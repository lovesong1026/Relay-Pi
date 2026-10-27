import { resolve } from "node:path";
import { admitToolArguments } from "./tool-admission.js";
import {
  Agent,
  type AgentEvent,
  type AgentMessage,
  type AgentTool,
} from "@earendil-works/pi-agent-core";
import { isContextOverflow, type ImageContent, type Usage } from "@earendil-works/pi-ai";
import { resolveProviderApiKey } from "../model-resolution/provider-catalog.js";
import { relayPiStreamFn } from "../model-resolution/models.js";
import { normalizeSavedModelSelection, type TransportName } from "../model-resolution/catalog.js";
import {
  ensureFreshConnectedTokens,
  markConnectedProviderReconnectNeeded,
} from "../connected-providers/tokens.js";
import { isConnectedProviderId } from "../connected-providers/store.js";
import {
  connectedFallbackCause,
  isPostOutputConnectedFailure,
  nextTransportAfterConnectedFailure,
} from "../connected-providers/fallback.js";
import { transportFallbackNotice } from "../connected-providers/fallback-notice.js";
import { usageForTransport } from "../connected-providers/billing.js";
import { connectedTransportSnapshot, demoteConnectedTransport } from "../cli/shared.js";
import type { Skill } from "@earendil-works/pi-coding-agent";
import type { SkillCollision } from "./skills.js";
import dedent from "dedent";
import { stripSystemReminders, systemReminder } from "../lib/system-reminder.js";

import { assistantText } from "../core/serializer.js";
import { classifyRoute } from "../model-routing/classifier.js";
import type { ClassifyRouteOptions } from "../model-routing/classifier.js";
import { loadRoutingTable } from "../model-routing/loader.js";
import { AdvisorTurnLifecycle } from "../model-routing/advisor-lifecycle.js";
import {
  ADVISOR_COMPLETION_REVIEW_REMINDER,
  ADVISOR_EXECUTOR_GUIDANCE_LAYER,
  ADVISOR_ORIENTATION_REMINDER,
} from "../model-routing/prompts.js";
import {
  ADVISOR_RECENT_MESSAGE_TARGET_TOKENS,
  buildAdvisorContext,
  captureAdvisorExecutorContext,
  type AdvisorExecutorContext,
} from "../model-routing/advisor-context.js";
import { ADVISOR_MAX_OUTPUT_TOKENS } from "../model-routing/advisor.js";
import { resolveTierDefault, type RouteResolutionCatalog } from "../model-routing/resolve.js";
import type { StepObservation } from "../model-routing/step-triggers.js";
import {
  ModelRouter,
  type ModelRouterOptions,
  type RouterStatus,
  type RouterPrepareInput,
  type RouterSwitch,
} from "../model-routing/router.js";
import {
  BUILT_IN_ROUTING_TABLE,
  isVirtualModel,
  type AdvisorPolicy,
  type RoutingTable,
} from "../model-routing/table.js";
import { toXML } from "../lib/xml.js";
import {
  compactObservationalContext,
  createObservationalContextTransform,
  DEFAULT_EFFECTIVE_CONTEXT,
  estimateTokens,
  resolveObservationalMemorySettings,
  stripObservationalContextMessages,
  updateObservationalMemory,
} from "../memory/observational.js";
import { rebuildMemoryContextPack, rebuildPinnedStoreContextPack } from "../memory/context-pack.js";
import { createEmbeddingClient } from "../memory/embedding.js";
import {
  loadStoredMemory,
  replaceSessionObservations,
  type MemoryPersistenceHandle,
} from "../memory/storage.js";
import { MemoryContextCache } from "../memory/store.js";
import { discoverMemoryStores } from "../memory/store/discovery.js";
import {
  DEFAULT_CLI_MEMORY_MODEL,
  DEFAULT_CLI_MODEL,
  resolveMeteredModelName,
  resolveModelName,
  routingCatalogAdapter,
} from "../model-resolution/resolver.js";
import { DEFAULT_TASK_WAIT_BUDGET_MS, type TurnRunnerConfig } from "../types/config.js";
import {
  COMPACT_MESSAGE_TOKENS_RATIO,
  compactTurnState,
  type AutoStateCompactionOptions,
} from "./state-compaction.js";
import type {
  TurnAgentFile,
  TurnAnswerCommand,
  TurnContextWindowUsage,
  WireGuardHorizon,
  TurnEditFollowUpQueueCommand,
  TurnEvent,
  TurnEventOrigin,
  TurnFollowUpQueueEntry,
  TurnInterruptCommand,
  TurnMode,
  TurnPromptCommand,
  TurnPromptImage,
  TurnQuestion,
  TurnState,
  TurnTokenUsage,
  ModelUsageEntry,
  TurnStartCommand,
  TurnTerminalEvent,
  TurnCommand,
  TurnOptions,
  TurnTodo,
} from "../types/protocol.js";
import type { StateMachineAgentState } from "../types/state-machine.js";
import {
  createAgentEventTranslator,
  agentMessageText,
  isExternallyVisibleAgentEvent,
} from "./agent-events.js";
import {
  createRecallMemorySystemPromptLayer,
  createSourceOfTruthSystemPromptLayer,
  createStateMachineSystemPromptLayer,
  withheldAskReminder,
  PARK_END_OF_TURN_NUDGE,
  parkNudge,
} from "./prompts.js";
import {
  applyEvictionHorizon,
  calculateWireTokens,
  createInitialHorizon,
  findEvictionHorizon,
} from "./wire-shaping.js";
import {
  createDefaultTurnRunnerTools,
  createTurnRunnerTools,
  resolveStateCwd,
  formatCarriedTodosReminder,
  formatStateMachineTerminalAcknowledgmentPrompt,
  type AskAdvisorToolStorage,
  type RecallMemoryToolStorage,
  isTurnRunnerControlResult,
  type TurnRunnerControlResult,
  type StateMachineRunnerDecision,
  MINIMUM_STATE_MACHINE_DELAY_MS,
} from "./tools.js";
import { connectMcpServers, type McpRuntime } from "./mcp.js";
import { SkillContext } from "./skill-context.js";
import {
  currentParkState,
  currentScheduledState,
  persistStateDefinition,
  recordStateStarted,
  recordAcceptedExecution,
  annotateUnchangedExecution,
} from "./state-machine-session.js";
import {
  failActiveSession,
  markTerminalAcknowledged,
  planDecision,
  planWake,
  recordPlannedTerminal,
  recordScheduled,
  recordSettled,
  repeatedSelectionLoopCount,
  startSession as startStateMachineSession,
  supersede,
  executionReceipt,
  type ExecutionSelection,
  type PlannedWork,
  type PollPolicy,
  type ShellSettlement,
  type ShellSpec,
  type SettledDecision,
} from "./state-machine-decisions.js";
import {
  createSubagentExecutor,
  classifySpawnModel,
  type SubagentResult,
  type SubagentAgentConfigInput,
  type SubagentExecutionContext,
  type SubagentRun,
  type SubagentSpec,
} from "./subagent.js";
import {
  completeTurn,
  copyOptionalArray,
  createInitialTurnState,
  restoreSavedExecutionSelections,
} from "./turn-state.js";
import {
  DEFAULT_TRANSIENT_RETRY_POLICY,
  lastMessageIsTransientFailure,
  transientRetryDelayMs,
  type TransientRetryPolicy,
} from "./transient-error.js";
import { addUsage, addUsageByModel } from "./usage-accounting.js";
import { SystemRuntimeClock, type RuntimeClock } from "./runtime-clock.js";
import type { PendingWork } from "../tasks/quiescence.js";
import { createTaskManager, type TaskManager } from "../tasks/task-manager.js";
import type { ScopeId, TaskEvent, TaskId, TaskSettlement, TaskSnapshot } from "../tasks/types.js";
import { createShellStateHandle, type ShellStateHandle } from "./shell-state-handle.js";
import type { StateMachineSession } from "../types/state-machine.js";
import {
  createSpawnAgentTool,
  createTaskAdminTools,
  lostTaskRecoveryReminder,
  settlementNotice,
  wrapBackgroundable,
} from "./task-tools.js";

/** @internal 仅供构造函数使用的生命周期接缝，不会出现在配置中。 */
interface TurnRunnerDependencies {
  /** 供内部使用的时钟接缝，用于确定性任务和调度生命周期测试。 */
  clock?: RuntimeClock;
  /** 供内部使用的调度校验覆盖项；生产环境仍保留 30 秒的下限。 */
  minimumScheduledDelayMs?: number;
}

/** 启动诊断在正常启动时保持静默，并说明可能导致超时的启动停滞。 */
const SLOW_STARTUP_WARNING_MS = 2_000;
const STARTUP_PHASES = [
  "connected_tokens",
  "memory",
  "skills",
  "mcp",
  "model_router",
  "hydration",
] as const;
type StartupPhase = (typeof STARTUP_PHASES)[number];

interface ChildToolContext {
  /** 此子项创建的任务所属的作用域。 */
  ownerScopeId: ScopeId;
  /** 供 recall_memory 使用的 Session 标识。 */
  memorySessionId?: string;
  /** 递归 fork_context 启动所使用的实时调用方对话记录。 */
  forkSource: NonNullable<SubagentExecutionContext["forkSource"]>;
  /** 拥有这组可递归调用工具的子项所使用的具体设置。 */
  modelSetting(): string;
}

export type TurnEventHandler = (event: TurnEvent) => void;

export interface AgentWorkerInput {
  state: TurnState;
  prompt: string;
  /** 内部循环 pass 会延续同一个公开 turn，因此必须保留路由信息。 */
  continuation?: boolean;
  /**
   * 转发给 `agent.prompt(text, images)` 的可选图像附件。
   * 仅父级 prompt 路径会携带图像；状态机子 Agent 和
   * answer 命令会忽略图像，因为它们的 prompt 由运行器合成。
   */
  images?: ImageContent[];
}

export interface AgentConfigInput extends SubagentAgentConfigInput {
  /** 父级启动路由器，用于选择初始的具体 model 和推理强度。 */
  router?: ModelRouter;
  /** 即使启动时使用的是具体选择，也会安装父级路由钩子。 */
  parentModelRouting?: boolean;
}

/**
 * 单次 `runAgentWorker` 调用的内部结果。范围比公开的
 * `TurnTerminalEvent` 更窄：worker 只会产生 `complete` 或
 * `interrupted`。`ask` 稍后由 `control` 合成；`sleep` 则由基于任务的 turn 循环合成。
 */
export type AgentWorkerOutcome =
  | {
      type: "complete";
      status: "completed" | "failed";
      result?: string;
      error?: string;
      state: TurnState;
    }
  | { type: "interrupted"; state: TurnState };

export interface AgentWorkerResult {
  outcome: AgentWorkerOutcome;
  control: TurnRunnerControlResult;
  /**
   * 供测试替身 worker 为本次父级调用构造的用量。真实父级运行不会设置此值：它会从实时 `Agent` 的
   * `message_end` 事件流式读取每次完成的用量，因此 worker 返回时汇总用量已经记录。绕过真实 `Agent` 的测试
   * harness 会在此报告用量并自行记录（见 `TestTurnRunner.runAgentWorker`），因此生产代码不会在此边界核算用量。
   */
  parentUsage?: TurnTokenUsage;
}

export type ParentLoopInput =
  | {
      type: "user_command";
      command: TurnPromptCommand | TurnAnswerCommand;
      continuation?: boolean;
    }
  | { type: "task_settlements"; settlements: TaskSettlement[] }
  | { type: "transition_enforcement"; stateName: string; output?: unknown }
  | { type: "terminal_acknowledgment" }
  | { type: "wake"; queued?: boolean };

/** 由运行器拥有、不会跨越公开命令或事件协议的延续输入。 */
type PendingParentLoopInput =
  | ParentLoopInput
  | { type: "advisor_completion_review" }
  | { type: "park_nudge" }
  | { type: "background_task_cleanup" }
  | { type: "recover_state"; stateName: string };

type StateTaskMetadata =
  | { kind: "agent"; stateName: string; run?: SubagentRun }
  | {
      kind: "script" | "poll";
      stateName: string;
      shell: ShellStateHandle;
      pollPolicy?: PollPolicy;
    };

/**
 * 父级在状态完成后必须发出 `select_state_machine_state`；运行器会在暂停决策、等待明确继续之前，
 * 重新提示父级发出该指令的次数上限。若缺少 worker 的恢复流程没有完成结果，仍会失败。两条路径都限制无进展的 model 重试次数。
 */
const PARENT_TRANSITION_RETRY_BUDGET = 3;

/** 顺序与 `TurnContextWindowUsage` 字段一致；索引对应 `scaled[0..3]`。 */
const CONTEXT_USAGE_KEYS = [
  "systemPrompt",
  "messages",
  "localMemory",
  "globalMemory",
] as const satisfies readonly (keyof TurnContextWindowUsage)[];

/**
 * 重新缩放四个分段的估算值，使其总和恰好等于最新 assistant 消息中
 * provider 报告的 `totalTokens`。当 `totalTokens` 不小于非零原始分段数时，每个
 * 非零分段至少分配一个 token，再按原始权重分配剩余量，并以最大余数法打破平局，确保总数精确。
 * 否则按比例向下取整（部分分段可能为零）。如果所有原始分段均为零，则将全部用量计入 `messages`。
 */
export function scaleContextWindowUsageToTotalTokens(
  base: TurnContextWindowUsage,
  totalTokens: number,
): TurnContextWindowUsage {
  const target = Math.max(0, Math.floor(totalTokens));
  if (target === 0) {
    return { systemPrompt: 0, messages: 0, localMemory: 0, globalMemory: 0 };
  }

  const raw = CONTEXT_USAGE_KEYS.map((k) => Math.max(0, Math.floor(base[k])));
  const sum = raw.reduce((a, b) => a + b, 0);
  if (sum === 0) {
    return { systemPrompt: 0, messages: target, localMemory: 0, globalMemory: 0 };
  }

  const minAlloc: number[] = raw.map((v) => (v > 0 ? 1 : 0));
  const minSum = minAlloc.reduce((a, b) => a + b, 0);

  let scaled: number[];
  if (target >= minSum && minSum > 0) {
    // 每个非空原始分段先保留一个 token，避免 provider 返回的总量很小时，
    // UI 中的整个分段都被清零；然后按权重分配剩余量。
    scaled = [...minAlloc];
    const remainderPool = target - minSum;
    if (remainderPool > 0) {
      const extra = raw.map((v) => Math.floor((v * remainderPool) / sum));
      for (let i = 0; i < 4; i++) scaled[i]! += extra[i]!;
      let remainder = remainderPool - extra.reduce((a, b) => a + b, 0);
      const fracs = raw.map((v, i) => ({
        i,
        frac: (v * remainderPool) / sum - extra[i]!,
      }));
      fracs.sort((a, b) => b.frac - a.frac);
      for (let r = 0; r < remainder; r++) {
        scaled[fracs[r]!.i]! += 1;
      }
    }
  } else {
    // provider 返回的总量小于非空分段数——改用纯比例向下取整
    // （部分分段可能为零）。
    scaled = raw.map((v) => Math.floor((v * target) / sum));
    let remainder = target - scaled.reduce((a, b) => a + b, 0);
    const fracs = raw.map((v, i) => ({
      i,
      frac: (v * target) / sum - scaled[i]!,
    }));
    fracs.sort((a, b) => b.frac - a.frac);
    for (let r = 0; r < remainder; r++) {
      scaled[fracs[r]!.i]! += 1;
    }
  }

  return {
    systemPrompt: scaled[0]!,
    messages: scaled[1]!,
    localMemory: scaled[2]!,
    globalMemory: scaled[3]!,
  };
}

function emptyTokenUsage(): TurnTokenUsage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

export class TurnRunner {
  private readonly eventHandlers = new Set<TurnEventHandler>();
  /** 将 pi Agent 事件映射为 turn 步骤；此转换器有状态，因此规范的 `tool_call` 步骤可以回显调用输入。 */
  private readonly agentEventToTurnEvents = createAgentEventTranslator();
  /** 供 Agent turn 的上下文转换器使用的内存观察记录存储。 */
  protected readonly memory = new MemoryContextCache();
  /** 负责加载、刷新并释放持久化观察记录存储。 */
  private memoryPersistence?: MemoryPersistenceHandle;
  /**
   * 按 Session 作用域管理的父级 pi Agent。它在 `start()` 时只创建一次，使 model、
   * 工具和 system prompt 结构在本 relay-pi Session 中每个 pi-agent turn 增长时保持稳定，
   * 从而支持 prompt 缓存。
   */
  private parentAgent?: Agent;
  /** 父级 Session 的虚拟 model 策略所有者；具体 model 固定时会暂时挂起该策略，但仍予以保留。 */
  protected modelRouter?: ModelRouter;
  /** 经过校验的项目路由表，供父级重新定向和显式虚拟状态 model 使用。 */
  private routingTable?: RoutingTable;
  /** 父级 turn 运行期间排队的 model 选择，会在下一个 turn 边界应用。 */
  private pendingModelSelection?: string;
  /** 随当前虚拟层级选定的顾问目标和对话记录预算。 */
  private advisorPolicy?: AdvisorPolicy;
  /** 当前公开 Agent 模式 turn 的产品级前置/最终顾问检查点。 */
  private advisorTurnLifecycle?: AdvisorTurnLifecycle;
  /** 仅当父级 pi Agent 正在生成公开终止事件时为 true。 */
  private parentAgentRunning = false;
  /** 当前父级 pass 捕获的控制结果。出现多个结果属于协议错误。 */
  private readonly parentControlResults: TurnRunnerControlResult[] = [];
  /** 持久化的状态机策略记录；执行由 TaskManager 负责。 */
  private stateMachine?: StateMachineSession;
  /** 每项状态执行和定时唤醒的运行时所有者。 */
  /** 供测试探针使用（任务描述符、作用域注入）；生产环境中的所有者是循环。 */
  protected readonly taskManager: TaskManager;
  /** 以 TaskManager 的稳定任务 ID 为键的纯执行元数据。 */
  private readonly stateTasks = new Map<TaskId, StateTaskMetadata>();
  /** 任务丢失后恢复时，附加到首个实际父级 pass 的一次性上下文。 */
  private recoveredTaskReminder?: string;
  /** 只有崩溃恢复流程可以要求继续执行孤立的可执行状态。 */
  private recoverExecution = false;
  /** 被静默门控暂存的 ask；会在父级下一次 pass 中重新呈现。 */
  private withheldAskQuestions?: TurnQuestion[];
  /** 保留的旧版用户通道投影，直到下一个循环接管它。 */
  private hydratedQueuedCommands?: TurnCommand[];
  /** 在连续 pass 之间等待占用唯一父级槽位的输入。 */
  private readonly parentInputs: PendingParentLoopInput[] = [];
  // Pi 的队列是临时的投递副本。外层队列负责持有已接受的
  // 命令，直到 pi 发出对应的消息对象，表明该输入已被消费。
  private readonly piQueuedInputs = new Map<
    AgentMessage,
    Extract<ParentLoopInput, { type: "user_command" }>
  >();
  /** 用户命令在任务处理期间到达时唤醒循环。 */
  private readonly parentInputWaiters = new Set<() => void>();
  /** 替换/中断期间已并入记录的任务结算结果。 */
  private readonly ignoredTaskSettlements = new Set<TaskId>();
  /** 已从任务管理器取出、但尚未排入父级队列的已结算任务。 */
  private readonly heldSettlements: TaskSettlement[] = [];
  /** 由任务支持的前台 bash 调用的投递状态。 */
  private readonly taskSettlementDelivery = new Map<
    TaskId,
    "foreground_pending" | "deliver" | "suppress"
  >();
  /** 将同一 tick 内的多个结算合并为一次 FIFO 排空和一条 B3 通知。 */
  private settlementDeliveryQueued = false;
  /** 本 turn 的 park 提醒已用；每次运行状态时重置。 */
  private parkNudged = false;
  /** 单调递增的根作用域后缀；每个公开 turn 拥有一个根作用域。 */
  private nextRootScope = 1;
  /** 当前接收状态任务的作用域。 */
  private activeRootScopeId?: `turn-${number}`;
  /** 工具在公开 turn 边界只构建一次，并由每个父级 pass 复用。 */
  private turnTools?: AgentTool[];
  /** 由 interrupt 设置，使循环唯一的退出路径可跳过待处理工作计算。 */
  private interruptReason?: string;
  /** 由 interrupt 启动的完整任务/进程清理流程；发出终止事件前会等待它完成。 */
  private interruptCleanup?: Promise<void>;
  /** 防止当前 turn 重复发出公开终止事件。 */
  private terminalEmitted = false;
  /** relay 状态和已启动子项共用的构造路径。 */
  private readonly subagentExecutor: ReturnType<typeof createSubagentExecutor>;
  /**
   * 当父级 Agent 的 prompt 正在处理中，`interrupt()` 会将其设为 true，
   * 这样 `agent.prompt()` 被拒绝后，`runAgentWorker` 就能区分本地中止与真实 provider 错误。被中断的 `TurnState`
   * 本身保存在 `this.state` 中（由 `interrupt()` 在中止前写入）；此标记仅用于区分两者。每次
   * `runAgentWorker` 开始时重置。
   */
  private parentAgentInterrupted = false;
  /**
   * 当前活动工作链的 promise。此值存在期间，调用方可以重复调用 `turn()`；这些
   * 命令会并入同一个 relay-pi turn。一个 relay-pi turn 可以包含多个父级 pi-agent turn 和多个状态机
   * 转换，但整个工作链只会发出一个公开终止事件。
   */
  private activeTurnPromise?: Promise<TurnTerminalEvent>;
  /**
   * 正在执行的 `compact()` promise。排空和推进 horizon 期间会公布此 promise，
   * 以便并发的 `turn()` 调用排在其后。Compact 不会设置 `activeTurnPromise`（它不会启动 turn
   * 工作链），因此对于 fire-and-forget 调用方（例如紧接 prompt 发出的 TUI `/compact` slash 命令），
   * 这是唯一能表明 wire-shaping horizon 正在推进的信号。
   */
  private compactInFlight?: Promise<void>;
  /** 由运行器拥有的最新 state；通过 `start()` 加载，并随终止事件推进。 */
  private state?: TurnState;
  /** `start()` 发出初始 `turn_started` 事件后为 true。 */
  private started = false;
  /** 汇总一个 turn 工作链中父级 Agent、状态 Agent 和记忆处理的 model 用量。 */
  private turnUsage?: TurnTokenUsage;
  /** `turnUsage` 按 model 划分的用量；通过 `recordUsage` 与其同步重置和填充。 */
  private turnUsageByModel?: ModelUsageEntry[];
  /**
   * 最新父级 assistant `message_end` 的进度条字段快照。
   * 状态 Agent 和终止事件会复用这些字段，因此仅状态 Agent 增加成本时，turn 中途的进度条/明细也不会跳变。
   *
   * 生产环境中，状态 Agent 运行时此值必定已设置：父级 worker 会通过真实 LLM 调用选择状态，该调用会发出 `message_end`
   * 并填充此快照。此字段开放为 `protected`，供越过真实父级路径、替代 `runAgentWorker` 的测试
   * harness 在触发状态 Agent 事件前设置快照。
   */
  protected lastParentUsageSnapshot?: {
    effectiveContextWindow: number;
    contextWindowUsage: TurnContextWindowUsage;
    lastMessageUsage: TurnTokenUsage;
  };
  /** 确保在首次需要持久化记忆的 turn 前只加载一次。 */
  private memoryLoaded = false;
  /** 在 `start()` 期间连接的 MCP 服务器；在运行器 `dispose()` 时释放。 */
  private mcpRuntime?: McpRuntime;
  protected readonly skillContext: SkillContext;
  protected readonly clock: RuntimeClock;
  protected readonly minimumScheduledDelayMs: number;
  /** 前台等待超时会返回仍在运行的结果，而不会取消任务。 */
  protected readonly taskWaitBudgetMs: number;

