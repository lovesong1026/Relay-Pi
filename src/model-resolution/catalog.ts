import type { ConnectedProviderId } from "../connected-providers/store.js";

/** 解析未固定 model 时，router 会考虑的计费 provider。 */
export type RouterProviderName = "openrouter";

/** 能够承载精选 catalog model 的任意 backend。 */
export type TransportName = RouterProviderName | ConnectedProviderId;

/** 在接受精选 shorthand 的所有位置都有效的无版本 model family。 */
export type FamilyName =
  | "fable"
  | "opus"
  | "sonnet"
  | "haiku"
  | "sol"
  | "terra"
  | "luna"
  | "astra"
  | "kimi"
  | "grok"
  | "deepseek"
  | "glm"
  | "jev";

export interface ProviderPreference {
  /** pi-ai 接受或 model resolution 在本地处理的 provider 标识。 */
  provider: RouterProviderName;
  /** 对于凭据无法通过 pi-ai 发现的 provider，使用 env var 覆盖。 */
  customEnvVar?: () => string | null;
}

export interface ProviderModelCandidate {
  /** 支持该候选 model 的 provider。 */
  provider: RouterProviderName;
  /** 传给运行时 model loader 的完整 provider:modelId 字符串。 */
  modelName: string;
}

interface ModelDefinition {
  /** 版本无关的名称；catalog 中第一个条目是该 family 的最新 model。 */
  family: FamilyName;
  shorthand: string;
  aliases: readonly string[];
  /**
   * 用于在每个受支持 transport 上承载该精选 model 的 provider-specific id。只有 transport
   * 实际提供该 model 时才列出：未列出的 transport 会跳过，而列出但 catalog 尚未发布该 id
   * 的 transport 会通过 `MISSING_MODEL_CLONES` 解析。
   *
   * Id 遵循 transport 自己的 namespace，并对应 `TransportName` union：`RouterProviderName`
   * router 聚合多个 vendor，需要 `vendor/model` 前缀来消除歧义；`ConnectedProviderId`
   * subscription 已限定到单个 vendor，因此使用不带前缀的 model 名称。
   */
  modelsByProvider: Partial<Record<TransportName, string>>;
  /**
   * 输出 token 的硬上限；仅当它低于上游 pi-ai catalog 报告的 `maxTokens` 时应用。某些
   * provider 宣传的窗口大于实际路由到的 backend 所接受的窗口，因此不限制会导致请求
   * 返回 400。catalog 值本身正确时留空。
   */
  maxOutputTokens?: number;
}

export const DEFAULT_CLI_MODEL = "opus";
export const DEFAULT_CLI_MEMORY_MODEL = "luna";

/**
 * shorthand resolution 的全局 provider 优先级。OpenRouter 是唯一的计费 router；
 * 在它之前会先查询已连接的 subscription。
 */
export const PROVIDER_ORDER: readonly ProviderPreference[] = [{ provider: "openrouter" }];

const DEFAULT_MODEL_BY_PROVIDER: Record<RouterProviderName, string> = {
  openrouter: DEFAULT_CLI_MODEL,
};

const MEMORY_MODEL_BY_PROVIDER: Record<RouterProviderName, string> = {
  openrouter: DEFAULT_CLI_MEMORY_MODEL,
};

