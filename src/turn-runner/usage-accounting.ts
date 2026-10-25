import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { usageForTransport } from "../connected-providers/billing.js";
import { isConnectedProviderId } from "../connected-providers/store.js";
import type { TransportName } from "../model-resolution/catalog.js";
import type { ModelUsageEntry, TurnTokenUsage } from "../types/protocol.js";

/**
 * 返回一个新的 `TurnTokenUsage`，其值等于 `a + b`；任一操作数为 `undefined` 时视为空用量。
 *
 * 纯函数：调用方必须使用返回值。早期的原地语义导致某些调用点丢弃返回值，却依赖通过共享
 * 引用修改累加器，使契约变得隐晦。
 */
export function addUsage(
  a: TurnTokenUsage | undefined,
  b: TurnTokenUsage | undefined,
): TurnTokenUsage | undefined {
  if (!a && !b) return undefined;
  if (!a) return cloneUsage(b!);
  if (!b) return cloneUsage(a);
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    totalTokens: a.totalTokens + b.totalTokens,
    cost: {
      input: a.cost.input + b.cost.input,
      output: a.cost.output + b.cost.output,
      cacheRead: a.cost.cacheRead + b.cost.cacheRead,
      cacheWrite: a.cost.cacheWrite + b.cost.cacheWrite,
      total: a.cost.total + b.cost.total,
    },
  };
}

/**
 * 返回一个新的按 model 划分的用量明细：将 `usage` 合并到 `model` 的条目中（通过 {@link addUsage}
 * 求和；model 尚不存在时追加）。纯函数：永不修改 `list`。falsy 的 `usage` 会返回 `list` 的
 * 未改变副本，因此只要同一 `usage` 也被合并到回合总量，就能保持不变量
 * `sum(result[].usage.cost.total) === addUsage(turnUsage, usage).cost.total`。
 */
export function addUsageByModel(
  list: readonly ModelUsageEntry[] | undefined,
  model: string,
  provider: TransportName,
  usage: TurnTokenUsage | undefined,
): ModelUsageEntry[] {
  const next: ModelUsageEntry[] = (list ?? []).map((entry) => ({
    model: entry.model,
    transport: { ...entry.transport },
    usage: cloneUsage(entry.usage),
  }));
  if (!usage) return next;
  const accountedUsage = usageForTransport(usage, provider);
  const existing = next.find(
    (entry) => entry.model === model && entry.transport.provider === provider,
  );
  if (existing) {
    existing.usage = addUsage(existing.usage, accountedUsage)!;
  } else {
    next.push({
      model,
      transport: {
        provider,
        billing: isConnectedProviderId(provider) ? "plan-covered" : "metered",
      },
      usage: cloneUsage(accountedUsage),
    });
  }
  return next;
}

function cloneUsage(usage: TurnTokenUsage): TurnTokenUsage {
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    totalTokens: usage.totalTokens,
    cost: { ...usage.cost },
  };
}

/**
 * 汇总每条携带用量的 assistant 消息中的 `Usage`。如果没有 assistant 消息贡献用量则返回
 * `undefined`，这样调用方可以区分“尚无用量”和“用量为零”。
 *
 * pi-ai 会为每次 assistant LLM 调用填充 `usage`；pi 没有回合结束时的聚合信号，因此按消息
 * 求和是回合总用量的规范路径。
 */
export function usageFromMessages(messages: readonly AgentMessage[]): TurnTokenUsage | undefined {
  let usage: TurnTokenUsage | undefined;
  for (const message of messages) {
    if (!isAssistantMessageWithUsage(message)) continue;
    usage = addUsage(usage, message.usage);
  }
  return usage;
}

function isAssistantMessageWithUsage(
  message: AgentMessage,
): message is AgentMessage & { usage: TurnTokenUsage } {
  return (
    typeof message === "object" &&
    message !== null &&
    "role" in message &&
    message.role === "assistant" &&
    "usage" in message &&
    typeof message.usage === "object" &&
    message.usage !== null
  );
}
