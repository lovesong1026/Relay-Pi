import type { TransportName } from "../model-resolution/catalog.js";
import type { ConnectedProviderId } from "./store.js";

export type TransportFallbackCause = "plan_exhausted" | "auth_failed" | "transport_error";

/** 统一维护已连接调用回退时向用户显示的那一句提示。 */
export function transportFallbackNotice(input: {
  provider: ConnectedProviderId;
  modelName: string;
  fallbackTransport: TransportName;
  cause: TransportFallbackCause;
}): string {
  const provider = input.provider === "openai-codex" ? "ChatGPT" : "Copilot";
  const reason =
    input.cause === "plan_exhausted"
      ? "plan limit hit"
      : input.cause === "auth_failed"
        ? "connection needs attention"
        : "plan transport unavailable";
  return `${provider} ${reason} for ${input.modelName} — continuing on ${transportLabel(input.fallbackTransport)}.`;
}

function transportLabel(transport: TransportName): string {
  if (transport === "openrouter") return "OpenRouter";
  return transport === "openai-codex" ? "ChatGPT plan" : "Copilot plan";
}