const MODEL_DEFINITIONS: readonly ModelDefinition[] = [
  {
    family: "opus",
    shorthand: "opus-5.5",
    aliases: ["claude-opus-5.5", "anthropic/claude-opus-5.5"],
    modelsByProvider: {
      openrouter: "anthropic/claude-opus-5.5",
      "github-copilot": "claude-opus-5.5",
    },
  },
  {
    family: "sonnet",
    shorthand: "sonnet-4.6",
    aliases: [
      "claude-sonnet-4.6",
      "claude-sonnet-4-6",
      "anthropic/claude-sonnet-4.6",
      "anthropic/claude-sonnet-4-6",
    ],
    modelsByProvider: {
      openrouter: "anthropic/claude-sonnet-4.6",
      "github-copilot": "claude-sonnet-4.6",
    },
  },
  {
    family: "haiku",
    shorthand: "haiku-4.5",
    aliases: [
      "claude-haiku-4.5",
      "claude-haiku-4-5",
      "anthropic/claude-haiku-4.5",
      "anthropic/claude-haiku-4-5",
    ],
    modelsByProvider: {
      openrouter: "anthropic/claude-haiku-4.5",
      "github-copilot": "claude-haiku-4.5",
    },
  },
  {
    // 默认的 observational-memory model。OpenRouter 通过 Responses transport 承载所有
    // OpenAI model，而不是走 anthropic-messages，否则 observer 和 reflector 请求的低
    // reasoning effort 会被静默丢弃。
    family: "luna",
    shorthand: "gpt-6-luna",
    aliases: ["openai/gpt-6-luna"],
    modelsByProvider: {
      openrouter: "openai/gpt-6-luna",
      "openai-codex": "gpt-6-luna",
    },
  },
  {
    family: "sol",
    shorthand: "gpt-6.1-sol",
    aliases: ["openai/gpt-6.1-sol"],
    modelsByProvider: {
      openrouter: "openai/gpt-6.1-sol",
      "openai-codex": "gpt-6.1-sol",
    },
    maxOutputTokens: 128000,
  },
  {
    family: "sol",
    shorthand: "gpt-6-sol",
    aliases: ["openai/gpt-6-sol"],
    modelsByProvider: {
      openrouter: "openai/gpt-6-sol",
      "openai-codex": "gpt-6-sol",
    },
    maxOutputTokens: 128000,
  },
  {
    family: "astra",
    shorthand: "gpt-6-astra",
    aliases: ["openai/gpt-6-astra"],
    modelsByProvider: {
      openrouter: "openai/gpt-6-astra",
      "openai-codex": "gpt-6-astra",
    },
    maxOutputTokens: 128000,
  },
  {
    family: "kimi",
    shorthand: "kimi-k3",
    aliases: ["moonshotai/kimi-k3"],
    modelsByProvider: {
      openrouter: "moonshotai/kimi-k3",
    },
    // Moonshot 的 provider route 宣传最大完成长度为 131k。
    maxOutputTokens: 131072,
  },
  {
    // OpenRouter 在 x-ai vendor namespace 下发布 Grok。
    family: "grok",
    shorthand: "grok-4.7",
    aliases: ["spacexai/grok-4.7", "spacexai/grok-4-7", "grok-4-7"],
    modelsByProvider: {
      openrouter: "x-ai/grok-4.7",
    },
  },
  {
    // 作为 deepseek family 的首项，因此 `deepseek` alias 会解析到这里。
    family: "deepseek",
    shorthand: "deepseek-v4.1-flash",
    aliases: ["deepseek/deepseek-v4.1-flash"],
    modelsByProvider: {
      openrouter: "deepseek/deepseek-v4.1-flash",
    },
  },
  {
    // DeepSeek V4 Pro 由 OpenRouter 在自己的 vendor namespace 下提供。
    family: "deepseek",
    shorthand: "deepseek-v4-pro",
    aliases: ["deepseek/deepseek-v4-pro"],
    modelsByProvider: {
      openrouter: "deepseek/deepseek-v4-pro",
    },
    // 即使 pi-ai catalog 宣传 384000，上游 backend 也会拒绝高于 262144 的 max_tokens。
    maxOutputTokens: 262144,
  },
  {
    // advisor 使用的 fable family 首项。provider hook 仍会检查已连接账户是否可用。
    family: "fable",
    shorthand: "fable-5.1",
    aliases: [
      "claude-fable-5.1",
      "claude-fable-5-1",
      "anthropic/claude-fable-5.1",
      "anthropic/claude-fable-5-1",
    ],
    modelsByProvider: {
      openrouter: "anthropic/claude-fable-5.1",
      "github-copilot": "claude-fable-5.1",
    },
  },
  {
    // 上一个 fable，保留为可解析的版本化 pin。
    family: "fable",
    shorthand: "fable-5",
    aliases: ["claude-fable-5", "anthropic/claude-fable-5"],
    modelsByProvider: {
      openrouter: "anthropic/claude-fable-5",
      "github-copilot": "claude-fable-5",
    },
  },
  {
    // Zhipu 的 GLM 5.3 由 OpenRouter 以 `z-ai/glm-5.3` 提供。
    family: "glm",
    shorthand: "glm-5.3",
    aliases: ["zai/glm-5.3", "z-ai/glm-5.3", "glm-5-3"],
    modelsByProvider: {
      openrouter: "z-ai/glm-5.3",
    },
  },
  {
    // TypeSafe 的 Jev Router 仅支持 OpenRouter，并会把每个请求路由到它判断最合适的
    // model 和 effort。能力来自 `MISSING_MODEL_CLONES`，因为 pi-ai catalog 没有发布该 id。
    family: "jev",
    shorthand: "jev-router",
    aliases: ["typesafe/jev-router"],
    modelsByProvider: {
      openrouter: "typesafe/jev-router",
    },
  },
];

