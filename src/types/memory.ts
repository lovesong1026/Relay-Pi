/** 用于召回排序和 prompt 渲染的相对重要性。 */
export type ObservationPriority = "high" | "medium" | "low";

/**
 * 行是原始 observation、由 reflector 合成的 reflection、用户单独添加的 `note`，还是批量整理
 * 的 `manual` corpus 行。默认情况下，reflection 的排名高于原始 observation（见
 * `reflectionBias`），因为它们是经过整理阶段保留下来的跨 observation 浓缩摘要；全局
 * 预算收紧时，loader 会优先保留它们。
 *
 * `manual` 行是批量整理的语料合成结果（例如 `relay-pi train`）：通过 `manualBias` 排名
 * 远高于其他内容，并且不会被 reflect prune 压缩。`note` 行是用户单独添加的记忆
 *（`relay-pi memory add`）：只在 reflection 之上获得小幅 `noteBias` 提升，仍符合
 * reflect prune 条件，因此快速记录会像其他 observation 一样随时间老化并折叠，不会永久固定。
 */
export type ObservationKind = "observation" | "reflection" | "manual" | "note";

/**
 * observation 的来源。用于审计和下游过滤。工具来源以 `tool:<name>` 写入 `tags`，而不是
 * 增加单独的 variant——这样 source enum 保持封闭，同时可以通过现有 tag 轴搜索工具归属。
 *
 * - `user`：操作员编写的记忆（例如 `relay-pi memory add`）。
 * - `agent`：Agent 在 turn 中产生；`name` 可选。
 * - `system`：系统合成，包括训练来源（`relay-pi train`）——不存在单独的 `train` kind。
 * - `api`：通过调用方拥有的 API/gateway 以程序方式写入。
 * - `import`：从外部记忆行的批量导入带入。
 */
export type ObservationSource =
  | { kind: "user" }
  /** 由 Agent 产生；名称可选，因为 runner 不会分配 Agent id。 */
  | { kind: "agent"; name?: string }
  | { kind: "system" }
  | { kind: "api" }
  | { kind: "import" };

/** 将持久化记忆渲染回模型上下文（发生原始消息压缩后）。 */
export interface Observation {
  /** observation 行稳定的持久化 key。 */
  id: string;
  /** 此 observation 保存时的 Unix 毫秒时间戳。 */
  createdAt: number;
  /**
   * 实际使用此 observation 的最近一次 turn 的 Unix 毫秒时间戳。初始值为 `createdAt`；
   * 当 observer 报告某行影响了 assistant 响应（`usedObservationIds`）时推进。它驱动
   * 全局层的排名衰减，使持续被使用的记忆即使原本很旧也会继续出现。
   */
  lastUsedAt: number;
  /**
   * 产生此 observation 的 Session。只有早于 sessionId 跟踪的旧行可以省略；新写入始终会设置。
   * loader 以此作为 local/global 轴：sessionId 匹配当前 runner 的行属于 local（始终渲染），
   * 其他行属于 global（按固定 token 预算排序）。
   */
  sessionId?: string;
  /**
   * 此行是 raw observation、reflection、note 还是 manual corpus 行。reflector 会把一批
   * observation 替换为一条浓缩 reflection；下游排序会给 reflection 一个乘数
   *（`reflectionBias`），给 note 稍大的乘数（`noteBias`），给 manual corpus 行最大的乘数
   *（`manualBias`），以匹配它们更高的单位 token 信号量。
   */
  kind: ObservationKind;
  /** 通常是 observation 发生当天、该 observation 所锚定的日历日期。 */
  observedDate: string;
  /** 用户或工具输出提到的、不同于 observedDate 的具体日期。 */
  referencedDate?: string;
  /** 有用时保留的原始相对日期短语，例如 "tomorrow" 或 "last week"。 */
  relativeDate?: string;
  /** 可用时附加到 observation 的 24 小时制本地时间。 */
  timeOfDay?: string;
  /** recall 和上下文渲染使用的重要性信号。 */
  priority: ObservationPriority;
  /** 用于调试、过滤和未来信任策略的 observation 来源。 */
  source: ObservationSource;
  /** 可以渲染回模型上下文的实际记忆文本。 */
  content: string;
  /** 用于过滤、分组和持久化查询的轻量标签。 */
  tags: string[];
}