  constructor(
    readonly config: TurnRunnerConfig,
    dependencies: TurnRunnerDependencies = {},
  ) {
    this.clock = dependencies.clock ?? new SystemRuntimeClock();
    this.minimumScheduledDelayMs =
      dependencies.minimumScheduledDelayMs ?? MINIMUM_STATE_MACHINE_DELAY_MS;
    this.taskWaitBudgetMs = config.taskWaitBudgetMs ?? DEFAULT_TASK_WAIT_BUDGET_MS;
    this.skillContext = new SkillContext(config);
    this.taskManager = createTaskManager({
      clock: this.clock,
      onEvent: (event) => this.handleTaskEvent(event),
    });
    this.subagentExecutor = createSubagentExecutor({
      createAgent: (input, onControlResult) => this.createAgent(input, onControlResult),
      skillContext: {
        resolveSkills: (spec, ctx) =>
          this.skillContext.resolveSubagentSkills(
            spec.allowedSkills,
            ctx.machineContext ? `state "${ctx.machineContext.currentState}"` : "sub-agent",
          ),
        resolveSlashSkillPrompt: (prompt, skills) =>
          this.skillContext.resolveSlashSkillPrompt(prompt, skills),
        createSystemPromptWithAppendedLayers: (input) =>
          this.createBaseSystemPromptWithAppendedLayers(input),
      },
      inheritedOptions: () => this.resolveSubagentInheritedOptions(),
      resolveModel: (model) => this.resolveStateModel(model),
      seedMessages: (spec, ctx) =>
        spec.forkContext
          ? [...(ctx.forkSource?.messages() ?? this.parentAgent?.state.messages ?? [])]
          : [],
      parentSystemPrompt: (ctx) =>
        ctx.forkSource?.systemPrompt() ?? this.parentAgent?.state.systemPrompt,
      createTools: (cwd, ctx) =>
        this.createTools(
          "agent",
          cwd,
          false,
          ctx.childScopeId && ctx.ownerScopeId
            ? {
                ownerScopeId: ctx.childScopeId,
                ...(ctx.memoryContext?.sessionId
                  ? { memorySessionId: ctx.memoryContext.sessionId }
                  : {}),
                forkSource: {
                  messages: () => [...(ctx.agent?.state.messages ?? [])],
                  systemPrompt: () => ctx.agent?.state.systemPrompt,
                },
                modelSetting: () => {
                  const model = ctx.agent?.state.model;
                  return model ? `${model.provider}:${model.id}` : DEFAULT_CLI_MODEL;
                },
              }
            : undefined,
        ),
      retryTransientServerErrors: (agent) => this.retryTransientServerErrors(agent),
      retryConnectedTransportFallback: (agent, visibleOutput) =>
        this.retryConnectedTransportFallback(agent, visibleOutput),
      emitAgentEvent: (event, origin) => this.emitAgentEvent(event, origin),
      recordUsage: (usage, modelId, provider) => this.recordUsage(usage, modelId, provider),
      emitTurnUsage: (origin) => this.emitTurnUsage(origin),
    });
  }

  async dispose(): Promise<void> {
    this.parentAgent?.clearAllQueues();
    this.parentInputs.length = 0;
    this.clearFollowUpQueue();
    await this.taskManager.interruptAll("Runner disposed.");
    await this.taskManager.reapAll("Runner disposed.");
    await this.memoryPersistence?.dispose();
    this.memoryPersistence = undefined;
    await this.mcpRuntime?.dispose();
    this.mcpRuntime = undefined;
  }

  subscribe(handler: TurnEventHandler): () => void {
    this.eventHandlers.add(handler);
    return () => {
      this.eventHandlers.delete(handler);
    };
  }

  editFollowUpQueue(command: TurnEditFollowUpQueueCommand): void {
    this.requireStarted();
    this.replaceFollowUpQueue(command.prompts);
  }

  /**
   * 按需推进固定的 `wireGuardHorizon`，压缩运行器在 wire 上可见的消息尾部，
   * 让下一次向 actor model 发出的请求使用更小的 prompt。
   *
   * 重要：此操作**不会**修改 `state.agent.messages` 或父级 Agent 的实时对话记录。持久化对话记录是恢复、
   * 快照、观察/反思处理和 TUI 滚动历史的事实来源；删除它会丢失 wire-shaping
   * 流程特意要保留的信息。这里复用 `createObservationalContextTransform` 每个 turn 都会运行的 horizon 推进机制，
   * 只是立即执行，并使用比自动触发更严格的 token 目标。
   *
   * 目标选择：
   *   - 当前 wire 消息尾部的 token 数超过父级 Agent 有效上下文窗口的 `COMPACT_MESSAGE_TOKENS_RATIO`（20%）时，
   *     目标设为该 20% 上限，为 system prompt、记忆包、下一条用户 prompt 和下一次 assistant 回复
   *     留出 80% 空间。
   *   - wire 消息尾部已低于 20% 时，目标改为当前尾部 token 数的一半。`compact` 由用户主动触发，
   *     因此即使 Session 已经很轻，也应产生可见的改善。
   *
   * 成功推进 horizon 后会刷新记忆上下文包（与转换器 `onCompaction` 处理器使用相同的 fire-and-forget 调用），
   * 使渲染出的前缀与新 horizon 一致，并只支付一次 prompt 缓存失效成本，而不是两次。
   *
   * 父级 pass 正在派发，或 turn 循环仍活动且没有进程内任务时，会发出非强制警告并拒绝操作。运行中的任务会开启
   * 父级空闲窗口：它的对话记录与父级 wire horizon 隔离，因此可以安全地在 pass 之间推进 horizon。
   */
  async compact(): Promise<void> {
    this.requireStarted();
    // 父级工作拥有 wire 对话记录，因此会关闭此门控。
    // 进程内状态工作不会占用父级，使父级保持空闲并开放门控；定时等待已结束公开 turn，也同样开放。
    if (
      this.parentAgentRunning ||
      (this.activeTurnPromise && this.taskManager.pendingWork().kind !== "open") ||
      this.compactInFlight
    ) {
      this.emit({
        type: "system",
        level: "warn",
        message: this.compactInFlight
          ? "compact ignored: a compact pass is already in progress."
          : "compact ignored: a parent pass is in flight; retry in the parent-idle window.",
      });
      return;
    }
    // 公布 compact promise，让并发的 `turn()` 调用能够观察到它
    // 并排在其后。否则 fire-and-forget 调用方（例如 TUI
    // `/compact` slash 命令）可能让后续 prompt 使用压缩前的 wire 消息尾部派发，
    // 并与 horizon 修改竞争。内部逻辑完成后，promise 会以 `void` 完成，
    // 因此 `turn()` 只需等待，无需检查结果。
    const inFlight = this.runCompact();
    this.compactInFlight = inFlight;
    try {
      await inFlight;
    } finally {
      if (this.compactInFlight === inFlight) {
        this.compactInFlight = undefined;
      }
    }
  }

  private async runCompact(): Promise<void> {
    try {
      const state = this.requireRunnerState();
      const observable = stripObservationalContextMessages(state.agent.messages);
      const previousHorizon = this.wireGuardHorizon.evictionHorizon;
      const currentRetained = applyEvictionHorizon(observable, previousHorizon);
      const beforeTokens = calculateWireTokens(currentRetained);
      const contextWindow = this.effectiveContextWindow();
      const ceiling = Math.max(1, Math.floor(contextWindow * COMPACT_MESSAGE_TOKENS_RATIO));
      const overCeiling = beforeTokens > ceiling;
      const target = overCeiling ? ceiling : Math.max(1, Math.floor(beforeTokens / 2));
      const targetLabel = overCeiling
        ? `target ${target} = 20% of ${contextWindow}`
        : `target ${target} = 50% of current ${beforeTokens}`;
      // 在 horizon 越过尚未观察的消息尾部前，先保留它。
      await this.ensureMemoryCoverageForCompaction(observable);
      const newHorizon = findEvictionHorizon(
        observable,
        previousHorizon,
        (candidate) => calculateWireTokens(candidate) <= target,
      );
      if (newHorizon === previousHorizon) {
        this.emit({
          type: "system",
          level: "info",
          message: `compact: nothing to evict (wire-tail ~${beforeTokens} tokens; ${targetLabel}).`,
        });
        return;
      }
      this.wireGuardHorizon.evictionHorizon = newHorizon;
      this.modelRouter?.noteCompaction();
      const retainedAfter = applyEvictionHorizon(observable, newHorizon);
      const afterTokens = calculateWireTokens(retainedAfter);
      const dropped = currentRetained.length - retainedAfter.length;
      this.emit({
        type: "system",
        level: "info",
        message: `compact: dropped ${dropped} older wire message(s); wire-tail ~${beforeTokens} → ~${afterTokens} tokens (${targetLabel}).`,
      });
      // 立即刷新侧边栏上下文进度条，使明细反映
      // 新 horizon，而不必等待下一个父级
      // `message_end` 重新锚定 `lastMessageUsage`。否则，
      // 即使下一次请求将派发小得多的 wire 消息尾部，进度条仍会显示压缩前的
      // `184k / 200k` 数值。
      this.emitPostCompactUsage();
    } catch (error) {
      // 排空和刷新记忆包各自有 try/catch；此处的外层
      // catch 用于捕获 horizon 推进路径中的意外异常，
      // 确保 `runCompact` 始终正常结束，并由调用方的 finally
      // 重置 `compactInFlight`。
      this.emit({
        type: "system",
        level: "warn",
        message: `compact: failed (${truncateForSystemMessage(
          error instanceof Error ? error.message : String(error),
        )}).`,
      });
    }
  }

  /**
   * 在任何 turn 运行前准备 Session。解析初始 state（新建的 state，
   * 或通过 `command.state` 提供的恢复 state），并发加载所有独立资源，构建父级 Agent，最后
   * 发出 `turn_started`。此过程不会运行 Agent 工作。
   *
   * `turn_started` 是就绪契约：只有在连接凭据、持久化记忆、技能、MCP 工具和路由表都已
   * 就绪时才会发出，因此首条 prompt 不会与尚未构建完成的运行时发生竞态。调用方
   * （CLI/TUI/Session 管理器）会在启动时调用一次，使用户在输入首条 prompt 前就能看到
   * 可用技能。
   */
  async start(command: TurnStartCommand): Promise<TurnState> {
    const startupStartedAt = performance.now();
    const phaseTimings: Partial<Record<StartupPhase, number>> = {};
    const measure = async (name: StartupPhase, work: () => Promise<void>): Promise<void> => {
      const startedAt = performance.now();
      await work();
      phaseTimings[name] = performance.now() - startedAt;
    };
    const mode = command.mode ?? this.config.mode ?? "auto";
    let state = command.state ?? createInitialTurnState(mode, command.options);
    // 这些阶段会填充互不重叠的运行器/全局 state：已连接 provider
    // 凭据、记忆持久化/缓存、MCP 运行时、路由表和
    // 技能上下文。下面的父级 Agent 构建会首次使用这些资源。
    // 技能加载最后启动，因为它的文件系统发现是同步的；与此同时，异步凭据、记忆、MCP 和路由工作可以并行推进。
    const startupResults = await Promise.allSettled([
      measure("connected_tokens", () => ensureFreshConnectedTokens()),
      measure("memory", () => this.ensureMemoryLoaded()),
      measure("mcp", () => this.ensureMcpServersConnected(command.mcpServers)),
      measure("model_router", async () => {
        const { table } = await loadRoutingTable({
          cwd: this.config.cwd ?? process.cwd(),
          catalogAdapter: routingCatalogAdapter,
        });
        // 已保存的聊天选择可能属于此路由表，而不是模型目录。
        if (command.state) {
          state = restoreSavedExecutionSelections(
            command.state,
            command.options,
            table,
            normalizeSavedModelSelection,
          );
        }
        state = { ...state, options: this.resolveTurnOptions(state.options) };
        this.initializeModelRouter(state.options?.model, table);
      }),
      measure("skills", () => this.ensureSkillsLoaded()),
    ]);
    const startupFailure = startupResults.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (startupFailure) throw startupFailure.reason;
    const hydrationStartedAt = performance.now();
    this.stateMachine = state.stateMachine;
    this.recoverExecution =
      command.state !== undefined &&
      ((state.status !== "failed" &&
        state.status !== "interrupted" &&
        state.status !== "waiting_for_human") ||
        (state.pendingLostTaskReminderTaskIds?.length ?? 0) > 0);
    const recovery = this.taskManager.recover(
      state.tasks ?? [],
      state.nextTaskId,
      state.taskOutputTails,
    );
    const pendingLostTaskIds = new Set([
      ...(state.pendingLostTaskReminderTaskIds ?? []),
      ...recovery.lost.map((descriptor) => descriptor.id),
    ]);
    const lostSnapshots = [...pendingLostTaskIds]
      .map((id) => this.taskManager.output(id))
      .filter((snapshot): snapshot is TaskSnapshot => snapshot !== undefined);
    if (lostSnapshots.length > 0) {
      this.recoveredTaskReminder = lostTaskRecoveryReminder(lostSnapshots);
      while (this.taskManager.nextSettled()) {
        // 恢复信息通过一次性提醒传递，而不是通过实时结算通道。
      }
    }
    this.hydratedQueuedCommands = state.queuedCommands ? [...state.queuedCommands] : undefined;
    const interruptedOnRecovery =
      command.state &&
      (state.status === "running" ||
        (state.status === "sleeping" && this.taskManager.pendingWork().kind !== "sleep"));
    const recoveredState: TurnState = {
      ...state,
      ...(interruptedOnRecovery
        ? { status: "interrupted", agent: { ...state.agent, status: "cancelled" } }
        : {}),
      tasks: [...this.taskManager.list()],
      taskOutputTails: this.snapshotTaskOutputTails(),
      pendingLostTaskReminderTaskIds:
        lostSnapshots.length > 0
          ? lostSnapshots.map((snapshot) => snapshot.descriptor.id)
          : undefined,
      nextTaskId: this.taskManager.nextTaskId(),
    };
    // 在原对象上加载 wire-shaping 对象。`this.wireGuardHorizon` 被
    // 观察上下文转换器引用；若替换引用，转换器就会失去原有视图。对
    // 新建的默认对象执行 `Object.assign`，可将持久化 state 中已有的所有字段
    // 复制进来，而无需在此处维护字段列表。
    if (state.wireGuardHorizon) {
      Object.assign(this.wireGuardHorizon, state.wireGuardHorizon);
    }
    this.setState(recoveredState);
    this.initializeParentAgent();
    this.started = true;
    const hydratedState = this.requireRunnerState();
    phaseTimings.hydration = performance.now() - hydrationStartedAt;
    warnSlowStartup(phaseTimings, performance.now() - startupStartedAt);
    this.emit({ type: "turn_started", state: hydratedState });
    return hydratedState;
  }

  /**
   * 路由处理 turn 驱动命令，并解析为工作链共用的终止结果。
   * `onAccepted` 只有在命令进入活动驱动器或
   * 运行器自有队列后才会触发；传输层可在该边界确认投递，
   * 而无需将传输元数据泄漏到持久化 turn state 中。
   */
  async turn(command: TurnCommand, onAccepted?: () => void): Promise<TurnTerminalEvent> {
    this.requireStarted();
    await ensureFreshConnectedTokens();
    await this.ensureMemoryLoaded();
    await this.ensureSkillsLoaded();
    // 串行等待正在执行的 compact。Compact 会推进 wire
    // horizon，并可能向持久化存储写入观察记录；若并发启动 turn，它会派发压缩前的 wire 消息尾部，
    // 与 horizon 修改发生竞态。在这里等待，可让 fire-and-forget
    // 调用方（TUI 先 `/compact` 再发 prompt）获得与 RPC 模式相同的顺序保证；RPC 模式会在每轮之间等待 `compact`。
    if (this.compactInFlight) {
      await this.compactInFlight;
    }
    if (this.activeTurnPromise) {
      // `turn()` 是并发边界：重复调用会扩展当前工作链或排在其后，
      // 而不会创建独立的父级对话记录。
      this.handleCommandDuringActiveTurn(command);
      onAccepted?.();
      return this.activeTurnPromise;
    }

    const activeTurnPromise = this.runTurnLoop(command);
    this.activeTurnPromise = activeTurnPromise;
    onAccepted?.();
    try {
      return await activeTurnPromise;
    } finally {
      if (this.activeTurnPromise === activeTurnPromise) {
        this.activeTurnPromise = undefined;
      }
    }
  }