const familyLatest: Partial<Record<FamilyName, string>> = {};
const shorthandsByFamily: Partial<Record<FamilyName, string[]>> = {};
for (const definition of MODEL_DEFINITIONS) {
  familyLatest[definition.family] ??= definition.shorthand;
  (shorthandsByFamily[definition.family] ??= []).push(definition.shorthand);
}

// Terra 仍是由 Sol 承担的 coding role 的持久化选择。
familyLatest.terra = familyLatest.sol;
shorthandsByFamily.terra = shorthandsByFamily.sol;

/**
 * 每个 family 的所有精选 shorthand，按 catalog 顺序分组并导出，使覆盖检查能够枚举 catalog
 * 本身，而不是依赖手动维护的 roster，让新添加的 model 悄悄漏检。
 */
export const SHORTHANDS_BY_FAMILY = Object.freeze(
  shorthandsByFamily as Record<FamilyName, readonly string[]>,
);

/** 每个 family 的最新 shorthand，由匹配的 catalog 首个条目派生。 */
export const FAMILY_LATEST = Object.freeze(familyLatest as Record<FamilyName, string>);

/** 将无版本的 family 名称解析为 catalog 顺序中的第一个版本化 shorthand。 */
export function resolveFamilyShorthand(name: string): string | undefined {
  return FAMILY_LATEST[name.trim().toLowerCase() as FamilyName];
}

export function isProviderPinnedModelName(modelName: string): boolean {
  return modelName.includes(":");
}

/**
 * 当 catalog 设置了 `maxOutputTokens` 且该值低于已解析 model 的输出上限时，将其限制到该值。
 * 没有适用覆盖时原样返回输入，因此未知或已正确设置的 model 会直接通过。
 */
export function clampModelOutputTokens<T extends { id: string; maxTokens: number }>(model: T): T {
  // `getModel` 在运行时会对不在 catalog 中的 pass-through provider:modelId 值返回 undefined；
  // resolution 必须原样转发它们，不能解引用缺失的 model。
  if (!model) return model;
  const cap = findModelDefinition(model.id)?.maxOutputTokens;
  if (cap === undefined || model.maxTokens <= cap) return model;
  return { ...model, maxTokens: cap };
}

export function getProviderDefaultModel(provider: RouterProviderName): string {
  return DEFAULT_MODEL_BY_PROVIDER[provider];
}

export function getProviderMemoryModel(provider: RouterProviderName): string {
  return MEMORY_MODEL_BY_PROVIDER[provider];
}

export function getModelCandidates(modelName: string): readonly ProviderModelCandidate[] {
  const definition = findModelDefinition(modelName);
  if (!definition) return [];

  return PROVIDER_ORDER.flatMap(({ provider }) => {
    const modelId = definition.modelsByProvider[provider];
    return modelId ? [{ provider, modelName: `${provider}:${modelId}` }] : [];
  });
}

export function isKnownShorthand(modelName: string): boolean {
  return Boolean(findModelDefinition(modelName));
}

export function canonicalizeModelName(modelName: string): string {
  return findModelDefinition(modelName)?.shorthand ?? modelName;
}

/** 将精选 shorthand 或 alias 解析为指定 transport 提供的 id。 */
export function transportModelId(transport: TransportName, shorthand: string): string | undefined {
  return findModelDefinition(shorthand)?.modelsByProvider[transport];
}