/** 在 runner state 之外持久化的完整 durable memory 视图。 */
export interface ObservationalMemorySnapshot {
  /** 当前由 runner memory store 持有的所有 durable observations。 */
  observations: Observation[];
  /** 用于决定何时执行 observation/reflection 的近似 token 数。 */
  estimatedTokens: {
    /** 所有 observation 内容的近似 token 数。 */
    observations: number;
  };
  /** 生成此 snapshot 时的 Unix 毫秒时间戳。 */
  updatedAt: number;
}

/** observation memory 在 turn 中运行时发出的进度/结果更新。 */
export interface ObservationalMemoryActivityEvent {
  /** 当前正在处理最新 pi-agent transcript 边界的 memory 操作。 */
  phase: "observation" | "reflection";
  /** 操作仍在运行还是已经结束。 */
  status: "running" | "completed";
  /** 适合 CLI/TUI 展示的可读状态。 */
  message: string;
  /** 已完成的 memory 操作生成或替换的 durable observations。 */
  observations?: Observation[];
  /**
   * observer 将最新 exchange 归因给此前使用过的 global-pack memory 后，推进其 `lastUsedAt` 的
   * 旧 global-pack memory。只在 `observation` 阶段的完成事件中设置，此时会执行使用归因。
   * 空值/undefined 表示本 turn 没有复用旧 memory。携带完整 observation 行（而不只是 id），
   * 使界面无需再次查询数据库即可直接渲染复用内容。
   */
  usageBumpedObservations?: Observation[];
}

/**
 * observation pipeline 使用的完整解析后 memory 设置。
 *
 * 所有数值 token 预算都会由 `TurnRunnerConfig.effectiveContext` 在
 * `src/memory/observational.ts` 的 `deriveMemoryBudgets` 中一次性派生，再与用户可设置的
 * 非预算选项通过 `resolveObservationalMemorySettings` 合并。派生表见 `MEMORY_BUDGET_RATIOS`。
 */
