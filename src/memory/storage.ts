import { DEFAULT_RELAY_PI_HOME } from "./paths.js";
import { join } from "node:path";
import type { PGlite, Transaction } from "@electric-sql/pglite";
import type { Observation, ObservationalMemorySettings } from "../types/memory.js";
import { EMBEDDING_BATCH_LIMIT, type EmbedFn } from "./embedding.js";
import {
  backfillNewestEmbeddings,
  embedAndPersistObservations,
  EmbeddingBackfillWorker,
} from "./embedding-worker.js";
import { rebuildMemoryContextPack } from "./context-pack.js";
import { createMemoryId } from "./id.js";
import { runMigrations } from "./migrations.js";
import { estimateTokens } from "./observational.js";
import { MemorySession } from "./session.js";
import type { MemoryContextCache } from "./store.js";

/**
 * `loadStoredMemory` 同步启动步骤（eager open-probe 和复用 open 的 backfill/context-pack build）
 * 的 lock-wait budget。刻意远短于 Session 默认的 30s open-lock budget：peer relay-pi 进程持有
 * 跨进程 lock 时，启动必须在几秒内退化到 async path，而不是每个 init step 都等待完整 budget，
 * 让首回合阻塞。steady-state write path 保留完整 default，使合法的回合中途 burst 仍能等待轮到它。
 */
const INIT_LOCK_WAIT_BUDGET_MS = 5_000;

/**
 * `loadStoredMemory` 返回的 handle。调用方将 `session` 传给 storage helper；每个 helper 只在
 * 执行 query 的时间内打开底层 PGlite handle，然后交还给 idle-close timer，使 peer relay-pi CLI
 * 能在 burst 之间获取跨进程 lock。禁用 memory persistence 时 `session` 为 undefined。
 */
export interface MemoryPersistenceHandle {
  session: MemorySession | undefined;
  embed: EmbedFn | undefined;
  dispose: () => Promise<void>;
}

export interface LoadStoredMemoryOptions {
  embed?: EmbedFn;
  embeddingLogPath?: string;
  /** 在首次 turn dispatch 前，将初始 context pack 冻结到 cache。 */
  contextPack?: {
    cache: MemoryContextCache;
    settings: ObservationalMemorySettings;
    sessionId?: string;
  };
  /**
   * 当配置路径的 memory database 无法打开并被移到一旁、以便从 fresh 状态启动时调用。
   * `backupPath` 是 `<path>.corrupted-<iso-timestamp>` 目录，之前的内容现位于其中；`cause`
   * 是触发 quarantine 的底层错误。调用方通常会展示面向用户的 system event，使已有 memory
   * 的丢失不会静默发生。
   */
  onRecover?: (info: { backupPath: string; cause: unknown }) => void;
  /**
   * 当 `withDb` 调用因在 wait budget 内无法获取跨进程 open-lock 而跳过时调用一次。Runner 将其
   * 展示为单条面向用户的 system warning，使两个并发 relay-pi CLI 可以共存（一个退化为无
   * memory），且不会为每个 skipped op spam UI。
   */
  onWarn?: (message: string) => void;
}

