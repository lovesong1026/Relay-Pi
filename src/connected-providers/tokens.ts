import { normalizeSavedModelSelection } from "../model-resolution/catalog.js";
import { refreshConnectedCredentials } from "./refresh.js";
import { connectedProviders } from "./registry.js";
import {
  createConnectedProviderStore,
  type ConnectedProviderId,
  type ConnectedProviderStore,
  type ConnectionRecord,
  type OAuthCredentials,
} from "./store.js";

const REFRESH_SKEW_MS = 60_000;

export interface ConnectedTokenManager {
  /** 加载进程生命周期内的连接快照，并填入所有仍有效的访问令牌。 */
  loadSnapshot(): Promise<readonly ConnectionRecord[]>;
  /** 刷新启动快照中发现的所有可用 provider。 */
  ensureFreshTokens(): Promise<void>;
  /** 返回有效令牌，并合并此 provider 的并发刷新。 */
  ensureFreshToken(provider: ConnectedProviderId): Promise<string | undefined>;
  /** 从进程内缓存同步读取可用的访问令牌。 */
  apiKey(provider: ConnectedProviderId): string | undefined;
  /** 启动合并刷新，而不让同步调用方等待。 */
  refreshInBackground(provider: ConnectedProviderId): void;
  /** 同步读取 provider 已缓存的完整凭据集。 */
  credentials(provider: ConnectedProviderId): OAuthCredentials | undefined;
}

interface ConnectedTokenManagerOptions {
  /** 凭据的持久来源及跨进程刷新串行化机制。 */
  store: ConnectedProviderStore;
  /** 用于独立判断各 provider 是否过期的时钟。 */
  now?: () => number;
  /** provider 刷新边界，可注入以确保测试绝不调用真实 OAuth 签发方。 */
  refreshCredentials?: (
    provider: ConnectedProviderId,
    credentials: OAuthCredentials,
  ) => Promise<OAuthCredentials>;
}

type RefreshOutcome = { credentials: OAuthCredentials } | { error: unknown } | undefined;

/** 围绕已连接 provider 存储构建隔离的令牌缓存。 */
export function createConnectedTokenManager(
  options: ConnectedTokenManagerOptions,
): ConnectedTokenManager {
  const now = options.now ?? Date.now;
  const refreshCredentials = options.refreshCredentials ?? refreshConnectedCredentials;
  const cache = new Map<ConnectedProviderId, OAuthCredentials>();
  const refreshes = new Map<ConnectedProviderId, Promise<string | undefined>>();
  const pendingCatalogRefresh = new Set<ConnectedProviderId>();
  let bootConnections: readonly ConnectionRecord[] = [];

  const isFresh = (credentials: OAuthCredentials): boolean =>
    credentials.expires > now() + REFRESH_SKEW_MS;

  const ensureFreshToken = (provider: ConnectedProviderId): Promise<string | undefined> => {
    const active = refreshes.get(provider);
    if (active) return active;
    const cached = cache.get(provider);
    if (cached && isFresh(cached) && !pendingCatalogRefresh.has(provider)) {
      return Promise.resolve(cached.access);
    }

    const pending = options.store
      .withLock<RefreshOutcome>(provider, async (current) => {
        if (!current) return { result: undefined };
        // 在存储锁内重新检查：另一个进程可能已经
        // 刷新了账户模型列表。即使账户仍无法使用后继模型，也消耗
        // 本次尝试，使普通回合不会轮询。
        const refreshCatalog =
          pendingCatalogRefresh.delete(provider) &&
          hasRetiredModelAvailability(provider, current.credentials);
        if (isFresh(current.credentials) && !refreshCatalog) {
          return { next: current, result: { credentials: current.credentials } };
        }
        let credentials: OAuthCredentials;
        try {
          credentials = await refreshCredentials(provider, current.credentials);
        } catch (error) {
          if (!isRefreshAuthFailure(error)) throw error;
          return {
            next: {
              ...current,
              eligibility: "unknown",
              eligibilityCheckedAt: now(),
            },
            result: { error },
          };
        }
        const next: ConnectionRecord = { ...current, credentials, lastRefreshAt: now() };
        return { next, result: { credentials } };
      })
      .then((outcome) => {
        if (!outcome) {
          cache.delete(provider);
          return undefined;
        }
        if ("error" in outcome) throw outcome.error;
        const credentials = outcome.credentials;
        cache.set(provider, credentials);
        return credentials.access;
      })
      .finally(() => {
        if (refreshes.get(provider) === pending) refreshes.delete(provider);
      });
    refreshes.set(provider, pending);
    return pending;
  };

  return {
    async loadSnapshot() {
      bootConnections = await options.store.read();
      cache.clear();
      pendingCatalogRefresh.clear();
      for (const connection of bootConnections) {
        if (hasRetiredModelAvailability(connection.provider, connection.credentials)) {
          pendingCatalogRefresh.add(connection.provider);
        }
        if (isFresh(connection.credentials)) cache.set(connection.provider, connection.credentials);
      }
      return bootConnections;
    },
    async ensureFreshTokens() {
      await Promise.all(
        bootConnections
          .filter(({ eligibility }) => eligibility !== "plan_ineligible")
          // 签发方刷新失败会使此 provider 无缓存。同步
          // 模型解析随后按路由顺序调用，而不是
          // 在回退生效前就让 CLI 回合启动失败。
          .map(({ provider }) => ensureFreshToken(provider).catch(() => undefined)),
      );
    },
    ensureFreshToken,
    apiKey(provider) {
      const credentials = cache.get(provider);
      if (!credentials || !isFresh(credentials)) return undefined;
      return credentials.access;
    },
    refreshInBackground(provider) {
      void ensureFreshToken(provider).catch(() => undefined);
    },
    credentials(provider) {
      return cache.get(provider);
    },
  };
}