  private async runTurnLoop(command: TurnCommand): Promise<TurnTerminalEvent> {
    this.turnUsage = undefined;
    this.turnUsageByModel = undefined;
    this.interruptReason = undefined;
    this.interruptCleanup = undefined;
    this.terminalEmitted = false;
    this.parkNudged = false;
    this.activeRootScopeId = `turn-${this.nextRootScope++}` as const;
    const routeStatus = this.modelRouter?.status();
    this.advisorTurnLifecycle =
      this.requireRunnerState().mode === "agent" && this.advisorPolicy?.enabled && routeStatus
        ? new AdvisorTurnLifecycle(routeStatus.assistantSteps)
        : undefined;
    this.turnTools = this.createTools(this.requireRunnerState().mode).tools;
    const hasRetainedFollowUps = this.parentInputs.some(
      (input) => input.type === "user_command" && input.command.behavior === "follow_up",
    );
    this.enqueueParentInput(
      command.type === "wake" ? { type: "wake" } : { type: "user_command", command },
    );
    const carriedUserCommands = this.hydratedQueuedCommands?.filter(
      (queued): queued is TurnPromptCommand | TurnAnswerCommand => queued.type !== "wake",
    );
    if (carriedUserCommands && carriedUserCommands.length > 0) {
      for (const queued of carriedUserCommands) {
        this.enqueueParentInput({ type: "user_command", command: queued });
      }
    }
    if (
      !hasRetainedFollowUps &&
      !carriedUserCommands?.some((queued) => queued.behavior === "follow_up")
    ) {
      for (const entry of this.getFollowUpQueue()) {
        this.enqueueParentInput({
          type: "user_command",
          command: {
            type: "prompt",
            message: entry.message,
            behavior: "follow_up",
            images: entry.images,
          },
        });
      }
    }
    this.hydratedQueuedCommands = undefined;

    let questions: TurnQuestion[] | undefined;
    let completion: { status: "completed" | "failed"; result?: string; error?: string } = {
      status: "completed",
    };
    const remindedTasks = new Set<TaskId>();
    let terminal!: TurnTerminalEvent;
    const retainSleepingFollowUps = () =>
      this.taskManager.pendingWork().kind === "sleep" &&
      this.parentInputs.length > 0 &&
      this.parentInputs.every(
        (queued) => queued.type === "user_command" && queued.command.behavior === "follow_up",
      );
    for (;;) {
      try {
        while (!questions && !this.interruptReason) {
          this.enqueueAvailableSettlements();
          const pendingBeforeInput = this.taskManager.pendingWork();
          const runnableIndex =
            pendingBeforeInput.kind === "open"
              ? this.parentInputs.findIndex(
                  (queued) =>
                    queued.type === "task_settlements" ||
                    queued.type === "background_task_cleanup" ||
                    (queued.type === "user_command" && queued.command.behavior === "steer"),
                )
              : 0;
          const input =
            runnableIndex >= 0 ? this.parentInputs.splice(runnableIndex, 1)[0] : undefined;
          if (!input) {
            if (pendingBeforeInput.kind !== "open") {
              // 循环没有可执行工作时，turn 就在此刻结束；
              // 每次 park 都会经过这里。状态完成后的转换中若选择了 park，
              // 不会返回任何结果，因此若改为监听终止结果，
              // 第一次之后的 park 都会被漏掉。
              const pendingTransition = this.requireRunnerState().pendingStateTransition;
              if (pendingTransition && !this.stateMachine?.terminal) {
                this.parentInputs.push({
                  type: "transition_enforcement",
                  ...pendingTransition,
                  output: this.completedStateOutput(pendingTransition.stateName),
                });
                continue;
              }
              if (this.queueParkNudgeIfDue(completion.status, pendingBeforeInput)) continue;
              const unfinished = this.stateMachine?.definition.states.find(
                (state) => state.name === this.stateMachine?.currentState,
              );
              if (
                this.recoverExecution &&
                completion.status === "completed" &&
                pendingBeforeInput.kind === "complete" &&
                !this.stateMachine?.terminal &&
                unfinished &&
                (unfinished.kind === "agent" ||
                  unfinished.kind === "script" ||
                  unfinished.kind === "poll" ||
                  unfinished.kind === "timer")
              ) {
                this.parentInputs.push({ type: "recover_state", stateName: unfinished.name });
                continue;
              }
              break;
            }
            const running = this.taskManager.list().filter((task) => task.status === "running");
            // 正在运行的状态 worker 仍拥有其工作。它返回后，针对每个任务给
            // 父级一次清理机会，而不是静默地将状态转换
            // 挂在可能永远不会自行退出的服务器之后。
            if (
              !running.some((task) => this.stateTasks.has(task.id)) &&
              running.some((task) => !remindedTasks.has(task.id))
            ) {
              for (const task of running) remindedTasks.add(task.id);
              this.parentInputs.push({ type: "background_task_cleanup" });
              continue;
            }
            await this.waitForLoopActivity();
            continue;
          }

          if (
            input.type === "wake" &&
            input.queued === true &&
            this.taskManager.pendingWork().kind !== "sleep" &&
            this.requireRunnerState().status !== "sleeping"
          ) {
            continue;
          }

          const result = await this.processParentLoopInput(input);
          if (result?.type === "ask") {
            if (this.taskManager.pendingWork().kind === "open") {
              // 终止后进入静默状态，当前禁止立即投递 ask。暂存
              // 问题，仅用于在父级下一次 pass 中提醒它
              // （任务结算会保证有下一次 pass）；如果问题仍相关，父级会重新提问。
              this.withheldAskQuestions = result.questions;
            } else {
              questions = result.questions;
            }
          }
          if (result?.type === "interrupted") this.interruptReason ??= "Interrupted";
          if (result?.type === "state_completed") {
            // 在每个 worker 边界重新检查跨状态保留的任务，
            // 不要仅仅因为父级选择等待就再次提示。
            remindedTasks.clear();
            this.setState({
              ...this.requireRunnerState(),
              pendingStateTransition: { stateName: result.stateName },
            });
            this.enqueueParentInput({
              type: "transition_enforcement",
              stateName: result.stateName,
              output: result.output,
            });
          }
          if (result?.type === "terminal") {
            if (this.queueAdvisorCompletionReviewIfDue(result.status)) continue;
            completion = {
              status: result.status === "error" ? "failed" : "completed",
              ...(result.result !== undefined ? { result: result.result } : {}),
              ...(result.error !== undefined ? { error: result.error } : {}),
            };
            if (this.stateMachine?.terminal && !this.stateMachine.terminalAcknowledged) {
              this.enqueueParentInput({ type: "terminal_acknowledgment" });
            }
          }

          // 保留旧的排空规则：选择 sleep 后到达的 follow-up
          // 继续排队，留给下一次用户驱动的 turn。上面的逻辑会跳过过期的 wake，
          // 避免它覆盖有意义的结果。
          if (retainSleepingFollowUps()) {
            break;
          }
        }
      } catch (error) {
        completion = {
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        };
        await this.taskManager.interruptAll(`Turn failed: ${completion.error}`);
      } finally {
        await this.interruptCleanup;
        if (!this.interruptReason && !questions && this.taskManager.pendingWork().kind === "open") {
          await this.taskManager.interruptAll("Turn exited with in-process work still active.");
          completion = {
            status: "failed",
            error: "Turn exited with in-process work still active.",
          };
        }
        this.discardStaleTaskSettlements();
        const quiescentState = this.snapshotState(this.requireRunnerState());
        try {
          await this.updateMemoryAfterAgentRun(
            quiescentState.agent.messages,
            quiescentState.options,
          );
        } catch (error) {
          // 记忆只是记录工作，不应决定 turn 的结果。观察失败时，
          // 消息尾部只会暂时未被观察，留待下一次
          // pass 重试——这与压缩
          // 调用点（`ensureMemoryCoverageForCompaction`）采用相同的尽力而为契约。
          this.emit({
            type: "system",
            level: "warn",
            message: `Memory update failed (${truncateForSystemMessage(
              error instanceof Error ? error.message : String(error),
            )}); the unobserved tail is retried next pass.`,
          });
        }
      }
      // 记录工作等待期间接受的可运行输入，仍由当前完成流程处理。
      if (
        !this.interruptReason &&
        !questions &&
        this.parentInputs.length > 0 &&
        !retainSleepingFollowUps()
      ) {
        continue;
      }
      const state = this.snapshotState(this.requireRunnerState());
      if (this.interruptReason) {
        terminal = {
          type: "interrupted",
          state: {
            ...state,
            status: "interrupted",
            agent: { ...state.agent, status: "cancelled" },
          },
        };
      } else if (questions) {
        terminal = {
          type: "ask",
          questions,
          state: { ...state, status: "waiting_for_human" },
        };
      } else {
        const settledPending = this.taskManager.pendingWork();
        terminal =
          settledPending.kind === "sleep"
            ? {
                type: "sleep",
                wakeAt: settledPending.wakeAt,
                state: { ...state, status: "sleeping" },
              }
            : completeTurn(state, completion.status, completion.result, completion.error);
      }
      terminal = this.attachTurnUsage({ ...terminal, state: this.snapshotState(terminal.state) });
      this.setState(terminal.state);
      this.emitTerminalOnce(terminal);
      this.turnTools = undefined;
      this.advisorTurnLifecycle = undefined;
      this.activeRootScopeId = undefined;
      this.turnUsage = undefined;
      this.turnUsageByModel = undefined;
      break;
    }
    return terminal;
  }

  private handleCommandDuringActiveTurn(command: TurnCommand): void {
    if ((command.type === "prompt" || command.type === "answer") && this.parentAgentRunning) {
      // 父级 pi-agent 正在驱动公开终止事件，因此
      // 用户输入可直接使用 pi 原生的 steer/follow-up 队列发送给 pi。
      if (command.behavior === "follow_up") {
        this.appendFollowUpPrompt(this.commandToUserMessage(command), command.images);
      }
      this.sendCommandToAgent(this.requireParentAgent(), command);
      return;
    }

    this.enqueueParentInput(
      command.type === "wake" ? { type: "wake", queued: true } : { type: "user_command", command },
    );
    if (
      (command.type === "prompt" || command.type === "answer") &&
      command.behavior === "follow_up"
    ) {
      this.appendFollowUpPrompt(this.commandToUserMessage(command), command.images);
    }
  }

  private sendCommandToAgent(agent: Agent, command: TurnPromptCommand | TurnAnswerCommand): void {
    const message = this.commandToUserMessage(command);
    const images = command.type === "prompt" ? command.images : undefined;
    const agentMessage = buildUserAgentMessage(message, images);
    const input = { type: "user_command" as const, command };
    this.enqueueParentInput(input);
    this.piQueuedInputs.set(agentMessage, input);
    if (command.behavior === "steer") {
      agent.steer(agentMessage);
    } else {
      agent.followUp(agentMessage);
    }
  }

  private enqueueParentInput(input: ParentLoopInput): void {
    this.parentInputs.push(input);
    for (const wake of this.parentInputWaiters) wake();
    this.parentInputWaiters.clear();
  }

  /**
   * 阻塞等待循环尚未处理的事项到达：父级输入
   * 或任务结算。只有循环确认没有可运行项后才会调用此方法，
   * 因此已经排队的内容不能算作新活动——
   * `enqueueAvailableSettlements` 正是为了此目的而排空任务管理器队列。
   */
  private async waitForLoopActivity(): Promise<void> {
    let wake!: () => void;
    const parentInput = new Promise<void>((resolve) => {
      wake = resolve;
      this.parentInputWaiters.add(wake);
    });
    try {
      await Promise.race([this.taskManager.waitForSettlement().then(() => undefined), parentInput]);
    } finally {
      this.parentInputWaiters.delete(wake);
    }
  }

  /**
   * 将所有结算从任务管理器移入暂存缓冲区。
   * 管理器队列绝不能保留循环已经看到的结算：
   * `waitForSettlement` 会把非空队列视为新活动；若循环在前台等待期间持有结算，
   * 就会在每个微任务中重复运行，却始终无法让出控制权，等待结束该等待的 I/O。
   */
  private holdSettledTasks(): void {
    for (
      let settlement = this.taskManager.nextSettled();
      settlement;
      settlement = this.taskManager.nextSettled()
    ) {
      this.heldSettlements.push(settlement);
    }
  }

  private enqueueAvailableSettlements(): void {
    this.holdSettledTasks();
    if ([...this.taskSettlementDelivery.values()].includes("foreground_pending")) return;
    const settlements: TaskSettlement[] = [];
    for (const settlement of this.heldSettlements.splice(0)) {
      const delivery = this.taskSettlementDelivery.get(settlement.id);
      this.taskSettlementDelivery.delete(settlement.id);
      if (delivery !== "suppress") settlements.push(settlement);
    }
    if (settlements.length === 0) return;

    const canSteer =
      this.parentAgentRunning &&
      this.parentControlResults.length === 0 &&
      settlements.every((settlement) => !this.stateTasks.has(settlement.id));
    if (canSteer) {
      const snapshots = settlements
        .map((settlement) => this.taskManager.output(settlement.id))
        .filter((snapshot) => snapshot !== undefined);
      if (snapshots.length > 0) {
        this.requireParentAgent().steer(
          buildUserAgentMessage(settlementNotice(snapshots), undefined),
        );
        return;
      }
    }
    this.parentInputs.unshift({ type: "task_settlements", settlements });
  }

  private handleTaskEvent(event: TaskEvent): void {
    if (event.type === "started") {
      this.emit({ type: "task_started", task: event.descriptor });
      return;
    }
    if (event.type === "output") {
      this.emit({ type: "task_output", taskId: event.id, chunk: event.chunk });
      return;
    }
    this.emit({ type: "task_settled", settlement: event.settlement });
    if (this.taskSettlementDelivery.get(event.settlement.id) === "foreground_pending") return;
    this.scheduleSettlementDelivery();
  }

  private scheduleSettlementDelivery(): void {
    if (this.settlementDeliveryQueued) return;
    this.settlementDeliveryQueued = true;
    queueMicrotask(() => {
      this.settlementDeliveryQueued = false;
      this.enqueueAvailableSettlements();
      for (const wake of this.parentInputWaiters) wake();
      this.parentInputWaiters.clear();
    });
  }

  private discardStaleTaskSettlements(): void {
    this.holdSettledTasks();
    for (const settlement of this.heldSettlements.splice(0)) {
      this.stateTasks.delete(settlement.id);
      this.ignoredTaskSettlements.delete(settlement.id);
      this.taskSettlementDelivery.delete(settlement.id);
    }
    for (const input of this.parentInputs) {
      if (input.type !== "task_settlements") continue;
      for (const settlement of input.settlements) {
        this.stateTasks.delete(settlement.id);
        this.ignoredTaskSettlements.delete(settlement.id);
        this.taskSettlementDelivery.delete(settlement.id);
      }
    }
    const userInputs = this.parentInputs.filter((input) => input.type !== "task_settlements");
    this.parentInputs.splice(0, this.parentInputs.length, ...userInputs);
  }

  private commandToUserMessage(command: TurnPromptCommand | TurnAnswerCommand): string {
    if (command.type === "prompt") {
      return this.skillContext.resolveSlashSkillPrompt(command.message);
    }

    const answerXml = toXML([{ questions: command.questions }, { answers: command.answers }]);
    const base = dedent`
      Here are my answers to your questions.

      ${answerXml}
    `;
    if (!command.message?.trim()) return base;
    return `${base}\n\n${this.skillContext.resolveSlashSkillPrompt(command.message)}`;
  }

  private replaceFollowUpQueue(entries: TurnFollowUpQueueEntry[]): void {
    this.setFollowUpQueue(entries);
    this.parentAgent?.clearFollowUpQueue();
    for (const [message, input] of this.piQueuedInputs) {
      if (input.command.behavior === "follow_up") this.piQueuedInputs.delete(message);
    }
    this.parentInputs.splice(
      0,
      this.parentInputs.length,
      ...this.parentInputs.filter(
        (input) => input.type !== "user_command" || input.command.behavior !== "follow_up",
      ),
    );
    this.hydratedQueuedCommands = this.hydratedQueuedCommands?.filter(
      (command) => !this.isFollowUpQueueCommand(command),
    );
    const state = this.requireRunnerState();
    this.setState({
      ...state,
      queuedCommands: state.queuedCommands?.filter(
        (command) => !this.isFollowUpQueueCommand(command),
      ),
    });
    if (this.parentAgentRunning) {
      for (const entry of entries) {
        this.sendCommandToAgent(this.requireParentAgent(), {
          type: "prompt",
          message: entry.message,
          images: entry.images,
          behavior: "follow_up",
        });
      }
    } else if (this.activeTurnPromise) {
      for (const entry of entries) {
        this.enqueueParentInput({
          type: "user_command",
          command: {
            type: "prompt",
            message: entry.message,
            behavior: "follow_up",
            images: entry.images,
          },
        });
      }
    }
    this.emitFollowUpQueue();
  }

  private isFollowUpQueueCommand(
    command: TurnCommand,
  ): command is TurnPromptCommand | TurnAnswerCommand {
    return (
      (command.type === "prompt" || command.type === "answer") && command.behavior === "follow_up"
    );
  }

  private appendFollowUpPrompt(message: string, images?: TurnPromptImage[]): void {
    const entry: TurnFollowUpQueueEntry =
      images && images.length > 0 ? { message, images } : { message };
    this.setFollowUpQueue([...this.getFollowUpQueue(), entry]);
    this.emitFollowUpQueue();
  }

  private removeQueuedFollowUpPrompt(command: TurnCommand): void {
    if (!this.isFollowUpQueueCommand(command)) return;
    this.removeFollowUpPrompt(this.commandToUserMessage(command));
  }

  /**
   * 删除首个 `message` 文本匹配的排队项。Pi-agent 的
   * 持久化对话记录只保留多模态用户内容中的文本部分，因此文本是实时和
   * 回放 follow-up 共用的规范去重键。
   */
  private removeFollowUpPrompt(message: string): void {
    const entries = this.getFollowUpQueue();
    const index = entries.findIndex((entry) => entry.message === message);
    if (index === -1) return;
    this.setFollowUpQueue([...entries.slice(0, index), ...entries.slice(index + 1)]);
    this.emitFollowUpQueue();
  }

  private clearFollowUpQueue(): void {
    if (this.getFollowUpQueue().length === 0) return;
    this.setFollowUpQueue([]);
    this.emitFollowUpQueue();
  }

  private emitFollowUpQueue(): void {
    this.emit({ type: "follow_up_queue", followUpQueue: this.getFollowUpQueue() });
  }

  interrupt(_command: TurnInterruptCommand): void {
    this.requireStarted();
    if (!this.state) return;
    this.recoverExecution = false;
    this.interruptReason = "Interrupted";
    this.parentAgentInterrupted = this.parentAgentRunning;
    this.parentAgent?.abort();
    // 已知问题：这些队列可能包含 turn 中途已接受、
    // 但模型尚未消费的用户 prompt（steer/follow_up）。清空队列会丢弃这些 prompt，尽管调用方已被告知它们
    // 已投递；因此中断若恰好与刚发送的消息竞态，就可能丢失消息。暂时接受此边缘情况；修复方式是将尚未消费的
    // 用户 prompt 重新作为待处理输入发出，留给下一次 turn，而不是直接清除。
    this.parentAgent?.clearAllQueues();
    this.parentInputs.length = 0;
    this.clearFollowUpQueue();
    this.parentAgentRunning = false;
    this.interruptCleanup = this.interruptTasks("Interrupted");
    if (!this.activeTurnPromise) {
      this.terminalEmitted = false;
      void this.interruptCleanup.then(() => {
        const state = this.snapshotState(this.requireRunnerState());
        const terminal: TurnTerminalEvent = {
          type: "interrupted",
          state: {
            ...state,
            status: "interrupted",
            agent: { ...state.agent, status: "cancelled" },
          },
        };
        this.setState(terminal.state);
        this.emitTerminalOnce(terminal);
      });
    }
  }

