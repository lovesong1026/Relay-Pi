import type {
  ModelUsageEntry,
  TurnEvent,
  TurnTerminalEvent,
  TurnTokenUsage,
} from "../../../src/types/protocol.js";

export type AdvisorCallOutcome = "success" | "rate_limited" | "unavailable" | "failed";

/** 从较新的 advisor 结果中结构化解析的 request-window 元数据。 */
export interface AdvisorContextObservation {
  /** advisor model 声明的输入加输出上下文窗口。 */
  contextWindowTokens: number;
  /** 在适配 executor context 前预留的输出额度。 */
  reservedOutputTokens: number;
  /** 为 provider tokenizer 和请求封装差异保留的保守余量。 */
  safetyMarginTokens: number;
  /** 扣除 system 和 output 预留后的最大 executor context 估计值。 */
  inputLimitTokens: number;
  /** 当前产品 context policy 下建议的 advisor 总输入。 */
  inputTargetTokens?: number;
  /** 估计的 advisor 总输入，包括共享的每张图像费用。 */
  estimatedInputTokens: number;
  /** advisor 请求中保留的 executor 消息。 */
  includedMessages: number;
  /** 通过观察式上下文表示的原始 executor 消息。 */
  compactedMessages?: number;
  /** 在整条消息边界被省略的最早 executor 消息。 */
  omittedMessages: number;
  /** 真实 advisor 模型窗口强制省略消息时为 true。 */
  truncated: boolean;
  /** 作为多模态请求部分转发的 executor 图像。 */
  attachedImages: number;
}

/** 位于 parent Agent 规范 step 序列中的一次 advisor attempt。 */
export interface AdvisorCallObservation {
  /** 移除流式增量和临时工具启动后的从 1 开始的索引。 */
  step: number;
  outcome: AdvisorCallOutcome;
  /** 只有成功咨询后才可用的具体 provider model。 */
  model?: string;
  /** 区分旧版/缺失元数据、格式错误元数据和已验证的观察记录。 */
  contextStatus: "valid" | "missing" | "malformed";
  /** 仅当每个 context-fidelity 字段都按要求的基本类型解析时存在。 */
  context?: AdvisorContextObservation;
  /**
   * 如果能观察到明确的 repository `edit` 或 `write`，这里记录相对位置。
   * `unknown` 不代表没有发生修改，因为 shell 命令是不透明的。
   */
  relativeToFirstExplicitRepositoryMutation: "before" | "after" | "unknown";
}

/** 从通用 tool-result details 中观察到的 advisor 工具结果。 */
export interface AdvisorCallTelemetry {
  /** 所有观察到的 `ask_advisor` 工具完成，包括非咨询结果。 */
  total: number;
  /** 返回命名具体 model 提供建议的调用。 */
  success: number;
  /** 被产品 cadence gate 拒绝的调用。 */
  rateLimited: number;
  /** 没有可用 advisor route 时发出的调用。 */
  unavailable: number;
  /** 没有返回可用建议的工具错误或格式错误结果。 */
  failed: number;
  /** 按工具报告的具体 model 对成功 advisor 调用分组。 */
  successByModel: Record<string, number>;
  /**
   * 第一个明确的 repository `edit` 或 `write`；无法观察到时为 null。
   * 不会臆测 shell 命令是只读还是会修改。
   */
  firstExplicitRepositoryMutationStep: number | null;
  /** Ordered call-level evidence used for attribution and context-fidelity admission. */
  attempts: AdvisorCallObservation[];
}

/** 仅根据原始 RPC 事件流重新推导的基准测试指标。 */
export interface RolloutTelemetry {
  /** 持久化 `telemetry.json` 契约的版本。 */
  schemaVersion: 3;
  costUsdTotal: number;
  /** 按具体 model id 分组的 provider 支出，不推断运行时角色。 */
  costUsdByModel: Record<string, number>;
  tokens: Pick<TurnTokenUsage, "input" | "output" | "cacheRead" | "cacheWrite" | "totalTokens">;
  /** 为下游精确分析保留的最新累计 per-model ledger。 */
  usageByModel: ModelUsageEntry[];
  advisorCalls: AdvisorCallTelemetry;
  routerSwitches: Record<string, number>;
  /** 规范的 parent step 事件，不包含流式增量和 subagent 来源的 step。 */
  steps: number;
  terminalStatus:
    | "completed"
    | "failed"
    | "cancelled"
    | "ask"
    | "interrupted"
    | "sleep"
    | "missing";
}

