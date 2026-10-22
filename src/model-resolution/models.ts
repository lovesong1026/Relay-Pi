import type { MutableModels, Provider } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { StreamFn } from "@earendil-works/pi-agent-core";

import { connectedProviders } from "../connected-providers/registry.js";

/**
 * The model registry every dispatch goes through: pi-ai's built-in providers
 * and connected providers with Relay Pi's own credential path declared.
 *
 * The agent loop is handed a `StreamFn` rather than resolving a transport
 * itself, so this is the one place that decides who can serve a model.
 */
export function relayPiModels(): MutableModels {
  const models = builtinModels();
  for (const { id } of connectedProviders()) {
    const provider = models.getProvider(id);
    if (provider) models.setProvider(withRelayPiManagedAuth(provider));
  }
  return models;
}

/**
 * A connected provider, with the fact that Relay Pi holds its credential declared.
 *
 * Relay Pi stores and refreshes ChatGPT and Copilot tokens itself, in its own
 * store with its own eligibility rules, and hands the resolved token to each
 * request as `apiKey`. pi-ai only honors that override for a provider that
 * declares api-key auth, and `openai-codex` declares OAuth alone — so without
 * this every ChatGPT-connected turn is refused with "Provider is not
 * configured" before a request is ever built. A provider that already declares
 * api-key auth (Copilot) keeps its own, which derives a per-account baseUrl.
 */
function withRelayPiManagedAuth(provider: Provider): Provider {
  if (provider.auth.apiKey) return provider;
  return {
    ...provider,
    auth: {
      ...provider.auth,
      apiKey: {
        name: `${provider.name} (managed by Relay Pi)`,
        async resolve({ credential }) {
          const key = credential?.key;
          return key ? { auth: { apiKey: key }, source: "Relay Pi connected account" } : undefined;
        },
      },
    },
  };
}

/**
 * Dispatch for the agent loop. The model object carries its own provider,
 * baseUrl and tier headers by the time it arrives here, so this only has to
 * pick the transport the model declares.
 */
export const relayPiStreamFn: StreamFn = (model, context, options) =>
  relayPiModels().streamSimple(model, context, options);
