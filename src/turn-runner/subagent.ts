import type { ScopeId, TaskId } from "../tasks/types.js";
import type { Agent, AgentEvent, AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import type { ThinkingLevel, Usage } from "@earendil-works/pi-ai";
import type { Skill } from "@earendil-works/pi-coding-agent";
import { assistantText } from "../core/serializer.js";
import {
  classifyRoute,
  type ClassifierDecision,
  type ClassifyRouteOptions,
} from "../model-routing/classifier.js";
import {
  resolveRoute,
  type RouteResolutionCatalog,
  type ResolvedTarget,
} from "../model-routing/resolve.js";
import type { RoutingTable } from "../model-routing/table.js";
import type { TurnEventOrigin, TurnOptions, TurnState, TurnTokenUsage } from "../types/protocol.js";
import type { StateMachineDefinition } from "../types/state-machine.js";
import type { TransportName } from "../model-resolution/catalog.js";
import { createForkContextReminder, createStateAgentSystemPromptLayer } from "./prompts.js";
import { isExternallyVisibleAgentEvent } from "./agent-events.js";
import { isPostOutputConnectedFailure } from "../connected-providers/fallback.js";
import type { TurnRunnerControlResult } from "./tools.js";
import { usageFromMessages } from "./usage-accounting.js";

/** 共享子 Agent executor 接受的完整内部描述。 */
export interface SubagentSpec {
  /** 定义子 Agent 完整任务的用户 prompt。 */
  prompt: string;
  /** 仅应用于此子 Agent 的可选角色或行为层。 */
  systemPrompt?: string;
  /** 子 Agent 可以使用的 skill 名称；省略时继承可用 skill 集合。 */
  allowedSkills?: string[];
  /** 子 Agent 编程工具使用的工作目录。 */
  cwd?: string;
  /** 此子 Agent 使用的精确或虚拟 model 设置。 */
  model?: string;
  /** 应用于子 Agent model 的推理强度。 */
  thinkingLevel?: ThinkingLevel;
  /** 是否使用父 Agent 当前的 transcript 初始化子 Agent。 */
  forkContext?: boolean;
}

/** prompt 运行一次后由子 Agent 所属者消费的终态结果。 */
export type SubagentResult =
  | { type: "complete"; result?: string }
  | { type: "failed"; error: string }
  | { type: "interrupted" };

/** 在 skill 和 context 展开之后，从实际构造的 worker 捕获的内容。 */
export interface PreparedSubagentExecution {
  prompt: string;
  systemPrompt: string;
  model: string;
  thinkingLevel?: string;
  inheritedContext?: { systemPrompt?: string; messages: AgentMessage[] };
}

/** 由 {@link SubagentSpec} 创建的一次进行中的 execution。 */
export interface SubagentRun {
  /** 在不构造实际 model worker 的测试 executor 中不存在。 */
  prepared?: PreparedSubagentExecution;
  /** 使用 executor 所有的 prompt 和 transcript 启动子 Agent。 */
  prompt(): Promise<SubagentResult>;
  /** 中止子 Agent，并使其 prompt 以 interrupted 结束。 */
  interrupt(reason: string): void;
  /** 纯文本的部分输出，不包括 fork 的 seed transcript。 */
  partialAssistantText(): string | undefined;
  /** 传给 interrupt 的原因；未中断时为 undefined。 */
  interruptedReason(): string | undefined;
}

export interface SubagentAgentConfigInput {
  /** 包含已解析选项和 seed 消息的临时子回合 state。 */
  state: TurnState;
  /** 对于全新的子 Agent，置于宿主系统指令之前的身份层。 */
  prependSystemPrompt?: string;
  /** 仅应用于每个子 Agent、置于宿主系统指令之后的角色层。 */
  appendSystemPrompt?: string;
  /** 不受限制的 context fork 逐字复用的完整渲染系统 prompt。 */
  systemPrompt?: string;
  /** 渲染进子 Agent 系统 prompt 的 skill；undefined 表示不受限制。 */
  skills?: Skill[];
  /** 绑定到子 Agent 工作目录和权限的运行时工具。 */
  tools: AgentTool[];
  /** 仅限子 Agent 的 memory identity 和 wire horizon；省略时使用父 runtime。 */
  memoryContext?: SubagentMemoryContext;
}

/** 子 Agent 本地的 memory identity 和可变 wire-shaping state。 */
export interface SubagentMemoryContext {
  /** 从父 Session 和 task ID 派生的持久 scratch 命名空间。 */
  sessionId?: string;
  /** 仅由此子 Agent 的 context transform 修改的 horizon。 */
  horizon: import("../types/protocol.js").WireGuardHorizon;
}

interface SubagentMachineContext {
  definition: StateMachineDefinition;
  currentState: string;
}

export interface SubagentExecutionContext {
  /** 附加到每个流式子 Agent 事件和用量 tick 的来源。 */
  origin: TurnEventOrigin;
  /** 用于将 state worker 限制在分配给它的 state 内的 active relay definition。 */
  machineContext?: SubagentMachineContext;
  /** 由生成的子 Agent 所属的 scope；关闭时其嵌套 task 会级联停止。 */
  childScopeId?: `task:${TaskId}`;
  /** 拥有 spawn task 且是 childScopeId 父级的 scope。 */
  ownerScopeId?: ScopeId;
  /** 此子 Agent 隔离的 observational-memory identity 和 horizon。 */
  memoryContext?: SubagentMemoryContext;
  /** 调用 spawn_agent 的 Agent 的 transcript 来源。 */
  forkSource?: {
    messages(): AgentMessage[];
    systemPrompt(): string | undefined;
  };
  /** 构造后为递归生成的 fork 发布的运行时 Agent。 */
  agent?: Agent;
}

export interface SubagentExecutorDeps {
  /** 在 executor 解析 model、prompt、skill 和 tool 后构造 pi Agent。 */
  createAgent(
    input: SubagentAgentConfigInput,
    onControlResult: (result: TurnRunnerControlResult) => void,
  ): Agent;
  /** 解析子 Agent 的 skill allowlist，并基于该集合展开 slash-skill prompt。 */
  skillContext: {
    /** 解析允许的 skill 名称；不受限制的子 Agent 返回 undefined。 */
    resolveSkills(spec: SubagentSpec, ctx: SubagentExecutionContext): Skill[] | undefined;
    /** 仅使用此子 Agent 可用的 skill 展开 slash 命令。 */
    resolveSlashSkillPrompt(prompt: string, skills: Skill[] | undefined): string;
    /** 当 fork 限制父 Agent 的 skill catalog 时，重建系统 prompt。 */
    createSystemPromptWithAppendedLayers(input: { skills: readonly Skill[] }): string;
  };
  /** 在应用每个 spec 的 model 和 effort 覆盖前，复制到子 Agent 的父选项。 */
  inheritedOptions(): TurnOptions;
  /** 将显式 virtual model 覆盖解析为其现有默认 route。 */
  resolveModel(
    model: string | undefined,
  ): Pick<ResolvedTarget, "modelName" | "thinkingLevel"> | undefined;
  /** 启用 forkContext 时，返回父 transcript 的快照。 */
  seedMessages(spec: SubagentSpec, ctx: SubagentExecutionContext): AgentMessage[];
  /** 返回不受限制的 fork 使用的、与父 Agent 字节一致的系统 prompt。 */
  parentSystemPrompt(ctx: SubagentExecutionContext): string | undefined;
  /** 使用子 Agent 解析后的 cwd 创建编程工具。 */
  createTools(cwd: string | undefined, ctx: SubagentExecutionContext): { tools: AgentTool[] };
  /** 在不改变子 Agent 语义的前提下，重试已有的 provider 瞬态失败。 */
  retryTransientServerErrors(agent: Agent): Promise<void>;
  /** 仅当此子 Agent 尚未发出可见输出或调用工具时，才跨 transport 切换。 */
  retryConnectedTransportFallback(agent: Agent, visibleOutput: () => boolean): Promise<void>;
  /** 通过附加的 child origin 将 pi 事件流过回合协议。 */
  emitAgentEvent(event: AgentEvent, origin: TurnEventOrigin): void;
  /** 将一个子 Agent 完成的用量添加到回合聚合值。 */
  recordUsage(
    usage: TurnTokenUsage | Usage | undefined,
    modelId: string | undefined,
    provider: TransportName | undefined,
  ): void;
  /** 子 Agent 完成后发出聚合用量快照。 */
  emitTurnUsage(origin: TurnEventOrigin): void;
}

/** 构建所有内部子 Agent spec builder 共用的单一 executor。 */
export function createSubagentExecutor(deps: SubagentExecutorDeps) {
  return (spec: SubagentSpec, ctx: SubagentExecutionContext): SubagentRun => {
    const controls: TurnRunnerControlResult[] = [];
    const seedMessages = deps.seedMessages(spec, ctx);
    // 预先记录 seed prefix 长度。子 Agent 的结果、部分文本和记录的用量都会通过从
    // agent.state.messages 中切掉此前缀来计算，因此 fork 的父 transcript 不会被并入本次运行。
    // 如果每个调用点都延迟读取 `seedMessages.length`，而 Agent 曾原地向 seed 数组追加内容，
    // 结果就会错误；因此只快照一次计数。
    const seedMessageCount = seedMessages.length;
    const resolvedModel = deps.resolveModel(spec.model);
    const inheritedOptions = deps.inheritedOptions();
    const childModelOptions: TurnOptions = resolvedModel
      ? { model: resolvedModel.modelName, thinkingLevel: resolvedModel.thinkingLevel }
      : {
          ...(spec.model ? { model: spec.model } : {}),
          ...(spec.thinkingLevel ? { thinkingLevel: spec.thinkingLevel } : {}),
        };
    const state: TurnState = {
      status: "running",
      mode: "agent",
      options: {
        ...inheritedOptions,
        ...childModelOptions,
      },
      agent: {
        status: "running",
        messages: seedMessages,
      },
    };
    const childSkills = deps.skillContext.resolveSkills(spec, ctx);
    // 像父 prompt 路径一样展开 `/skill` slash 命令，但范围限制为此 state 实际获准使用的 skill。
    // 这样 state prompt 可以写 "use the /foo skill to do xyz"，并注入 skill 正文，而不是把字面
    // `/foo` 文本发送给 model。
    const expandedPrompt = deps.skillContext.resolveSlashSkillPrompt(spec.prompt, childSkills);
    const forkContext = spec.forkContext === true;
    const identityLayer = createStateAgentSystemPromptLayer(ctx.machineContext);
    // 使用 fork 时，子 Agent 的 identity + 每个 state 的 systemPrompt 层会放在尾部 user 回合中，
    // 这样系统 prompt 可以与父 Agent 保持字节一致，并保留 provider prompt-cache 前缀。唯一例外是：
    // 通过 allowedSkills 限制 skill 的 state 不得继承父 Agent 的完整 skill catalog。
    // resolveSkills 仅在不受限制的 state 中返回 undefined；返回具体 allowlist 时，我们会围绕该
    // allowlist 重建系统 prompt，而不是逐字复用父 prompt，以 allowlist 契约换取缓存前缀。
    const forkSystemPrompt = forkContext
      ? childSkills === undefined
        ? deps.parentSystemPrompt(ctx)
        : deps.skillContext.createSystemPromptWithAppendedLayers({ skills: childSkills })
      : undefined;
    const tailPrompt = forkContext
      ? [createForkContextReminder(), identityLayer, spec.systemPrompt, expandedPrompt]
          .filter((part): part is string => Boolean(part))
          .join("\n\n")
      : expandedPrompt;
    const agent = deps.createAgent(
      {
        state,
        ...(forkSystemPrompt ? { systemPrompt: forkSystemPrompt } : {}),
        prependSystemPrompt: forkContext ? undefined : identityLayer,
        appendSystemPrompt: forkContext ? undefined : spec.systemPrompt,
        skills: childSkills,
        ...deps.createTools(spec.cwd, ctx),
        ...(ctx.memoryContext ? { memoryContext: ctx.memoryContext } : {}),
      },
      (result) => {
        if (result.type === "none") return;
        if (controls.length > 0) {
          throw new Error("A sub-agent pass produced more than one control result.");
        }
        controls.push(result);
      },
    );
    ctx.agent = agent;
    let unsubscribe: (() => void) | undefined;
    let interruptedReason: string | undefined;
    const finish = (): SubagentResult => {
      const control = controls[0] ?? { type: "none" as const };
      if (control.type !== "none") {
        return { type: "failed", error: `Sub-agent emitted unsupported control: ${control.type}` };
      }
      if (agent.state.errorMessage) {
        return { type: "failed", error: agent.state.errorMessage };
      }
      return {
        type: "complete",
        result: assistantText(agent.state.messages.slice(seedMessageCount)),
      };
    };

    // 子 Agent 与父 Agent 一样运行一个回合——由多次 completion 调用组成——因此会根据自身的
    // `message_end` 事件为每次 completion 流式发送一个 `usage` 事件。只有在没有触发任何
    // `message_end` 时（stubbed-agent 测试路径），finally 块才会回退为汇总整条消息列表。
    let recordedMessageUsage = false;
    return {
      prepared: {
        prompt: tailPrompt,
        systemPrompt: agent.state.systemPrompt,
        model: `${agent.state.model.provider}:${agent.state.model.id}`,
        thinkingLevel: agent.state.thinkingLevel,
        ...(forkContext
          ? { inheritedContext: { systemPrompt: forkSystemPrompt, messages: [...seedMessages] } }
          : {}),
      },
      prompt: async () => {
        let visibleOutput = false;
        unsubscribe = agent.subscribe((event) => {
          if (isExternallyVisibleAgentEvent(event)) visibleOutput = true;
          deps.emitAgentEvent(event, ctx.origin);
          if (event.type !== "message_end" || event.message.role !== "assistant") return;
          deps.recordUsage(
            event.message.usage,
            event.message.model,
            event.message.provider as TransportName,
          );
          recordedMessageUsage = true;
          if (event.message.usage.totalTokens > 0) deps.emitTurnUsage(ctx.origin);
        });
        try {
          await agent.prompt(tailPrompt);
          await deps.retryConnectedTransportFallback(agent, () => visibleOutput);
          if (
            !isPostOutputConnectedFailure(
              agent.state.model.provider,
              agent.state.messages.at(-1),
              visibleOutput,
            )
          ) {
            await deps.retryTransientServerErrors(agent);
          }
          return interruptedReason ? { type: "interrupted" } : finish();
        } catch (error) {
          if (interruptedReason) return { type: "interrupted" };
          if (error instanceof Error) return { type: "failed", error: error.message };
          return { type: "failed", error: String(error) };
        } finally {
          if (!recordedMessageUsage) {
            deps.recordUsage(
              usageFromMessages(agent.state.messages.slice(seedMessageCount)),
              agent.state.model.id,
              agent.state.model.provider as TransportName,
            );
            deps.emitTurnUsage(ctx.origin);
          }
          unsubscribe?.();
        }
      },
      interrupt: (reason) => {
        interruptedReason = reason;
        agent.abort();
        agent.clearAllQueues();
        unsubscribe?.();
      },
      partialAssistantText: () =>
        assistantText(agent.state.messages.slice(seedMessageCount)) || undefined,
      interruptedReason: () => interruptedReason,
    };
  };
}

export interface ClassifySpawnModelDeps {
  /** Active routing table used to distinguish concrete settings from virtual tiers. */
  table: RoutingTable;
  /** Concrete-model capability lookup used by the pure resolution kernel. */
  resolveCatalog: RouteResolutionCatalog;
  /** Provider-call settings for the stateless classifier. */
  classifierOptions: ClassifyRouteOptions;
  /** Test seam for the one classifier call; production uses classifyRoute directly. */
  classify?: typeof classifyRoute;
}

/** 从父 Agent 的 model 设置中选择的具体子 Agent 目标。 */
export interface SpawnModelSelection {
  /** 子 Agent 执行继承或选择的具体 catalog 名称。 */
  modelName: string;
  /** 仅当 virtual 设置选择该 route 时才存在、由 route 拥有的 effort。 */
  thinkingLevel?: ThinkingLevel;
}

/**
 * 在不查询 Session 可变的 ModelRouter 的情况下解析子 Agent model。
 * 具体设置逐字继承；virtual 设置会基于子 Agent prompt 执行一次无状态 classify 调用，并立即解析该决定。
 */
export async function classifySpawnModel(
  prompt: string,
  parentSetting: string,
  deps: ClassifySpawnModelDeps,
): Promise<SpawnModelSelection> {
  const tier = deps.table.tiers[parentSetting];
  if (!tier) return { modelName: parentSetting };

  const classify = deps.classify ?? classifyRoute;
  const decision: ClassifierDecision = await classify(
    {
      tierName: parentSetting,
      tier,
      guidance: deps.table.classifier.guidance,
      lastStepDelta: prompt,
      hasImages: false,
      trigger: "turn_start",
    },
    deps.classifierOptions,
  );
  const resolved = resolveRoute(
    deps.table,
    parentSetting,
    decision.route,
    { hasImages: false },
    deps.resolveCatalog,
  );
  return { modelName: resolved.modelName, thinkingLevel: resolved.thinkingLevel };
}