/** Derive all campaign telemetry from a raw, append-only RPC event ledger. */
export function deriveTelemetry(events: readonly TurnEvent[]): RolloutTelemetry {
  let latestUsage: Pick<TurnTokenUsageHolder, "turnUsage" | "usageByModel"> | undefined;
  let terminal: TurnTerminalEvent | undefined;
  let steps = 0;
  const advisorCalls: AdvisorCallTelemetry = {
    total: 0,
    success: 0,
    rateLimited: 0,
    unavailable: 0,
    failed: 0,
    successByModel: {},
    firstExplicitRepositoryMutationStep: null,
    attempts: [],
  };
  const routerSwitches: Record<string, number> = {};

  for (const event of events) {
    const loose = event as TurnEvent & Partial<TurnTokenUsageHolder>;
    if (loose.turnUsage && Array.isArray(loose.usageByModel)) {
      latestUsage = { turnUsage: loose.turnUsage, usageByModel: loose.usageByModel };
    }

    if (isTerminal(event)) terminal ??= event;

    if (event.type === "router_switch") {
      increment(routerSwitches, `${event.fromModel}→${event.toModel}`);
    }

    if (event.type !== "step" || event.origin) continue;
    if (
      event.step.type === "text_delta" ||
      event.step.type === "reasoning_delta" ||
      event.step.type === "tool_call_start"
    ) {
      continue;
    }
    steps += 1;
    if (
      advisorCalls.firstExplicitRepositoryMutationStep === null &&
      event.step.type === "tool_call" &&
      !event.step.isError &&
      isExplicitRepositoryMutation(event.step.toolName, event.step.input)
    ) {
      advisorCalls.firstExplicitRepositoryMutationStep = steps;
    }
    if (event.step.type !== "tool_call" || event.step.toolName !== "ask_advisor") continue;

    const details = asAdvisorDetails(event.step.details);
    advisorCalls.total += 1;
    let outcome: AdvisorCallOutcome;
    if (details?.rateLimited) {
      outcome = "rate_limited";
      advisorCalls.rateLimited += 1;
    } else if (details?.unavailable) {
      outcome = "unavailable";
      advisorCalls.unavailable += 1;
    } else if (event.step.isError || !details?.model) {
      outcome = "failed";
      advisorCalls.failed += 1;
    } else {
      outcome = "success";
      advisorCalls.success += 1;
      increment(advisorCalls.successByModel, details.model);
    }
    advisorCalls.attempts.push({
      step: steps,
      outcome,
      ...(details?.model ? { model: details.model } : {}),
      contextStatus: details?.contextStatus ?? "missing",
      ...(details?.context ? { context: details.context } : {}),
      relativeToFirstExplicitRepositoryMutation: "unknown",
    });
  }

  for (const attempt of advisorCalls.attempts) {
    attempt.relativeToFirstExplicitRepositoryMutation =
      advisorCalls.firstExplicitRepositoryMutationStep === null
        ? "unknown"
        : attempt.step < advisorCalls.firstExplicitRepositoryMutationStep
          ? "before"
          : "after";
  }

  const usage = latestUsage?.turnUsage ?? emptyUsage();
  const usageByModel = latestUsage?.usageByModel ?? [];
  const costUsdByModel: Record<string, number> = {};
  for (const entry of usageByModel) increment(costUsdByModel, entry.model, entry.usage.cost.total);
  return {
    schemaVersion: 3,
    costUsdTotal: usage.cost.total,
    costUsdByModel,
    tokens: {
      input: usage.input,
      output: usage.output,
      cacheRead: usage.cacheRead,
      cacheWrite: usage.cacheWrite,
      totalTokens: usage.totalTokens,
    },
    usageByModel,
    advisorCalls,
    routerSwitches,
    steps,
    terminalStatus: terminalStatus(terminal),
  };
}

/** 在 report 代码消费前升级持久化 telemetry。v2 没有记录 advisor 请求安全余量，
 * 因此该 schema 中原本成功的 context 观察会保留为格式错误证据，
 * 而不会被渲染成满足当前 fidelity 契约的记录。 */
