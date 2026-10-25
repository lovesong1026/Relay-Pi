import type { MutableModels, Provider } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { StreamFn } from "@earendil-works/pi-agent-core";

import { connectedProviders } from "../connected-providers/registry.js";

/**
 * 每次分派都会经过的模型注册表：pi-ai 的内置 provider，
 * 以及声明了 Relay Pi 自有凭据路径的已连接 provider。
 *
 * agent 循环接收 `StreamFn`，而非自行解析传输方式，
 * 因此这里是决定谁能提供某个模型的唯一位置。
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
 * 已连接的 provider，声明其凭据由 Relay Pi 持有。
 *
 * Relay Pi 使用自有存储和资格规则自行存储并刷新 ChatGPT
 * 和 Copilot token，并将解析后的 token 作为 `apiKey` 传给每个
 * 请求。pi-ai 仅对声明了 api-key 认证的 provider 采用该覆盖值，
 * 而 `openai-codex` 只声明 OAuth——因此，没有此处理时，
 * 每个连接 ChatGPT 的回合都会在构建请求之前以 "Provider is not
 * configured" 被拒绝。已经声明 api-key 认证的 provider
 *（Copilot）保留其自有认证，以便派生每个账户的 baseUrl。
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
 * agent 循环的分派入口。模型对象到达这里时已携带自身的 provider、
 * baseUrl 和层级请求头，因此这里只需
 * 选择模型声明的传输方式。
 */
export const relayPiStreamFn: StreamFn = (model, context, options) =>
  relayPiModels().streamSimple(model, context, options);
