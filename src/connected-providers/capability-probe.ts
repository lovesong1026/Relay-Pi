import { missingCatalogModels } from "../model-resolution/provider-catalog.js";
import { complete } from "@earendil-works/pi-ai/compat";
import {
  type Api,
  type AssistantMessage,
  type Context,
  type Model,
  type ProviderStreamOptions,
} from "@earendil-works/pi-ai";
import type { OAuthCredentials } from "@earendil-works/pi-ai/oauth";
import { transportModelIds } from "../model-resolution/catalog.js";
import { connectedProviders } from "./registry.js";
import type { ConnectedProviderId, ConnectionEligibility } from "./store.js";

const CHATGPT_PROBE_MODEL_ID = "gpt-6-luna";

export interface CapabilityProbeResult {
  /** 此账户是否可承载订阅覆盖的模型流量。 */
  eligibility: ConnectionEligibility;
  /** 已连接账户可用的 provider 模型 id。 */
  servedModelIds: string[];
  /** 无法确认资格时给出的稳定且已脱敏的原因。 */
  detail?: string;
}

export interface CapabilityProbeDependencies {
  /** 在测试中由确定性 HTTP 状态 fixture 替换的补全调用边界。 */
  complete?: (
    model: Model<Api>,
    context: Context,
    options?: ProviderStreamOptions,
  ) => Promise<AssistantMessage>;
}

export async function probeConnectedProvider(
  id: ConnectedProviderId,
  credentials: OAuthCredentials,
  deps: CapabilityProbeDependencies = {},
): Promise<CapabilityProbeResult> {
  const entry = connectedProviders().find((candidate) => candidate.id === id);
  if (!entry) return unknown("Provider is not registered.");
  const oauth = entry.oauth();
  const credential = { ...credentials, type: "oauth" as const };

  // provider 负责自己的模型列表：配置的模拟签发方代替
  // 整个 provider，其模型带有 fixture 的 baseUrl/transport。
  const provider = entry.provider();
  const shipped = provider.getModels();
  const catalog = [...shipped, ...missingCatalogModels(id, shipped)];
  // 账户特定的可用性由 provider 而非 OAuth
  // 实现负责：不符合资格的 Copilot 计划会过滤掉所有模型。
  const available = provider.filterModels?.(catalog, credential) ?? catalog;
  const servedModelIds =
    id === "openai-codex" ? transportModelIds("openai-codex") : available.map((model) => model.id);
  const copilotHasNoModels = id === "github-copilot" && hasEmptyAvailableModelIds(credentials);
  // 不符合资格的 Copilot 账户会过滤掉所有模型。仍使用目录中的基础模型探测，
  // 使 connect 依然执行传输并观察其 stop=error。
  const model = selectProbeModel(id, available.length > 0 ? available : catalog);
  if (!model) return unknown("No probe model is available.");

  let responseStatus: number | undefined;
  try {
    const message = await (deps.complete ?? complete)(
      model,
      {
        systemPrompt: "Return one short token.",
        messages: [{ role: "user", content: "ok", timestamp: Date.now() }],
      },
      {
        apiKey: (await oauth.toAuth(credential)).apiKey,
        maxTokens: 1,
        onResponse: (response) => {
          responseStatus = response.status;
        },
      },
    );
    if (copilotHasNoModels) {
      return {
        eligibility: "plan_ineligible",
        servedModelIds: [],
        detail: "No models are available for this Copilot plan.",
      };
    }
    // pi-ai 传输以 stopReason "error" 呈现 HTTP 故障，而不是
    // 让 complete() 拒绝，因此此处也必须执行计费分类。
    if (message.stopReason === "error") return classifyFailure(responseStatus);
    return { eligibility: "eligible", servedModelIds };
  } catch (error) {
    return classifyFailure(responseStatus ?? errorStatus(error));
  }
}

/**
 * 只有已确认的计费拒绝才能将计划标记为不符合资格；认证失败、
 * 服务器错误和网络中断仍为 "unknown"，使暂时性故障
 * 绝不会持久化错误的资格判定。
 */
function classifyFailure(responseStatus: number | undefined): CapabilityProbeResult {
  if (responseStatus === 402) {
    return {
      eligibility: "plan_ineligible",
      servedModelIds: [],
      detail: "Provider plan does not cover the probe model.",
    };
  }
  return unknown(
    responseStatus === undefined
      ? "Capability probe request failed."
      : `Capability probe failed with HTTP ${responseStatus}.`,
  );
}

function errorStatus(error: unknown): number | undefined {
  if (error === null || typeof error !== "object" || !("status" in error)) return undefined;
  return typeof error.status === "number" ? error.status : undefined;
}

function selectProbeModel(
  id: ConnectedProviderId,
  available: readonly Model<Api>[],
): Model<Api> | undefined {
  if (id === "openai-codex") {
    const donor = available.find((model) => model.id === "gpt-5.4-mini") ?? available[0];
    return donor
      ? { ...donor, id: CHATGPT_PROBE_MODEL_ID, name: CHATGPT_PROBE_MODEL_ID }
      : undefined;
  }
  return available.reduce<Model<Api> | undefined>((cheapest, model) => {
    if (!cheapest) return model;
    return model.cost.input + model.cost.output < cheapest.cost.input + cheapest.cost.output
      ? model
      : cheapest;
  }, undefined);
}

function hasEmptyAvailableModelIds(credentials: OAuthCredentials): boolean {
  return Array.isArray(credentials.availableModelIds) && credentials.availableModelIds.length === 0;
}

function unknown(detail: string): CapabilityProbeResult {
  return { eligibility: "unknown", servedModelIds: [], detail };
}
