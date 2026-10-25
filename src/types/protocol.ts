import type { ImageContent, TextContent, ThinkingLevel, Usage } from "@earendil-works/pi-ai";
import type { RouterSwitch } from "../model-routing/router.js";
import type { TransportName } from "../model-resolution/catalog.js";
import type { TaskDescriptor, TaskId, TaskSettlement } from "../tasks/types.js";

export type { TaskDescriptor, TaskId, TaskSettlement, TaskSnapshot } from "../tasks/types.js";

import type { AgentSession } from "./agent.js";
import type { ObservationalMemoryActivityEvent } from "./memory.js";
import type { StateMachineDefinition, StateMachineSession } from "./state-machine.js";

/**
 * TurnRunner 协议。
 *
 * 用于操作 Relay Pi turn runner 的 JSON 友好 command/event 协议。
 * 传输方式有意不作规定：只要能够发送 command 并消费流式 event，CLI、daemon、HTTP server
 * 或父进程都可以使用此协议。
 *
 * 协议不是通信层，而是 runner 自身的控制面：
 *
 * - command 告诉 runner 要做什么；
 * - turn event 报告 turn 期间的工作，并结束每个 turn。
 *
 * ## Turn 模型
 *
 * runner 是有状态的 turn executor：`start` 引导当前 `TurnState`，每个终态 event 返回下一
 * 个 snapshot。Session 是持久化所有者：分配 session id，在 start 前 hydrate 已保存的 snapshot，
 * 持久化终态 snapshot，安排 wakeup，并可为同一个用户 Session 运行无界数量的 turn。
 *
 * 调用方通过发送 `start` 初始化 Session。这是 setup command，不是 turn：runner 加载 memory
 * 和 skills，发送包含初始空 `TurnState` 的 `turn_started` 后返回。调用方可以通过
 * `getSkills()`、`getResolvedAgentFiles()` 和 `getSkillCollisions()` 取得 skills、Agent 文件及
 * skill 冲突，并渲染 setup 摘要；在调用方发送后续 command 前，不会执行 Agent 工作。
 *
 * Session 建立后，调用方可以发送以下 command 运行 turn：
 *
 * - `prompt`：针对当前状态发送用户 prompt；
 * - `answer`：回答上一次终态 `ask` event 提出的问题；
 * - `wake`：为一次计划中的状态机步骤恢复睡眠 Session。
 *
 * 每个 turn 可以发送任意数量的进行中 event，包括 task 生命周期、Agent 步骤、状态 snapshot
 * 和诊断信息。每个 turn 恰好以一个终态 event 结束：`complete`、`ask`、`interrupted` 或
 * `sleep`。终态 event 携带 turn runner 拥有的、继续后续 turn 所需的状态。
 * `complete` 表示本次 turn runner turn 结束，不表示整个 Session 结束。用户可以继续为同一
 * Session 发送 prompt；runner 会从内部持有的 `TurnState` 继续。Agent Session 始终存在，
 * 因为 Agent 持有对话历史，并在状态机模式下驱动状态转换。
 *
 * ## 场景 1：一次性 Agent 任务
 *
 * 用户请求普通任务，例如“总结这个文件”或“修复这个 bug”。调用方发送 `start`（省略
 * `mode` 或设置 `mode: "auto"`）建立 Session；runner 发送带空 `state.agent` 的
 * `turn_started`。用户输入第一个 prompt 后，调用方发送 `prompt` command，runner 将其
 * 分类为 Agent 模式并发送：
 *
 * 1. 零个或多个 `step`、`todos`、`follow_up_queue` 或 `log` event；
 * 2. 携带最终答案和更新后 `state.agent` 的 `complete`。
 *
 * 这与普通 Agent runner 一样工作。由于 Session 不是长生命周期业务流程，不会出现状态机 UI。
 *
 * ## 场景 2：自动选择的状态机
 *
 * 用户请求具有复杂生命周期的任务，例如“持续跟进客户直到客户预约会议”，或“实现此改动、
 * 创建 PR 并持续观察直到合并”。使用 `mode: "auto"` 时，`start` 后的第一个 `prompt`
 * 会经过 runner 路由；runner 选择一个状态机，并在下一次发送的 state 中填充
 * `state.stateMachine`。
 *
 * turn 期间，runner 会发送 UI 可以直接渲染的 event：
 *
 * - `state_machine` 携带完整的状态机 Session snapshot；
 * - `step` 展示文本进度、推理、工具调用或系统消息；
 * - `todos` 展示当前任务进度；
 * - `follow_up_queue` 展示等待当前 turn chain 完成的 prompt；
 * - `task_started`、`task_output` 和 `task_settled` 暴露 task 生命周期变化；
 * - `log` 展示诊断消息。
 *
 * UI 始终可以把 `state.agent` 渲染为对话 transcript。若同时看到 `state.stateMachine`，
 * 还可以渲染状态机的 Kanban board。每个 `state_machine` event 会将可见的 Session 卡片
 * 移到当前状态列，并更新生命周期状态。
 *
 * ### 场景 2a：用户 follow-up 中断 turn
 *
 * 状态机运行期间，用户可以发送带 `behavior: "steer"` 的 `prompt` command。runner 应将
 * 它视为活动 pi Session 的额外用户上下文。例如，状态机等待回复时，用户可能说“我已经
 * 收到这封邮件”。runner Agent 可以吸收该消息，更新状态机状态，然后继续同一个状态机
 * Session，而不是放弃它。
 *
 * 典型的流是：
 *
 * 1. Agent 吸收用户更新时发送 `step` event；
 * 2. 更新后的状态机继续运行时发送更多 `state_machine` event；
 * 3. 携带更新后 `state` 的终态 event（`complete`、`ask`、`sleep` 或 `interrupted`）。
 *
 * ### 场景 2b：计划状态使用 sleep
 *
 * 状态机可能发送邮件后等待回复，或暂停到指定时间。重复的外部检查应建模为 poll 状态，
 * 而不是由用户拥有的无限 polling script。绝对等待应建模为 timer 状态。计划工作需要等待
 * 时，runner 会发送带 `wakeAt` 的终态 `sleep` event。
 *
 * runner 之上的层持久化状态，安排在 `wakeAt` 唤醒，并在该时间再次启动 runner。每次 wake
 * 时，runner 执行一次计划的 poll 尝试，或完成 timer 状态。计划工作结束后，runner 将结果
 * 记录到状态机 Session，并继续下一个状态。
 *
 * 如果 Session 在计划状态上睡眠时用户发送 prompt，Session 会取消待处理 wake，将该 prompt
 * 作为普通 turn runner turn 运行；如果状态机仍在等待，则 Session 回到 `sleep`。当业务流程
 * 实际正在等待外部事件时，用户不应看到稳定的 `complete` 状态。
 *
 * ### 场景 2c：中断状态机工作
 *
 * interrupt 会停止当前 turn 的活动 turn-runner 工作。如果状态机 Session 活动着，中断还会
 * 记录一个 interrupted 状态机终态标记。计划的 wakeup 由 Session 持有，并在那里取消。之后
 * 用户发送 prompt 时，会从 interrupted 状态开始新的 turn；父 Agent 可以选择正确的继续路径。
 *
 * ## 场景 3：显式状态机定义
 *
 * 调用方可以将完整的 `StateMachineDefinition` 作为 `mode` 传入。定义是一组 runner 可以
 * 使用的候选状态，不是强制每个 prompt 都进入该状态机的命令。
 *
 * 如果用户 prompt 匹配定义，runner 会直接运行该状态机，并发送与场景 2 相同的状态机 event。
 *
 * 如果用户 prompt 不适合提供的定义，runner 应在 Agent 模式下正常回答。从概念上说，此时
 * 选中的状态可以是 `undefined`：没有任何候选状态符合用户请求。
 */