/** 有效令牌可能携带在模型家族后继版本发布前捕获的模型列表。 */
function hasRetiredModelAvailability(
  provider: ConnectedProviderId,
  credentials: OAuthCredentials,
): boolean {
  if (provider !== "github-copilot" || !Array.isArray(credentials.availableModelIds)) return false;
  const available = new Set(
    credentials.availableModelIds.filter((id): id is string => typeof id === "string"),
  );
  const prefix = `${provider}:`;
  return [...available].some((id) => {
    const current = normalizeSavedModelSelection(`${prefix}${id}`)?.slice(prefix.length);
    return current !== undefined && current !== id && !available.has(current);
  });
}

function isRefreshAuthFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b401\b|\b403\b|unauthori[sz]ed|invalid.*(?:token|grant)|authentication/i.test(message);
}

const connectedStore = createConnectedProviderStore();
const connectedTokens = createConnectedTokenManager({ store: connectedStore });

/**
 * 对已解析的规格执行 provider 的 OAuth 模型钩子。Copilot
 * 凭据会为企业账户重写端点，并过滤账户无法
 * 使用的模型；账户过滤掉该模型时返回 undefined，
 * 未加载凭据时返回未经钩子处理的规格。
 */
export function applyConnectedModelHook<T extends { id: string }>(
  provider: ConnectedProviderId,
  model: T,
): T | undefined {
  const credentials = connectedTokens.credentials(provider);
  if (!credentials) return model;
  // 账户特定的模型可用性由 provider 通过
  // `filterModels` 负责。
  const entry = connectedProviders().find((candidate) => candidate.id === provider);
  const filterModels = entry?.provider().filterModels;
  if (!filterModels) return model;
  const kept = filterModels([model as never], {
    ...credentials,
    type: "oauth",
  }) as unknown as T[];
  return kept.find((candidate) => candidate.id === model.id);
}

export function loadConnectedTokensSnapshot(): Promise<readonly ConnectionRecord[]> {
  return connectedTokens.loadSnapshot();
}

export function ensureFreshConnectedTokens(): Promise<void> {
  return connectedTokens.ensureFreshTokens();
}

export function connectedProviderApiKey(provider: ConnectedProviderId): string | undefined {
  return connectedTokens.apiKey(provider);
}

export function refreshConnectedTokenInBackground(provider: ConnectedProviderId): void {
  connectedTokens.refreshInBackground(provider);
}

/** 持久化需要重新连接的资格状态，而不删除或重写凭据。 */
export async function markConnectedProviderReconnectNeeded(
  provider: ConnectedProviderId,
): Promise<void> {
  await connectedStore.withLock(provider, async (current) => ({
    ...(current
      ? {
          next: {
            ...current,
            eligibility: "unknown" as const,
            eligibilityCheckedAt: Date.now(),
          },
        }
      : {}),
    result: undefined,
  }));
}
