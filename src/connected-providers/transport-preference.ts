import {
  PROVIDER_ORDER,
  transportModelId,
  type RouterProviderName,
  type TransportName,
} from "../model-resolution/catalog.js";
import { CONNECTED_PROVIDER_ORDER, isConnectedProviderId, type ConnectionRecord } from "./store.js";

export interface TransportSnapshot {
  /** CLI 进程启动时存在的连接；后续存储改动在下次调用时生效。 */
  connections: readonly Pick<ConnectionRecord, "provider" | "eligibility">[];
  /**
   * 已配置凭据的路由 provider。存在时，按路由顺序
   * 选择会跳过未配置的路由器，使回退绝不会落到
   * 无法认证的后端。缺省表示“假定全部已配置”
   * （无论哪种情况，显式固定的选择都绕过此检查）。
   */
  configuredRouters?: readonly RouterProviderName[];
}

export interface TransportChoice {
  /** 被选中来承载所请求模型的后端。 */
  transport: TransportName;
  /** 在选定传输上发送的 provider 特定模型 id。 */
  modelId: string;
  /** 当调用由已连接订阅而非按量计费的路由器承载时为真。 */
  planCovered: boolean;
  /** 选中此传输的规则。 */
  reason: "connected" | "router_order" | "explicit_pin";
}

/** 从不可变的启动快照中选择传输，不读取环境变量或磁盘。 */
export function chooseTransport(shorthand: string, snapshot: TransportSnapshot): TransportChoice {
  const separator = shorthand.indexOf(":");
  if (separator !== -1) {
    const transport = shorthand.slice(0, separator) as TransportName;
    return {
      transport,
      modelId: shorthand.slice(separator + 1),
      planCovered: isConnectedProviderId(transport),
      reason: "explicit_pin",
    };
  }

  for (const provider of CONNECTED_PROVIDER_ORDER) {
    const connection = snapshot.connections.find((candidate) => candidate.provider === provider);
    if (!connection || connection.eligibility === "plan_ineligible") continue;
    const modelId = transportModelId(provider, shorthand);
    if (modelId) {
      return { transport: provider, modelId, planCovered: true, reason: "connected" };
    }
  }

  const routerConfigured = (provider: RouterProviderName): boolean =>
    snapshot.configuredRouters === undefined || snapshot.configuredRouters.includes(provider);
  for (const { provider } of PROVIDER_ORDER) {
    if (!routerConfigured(provider)) continue;
    const modelId = transportModelId(provider, shorthand);
    if (modelId) {
      return { transport: provider, modelId, planCovered: false, reason: "router_order" };
    }
  }

  // 未知名称保留 resolver.ts 的直通行为，直到它能
  // 产生已有的面向用户的 "Unknown model shorthand" 错误。
  return {
    transport: PROVIDER_ORDER[0]!.provider,
    modelId: shorthand,
    planCovered: false,
    reason: "router_order",
  };
}