/**
 * prompt 的顶层执行模式。
 *
 * - `"agent"`：将 prompt 作为普通的一次性/当前 Session Agent 会话处理。
 * - `"auto"`：让 runner 分类 prompt 需要哪种模式。即使此前的状态机已到达终态，auto
 *   Session 仍可随时间创建新的状态机定义。
 * - StateMachineDefinition：在适用时使用这组显式候选状态。显式定义 Session 受该定义
 *   限制；如果没有状态适配，选中状态可以是 undefined，runner 可以正常回答。
 */
export type TurnMode = "agent" | "auto" | StateMachineDefinition;

export type TurnRunnerTerminalStatus = "completed" | "failed" | "cancelled";

export type TurnStateStatus =
  | "running"
  | "waiting_for_human"
  | "sleeping"
  | "interrupted"
  | TurnRunnerTerminalStatus;

/** 继续后续 turn 所需的、由 TurnRunner 拥有的状态快照。 */
export interface TurnState {
  /** 当前 turn state 的生命周期，无论处于 Agent 还是状态机模式。 */
  status: TurnStateStatus;
  /**
   * 最初用于启动 Session 的 mode。恢复时必须保留它，使 `auto` Session 可以继续创建定义，
   * 而显式定义 Session 仍受提供的状态集合约束。
   */
  mode: TurnMode;
  /**
   * 后续 turn 使用的有效运行时选项。与 Agent transcript 分开持久化，使 model、memory model
   * 和 thinking level 即使进程默认值变化，也能在恢复后保留。
   */
  options?: TurnOptions;
  /** 始终存在 Agent conversation，包括状态机 Session。 */
  agent: AgentSession;
  /** 当前 Session 正在以状态机模式执行时存在。 */
  stateMachine?: StateMachineSession;
  /**
   * 已完成的 worker，但 parent 仍欠一次下一状态选择。跨暂停/重启保留它，因此继续时会重试
   * decision，而不是重复执行工作。输出保留在状态机 history 中，不会重复记录；只有新状态
   * 成功选择后才清除。
   */
  pendingStateTransition?: { stateName: string };

