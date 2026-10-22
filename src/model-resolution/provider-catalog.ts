import { getEnvApiKey } from "@earendil-works/pi-ai/compat";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import type { Api, Model } from "@earendil-works/pi-ai";
import { isConnectedProviderId } from "../connected-providers/store.js";
import {
  connectedProviderApiKey,
  refreshConnectedTokenInBackground,
} from "../connected-providers/tokens.js";

/** The published fields a missing model's contract can differ from its sibling's on. */
type PublishedContract = Partial<Pick<Model<Api>, "input" | "contextWindow" | "maxTokens">> & {
  cost?: Partial<Model<Api>["cost"]>;
};

interface MissingModelClone {
  /** A shipped sibling whose transport, compat and reasoning shape the clone keeps. */
  from: string;
  to: string;
  name: string;
  /**
   * The contract each transport publishes, keyed by catalog provider. A
   * provider left out gets no clone rather than another transport's numbers.
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
 * Models a transport serves that pi-ai's catalog has not shipped, each cloned
 * from a shipped sibling with only the fields whose published contract differs.
 *
 * An entry is a bug report against the catalog, deleted the moment it ships the
 * id. Without it the provider does not resolve the id at all.
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
    // OpenRouter prices this router by the model it picks, so the shipped
    // sibling's cost stands in: it keeps accounting conservative rather than
    // free. The token cap follows the cheap model the router usually selects.
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

/** The catalog's spec for `provider:modelId`, or the clone standing in for one it lacks. */
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
 * Clones `provider` publishes a contract for and whose source it ships; any
 * other is dropped rather than guessed at.
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
 * The API key to send for a provider, resolved the way Relay Pi stores keys.
 *
 * Connected providers (ChatGPT, Copilot) keep their token in Relay Pi's own store,
 * which pi-ai cannot see at all. And the api-dispatch `complete()` used for
 * structured output does no provider auth resolution whatsoever, so it needs
 * the key handed to it.
 */
export function resolveProviderApiKey(provider: string): string | undefined {
  if (isConnectedProviderId(provider)) {
    const token = connectedProviderApiKey(provider);
    if (!token) refreshConnectedTokenInBackground(provider);
    return token;
  }
  return getEnvApiKey(provider as Parameters<typeof getEnvApiKey>[0]);
}