export async function loadStoredMemory(
  memoryPath: string | false | undefined,
  cwd: string,
  options: LoadStoredMemoryOptions = {},
): Promise<MemoryPersistenceHandle> {
  if (!memoryPath) {
    const noop = async () => {};
    return { session: undefined, embed: undefined, dispose: noop };
  }

  const resolvedPath = resolveMemoryPath(memoryPath, cwd);
  const session = new MemorySession({
    path: resolvedPath,
    openOptions: {
      // Migration 同时充当 corruption probe：runMigrations 内的失败会穿过 openPGlite 的 try block，
      // 将目录移到一旁并从 fresh 状态启动，而不是让 Agent 被不透明的 PGlite abort 卡住。
      init: async (db) => {
        await runMigrations(db);
      },
      ...(options.onRecover ? { onRecover: options.onRecover } : {}),
    },
    ...(options.onWarn ? { onWarn: options.onWarn } : {}),
  });

  // backfill worker 负责有界 startup catch-up 未覆盖的 embedding backlog，然后一直停止，直到
  // write kick 它：observer 和 reflector 在回合中写 row，write helper 调用 `session.notifyWrite()`，
  // embedding 在后台数秒内落库。没有 `embed` option 时跳过 worker，是测试和不调用 recall_memory
  // 的一次性工具的有意设计。
  const worker = options.embed
    ? new EmbeddingBackfillWorker({
        session,
        embed: options.embed,
        logPath: options.embeddingLogPath ?? defaultEmbeddingLogPath(),
      })
    : undefined;
  if (worker) {
    session.onWrite(() => worker.kick());
  }

  // Eager probe：在启动时打开并运行一次 migration。这样保留旧 eager loader 的“corruption 快速
  // 失败”特性（不可读 dataDir 会 quarantine 并在任何 turn dispatch 前调用 onRecover），又不
  // 改变 steady-state lazy-open 行为。之后 handle 会在 2s 内 idle-close，除非下面的 contextPack
  // 先抓住它。
  //
  // 这里使用短 lock-wait budget，而不是 Session default（30s）：如果 peer relay-pi 进程持有
  // 跨进程 open-lock，此 probe 以及复用其 open 的 backfill/context-pack step 必须在几秒内退化，
  // 不能串联多个完整 30s wait，让首回合挂起数分钟。忙碌 peer 下 probe 返回 undefined；随后跳过
  // follow-on init step（backfill catch-up 和 initial context-pack build，它们只会再次阻塞同一个
  // lock），将其推迟到 async worker + 后续 compaction。（这不同于 quarantine recovery：probe
  // 在 fresh dataDir 上成功，后续 step 会正常运行；这里只是跳过。）steady-state write path 保留完整 budget。
  const probed = await session.withDb(async () => true, {
    lockWaitBudgetMs: INIT_LOCK_WAIT_BUDGET_MS,
  });

  // 在 worker 启动前（且首回合 dispatch 前）做有界同步 catch-up：为仍缺 vector 的最新 row 做
  // embedding，使无 embedding flow 写入的 memory（embedding 关闭时的 `relay-pi memory add` /
  // `relay-pi train`）能在第一回合就进行 semantic recall，而不是等 async drain 到达。限制为
  // 一次 embedding HTTP request；更深的 backlog 由 worker 负责。Best-effort：失败（无 API key、
  // endpoint down）时由 worker retry loop 接管。probe 无法获取 lock 时跳过；peer 释放后 worker
  // 会接手 backlog。
  if (probed && options.embed) {
    try {
      await backfillNewestEmbeddings(session, options.embed, EMBEDDING_BATCH_LIMIT);
    } catch {
      // 退化到 async backfill path；worker 会记录原因。
    }
  }
  worker?.start();

  if (probed && options.contextPack) {
    // 初始 compaction trigger：在首回合 dispatch 前冻结渲染后的 memory pack，使 prefix 从
    // 第 1 回合而不是第 2 回合起就稳定。上面的 probe 已运行 migration；2s idle-close window
    // 意味着 rebuild 通常复用同一次 open。这里失败不是致命错误：pack 保持为空，runner 之后可
    // 再触发刷新。
    try {
      await rebuildMemoryContextPack({
        session,
        cache: options.contextPack.cache,
        settings: options.contextPack.settings,
        ...(options.contextPack.sessionId !== undefined
          ? { sessionId: options.contextPack.sessionId }
          : {}),
      });
    } catch {
      // Pack build 失败；在下一次 compaction trigger 刷新之前，渲染 memory 为空。这里静默记录，
      // 因为调用方不需要在 startup 中途收到噪音。
    }
  }

  const dispose = async () => {
    await worker?.stop();
    await session.dispose();
  };
  return { session, embed: options.embed, dispose };
}

function defaultEmbeddingLogPath(): string {
  return join(DEFAULT_RELAY_PI_HOME, "logs", "memory-backfill.log");
}

/**
 * 插入新的 observation row，同时物化 `id`、`createdAt` 和 `lastUsedAt = createdAt`。返回填充
 * 完整的 `Observation`，使调用方可以引用刚分配的 id（例如保持 observation-group range marker
 * 一致）。跨进程 lock 在 Session wait budget 内无法获取时返回 `undefined`——此时静默丢弃 write，
 * 以免并发 relay-pi CLI 使前台回合崩溃。
 *
 * 设置 `options.embed` 时，在同一次 open 中同步写入 row 的 embedding，因此函数返回的瞬间
 * memory 就能 vector-recall。一次性 CLI writer（`relay-pi memory add`、`relay-pi train`）会传入
 * 它，因为它们的进程不运行 backfill worker；否则 row 会保持 keyword-only，直到之后的 runner
 * 排空 backlog。Embedding 失败不会让 write 失败：row 仍会落库，下一次 backfill pass 会处理它。
 */
