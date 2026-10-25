import type { Model } from "@earendil-works/pi-ai";
import { findEnvKeys } from "@earendil-works/pi-ai/compat";

import {
  BUILT_IN_ROUTING_TABLE,
  isVirtualModel,
  type RoutingCatalogAdapter,
  type RoutingTable,
} from "../model-routing/table.js";
import { catalogModel } from "./provider-catalog.js";
import {
  canonicalizeModelName,
  normalizeSavedModelSelection,
  resolveFamilyShorthand,
  canonicalizeProviderModelId,
  clampModelOutputTokens,
  DEFAULT_CLI_MEMORY_MODEL,
  getModelCandidates,
  getProviderDefaultModel,
  getProviderMemoryModel,
  isKnownShorthand,
  isProviderPinnedModelName,
  PROVIDER_ORDER,
  type ProviderModelCandidate,
  type RouterProviderName,
  resolveProviderShorthand,
} from "./catalog.js";
import { connectedTransportSnapshot } from "../cli/shared.js";
import { chooseTransport } from "../connected-providers/transport-preference.js";
import {
  applyConnectedModelHook,
  connectedProviderApiKey,
  refreshConnectedTokenInBackground,
} from "../connected-providers/tokens.js";
import { isConnectedProviderId, type ConnectedProviderId } from "../connected-providers/store.js";

export { DEFAULT_CLI_MEMORY_MODEL, DEFAULT_CLI_MODEL } from "./catalog.js";

/**
 * 保留 CLI selection 及其 provenance（显式 flag、推断出的 provider credential，或 routing-table
 * 默认值）。类型放在独立模块中，使 cli.ts 专注于 argv 解析和 I/O harness；provider 列表
 * 的变化不会触及 CLI 表面。
 */

export interface ModelResolution {
  /** Model name retained for config, display, and later runtime resolution. */
  modelName: string;
  /** explicit: CLI flag; inferred: provider env var present; default: active routing-table fallback. */
  source: "explicit" | "inferred" | "default";
  /** Provider env var that triggered inference, e.g. "OPENROUTER_API_KEY". */
  envVar?: string;
  /** True when the env var was loaded from a CLI env file rather than the shell. */
  fromDotenv?: boolean;
  /** True when the retained name is a virtual tier owned by model routing. */
  routed?: boolean;
}

export function resolveModelName(model: string): Model<any> {
  model = resolveModelReference(model);
  const separator = model.indexOf(":");
  if (separator === -1) {
    throw new Error("Models must use provider:modelId syntax");
  }
  const rawProvider = model.slice(0, separator);
  const rawModelId = model.slice(separator + 1);
  // CLI 支持 OpenRouter router 和已连接 subscription。其他显式 pin——例如
  // `anthropic:claude-opus-5.5` 或 `openai:gpt-6-sol`——在此处是未知 provider：
  // `resolveProviderShorthand` 返回 undefined，原始 provider 会透传，下面的
  // `catalogModel` 也会原样交给 pi-ai。这是偶然的 passthrough，不是受支持的路径：
  // 如果 pi-ai 提供该 provider/id 且调用方提供 credential，pi-ai 会解析它；否则会得到
  // undefined model。未知 provider 不适用 catalog canonicalization。
  const provider = resolveProviderShorthand(rawProvider) ?? rawProvider;
  const modelId = isKnownProvider(provider)
    ? canonicalizeProviderModelId(provider, rawModelId)
    : rawModelId;
  // catalog 为每个 provider 返回结果。clampModelOutputTokens 会在运行时原样转发缺失的 model。
  return clampModelOutputTokens(catalogModel(provider, modelId) as Model<any>);
}

/** 仅通过已配置的计费 router 顺序解析辅助 actor。 */
export function resolveMeteredModelName(modelName: string): Model<any> {
  return resolveModelName(resolveRouterModelReference(modelName));
}

/** 每个 model-routing composition site 共用的具体 catalog 边界。 */
export const routingCatalogAdapter: RoutingCatalogAdapter = {
  isCatalogName: isKnownShorthand,
  normalizeSavedModelName: normalizeSavedModelSelection,
  modelAcceptsImages: (name: string) =>
    resolveModelName(isProviderPinnedModelName(name) ? name : `openrouter:${name}`).input.includes(
      "image",
    ),
};

function isKnownProvider(provider: string): provider is RouterProviderName {
  return PROVIDER_ORDER.some((entry) => entry.provider === provider);
}

/** 当前进程中已配置 credential env var 的 router provider。 */
export function configuredRouterProviders(): RouterProviderName[] {
  return PROVIDER_ORDER.filter((entry) => lookupProviderEnvVar(entry) !== undefined).map(
    (entry) => entry.provider,
  );
}

function lookupProviderEnvVar(entry: {
  provider: RouterProviderName;
  customEnvVar?: () => string | null;
}): string | undefined {
  if (entry.customEnvVar) {
    return entry.customEnvVar() ?? undefined;
  }
  const envVars = findEnvKeys(entry.provider);
  return envVars && envVars.length > 0 ? envVars[0] : undefined;
}

/**
 * 与 resolveCliModel 相同的 selection logic，但选择每个 provider 更便宜的
 * observational-memory model。
 */
export function resolveCliMemoryModel(
  memoryModelName: string | undefined,
  dotenvKeys: Set<string>,
): ModelResolution {
  return resolveCliModelWith(
    memoryModelName,
    getMemoryModelCandidates(),
    dotenvKeys,
    DEFAULT_CLI_MEMORY_MODEL,
  );
}

