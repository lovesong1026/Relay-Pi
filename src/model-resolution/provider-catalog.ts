import { getEnvApiKey } from "@earendil-works/pi-ai/compat";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import type { Api, Model } from "@earendil-works/pi-ai";
import { isConnectedProviderId } from "../connected-providers/store.js";
import {
  connectedProviderApiKey,
  refreshConnectedTokenInBackground,
} from "../connected-providers/tokens.js";

/** 缺失模型的契约可与同系列模型不同的已发布字段。 */
type PublishedContract = Partial<Pick<Model<Api>, "input" | "contextWindow" | "maxTokens">> & {
  cost?: Partial<Model<Api>["cost"]>;
};

interface MissingModelClone {
  /** 已发布的同系列模型；克隆保留其传输方式、兼容性和推理结构。 */
  from: string;
  to: string;
  name: string;
  /**
   * 每种传输方式发布的契约，以目录 provider 为键。
   * 未列出的 provider 不会获得克隆，而不是使用其他传输方式的数值。
   */
  byProvider: Partial<Record<string, PublishedContract>>;
}

const OPUS_5_5_CONTRACT: PublishedContract = {
  input: ["text", "image"],
  contextWindow: 1_000_000,
  maxTokens: 128_000,
  cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
};
const SOL_6_CONTRACT: PublishedContract = {
  input: ["text", "image"],
  contextWindow: 1_050_000,
  maxTokens: 128_000,
  cost: {
    input: 2,
    output: 10,
    cacheRead: 0.2,
    cacheWrite: 2.5,
    tiers: [{ inputTokensAbove: 272000, input: 4, output: 15, cacheRead: 0.4, cacheWrite: 5 }],
  },
};
const SOL_6_1_CONTRACT: PublishedContract = {
  ...SOL_6_CONTRACT,
  cost: {
    input: 2,
    output: 10,
    cacheRead: 0.1,
    cacheWrite: 2.5,
    tiers: [{ inputTokensAbove: 272000, input: 4, output: 15, cacheRead: 0.2, cacheWrite: 5 }],
  },
};
const LUNA_6_CONTRACT: PublishedContract = {
  input: ["text", "image"],
  contextWindow: 1_050_000,
  maxTokens: 128_000,
  cost: {
    input: 0.1,
    output: 0.5,
    cacheRead: 0.01,
    cacheWrite: 0.125,
    tiers: [
      { inputTokensAbove: 272000, input: 0.2, output: 0.75, cacheRead: 0.02, cacheWrite: 0.25 },
    ],
  },
};

/**
 * 传输方式已提供、但 pi-ai 目录尚未发布的模型，各自从
 * 已发布的同系列模型克隆，仅覆盖已发布契约中不同的字段。
 *
 * 每个条目都是针对目录的缺陷报告，目录发布该 id 时即删除。
 * 没有它，provider 根本无法解析该 id。
 */