export async function appendObservation(
  session: MemorySession,
  input: Omit<Observation, "id" | "createdAt" | "lastUsedAt">,
  options: { embed?: EmbedFn } = {},
): Promise<Observation | undefined> {
  const observation: Observation = {
    ...input,
    id: createMemoryId(),
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
  };
  const result = await session.withDb(async (db) => {
    await upsertObservation(db, observation);
    if (options.embed) {
      try {
        await embedAndPersistObservations(
          db,
          [{ id: observation.id, content: observation.content }],
          options.embed,
        );
      } catch {
        // Embedding 不可用（无 key、rate limit 耗尽、endpoint down）。Observation row 已经落库；
        // 下面的 notifyWrite 会 kick 正在运行的 backfill worker，startup catch-up 会覆盖只有 CLI 的流程。
      }
    }
    return observation;
  });
  if (result) session.notifyWrite();
  return result;
}

/**
 * 用给定 list 替换此 Session 的 row。Reflection 使用它将 Session 的 observation log 压缩为一条
 * reflection row。将删除限定为 `session_id = $1` 使跨 Session global pool 可持久化：当前 Session
 * 的 reflection 永远不会触碰其他 Session 的 row。无法获取跨进程 lock 时无操作。
 */
export async function replaceSessionObservations(
  session: MemorySession,
  sessionId: string,
  observations: readonly Observation[],
): Promise<void> {
  const ids = observations.map((observation) => observation.id);
  const wrote = await session.withDb(async (db) => {
    await db.transaction(async (tx) => {
      if (ids.length === 0) {
        await tx.query("DELETE FROM observations WHERE session_id = $1", [sessionId]);
      } else {
        await tx.query(
          "DELETE FROM observations WHERE session_id = $1 AND NOT (id = ANY($2::text[]))",
          [sessionId, ids],
        );
      }
      for (const observation of observations) {
        await upsertObservation(tx, observation);
      }
    });
    return true;
  });
  // 纯 delete 不需要 embedding work，因此只有 upsert row 才 kick backfill worker。
  if (wrote && observations.length > 0) session.notifyWrite();
}

/**
 * 按时间顺序读取此 Session 的 observation，并附带粗略 token count。Observer 用它根据
 * Session-local observation token 累积值决定是否触发 reflection；`getUnobservedMessageTail` 用
 * 它找出已折叠进 observation-group range 的最大 message id。跨进程 lock 无法获取时返回空快照。
 */
export interface SessionObservationsSnapshot {
  observations: Observation[];
  estimatedObservationTokens: number;
}

/**
 * 读取持久化 store 中的每个 observation，不论 Session id，按时间顺序排列。跨 Session reflect
 * command（`relay-pi memory reflect`）使用它，将整个 global pool 压缩为一条 reflection row。
 * 跨进程 lock 无法获取时返回空快照。
 */
export async function readAllObservations(
  session: MemorySession,
): Promise<SessionObservationsSnapshot> {
  const result = await session.withDb(async (db) => {
    const queryResult = await db.query<ObservationRow>(
      `SELECT id, created_at, last_used_at, session_id, kind, observed_date, referenced_date,
              relative_date, time_of_day, priority, source_json, content, tags_json
       FROM observations
       ORDER BY created_at ASC`,
    );
    const observations = queryResult.rows.map(rowToObservation);
    return {
      observations,
      estimatedObservationTokens: estimateTokens(
        observations.map((observation) => observation.content).join("\n"),
      ),
    };
  });
  return result ?? { observations: [], estimatedObservationTokens: 0 };
}

/**
 * 用给定 list 替换整个 observation pool（跨所有 Session）。`reflectAllObservations`（跨 Session
 * reflect）是唯一合法调用方。Session-scoped reflection 使用 `replaceSessionObservations`，因此
 * 不会销毁其他 Session 的 row。无法获取跨进程 lock 时无操作。
 */