/** 该 transport 提供的所有 model id，按 catalog 顺序排列。 */
export function transportModelIds(transport: TransportName): string[] {
  return MODEL_DEFINITIONS.flatMap((definition) => {
    const modelId = definition.modelsByProvider[transport];
    return modelId ? [modelId] : [];
  });
}

/** 根据 transport-specific model id 找回它代表的精选 shorthand。 */
export function shorthandForTransportModel(
  transport: TransportName,
  modelId: string,
): string | undefined {
  return MODEL_DEFINITIONS.find((definition) => definition.modelsByProvider[transport] === modelId)
    ?.shorthand;
}

/**
 * 根据 catalog alias 规范化 `provider:modelId` model id，使用户能够传入熟悉的变体，例如
 * `claude-opus-5-5`，即使底层 provider catalog 写作 `claude-opus-5.5` 也可以工作。
 * 没有 alias 匹配时回退到输入 id，让未知 id 原样进入 provider lookup。
 */
export function canonicalizeProviderModelId(provider: RouterProviderName, modelId: string): string {
  const definition = findModelDefinition(modelId);
  if (!definition) return modelId;
  return definition.modelsByProvider[provider] ?? modelId;
}

function findModelDefinition(modelName: string): ModelDefinition | undefined {
  const normalized = modelName.toLowerCase();
  const familyShorthand = resolveFamilyShorthand(normalized);
  return MODEL_DEFINITIONS.find(
    (definition) =>
      definition.shorthand === (familyShorthand ?? normalized) ||
      definition.aliases.includes(normalized),
  );
}

/**
 * 将用户友好的 provider 名称（及常见 alias）映射到规范的 `RouterProviderName`。
 * 未知值返回 `undefined`，让调用方展示可接受名称列表。
 */
export function resolveProviderShorthand(name: string): RouterProviderName | undefined {
  switch (name.trim().toLowerCase()) {
    case "openrouter":
      return "openrouter";
    default:
      return undefined;
  }
}

/** 按规范顺序列出 `--provider` 接受的名称，用于帮助信息和错误信息。 */
export const PROVIDER_SHORTHANDS: readonly string[] = ["openrouter"];

/** 为 provider 的默认 chat model 构造 `provider:modelId` 引用。 */
export function pinnedDefaultModel(provider: RouterProviderName): string {
  return `${provider}:${getProviderDefaultModel(provider)}`;
}

/** 为 provider 的 memory model 构造 `provider:modelId` 引用。 */
export function pinnedMemoryModel(provider: RouterProviderName): string {
  return `${provider}:${getProviderMemoryModel(provider)}`;
}

/** 从已保存的 Session 和 routing 配置中恢复 family 意图。
 * 已知的替换目标保留其 transport；未知选择和历史 message attribution 保持不变。 */
export function normalizeSavedModelSelection(modelName: string): string;
export function normalizeSavedModelSelection(modelName: string | undefined): string | undefined;
export function normalizeSavedModelSelection(modelName: string | undefined): string | undefined {
  const savedFamilies: Readonly<Record<string, FamilyName>> = {
    "opus-5": "opus",
    "opus-4.8": "opus",
    "opus-4.7": "opus",
    "gpt-5.6-sol": "sol",
    "gpt-5.6-terra": "terra",
    "gpt-5.6-luna": "luna",
    "grok-4.3": "grok",
    "glm-5.2": "glm",
    "glm-4.7": "glm",
  };
  if (modelName === undefined) return undefined;
  const separator = modelName.indexOf(":");
  const id = separator === -1 ? modelName : modelName.slice(separator + 1);
  const family =
    savedFamilies[
      id
        .toLowerCase()
        .replace(/^(?:anthropic|openai|xai|x-ai|zai|z-ai)\//, "")
        .replace(/^claude-/, "")
        .replace(/(\d)-(?=\d)/g, "$1.")
    ];
  if (!family) return modelName;
  if (separator === -1) return family;
  const rawProvider = modelName.slice(0, separator);
  const router = resolveProviderShorthand(rawProvider);
  if (router) return `${rawProvider}:${family}`;
  if (rawProvider === "openai-codex" || rawProvider === "github-copilot") {
    const target = transportModelId(rawProvider, family);
    if (target) return `${rawProvider}:${target}`;
  }
  return modelName;
}
