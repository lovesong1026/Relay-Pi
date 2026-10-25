import type { ThinkingLevel } from "@earendil-works/pi-ai";

export const INTERRUPTED_STATE_MACHINE_STATE = "interrupted";

/**
 * durable 状态机定义和运行时状态。
 *
 * 状态机建模高层业务流程，而不是 task 执行。任意时刻只有一个当前业务状态。状态机
 * runner Agent 会看到原始 prompt、当前转换 input、状态 history 和状态定义，然后决定下一个
 * 状态、Session 是否应等待，或终态是否应完成状态机。
 *
 * 如果某个状态需要 fan-out、并行或 task 级 workflow 执行，应放在 agent/script 状态内部。
 * 状态机只跟踪业务层状态转换。不要将 email、GitHub、Slack、Calendly 或 webhook 等集成
 * 硬编码进引擎。任何提供 API 或 CLI 的外部系统都可以通过 bash script 接入；引擎可以接受
 * 几分钟的 polling 延迟，而不需要实时响应能力。
 *
 * 案例 1：会议外联状态机
 *
 * 用户提供 email 地址。Agent/script 状态可以丰富潜客信息、研究公司、起草/发送外联消息，
 * 然后由 poll 状态检查潜客是否回复或下一次 follow-up 日期是否到达。
 *
 * runner 应：
 *
 * 1. 从 StateMachineDefinition 启动 StateMachineSession。
 * 2. 进入 enrichment/research 的 agent 状态，并把输出记录到 Session history，使状态机
 *    恢复时无需重复研究。
 * 3. 进入发送邮件的 script 状态，并记录已发送消息的详情。
 * 4. runner 可以选择 poll 状态。runner 执行一次 poll 尝试；没有变化时发送 sleep event，
 *    依赖外层稍后唤醒。poll 尝试可以运行 script 或提示 Agent，只有状态机有下一步工作时
 *    才应返回结构化数据，例如：
 *    - 潜客已回复；
 *    - follow-up 到期；
 *    - 会议已安排；
 *    - 外联窗口已过期。
 * 5. polling 返回回复 payload 后，恢复 Session，并要求 Agent 将其分类为：感兴趣、否定、
 *    临时问题、中立或不清楚。
 * 6. runner 根据分类选择下一状态：
 *    - interested -> send Calendly / schedule-meeting 状态；
 *    - ad hoc question -> 回答问题，然后回到等待；
 *    - negative -> 终态 `prospect_not_interested`；
 *    - unclear -> 追问或等待更多上下文。
 * 7. polling 返回 follow-up_due 后，如果 Session 未超过 cadence 限制则发送 follow-up，
 *    例如每 4 天一次，持续一个月。
 * 8. 在命名的终态之一结束：
 *    - meeting_scheduled；
 *    - prospect_not_interested；
 *    - negative_response；
 *    - no_response_after_followups。
 *
 * 状态机类型应通过以下结构支持它：
 *
 * - durable Session history；
 * - 输出可通过状态机 history 获取的 agent/tool/script 状态；
 * - poll 状态以及显式等待人工输入；
 * - 由完整 prompt、转换 input 和 history 驱动的 runner-Agent decision；
 * - 比通用 "completed" 或 "failed" 更丰富的命名终态。
 *
 * 案例 2：开发状态机
 *
 * 用户提供 prompt。Agent/script 状态可以创建隔离 worktree、运行开发 Agent、运行 review
 * Agent、创建 PR，poll 直到 PR 合并或关闭，然后清理 worktree。
 *
 * runner 应：
 *
 * 1. 从用户 prompt 启动 StateMachineSession。
 * 2. 执行创建 worktree 并将路径记录到状态机 history 的 script/tool 状态。
 * 3. 执行在 worktree 内实现请求改动的 agent 状态。
 * 4. 执行 review agent 状态。review 可以批准、要求修复或阻塞状态机。
 * 5. 如果要求修复，带着 review feedback 再次选择 dev-agent 状态。Session history 应保留
 *    两次尝试。
 * 6. 获批后执行 PR 创建状态，并记录 PR 编号/URL。
 * 7. 进入 poll 状态。每次 poll 可以使用 gh、git 或其他 CLI/API wrapper 检查 PR 状态并返回：
 *    - merged -> 继续清理并进入终态 merged；
 *    - closed -> 继续清理并进入终态 closed。
 * 8. 使用记录的 worktree 路径执行清理。
 *
 * 状态机类型应通过以下结构支持它：
 *
 * - 可用业务状态目录；
 * - 不丢失既有状态 history 的 retry/review 循环；
 * - 两次尝试之间使用 sleep 的 poll 状态；
 * - 外部终态结果后运行的清理/finalizer 状态；
 * - merged、closed、failed_review 或 cancelled 等终态。
 *
 * 状态机模式下，parent runner 仍是带普通工具的普通 pi Agent。区别在于 prompt 和路由：
 * 它应尽可能通过状态机完成 durable 业务流程，同时在合适时直接回答简单的无关请求。parent
 * runner dispatch 当前状态，记录所选状态的结果，询问 runner Agent 下一状态，更新 history，
 * 并发送 protocol event。
 *
 * Agent 状态通过以普通 Agent 模式运行 runner 来执行。parent runner 不是独立的 worker pool；
 * 所选状态拥有执行权，agent 状态将执行委派回 turn-runner 的 Agent-mode turn。因此同一状态机
 * 可以从中间开始，例如用户说“我已经发过邮件，只需等待回复”。runner 构造 Agent prompt 时
 * 自动注入原始 prompt 和相关 history；状态定义只描述自身行为。人工输入由 parent 拥有：机器
 * 停放而不执行工作，parent 负责提出离开 park 所需的问题。polling 保持显式，因为 runner
 * 拥有一次 poll 尝试，并在下一次尝试前发送 sleep。
 *
 * 模板化 script command 示例：
 *
 * parent runner 选择状态时可以传入转换 input：
 *
 *   {
 *     kind: "script",
 *     inputSchema: {
 *       type: "object",
 *       properties: { branchName: { type: "string" } },
 *       required: ["branchName"]
 *     },
 *     command: "scripts/create-worktree.sh '{{ input.branchName }}'"
 *   }
 *
 * 后续开发或清理状态可以接收从前一状态完成输出中选取的新 input：
 *
 *   {
 *     kind: "script",
 *     command: "rm -rf '{{ input.worktreePath }}'"
 *   }
 *
 * PR poll 状态可以通过任意 CLI/API wrapper 检查，而不需要状态机引擎了解 GitHub：
 *
 *   {
 *     kind: "poll",
 *     command: "scripts/check-pr-finished.sh '{{ input.prUrl }}'",
 *     intervalMs: 300000
 *   }
 */