  /**
   * todo 工具写入的当前 todo 列表。与 turn state 一起持久化，使恢复的 runner 保留相同的
   * 工作计划，而不是从空的工具本地列表开始。
   */
  todos?: TurnTodo[];
  /**
   * 等待投递给用户的可见 follow-up prompt。parent Agent 活动时，runner 会将它镜像到 pi-agent
   * follow-up queue。每个条目是 `TurnPromptCommand` 的子集（`message` 和可选的 `images`），
   * 会与状态一起持久化，使恢复的 runner 能重放本应在线投递的相同多模态 payload。
   */
  followUpQueue?: TurnFollowUpQueueEntry[];
  /**
   * runner 已接受但尚未执行的 command，因为活动工作无法吸收它们。恢复后 runner 能安全
   * 继续时，会按原始顺序重放这些 command。
   */
  queuedCommands?: TurnCommand[];
  /**
   * 用于在 snapshot 或进程重启后重建活动 task 集合的 durable task descriptor。`running` task
   * 会保持当前进程唤醒；`scheduled` task 允许在 `wakeAt` 前睡眠；终态 task status 不持有
   * 任何资源。descriptor 必须持久化，因为 identity、ownership 和 lifecycle 要跨 hydration
   * 保留。运行时 promise 和 AbortController 绑定进程，故有意不存储；hydration 会把曾经
   * running 的工作标记为 `lost`，而不是假装 executor 仍存活。
   */
  tasks?: TaskDescriptor[];
  /**
   * 为进程绑定 task 保留的输出，用于崩溃恢复时告诉下一次 parent pass 每个丢失 executor 最后
   * 报告的内容。以 task id 为 key，最多保留最后三个 chunk，每个限制为末尾 1,500 个字符，
   * 防止恢复上下文让 durable snapshot 无界增长。
   */
  taskOutputTails?: Partial<Record<TaskId, string[]>>;
  /**
   * 尚未将崩溃恢复上下文附加到 parent pass 的丢失 task id。持久化此投递标记，防止连续
   * 重启在 parent 行动前悄悄丢掉提醒。
   */
  pendingLostTaskReminderTaskIds?: TaskId[];
  /**
   * 为下一个 task id 分配的数字后缀。将分配器与 descriptor 一起持久化，即使终态 descriptor
   * 被压缩或从 state.json 恢复，也能保持 id 单调递增。
   */
  nextTaskId?: number;
  /**
   * 持久化的 wire-shaping 状态。跨 resume 携带 sticky eviction horizon 和未来的 wire-shaping
   * 字段，使压缩后的 Session 保留裁剪过的 wire-tail——durable transcript 仍保留完整历史，
   * 但下一个 outgoing prompt 继续只发送 horizon 之后的切片。新 Session 没有此字段；runner
   * 会回退到 `createInitialHorizon()`。
   */
  wireGuardHorizon?: WireGuardHorizon;
}

/**
 * actor Agent wire-tail 的 sticky eviction 点。pi-agent 每个 turn 都会对完整的未转换历史重新
 * 运行 `transformContext`；如果 projection 的裁剪点每轮移动，prompt-cache 前缀会每次失效。
 * 将裁剪固定到只会推进的 timestamp 后，被丢弃的前缀在内容上保持确定，后续 turn 可以重新
 * 命中 provider prompt cache。
 *
 * runtime 为每个 runner 保留一个可变实例（由 `TurnRunner.wireGuardHorizon` 持有，并由
 * observational context transform 引用）。它通过 `TurnState` 往返持久化，使 resume 保留
 * 裁剪后的 wire-tail；当 observational context transform 的 auto-trigger 触发、
 * `tryRecoverFromContextOverflow` 响应 provider overflow error，或用户调用 `compact` 时推进。
 *
 * 定义为对象而不是裸 timestamp，使未来的 wire-shaping 字段可以在不改 schema 的情况下
 * 与 horizon 一起持久化。
 */
export interface WireGuardHorizon {
  /** `timestamp <= evictionHorizon` 的消息会从 wire 中丢弃。 */
  evictionHorizon: number;
}

/** pi Session 活动时，follow-up prompt 的投递方式。 */
export type TurnPromptBehavior = "steer" | "follow_up";

export interface TurnOptions {
  /** 面向用户的 Agent turn 的 model 覆盖值，可以是 shorthand 或 provider:modelId。 */
  model?: string;
  /**
   * observation memory 提取和 reflection 使用的 model 覆盖值，可以是 shorthand 或
   * provider:modelId。省略时使用 runner 的 `memoryModel`，再回退到默认 memory model。
   */
  memoryModel?: string;
  thinkingLevel?: ThinkingLevel;
}