export interface ObservationalMemorySettings {
  /** 从原始 Agent 消息中提取新 observation 的设置。 */
  observation: {
    /**
     * 派生值。每 turn 触发通过 wire-shaping horizon 替换旧 transcript 内容的原始消息 token
     * 阈值；即 `0.60 * effectiveContext`。
     */
    messageTokens: number;
    /**
     * 派生值（固定常量）。一次 observer 调用发送的原始 transcript token 上限。每次 observer
     * 调用前，runner 会从最旧端开始裁剪未观察尾部到此大小，因此即使连续多个
     * `hasMemory=false` turn 让尾部增长，observer prompt 也不会超过 memory model 的硬窗口。
     * 边界消息会部分保留（切 head、保留 tail），而不是整条丢弃。它独立于
     * `effectiveContext`，因为上限取决于 memory model 的窗口，而不是 actor 的预算。
     */
    maxTranscriptTokens: number;
    /**
     * 派生值（固定常量）。observer 单次调用被要求生成的 observation log 上限。它同时驱动
     * observer prompt 中渲染的软预算，以及 `enforceObservationTokenBudget` 强制执行的
     * 硬重试/最终裁剪阈值。独立于 `effectiveContext`。
     */
    maxObservationLogTokens: number;
    /**
     * 派生值。wire-shaping horizon 推进后的原始尾部 token 目标。
     * `OBSERVATION_BUFFER_RATIO * messageTokens`。由于它的上限已经包含在 messageTokens 中，
     * 不计入 `effectiveContext`。
     */
    bufferActivation: number;
    /**
     * 派生值（固定常量）。observer prompt 中用于去重上下文的 previous observations 预算。
     * 仅供 observer 使用，永远不会进入 actor 的上下文窗口。
     */
    previousObserverTokens: number;
    /** 追加到相应 memory system prompt 的额外指令。 */
    instruction?: string;
    /** observer 是否同时生成简短的 thread 标题。 */
    threadTitle?: boolean;
  };
  /** 用于压缩 durable observation log 的设置。 */
  reflection: {
    /**
     * 派生值。reflection 之间的本地记忆 token 上限；当前 Session 的 observations 超过此值
     * 后触发 reflection。即 `0.325 * effectiveContext`。
     */
    observationTokens: number;
    /**
     * 派生值。reflection event 后的本地记忆 token 目标。
     * `REFLECTION_BUFFER_RATIO * observationTokens`（触发值的 40%）。由于上限不超过
     * observationTokens，不计入 `effectiveContext`。
     */
    bufferActivation: number;
    /** 追加到 reflector system prompt 的额外指令。 */
    instruction?: string;
  };
  /**
   * 固定上限。渲染在当前 Session 压缩视图之前的 global memory 层 token 预算。
   * cross-session reflection 和 observation 按 `priority * usageDecay * kindBias` 排序，
   * 并贪心装入直到预算耗尽。保持固定值（当前 8k 的 `GLOBAL_CONTEXT_TOKEN_BUDGET`），
   * 而不随 `effectiveContext` 缩放，避免更大的 model window 让渲染前缀膨胀——较久远的
   * reflection 仍可通过 `recall_memory` 工具访问。
   */
  globalContextTokenBudget: number;
  /**
   * global-layer 排名中应用于 `lastUsedAt` 时间的 half-life。
   * `usageDecay = 0.5 ^ ((now - lastUsedAt) / halfLifeMs)`——距离上次使用一个 half-life 后，
   * 一行同等 priority 的价值是刚使用行的一半。默认 7 天：足够短，使一个月前未使用的
   * 闲聊不再挤出本周决定；又足够长，使昨天的结论明天仍能出现。排名是 `lastUsedAt` 的
   * 单调函数，因此单次排名过程中任意两行的顺序不受 `now` 影响——loader 利用这一点
   * 将完整 ORDER BY 下推到 SQL。
   */
  recencyHalfLifeMs: number;
  /**
   * 当行是 reflection 而不是原始 observation 时应用的分数乘数。默认 1.3，使相同
   * priority/recency 下 reflection 优先，但不会完全排除原始 observation。
   */
  reflectionBias: number;
  /**
   * 当 `kind === 'manual'` 时应用于行分数的乘数，作用类似 `reflectionBias`。默认 100
   *（见 DEFAULT_MANUAL_BIAS），使整理后的行位于 global pack 顶部——`ln(100) ≈ 4.6`，
   * 相当于默认 half-life 下约 32 天的 recency 领先。
   */
  manualBias: number;
  /**
   * 当 `kind === 'note'`（一条 `relay-pi memory add` 记录）时应用于行分数的乘数。默认 1.5：
   * 只比 reflection 略高，使用户确认过的 note 能胜过自动合成行；远低于 `manualBias`，
   * 因此不会像 train corpus 一样支配整个 pack。
   */
  noteBias: number;
  /** 是否启用 recall_memory 工具和 embedding backfill。 */
  retrieval: boolean;
}

/**
 * 调用方提供的 memory 设置。只有非预算选项可由用户设置：所有数值 token 预算都从
 * `TurnRunnerConfig.effectiveContext` 派生，不能单独固定。
 */
export interface ObservationalMemorySettingsInput {
  observation?: {
    /** 追加到相应 memory system prompt 的额外指令。 */
    instruction?: string;
    /** observer 是否同时生成简短的 thread 标题。 */
    threadTitle?: boolean;
  };
  reflection?: {
    /** 追加到 reflector system prompt 的额外指令。 */
    instruction?: string;
  };
  /** global-layer recency decay 的 half-life；见 `ObservationalMemorySettings.recencyHalfLifeMs`。 */
  recencyHalfLifeMs?: number;
  /** reflection 相对于 observation 的分数乘数；见 `ObservationalMemorySettings.reflectionBias`。 */
  reflectionBias?: number;
  /** manual 行分数乘数；见 `ObservationalMemorySettings.manualBias`。 */
  manualBias?: number;
  /** note 行分数乘数；见 `ObservationalMemorySettings.noteBias`。 */
  noteBias?: number;
  /** 是否启用 recall_memory 工具和 embedding backfill。 */
  retrieval?: boolean;
}