/** 用户编写的状态机模板。运行时进度存放在 StateMachineSession。 */
export interface StateMachineDefinition {
  /** 在 CLI/UI 中用于选择时展示的可读标签。 */
  name: string;
  /**
   * 给 runner Agent 的路由指导，说明这组状态适用于什么情况；如果用户请求不匹配此 prompt，
   * 选中状态可以是 undefined，runner 可以在 Agent 模式下正常回答。
   */
  prompt: string;
  /** runner Agent 可以选择的状态列表，包括终态。 */
  states: StateMachineState[];
}

/** 持久化的执行状态。runner 可以在任意状态后停止，并从此 Session 继续而不重复已完成工作。 */
export interface StateMachineSession {
  /** 当前活动 definition；恢复和 dispatch currentState 时必需。 */
  definition: StateMachineDefinition;
  /** 启动状态机的原始用户请求。 */
  prompt: string;
  /**
   * runner Agent 选择的当前业务状态。
   *
   * 保留值 "interrupted" 表示 runtime 工作在状态完成前被中止。它不是用户编写的状态名；
   * 先前运行状态及其 input 仍可在 history 中找到。
   */
  currentState?: string;
  /**
   * parent runner 选择当前状态时提供的 input。持久化它，使睡眠中的计划状态能用相同的模板值恢复。
   */
  currentInput?: Record<string, unknown>;
  /**
   * 用于状态查询的紧凑进度计数。与 history 分开，避免频繁的 poll sleep 刷屏审计日志。
   */
  progress?: StateMachineProgress;
  /** 用于调试、重放和持久化的只追加审计日志。 */
  history: StateMachineSessionEvent[];
  /** 只有 Session 到达命名终态后存在。 */
  terminal?: StateMachineTerminalResult;
  /**
   * parent runner 为当前 `terminal` 运行 acknowledgment turn 后设置。状态机工具会以
   * `terminate: true` 结束 parent prompt loop，因此驱动状态机进入终态的 turn 不会自然地在
   * parent transcript 中确认结果；turn runner 会在记录终态后立即运行一次最终 parent prompt，
   * 补上这一环（见 turn-runner.ts 中的 `runStateMachineTerminalAcknowledgment`）。
   *
   * 此标记按 Session 生效：如果 parent 在 acknowledgment pass 中重新路由回 turn loop，
   * 它可防止同一个 `session.terminal` 被重复确认。acknowledgment turn 中创建的新状态机
   * 会由 `createStateMachineSession` 建立新的 Session，并在自身终止时获得独立确认。
   */
  terminalAcknowledged?: boolean;
  createdAt: number;
  updatedAt: number;
}