export interface TurnQuestionOption {
  /** 展示给用户的选项标签。 */
  label: string;
  /** 选项的可选额外上下文。 */
  description?: string;
}

export interface TurnQuestion {
  /** 向用户展示的问题文本。 */
  question: string;
  /** 分组问题的可选分节标题。 */
  header?: string;
  /** 可用的回答选项。 */
  options: TurnQuestionOption[];
  /** 是否可以选择多个选项。 */
  multiSelect?: boolean;
}

export type TurnTodoStatus = "pending" | "in_progress" | "completed" | "failed";

export interface TurnTodo {
  /** todo 编辑用于替换已有工作项的稳定标识符。 */
  id: string;
  /** 面向稳定 UI 的工作项标签。 */
  content: string;
  /** 工作项的当前进度状态。 */
  status: TurnTodoStatus;
}

/** token accounting 镜像 pi 的 Usage 形状，使 runner event 可以转发 provider usage 而不重命名字段。 */
export type TurnTokenUsage = Usage;

export type TurnStep =
  | {
      type: "text_delta";
      /** canonical `text` step 到达前流式发送的部分 assistant 文本。 */
      delta: string;
    }
  | {
      type: "reasoning_delta";
      /** canonical `reasoning` step 到达前流式发送的部分 reasoning。 */
      delta: string;
    }
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | {
      /**
       * 工具调用已开始执行。这是 canonical `tool_call` step 的临时前置事件，
       * 类似 `text_delta` 先于 `text`。
       */
      type: "tool_call_start";
      toolName: string;
      /** 将此 start 与对应的 canonical `tool_call` step 关联起来。 */
      toolCallId: string;
      /** 模型解析的工具参数；形状由具体工具决定。 */
      input?: Record<string, any>;
    }
  | {
      /**
       * 已结束工具调用的 canonical 记录。类似 `text_delta` 之后的 `text`，它是自包含的：
       * 会在 result 旁回显调用的 `input`，使消费者无需从较早的 `tool_call_start` 拼接状态，
       * 就能渲染已结束的调用。
       */
      type: "tool_call";
      toolName: string;
      /** 与开始此调用的 `tool_call_start` step 的 `toolCallId` 匹配。 */
      toolCallId: string;
      /** 从匹配的 `tool_call_start` 回显的工具参数。 */
      input?: Record<string, any>;
      /** 工具是否以错误结束。 */
      isError: boolean;
      /** 工具结果内容。 */
      output?: (TextContent | ImageContent)[];
      /** 用于机器可读结果的、工具专属的结构化结果元数据。 */
      details?: unknown;
    }
  | { type: "system"; message: string };

/**
 * HTTP MCP server 配置。
 *
 * runner 通过 streamable-HTTP transport 连接，在 start 时列出 server 的 tools，并以
 * `{server}__{tool}` 形式的名称暴露给 Agent。认证有意不在此处处理：通过 `headers`
 * 传入 server 要求的凭据。
 */
export interface McpHttpServerConfig {
  /** transport 标签；目前只支持 `"http"`。 */
  type: "http";
  /** 远程 MCP endpoint 的绝对 http 或 https URL。 */
  url: string;
  /** 每次向此 server 发请求时携带的额外 HTTP header。 */
  headers?: Record<string, string>;
}

/**
 * 建立新的 turn-runner Session。
 *
 * `start` 是 setup command，不是 turn。runner 加载 memory 和 skills，保存初始 `TurnState`
 *（新建或通过 `state` 传入的恢复状态），并发送 `turn_started`。不会运行 Agent 工作；
 * 调用方之后发送 `prompt` 才真正运行 turn。skills、Agent 文件和 skill 冲突通过 runner
 * 专用方法暴露，使调用方无需订阅专用 event 即可渲染 setup 摘要。
 *
 * CLI/TUI 启动时发送它，使用户在输入第一个 prompt 前就能看到可用 skills。
 */
export interface TurnStartCommand {
  type: "start";
  /** 后续 prompt 的路由模式。省略时使用 turn runner 配置的默认值。 */
  mode?: TurnMode;
  /**
   * 要恢复的已有状态。提供后，runner 会用此状态发送 `turn_started`，而不是新建状态。
   * 恢复的 Session 保留其持久化的 Agent 和状态机历史。
   */
  state?: TurnState;
  /**
   * Session-scoped runtime options。runner 启动时固定它们，使 parent pi-agent 在后续每个
   * relay-pi turn 内都保持稳定的 model、thinking level 和 prompt cache 形状。
   */
  options?: TurnOptions;
  /**
   * 在第一个 turn 运行前连接的远程 MCP server。每个条目的 tools 会以命名空间名称暴露给
   * parent 和 state Agent。连接失败会记录并跳过，因此单个损坏的 server 不会阻塞 Session setup。
   */
  mcpServers?: Record<string, McpHttpServerConfig>;
}

