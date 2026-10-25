import type { Model, OAuthCredential, Provider } from "@earendil-works/pi-ai";
import { createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import type { OAuthCredentials } from "@earendil-works/pi-ai/oauth";
import type { ConnectedProviderId } from "./store.js";

export const FAKE_ISSUER_ENV = "RELAY_PI_CONNECT_FAKE_ISSUER_URL";

/** 客户端和签发方一致性测试共同导入的具体 RFC-8628 契约。 */
export const FAKE_ISSUER_WIRE_TABLE = {
  deviceCode: {
    method: "POST",
    path: "/device/code",
    request: { client_id: "relay-pi:openai-codex", scope: "openid profile email" },
    response: {
      device_code: "fixture-device-code",
      user_code: "ABCD-EFGH",
      verification_uri: "https://issuer.test/device",
      interval: 1,
      expires_in: 600,
    },
  },
  pendingToken: {
    method: "POST",
    path: "/token",
    request: {
      device_code: "fixture-device-code",
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    },
    response: { status: "pending" },
  },
  approvedToken: {
    method: "POST",
    path: "/token",
    request: {
      device_code: "fixture-device-code",
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    },
    response: {
      access_token: "fixture-access-token",
      refresh_token: "fixture-refresh-token",
      expires_in: 3600,
      account_id: "fixture-account",
    },
  },
  refreshToken: {
    method: "POST",
    path: "/token",
    request: { refresh_token: "fixture-refresh-token", grant_type: "refresh_token" },
    response: {
      access_token: "fixture-rotated-access-token",
      refresh_token: "fixture-rotated-refresh-token",
      expires_in: 3600,
      account_id: "fixture-account",
    },
  },
} as const;

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  interval: number;
  expires_in: number;
}

interface TokenResponse {
  status?: "pending" | "slow_down" | "denied" | "expired";
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  account_id?: string;
}

let installedBaseUrl: string | undefined;
let installedProviders: readonly Provider[] | undefined;

/**
 * 配置模拟签发方时，将已连接 provider 注册表
 * 指向它。
 *
 * OAuth 实现挂在使用它的 provider 上，因此代替
 * 真实签发方就意味着代替整个 provider：
 * `connectedProviders()` 会读取此处发布的实现，而不是内置
 * 实现。使用读取而非全局修改，才能让替换在
 * 消费它的边界处保持可见。
 */
export function installFakeIssuerIfConfigured(
  env: Record<string, string | undefined> = process.env,
): "installed" | "skipped" {
  const configured = env[FAKE_ISSUER_ENV]?.trim();
  if (!configured) return "skipped";
  const baseUrl = configured.replace(/\/+$/, "");
  if (installedBaseUrl !== baseUrl || !installedProviders) {
    installedBaseUrl = baseUrl;
    installedProviders = [
      createFakeProvider("openai-codex", "ChatGPT", baseUrl),
      createFakeProvider("github-copilot", "GitHub Copilot", baseUrl),
    ];
  }
  return "installed";
}

/** 清除已安装的模拟实现，避免一次测试的签发方泄漏到下一次。 */
export function resetFakeIssuer(): void {
  installedBaseUrl = undefined;
  installedProviders = undefined;
}

/** 替代 `id` 的模拟实现；未配置时为 undefined。 */
export function fakeConnectedProvider(id: ConnectedProviderId): Provider | undefined {
  return installedProviders?.find((provider) => provider.id === id);
}

function createFakeProvider(id: ConnectedProviderId, name: string, baseUrl: string): Provider {
  return createProvider({
    id,
    name,
    baseUrl,
    api: openAICompletionsApi(),
    // 被测签发方是一个普通的 OpenAI 兼容服务器，因此真实
    // provider 的模型通过它的传输承载，并关闭 fixture 无法
    // 提供的厂商扩展。
    models: getBuiltinModels(id as Parameters<typeof getBuiltinModels>[0]).map(
      (model): Model<"openai-completions"> => {
        const carried = model as Model<"openai-completions">;
        return {
          ...carried,
          api: "openai-completions",
          baseUrl,
          compat: {
            ...carried.compat,
            supportsStore: false,
            supportsDeveloperRole: false,
            supportsReasoningEffort: false,
          },
        };
      },
    ),
    auth: {
      oauth: {
        name,
        async login(interaction) {
          const device = await postJson<DeviceCodeResponse>(`${baseUrl}/device/code`, {
            client_id: `relay-pi:${id}`,
            scope: id === "openai-codex" ? "openid profile email" : "read:user",
          });
          interaction.notify({
            type: "device_code",
            userCode: device.user_code,
            verificationUri: device.verification_uri,
            intervalSeconds: device.interval,
            expiresInSeconds: device.expires_in,
          });
          const credentials = await pollFakeDeviceCode(baseUrl, device, interaction.signal);
          return { ...credentials, type: "oauth" };
        },
        async refresh(credential) {
          const token = await postJson<TokenResponse>(`${baseUrl}/token`, {
            refresh_token: credential.refresh,
            grant_type: "refresh_token",
          });
          return { ...credentialsFromToken(token, credential.refresh), type: "oauth" };
        },
        async toAuth(credential: OAuthCredential) {
          return { apiKey: credential.access, baseUrl };
        },
      },
    },
  });
}

/**
 * 模拟签发方的 RFC-8628 轮询——pending、slow_down、denied、expired。
 * 这就是一致性 fixture 验证的全部协议范围，因此
 * 在此明确实现，而不采用通用实现。
 */
async function pollFakeDeviceCode(
  baseUrl: string,
  device: DeviceCodeResponse,
  signal: AbortSignal,
): Promise<OAuthCredentials> {
  const deadline = Date.now() + (device.expires_in ?? 600) * 1000;
  let intervalMs = (device.interval ?? 1) * 1000;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    const result = tokenPollResult(
      await postJson<TokenResponse>(`${baseUrl}/token`, {
        device_code: device.device_code,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    );
    if (result.status === "complete") return result.value;
    if (result.status === "failed") throw new Error(result.message);
    if (result.status === "slow_down") intervalMs += 1000;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("Device login expired.");
}

function tokenPollResult(
  response: TokenResponse,
):
  | { status: "pending" | "slow_down" }
  | { status: "failed"; message: string }
  | { status: "complete"; value: OAuthCredentials } {
  if (response.status === "pending" || response.status === "slow_down") {
    return { status: response.status };
  }
  if (response.status === "denied") {
    return { status: "failed", message: "Device login denied." };
  }
  if (response.status === "expired") {
    return { status: "failed", message: "Device login expired." };
  }
  try {
    return { status: "complete", value: credentialsFromToken(response) };
  } catch {
    return { status: "failed", message: "Device token response was malformed." };
  }
}

function credentialsFromToken(response: TokenResponse, previousRefresh?: string): OAuthCredentials {
  if (
    typeof response.access_token !== "string" ||
    typeof response.expires_in !== "number" ||
    (typeof response.refresh_token !== "string" && previousRefresh === undefined)
  ) {
    throw new Error("Device token response was malformed.");
  }
  return {
    access: response.access_token,
    refresh: response.refresh_token ?? previousRefresh!,
    expires: Date.now() + response.expires_in * 1000,
    ...(response.account_id === undefined ? {} : { accountId: response.account_id }),
  };
}

async function postJson<T>(url: string, body: Record<string, string>): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Fake issuer request failed (${response.status}).`);
  return (await response.json()) as T;
}