export type StateMachineState =
  | StateMachineAgentState
  | StateMachineScriptState
  | StateMachinePollState
  | StateMachineTimerState
  | StateMachineParkState
  | StateMachineTerminalState;

export interface StateMachineProgress {
  /** 按状态名索引的计数，用于紧凑的进度查询。 */
  states: Record<string, StateMachineStateProgress>;
}

export interface StateMachineStateProgress {
  /** 活动 definition 更新进度条目时记录的状态 kind。 */
  kind?: StateMachineState["kind"];
  /** parent 选择此状态的次数。 */
  runs: number;
  /** 此状态在等待下一次 wake 时发送 sleep 的次数。 */
  sleeps: number;
  /** 最近一次 sleep 的计划 wake 时间；状态再次运行时清除。 */
  nextWakeAt?: number;
  /**
   * 此状态最近一次 `state_started` 的时间戳。镜像 history 中的记录，使 elapsed-time 检查
   *（例如 poll `timeoutMs`）即使旧的 `state_started` 条目从有上限的 history 中移除后仍能工作。
   */
  startedAt?: number;
}

export interface StateMachineBaseState {
  /** 状态名，在 status 输出中展示，并供 runner 选择状态时使用。 */
  name: string;
  /** 帮助 runner Agent 理解何时适合选择此状态。 */
  when?: string;
  /**
   * parent runner 选择此状态时必须提供的 input 的可选 JSON Schema。runner 会在执行前校验
   * 转换 input，并将其以 `input` 暴露给 prompt/script 模板。
   */
  inputSchema?: Record<string, unknown>;
}

/** 运行 Agent。runner 会在此状态配置之外注入原始 prompt/history。 */
export interface StateMachineAgentState extends StateMachineBaseState {
  kind: "agent";
  /**
   * 发送给子 Agent 的用户 prompt。parent runner 选择此状态时，会使用转换 input 将其渲染为模板。
   */
  prompt: string;
  /**
   * 只追加到此子 Agent 基础 system prompt 的可选 system prompt。用于持久化角色或行为指令；
   * 动态状态 input 应放在 `prompt` 中。
   */
  systemPrompt?: string;
  /**
   * 此子 Agent 的可选 skill allowlist。设置后只将这些已发现或显式配置的 skill 注入子 Agent
   * system prompt。
   */
  allowedSkills?: string[];
  /**
   * 此子 Agent 编程工具（bash、read、write、edit）的工作目录。默认使用状态机 Session cwd。
   * 如果状态应在不同 repository 或子目录中工作，请设置这里。
   */
  cwd?: string;
  /**
   * 此子 Agent 的精确 model，可以是 shorthand（例如 "opus-5.5"）或 provider:modelId。
   * 未设置时继承 parent runner 的 model。它有意不暴露给 create_state_machine_definition 或
   * select_state_machine_state 的 override：编排模型不知道可用 model catalog，不应自行选择 model。
   * 此值由 UI 设置，UI 可以展示真实 model 列表。未知值会像错误的 CLI --model 一样在
   * resolveModelName 处失败。
   */
  model?: string;
  /**
   * 此子 Agent 的 reasoning effort。与 `model` 采用相同的 UI-only 契约：不出现在工具 schema 中，
   * 因此编排模型无法设置它，由 UI 写入。未设置时继承 parent runner 的 thinking level。
   */
  thinkingLevel?: ThinkingLevel;
  /**
   * 此子 Agent 是否从 parent runner 对话上下文的副本开始，而不是使用全新的空 transcript。
   *
   * `false`（默认，也是历史行为）时，子 Agent 只看到本状态渲染后的 `prompt`、worker identity
   * system-prompt 层和传入的转换 `input`。适合范围明确、自包含的任务，此时清晰的 prompt 已足够，
   * 既有上下文反而会分散注意力或造成偏置。
   *
   * `true` 时，runner 用 parent runner 完整上下文的逐字副本为子 Agent 提供历史，包括 parent
   * system prompt 和 message history，使子 Agent 继承此前讨论、决定、约束和工具 history。为
   * 控制成本，fork 保留 parent 的精确缓存前缀（相同 system prompt 和前导 messages），所有
   * 状态专属内容——worker identity 层、该状态的 `systemPrompt` 和自身 `prompt`——作为唯一
   * 未缓存的新尾部 user turn 发送。任务依赖先前 thread 决定或用户偏好，且通过状态 prompt
   * 重述会繁琐或有损时，才使用它。
   *
   * fork transcript 是临时的：不会写入状态机 Session history（只写入状态的紧凑最终输出），
   * 因此 fork 不会让 durable Session 膨胀。
   */
  forkContext?: boolean;
}

