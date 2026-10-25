import { open, readFile, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { TurnRunner, type TurnEventHandler } from "../turn-runner/turn-runner.js";
import { resolveModelName } from "../model-resolution/resolver.js";
import { BUILT_IN_ROUTING_TABLE, isVirtualModel } from "../model-routing/table.js";
import type { RouterStatus } from "../model-routing/router.js";
import type { ThinkingLevel } from "@earendil-works/pi-ai";
import type { TurnRunnerConfig } from "../types/config.js";
import { validateThinkingLevel } from "./thinking-level.js";
import type { Skill } from "@earendil-works/pi-coding-agent";
import type { SkillCollision } from "../turn-runner/skills.js";
import type {
  TurnAgentFile,
  TurnAnswerCommand,
  TurnCompactCommand,
  TurnEditFollowUpQueueCommand,
  TurnEvent,
  TurnInterruptCommand,
  TurnMode,
  TurnPromptBehavior,
  TurnFollowUpQueueEntry,
  TurnPromptImage,
  TurnQuestion,
  TurnStartCommand,
  TurnState,
  TurnTerminalEvent,
  TurnCommand,
  TurnOptions,
  TurnUsageEvent,
  TurnUsageFields,
} from "../types/protocol.js";
import {
  SystemRuntimeClock,
  type CancelScheduled,
  type RuntimeClock,
} from "../turn-runner/runtime-clock.js";

/**
 * `scheduleWake` 对照 `wakeAt` 检查墙上时钟的频率。采用轮询而非依赖
 * 单次长时 `setTimeout`，可在 macOS / Windows / 容器休眠后保持唤醒正确，
 * 因为 Node 和 Bun 定时器使用会随进程暂停的单调时钟。
 */
const WAKE_POLL_INTERVAL_MS = 30_000;

/** 任务输出持久化的尾沿控制；限制完整状态的序列化频率。 */
const OUTPUT_PERSIST_DEBOUNCE_MS = 1_000;

interface StoredSessionFile {
  sessionId?: string;
  updatedAt?: number;
  state?: TurnState;
  lastUsage?: TurnUsageFields;
  sessionCostUsd?: number;
}

export interface SessionStartInput {
  /** 后续提示词的路由模式。省略则使用会话配置的默认值。 */
  mode?: TurnMode;
  options?: TurnOptions;
  /** 在第一回合运行前一次性连接的远程 MCP 服务器。 */
  mcpServers?: TurnStartCommand["mcpServers"];
}

export interface SessionPromptInput {
  message: string;
  behavior?: TurnPromptBehavior;
  /**
   * 随提示词文本一起转发给运行器的可选图像附件。
   * 每个条目包含一张 base64 编码的图像及其 MIME 类型。
   */
  images?: TurnPromptImage[];
}

export interface SessionAnswerInput {
  questions: TurnQuestion[];
  /**
   * 每个问题所选选项的标签，以 `question.question` 为键。始终
   * 使用数组，使单选和多选共用同一种结构；空
   * 数组表示用户未选择就跳过了多选题。
   */
  answers: Record<string, string[]>;
  behavior?: TurnPromptBehavior;
  /**
   * 可选的自由格式提示词文本，追加在答案 XML 之后。TUI 用它
   * 在同一回合中提交部分答案和输入的消息。
   */
  message?: string;
  /** 随合成提示词一同传递的可选图像附件。 */
  images?: TurnPromptImage[];
}

export interface SessionEditFollowUpQueueInput {
  prompts: TurnFollowUpQueueEntry[];
}

export type SessionEventHandler = (event: TurnEvent) => void;

export interface SessionTurnRunner {
  start(command: TurnStartCommand): Promise<TurnState>;
  turn(command: TurnCommand): Promise<TurnTerminalEvent>;
  interrupt(command: TurnInterruptCommand): void;
  editFollowUpQueue(command: TurnEditFollowUpQueueCommand): void;
  compact(command: TurnCompactCommand): void | Promise<void>;
  subscribe(handler: TurnEventHandler): () => void;
  getState(): TurnState | undefined;
  /** 会话启动后重新指定持久父运行器的目标模型。 */
  setModel?(model: string): { routed: boolean };
  /** 根据启动时加载的项目路由表验证选择。 */
  isVirtualModelSelection?(model: string): boolean;
  /** 当此运行器具有路由状态时，返回路由器维护的显示快照。 */
  routeStatus?(): RouterStatus | undefined;
  getSkills(): Promise<readonly Skill[]>;
  reloadSkills(): Promise<readonly Skill[]>;
  getResolvedAgentFiles(): Promise<readonly TurnAgentFile[]>;
  getSkillCollisions(): Promise<readonly SkillCollision[]>;
  dispose(): Promise<void>;
}

export interface SessionOptions {
  id: string;
  /** 此会话拥有的具体目录。管理器会在构造前创建它。 */
  sessionPath: string;
  runner?: SessionTurnRunner;
  resumeFromStorage?: boolean;
  /** 墙上时钟与定时器的注入点，用于确定性的计划任务唤醒行为。 */
  clock?: RuntimeClock;
}

export class Session {
  readonly id: string;
  private readonly runner: SessionTurnRunner;
  /** 此会话拥有的目录。状态持久化会将 `state.json` 写入其中。 */
  private readonly sessionPath: string;
  /** 会话级时钟，用于持久化时间戳和计划唤醒推算。 */
  /** 为突发任务输出等待执行的尾沿写入。 */
  private cancelOutputPersist?: CancelScheduled;
  private readonly clock: RuntimeClock;
  /** 同目录下的唯一临时目标；旧文件绝不会与其他 Session 写入器共用路径。 */
  private readonly persistenceTempPath: string;
  /** 关注此单个会话原始 turn-runner 事件的订阅者。 */
  private readonly eventHandlers = new Set<SessionEventHandler>();
  /** 释放时移除会话对其运行器的订阅。 */
  private readonly unsubscribeRunner: () => void;
  /** 正在执行的运行器回合，用于区分活动工作与可复用的终止结果。 */
  private activeTurn?: Promise<void>;
  /** 正在执行的运行器初始化，派发任何回合前都会等待它，以确保 turn_started 先到达。 */
  private startPromise?: Promise<void>;
  /** 最近的终止事件；调用方在回合结束后等待时立即返回。 */
  private lastTerminal?: TurnTerminalEvent;
  /**
   * 当注入的墙上时钟到达 `wakeAt` 时触发唤醒的轮询间隔。用户
   * 输入不会撤销截止时间，使其可以唤醒活动回合；中断和非休眠
   * 终止事件会撤销它。使用轮询而非单个长定时器，使休眠期间错过
   * 截止时间的笔记本在恢复后很快触发：Node/Bun 定时器由单调时钟驱动，
   * 它会在 macOS 休眠时暂停，而墙上时钟比较不会。
   */
  private wakeTimer?: CancelScheduled;
  /** 当截止时间比轮询间隔更近时使用的可选快速路径定时器。 */
  private wakeFastPath?: CancelScheduled;
  /** 在当前文件系统提交之后等待的最新即时序列化封装数据。 */
  private queuedEnvelope?: string;
  /** 持久化进行期间，所有调用方共享的单一写入排空任务。 */
  private persistenceDrain?: Promise<void>;
  /** 此会话是否应在首次使用时加载 `state.json`。新会话初始为空。 */
  private readonly resumeFromStorage: boolean;
  /** 等待中的 `waitForTerminal` 调用方，在下一个终止事件到达时一并完成。 */
  private readonly terminalWaiters: Array<(terminal: TurnTerminalEvent) => void> = [];
  /**
   * 最新的 `usage` 快照（当前回合累计值加上父上下文
   * 栏字段）。与 `TurnState` 一起持久化到 `state.json`，而不是
   * 运行器快照中，以便侧栏在重启后恢复。
   */
  private lastUsage?: TurnUsageFields;
  /**
   * 截至目前已到达终止事件的所有回合的费用，单位为 USD。
   * 每回合从 `terminal.turnUsage.cost.total` 记账一次，并持久化
   * 到 `state.json`。正在执行的回合费用单独记录
   * 在 `liveTurnCostUsd` 中，仅在显示时合入，因此回合中途
   * 崩溃后恢复时会丢弃未完成回合的部分费用，而不是
   * 持久化一个不断变化的值。
   */
  private sessionCostUsd = 0;
  /**
   * 活动回合的累计费用，单位为 USD，镜像自每个 `usage`
   * 事件的 `turnUsage.cost.total`。终止事件将最终总额计入
   * `sessionCostUsd` 时清空。仅用于显示，从不持久化。
   */
  private liveTurnCostUsd = 0;

  constructor(
    readonly config: TurnRunnerConfig,
    options: SessionOptions,
  ) {
    this.id = options.id;
    this.resumeFromStorage = options.resumeFromStorage ?? Boolean(options.id);
    // 将会话 id 传入运行器配置，使
    // 观察器/反思器写入的观察记录带有此会话标签。记忆
    // 加载器使用会话 id 区分本地记忆（此会话）和
    // 全局记忆（其他所有会话，按排名纳入预算）。
    this.runner = options.runner ?? new TurnRunner({ ...config, sessionId: options.id });
    this.sessionPath = options.sessionPath;
    this.clock = options.clock ?? new SystemRuntimeClock();
    this.persistenceTempPath = `${this.sessionFilePath()}.tmp-${process.pid}-${randomUUID()}`;
    this.unsubscribeRunner = this.runner.subscribe((event) => void this.handleTurnEvent(event));
  }

  subscribe(handler: SessionEventHandler): () => void {
    this.eventHandlers.add(handler);
    return () => {
      this.eventHandlers.delete(handler);
    };
  }

  /**
   * 在任何回合运行前初始化会话。只调用一次运行器的
   * 初始化步骤，使调用方可以在启动时、用户输入提示词之前，
   * 立即渲染技能和 agent 文件。
   *
   * 重复调用不执行操作；恢复的会话复用持久化状态。
   */
  async start(input: SessionStartInput = {}): Promise<void> {
    if (this.startPromise) {
      await this.startPromise;
      return;
    }
    const envelope = this.resumeFromStorage ? await this.readStoredEnvelope() : {};
    this.applyPersistedTelemetryFields(envelope);
    const state = envelope.state;
    const command: TurnStartCommand = {
      type: "start",
      ...((input.mode ?? this.config.mode) ? { mode: input.mode ?? this.config.mode } : {}),
      ...(state ? { state } : {}),
      ...this.startOptions(input.options),
      ...(input.mcpServers ? { mcpServers: input.mcpServers } : {}),
    };
    this.startPromise = this.runner.start(command).then(() => this.syncModelSelections());
    await this.startPromise;
    if (state) {
      await this.persistLatestState();
      if (state.status === "sleeping") {
        await this.replaySleepFromResumedState();
      }
    }
  }

  /**
   * 恢复的休眠会话不会重新执行原始 `sleep` 终止事件，
   * 因此轮询唤醒定时器和 TUI 休眠横幅会一直不活动。
   * 根据持久化状态合成一个 `sleep` 事件，并通过
   * 正常的终止事件路径处理它，使 `scheduleWake` 启动定时器，且订阅者
   * 收到横幅。
   */
  private async replaySleepFromResumedState(): Promise<void> {
    const state = this.runner.getState();
    const wakeAt = scheduledTaskWakeAt(state);
    if (!state || wakeAt === undefined) return;
    await this.handleTurnEvent({ type: "sleep", wakeAt, state });
  }

  async prompt(input: SessionPromptInput): Promise<void> {
    await this.ensureStarted();
    await this.requireState();
    const command: TurnCommand = {
      type: "prompt",
      message: input.message,
      behavior: input.behavior ?? "follow_up",
      images: input.images,
    };
    this.dispatchTurn(command);
  }

  async answer(input: SessionAnswerInput): Promise<void> {
    await this.ensureStarted();
    await this.requireState();
    const command: TurnAnswerCommand = {
      type: "answer",
      questions: input.questions,
      answers: input.answers,
      behavior: input.behavior ?? "follow_up",
      message: input.message,
      images: input.images,
    };
    this.dispatchTurn(command);
  }

  async interrupt(): Promise<void> {
    await this.ensureStarted();
    this.cancelWake();
    this.runner.interrupt({ type: "interrupt" });
  }

  private async ensureStarted(): Promise<void> {
    if (!this.startPromise) {
      await this.start();
      return;
    }
    await this.startPromise;
  }

  editFollowUpQueue(input: SessionEditFollowUpQueueInput): void {
    this.runner.editFollowUpQueue({
      type: "edit_follow_up_queue",
      prompts: input.prompts,
    });
  }

  /**
   * 按需压缩运行器在线路上可见的消息尾部。运行器
   * 先将对话记录中尚未观察的尾部写入持久
   * 记忆存储（使被移除的消息作为观察记录保留在
   * 渲染的前缀中），再推进其固定移除边界，使
   * 下一个发往执行模型的请求使用更小的提示词。
   *
   * 有意保持 `TurnState.agent.messages` 中的持久对话记录
   * 不变，使恢复、历史回看和观察器/反思器处理都保留
   * 完整历史。新的移除边界作为
   * `TurnState.wireGuardHorizon` 的一部分持久化，使在
   * 用户退出 TUI 前刚压缩的会话下次恢复时仍保留裁剪后的线路消息尾部。
   */
  async compact(): Promise<void> {
    await this.ensureStarted();
    await this.runner.compact({ type: "compact" });
    await this.persistLatestState();
  }

  async waitForTerminal(): Promise<TurnTerminalEvent> {
    if (this.lastTerminal && !this.activeTurn) {
      return this.lastTerminal;
    }
    return new Promise((resolve) => {
      this.terminalWaiters.push(resolve);
    });
  }

  isTurnActive(): boolean {
    return Boolean(this.activeTurn);
  }

  /**
   * 运行器最近发出的终止事件；若尚无回合
   * 结束则为 `undefined`。在 `hydrate()` / `start()` 后接入的订阅者
   * （如延迟启动的 TUI）可用它恢复开始监听前
   * 已发出的状态，尤其是休眠横幅。
   */
  getLastTerminal(): TurnTerminalEvent | undefined {
    if (this.activeTurn) return undefined;
    return this.lastTerminal;
  }

  /** 当前由运行器维护的回合状态快照，包含 agent 消息历史。 */
  getState(): TurnState | undefined {
    return this.runner.getState();
  }

  /** 当前由路由器维护的状态，供 UI 只读查看。 */
  routeStatus(): RouterStatus | undefined {
    return this.runner.routeStatus?.();
  }

  /** 用于侧栏恢复的最新 `usage` 载荷；不是 `TurnState` 的一部分。 */
  getLastUsage(): TurnUsageFields | undefined {
    return this.lastUsage;
  }

  /**
   * 用于显示的累计会话费用，单位为 USD：已完成回合加上
   * 当前回合的累计值。持久化值仅包含
   * 已完成回合；正在执行的部分在读取时合入，使
   * 侧栏在回合中途继续更新而不改变持久化总额。
   */
  getSessionCostUsd(): number {
    return this.sessionCostUsd + this.liveTurnCostUsd;
  }

  /**
   * 为此会话发现的技能。在 `start()` 完成后可用；
   * 否则在首次调用时延迟加载。
   */
  getSkills(): Promise<readonly Skill[]> {
    return this.runner.getSkills();
  }

  /**
   * 重新发现技能并刷新运行器的精选文件记忆，使磁盘
   * 改动无需重启会话即可在下一回合生效。
   */
  reloadSkills(): Promise<readonly Skill[]> {
    return this.runner.reloadSkills();
  }

  /** 在磁盘上解析到的系统提示词文件（默认为 AGENTS.md）。 */
  getResolvedAgentFiles(): Promise<readonly TurnAgentFile[]> {
    return this.runner.getResolvedAgentFiles();
  }

  /**
   * 更换后续回合使用的选择。虚拟名称根据
   * 运行器加载的项目表验证；具体名称保留 CLI
   * 已有的解析验证。已启动的运行器直接重新指定目标，
   * 而正在执行的回合继续使用启动时的选择。
   */
  setModel(model: string): { modelName: string; routed: boolean } {
    const trimmed = model.trim();
    if (!trimmed) {
      throw new Error("Model name is required");
    }
    let routed: boolean;
    if (this.runner.getState() && this.runner.setModel) {
      routed = this.runner.setModel(trimmed).routed;
    } else {
      routed =
        this.runner.isVirtualModelSelection?.(trimmed) ??
        isVirtualModel(trimmed, BUILT_IN_ROUTING_TABLE);
      if (!routed) resolveModelName(trimmed);
    }
    this.config.model = trimmed;
    return { modelName: trimmed, routed };
  }

  /**
   * 更换后续具体模型回合使用的思考级别。路由
   * 选择改为报告其层级，因为该值由路由工作强度决定；
   * 这种情况下不修改配置。
   */
  setThinkingLevel(level: string): { thinkingLevel?: ThinkingLevel; routedBy?: string } {
    const normalized = validateThinkingLevel(level);
    const model = this.config.model;
    const routed =
      model &&
      (this.runner.isVirtualModelSelection?.(model) ??
        isVirtualModel(model, BUILT_IN_ROUTING_TABLE));
    if (routed) {
      return { routedBy: model };
    }
    this.config.thinkingLevel = normalized;
    return { thinkingLevel: normalized };
  }

  /** 发现过程中，一个定义遮蔽另一个定义的技能名称冲突。 */
  getSkillCollisions(): Promise<readonly SkillCollision[]> {
    return this.runner.getSkillCollisions();
  }

  /** 在派发用户命令之前，从持久化状态启动此会话。 */
  async hydrate(): Promise<void> {
    if (this.startPromise) {
      await this.startPromise;
      return;
    }
    if (!this.resumeFromStorage) return;
    const envelope = await this.readStoredEnvelope();
    this.applyPersistedTelemetryFields(envelope);
    const state = envelope.state;
    if (!state) return;
    this.startPromise = this.runner
      .start({ type: "start", state, ...this.startOptions() })
      .then(() => this.syncModelSelections());
    await this.startPromise;
    await this.persistLatestState();
    if (state.status === "sleeping") {
      await this.replaySleepFromResumedState();
    }
  }

  async dispose(): Promise<void> {
    this.cancelOutputPersist?.();
    this.cancelOutputPersist = undefined;
    this.cancelWake();
    await this.runner.dispose();
    await this.persistLatestState();
    if (this.persistenceDrain) await this.persistenceDrain;
    this.unsubscribeRunner();
  }

  private dispatchTurn(command: TurnCommand): void {
    this.lastTerminal = undefined;
    let terminalObserved = false;
    const unsubscribeAssertion = this.runner.subscribe((event) => {
      if (isTerminalEvent(event)) terminalObserved = true;
    });
    const activeTurn = this.runner
      .turn(command)
      .then(() => {
        if (!terminalObserved) {
          throw new Error("TurnRunner.turn() settled without emitting a terminal event.");
        }
      })
      .catch((error) => {
        this.emit({
          type: "system",
          level: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        unsubscribeAssertion();
        if (this.activeTurn === activeTurn) {
          this.activeTurn = undefined;
        }
      });
    this.activeTurn = activeTurn;
  }

  private async handleTurnEvent(event: TurnEvent): Promise<void> {
    if (event.type === "usage") {
      this.applyUsageEvent(event);
      void this.persistLatestState();
    }
    if (event.type === "task_started" || event.type === "task_settled") {
      void this.persistLatestState();
    }
    if (event.type === "task_output") {
      // 输出块可能以流速到达；每次持久化都会序列化
      // 完整 TurnState，因此通过尾沿防抖控制此触发源。
      // 快照有效性不受影响——每次触发的写入都捕获
      // 完整状态；防抖只限制频率。
      if (!this.cancelOutputPersist) {
        this.cancelOutputPersist = this.clock.schedule(() => {
          this.cancelOutputPersist = undefined;
          void this.persistLatestState();
        }, OUTPUT_PERSIST_DEBOUNCE_MS);
      }
    }
    if (isTerminalEvent(event)) {
      this.cancelOutputPersist?.();
      this.cancelOutputPersist = undefined;
      this.lastTerminal = event;
      this.commitTerminalCost(event);
      await this.writeStoredEnvelope(event.state);
      if (event.type === "sleep") {
        this.scheduleWake(event);
      } else {
        this.cancelWake();
      }
      for (const resolve of this.terminalWaiters.splice(0)) {
        resolve(event);
      }
    }
    this.emit(event);
  }

  /**
   * 将当前回合累计值镜像到 `lastUsage`（用于上下文栏）
   * 和 `liveTurnCostUsd`（用于回合中途费用显示）。持久化的
   * `sessionCostUsd` 保持不变，直到终止事件计入
   * 最终总额，因此被中断回合的部分费用不会在
   * 崩溃后保留。
   */
  private applyUsageEvent(event: TurnUsageEvent): void {
    this.lastUsage = {
      turnUsage: event.turnUsage,
      usageByModel: event.usageByModel,
      lastMessageUsage: event.lastMessageUsage,
      effectiveContextWindow: event.effectiveContextWindow,
      contextWindowUsage: event.contextWindowUsage,
    };
    this.liveTurnCostUsd = event.turnUsage.cost.total;
  }

  /**
   * 将已完成回合的全部费用计入持久化的 `sessionCostUsd`，
   * 并清空当前回合跟踪值。终止事件携带用量包时，也从中
   * 刷新 `lastUsage`，使侧栏的上下文栏
   * 即使没有收到前置 `usage` 事件也能反映最终的单回合累计值
   * （例如突然出错的路径）。
   */
  private commitTerminalCost(terminal: TurnTerminalEvent): void {
    // `TurnTerminalBaseEvent extends Partial<TurnUsageFields>`，因此
    // 虽然运行器原子地附加整个包，但类型系统中每个
    // 字段都是独立可选的。检查每个字段，以确保
    // 收窄符合实际，且使用方无需非空断言。
    if (terminal.turnUsage) {
      this.sessionCostUsd += terminal.turnUsage.cost.total;
    }
    if (
      terminal.turnUsage &&
      terminal.lastMessageUsage &&
      terminal.effectiveContextWindow !== undefined &&
      terminal.contextWindowUsage
    ) {
      this.lastUsage = {
        turnUsage: terminal.turnUsage,
        usageByModel: terminal.usageByModel ?? [],
        lastMessageUsage: terminal.lastMessageUsage,
        effectiveContextWindow: terminal.effectiveContextWindow,
        contextWindowUsage: terminal.contextWindowUsage,
      };
    }
    this.liveTurnCostUsd = 0;
  }

  private applyPersistedTelemetryFields(
    envelope: Pick<StoredSessionFile, "lastUsage" | "sessionCostUsd">,
  ): void {
    if (envelope.lastUsage !== undefined) {
      this.lastUsage = envelope.lastUsage;
    }
    if (typeof envelope.sessionCostUsd === "number" && Number.isFinite(envelope.sessionCostUsd)) {
      this.sessionCostUsd = envelope.sessionCostUsd;
    }
  }

  private emit(event: TurnEvent): void {
    for (const handler of this.eventHandlers) {
      handler(event);
    }
  }

  private scheduleWake(terminal: Extract<TurnTerminalEvent, { type: "sleep" }>): void {
    this.cancelWake();
    const fire = (): void => {
      if (this.clock.now() < terminal.wakeAt) return;
      const state = this.runner.getState();
      if (!state || state.status !== "sleeping") return;
      this.cancelWake();
      this.dispatchTurn({ type: "wake" });
    };
    // 每 30 秒轮询一次，使休眠的笔记本在重新开盖后很快唤醒回合。
    // 抖动受轮询间隔限制；考虑到上游强制 wakeAt 至少为 30 秒后，
    // 这一抖动可以接受。
    this.wakeTimer = this.clock.repeat(fire, WAKE_POLL_INTERVAL_MS);
    // 针对比轮询间隔更近的截止时间使用快速路径，使短等待保持精确。
    const remaining = terminal.wakeAt - this.clock.now();
    if (remaining < WAKE_POLL_INTERVAL_MS) {
      this.wakeFastPath = this.clock.schedule(fire, Math.max(0, remaining));
    }
  }

  private cancelWake(): void {
    if (this.wakeTimer) {
      this.wakeTimer();
      this.wakeTimer = undefined;
    }
    if (this.wakeFastPath) {
      this.wakeFastPath();
      this.wakeFastPath = undefined;
    }
  }

  private async requireState(): Promise<TurnState> {
    await this.ensureStarted();
    const state = this.runner.getState();
    if (!state) {
      throw new Error(`Unknown session: ${this.id}`);
    }
    return state;
  }

  /** 将当前运行器状态和会话维护的封装字段写入 `state.json`。 */
  private async persistLatestState(): Promise<void> {
    const state = this.runner.getState();
    if (!state) return;
    await this.writeStoredEnvelope(state);
  }

  private syncModelSelections(): void {
    const options = this.runner.getState()?.options;
    if (options?.model) this.config.model = options.model;
    if (options?.memoryModel) this.config.memoryModel = options.memoryModel;
  }

  private startOptions(options?: TurnOptions): { options?: TurnOptions } {
    // CLI/TUI 配置是当前会话契约。恢复时应
    // 覆盖持久化选项，使 --model 等标志立即生效。
    const effective: TurnOptions = {
      ...(this.config.model ? { model: this.config.model } : {}),
      ...(this.config.memoryModel ? { memoryModel: this.config.memoryModel } : {}),
      ...(this.config.thinkingLevel ? { thinkingLevel: this.config.thinkingLevel } : {}),
      ...options,
    };
    return Object.keys(effective).length > 0 ? { options: effective } : {};
  }

  private async readStoredEnvelope(): Promise<{
    state?: TurnState;
    lastUsage?: TurnUsageFields;
    sessionCostUsd?: number;
  }> {
    try {
      const content = await readFile(this.sessionFilePath(), "utf-8");
      const stored = JSON.parse(content) as StoredSessionFile;
      // 旧会话文件早于 `lastMessageUsage` 或逐条目的
      // `transport` 归属字段；任一缺失时跳过快照，避免
      // 侧栏读取 undefined。上下文栏会在
      // 恢复后的第一回合重新填充；此处不做迁移。
      const lastUsage =
        stored.lastUsage?.lastMessageUsage &&
        (stored.lastUsage.usageByModel ?? []).every((entry) => entry?.transport)
          ? stored.lastUsage
          : undefined;
      return {
        ...(stored.state ? { state: stored.state } : {}),
        lastUsage,
        sessionCostUsd: stored.sessionCostUsd,
      };
    } catch (error) {
      if (isEnoent(error) || String(error).includes(this.sessionFilePath())) {
        return {};
      }
      throw error;
    }
  }

  private async writeStoredEnvelope(state: TurnState): Promise<void> {
    const payload: StoredSessionFile = {
      sessionId: this.id,
      updatedAt: this.clock.now(),
      state,
      sessionCostUsd: this.sessionCostUsd,
    };
    if (this.lastUsage !== undefined) {
      payload.lastUsage = this.lastUsage;
    }
    // 同步捕获：运行器快照可能包含实时数组，其内容可能在
    // 较早的文件系统操作等待 I/O 时变化。
    this.queuedEnvelope = `${JSON.stringify(payload, null, 2)}\n`;
    if (!this.persistenceDrain) {
      const drain = this.drainPersistence();
      this.persistenceDrain = drain;
      void drain.then(
        () => {
          if (this.persistenceDrain === drain) this.persistenceDrain = undefined;
        },
        () => {
          if (this.persistenceDrain === drain) this.persistenceDrain = undefined;
        },
      );
    }
    await this.persistenceDrain;
  }

  private async drainPersistence(): Promise<void> {
    try {
      while (this.queuedEnvelope !== undefined) {
        const serialized = this.queuedEnvelope;
        this.queuedEnvelope = undefined;
        await this.commitSerializedEnvelope(serialized);
      }
    } catch (error) {
      // 等待此排空任务的每个调用方都能观察到失败。丢弃合并后的载荷，
      // 而不是在某个无关的后续持久化请求中意外提交它。
      this.queuedEnvelope = undefined;
      throw error;
    }
  }

  private async commitSerializedEnvelope(serialized: string): Promise<void> {
    const destination = this.sessionFilePath();
    const temporary = this.persistenceTempPath;
    try {
      const file = await open(temporary, "w", 0o600);
      try {
        await file.writeFile(serialized, "utf-8");
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, destination);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  private sessionFilePath(): string {
    return join(this.sessionPath, "state.json");
  }
}

function scheduledTaskWakeAt(state: TurnState | undefined): number | undefined {
  const wakeTimes = (state?.tasks ?? [])
    .filter(
      (task) =>
        task.kind === "scheduled" && task.status === "scheduled" && Number.isFinite(task.wakeAt),
    )
    .map((task) => task.wakeAt as number);
  return wakeTimes.length > 0 ? Math.min(...wakeTimes) : undefined;
}

function isTerminalEvent(event: TurnEvent): event is TurnTerminalEvent {
  return (
    event.type === "complete" ||
    event.type === "ask" ||
    event.type === "interrupted" ||
    event.type === "sleep"
  );
}

function isEnoent(error: unknown): boolean {
  return String(error).includes("ENOENT");
}