/**
 * 与 prompt 文本一起携带的图像附件。数据是 base64 编码的原始图像字节（不带 `data:` URL
 * 前缀），`mimeType` 使用视觉模型期望的标准标签，如 `image/png`、`image/jpeg`。
 *
 * 附件会原样传给底层 Agent，作为多模态 user content；外层 `message` 文本仍是 prompt 的主体。
 */
export interface TurnPromptImage {
  data: string;
  mimeType: string;
}

/**
 * 等待重新投递给 parent Agent 的 pending follow-up prompt。
 *
 * 形状是 `TurnPromptCommand` 的子集（用户可见的 prompt 字段，不含隐含的 `behavior`——
 * 每个排队条目都会作为 follow-up 运行）。与 `TurnState.followUpQueue` 一起持久化，使恢复的
 * Session 投递与原始 turn 本应发送的相同多模态 payload。
 */
export interface TurnFollowUpQueueEntry {
  message: string;
  images?: TurnPromptImage[];
}

/**
 * 针对 runner 当前状态发送新的用户 prompt。
 *
 * 即使上一次 `turn()` 调用仍活动，调用方也可以发送 prompt command。runner 会在可能时
 * 将 `behavior` 映射到活动 pi Agent，否则将 command 排到活动的非 Agent 工作之后。状态保留
 * 在 runner 内部：由 `start` 引导，并从 runner 自己的终态 event 更新。
 */
export interface TurnPromptCommand {
  type: "prompt";
  message: string;
  /**
   * 此用户消息的投递行为。runner 会判断当前是 parent pi-agent 还是状态机工作在驱动公开的
   * relay-pi turn；该 driver 决定消息立即到达 pi，还是等待状态转换上下文。
   */
  behavior: TurnPromptBehavior;
  /**
   * 作为多模态内容投递给 parent pi-agent 的可选图像附件。空值/undefined 表示纯文本 prompt，
   * 即此前的行为。
   */
  images?: TurnPromptImage[];
}

/**
 * 为 runner 发出的结构化问题提供回答。
 *
 * 回答会序列化为 parent Agent prompt 文本，并遵循与 prompt 相同的活动 turn 行为。
 * state Agent 的回答也会经过 parent，由 parent 检查状态机 history 并选择合适状态。
 */
export interface TurnAnswerCommand {
  type: "answer";
  questions: TurnQuestion[];
  /**
   * 每个问题选中的选项标签，以 `question.question` 为 key。
   * 始终使用数组，使单选和多选共享同一形状；单选回答是单元素数组，空数组表示用户在
   * 多选问题中未选择任何内容就继续了。
   */
  answers: Record<string, string[]>;
  /** 序列化回答后的投递行为，与 prompt 相同。 */
  behavior: TurnPromptBehavior;
  /**
   * 序列化后的 answer XML 后追加的可选自由文本 prompt。
   * 用户决定直接输入而不是完成 picker 时，可以在一个 turn 中提交部分回答和新指令。
   */
  message?: string;
  /**
   * 与合成 prompt 一起投递的可选图像附件，语义与 `TurnPromptCommand.images` 相同。
   */
  images?: TurnPromptImage[];
}

/** 唤醒 runner 的睡眠状态；如果状态没有等待计划工作，则这是 no-op。 */
export interface TurnWakeCommand {
  type: "wake";
}

/**
 * 替换当前可见的 follow-up queue。
 *
 * 这是 UI client 使用的带外编辑 command。可能时会将 queue 镜像到活动 pi Agent，但 protocol
 * event 来自 runner 拥有的 prompt 列表，使 client 可以直接渲染和编辑它。
 */
export interface TurnEditFollowUpQueueCommand {
  type: "edit_follow_up_queue";
  /** prompt 应投递的完整替换 queue，按投递顺序排列。 */
  prompts: TurnFollowUpQueueEntry[];
}

/** 驱动一次 turn-runner turn 的 command。排除 `start`，因为 setup 不是 turn，直接由 `TurnRunner.start()` 处理。 */
export type TurnCommand = TurnPromptCommand | TurnAnswerCommand | TurnWakeCommand;

/** 在当前运行 turn 外带控制消息，用于中断它。 */
export interface TurnInterruptCommand {
  type: "interrupt";
}