/** 运行 shell command；这是通用的集成原语。 */
export interface StateMachineScriptState extends StateMachineBaseState {
  kind: "script";
  /**
   * 用于集成、初始化、清理和确定性检查的 shell command。runner 使用转换 input 将它渲染为
   * 模板；状态机 definition 应保持可序列化，不要在这里存储可执行函数。
   */
  command: string;
  /** command 的工作目录；默认使用状态机 Session cwd。 */
  cwd?: string;
  /** command 超过此运行时会被终止。 */
  timeoutMs?: number;
  /** 被视为成功的退出码，默认为 [0]。 */
  successCodes?: number[];
}

/** 执行一次外部检查，然后记录数据或睡眠到下一次尝试。 */
export interface StateMachinePollState extends StateMachineBaseState {
  kind: "poll";
  /**
   * 下一次外部检查尝试之间的重复等待时间。接受 `ms` package 解析的人类可读时长字符串
   *（例如 `"30s"`、`"15m"`、`"3h"`、`"5d"`），也接受原始毫秒数。
   */
  intervalMs: number | string;
  /** 状态机在此 poll 状态中最多保持多久，超时后 Session 失败。 */
  timeoutMs?: number;
  /**
   * 每次 poll 尝试运行一次。script 以 `successCodes` 中的退出码表示“发现结果”；其他退出码
   * 视为“继续 polling”，runner 会在 `intervalMs` 后 sleep 再尝试。stdout 会被捕获并作为
   * 状态输出暴露（可行时也解析为 JSON），但解析结果不会影响 poll 是否完成——只有退出码决定。
   */
  command: string;
  /** command 的工作目录；默认使用状态机 Session cwd。 */
  cwd?: string;
  /** 表示此次 poll 发现结果的退出码，默认为 [0]。 */
  successCodes?: number[];
}

/** 睡眠到未来某个时间，然后让 parent 选择下一状态。 */
export interface StateMachineTimerState extends StateMachineBaseState {
  kind: "timer";
  /**
   * 此 timer 状态完成的绝对时间。接受 ISO 8601 日期字符串（例如 `"2026-05-24T18:00:00Z"`）
   * 或 Unix epoch 毫秒数。与 `wakeAfterMs` 互斥，二者必须且只能设置一个。
   */
  wakeAt?: number | string;
  /**
   * 从 parent 选择此 timer 状态的时刻开始计算的相对时长，经过后 timer 完成。接受由 `ms`
   * package 解析的人类可读时长字符串（例如 `"3h"`、`"5d"`）或原始毫秒数。当等待长度
   * 预先已知但绝对 wake 时间未知时很有用（例如可复用 definition，或由 parent 在选择时决定
   * 开始时间的转换）。与 `wakeAt` 互斥。
   */
  wakeAfterMs?: number | string;
}

/** 进入后让机器停放，不执行工作，也不安排 wake，由 parent 驱动。 */
export interface StateMachineParkState extends StateMachineBaseState {
  kind: "park";
}