/**
 * 解析面向用户的 model，并报告 provenance，以便调用方显示类似
 * “inferred from OPENROUTER_API_KEY in an env file”的信息。
 */
export function resolveCliModel(
  modelName: string | undefined,
  dotenvKeys: Set<string>,
  routingTable: RoutingTable = BUILT_IN_ROUTING_TABLE,
): ModelResolution {
  return resolveCliModelWith(
    modelName,
    getDefaultModelCandidates(),
    dotenvKeys,
    routingTable.defaultTier,
    routingTable,
  );
}

function resolveCliModelWith(
  modelName: string | undefined,
  providerInference: ProviderModelCandidate[],
  dotenvKeys: Set<string>,
  defaultModel: string,
  routingTable: RoutingTable = BUILT_IN_ROUTING_TABLE,
): ModelResolution {
  if (modelName) {
    if (isVirtualModel(modelName, routingTable)) {
      return { modelName, source: "explicit", routed: true };
    }
    if (isVirtualModel(modelName, BUILT_IN_ROUTING_TABLE)) {
      throw new Error(`Unknown virtual model tier "${modelName}" in the active routing table.`);
    }
    return {
      modelName:
        isProviderPinnedModelName(modelName) || resolveFamilyShorthand(modelName)
          ? modelName
          : canonicalizeModelName(modelName),
      source: "explicit",
    };
  }
  if (isVirtualModel(defaultModel, routingTable)) {
    return { modelName: defaultModel, source: "default", routed: true };
  }
  const inferred = findInferredProviderEntry(providerInference);
  if (inferred) {
    return {
      modelName: inferred.entry.modelName,
      source: "inferred",
      envVar: inferred.envVar,
      fromDotenv: dotenvKeys.has(inferred.envVar),
    };
  }
  return { modelName: defaultModel, source: "default" };
}

function findInferredProviderEntry(
  providerInference: readonly ProviderModelCandidate[],
): { entry: ProviderModelCandidate; envVar: string } | undefined {
  for (const entry of providerInference) {
    const provider = PROVIDER_ORDER.find((candidate) => candidate.provider === entry.provider);
    if (!provider) continue;

    const envVar = lookupProviderEnvVar(provider);
    if (envVar) return { entry, envVar };
  }
  return undefined;
}

function getDefaultModelCandidates(): ProviderModelCandidate[] {
  return PROVIDER_ORDER.map(({ provider }) => ({
    provider,
    modelName: getProviderDefaultModel(provider),
  }));
}

function getMemoryModelCandidates(): ProviderModelCandidate[] {
  return PROVIDER_ORDER.map(({ provider }) => ({
    provider,
    modelName: getProviderMemoryModel(provider),
  }));
}

interface ConnectedModelResolutionDependencies {
  snapshot(): ReturnType<typeof connectedTransportSnapshot>;
  apiKey(provider: ConnectedProviderId): string | undefined;
  applyHook<T extends { id: string }>(provider: ConnectedProviderId, model: T): T | undefined;
  refresh(provider: ConnectedProviderId): void;
}

const connectedModelResolutionDependencies: ConnectedModelResolutionDependencies = {
  snapshot: connectedTransportSnapshot,
  apiKey: connectedProviderApiKey,
  applyHook: applyConnectedModelHook,
  refresh: refreshConnectedTokenInBackground,
};

/** 通过已连接 plan 再按 router 顺序解析未固定的 catalog 名称。 */
export function resolveModelReference(
  modelName: string,
  deps: ConnectedModelResolutionDependencies = connectedModelResolutionDependencies,
): string {
  if (isProviderPinnedModelName(modelName)) return modelName;

  const transport = chooseTransport(modelName, deps.snapshot());
  if (transport.planCovered && isConnectedProviderId(transport.transport)) {
    const provider = transport.transport;
    if (deps.apiKey(provider)) {
      // account hook 可以过滤 plan 无法提供的 model（Copilot 的 availableModelIds）；
      // 被过滤的 model 会回退到 router 顺序。
      const spec = catalogModel(provider, transport.modelId);
      if (!spec || deps.applyHook(provider, spec)) {
        return `${provider}:${transport.modelId}`;
      }
    } else {
      // resolution 必须保持同步。cache miss 不能在这里等待，因此此调用保持现有 router 路径，
      // 同时让后台启动的合并 refresh 供后续 resolution 使用。
      deps.refresh(provider);
    }
  }

  return resolveRouterModelReference(modelName);
}

function resolveRouterModelReference(modelName: string): string {
  if (isProviderPinnedModelName(modelName)) return modelName;
  const inferred = findInferredProviderEntry(getModelCandidates(modelName));
  if (inferred) return inferred.entry.modelName;

  if (isKnownShorthand(modelName)) {
    throw new Error(`Model shorthand requires credentials for a supported provider: ${modelName}`);
  }

  throw new Error(`Unknown model shorthand: ${modelName}`);
}

export function describeModelResolution(resolution: ModelResolution): string {
  const routed = resolution.routed ? `${resolution.modelName} (routed) — ` : "";
  if (resolution.source === "explicit") return `${routed}explicit CLI flag`;
  if (resolution.source === "inferred") {
    const where = resolution.fromDotenv ? "an env file" : "shell environment";
    return `${routed}inferred from ${resolution.envVar} in ${where}`;
  }
  return resolution.routed
    ? `${routed}routing-table default`
    : "built-in default (no provider env vars set)";
}