export async function replaceAllObservations(
  session: MemorySession,
  observations: readonly Observation[],
): Promise<void> {
  const ids = observations.map((observation) => observation.id);
  const wrote = await session.withDb(async (db) => {
    await db.transaction(async (tx) => {
      if (ids.length === 0) {
        await tx.query("DELETE FROM observations");
      } else {
        await tx.query("DELETE FROM observations WHERE NOT (id = ANY($1::text[]))", [ids]);
      }
      for (const observation of observations) {
        await upsertObservation(tx, observation);
      }
    });
    return true;
  });
  if (wrote && observations.length > 0) session.notifyWrite();
}

export async function readSessionObservations(
  session: MemorySession,
  sessionId: string,
): Promise<SessionObservationsSnapshot> {
  const result = await session.withDb(async (db) => {
    const queryResult = await db.query<ObservationRow>(
      `SELECT id, created_at, last_used_at, session_id, kind, observed_date, referenced_date,
              relative_date, time_of_day, priority, source_json, content, tags_json
       FROM observations
       WHERE session_id = $1
       ORDER BY created_at ASC`,
      [sessionId],
    );
    const observations = queryResult.rows.map(rowToObservation);
    return {
      observations,
      estimatedObservationTokens: estimateTokens(
        observations.map((observation) => observation.content).join("\n"),
      ),
    };
  });
  return result ?? { observations: [], estimatedObservationTokens: 0 };
}

/**
 * 将给定 id 的 `last_used_at` bump 到 `now`。Fire-and-forget usage signal：如果 model 的 response
 * 依赖某条 memory，该 memory 的 ranking 会刷新，从而继续浮现。`ids` 为空，或无法获取跨进程
 * lock 时无操作。
 */
export async function bumpLastUsed(
  session: MemorySession,
  ids: readonly string[],
  now: number,
): Promise<void> {
  if (ids.length === 0) return;
  await session.withDb(async (db) => {
    await db.query("UPDATE observations SET last_used_at = $1 WHERE id = ANY($2::text[])", [
      now,
      ids,
    ]);
  });
}

async function upsertObservation(
  database: Pick<PGlite, "query"> | Transaction,
  observation: Observation,
): Promise<void> {
  await database.query(
    `INSERT INTO observations (
      id, created_at, last_used_at, session_id, kind, observed_date, referenced_date, relative_date, time_of_day,
      priority, source_json, content, tags_json
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
    ON CONFLICT (id) DO UPDATE SET
      created_at = EXCLUDED.created_at,
      last_used_at = EXCLUDED.last_used_at,
      session_id = EXCLUDED.session_id,
      kind = EXCLUDED.kind,
      observed_date = EXCLUDED.observed_date,
      referenced_date = EXCLUDED.referenced_date,
      relative_date = EXCLUDED.relative_date,
      time_of_day = EXCLUDED.time_of_day,
      priority = EXCLUDED.priority,
      source_json = EXCLUDED.source_json,
      content = EXCLUDED.content,
      tags_json = EXCLUDED.tags_json`,
    [
      observation.id,
      observation.createdAt,
      observation.lastUsedAt,
      observation.sessionId ?? null,
      observation.kind,
      observation.observedDate,
      observation.referencedDate ?? null,
      observation.relativeDate ?? null,
      observation.timeOfDay ?? null,
      observation.priority,
      JSON.stringify(observation.source),
      observation.content,
      JSON.stringify(observation.tags),
    ],
  );
}

function resolveMemoryPath(path: string, cwd: string): string {
  return path.startsWith("/") ? path : join(cwd, path);
}

interface ObservationRow {
  id: string;
  created_at: number;
  last_used_at: number;
  session_id: string | null;
  kind: Observation["kind"];
  observed_date: string;
  referenced_date: string | null;
  relative_date: string | null;
  time_of_day: string | null;
  priority: Observation["priority"];
  source_json: string;
  content: string;
  tags_json: string;
}

function rowToObservation(row: ObservationRow): Observation {
  return {
    id: row.id,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    ...(row.session_id !== null ? { sessionId: row.session_id } : {}),
    kind: row.kind,
    observedDate: row.observed_date,
    ...(row.referenced_date !== null ? { referencedDate: row.referenced_date } : {}),
    ...(row.relative_date !== null ? { relativeDate: row.relative_date } : {}),
    ...(row.time_of_day !== null ? { timeOfDay: row.time_of_day } : {}),
    priority: row.priority,
    source: JSON.parse(row.source_json) as Observation["source"],
    content: row.content,
    tags: JSON.parse(row.tags_json) as string[],
  };
}