  protected emit(event: TurnEvent): void {
    for (const handler of this.eventHandlers) {
      handler(event);
    }
  }

  private async processParentLoopInput(
    input: PendingParentLoopInput,
  ): Promise<SettledDecision["outcome"] | undefined> {
    switch (input.type) {
      case "user_command":
        return this.runUserCommandPass(input.command, input.continuation);
      case "task_settlements":
        return this.processTaskSettlements(input.settlements);
      case "transition_enforcement":
        return this.selectNextStateAfterCompletion(input.stateName, input.output);
      case "terminal_acknowledgment":
        return this.runTerminalAcknowledgmentPass();
      case "advisor_completion_review":
        return this.runAdvisorCompletionReviewPass();
      case "recover_state":
        return this.enforceParentTransition(
          (retry) =>
            systemReminder(
              `The relay is unfinished at "${input.stateName}", but no worker or scheduled wake exists. Nothing is running in the background. Recover by selecting the appropriate state with select_state_machine_state; inspect existing results before repeating side effects. Ask the user only if required, or explicitly fail/cancel the relay. ${retry ?? ""}`,
            ),
          `Relay state "${input.stateName}" has no worker or scheduled wake; recovery did not select a state.`,
        );
      case "background_task_cleanup":
        return this.runBackgroundTaskCleanupPass();
      case "park_nudge":
        return this.runParkNudgePass();
      case "wake":
        return this.runWakeInput();
    }
  }

  private async runBackgroundTaskCleanupPass() {
    const running = this.taskManager.list().filter((task) => task.status === "running");
    if (running.length === 0) return undefined;
    const worker = await this.runParentPass({
      state: this.snapshotState({ ...this.requireRunnerState(), status: "running" }),
      prompt: systemReminder(dedent`
        Your pass has ended, but background tasks are still running:
        ${running
          .slice(0, 20)
          .map((task) => `- ${task.id} (${task.name}): ${task.label.slice(0, 300)}`)
          .join("\n")}
        ${running.length > 20 ? "Use task_output without an id to list all remaining tasks." : ""}

        The turn remains open, and any relay continuation waits, until these
        tasks finish or are stopped. Before advancing or finishing,
        use task_output with an id to inspect progress or with wait to wait for
        completion; use task_stop with an id for work no longer needed, such as a
        temporary preview server. Do not stop useful work just to finish. If it
        will finish on its own soon, you may simply end this response and wait;
        the runner will resume you when it settles. Ending this response does
        not finish the turn while tasks remain running.
      `),
      continuation: true,
    });
    this.setState(worker.outcome.state);
    // 如果此处失败的终止结果被返回，循环会继续等待可能
    // 永远不会退出的任务；抛出异常会结束 turn 并回收这些任务。
    if (worker.outcome.type === "complete" && worker.outcome.status === "failed") {
      throw new Error(worker.outcome.error ?? "Background task cleanup failed.");
    }
    return this.settleContinuationPass(worker);
  }

  private async runUserCommandPass(
    command: TurnPromptCommand | TurnAnswerCommand,
    continuation = false,
  ) {
    const runningState = {
      ...this.requireRunnerState(),
      status: "running" as const,
    };
    const state = continuation ? runningState : this.clearFinishedTodosAtTurnStart(runningState);
    let prompt = this.commandToUserMessage(command);
    if (state.pendingStateTransition) {
      prompt += `\n\n${systemReminder(`The relay state "${state.pendingStateTransition.stateName}" already completed. Its next-state decision is pending. Review its saved result and select the next state; do not rerun completed work merely to resume. ${toXML({ state_completed: { output: this.completedStateOutput(state.pendingStateTransition.stateName) ?? null } })}`)}`;
    }
    if (
      !continuation &&
      command.behavior === "steer" &&
      this.taskManager.pendingWork().kind === "open"
    ) {
      prompt = `${systemReminder(dedent`
        <system-reminder>
        The user sent this as a steer message while state-machine work is running.
        If the state-machine should change course, call select_state_machine_state to restart the current state with updated input or choose a different state.
        </system-reminder>
      `)}\n\n${prompt}`;
    }
    const todoReminder = continuation ? undefined : formatCarriedTodosReminder(state.todos);
    if (todoReminder) prompt = `${todoReminder}\n\n${prompt}`;
    if (!continuation) this.removeQueuedFollowUpPrompt(command);
    const worker = await this.runParentPass({
      state,
      prompt,
      images: promptImagesToContent(command.images),
      continuation,
    });
    this.setState(worker.outcome.state);
    if (
      worker.outcome.type === "complete" &&
      worker.outcome.status === "failed" &&
      this.taskManager.pendingWork().kind === "sleep"
    ) {
      this.emit({
        type: "system",
        level: "error",
        message: worker.outcome.error ?? worker.outcome.result ?? "Prompt failed while waiting.",
      });
    }
    if (worker.outcome.type === "interrupted") return { type: "interrupted" } as const;
    if (state.mode === "agent") {
      if (worker.control.type === "ask_user_question") {
        return { type: "ask", questions: worker.control.questions } as const;
      }
      return worker.outcome.status === "failed"
        ? ({ type: "terminal", status: "error", error: worker.outcome.error } as const)
        : ({ type: "terminal", status: "completed", result: worker.outcome.result } as const);
    }
    const result = await this.stateMachineResultFromWorker(worker, worker.outcome.state);
    if (result) return result;
    return worker.outcome.status === "failed"
      ? ({ type: "terminal", status: "error", error: worker.outcome.error } as const)
      : ({ type: "terminal", status: "completed", result: worker.outcome.result } as const);
  }

  private async runParentPass(input: AgentWorkerInput): Promise<AgentWorkerResult> {
    const stateName = this.stateMachine?.currentState;
    const retryWarning = stateName ? this.repeatedSelectionLoopWarning(stateName) : undefined;
    if (retryWarning) {
      this.emit({ type: "system", level: "warn", message: retryWarning });
      input = { ...input, prompt: `${input.prompt}\n\n${retryWarning}` };
    }
    const agent = this.requireParentAgent();
    if (agent.hasQueuedMessages()) {
      throw new Error("Parent pi steer/follow-up queues must be empty at internal pass start.");
    }
    const recoveredTaskReminder = this.recoveredTaskReminder;
    this.recoveredTaskReminder = undefined;
    if (recoveredTaskReminder) {
      this.setState({
        ...this.requireRunnerState(),
        pendingLostTaskReminderTaskIds: undefined,
      });
    }
    const recoveryInput = recoveredTaskReminder
      ? {
          ...input,
          state: { ...input.state, pendingLostTaskReminderTaskIds: undefined },
          prompt: `${recoveredTaskReminder}\n\n${input.prompt}`,
        }
      : input;
    const parked = currentParkState(this.stateMachine);
    // 将提醒附加到当前即将执行的 pass，因此离开 park 的转换
    // 不需要额外的 model 调用。选择工具会在进入状态时的 pass 中
    // 将同一提醒放入终止结果，此时 currentState 尚未改变。
    return this.runAgentWorker(
      parked
        ? { ...recoveryInput, prompt: `${recoveryInput.prompt}\n\n${parkNudge(parked.name)}` }
        : recoveryInput,
    );
  }

  private async runWakeInput(): Promise<SettledDecision["outcome"] | undefined> {
    const planned = planWake(this.stateMachine, this.clock.now());
    if (!planned) {
      return { type: "terminal", status: "completed", result: "Nothing to wake." };
    }
    await this.cancelScheduledTasks("Scheduled wake fired.");
    this.setStateMachine(planned.session);
    return this.executePlannedWork(planned.work, planned.selection);
  }

  private async runTerminalAcknowledgmentPass() {
    const session = this.stateMachine;
    if (!session?.terminal || session.terminalAcknowledged) return undefined;
    this.setStateMachine(markTerminalAcknowledged(session));
    const acknowledged = this.stateMachine;
    if (!acknowledged?.terminal) return undefined;
    const worker = await this.runParentPass({
      state: this.snapshotState({ ...this.requireRunnerState(), status: "running" }),
      prompt: formatStateMachineTerminalAcknowledgmentPrompt({ session: acknowledged }),
      continuation: true,
    });
    this.setState(worker.outcome.state);
    if (worker.outcome.type === "interrupted") return { type: "interrupted" } as const;
    return this.stateMachineResultFromWorker(worker, worker.outcome.state);
  }

  /**
   * 将已完成的延续 pass 归并为循环结果：中断、ask、
   * 父级发出的任意控制操作，或 turn 完成。所有
   * 运行器拥有的延续 pass 都以相同方式结算，因此共用此方法，
   * 而不分别重新推导这四种结果的优先顺序。
   */
  private async settleContinuationPass(
    worker: AgentWorkerResult,
  ): Promise<SettledDecision["outcome"]> {
    if (worker.outcome.type === "interrupted") return { type: "interrupted" };
    if (worker.control.type === "ask_user_question") {
      return { type: "ask", questions: worker.control.questions };
    }
    if (this.requireRunnerState().mode !== "agent") {
      const controlled = await this.stateMachineResultFromWorker(worker, worker.outcome.state);
      if (controlled) return controlled;
    }
    return worker.outcome.status === "failed"
      ? { type: "terminal", status: "error", error: worker.outcome.error }
      : { type: "terminal", status: "completed", result: worker.outcome.result };
  }

  /**
   * 状态机仍处于 park 时，若 turn 即将以完成状态结束，就额外运行一次父级 pass。
   * `runParentPass` 会自行附加 {@link parkNudge}，因此这里仅提供“你的 turn 即将结束”这一提示。再次结束 turn
   * 也是合法结果——此 pass 只是提醒，并非强制要求——所以
   * 父级接下来的任何操作都会按正常方式结算 turn。
   */
  private async runParkNudgePass() {
    const worker = await this.runParentPass({
      state: this.snapshotState({ ...this.requireRunnerState(), status: "running" }),
      prompt: PARK_END_OF_TURN_NUDGE,
      continuation: true,
    });
    this.setState(worker.outcome.state);
    return this.settleContinuationPass(worker);
  }

  /**
   * 成功的 turn 即将结束且状态机处于 park 时，排入一次提醒 pass。Park 不会安排唤醒，因此不会有其他机制
   * 恢复状态机：若父级进入 park 后忘记转换，这就是最后一次能发现问题的机会。每个已执行状态只花费一次提醒，
   * 因此父级确实在等待用户时不会被催促转换；而在实际工作轮次之间 park 的循环，每轮仍会收到提醒（见
   * {@link executePlannedWork}）。只要仍有待处理工作——正在运行的任务或会自行恢复状态机的定时唤醒——就说明 turn
   * 并非因停滞的 park 而结束，无需提醒。
   */
  private queueParkNudgeIfDue(status: "completed" | "failed", pending: PendingWork): boolean {
    if (
      status !== "completed" ||
      this.parkNudged ||
      pending.kind !== "complete" ||
      !currentParkState(this.stateMachine)
    ) {
      return false;
    }
    this.parkNudged = true;
    this.parentInputs.unshift({ type: "park_nudge" });
    return true;
  }

  private async runAdvisorCompletionReviewPass() {
    const worker = await this.runParentPass({
      state: this.snapshotState({ ...this.requireRunnerState(), status: "running" }),
      prompt: systemReminder(ADVISOR_COMPLETION_REVIEW_REMINDER),
      continuation: true,
    });
    this.setState(worker.outcome.state);
    // 此操作只会在 Agent 模式排入，因此共用结算逻辑中的状态机
    // 分支在这里不可达。
    return this.settleContinuationPass(worker);
  }

  /**
   * 只有已完成的 Agent 模式 turn 完成了足够多工作、确实能从审查中
   * 受益时，才排入新的父级延续 pass。若成功咨询后没有再执行任何实际工具工作，则顾问已经
   * 看到最后可用的证据；无需统计调用次数，这本身就满足此检查点。否则，完成会开启独立的顾问阶段，因此该阶段首次调用会获得新的常规下限，
   * 即使刚刚执行过方向判断调用也是如此。先标记检查点再入队，可避免
   * 失败和被忽略的提醒递归触发。
   */
  private queueAdvisorCompletionReviewIfDue(
    status: "completed" | "failed" | "cancelled" | "error",
  ): boolean {
    const lifecycle = this.advisorTurnLifecycle;
    const routeStatus = this.modelRouter?.status();
    if (
      status !== "completed" ||
      !lifecycle ||
      !routeStatus ||
      this.taskManager.pendingWork().kind === "open" ||
      !lifecycle.takeCompletionCheckpoint(routeStatus.assistantSteps)
    ) {
      return false;
    }
    // 完成审查是独立的产品生命周期阶段，类似于
    // 路由切换后新 model 开始一个新阶段。重置
    // 步骤下限，而不是绕过顾问门控，以继续遵守常规的
    // 进行中预留和成功后的冷却时间。
    this.modelRouter?.resetAdvisorCooldown();
    this.parentInputs.unshift({ type: "advisor_completion_review" });
    return true;
  }

  private async executePlannedWork(
    work: PlannedWork,
    selection?: ExecutionSelection,
  ): Promise<SettledDecision["outcome"] | undefined> {
    this.recoverExecution = false;
    if ("terminal" in work) {
      const settled = recordPlannedTerminal(this.requireStateMachine(), work.terminal);
      this.setStateMachine(settled.session);
      return settled.outcome;
    }
    if ("schedule" in work) {
      if (work.schedule.wakeAt > this.clock.now()) {
        this.taskManager.start({
          kind: "scheduled",
          name: work.schedule.stateName,
          label: `Wait for ${work.schedule.stateName}`,
          ownerScopeId: this.requireRootScope(),
          wakeAt: work.schedule.wakeAt,
        });
        const settled = recordScheduled(
          this.requireStateMachine(),
          work.schedule.stateName,
          work.schedule.wakeAt,
        );
        this.setStateMachine(settled.session);
        return settled.outcome;
      }
      const now = this.clock.now();
      const startedAt = this.stateMachine?.progress?.states[work.schedule.stateName]?.startedAt;
      const settled = recordSettled(
        this.requireStateMachine(),
        work.schedule.stateName,
        "timer",
        {
          type: "completed",
          output: {
            elapsedMs: startedAt === undefined ? 0 : Math.max(0, now - startedAt),
            timestamp: now,
          },
        },
        undefined,
        now,
      );
      this.setStateMachine(settled.session);
      return settled.outcome;
    }
    if ("park" in work) return undefined;
    // 运行状态代表进展，因此下次进入 park 时可再次使用 turn 结束提醒。
    // 若父级只是重复进入 park，没有运行任何工作，就永远不会到达此行，因此最多只会提醒一次。
    this.parkNudged = false;
    if ("subagent" in work.run) {
      this.startSubagentTask(work.run.subagent, work.run.stateName, selection);
    } else {
      this.startShellTask(work.run.shell, work.run.stateName, work.run.pollPolicy, selection);
    }
    return undefined;
  }

  private startSubagentTask(
    spec: SubagentSpec,
    stateName: string,
    selection?: ExecutionSelection,
  ): void {
    const cwd = resolveStateCwd(spec.cwd, this.config.cwd ?? process.cwd());
    const ownerScopeId = this.requireRootScope();
    const handle = this.taskManager.start({
      kind: "subagent",
      name: stateName,
      label: `Run state ${stateName}`,
      ownerScopeId,
      execute: async ({ signal, taskId }) => {
        if (signal.aborted) return { type: "interrupted" } satisfies SubagentResult;
        const run = this.createStateSubagentRun({
          state: { kind: "agent", name: stateName, ...spec, cwd },
          prompt: spec.prompt,
          origin: { taskId },
        });
        if (selection) {
          const receipt = run.prepared
            ? annotateUnchangedExecution(
                this.requireStateMachine(),
                executionReceipt({ id: taskId, selection, cwd, prepared: run.prepared }),
              )
            : undefined;
          const accepted = receipt
            ? recordAcceptedExecution(this.requireStateMachine(), receipt)
            : this.requireStateMachine();
          this.setStateMachine(
            recordStateStarted(accepted, selection.state, selection.input, receipt),
            true,
          );
        }
        const metadata = this.stateTasks.get(taskId);
        if (metadata?.kind === "agent") metadata.run = run;
        const interrupt = () => run.interrupt(String(signal.reason ?? "Interrupted"));
        if (signal.aborted) interrupt();
        signal.addEventListener("abort", interrupt, { once: true });
        try {
          return await run.prompt();
        } finally {
          signal.removeEventListener("abort", interrupt);
        }
      },
    });
    this.stateTasks.set(handle.id, { kind: "agent", stateName });
  }

  private startShellTask(
    spec: ShellSpec,
    stateName: string,
    pollPolicy?: PollPolicy,
    selection?: ExecutionSelection,
  ): void {
    const cwd = resolveStateCwd(spec.cwd, this.config.cwd ?? process.cwd());
    const shell = createShellStateHandle({
      command: spec.command,
      cwd,
      timeoutMs: spec.timeoutMs,
      successCodes: spec.successCodes,
    });
    let taskId!: TaskId;
    const handle = this.taskManager.start({
      kind: "tool",
      name: stateName,
      label: `Run state ${stateName}`,
      ownerScopeId: this.requireRootScope(),
      execute: async ({ signal, onOutput }) => {
        if (signal.aborted)
          return {
            type: "interrupted",
            reason: String(signal.reason ?? "Interrupted"),
          } satisfies ShellSettlement;
        if (selection) {
          const receipt = annotateUnchangedExecution(
            this.requireStateMachine(),
            executionReceipt({ id: taskId, selection, cwd, prepared: spec }),
          );
          this.setStateMachine(
            recordStateStarted(
              recordAcceptedExecution(this.requireStateMachine(), receipt),
              selection.state,
              selection.input,
              receipt,
            ),
            true,
          );
        }
        let finish!: () => void;
        const finishedPromise = new Promise<void>((resolve) => {
          finish = resolve;
        });
        // 所有执行器的停止语义一致：进程组会立即通过 SIGKILL 终止
        // （与 pi-bash 一致），因此中断终止事件不必等待宽限期。
        // 如果将来需要优雅的 TERM 清理，应作为显式选择加入，而不是默认对所有任务启用。
        const unregisterReaper = this.taskManager.registerReaper(async (reason) => {
          shell.interrupt(reason);
          await finishedPromise;
        });
        const interrupt = () => shell.interrupt(String(signal.reason ?? "Interrupted"));
        signal.addEventListener("abort", interrupt, { once: true });
        try {
          const output = await shell.run();
          onOutput(output.stdout);
          return { type: "completed", output } satisfies ShellSettlement;
        } catch (error) {
          const reason = shell.interruptedReason();
          if (reason !== undefined)
            return { type: "interrupted", reason } satisfies ShellSettlement;
          return {
            type: "failed",
            error: error instanceof Error ? error.message : String(error),
          } satisfies ShellSettlement;
        } finally {
          signal.removeEventListener("abort", interrupt);
          finish();
          unregisterReaper();
        }
      },
    });
    taskId = handle.id;
    this.stateTasks.set(taskId, {
      kind: pollPolicy ? "poll" : "script",
      stateName,
      shell,
      ...(pollPolicy ? { pollPolicy } : {}),
    });
  }

  private async recordTaskSettlements(
    settlements: readonly TaskSettlement[],
  ): Promise<SettledDecision["outcome"] | undefined> {
    let latest: SettledDecision["outcome"] | undefined;
    for (const settlement of settlements) {
      if (this.ignoredTaskSettlements.delete(settlement.id)) {
        this.stateTasks.delete(settlement.id);
        continue;
      }
      const metadata = this.stateTasks.get(settlement.id);
      if (!metadata) continue;
      this.stateTasks.delete(settlement.id);
      const result = this.stateResultFromSettlement(settlement);
      const recorded = recordSettled(
        this.requireStateMachine(),
        metadata.stateName,
        metadata.kind,
        result,
        this.partialStateOutput(metadata),
        this.clock.now(),
      );
      this.setStateMachine(recorded.session);
      latest = recorded.outcome;
      if (latest.type === "sleep") {
        this.taskManager.start({
          kind: "scheduled",
          name: metadata.stateName,
          label: `Wait for ${metadata.stateName}`,
          ownerScopeId: this.requireRootScope(),
          wakeAt: latest.wakeAt,
        });
      }
    }
    return latest;
  }

