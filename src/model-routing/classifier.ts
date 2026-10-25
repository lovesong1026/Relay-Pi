import type { Usage } from "@earendil-works/pi-ai";
import dedent from "dedent";
import { Type } from "typebox";
import * as structuredOutput from "../core/structured-output.js";
import type { TransportName } from "../model-resolution/catalog.js";
import { resolveMeteredModelName } from "../model-resolution/resolver.js";
import {
  CLASSIFIER_SYSTEM_PROMPT,
  renderCacheContinuity,
  renderClassifierRules,
} from "./prompts.js";
import type { ClassifierTarget, TierDefinition } from "./table.js";

const CONTEXT_HINT_LIMIT = 1_000;

function classifierResultTool(routeNames: string[]) {
  return {
    name: "select_route",
    description: "为 Agent 接下来的工作选择一个现有路由。",
    parameters: Type.Object(
      {
        route: Type.Union(
          routeNames.map((name) => Type.Literal(name)),
          { description: "Exactly one route name from AVAILABLE ROUTES." },
        ),
        rationale: Type.String({
          minLength: 1,
          description: "One sentence explaining why this route matches the current work.",
        }),
      },
      { additionalProperties: false },
    ),
  };
}

/**
 * 请求分类的运行时里程碑。概念在此处定义，由 router、protocol event 和 CLI probe
 * 消费，因此 union 不会在各层之间漂移。
 */
export type RouteTrigger = "turn_start" | "cadence" | "advisor" | "step_trigger" | "compaction";

/** 在 turn 边界或 turn 内里程碑处提供的精简路由事实。 */
export interface ClassifierInput {
  /** 本次调用中要分类完整路由集合的虚拟层级。 */
  tierName: string;
  /** 展示给分类器的层级规则；具体目标对分类器保持隐藏。 */
  tier: TierDefinition;
  /** 管理员编写的路由和缓存偏好策略。 */
  guidance: string;
  /** 在可保持连续性时使用的当前具体目标和选中路由。 */
  currentTarget?: string;
  /** 上一回合的有界摘要，仅用于判断任务连续性。 */
  prevTurnHint?: string;
  /** 最近一次 Agent 步骤发生变化的有界描述。 */
  lastStepDelta?: string;
  /** 待处理输入是否包含图像；路由器会在分类后处理能力要求。 */
  hasImages: boolean;
  /** 请求分类的事件，用于解释稀疏的 cadence/advisor 上下文。 */
  trigger: RouteTrigger;
}

/** 结构化输出 classifier 调用使用的纯 system/user prompt 对。 */
export interface ClassifierMessages {
  /** 稳定的 classifier 策略。 */
  systemPrompt: string;
  /** 层级规则以及精简的请求专属路由事实。 */
  prompt: string;
}

/** 结构化输出调用的接缝；生产环境绑定 `generateStructuredOutput`。 */
export type ClassifierGenerate = typeof structuredOutput.generateStructuredOutput;

/** 一次 classifier 调用的归因报告；无论从哪条路径运行，形状都一致。 */
export interface ClassifierUsageReport {
  /** 此次调用计费所使用的 provider-specific model id。 */
  modelId: string;
  /** 承载此次调用的 backend。 */
  transport: TransportName;
  /** 此次分类调用产生的计费 usage。 */
  usage: Usage;
}

/** 一次实时路由决策的选项。 */
export interface ClassifyRouteOptions {
  /** 路由表中的 classifier target。 */
  target: ClassifierTarget;
  /** 所属 turn 被中断时，取消 provider 请求。 */
  signal?: AbortSignal;
  /** 接收此次调用的归因 usage。 */
  onUsage?: (report: ClassifierUsageReport) => void;
  /** 用于确定性测试的 chat-path 网络接缝。 */
  generate?: ClassifierGenerate;
}

/** 仍然只命名策略而非具体执行目标的 classifier 选择。 */
export interface ClassifierDecision {
  /** 从给定 tier 中选出的现有路由名称。 */
  route: string;
  /** chat classifier 返回的一句话解释。 */
  rationale?: string;
  /**
   * 每个路由的概率。chat classifier 不会返回概率；保留此字段是为了让 router 和 CLI 报告
   * 不必根据 classifier 的实现分支。
   */
  probabilities?: Record<string, number>;
}

function boundedText(value: string | undefined): string | null {
  if (!value?.trim()) return null;
  const normalized = value.trim();
  return normalized.length <= CONTEXT_HINT_LIMIT
    ? normalized
    : `${normalized.slice(0, CONTEXT_HINT_LIMIT)}…`;
}

function boundedHint(value: string | undefined): string {
  return boundedText(value) ?? "Not provided.";
}

/** 构造完整的精简 chat-classifier prompt，不读取运行时状态。 */
export function buildClassifierMessages(input: ClassifierInput): ClassifierMessages {
  const continuity = renderCacheContinuity(input.currentTarget);

  return {
    systemPrompt: CLASSIFIER_SYSTEM_PROMPT,
    prompt: dedent`
      ${renderClassifierRules(input.tierName, input.tier, input.guidance)}

      分类上下文：
      触发原因：${input.trigger}
      是否包含图像：${input.hasImages ? "是" : "否"}
      ${continuity}
      上一回合提示：${boundedHint(input.prevTurnHint)}
      当前请求 / 上一步变化：${boundedHint(input.lastStepDelta)}

      从可用路由中准确选择一个名称，并给出一句理由。
    `,
  };
}

/** 通过 `select_route` 工具强制返回 route 的 chat model 选择。 */
async function classifyWithChatModel(
  input: ClassifierInput,
  options: ClassifyRouteOptions,
): Promise<ClassifierDecision> {
  const model = resolveMeteredModelName(options.target.modelName);
  const messages = buildClassifierMessages(input);
  const generate = options.generate ?? structuredOutput.generateStructuredOutput;
  return await generate({
    model: `${model.provider}:${model.id}`,
    tool: classifierResultTool(Object.keys(input.tier.routes)),
    systemPrompt: messages.systemPrompt,
    prompt: messages.prompt,
    ...(options.target.thinkingLevel
      ? { callOptions: { reasoningEffort: options.target.thinkingLevel } }
      : {}),
    signal: options.signal,
    onUsage: (usage) =>
      options.onUsage?.({
        modelId: model.id,
        transport: model.provider as TransportName,
        usage,
      }),
  });
}

/** 使用一次模型调用对一个 tier 进行分类，并拒绝该 tier 之外的任何 route。 */
export async function classifyRoute(
  input: ClassifierInput,
  options: ClassifyRouteOptions,
): Promise<ClassifierDecision> {
  const decision = await classifyWithChatModel(input, options);
  if (!Object.hasOwn(input.tier.routes, decision.route)) {
    throw new Error(
      `Classifier selected unknown route "${decision.route}" for tier "${input.tierName}".`,
    );
  }
  return decision;
}