/** 到达后结束 Session。终态结果本身也是状态机状态。 */
export interface StateMachineTerminalState extends StateMachineBaseState {
  kind: "terminal";
  /** 将此命名结果映射到 Session lifecycle status。 */
  status: "completed" | "failed" | "cancelled";
  /** 展示给用户并记录到 history 的可选最终说明。 */
  reason?: string;
}

export interface StateMachineTerminalResult {
  /**
   * 使 Session 结束的终态名称。发生 runtime failure 时，这是出错的状态（poll/agent/script），
   * 而不是 definition 中的 terminal state。
   */
  state: string;
  /**
   * Session 的最终 lifecycle status。`completed`/`failed`/`cancelled` 来自 Agent 有意选择的
   * terminal state。`error` 仅供 runtime 使用：它永远不是用户编写的 terminal status（Agent
   * 不能选择它），只在机器崩溃时由 runner 设置——包括 poll timeout、未知/无效选择的状态、
   * agent/script 状态失败、配置错误的 poll gate 或 protocol-violation 重试耗尽。只有 `error`
   * 结果会使 turn 失败；其他三个是成功的 turn 结果，其含义由 `state`/`reason` 表达。
   */
  status: StateMachineTerminalState["status"] | "error";
  /** 可选最终说明，通常由 runner 生成。 */
  reason?: string;
}

/** executor 构造但尚未启动的即时工作证据，范围受限。 */
export interface StateMachineExecutionReceipt {
  /** accepted decision 与实际启动共享的 task identity。 */
  id: string;
  state: string;
  kind: "agent" | "script";
  /** canonical effective work（不含 task identity 和 timing）的 SHA-256。 */
  fingerprint: string;
  /** 构造 worker tools 或 shell 时使用的绝对工作目录。 */
  cwd: string;
  forkContext: boolean;
  /** 提供的顶层 input key；仅有 key 不代表它们已传递给 worker。 */
  suppliedInputKeys: string[];
  /** prompt/command 模板引用的顶层 input key。 */
  renderedInputKeys: string[];
  /** 此次选择是否将 override 持久化到 definition。 */
  persistOverride: boolean;
  /** 有界的实际 prompt 或 command；fingerprint 覆盖完整工作。 */
  preview: string;
  previewTruncated: boolean;
  /** forked worker 实际继承的 context digest。 */
  inheritedContextHash?: string;
  /** effective work 相同的情况下，此状态最近一次 settled execution。 */
  unchangedFrom?: { id: string; outcome: "completed" | "failed" | "interrupted" };
}

export type StateMachineSessionEvent =
  | { type: "state_machine_started"; timestamp: number }
  | {
      type: "runner_decided";
      timestamp: number;
      decision: unknown;
      execution?: StateMachineExecutionReceipt;
    }
  | {
      type: "state_started";
      /** 只有即时工作构造完成且 task 被接纳后存在。 */
      execution?: StateMachineExecutionReceipt;
      timestamp: number;
      state: string;
      input?: Record<string, unknown>;
    }
  | { type: "state_completed"; timestamp: number; state: string; output?: unknown }
  | { type: "state_failed"; timestamp: number; state: string; error: string }
  | {
      type: "state_interrupted";
      timestamp: number;
      state: string;
      reason?: string;
      output?: { assistantText?: string } | { stdout: string; stderr: string };
    }
  | {
      // select_state_machine_state 持久化 override 到活动 definition 时发送
      //（decision.persistOverride !== false）。记录合并后的 state，使 replay history 的人可以看到
      // definition 何时、如何偏离原始 create_state_machine_definition 形状。
      type: "state_definition_updated";
      timestamp: number;
      state: string;
      updatedState: StateMachineState;
    }
  | { type: "state_machine_completed"; timestamp: number; terminal: StateMachineTerminalResult }
  | {
      // 已完成 Session 恢复时记录（何时合法见 recordStateMachineReactivated）。`state` 是恢复状态
      // 的名称；`priorTerminal` 保留被清除的结果，使 replay 仍显示 completed→running 转换。
      type: "state_machine_reactivated";
      timestamp: number;
      state: string;
      priorTerminal: StateMachineTerminalResult;
    };