  private async processTaskSettlements(
    settlements: readonly TaskSettlement[],
  ): Promise<SettledDecision["outcome"] | undefined> {
    const stateSettlements = settlements.filter(
      (settlement) =>
        this.stateTasks.has(settlement.id) || this.ignoredTaskSettlements.has(settlement.id),
    );
    const taskSettlements = settlements.filter(
      (settlement) => !stateSettlements.includes(settlement),
    );
    const stateOutcome = await this.recordTaskSettlements(stateSettlements);
    if (taskSettlements.length === 0) return stateOutcome;
    if (stateOutcome) {
      this.parentInputs.unshift({ type: "task_settlements", settlements: taskSettlements });
      return stateOutcome;
    }

    const snapshots = taskSettlements
      .map((settlement) => this.taskManager.output(settlement.id))
      .filter((snapshot) => snapshot !== undefined);
    if (snapshots.length === 0) return stateOutcome;
    const worker = await this.runParentPass({
      state: this.snapshotState({ ...this.requireRunnerState(), status: "running" }),
      prompt: settlementNotice(snapshots),
      continuation: true,
    });
    this.setState(worker.outcome.state);
    return this.settleContinuationPass(worker);
  }

  private stateResultFromSettlement(settlement: TaskSettlement): SubagentResult | ShellSettlement {
    if (settlement.status === "completed") {
      return settlement.result as SubagentResult | ShellSettlement;
    }
    if (settlement.status === "stopped") {
      return { type: "interrupted", reason: settlement.reason };
    }
    return {
      type: "failed",
      error:
        settlement.status === "failed"
          ? settlement.error instanceof Error
            ? settlement.error.message
            : String(settlement.error)
          : `Task ${settlement.id} was lost.`,
    };
  }

  private partialStateOutput(metadata: StateTaskMetadata) {
    if (metadata.kind === "agent") {
      const assistantText = metadata.run?.partialAssistantText();
      return assistantText ? { assistantText } : undefined;
    }
    return metadata.shell.partialOutput();
  }

  private async interruptTasks(reason: string): Promise<void> {
    const scheduledState = currentScheduledState(this.stateMachine);
    const scheduledTask = scheduledState
      ? this.taskManager
          .list()
          .find(
            (task) =>
              task.kind === "scheduled" &&
              task.status === "scheduled" &&
              task.name === scheduledState.name,
          )
      : undefined;
    if (scheduledState && scheduledTask) {
      const recorded = recordSettled(
        this.requireStateMachine(),
        scheduledState.name,
        scheduledState.kind,
        { type: "interrupted", reason },
        undefined,
        this.clock.now(),
      );
      this.setStateMachine(recorded.session);
      this.ignoredTaskSettlements.add(scheduledTask.id);
    }
    for (const [id, metadata] of this.stateTasks) {
      if (this.taskManager.output(id)?.descriptor.status !== "running") continue;
      const recorded = recordSettled(
        this.requireStateMachine(),
        metadata.stateName,
        metadata.kind,
        { type: "interrupted", reason },
        this.partialStateOutput(metadata),
        this.clock.now(),
      );
      this.setStateMachine(recorded.session);
      this.ignoredTaskSettlements.add(id);
    }
    await this.taskManager.interruptAll(reason);
  }

  private async cancelScheduledTasks(reason: string): Promise<void> {
    const scheduled = this.taskManager.list().filter((task) => task.status === "scheduled");
    for (const task of scheduled) this.ignoredTaskSettlements.add(task.id);
    await Promise.all(scheduled.map((task) => this.taskManager.stop(task.id, reason)));
  }

  /** 恢复 prompt 用于说明重复的有效工作，但不会禁止合理重试。 */
  private repeatedSelectionLoopWarning(stateName: string): string | undefined {
    const session = this.stateMachine;
    const count = session ? repeatedSelectionLoopCount(session, stateName) : undefined;
    if (count === undefined) return undefined;
    return systemReminder(dedent`
      UNCHANGED EXECUTION: the last ${count} retained settled attempts of state "${stateName}"
      ran identical effective instructions, input, cwd, and inherited context. Time elapsed and
      intervening states do not establish progress. Before selecting again, inspect the accepted
      execution receipt and prior output. Change the work to address the failure, identify the
      external condition that changed and justifies a retry, or report the blocker. An identical
      retry remains allowed when external conditions have changed. For waiting, use a park for
      user input, a poll for a checkable condition, or a timer for a future time.
    `);
  }

  private completedStateOutput(stateName: string): unknown {
    const history = this.stateMachine?.history ?? [];
    for (let index = history.length - 1; index >= 0; index--) {
      const event = history[index];
      if (event?.type === "state_completed" && event.state === stateName) return event.output;
    }
    return undefined;
  }

  private async selectNextStateAfterCompletion(
    stateName: string,
    output?: unknown,
  ): Promise<SettledDecision["outcome"] | undefined> {
    return this.enforceParentTransition(
      (retryInstruction) =>
        systemReminder(dedent`
        The state "${stateName}" finished.

        ${toXML({
          state_completed: {
            output: output ?? null,
          },
        })}

        <system-reminder>
        THIS PARENT PASS MUST END WITH ONE select_state_machine_state TOOL CALL. A parent pass accepts only one terminating control result. Do not combine this selection with ask_user_question or another selection in the same response. If user input is needed, select the park state alone now; after this completed-state transition to park, the runner automatically starts another parent pass, where you can call ask_user_question. Selecting park ends this pass, not that later opportunity to ask. Text or narration alone does not advance the state machine.

        ${retryInstruction ?? ""}

        If the state produced output the user would want to see — a written artifact (poem, summary, draft), a finding, a status the user is watching, or anything else the background work was meant to surface — post that content to the user in this turn before or alongside the tool call. The user does not see state output, transcripts, or tool results from background states; if you do not relay it here, they never see it. Skip the user-facing message only when the state output is purely internal plumbing (an ack, a control signal, a value that only matters to the next state).

        You are the orchestrator and are responsible for this sub-agent's output. Treat the state_completed block above as a claim, not as verified truth. The sub-agent may have hallucinated success, skipped steps, swallowed errors, or misreported what it did. Before transitioning, review the output against reality: read the files it claims to have changed, run the build/test/lint it claims to have passed, and confirm any IDs, paths, counts, or statuses it asserts. If the output is wrong, incomplete, or unverifiable, do not just blindly re-select the same state — the sub-agent will hallucinate the same result a second time. Re-select the state with a decision.override.state.prompt that addresses the specific failure (require a verification step, name the exact file path or tool to use, forbid the hallucinated phrasing), or select a different state. Tuning the sub-agent's prompt is the orchestrator's lever — use it. Do not silently take over the sub-agent's job by running its tools yourself; that hides the broken state from future runs. Do not propagate an unverified claim into the next state's prompt as fact, and do not relay it to the user as finished work. The orchestrator owns correctness; the sub-agent only owns effort.

        CARRY FORWARD BEFORE YOU SELECT. The next state runs in a fresh sub-agent that cannot see this state_completed output, your reasoning, or your reply text — the ONLY thing it receives is the \`decision.input\` and \`decision.override.state.prompt\` you pass in the select call. So if the next state's job depends on anything this state just produced (a root cause, file path, diagnosis, ID, count, decision), inline those exact facts into the select's \`decision.input\`/\`decision.override.state.prompt\` on the FIRST transition into it. Do not select it bare and let it come back confused, then add the context on a retry — a select that advances to a finding-dependent state carrying none of the finding is already wrong, even with the right state name. Summarizing the finding in your message to the user does not carry it forward.
        </system-reminder>
      `),
      "State completed, but the runner did not call select_state_machine_state.",
    );
  }

  /**
   * 供父级履行状态机转换义务时共用的有界重试循环。
   * 通过 `buildPrompt` 重新提示，最多重试 `PARENT_TRANSITION_RETRY_BUDGET` 次
   * （第二次及之后的尝试会附带重试提醒）；首次被接受的选择会结束强制流程，只有同步
   * 工作会立即产生结果。已完成工作重试耗尽时会请求明确继续，
   * 并保留决策和输出。若恢复时没有已完成结果，
   * 仍会记录带有 `failureReason` 的错误终止结果。
   */
  private async enforceParentTransition(
    buildPrompt: (retryInstruction: string | undefined) => string,
    failureReason: string,
  ): Promise<SettledDecision["outcome"] | undefined> {
    for (let attempt = 1; attempt <= PARENT_TRANSITION_RETRY_BUDGET; attempt++) {
      const retryInstruction =
        attempt === 1
          ? undefined
          : `This is retry ${attempt} of ${PARENT_TRANSITION_RETRY_BUDGET}. You did not call select_state_machine_state last time. You must call select_state_machine_state now.`;
      const turnState = this.snapshotState({ ...this.requireRunnerState(), status: "running" });
      const workerResult = await this.runParentPass({
        state: turnState,
        prompt: buildPrompt(retryInstruction),
        continuation: true,
      });
      this.setState(workerResult.outcome.state);
      const result = await this.stateMachineResultFromWorker(
        workerResult,
        workerResult.outcome.state,
      );
      if (result) return result;
      // 启动异步状态不会立即产生结果。select
      // 控制操作本身就证明转换义务已经履行。
      if (workerResult.control.type === "select_state_machine_state") return undefined;
    }

    if (this.requireRunnerState().pendingStateTransition) {
      return {
        type: "ask",
        questions: [
          {
            header: "Relay paused",
            question:
              "The last relay step finished, but the agent could not choose the next step. Continue to retry that decision using the saved result?",
            options: [
              {
                label: "Continue",
                description: "Retry choosing the next step without restarting the completed work.",
              },
            ],
          },
        ],
      };
    }

    const failed = failActiveSession(
      this.requireStateMachine(),
      this.stateMachine?.currentState ?? "",
      failureReason,
    );
    this.setStateMachine(failed.session);
    return failed.outcome;
  }

  protected createStateSubagentRun(input: {
    state: StateMachineAgentState;
    prompt: string;
    origin: TurnEventOrigin;
  }): SubagentRun {
    const spec: SubagentSpec = {
      prompt: input.prompt,
      ...(input.state.systemPrompt ? { systemPrompt: input.state.systemPrompt } : {}),
      ...(input.state.allowedSkills ? { allowedSkills: input.state.allowedSkills } : {}),
      ...(input.state.cwd ? { cwd: input.state.cwd } : {}),
      ...(input.state.model ? { model: input.state.model } : {}),
      ...(input.state.thinkingLevel ? { thinkingLevel: input.state.thinkingLevel } : {}),
      ...(input.state.forkContext ? { forkContext: true } : {}),
    };
    const session = this.stateMachine;
    const machineContext = session
      ? { definition: session.definition, currentState: input.state.name }
      : undefined;
    return this.subagentExecutor(spec, {
      origin: input.origin,
      ...(machineContext ? { machineContext } : {}),
    });
  }

  /** 只有在 TaskManager 分配身份和子作用域后，才创建公开的 spawn。 */
  protected async createSpawnedSubagentRun(
    publicSpec: SubagentSpec,
    taskId: TaskId,
    ownerScopeId: ScopeId,
    childScopeId: `task:${TaskId}`,
    forkSource?: NonNullable<SubagentExecutionContext["forkSource"]>,
    callerModelSetting?: string,
  ): Promise<SubagentRun> {
    const parentSetting =
      callerModelSetting ??
      this.requireRunnerState().options?.model ??
      this.config.model ??
      DEFAULT_CLI_MODEL;
    const selection = await this.selectSpawnModel(publicSpec.prompt, parentSetting);
    const memorySessionId = this.config.sessionId
      ? `${this.config.sessionId}:sub:${taskId}`
      : undefined;
    return this.subagentExecutor(
      {
        ...publicSpec,
        model: selection.modelName,
        ...(selection.thinkingLevel ? { thinkingLevel: selection.thinkingLevel } : {}),
      },
      {
        origin: { taskId },
        childScopeId,
        ownerScopeId,
        memoryContext: {
          ...(memorySessionId ? { sessionId: memorySessionId } : {}),
          horizon: createInitialHorizon(),
        },
        ...(forkSource ? { forkSource } : {}),
      },
    );
  }

  /** 无状态的 spawn 分类器接缝；特意不查询 Session 的 ModelRouter。 */
  protected async selectSpawnModel(prompt: string, parentSetting: string) {
    const table = this.routingTable ?? BUILT_IN_ROUTING_TABLE;
    return classifySpawnModel(prompt, parentSetting, {
      table,
      resolveCatalog: routingCatalogAdapter,
      classifierOptions: this.classifierOptions(table),
    });
  }

  protected async dropSubagentScratch(taskId: TaskId): Promise<void> {
    const session = this.memoryPersistence?.session;
    if (!session || !this.config.sessionId) return;
    await replaceSessionObservations(session, `${this.config.sessionId}:sub:${taskId}`, []);
  }

  private requireRunnerState(): TurnState {
    if (!this.state) {
      throw new Error("Turn runner has not been started.");
    }
    return this.state;
  }

  private requireStateMachine(): StateMachineSession {
    if (!this.stateMachine) throw new Error("No state machine is active.");
    return this.stateMachine;
  }

  /** 设为 `protected`，以便测试探针在 turn 之外驱动工具时提供作用域。 */
  protected requireRootScope(): ScopeId {
    if (!this.activeRootScopeId) throw new Error("No turn root scope is active.");
    return this.activeRootScopeId;
  }

  private setStateMachine(session: StateMachineSession, notify = false): void {
    this.stateMachine = session;
    if (notify) this.emit({ type: "state_machine", stateMachine: session });
  }

  private getActiveStateOutput() {
    for (const [id, metadata] of this.stateTasks) {
      if (this.taskManager.output(id)?.descriptor.status !== "running") continue;
      if (metadata.kind === "agent") {
        const assistantText = metadata.run?.partialAssistantText();
        return assistantText
          ? { state: metadata.stateName, kind: "agent" as const, output: { assistantText } }
          : { state: metadata.stateName, kind: "agent" as const };
      }
      const output = metadata.shell.partialOutput();
      return output
        ? { state: metadata.stateName, kind: metadata.kind, output }
        : { state: metadata.stateName, kind: metadata.kind };
    }
    return undefined;
  }

  private captureParentControlResult(result: TurnRunnerControlResult): void {
    if (result.type === "none") return;
    if (this.parentControlResults.length > 0) {
      throw new Error("A parent pass produced more than one control result.");
    }
    this.parentControlResults.push(result);
  }

  private consumeParentControlResult(): TurnRunnerControlResult {
    const result = this.parentControlResults.shift() ?? { type: "none" as const };
    if (this.parentControlResults.length > 0) {
      throw new Error("A parent pass produced more than one control result.");
    }
    return result;
  }

  private attachTurnUsage(terminal: TurnTerminalEvent): TurnTerminalEvent {
    if (!this.turnUsage) return terminal;
    return {
      ...terminal,
      turnUsage: this.turnUsage,
      usageByModel: this.turnUsageByModel ?? [],
      ...(this.lastParentUsageSnapshot
        ? {
            effectiveContextWindow: this.lastParentUsageSnapshot.effectiveContextWindow,
            contextWindowUsage: this.lastParentUsageSnapshot.contextWindowUsage,
            lastMessageUsage: this.lastParentUsageSnapshot.lastMessageUsage,
          }
        : {}),
    };
  }

  private emitTerminalOnce(terminal: TurnTerminalEvent): void {
    if (this.terminalEmitted) return;
    this.terminalEmitted = true;
    this.emit(terminal);
  }

  getState(): TurnState | undefined {
    if (!this.state) return undefined;
    return this.snapshotState(this.state);
  }

  private snapshotState(state: TurnState): TurnState {
    const parentAgent = this.parentAgent
      ? {
          ...state.agent,
          status: state.agent.status,
          messages: this.parentAgent.state.messages,
        }
      : state.agent;
    const snapshot: TurnState = {
      ...state,
      agent: parentAgent,
      stateMachine: this.stateMachine,
      todos: copyOptionalArray(state.todos ?? this.state?.todos),
      followUpQueue: copyOptionalArray(state.followUpQueue ?? this.state?.followUpQueue),
      queuedCommands:
        this.activeRootScopeId !== undefined
          ? this.parentInputs
              .filter(
                (input): input is Extract<ParentLoopInput, { type: "user_command" }> =>
                  input.type === "user_command",
              )
              .map((input) => input.command)
          : (this.hydratedQueuedCommands ??
            copyOptionalArray(state.queuedCommands ?? this.state?.queuedCommands)),
      tasks: [...this.taskManager.list()],
      taskOutputTails: this.snapshotTaskOutputTails(),
      nextTaskId: this.taskManager.nextTaskId(),
      // 在每个快照中传递 wire-shaping state，使持久化
      // 层（`state.json`、终止 payload、`getState` 调用方）都能看到
      // 当前值。通过展开复制，避免调用方修改
      // 运行器的实时对象。如果值仍等于新运行器默认值，则省略它，让未变更的 Session 保持 schema 简洁；
      // 目前只有 `evictionHorizon` 一个字段，因此它也充当
      // 变更标记——新增 wire-shaping 字段时需重新评估。
      ...(this.wireGuardHorizon.evictionHorizon > 0
        ? { wireGuardHorizon: { ...this.wireGuardHorizon } }
        : {}),
    };
    return this.applyAutoStateCompaction(snapshot);
  }

  private snapshotTaskOutputTails(): TurnState["taskOutputTails"] {
    const tails: NonNullable<TurnState["taskOutputTails"]> = {};
    for (const descriptor of this.taskManager.list()) {
      const output = this.taskManager.output(descriptor.id)?.output;
      if (output && output.length > 0) {
        tails[descriptor.id] = output.slice(-3).map((chunk) => chunk.slice(-1_500));
      }
    }
    return Object.keys(tails).length > 0 ? tails : undefined;
  }

  /**
   * 限制通过 emit/return/
   * `getState` 离开运行器的每个 state 大小。仅在启用
   * `TurnRunnerConfig.autoStateCompaction` 时运行——这个唯一的收口点确保持久化层、终止
   * payload 和外部观察者看到的都是同一份裁剪后 state。
   */
  private applyAutoStateCompaction(state: TurnState): TurnState {
    const options = this.resolveCompactionOptions();
    if (!options) return state;
    const { state: capped, evicted, bytes } = compactTurnState(state, options);
    if (evicted > 0) {
      console.warn(
        `[relay-pi] turn state exceeded auto-compaction ceiling; evicted ${evicted} oldest message(s) (now ${bytes} bytes) for session ${this.config.sessionId ?? "<unknown>"}`,
      );
    }
    return capped;
  }

  private resolveCompactionOptions(): AutoStateCompactionOptions | undefined {
    // 默认开启：`undefined` 和 `true` 都会启用 100 MB 上限，防止
    // `state.json` 无限制增长导致持久化卡死。只有显式设为
    // `false` 才会关闭压缩。
    const setting = this.config.autoStateCompaction;
    if (setting === false) return undefined;
    if (setting === undefined || setting === true) return {};
    return setting;
  }

  private setState(state: TurnState): void {
    this.state = this.snapshotState(state);
  }

  private snapshotActiveAgentState(): void {
    if (!this.state) return;
    this.state = this.snapshotState(this.state);
  }

  private getFollowUpQueue(): TurnFollowUpQueueEntry[] {
    return [...(this.state?.followUpQueue ?? [])];
  }

  private setFollowUpQueue(entries: TurnFollowUpQueueEntry[]): void {
    if (!this.state) return;
    this.setState({ ...this.state, followUpQueue: [...entries] });
  }

  private getTodos(): TurnTodo[] {
    return [...(this.state?.todos ?? [])];
  }

  private setTodos(todos: TurnTodo[]): void {
    if (!this.state) return;
    this.setState({ ...this.state, todos: [...todos] });
  }