/**
 * 在 runner 的 wire-visible 消息尾部执行压缩的带外控制消息。`TurnState.agent.messages` 中的
 * durable transcript **不会**被修改；runner 只推进 sticky wire-shaping eviction horizon，使
 * 下一次向 actor model 发出的请求携带更小的 prompt。scrollback、resume 以及 observer/reflector
 * pass 都保留完整历史。
 *
 * 目标选择针对当前 wire-tail，而不是 durable transcript：
 * - 当 wire-tail 当前占 parent Agent effective context window 的 20% 以上时，目标是 20% 上限，
 *   为 system prompt、memory pack、下一个用户 prompt 和下一个 assistant 响应留下 80% 余量。
 * - 当 wire-tail 已低于 20% 时，目标改为当前 wire-tail token 数的一半。`compact` 由用户发起，
 *   因此即使 Session 已经很轻，也会产生可见的缓解，而不是静默 no-op。
 *
 * 与自动 wire-shaping trigger（只有 actor context-window 预算超限时才触发）不同，`compact`
 * 即使 wire 已低于预算也会运行，使调用方可以按需释放上下文。
 *
 * `compact` 不会开始或结束 turn。turn chain 正在运行时，它会以 soft warning 被拒绝——在
 * stream 中途修改 horizon 会使 parent（或 state Agent）已经 dispatch 的请求失效。poll/timer
 * sleep 发出 `sleep` 终态前已经解析完 chain，因此等待期间可以干净地运行 compact；调用方只需
 * 在 turn 正在 dispatch 时推迟 compact。
 */
export interface TurnCompactCommand {
  type: "compact";
}

export type TurnRunnerCommand =
  | TurnStartCommand
  | TurnCommand
  | TurnInterruptCommand
  | TurnEditFollowUpQueueCommand
  | TurnCompactCommand;

/** delivery 必须关联时使用的 RPC transport envelope。 */
export type RpcTurnCommand = TurnCommand & { requestId: string };

/** 换行分隔 RPC transport 接受的 command。 */
export type RpcRunnerCommand =
  | TurnStartCommand
  | RpcTurnCommand
  | TurnInterruptCommand
  | TurnEditFollowUpQueueCommand
  | TurnCompactCommand;

/** 为 Session 在磁盘上解析出的 system-prompt 文件。 */
export interface TurnAgentFile {
  /** 相对于工作目录配置的文件名，例如 "AGENTS.md"。 */
  name: string;
  /** 磁盘上的绝对路径。 */
  path: string;
}

export interface TurnStartedEvent {
  type: "turn_started";
  /** 应用 config/options/auto routing 后的完整 turn state。 */
  state: TurnState;
}

export interface TurnStepEvent {
  type: "step";
  step: TurnStep;
  /**
   * task-backed 子 Agent 产生此 step 时设置。parent Agent 不设置；将 `taskId` 与
   * `task_started` 关联即可取得其名称和角色。
   */
  origin?: TurnEventOrigin;
}

/** 标识生成非 parent event 的 task runtime。 */
export interface TurnEventOrigin {
  /** spawned 和 state-machine 子 Agent 共享的稳定 identity。 */
  taskId: TaskId;
}

/** task id 分配且 descriptor 可观察后发送一次。 */
export interface TurnTaskStartedEvent {
  type: "task_started";
  /** task 启动时的完整 durable descriptor。 */
  task: TaskDescriptor;
  /** 由另一个 task runtime 引起此生命周期变化时存在。 */
  origin?: TurnEventOrigin;
}

/** turn 保持打开时，每追加一个 task-output chunk 发送一次。 */
export interface TurnTaskOutputEvent {
  type: "task_output";
  taskId: TaskId;
  /**
   * 仅包含增量输出；消费者按 event 顺序追加 chunk。这不是累计 replay。late attach 和显式
   * task_output 请求会从 TaskManager 获取累计缓冲 snapshot。
   */
  chunk: string;
  /** 由另一个 task runtime 引起此生命周期变化时存在。 */
  origin?: TurnEventOrigin;
}

/** task 到达终态 lifecycle status 后发送一次。 */
export interface TurnTaskSettledEvent {
  type: "task_settled";
  /** 终态值，包括工作是 completed、failed、stopped 还是 lost。 */
  settlement: TaskSettlement;
  /** 由另一个 task runtime 引起此生命周期变化时存在。 */
  origin?: TurnEventOrigin;
}

/**
 * 进程内 task 保持 turn 打开时发送的 RPC transport liveness signal。它是 transport telemetry
 * 而非 model activity：runner 不会把它加入 Agent transcript、routing observations 或 memory。
 */
export interface TurnHeartbeatEvent {
  type: "heartbeat";
  /** RPC transport runtime clock 提供的 timestamp。 */
  timestamp: number;
  /** 当前需要 RPC 进程保持唤醒的运行中 task id。 */
  activeTaskIds: TaskId[];
}

export interface TurnTodosEvent {
  type: "todos";
  todos: TurnTodo[];
}

export interface TurnFollowUpQueueEvent {
  type: "follow_up_queue";
  /** 活动工作 settlement 后等待作为 follow-up 运行的 prompt。 */
  followUpQueue: TurnFollowUpQueueEntry[];
}

