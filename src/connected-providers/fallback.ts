import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  chooseTransport,
  type TransportChoice,
  type TransportSnapshot,
} from "./transport-preference.js";
import { shorthandForTransportModel } from "../model-resolution/catalog.js";
import { isConnectedProviderId, type ConnectedProviderId } from "./store.js";
import type { TransportFallbackCause } from "./fallback-notice.js";

/** 仅对符合跨传输回退条件的故障分类。 */
export function connectedFallbackCause(
  message: AgentMessage | undefined,
): TransportFallbackCause | undefined {
  if (!message || message.role !== "assistant" || message.stopReason !== "error") return undefined;
  const error = message.errorMessage ?? "";
  if (/context|prompt is too long|token.*maximum/i.test(error)) return undefined;
  if (/\b401\b|\b403\b|unauthori[sz]ed|invalid.*(?:token|key)|authentication/i.test(error)) {
    return "auth_failed";
  }
  if (/\b402\b|\b429\b|usage limit|plan limit|quota|exhausted|not included/i.test(error)) {
    return "plan_exhausted";
  }
  return "transport_error";
}

/** 当连接故障因重放已不安全而必须终止时为真。 */
export function isPostOutputConnectedFailure(
  provider: string,
  message: AgentMessage | undefined,
  visibleOutput: boolean,
): boolean {
  return (
    visibleOutput &&
    isConnectedProviderId(provider) &&
    connectedFallbackCause(message) !== undefined
  );
}

/** 将失败的连接视为不符合资格后，选择下一个传输。 */
export function nextTransportAfterConnectedFailure(
  provider: ConnectedProviderId,
  modelId: string,
  snapshot: TransportSnapshot,
): TransportChoice | undefined {
  const shorthand = shorthandForTransportModel(provider, modelId);
  if (!shorthand) return undefined;
  const connections = snapshot.connections.some((connection) => connection.provider === provider)
    ? snapshot.connections.map((connection) =>
        connection.provider === provider
          ? { ...connection, eligibility: "plan_ineligible" as const }
          : connection,
      )
    : [...snapshot.connections, { provider, eligibility: "plan_ineligible" as const }];
  return chooseTransport(shorthand, { ...snapshot, connections });
}