  // 新 turn 开始时，如果 todo 列表中的项目都处于终止
  // 状态（completed 或 failed），列表便不再代表进行中的工作。
  // 清空列表以重置用户可见的 todos 面板，并避免下一 turn
  // 继续携带过时提醒。
  private clearFinishedTodosAtTurnStart(state: TurnState): TurnState {
    const todos = state.todos;
    if (!todos || todos.length === 0) return state;
    const hasOpen = todos.some(
      (todo) => todo.status === "pending" || todo.status === "in_progress",
    );
    if (hasOpen) return state;
    const cleared: TurnState = { ...state, todos: [] };
    this.setState(cleared);
    this.emit({ type: "todos", todos: [] });
    return cleared;
  }

  private requireStarted(): void {
    if (!this.started) {
      throw new Error("Turn runner has not been started.");
    }
  }

  protected requireParentAgent(): Agent {
    if (!this.parentAgent) {
      throw new Error("Turn runner parent agent has not been initialized.");
    }
    return this.parentAgent;
  }

  private initializeParentAgent(): void {
    const state = this.requireRunnerState();
    // 路由指导层与其描述的工具一同传递。
    // 每个工具的描述保持精简（说明如何调用、参数
    // 含义是什么）；“何时使用该工具”的指导放在这里，使
    // Agent 学会识别用户实际输入的触发模式。
    //   - 状态机层：在公开状态机工具的非 `agent` 模式中附加；
    //     最重要的是 `auto` 模式，因为 Agent 必须在 todo_write
    //     与 create_state_machine_definition 之间作出选择。
    //   - 回忆记忆层：只要已接入持久化记忆就附加，使 Agent 在跨 Session 问题
    //     （“你昨天做了什么”“我们不是已经发布 X 了吗？”）中使用 `recall_memory`，
    //     而不是含糊作答。
    const layers = [
      state.mode === "agent"
        ? undefined
        : createStateMachineSystemPromptLayer({ mode: state.mode, session: state }),
      this.config.memoryDbPath !== undefined ? createRecallMemorySystemPromptLayer() : undefined,
      // 顾问的时机指导随工具一同提供：仅靠工具描述进行
      // 引导，会明显减少困难任务中的顾问调用。
      this.advisorPolicy?.enabled ? ADVISOR_EXECUTOR_GUIDANCE_LAYER : undefined,
      // 事实来源优先的指导始终适用：即使未配置
      // 记忆，Agent 也应优先使用 cwd 中的实时工具、
      // 技能和文件，而不是猜测回答。
      createSourceOfTruthSystemPromptLayer(),
    ].filter((layer): layer is string => Boolean(layer));
    const appendSystemPrompt = layers.length > 0 ? layers.join("\n\n") : undefined;
    this.parentControlResults.length = 0;
    this.parentAgent = this.createAgent(
      {
        state,
        appendSystemPrompt,
        parentModelRouting: true,
        ...(this.modelRouter ? { router: this.modelRouter } : {}),
        ...this.createTools(state.mode),
      },
      (result) => {
        this.captureParentControlResult(result);
      },
    );
    this.snapshotActiveAgentState();
  }

  private async stateMachineResultFromWorker(
    workerResult: AgentWorkerResult,
    state: TurnState,
  ): Promise<SettledDecision["outcome"] | undefined> {
    const control = workerResult.control;
    if (control.type === "none") return undefined;
    if (control.type === "ask_user_question") {
      return { type: "ask", questions: control.questions };
    }
    if (control.type === "create_state_machine_definition") {
      // 执行到这里的 create 已由工具授权：只有没有活动状态机，
      // 或 Agent 主动选择 `replaceActive` 时，工具才会发出
      // 此控制结果。因此此处若仍有活动的非终止 Session，就表示
      // Agent 有意替换它；先 supersede 旧状态机（记录
      // `cancelled` 终止结果），再安装新状态机。
      const active = this.stateMachine;
      if (active && !active.terminal) {
        await this.replaceActiveStateTasks("Replaced by a new state machine.");
        this.setStateMachine(
          supersede(active, `Superseded by a new state machine ("${control.definition.name}").`),
          true,
        );
      }

      const firstState = control.firstState;
      this.setStateMachine(
        startStateMachineSession({
          prompt:
            workerResult.outcome.type === "complete" ? (workerResult.outcome.result ?? "") : "",
          definition: control.definition,
          currentState: firstState,
        }),
      );
      return this.runStateMachineDecision({ state: firstState });
    }

    if (!this.stateMachine && typeof state.mode === "object") {
      this.setStateMachine(
        startStateMachineSession({
          prompt:
            workerResult.outcome.type === "complete" ? (workerResult.outcome.result ?? "") : "",
          definition: state.mode as Exclude<TurnMode, "agent" | "auto">,
          currentState: control.decision.state,
        }),
      );
    }
    return this.runStateMachineDecision(control.decision);
  }

  private async runStateMachineDecision(decision: StateMachineRunnerDecision) {
    await this.replaceActiveStateTasks("Replaced by a newly selected state.");
    await this.cancelScheduledTasks("Replaced by a newly selected state.");
    const planned = planDecision(this.requireStateMachine(), decision, this.clock.now());
    // 清理或用户 steer pass 可能会在排队提醒运行前完成转换。
    // 旧状态的转换义务不应因此触发第二次选择。
    for (let index = this.parentInputs.length - 1; index >= 0; index--) {
      if (this.parentInputs[index]?.type === "transition_enforcement") {
        this.parentInputs.splice(index, 1);
      }
    }
    this.setState({ ...this.requireRunnerState(), pendingStateTransition: undefined });
    this.setStateMachine(planned.session, true);
    return this.executePlannedWork(planned.work, planned.selection);
  }

  private async replaceActiveStateTasks(reason: string): Promise<void> {
    const pending = [...this.stateTasks.entries()];
    // 父级 pass 期间停止的 worker，其结算结果仍可能已在队列中。
    // 选择替代工作前，先作废所有旧状态的结果。
    for (const [id] of pending) this.ignoredTaskSettlements.add(id);
    const active = pending.filter(
      ([id]) => this.taskManager.output(id)?.descriptor.status === "running",
    );
    for (const [, metadata] of active) {
      const recorded = recordSettled(
        this.requireStateMachine(),
        metadata.stateName,
        metadata.kind,
        { type: "interrupted", reason },
        this.partialStateOutput(metadata),
        this.clock.now(),
      );
      this.setStateMachine(recorded.session);
    }
    await Promise.all(active.map(([id]) => this.taskManager.stop(id, reason)));
  }

  protected createTools(
    mode: TurnMode,
    cwdOverride?: string,
    includeParentTools = true,
    childContext?: ChildToolContext,
  ): {
    tools: AgentTool[];
  } {
    const cwd = resolveStateCwd(cwdOverride, this.config.cwd ?? process.cwd());
    const todoStorage = {
      getTodos: () => this.getTodos(),
      setTodos: (todos: TurnTodo[]) => {
        this.setTodos(todos);
        this.emit({ type: "todos", todos });
      },
    };
    const skills = this.skillContext.getSkills();
    const mcpTools = this.mcpRuntime?.tools ?? [];
    const recallStorage: RecallMemoryToolStorage = {
      getSession: () => this.memoryPersistence?.session,
      embed: this.memoryPersistence?.embed,
      sessionId: childContext?.memorySessionId ?? this.config.sessionId,
      // 复用已解析的 memory model，使 `recall_memory` 可选的
      // expand 标志使用与观察器相同的低成本 model。
      expansionModel: this.resolveMemoryActorModel(undefined),
    };
    const router = this.modelRouter;
    const advisorStorage =
      includeParentTools && router && this.advisorPolicy?.enabled
        ? this.createAskAdvisorStorage(router, this.advisorPolicy)
        : undefined;
    const baseTools =
      mode === "agent"
        ? createDefaultTurnRunnerTools(cwd, todoStorage, recallStorage, advisorStorage)
        : createTurnRunnerTools({
            cwd,
            mode,
            getDefinition: () => this.stateMachine?.definition,
            getStateMachine: () => this.stateMachine,
            updateStateDefinition: (updatedState) => {
              const liveWorker = [...this.stateTasks].some(
                ([id, metadata]) =>
                  metadata.stateName === updatedState.name &&
                  this.taskManager.output(id)?.descriptor.status === "running",
              );
              const liveWake = this.taskManager
                .list()
                .some((task) => task.status === "scheduled" && task.name === updatedState.name);
              if (liveWorker || liveWake) {
                throw new Error(
                  `State "${updatedState.name}" is running or scheduled. Use select_state_machine_state with an override to restart or reschedule it.`,
                );
              }
              this.setStateMachine(
                persistStateDefinition(this.requireStateMachine(), updatedState),
                true,
              );
            },
            getActiveStateOutput: () => this.getActiveStateOutput(),
            todoStorage,
            skills,
            recallStorage,
            advisorStorage,
            clock: this.clock,
            minimumScheduledDelayMs: this.minimumScheduledDelayMs,
          });
    const childSafeTools = includeParentTools
      ? baseTools
      : baseTools.filter((tool) => tool.name !== "ask_user_question");
    const taskAwareTools = childSafeTools.map((tool) =>
      tool.name === "bash"
        ? wrapBackgroundable(tool, {
            taskManager: this.taskManager,
            defaultWaitBudgetMs: this.taskWaitBudgetMs,
            clock: this.clock,
            ownerScopeId: () => childContext?.ownerScopeId ?? this.requireRootScope(),
            label: (params) => String(params.command ?? "bash command"),
            onTaskStarted: (id, foregroundPending) => {
              this.taskSettlementDelivery.set(
                id,
                foregroundPending ? "foreground_pending" : "deliver",
              );
            },
            onForegroundResult: (id, converted) => {
              this.taskSettlementDelivery.set(id, converted ? "deliver" : "suppress");
              this.scheduleSettlementDelivery();
            },
          })
        : tool,
    );
    return {
      tools: [
        ...taskAwareTools,
        ...(includeParentTools || childContext
          ? [
              this.createSpawnTool(childContext),
              ...createTaskAdminTools({ taskManager: this.taskManager, clock: this.clock }),
            ]
          : []),
        ...mcpTools,
      ],
    };
  }

  private createSpawnTool(childContext?: ChildToolContext): AgentTool {
    const ownerScopeId = () => childContext?.ownerScopeId ?? this.requireRootScope();
    return createSpawnAgentTool({
      taskManager: this.taskManager,
      defaultWaitBudgetMs: this.taskWaitBudgetMs,
      clock: this.clock,
      ownerScopeId,
      createRun: async ({ spec, taskId, ownerScopeId: callerScopeId, childScopeId }) =>
        this.createSpawnedSubagentRun(
          spec,
          taskId,
          callerScopeId,
          childScopeId,
          childContext?.forkSource,
          childContext?.modelSetting(),
        ),
      dropScratch: async (taskId) => this.dropSubagentScratch(taskId),
      onTaskStarted: (id, foregroundPending) => {
        this.taskSettlementDelivery.set(id, foregroundPending ? "foreground_pending" : "deliver");
      },
      onForegroundResult: (id, converted) => {
        this.taskSettlementDelivery.set(id, converted ? "deliver" : "suppress");
        this.scheduleSettlementDelivery();
      },
    });
  }

  protected createAskAdvisorStorage(
    router: ModelRouter,
    policy: AdvisorPolicy,
  ): AskAdvisorToolStorage {
    const resolveAdvisorModel = () => resolveMeteredModelName(policy.target.modelName);
    return {
      getContext: async (contextWindowTokens) =>
        await this.captureContextForAdvisor(contextWindowTokens),
      resolveModel: () => {
        const model = resolveAdvisorModel();
        return {
          modelName: model.id,
          contextWindowTokens: model.contextWindow,
          acceptsImages: model.input.includes("image"),
        };
      },
      thinkingLevel: policy.target.thinkingLevel,
      advisorGate: () => router.beginAdvisorConsult(),
      noteAdvisorConsult: (success = true) => {
        router.endAdvisorConsult(success);
        if (success && this.advisorTurnLifecycle) {
          this.advisorTurnLifecycle.noteSuccessfulConsult(router.status().assistantSteps);
        }
      },
      recordUsage: (usage) => {
        const model = resolveAdvisorModel();
        this.recordAndEmitUsage(usage, model.id, model.provider as TransportName);
      },
      onUsageError: (error) => {
        const reason = error instanceof Error ? error.message : String(error);
        this.emit({
          type: "system",
          level: "warn",
          message: `Advisor usage accounting failed; advice was retained: ${reason}`,
        });
      },
      onAdvisorError: (error) => {
        const reason = error instanceof Error ? error.message : String(error);
        this.emit({
          type: "system",
          level: "warn",
          message: `Advisor consultation failed; executor continued: ${reason}`,
        });
      },
    };
  }