export interface TurnStateMachineEvent {
  type: "state_machine";
  /**
   * 完整 Session snapshot，使单个 event 包含 UI 渲染 relay 所需的一切。
   * `stateMachine.progress.states[name].runs > 0` 表示“已经运行过”。
   */
  stateMachine: StateMachineSession;
}

export interface TurnMemoryEvent extends ObservationalMemoryActivityEvent {
  type: "memory";
}

/**
 * parent Agent 输入各区域当前占用 token 数的分段估算。它不同于报告 provider 平面总量的
 * `TurnTokenUsage`：此分解将占用归因到 runner 控制的 segment，使界面可以显示预算究竟
 * 被哪一部分填满。数值是基于字符长度的启发式估算，而不是精确 tokenizer 计数。
 *
 * 在 `usage` event 中，runner 会重新缩放这四个字段，使其总和等于 provider 提供的最新
 * parent assistant message 的 `totalTokens`。event 的 `usage` 字段携带运行中的 turn aggregate，
 * 而此分解描述最新的 parent input——两者有意使用不同分母。
 */
export interface TurnContextWindowUsage {
  /**
   * parent Agent 完整 system prompt 占用的 token，包括基础 coding-agent prompt、用户提供的
   * `systemInstructions` 以及从磁盘加载的每个 system-prompt 文件（通常是 `AGENTS.md`）。
   */
  systemPrompt: number;
  /**
   * 下一个 turn 将发送的原始消息历史占用的 token，包括刚追加到 state 的最新 assistant 响应。
   * 每次请求由 transform 重新注入的 synthetic memory wrapper 不计入；它们是临时的。
   */
  messages: number;
  /**
   * 渲染到 actor prefix 的当前 Session local memory pack 占用的 token。
   * 汇总 frozen local pack 中每个 observation 和 reflection 的 `content` 字段。
   */
  localMemory: number;
  /**
   * 渲染到 actor prefix 的跨 Session global memory pack 占用的 token。
   * 汇总 frozen global pack 中每个 observation 和 reflection 的 `content` 字段。
   */
  globalMemory: number;
}

/**
 * `usage` during-event 和每个终态 event 共用的 token accounting payload。将字段放进同一接口
 * 可使 during stream 与终态 event 保持同步：每个 `usage` event 和终态 event 都拥有相同形状，
 * 只读取终态的消费者也能恢复运行中的 aggregate 和最新 parent context bar。
 *
 * 报告两种不同的 token 总量：
 * - `turnUsage`：每个 turn 的 aggregate，覆盖所有成功记录的 LLM 调用（parent worker、state
 *   Agent、classifier、advisor 和 memory worker）。用于成本统计和“本 turn 花了多少”的展示。
 *   它不能与 `effectiveContextWindow` 比较，因为上限按请求计算。
 * - `lastMessageUsage`：最近一条 parent assistant message 的精确 provider usage。用于上下文
 *   窗口压力展示（“X / cap”）：`lastMessageUsage.totalTokens` 是最近调用中 parent window 的
 *   实际占用，`contextWindowUsage` 则提供同一总量上的启发式分段分解。
 */
export interface TurnUsageFields {
  /**
   * 运行中的 turn aggregate：到目前为止此 turn 记录的每个 model `usage` 之和，包括 parent、
   * state Agent、classifier、advisor 和 memory 调用。始终是累计值，不是单次调用的 delta。
   */
  turnUsage: TurnTokenUsage;
  /**
   * 与 `turnUsage` 相同的 aggregate，但按产生每次调用的 model 分组——因此 state Agent 使用不同
   * model 的 relay turn 可以按 model 归因。不变量 `sum(usageByModel[].usage.cost.total) === turnUsage.cost.total`。
   * 尚未记录 usage 时为空数组。
   */
  usageByModel: ModelUsageEntry[];
  /**
   * 最近一条 parent assistant message 的 provider usage。每次 parent `message_end` 刷新；只有
   * state Agent 或辅助调用推进 `turnUsage` 时保持不变。这是与 `effectiveContextWindow` 比较
   * 时应展示的准确数字——它反映 API 对最近一次 parent 调用的精确计数（`input` 是新输入，
   * `cacheRead` + `cacheWrite` 是缓存命中/写入，`totalTokens` 是它们与 `output` 的总和）。
   */
  lastMessageUsage: TurnTokenUsage;
  /**
   * 展示 `lastMessageUsage.totalTokens` 时使用的有效上限。它反映用户设置的
   * `TurnRunnerConfig.effectiveContext`（默认 200k），并限制到 model 的硬 context window。
   * 每个 memory budget 都从同一个值派生，因此此 bar 也代表实际的压缩上限。跟踪最新的
   * parent emission；只有 state Agent 推进 `turnUsage` 时保持稳定。
   */
  effectiveContextWindow: number;
  /**
   * 最近一条 parent message 的 input 如何分配到 system prompt、原始消息历史和两个 memory pack
   * 层的启发式分段分解。让界面可视化究竟是哪个预算在增长。重新缩放后四个字段的总和
   * 恰好等于 `lastMessageUsage.totalTokens`，因此消费者可以用此分解驱动 bar 的分段宽度，
   * 同时让绝对尺度以准确的 provider 总量为基准。与 `effectiveContextWindow` 一样，它镜像
   * 最新的 parent emission，不会在 state Agent tick 时移动。
   */
  contextWindowUsage: TurnContextWindowUsage;
}

