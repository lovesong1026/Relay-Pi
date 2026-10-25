import type { OAuthAuth, Provider } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { fakeConnectedProvider } from "./fake-issuer.js";
import type { ConnectedProviderId } from "./store.js";

export interface ConnectedProviderEntry {
  /** pi-ai 和凭据存储使用的稳定传输 id。 */
  id: ConnectedProviderId;
  /** 面向用户的订阅名称。 */
  label: string;
  /** `relay-pi connect` 接受的简短 CLI 值。 */
  alias: string;
  /** 此 provider 可运行的登录模式；VM 中仅设备码有效。 */
  loginModes: readonly ("device_code" | "browser")[];
  /** 解析当前启用的 pi-ai 实现，包括由环境变量控制的模拟签发方。 */
  oauth(): OAuthAuth;
  /**
   * 完整的 pi-ai provider。模型可用性现在由 provider
   * （`filterModels`）而非 OAuth 实现负责，因此调用方要
   * 查询“此账户可用哪些模型”时需要它，而不只是 `oauth()`。
   */
  provider(): Provider;
}

/**
 * OAuth 实现挂在使用它的模型 provider 上，因此从
 * 内置 provider 列表中读取，而不是按 id 查找。这使得
 * 此处成为配置的模拟签发方的唯一替换点，所有通过注册表的
 * 调用方都能看到这一替换。
 */
function piProvider(id: ConnectedProviderId): Provider {
  const provider =
    fakeConnectedProvider(id) ?? builtinProviders().find((candidate) => candidate.id === id);
  if (!provider) throw new Error(`OAuth provider is not registered: ${id}`);
  return provider;
}

function oauthProvider(id: ConnectedProviderId): OAuthAuth {
  const oauth = piProvider(id).auth.oauth;
  if (!oauth) throw new Error(`OAuth provider is not registered: ${id}`);
  return oauth;
}

const CONNECTED_PROVIDERS: readonly ConnectedProviderEntry[] = [
  {
    id: "openai-codex",
    label: "ChatGPT",
    alias: "chatgpt",
    loginModes: ["device_code", "browser"],
    oauth: () => oauthProvider("openai-codex"),
    provider: () => piProvider("openai-codex"),
  },
  {
    id: "github-copilot",
    label: "GitHub Copilot",
    alias: "copilot",
    loginModes: ["device_code"],
    oauth: () => oauthProvider("github-copilot"),
    provider: () => piProvider("github-copilot"),
  },
];

export function connectedProviders(): readonly ConnectedProviderEntry[] {
  return CONNECTED_PROVIDERS;
}

export function resolveConnectedProviderAlias(input: string): ConnectedProviderId | undefined {
  return CONNECTED_PROVIDERS.find(({ id, alias }) => input === id || input === alias)?.id;
}