  /**
   * 普通顾问调用在上下文仍高效时保持原样。超过软
   * 目标后，通过常规记忆观察器排空较早的工作，并用顾问专属 horizon 投影，
   * 从而不改变执行器的下一次请求。
   */
  protected async captureContextForAdvisor(
    contextWindowTokens: number,
    options: { drainObservations?: boolean } = {},
  ): Promise<AdvisorExecutorContext> {
    const agent = this.requireParentAgent();
    const rawContext = await captureAdvisorExecutorContext(agent);
    const rawRequest = buildAdvisorContext({
      context: rawContext,
      contextWindowTokens,
      reservedOutputTokens: ADVISOR_MAX_OUTPUT_TOKENS,
    });
    const inputTargetTokens = rawRequest.metadata.inputTargetTokens;
    if (
      !rawRequest.metadata.truncated &&
      rawRequest.metadata.estimatedInputTokens <= inputTargetTokens
    ) {
      return rawContext;
    }
    if (!this.memoryPersistence?.session) return rawContext;

    let recentMessageTarget = Math.min(
      ADVISOR_RECENT_MESSAGE_TARGET_TOKENS,
      Math.floor(inputTargetTokens / 2),
    );
    let projectedContext = rawContext;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      projectedContext = await captureAdvisorExecutorContext(agent, {
        transformMessages: async (messages) =>
          await compactObservationalContext({
            messages,
            memory: this.memory,
            horizon: this.advisorWireGuardHorizon,
            targetMessageTokens: recentMessageTarget,
            protectRecentToolInteraction: true,
            ...(options.drainObservations === false
              ? {}
              : {
                  onCompaction: async (observable: AgentMessage[]) =>
                    await this.ensureMemoryCoverageForCompaction(observable),
                }),
          }),
      });
      const projectedRequest = buildAdvisorContext({
        context: projectedContext,
        contextWindowTokens,
        reservedOutputTokens: ADVISOR_MAX_OUTPUT_TOKENS,
      });
      const excess = projectedRequest.metadata.estimatedInputTokens - inputTargetTokens;
      if (excess <= 0) return projectedContext;
      recentMessageTarget = Math.max(1, recentMessageTarget - excess);
    }
    return projectedContext;
  }

  /**
   * 应用于每个父级 pass 的预处理，包括 harness 对
   * `runAgentWorker` 的覆盖（覆盖实现必须首先调用此方法）。需要送达“接下来运行的任意父级 pass”的一次性提醒
   * 都在这里处理。
   */
  protected prepareParentPassInput(input: AgentWorkerInput): AgentWorkerInput {
    const withheldAsk = this.withheldAskQuestions;
    this.withheldAskQuestions = undefined;
    if (!withheldAsk) return input;
    return { ...input, prompt: `${withheldAskReminder(withheldAsk)}\n\n${input.prompt}` };
  }

  protected async runAgentWorker(rawInput: AgentWorkerInput): Promise<AgentWorkerResult> {
    const input = this.prepareParentPassInput(rawInput);
    if (this.parentAgentRunning) {
      throw new Error("Cannot start a parent agent while another parent agent is active.");
    }

    const agent = this.requireParentAgent();
    this.applyPendingModelSelection(agent);
    agent.state.tools = (this.turnTools ?? this.createTools(input.state.mode).tools).map(
      admitToolArguments,
    );
    this.parentControlResults.length = 0;
    this.setParentAgentRunning(true);

    let visibleOutput = false;
    const unsubscribe = agent.subscribe((event) => {
      if (isExternallyVisibleAgentEvent(event)) visibleOutput = true;
      this.emitParentAgentEvent(event);
    });
    this.parentAgentInterrupted = false;
    try {
      if (!input.continuation) {
        this.modelRouter?.noteTurnStart({ promptHasImages: (input.images?.length ?? 0) > 0 });
      }
      await this.rerouteIfDue(agent, { prevTurnHint: input.prompt, signal: agent.signal });
      await agent.prompt(input.prompt, input.images);
      await this.retryConnectedTransportFallback(agent, () => visibleOutput);
      // 单次恢复：如果 provider 因上下文溢出错误拒绝首次请求，
      // 推进固定的 wire-shaping
      // horizon，使下一次发送大致只携带较新的半段
      // 历史，然后通过 `agent.continue()` 恢复同一个 turn。
      // 继续而不是重新提示，可将现有用户
      // 消息留在尾部，避免重复追加。若第二次尝试仍超出限制，则作为 `failed` 继续处理——不再
      // 重试。恢复会设置压缩分类标记；循环的 prepareNextTurn 只会在已完成 turn 之后运行，
      // 因此重试会在此处消费该标记，避免泄漏到
      // 下一次用户 turn。
      if (await this.tryRecoverFromContextOverflow(agent)) {
        await this.rerouteIfDue(agent, { signal: agent.signal });
        await agent.continue();
      }
      if (
        !isPostOutputConnectedFailure(
          agent.state.model.provider,
          agent.state.messages.at(-1),
          visibleOutput,
        )
      ) {
        await this.retryTransientServerErrors(agent);
      }
    } catch (error) {
      if (!this.parentAgentInterrupted) {
        throw error;
      }
    } finally {
      unsubscribe();
      // 控制操作会在 pi 排空队列之前结束当前父级 pass。
      // 未消费的命令会留在 parentInputs，供外层下一次 pass 处理。
      agent.clearAllQueues();
      this.piQueuedInputs.clear();
      this.setParentAgentRunning(false);
    }

    if (this.parentAgentInterrupted) {
      return {
        control: this.consumeParentControlResult(),
        outcome: { type: "interrupted", state: this.requireRunnerState() },
      };
    }

    const messages = agent.state.messages;
    const status = agent.state.errorMessage ? "failed" : "completed";
    const live = this.state;
    const state = {
      ...input.state,
      status,
      agent: {
        ...input.state.agent,
        status,
        messages,
      },
      todos: live?.todos ?? input.state.todos,
      followUpQueue: live?.followUpQueue ?? input.state.followUpQueue,
      tasks: live?.tasks ?? input.state.tasks,
      nextTaskId: live?.nextTaskId ?? input.state.nextTaskId,
    } satisfies TurnState;
    return {
      control: this.consumeParentControlResult(),
      outcome: {
        type: "complete",
        status,
        state,
        result: assistantText(messages),
        error: agent.state.errorMessage,
      },
    };
  }

  private setParentAgentRunning(running: boolean): void {
    this.parentAgentRunning = running;
    this.snapshotActiveAgentState();
  }

  /**
   * 检查父级 prompt 后最新的 assistant 消息；如果消息携带 provider 的上下文溢出错误，
   * 则修改 Agent
   * state 和固定的 `wireGuardHorizon`，使下一次重试
   * 发送大约较新的半段可观察历史。
   *
   * 只有实际完成恢复时才返回 `true`——也就是
   * horizon 至少前进并淘汰了一条可观察消息。调用方将返回值用作一次性门控：首次
   * `agent.prompt(...)` 后调用一次；若结果为 `true`，就通过
   * `agent.continue()` 恰好恢复 turn 一次。此 helper 不会再次检查
   * 失败消息，因此重试再次溢出时会自然按 `failed` turn
   * 处理。
   *
   * 成功时的修改：
   * - 弹出 pi-agent 为溢出错误追加的失败 assistant 消息
   *   （空文本标记，带有 `stopReason: "error"` 和
   *   `errorMessage`），避免重试的对话记录包含该消息。
   *   `agent.continue()` 自己的运行生命周期会在重试
   *   前重置 `errorMessage`，因此这里无需清除它；
   * - 将 `this.wireGuardHorizon.evictionHorizon` 推进到最小值，使
   *   `findEvictionHorizon` 报告派发列表缩小至最多 `floor(n / 2)` 条
   *   可观察消息；其中 `n`
   *   不包括失败消息本身。
   *
   * 发出一条说明压缩情况的 `system` 信息事件，
   * 供各界面显示通知。消息会报告淘汰后
   * *实际*删除的数量（经过 `MIN_HISTORY_TAIL` 限制和
   * 孤立头部跳过处理后），而不是 n 的一半这一目标值。
   *
   * 以下情况返回 `false`：
   * - 父级 Agent 未失败（未设置 `errorMessage`）；
   * - 失败并非上下文溢出（例如速率限制、传输
   *   错误等——留给调用方呈现）；
   * - 无法推进 horizon（例如现有 horizon 已涵盖
   *   所有可淘汰消息，或历史过短，无法满足
   *   `MIN_HISTORY_TAIL`）。此时使用相同上下文重试仍会溢出，因此接受失败，
   *   不再为第二次无用请求付费。
   */
  protected async tryRecoverFromContextOverflow(agent: Agent): Promise<boolean> {
    if (!agent.state.errorMessage) return false;
    const messages = agent.state.messages;
    const lastMessage = messages[messages.length - 1];
    if (!lastMessage || lastMessage.role !== "assistant") return false;
    if (!isContextOverflow(lastMessage, agent.state.model.contextWindow)) return false;

    // 计算一半历史时，排除失败的 assistant 消息；
    // 只有之前的“真实”回合才应计入
    // 本次裁剪针对的可观察消息总数。
    const observable = stripObservationalContextMessages(messages.slice(0, -1));
    const target = Math.floor(observable.length / 2);
    const previousHorizon = this.wireGuardHorizon.evictionHorizon;
    await this.ensureMemoryCoverageForCompaction(observable);
    const newHorizon = findEvictionHorizon(
      observable,
      previousHorizon,
      (candidate) => candidate.length <= target,
    );
    if (newHorizon === previousHorizon) return false;

    messages.pop();
    this.wireGuardHorizon.evictionHorizon = newHorizon;
    this.modelRouter?.noteCompaction();

    const remaining = applyEvictionHorizon(observable, newHorizon).length;
    const dropped = observable.length - remaining;
    this.emit({
      type: "system",
      level: "info",
      message: `Context overflow: dropped ${dropped} older message${dropped === 1 ? "" : "s"} and retrying.`,
    });
    return true;
  }

  /**
   * 弹出失败的 assistant 消息并继续同一 turn，以重试上游的瞬时故障。
   *
   * 仅当最新 assistant 消息的 `stopReason: "error"`，且错误文本符合已知 gateway 5xx 或传输故障
   * 模式（见 `transient-error.ts`）时触发。上下文溢出恢复已在上游处理，此处会跳过；4xx 错误和速率限制
   * 不会重试，因为相同 payload 仍会失败。
   *
   * 每次 `agent.continue()` 重试都会采用指数退避和随机抖动。
   * 每次重试都会发出一条 `system` 信息事件，供调用方在 UI 中显示“上游错误后正在重试”。重试计数器会在
   * Agent 于两次失败之间取得进展时重置——如果
   * `agent.continue()` 在下一条失败消息之前追加了成功的中间消息，
   * 下一次失败就作为新序列处理，并获得完整的重试预算。重试后只要 assistant
   * 消息不再是瞬时故障（成功或
   * 其他不可重试的错误），helper 就会返回，让调用方呈现
   * 结果。
   *
   * 循环没有显式迭代上限，因为每次迭代要么在没有进展时达到
   * `maxAttempts`（并终止），要么在真实 Agent 工作后重置（工具调用、token 数，由
   * pi-agent 自身每 turn 的限制约束）。若 provider 能持续产生无限次“进展 + 失败”，
   * 调用方也会为每一轮真实工作付费——这里不存在免费的无限循环。
   */
  protected async retryTransientServerErrors(
    agent: Agent,
    policy: TransientRetryPolicy = DEFAULT_TRANSIENT_RETRY_POLICY,
  ): Promise<void> {
    let attempt = 1;
    while (attempt < policy.maxAttempts) {
      if (!agent.state.errorMessage) return;
      if (!lastMessageIsTransientFailure(agent.state.messages)) return;
      const failingMessage = agent.state.messages.at(-1);
      const reason =
        failingMessage?.role === "assistant" && failingMessage.errorMessage
          ? failingMessage.errorMessage
          : "Upstream error";
      const delayMs = transientRetryDelayMs(attempt, policy);
      this.emit({
        type: "system",
        level: "info",
        message: `Upstream error (${truncateForSystemMessage(reason)}); retrying in ${Math.round(delayMs / 100) / 10}s (attempt ${attempt + 1}/${policy.maxAttempts}).`,
      });
      // pi-agent 会把失败留作尾部 assistant 消息，并
      // 保留 `errorMessage`；弹出该消息后，`agent.continue()`
      // 便可从之前的用户/工具结果尾部继续，而不会把
      // 失败标记发送回 provider。
      agent.state.messages.pop();
      const lengthBeforeContinue = agent.state.messages.length;
      await sleep(delayMs);
      await agent.continue();
      // 如果 `continue()` 追加的不只是新的失败尾部
      // （也就是说，在 Agent 再次失败前至少追加了一条中间 assistant 或工具消息），
      // Agent 就在两次失败之间取得了真实进展。重置计数，使下一次失败获得
      // 新的重试预算，而非继承当前计数。
      const messagesAppended = agent.state.messages.length - lengthBeforeContinue;
      attempt = messagesAppended > 1 ? 1 : attempt + 1;
    }
  }

  /** 在产生任何可见效果前，遇到已连接 provider 拒绝请求时，尝试切换到下一个传输方式重试。 */
  protected async retryConnectedTransportFallback(
    agent: Agent,
    visibleOutput: () => boolean,
  ): Promise<void> {
    while (agent.state.errorMessage) {
      const provider = agent.state.model.provider;
      if (!isConnectedProviderId(provider)) return;
      const cause = connectedFallbackCause(agent.state.messages.at(-1));
      if (!cause || visibleOutput()) return;
      const fallback = nextTransportAfterConnectedFailure(
        provider,
        agent.state.model.id,
        connectedTransportSnapshot(),
      );
      if (!fallback || fallback.transport === provider) return;

      const failedModelName = agent.state.model.id;
      demoteConnectedTransport(provider);
      if (cause === "auth_failed") await markConnectedProviderReconnectNeeded(provider);
      agent.state.messages.pop();
      agent.state.model = resolveModelName(`${fallback.transport}:${fallback.modelId}`);
      this.emit({
        type: "system",
        level: "info",
        message: transportFallbackNotice({
          provider,
          modelName: failedModelName,
          fallbackTransport: fallback.transport,
          cause,
        }),
      });
      await agent.continue();
    }
  }

  protected async updateMemoryAfterAgentRun(
    messages: AgentMessage[],
    options: TurnOptions | undefined,
    sessionId = this.config.sessionId,
    refreshReflections = true,
  ): Promise<void> {
    if (this.config.memoryDbPath === undefined) {
      return;
    }
    const session = this.memoryPersistence?.session;
    if (!session) return;
    // 观察器接收 model 名称并在内部解析，但用量按解析后的 ID
    // 归属，使记忆部分与父级及状态 Agent 在 `usageByModel` 中的记录一致（例如 `openai/gpt-5.4-mini`），
    // 而不是在解析后的 ID 之间混入简写名称。
    const memoryModel = this.resolveMemoryActorModel(options);
    const resolvedMemoryModel = resolveMeteredModelName(memoryModel);
    const memoryModelId = resolvedMemoryModel.id;
    const result = await updateObservationalMemory({
      session,
      memory: this.memory,
      sessionId,
      effectiveContext: this.resolveEffectiveContext(this.parentAgent?.state.model.contextWindow),
      actorModel: `${resolvedMemoryModel.provider}:${resolvedMemoryModel.id}`,
      settings: this.config.memory,
      messages,
      cwd: this.config.cwd ?? process.cwd(),
      // 观察/反思工作属于 turn 成本。将其计入
      // 总用量，并发出 `usage` 事件，使记忆开销像
      // 每次完成一样实时显示；这样即使记忆工作在父级最后一个
      // `message_end` 之后运行，最后一条流式事件仍会与
      // 终止时的汇总用量相等。
      onUsage: (usage) => {
        this.recordUsage(usage, memoryModelId, resolvedMemoryModel.provider as TransportName);
        this.emitTurnUsage();
      },
      onActivity: (event) => this.emit({ type: "memory", ...event }),
    });

    // 压缩触发：反思刚刚替换了持久化
    // 观察记录集合，因此重建冻结的上下文包以载入
    // 新的精简视图。只有观察、不含反思的更新不会
    // 刷新上下文包——这样可保持渲染前缀稳定，使
    // provider 的 prompt 缓存继续有效。
    if (refreshReflections && result.reflections.length > 0) {
      await this.refreshMemoryContextPack();
    }
  }

  /**
   * 将尚未观察的消息尾部排入持久化记忆，并刷新
   * 冻结的上下文包，使淘汰后的渲染包含即将
   * 被丢弃消息所对应的 `<observation-group range=“…”>`。每个 `findEvictionHorizon` 调用点都会执行此操作——包括
   * wire-shaping 转换器的 `onCompaction`、`/compact` 和
   * 上下文溢出恢复路径——以确保它们通过同一个观察器写入，并采用相同的尽力而为失败策略：排空失败时
   * 会记录 `system` 警告，但仍继续淘汰。
   *
   * actor model 始终使用 Session 配置默认值
   * （`config.memoryModel → DEFAULT_CLI_MEMORY_MODEL`）解析，确保每条
   * 压缩路径都通过相同的观察器写入，与触发入口无关。`/compact` 不会在此处采用
   * 每 turn 的 `--memory-model` 覆盖值——该覆盖只影响 Agent 回复，不影响排空。
   */
  private async ensureMemoryCoverageForCompaction(messages: AgentMessage[]): Promise<void> {
    try {
      await this.updateMemoryAfterAgentRun(messages, undefined);
    } catch (error) {
      this.emit({
        type: "system",
        level: "warn",
        message: `compact: observation drain failed (${truncateForSystemMessage(
          error instanceof Error ? error.message : String(error),
        )}); evicting anyway.`,
      });
    }
    await this.refreshMemoryContextPack();
  }

  private async refreshMemoryContextPack(): Promise<void> {
    const session = this.memoryPersistence?.session;
    if (!session) return;
    try {
      await rebuildMemoryContextPack({
        session,
        cache: this.memory,
        settings: resolveObservationalMemorySettings(
          this.resolveEffectiveContext(this.parentAgent?.state.model.contextWindow),
          this.config.memory,
        ),
        ...(this.config.sessionId !== undefined ? { sessionId: this.config.sessionId } : {}),
      });
    } catch {
      // 重建记忆包采用尽力而为策略；若失败，现有记忆包会
      // 继续保留。turn 流程不会等待记忆工作。
    }
  }

  /**
   * 记忆 model 的优先顺序：每 turn 覆盖值 → 运行器配置 → 默认值。
   * 此方法对外开放，供测试验证记忆观察器实际使用的
   * 精确回退顺序。
   */
  resolveMemoryActorModel(options: TurnOptions | undefined): string {
    return options?.memoryModel ?? this.config.memoryModel ?? DEFAULT_CLI_MEMORY_MODEL;
  }

  protected createAgent(
    input: AgentConfigInput,
    onControlResult?: (result: TurnRunnerControlResult) => void,
  ): Agent {
    const options = this.resolveTurnOptions(undefined, input.state.options);
    const initialRoute = input.router?.initialTarget({ hasImages: false });
    const model = resolveModelName(initialRoute?.modelName ?? options.model ?? DEFAULT_CLI_MODEL);
    // 父级 Agent 配置取自 start/Session 选项，而非
    // 每条 prompt 命令的选项。若选择具体 model，为保护 prompt 缓存，该 model 会在整个 Session 中
    // 保持稳定；路由 Session 则会在 ModelRouter 更换
    // model 时（每 turn 或通过 prepareNextTurn）有意放弃缓存前缀，并由分类器指令
    // 携带“任务中途不要切换 model”的缓存偏好。
    let agent!: Agent;
    agent = new Agent({
      // 派发由 model 注册表负责；循环本身不解析任何传输方式。
      streamFn: relayPiStreamFn,
      initialState: {
        model,
        thinkingLevel: initialRoute?.thinkingLevel ?? options.thinkingLevel ?? "medium",
        systemPrompt:
          input.systemPrompt ??
          this.createBaseSystemPromptWithAppendedLayers({
            prepend: [input.prependSystemPrompt],
            append: [input.appendSystemPrompt],
            skills: input.skills,
          }),
        messages: input.state.agent.messages,
        tools: input.tools.map(admitToolArguments),
      },
      transformContext: this.createMemoryTransform(input.memoryContext),
      ...(input.parentModelRouting
        ? {
            prepareNextTurn: (signal?: AbortSignal) => this.rerouteIfDue(agent, { signal }),
          }
        : {}),
      ...(onControlResult
        ? {
            shouldStopAfterTurn: () =>
              agent === this.parentAgent && this.parentControlResults.length > 0,
          }
        : {}),
      steeringMode: "all",
      toolExecution: "parallel",
      afterToolCall: async (context) => {
        const details = context.result.details;
        if (isTurnRunnerControlResult(details)) {
          onControlResult?.(details);
        }
        return undefined;
      },
      getApiKey: resolveProviderApiKey,
    });
    return agent;
  }

  protected createMemoryTransform(memoryContext?: SubagentAgentConfigInput["memoryContext"]) {
    // 记忆转换器负责保留历史，同时受 token
    // 预算（小型 model 的上下文窗口成本）和 wire 字节
    // 预算（gateway 请求体上限）约束。它会先应用固定 horizon，
    // 使后续 turn 复用相同的淘汰决策，并让 provider prompt 缓存在淘汰事件之间保持有效。
    return createObservationalContextTransform({
      memory: this.memory,
      effectiveContext: () =>
        this.resolveEffectiveContext(this.parentAgent?.state.model.contextWindow),
      settings: this.config.memory,
      horizon: memoryContext?.horizon ?? this.wireGuardHorizon,
      onCompaction: async (messages) => {
        if (memoryContext) {
          try {
            await this.updateMemoryAfterAgentRun(
              messages,
              undefined,
              memoryContext.sessionId,
              false,
            );
          } catch (error) {
            this.emit({
              type: "system",
              level: "warn",
              message: `compact: child observation drain failed (${truncateForSystemMessage(
                error instanceof Error ? error.message : String(error),
              )}); evicting anyway.`,
            });
          }
          return;
        }
        await this.ensureMemoryCoverageForCompaction(messages);
        this.modelRouter?.noteCompaction();
      },
    });
  }

  // 在此运行器实例的所有 turn 中保持固定。恢复 Session 时（创建新运行器）会重置。记忆转换器
  // 在 token 或字节预算触发淘汰时原地修改此值；provider 上下文溢出错误也会由
  // `runAgentWorker` 修改它，使重试
  // 发送较新的半段历史。
  protected readonly wireGuardHorizon: WireGuardHorizon = createInitialHorizon();

  /** 仅在重复的顾问投影间保持固定；不会持久化到执行器 state 中。 */
  protected readonly advisorWireGuardHorizon: WireGuardHorizon = createInitialHorizon();

  async getSkills(): Promise<readonly Skill[]> {
    await this.ensureSkillsLoaded();
    return this.skillContext.getSkills();
  }

  /**
   * 从磁盘重新发现已安装技能和精选记忆存储。无需重启运行器即可呈现
   * 新添加的技能或已编辑的记忆文件。调用方通常会将此方法与 `getSkills()` 配合，刷新
   * 自动补全目录。
   */
  async reloadSkills(): Promise<readonly Skill[]> {
    await this.skillContext.reload();
    await this.refreshPinnedStoreContextPack();
    return this.skillContext.getSkills();
  }

  /** 本 Session 在磁盘上解析到的 system prompt 文件（默认是 AGENTS.md）。 */
  async getResolvedAgentFiles(): Promise<readonly TurnAgentFile[]> {
    await this.ensureSkillsLoaded();
    return this.skillContext.getResolvedAgentFiles();
  }

  /** 技能发现过程中，一个定义覆盖另一个定义时出现的技能名称冲突。 */
  async getSkillCollisions(): Promise<readonly SkillCollision[]> {
    await this.ensureSkillsLoaded();
    return this.skillContext.getSkillCollisions();
  }

  getSkillInstructions(skillId: string): string {
    return this.skillContext.getSkillInstructions(skillId);
  }

  private async ensureSkillsLoaded(): Promise<void> {
    await this.skillContext.ensureLoaded();
  }

  /**
   * 每个 Session 只连接远程 MCP 服务器一次。后续启动
   * （例如恢复的 Session）会复用现有运行时，确保工具标识
   * 稳定。运行时会在 `dispose()` 中释放。
   */
  private async ensureMcpServersConnected(servers: TurnStartCommand["mcpServers"]): Promise<void> {
    if (this.mcpRuntime || !servers || Object.keys(servers).length === 0) return;
    this.mcpRuntime = await connectMcpServers(servers);
  }

  private async ensureMemoryLoaded(): Promise<void> {
    if (this.memoryLoaded) return;
    this.memoryLoaded = true;

    // 每个运行器只构建一次 embedding 客户端，以便连接复用
    // 能够分摊回填 worker 和
    // `recall_memory` 工具的 TLS 初始化开销。客户端会在每次
    // 调用时惰性解析 `OPENROUTER_API_KEY`，因此 Session 中途添加凭据后即可启用检索，无需重启运行器。
    //
    // 基于文件的记忆包会与基于数据库的记忆包并行加载，确保
    // 首次派发的 turn 同时看到两种冻结层。之后数据库压缩
    // 只会触发观察记录层刷新；显式重新加载技能时才刷新
    // 基于文件的层。
    const pinnedStoreLoad = this.refreshPinnedStoreContextPack();
    this.memoryPersistence = await loadStoredMemory(
      this.config.memoryDbPath,
      this.config.cwd ?? process.cwd(),
      {
        embed: createEmbeddingClient(),
        contextPack: {
          cache: this.memory,
          settings: resolveObservationalMemorySettings(
            this.resolveEffectiveContext(this.parentAgent?.state.model.contextWindow),
            this.config.memory,
          ),
          ...(this.config.sessionId !== undefined ? { sessionId: this.config.sessionId } : {}),
        },
        // 向 UI 报告隔离恢复。原目录会在用户磁盘上移至
        // 一旁，并在原位置创建新的数据库，因此在用户手动检查备份之前，
        // 本 Session 的回忆功能无法访问之前的记忆；如果没有 system
        // 事件提示，这种数据损失会悄无声息地发生。
        onWarn: (message) => {
          // 跨进程锁竞争：另一个并发运行的 relay-pi CLI 持有
          // memory db 打开锁的时间超过了等待预算，因此本次操作
          // 被跳过。每次发生时都显示一次提示，让用户了解本 turn 的 recall
          // 和观察器写入能力已降级。
          this.emit({ type: "system", level: "warn", message });
        },
        onRecover: ({ backupPath, cause }) => {
          const reason = cause instanceof Error ? cause.message || cause.name : String(cause);
          this.emit({
            type: "system",
            level: "warn",
            message: `memory.db could not be opened (${reason}); quarantined to ${backupPath} and starting fresh.`,
          });
        },
      },
    );
    await pinnedStoreLoad;
  }

  /** 重新加载冻结的文件记忆层，不触及数据库记忆。 */
  private async refreshPinnedStoreContextPack(): Promise<void> {
    if (this.config.memoryStores === false) {
      this.memory.setStoredContextPack([]);
      return;
    }
    try {
      const base = this.config.cwd ?? process.cwd();
      // 显式条目可能是相对路径；应相对于已配置的
      // cwd 解析，与相对数据库路径和 system prompt 路径一致，而不是相对于进程 cwd。
      const stores = this.config.memoryStores
        ? this.config.memoryStores.map((store) => resolve(base, store))
        : await discoverMemoryStores(base);
      await rebuildPinnedStoreContextPack({ stores, cache: this.memory });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.warn(`[relay-pi] failed to load pinned memory stores: ${reason}`);
    }
  }

  protected createBaseSystemPromptWithAppendedLayers(input?: {
    prepend?: Array<string | undefined>;
    append?: Array<string | undefined>;
    skills?: readonly Skill[];
  }): string {
    return this.skillContext.createSystemPromptWithAppendedLayers(input);
  }

  /**
   * 每 turn 选项优先顺序的唯一事实来源：
   * 显式 turn 选项 → 从 state 继承的基础选项 → 运行器配置 → 默认值。
   */
  resolveTurnOptions(options?: TurnOptions, base?: TurnOptions): TurnOptions {
    return {
      model: options?.model ?? base?.model ?? this.config.model ?? DEFAULT_CLI_MODEL,
      memoryModel:
        options?.memoryModel ??
        base?.memoryModel ??
        this.config.memoryModel ??
        DEFAULT_CLI_MEMORY_MODEL,
      thinkingLevel: options?.thinkingLevel ?? base?.thinkingLevel ?? this.config.thinkingLevel,
    };
  }

  protected recordUsage(
    usage?: TurnTokenUsage | Usage,
    modelId?: string,
    provider?: TransportName,
  ): void {
    const transport =
      provider ?? (this.parentAgent?.state.model.provider as TransportName | undefined);
    if (usage && (!modelId || !transport)) {
      throw new Error("Usage accounting requires both model id and transport provider.");
    }
    const accounted = usage && transport ? usageForTransport(usage, transport) : usage;
    this.turnUsage = addUsage(this.turnUsage, accounted);
    if (accounted && modelId && transport) {
      this.turnUsageByModel = addUsageByModel(this.turnUsageByModel, modelId, transport, accounted);
      this.turnUsage!.cost.total = this.turnUsageByModel.reduce(
        (total, entry) => total + entry.usage.cost.total,
        0,
      );
    }
  }

  /** 归属非父级 model 调用的用量；存在完整上下文快照后再发布。 */
  private recordAndEmitUsage(
    usage: TurnTokenUsage | Usage,
    modelId: string,
    provider: TransportName,
  ): void {
    this.recordUsage(usage, modelId, provider);
    this.emitTurnUsage();
  }

  protected emitAgentEvent(event: AgentEvent, origin?: TurnEventOrigin): void {
    if (event.type === "message_start" && event.message.role === "user") {
      this.removeFollowUpPrompt(agentMessageText(event.message));
    }
    for (const turnEvent of this.agentEventToTurnEvents(event)) {
      this.emit(origin ? { ...turnEvent, origin } : turnEvent);
    }
  }

  protected emitParentAgentEvent(event: AgentEvent): void {
    if (event.type === "message_start" && event.message.role === "user") {
      const input = this.piQueuedInputs.get(event.message);
      if (input) {
        const index = this.parentInputs.indexOf(input);
        if (index !== -1) this.parentInputs.splice(index, 1);
        this.piQueuedInputs.delete(event.message);
      }
    }
    this.emitAgentEvent(event);
    if (event.type === "turn_end" && event.message.role === "assistant") {
      this.modelRouter?.noteAssistantStep(routerStepObservation(event.message, event.toolResults));
      this.advisorTurnLifecycle?.noteExecutedTools(
        event.toolResults.map((result) => result.toolName),
      );
      this.steerAdvisorOrientationIfDue();
    }
    if (event.type !== "message_end" || event.message.role !== "assistant") return;

    // 缓存父级最新的进度条/明细，使后续状态 Agent 和
    // 终止事件能够复用，避免基于过时数据重新缩放。
    this.lastParentUsageSnapshot = {
      effectiveContextWindow: this.effectiveContextWindow(),
      contextWindowUsage: scaleContextWindowUsageToTotalTokens(
        this.estimateContextWindowUsage(),
        event.message.usage.totalTokens,
      ),
      lastMessageUsage: event.message.usage,
    };

    // 一个 turn 是一系列完成调用组成的循环；将本次完成的用量并入
    // 持续汇总，并立即发出 `usage` 事件，使工具密集型 turn
    // 能在每次完成时更新成本。这是唯一由真实父级运行记录用量的位置——只有完成实际
    // 消耗了 token 才会发出 `usage` 事件，因此被拒绝的请求（例如 provider 上下文溢出
    // 错误，随后由 turn 恢复）不会产生用量，否则将
    // 显示一个全零进度条。
    this.recordUsage(
      event.message.usage,
      event.message.model,
      event.message.provider as TransportName,
    );
    if (event.message.usage.totalTokens > 0) this.emitTurnUsage();
  }

  /** 在对话记录中投递一次方向检查点，不改变公开协议。 */
  private steerAdvisorOrientationIfDue(): void {
    const lifecycle = this.advisorTurnLifecycle;
    const routeStatus = this.modelRouter?.status();
    if (
      !lifecycle ||
      !routeStatus ||
      !lifecycle.takeOrientationCheckpoint(routeStatus.assistantSteps)
    ) {
      return;
    }
    this.requireParentAgent().steer(
      buildUserAgentMessage(systemReminder(ADVISOR_ORIENTATION_REMINDER), undefined),
    );
  }

  /**
   * 推进 `compact()` 的淘汰 horizon 后，重新发出上下文窗口明细。进度条的分子是最近一次父级
   * `lastMessageUsage.totalTokens`，它仍反映压缩前的
   * wire 消息尾部；我们会针对新 horizon 重新估算各分段占用，
   * 求和得到合成总量，并按比例缩放
   * 快照中的 `lastMessageUsage`，让进度条立即更新。
   * 在下一次父级 message_end 之前，状态 Agent 发出的事件也会读取
   * 更新后的快照，避免显示形状跳回过时值。
   */
  private emitPostCompactUsage(): void {
    if (!this.lastParentUsageSnapshot) return;
    const rawBreakdown = this.estimateContextWindowUsage();
    const newTotal =
      rawBreakdown.systemPrompt +
      rawBreakdown.messages +
      rawBreakdown.localMemory +
      rawBreakdown.globalMemory;
    const prior = this.lastParentUsageSnapshot.lastMessageUsage;
    const priorTotal = Math.max(1, prior.totalTokens);
    const ratio = newTotal / priorTotal;
    const scale = (value: number) => Math.max(0, Math.round(value * ratio));
    const refreshedMessageUsage: TurnTokenUsage = {
      input: scale(prior.input),
      output: scale(prior.output),
      cacheRead: scale(prior.cacheRead),
      cacheWrite: scale(prior.cacheWrite),
      totalTokens: newTotal,
      // 成本是历史值：provider 已经按
      // 压缩前的调用计费，因此保留原值，而不是伪造一个
      // 用户实际上并未支付的较低成本。
      cost: prior.cost,
    };
    const refreshedContextWindowUsage = scaleContextWindowUsageToTotalTokens(
      rawBreakdown,
      newTotal,
    );
    this.lastParentUsageSnapshot = {
      effectiveContextWindow: this.lastParentUsageSnapshot.effectiveContextWindow,
      contextWindowUsage: refreshedContextWindowUsage,
      lastMessageUsage: refreshedMessageUsage,
    };
    // `compact()` 只在 turn 之间运行，因此此处的 `this.turnUsage`
    // 未定义；发出零汇总，仍可让 `Session.applyUsageEvent`
    // 刷新 `lastUsage`。Session 成本已在上一次终止事件中入账，
    // 因此 `turnUsage.cost.total` 为零不会
    // 造成任何已产生费用丢失。
    const turnUsage = this.turnUsage ?? emptyTokenUsage();
    this.emit({
      type: "usage",
      turnUsage,
      usageByModel: this.turnUsageByModel ?? [],
      lastMessageUsage: refreshedMessageUsage,
      effectiveContextWindow: this.lastParentUsageSnapshot.effectiveContextWindow,
      contextWindowUsage: refreshedContextWindowUsage,
    });
  }

  /**
   * 发出反映最新 `this.turnUsage` 的 `usage` 事件。复用
   * 最近的父级上下文窗口快照作为进度条/明细数据，使
   * turn 中途的更新（父级 worker 完成、状态 Agent 完成）能够呈现成本，
   * 而不改变父级上下文字段。在首次父级完成之前，用量会被记录并计入终止结果及之后的第一条用量
   * 事件，但不会发出不完整的 wire 事件。
   */
  protected emitTurnUsage(origin?: TurnEventOrigin): void {
    if (!this.turnUsage || !this.lastParentUsageSnapshot) return;
    this.emit({
      type: "usage",
      turnUsage: this.turnUsage,
      usageByModel: this.turnUsageByModel ?? [],
      lastMessageUsage: this.lastParentUsageSnapshot.lastMessageUsage,
      effectiveContextWindow: this.lastParentUsageSnapshot.effectiveContextWindow,
      contextWindowUsage: this.lastParentUsageSnapshot.contextWindowUsage,
      ...(origin ? { origin } : {}),
    });
  }

  /**
   * 估算父级 Agent 输入中各分段的占用，之后还会与 provider 的 `totalTokens`
   * 对齐。system prompt 和记忆
   * 包使用与记忆流水线相同的 `ceil(chars / CHARS_PER_TOKEN)` 估算方法，确保
   * 压缩触发条件与 `MEMORY_BUDGET_RATIOS` 处于相同尺度。
   *
   * 消息尾部使用 {@link calculateWireTokens} 计算淘汰后的切片——这与 provider 实际分词的切片相同——因此
   * wire-shaping 已删除的消息不会继续计入 `messages` 分段，也不会因为运行器保留的完整
   * 对话记录而虚增。文本和结构化内容块（`toolCall`、thinking
   * 等）按 `ceil(chars / CHARS_PER_TOKEN)` 估算；图像块按每张图像的固定估算值计入，
   * 而不是按其 base64 字节长度计算。
   *
   * `emitParentAgentEvent` 会使用
   * {@link scaleContextWindowUsageToTotalTokens} 重新缩放全部四个分段，确保发出的明细
   * 总和恰好等于 API 报告的 `usage.totalTokens`。
   */
  protected estimateContextWindowUsage() {
    const agent = this.requireParentAgent();
    const pack = this.memory.getContextPack();
    const dispatched = applyEvictionHorizon(
      agent.state.messages,
      this.wireGuardHorizon.evictionHorizon,
    );
    const messageWireTokens = calculateWireTokens(dispatched);
    return {
      systemPrompt: estimateTokens(agent.state.systemPrompt),
      messages: messageWireTokens,
      localMemory: pack.local.reduce((total, row) => total + estimateTokens(row.content), 0),
      globalMemory: [...pack.stored, ...pack.global].reduce(
        (total, row) => total + estimateTokens(row.content),
        0,
      ),
    };
  }

  /**
   * 上下文用量进度条的有效上限。用户设置的
   * `config.effectiveContext`（默认值 `DEFAULT_EFFECTIVE_CONTEXT`）会限制在父级 model 的硬性上下文窗口内；
   * 用户设置超过 model 容量时，会静默限制为 model 上限。所有记忆预算都
   * 由同一个数值推导，因此该进度条也代表实际的
   * 压缩上限。
   */
  protected effectiveContextWindow(): number {
    const modelWindow = this.requireParentAgent().state.model.contextWindow;
    return this.resolveEffectiveContext(modelWindow);
  }

  /**
   * 根据可选的 model 窗口解析用户设置的 `effectiveContext`。
   * 在父级 Agent 存在之前运行的记忆流水线调用方（初始
   * 记忆包加载、转换器构建）会传入 `undefined`，并使用
   * 未受限的用户值；面向 Agent 的 `effectiveContextWindow()` 则始终
   * 传入实时 model 窗口。
   */
  protected resolveEffectiveContext(modelWindow?: number): number {
    const userValue = this.config.effectiveContext ?? DEFAULT_EFFECTIVE_CONTEXT;
    return modelWindow !== undefined ? Math.min(userValue, modelWindow) : userValue;
  }

  /** 根据已加载的路由表和恢复的选择构建父级路由器。 */
  private initializeModelRouter(modelName: string | undefined, table: RoutingTable): void {
    this.modelRouter = undefined;
    this.routingTable = table;
    this.advisorPolicy = undefined;
    if (!modelName || !isVirtualModel(modelName, table)) return;
    this.advisorPolicy = table.tiers[modelName]!.advisor;
    this.modelRouter = this.createBoundModelRouter(modelName, table, routingCatalogAdapter);
  }

  private createBoundModelRouter(
    tier: string,
    table: RoutingTable,
    resolveCatalog: RouteResolutionCatalog,
  ): ModelRouter {
    return this.createModelRouter({
      table,
      tier,
      classify: async (input, signal) => {
        return classifyRoute(input, { ...this.classifierOptions(table), signal });
      },
      resolveCatalog,
    });
  }

  /**
   * 父级路由和已启动子项共用一份分类器契约。
   * 分类器会报告实际使用的 model ID 和传输方式，因此
   * 两条分类器路径会以相同方式归属其费用。
   */
  protected classifierOptions(table: RoutingTable): ClassifyRouteOptions {
    return {
      target: table.classifier.target,
      onUsage: (report) => this.recordAndEmitUsage(report.usage, report.modelId, report.transport),
    };
  }

  /** 当 model 名称由经过校验的项目表管理时返回 true。 */
  isVirtualModelSelection(modelName: string): boolean {
    return isVirtualModel(modelName, this.routingTable ?? BUILT_IN_ROUTING_TABLE);
  }

  /** 供 Session 自有 UI 使用的只读路由快照。 */
  routeStatus(): RouterStatus | undefined {
    return this.modelRouter?.status();
  }

  /**
   * 重新指定后续父级 turn 的目标，同时保留当前正在执行的 turn。
   * 具体选择会固定路由；虚拟选择会重建路由，使下一次
   * turn 从该层级最新的基线重新分类。
   */
  setModel(modelName: string): { routed: boolean } {
    const routed = this.isVirtualModelSelection(modelName);
    if (!routed) resolveModelName(modelName);
    const state = this.requireRunnerState();
    state.options = { ...state.options, model: modelName };
    this.pendingModelSelection = modelName;
    if (!this.parentAgentRunning) this.applyPendingModelSelection(this.requireParentAgent());
    return { routed };
  }

  private applyPendingModelSelection(agent: Agent): void {
    const selection = this.pendingModelSelection;
    if (!selection) return;
    this.pendingModelSelection = undefined;
    if (!this.isVirtualModelSelection(selection)) {
      this.modelRouter?.pin();
      this.advisorPolicy = undefined;
      agent.state.model = resolveModelName(selection);
      return;
    }

    const table = this.routingTable ?? BUILT_IN_ROUTING_TABLE;
    this.modelRouter?.unpin();
    this.advisorPolicy = table.tiers[selection]!.advisor;
    this.modelRouter = this.createBoundModelRouter(selection, table, routingCatalogAdapter);
    const initial = this.modelRouter.initialTarget({ hasImages: false });
    agent.state.model = resolveModelName(initial.modelName);
    agent.state.thinkingLevel = initial.thinkingLevel;
  }

  /** 显式指定的虚拟状态 model 会直接使用其层级的默认路由，不产生分类器延迟。 */
  private resolveStateModel(modelName: string | undefined) {
    if (!modelName || !this.isVirtualModelSelection(modelName)) return undefined;
    const table = this.routingTable ?? BUILT_IN_ROUTING_TABLE;
    return resolveTierDefault(table, modelName, { hasImages: false }, routingCatalogAdapter);
  }

  /** 省略的子项 model 会继承父级当前的具体目标，而不是父级的虚拟设置。 */
  private resolveSubagentInheritedOptions(): TurnOptions {
    const options = { ...this.requireRunnerState().options };
    if (!options.model || !this.isVirtualModelSelection(options.model)) return options;
    const parent = this.requireParentAgent().state;
    return {
      ...options,
      model: `${parent.model.provider}:${parent.model.id}`,
      ...(parent.thinkingLevel === "off" ? {} : { thinkingLevel: parent.thinkingLevel }),
    };
  }

  /** 供生产绑定和确定性运行器测试使用的组合接缝。 */
  protected createModelRouter(options: ModelRouterOptions): ModelRouter {
    return new ModelRouter(options);
  }

  /** 在里程碑或定期检查到期时进行分类，并应用分类结果中的切换。 */
  private async rerouteIfDue(agent: Agent, input: RouterPrepareInput) {
    const switched = await this.modelRouter?.prepareTurn(input);
    return switched ? await this.applyRouterSwitch(agent, switched) : undefined;
  }

  /** 解析并原子地应用一次由路由器管理的 model/推理强度变更。 */
  private async applyRouterSwitch(agent: Agent, switched: RouterSwitch) {
    const model = resolveModelName(switched.toModel);
    agent.state.model = model;
    agent.state.thinkingLevel = switched.thinkingLevel;
    if (this.lastParentUsageSnapshot) {
      this.lastParentUsageSnapshot = {
        ...this.lastParentUsageSnapshot,
        effectiveContextWindow: this.resolveEffectiveContext(model.contextWindow),
      };
    }
    this.emit({ type: "router_switch", ...switched });
    return { model, thinkingLevel: switched.thinkingLevel };
  }
}

