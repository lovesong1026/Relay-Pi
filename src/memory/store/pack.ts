import { estimateTokens } from "../observational.js";
import { mergeListings } from "./sources.js";
import { listStoreTolerant, type StoredMemory } from "./store.js";

/** 固定注入 Agent prompt 的精选文件 memory 独立上限。 */
export const PINNED_STORE_TOKEN_BUDGET = 15_000;

export interface LoadPinnedStorePackOptions {
  /** 按 collision precedence 排列的 store 目录，最近的在前。 */
  stores: readonly string[];
  /** file-backed 内容的独立上限，默认为 15,000 token。 */
  tokenBudget?: number;
}

export interface PinnedStorePack {
  /** collision resolution 和预算适配后保留的、从新到旧的条目。 */
  entries: StoredMemory[];
  /** 为满足上限而移除的完整旧条目数量。 */
  dropped: number;
}

/**
 * 加载精选文件 memory 的冻结、从新到旧视图。
 *
 * 格式错误的条目隔离在自己的文件中并发出警告，而不会让 Agent 启动失败。完整集合超过
 * 独立上限时，从最旧开始移除完整条目；保留最新条目，如果它单独就过大，则确定性地从
 * 尾部截断。
 */
export async function loadPinnedStorePack(
  options: LoadPinnedStorePackOptions,
): Promise<PinnedStorePack> {
  const tokenBudget = options.tokenBudget ?? PINNED_STORE_TOKEN_BUDGET;
  if (!Number.isFinite(tokenBudget) || tokenBudget < 0) {
    throw new Error(`Pinned store token budget must be a non-negative number: ${tokenBudget}`);
  }

  const listings = await Promise.all(
    options.stores.map(async (store) => ({
      source: store,
      entries: await loadStoreEntries(store),
    })),
  );
  const entries = mergeListings(listings, []);
  let totalTokens = entries.reduce((total, entry) => total + estimateTokens(entry.content), 0);
  let dropped = 0;
  let truncated = false;

  while (entries.length > 1 && totalTokens > tokenBudget) {
    const removed = entries.pop()!;
    totalTokens -= estimateTokens(removed.content);
    dropped += 1;
  }

  if (entries.length === 1 && totalTokens > tokenBudget) {
    entries[0] = {
      ...entries[0]!,
      content: truncateToTokenBudget(entries[0]!.content, tokenBudget),
    };
    truncated = true;
  }

  if (dropped > 0 || truncated) {
    const truncation = truncated ? " and truncated the newest entry" : "";
    const formattedBudget = tokenBudget.toLocaleString("en-US");
    console.warn(
      `[relay-pi] pinned memory store context exceeded ${formattedBudget}-token cap; dropped ${dropped} older memory ${dropped === 1 ? "entry" : "entries"}${truncation}.`,
    );
  }

  return { entries, dropped };
}

async function loadStoreEntries(store: string): Promise<StoredMemory[]> {
  try {
    return await listStoreTolerant(store, warnSkippedStore);
  } catch (error) {
    warnSkippedStore(store, error);
    return [];
  }
}

function truncateToTokenBudget(content: string, tokenBudget: number): string {
  let low = 0;
  let high = content.length;
  while (low < high) {
    const midpoint = Math.ceil((low + high) / 2);
    if (estimateTokens(content.slice(0, midpoint)) <= tokenBudget) low = midpoint;
    else high = midpoint - 1;
  }
  return content.slice(0, low);
}

function warnSkippedStore(path: string, error: unknown): void {
  const reason = error instanceof Error ? error.message : String(error);
  console.warn(`[relay-pi] skipped malformed memory store entry ${path}: ${reason}`);
}