/**
 * turn usage 的一个 model-and-transport 分片。fallback 可能在两个 provider 上使用同一逻辑
 * model，因此消费者不能只按 model id 合并行。
 */
export interface ModelUsageEntry {
  /** model runtime 报告的 provider-specific model id。 */
  model: string;
  /** 承载此次调用的 backend，以及其成本是否由订阅覆盖。 */
  transport: {
    provider: TransportName;
    billing: "plan-covered" | "metered";
  };
  /** 此 model/provider 对的累计 token 和成本。 */
  usage: TurnTokenUsage;
}

/** parent context snapshot 存在且计费 usage 推进后发送。`turnUsage` 包含所有记录的 parent、state Agent、classifier、advisor 和 memory 调用；context 字段仍限定于最近一次 parent 调用。 */
export interface TurnUsageEvent extends TurnUsageFields {
  type: "usage";
  /**
   * 此 usage tick 在 task-backed 子 Agent 边界发送时设置。parent 驱动的 tick 不设置，
   * 使消费者可以归因运行中的成本。
   */
  origin?: TurnEventOrigin;
}

/**
 * 终态 event 可选地嵌入相同 payload：本 turn 至少记录过一条 assistant message 时，runner
 * 始终附加最终运行 aggregate 和最新 parent snapshot。没有执行 LLM 工作的早期终态（例如在
 * 任何 message 之前立即 ask）可以省略它们。
 */
export interface TurnTerminalBaseEvent extends Partial<TurnUsageFields> {
  state: TurnState;
}

export interface TurnAskEvent extends TurnTerminalBaseEvent {
  type: "ask";
  questions: TurnQuestion[];
}

export interface TurnCompletedEvent extends TurnTerminalBaseEvent {
  type: "complete";
  status: TurnRunnerTerminalStatus;
  result?: string;
  error?: string;
}

export interface TurnInterruptedEvent extends TurnTerminalBaseEvent {
  type: "interrupted";
}

export interface TurnSleepEvent extends TurnTerminalBaseEvent {
  type: "sleep";
  /** 外层应唤醒 runner 的 Unix 毫秒 timestamp。 */
  wakeAt: number;
}

export interface TurnSystemEvent {
  type: "system";
  level: "debug" | "info" | "warn" | "error";
  message: string;
}

/**
 * virtual-model router 选中的具体 model 或 reasoning-effort 变化。派生自 router 自身的 switch
 * 形状，使两者不会漂移——runner 发送 `{ type: "router_switch", ...switched }`。
 */
export interface TurnRouterSwitchEvent extends RouterSwitch {
  type: "router_switch";
  /** 只有未来独立路由的 child Agent 发送 switch 时才存在。 */
  origin?: TurnEventOrigin;
}

/** runner 仍在处理当前 turn 时发送的 event。 */
export type TurnDuringEvent =
  | TurnStepEvent
  | TurnHeartbeatEvent
  | TurnTaskStartedEvent
  | TurnTaskOutputEvent
  | TurnTaskSettledEvent
  | TurnTodosEvent
  | TurnFollowUpQueueEvent
  | TurnStateMachineEvent
  | TurnMemoryEvent
  | TurnUsageEvent
  | TurnSystemEvent
  | TurnRouterSwitchEvent;

/** 结束当前 turn 的 event。 */
export type TurnTerminalEvent =
  | TurnAskEvent
  | TurnCompletedEvent
  | TurnInterruptedEvent
  | TurnSleepEvent;

export type TurnEvent = TurnStartedEvent | TurnDuringEvent | TurnTerminalEvent;

/** 仅 RPC 使用的 delivery receipt；runner subscriber 不会观察到此 event。 */
export interface RpcCommandAcceptedEvent {
  type: "command_accepted";
  requestId: string;
  commandType: RpcTurnCommand["type"];
}

/** 私有 host recovery snapshot；永远不会进入用户可见的 event history。 */
export interface RpcCheckpointEvent {
  type: "checkpoint";
  state: TurnState;
}

/** `relay-pi --rpc` 的完整换行分隔输出 union。 */
export type RpcEvent = TurnEvent | RpcCommandAcceptedEvent | RpcCheckpointEvent;
