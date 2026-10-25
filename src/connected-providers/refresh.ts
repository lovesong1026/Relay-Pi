import { connectedProviders } from "./registry.js";
import type { ConnectedProviderId, OAuthCredentials } from "./store.js";

const OPENAI_TOKEN_URL = "https://auth.openai.com/oauth/token";
const OPENAI_CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const OPENAI_CODEX_SCOPE = "openid profile email";

type FetchToken = (input: string, init: RequestInit) => Promise<Response>;

/** 使用 provider 支持的 OAuth 流程刷新一组已连接 provider 凭据。 */
export async function refreshConnectedCredentials(
  provider: ConnectedProviderId,
  credentials: OAuthCredentials,
): Promise<OAuthCredentials> {
  if (provider === "github-copilot") {
    // pi-ai 的 OAuth 实现现在挂在各自的 provider 上，且
    // 交换通过 `refresh(credential, signal)` 而非 `refreshToken` 进行。
    const oauth = connectedProviders()
      .find((entry) => entry.id === provider)
      ?.oauth();
    if (!oauth) throw new Error(`OAuth provider is not registered: ${provider}`);
    return oauth.refresh({ ...credentials, type: "oauth" }, new AbortController().signal);
  }
  return refreshOpenAICodexCredentials(credentials.refresh);
}

/**
 * 使用 pi-ai 当前省略的 scope 刷新 ChatGPT 凭据。OpenAI
 * 会轮换刷新令牌，因此调用方必须用此完整结果替换已存储的凭据
 * 对象，而不是只修补 `access`。
 */
export async function refreshOpenAICodexCredentials(
  refreshToken: string,
  fetchImpl: FetchToken = (input, init) => fetch(input, init),
  now: () => number = Date.now,
): Promise<OAuthCredentials> {
  const response = await fetchImpl(OPENAI_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: OPENAI_CODEX_CLIENT_ID,
      scope: OPENAI_CODEX_SCOPE,
    }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `OpenAI Codex token refresh failed (${response.status}): ${detail || response.statusText}`,
    );
  }
  const value: unknown = await response.json();
  if (!isTokenResponse(value)) {
    throw new Error("OpenAI Codex token refresh response missing required fields");
  }
  const accountId = accountIdFromAccessToken(value.access_token);
  if (!accountId) throw new Error("Failed to extract accountId from refreshed OpenAI Codex token");
  return {
    access: value.access_token,
    refresh: value.refresh_token,
    expires: now() + value.expires_in * 1_000,
    accountId,
  };
}

interface OpenAITokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

function isTokenResponse(value: unknown): value is OpenAITokenResponse {
  if (value === null || typeof value !== "object") return false;
  const token = value as Record<string, unknown>;
  return (
    typeof token.access_token === "string" &&
    typeof token.refresh_token === "string" &&
    typeof token.expires_in === "number"
  );
}

function accountIdFromAccessToken(accessToken: string): string | undefined {
  try {
    const payload = accessToken.split(".")[1];
    if (!payload) return undefined;
    const decoded: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (decoded === null || typeof decoded !== "object") return undefined;
    const auth = (decoded as Record<string, unknown>)["https://api.openai.com/auth"];
    if (auth === null || typeof auth !== "object") return undefined;
    const accountId = (auth as Record<string, unknown>).chatgpt_account_id;
    return typeof accountId === "string" && accountId ? accountId : undefined;
  } catch {
    return undefined;
  }
}