export function normalizePersistedTelemetry(value: unknown): RolloutTelemetry {
  if (!value || typeof value !== "object") throw new Error("Malformed rollout telemetry.");
  const persisted = value as Omit<RolloutTelemetry, "schemaVersion"> & {
    schemaVersion: number;
  };
  if (persisted.schemaVersion !== 2 && persisted.schemaVersion !== 3) {
    throw new Error(`Unsupported rollout telemetry schemaVersion: ${persisted.schemaVersion}.`);
  }

  const attempts = persisted.advisorCalls.attempts.map((attempt) => {
    const context = attempt.context as Partial<AdvisorContextObservation> | undefined;
    if (
      attempt.contextStatus !== "valid" ||
      (context &&
        Number.isInteger(context.safetyMarginTokens) &&
        (context.safetyMarginTokens ?? -1) >= 0)
    ) {
      return attempt;
    }
    const { context: omittedContext, ...withoutContext } = attempt;
    void omittedContext;
    return { ...withoutContext, contextStatus: "malformed" as const };
  });

  return {
    ...persisted,
    schemaVersion: 3,
    advisorCalls: { ...persisted.advisorCalls, attempts },
  };
}

interface TurnTokenUsageHolder {
  turnUsage: TurnTokenUsage;
  usageByModel: ModelUsageEntry[];
}

interface AdvisorDetails {
  type: "ask_advisor";
  model?: string;
  rateLimited?: boolean;
  unavailable?: boolean;
  contextStatus: "valid" | "missing" | "malformed";
  context?: AdvisorContextObservation;
}

function asAdvisorDetails(value: unknown): AdvisorDetails | undefined {
  if (!value || typeof value !== "object") return undefined;
  const details = value as Record<string, unknown>;
  if (details.type !== "ask_advisor") return undefined;
  const context = asAdvisorContext(details.context);
  return {
    type: "ask_advisor",
    ...(typeof details.model === "string" ? { model: details.model } : {}),
    ...(details.rateLimited === true ? { rateLimited: true } : {}),
    ...(details.unavailable === true ? { unavailable: true } : {}),
    contextStatus: details.context === undefined ? "missing" : context ? "valid" : "malformed",
    ...(context ? { context } : {}),
  };
}

function asAdvisorContext(value: unknown): AdvisorContextObservation | undefined {
  if (!value || typeof value !== "object") return undefined;
  const context = value as Record<string, unknown>;
  const contextWindowTokens = positiveInteger(context.contextWindowTokens);
  const reservedOutputTokens = nonnegativeInteger(context.reservedOutputTokens);
  const safetyMarginTokens = nonnegativeInteger(context.safetyMarginTokens);
  const inputLimitTokens = positiveInteger(context.inputLimitTokens);
  const inputTargetTokens = positiveInteger(context.inputTargetTokens);
  const estimatedInputTokens = positiveInteger(context.estimatedInputTokens);
  const includedMessages = nonnegativeInteger(context.includedMessages);
  const compactedMessages = nonnegativeInteger(context.compactedMessages);
  const omittedMessages = nonnegativeInteger(context.omittedMessages);
  const attachedImages = nonnegativeInteger(context.attachedImages);
  if (
    contextWindowTokens === undefined ||
    reservedOutputTokens === undefined ||
    safetyMarginTokens === undefined ||
    inputLimitTokens === undefined ||
    estimatedInputTokens === undefined ||
    includedMessages === undefined ||
    omittedMessages === undefined ||
    attachedImages === undefined ||
    typeof context.truncated !== "boolean"
  ) {
    return undefined;
  }
  return {
    contextWindowTokens,
    reservedOutputTokens,
    safetyMarginTokens,
    inputLimitTokens,
    ...(inputTargetTokens !== undefined ? { inputTargetTokens } : {}),
    estimatedInputTokens,
    includedMessages,
    ...(compactedMessages !== undefined ? { compactedMessages } : {}),
    omittedMessages,
    truncated: context.truncated,
    attachedImages,
  };
}

function nonnegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function isExplicitRepositoryMutation(
  toolName: string,
  input: Record<string, unknown> | undefined,
): boolean {
  if (toolName !== "edit" && toolName !== "write") return false;
  const path = input?.path;
  if (typeof path !== "string") return false;
  return !path.startsWith("/") || path === "/testbed" || path.startsWith("/testbed/");
}

function isTerminal(event: TurnEvent): event is TurnTerminalEvent {
  return (
    event.type === "complete" ||
    event.type === "ask" ||
    event.type === "interrupted" ||
    event.type === "sleep"
  );
}

function terminalStatus(
  terminal: TurnTerminalEvent | undefined,
): RolloutTelemetry["terminalStatus"] {
  if (!terminal) return "missing";
  if (terminal.type === "complete") return terminal.status;
  return terminal.type;
}

function increment(counts: Record<string, number>, key: string, amount = 1): void {
  counts[key] = (counts[key] ?? 0) + amount;
}

function emptyUsage(): TurnTokenUsage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}
