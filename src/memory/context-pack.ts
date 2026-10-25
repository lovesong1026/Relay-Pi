import type { ObservationalMemorySettings } from "../types/memory.js";
import { loadGlobalPack, loadLocalPack } from "./loader.js";
import { loadPinnedStorePack } from "./store/pack.js";
import type { MemorySession } from "./session.js";
import type { MemoryContextCache } from "./store.js";

/** 只刷新精选文件 memory，与数据库是否可用无关。 */
export async function rebuildPinnedStoreContextPack(options: {
  stores: readonly string[];
  cache: MemoryContextCache;
}): Promise<void> {
  const pack = await loadPinnedStorePack({ stores: options.stores });
  options.cache.setStoredContextPack(pack.entries);
}

/**
 * 压缩触发器：重建渲染在 message tail 之前的冻结 memory pack，然后将它存入运行器的
 * MemoryContextCache。
 *
 * 恰好以下三个 event 会触发刷新：
 *   1. `loadStoredMemory()` 完成——初始 seed。
 *   2. reflector 替换 observation——压缩视图发生变化。
 *   3. wire-shaping eviction horizon 前进——prompt cache 已经失效，因此顺便免费刷新。
 *
 * 其他路径（observer 在回合中途追加 row、recall_memory tool 返回 row）都刻意不刷新：
 * 前缀保持稳定，以保留 provider 的 prompt cache。
 *
 * 此处失败不是致命错误——缺失的数据库、planner 故障或损坏的 index 只会保留之前的 pack。
 * 运行器记录日志并继续；用户回合不会被 memory bookkeeping 阻塞。
 */
export async function rebuildMemoryContextPack(options: {
  session: MemorySession | undefined;
  cache: MemoryContextCache;
  settings: ObservationalMemorySettings;
  sessionId?: string;
}): Promise<void> {
  if (!options.session) return;

  // 一个 withDb 会在 global+local pack 查询期间固定打开状态，因此重建只需持有一次跨进程
  // lock；几秒后 idle-close timer 触发时再释放。
  await options.session.withDb(async (db) => {
    // 运行器没有 Session id 时跳过 local 层（一次性工具、测试）。global 层始终运行，
    // 因为 loader 的 `excludeSessionId` 可选，传入 undefined 也有明确含义。
    const [globalPack, localPack] = await Promise.all([
      loadGlobalPack(db, {
        ...(options.sessionId !== undefined ? { excludeSessionId: options.sessionId } : {}),
        tokenBudget: options.settings.globalContextTokenBudget,
        recencyHalfLifeMs: options.settings.recencyHalfLifeMs,
        reflectionBias: options.settings.reflectionBias,
        manualBias: options.settings.manualBias,
        noteBias: options.settings.noteBias,
      }),
      options.sessionId !== undefined
        ? loadLocalPack(db, { sessionId: options.sessionId })
        : Promise.resolve([]),
    ]);

    options.cache.setContextPack({ global: globalPack, local: localPack });
  });
}