const MISSING_MODEL_CLONES: readonly MissingModelClone[] = [
  {
    from: "openai/gpt-5.6-sol",
    to: "openai/gpt-6.1-sol",
    name: "GPT-6.1 Sol",
    byProvider: { openrouter: SOL_6_1_CONTRACT },
  },
  {
    from: "gpt-5.6-sol",
    to: "gpt-6.1-sol",
    name: "GPT-6.1 Sol",
    byProvider: { "openai-codex": { cost: SOL_6_1_CONTRACT.cost } },
  },
  {
    from: "claude-opus-5",
    to: "claude-opus-5.5",
    name: "Claude Opus 5.5",
    byProvider: { "github-copilot": { cost: OPUS_5_5_CONTRACT.cost } },
  },
  {
    from: "gpt-5.6-sol",
    to: "gpt-6-sol",
    name: "GPT-6 Sol",
    byProvider: { "openai-codex": { cost: SOL_6_CONTRACT.cost } },
  },
  {
    from: "gpt-5.6-luna",
    to: "gpt-6-luna",
    name: "GPT-6 Luna",
    byProvider: { "openai-codex": { cost: LUNA_6_CONTRACT.cost } },
  },
  {
    from: "anthropic/claude-opus-5",
    to: "anthropic/claude-opus-5.5",
    name: "Claude Opus 5.5",
    byProvider: { openrouter: OPUS_5_5_CONTRACT },
  },
  {
    from: "openai/gpt-5.6-sol",
    to: "openai/gpt-6-sol",
    name: "GPT-6 Sol",
    byProvider: { openrouter: SOL_6_CONTRACT },
  },
  {
    from: "openai/gpt-5.6-luna",
    to: "openai/gpt-6-luna",
    name: "GPT-6 Luna",
    byProvider: { openrouter: LUNA_6_CONTRACT },
  },
  {
    from: "x-ai/grok-4.3",
    to: "x-ai/grok-4.7",
    name: "Grok 4.7",
    byProvider: {
      openrouter: {
        input: ["text", "image"],
        contextWindow: 500000,
        maxTokens: 450000,
        cost: {
          input: 1.6,
          output: 4.8,
          cacheRead: 0.4,
          cacheWrite: 0,
        },
      },
    },
  },
  {
    from: "deepseek/deepseek-v4-flash",
    to: "deepseek/deepseek-v4.1-flash",
    name: "DeepSeek V4.1 Flash",
    byProvider: {
      openrouter: {
        input: ["text", "image"],
        cost: { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0 },
        contextWindow: 1_048_576,
        maxTokens: 384_000,
      },
    },
  },
  {
    // OpenRouter 按该路由器选择的模型计费，因此使用已发布的
    // 同系列模型成本代替：使记账保持保守，而非
    // 免费。token 上限沿用路由器通常选择的低成本模型。
    from: "z-ai/glm-5.3",
    to: "typesafe/jev-router",
    name: "TypeSafe Jev Router",
    byProvider: {
      openrouter: {
        input: ["text", "image"],
        contextWindow: 1_048_576,
        maxTokens: 32_768,
      },
    },
  },
];

/** 目录中 `provider:modelId` 的规范，或替代缺失条目的克隆。 */
export function catalogModel(provider: string, modelId: string): Model<Api> | undefined {
  return (
    shippedModel(provider, modelId) ??
    missingCatalogModels(provider).find((model) => model.id === modelId)
  );
}

function shippedModel(provider: string, modelId: string): Model<Api> | undefined {
  return getBuiltinModel(
    provider as Parameters<typeof getBuiltinModel>[0],
    modelId as Parameters<typeof getBuiltinModel>[1],
  ) as Model<Api> | undefined;
}

/**
 * `provider` 已发布契约且提供源模型的克隆；
 * 其他项直接丢弃，不作猜测。
 */
export function missingCatalogModels(
  provider: string,
  models?: readonly Model<Api>[],
): Model<Api>[] {
  return MISSING_MODEL_CLONES.flatMap((clone) => {
    const lookup = (id: string) =>
      models ? models.find((model) => model.id === id) : shippedModel(provider, id);
    if (lookup(clone.to)) return [];
    const contract = clone.byProvider[provider];
    const source = contract && lookup(clone.from);
    if (!source) return [];
    return [
      {
        ...source,
        ...contract,
        id: clone.to,
        name: clone.name,
        cost: { ...source.cost, ...contract.cost },
      },
    ];
  });
}

/**
 * 要发送给 provider 的 API 密钥，按 Relay Pi 的密钥存储方式解析。
 *
 * 已连接 provider（ChatGPT、Copilot）将 token 保留在 Relay Pi 自有存储中，
 * pi-ai 完全不可见。而用于结构化输出的 api-dispatch `complete()`
 * 不执行任何 provider 认证解析，因此需要
 * 将密钥直接传给它。
 */
export function resolveProviderApiKey(provider: string): string | undefined {
  if (isConnectedProviderId(provider)) {
    const token = connectedProviderApiKey(provider);
    if (!token) refreshConnectedTokenInBackground(provider);
    return token;
  }
  return getEnvApiKey(provider as Parameters<typeof getEnvApiKey>[0]);
}