const ROUTER_STEP_TEXT_LIMIT = 2_000;

function warnSlowStartup(timings: Partial<Record<StartupPhase, number>>, totalMs: number): void {
  if (totalMs < SLOW_STARTUP_WARNING_MS) return;
  const phases = STARTUP_PHASES.map(
    (phase) => `${phase}=${(timings[phase] ?? 0).toFixed(1)}ms`,
  ).join(" ");
  console.warn(`[relay-pi] slow startup: ${phases} total=${totalMs.toFixed(1)}ms`);
}

function routerStepObservation(
  message: Extract<AgentMessage, { role: "assistant" }>,
  toolResults: Extract<AgentEvent, { type: "turn_end" }>["toolResults"],
): StepObservation {
  const content = [...message.content, ...toolResults.flatMap((result) => result.content)];
  const text = content
    .filter(
      (block): block is Extract<(typeof content)[number], { type: "text" }> =>
        block.type === "text",
    )
    .map((block) => stripSystemReminders(block.text))
    .filter(Boolean)
    .join("\n")
    .trim();
  return {
    blockTypes: content.map((block) => block.type),
    text: text.slice(-ROUTER_STEP_TEXT_LIMIT),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 截取上游错误的摘要，使其简短且仅占一行，再作为
 * `system` 信息消息发出。Provider 错误 payload 可能包含数
 * 千字节的 JSON；截断可确保重试通知易于阅读。
 */
function truncateForSystemMessage(message: string, limit = 160): string {
  const flattened = message.replace(/\s+/g, " ").trim();
  if (flattened.length <= limit) return flattened;
  return `${flattened.slice(0, limit - 1)}…`;
}

/** 将协议层的 prompt 图像转换为 pi-ai `ImageContent` 内容块。 */
function promptImagesToContent(images: TurnPromptImage[] | undefined): ImageContent[] {
  if (!images) return [];
  return images.map((image) => ({
    type: "image" as const,
    data: image.data,
    mimeType: image.mimeType,
  }));
}

/**
 * 根据 prompt 的文本和可选图像构造 pi-agent 用户消息。
 * 纯文本 prompt 使用简单的字符串内容格式；多模态 prompt
 * 则转换为内容数组，先放文本部分，再放图像块。
 */
function buildUserAgentMessage(
  message: string,
  images: TurnPromptImage[] | undefined,
): {
  role: "user";
  content: string | ({ type: "text"; text: string } | ImageContent)[];
  timestamp: number;
} {
  const imageContent = promptImagesToContent(images);
  const content =
    imageContent.length > 0 ? [{ type: "text" as const, text: message }, ...imageContent] : message;
  return { role: "user", content, timestamp: Date.now() };
}
