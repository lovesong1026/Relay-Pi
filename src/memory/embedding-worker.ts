import type { PGlite, Transaction } from "@electric-sql/pglite";
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";
import type { EmbedFn } from "./embedding.js";
import type { MemorySession } from "./session.js";

/**
 * 填充缺失 embedding 的后台 worker。由 `loadStoredMemory()` 启动，用来排空之前运行留下的 backlog；之后由 event 驱动：
 * backlog 为空时停止，新的 observation 写入时由 storage write helper 重新 kick。绝不会阻塞
 * 回合：observer/reflector 可以写入新 row 后立即返回用户；embedding 在后台数秒内落库，
 * 之后该 row 就能通过 hybrid 检索。
 * 排空形状：
 *   1. 将未 embedding 的 row 按 `BATCH_SIZE` 分块排空，每个 chunk 使用自己的 `withDb`，直到 select 返回零 row。
 *      batch 之间 worker 调用 `relinquish()` 释放 memory Session——现在关闭 handle 并释放跨进程
 *      `.relay-pi-open.lock`，而不是等 idle-close timer——然后短暂暂停，让等待打开同一 memory.db 的
 *      peer relay-pi 进程先获得 lock，再由 worker 为下一批重新获取。这样 worker 不会在（可能很多批的）
 *      排空期间饿死前台 Session 的 turn-init。代价是 backlog 活跃排空时每批重新打开一次 WASM；
 *      这是短暂的后台工作，不同于下面刻意避免的永久 idle tick。
 *   2. 如果排空结果为空且期间没有收到 `kick()`，退出循环。刻意避免永久 idle tick：Session idle-close
 *      后每个 tick 都会重新打开一次 WASM Postgres；多个 Session 停在 sandbox 中时，这会让常驻 CLI
 *      持续消耗约 8% CPU。
 *   3. 如果唯一的未 embedding row 处于 per-id attempt cooldown，则在 `ATTEMPT_COOLDOWN_MS` 后重试，
 *      而不是退出，使 churn 的 row 最终仍会重新 embedding。
 *   4. 出错时（rate limit、transient network），等待 `ERROR_SLEEP_MS` 后退避重试。lock-busy 的
 *      `withDb` skip 在 `RETRY_SLEEP_MS` 后重试。
 *
 * 失败局部处理：循环内任何错误都会记录日志，并在退避后恢复。worker 绝不会向调用方抛出错误。
 */
const BATCH_SIZE = 50;
const DEFAULT_RETRY_SLEEP_MS = 10_000;
const DEFAULT_ERROR_SLEEP_MS = 60_000;
// worker 释放跨进程 lock 后，在 drain batch 之间暂停，让轮询同一 memory.db 的 peer relay-pi 进程
// 有机会在 worker 为下一批重新打开前获取 lock。相对于真实 embedding batch（一次 network
// round-trip）很短，几乎不影响排空吞吐，但足够与新 peer 的早期 poll backoff 重叠
//（pollAcquireOpenLock 从 50/100/200/400ms 开始）——这正是生产环境中刚启动 Session 的
// turn-init 竞争者所需的场景。它无法保证已经深入约 1000ms backoff 上限的 peer 命中
//（该 backoff 不会重置），但每批都会重新打开窗口，因此不会让 peer 在整个排空期间饿死。
// 需要每周期硬保证的测试可通过 `interBatchYieldMs` 将此值增大到 1000ms 以上。
const DEFAULT_INTER_BATCH_YIELD_MS = 250;
// 限制单条 observation 重新 embedding 的频率。生产 memory store 可能 churn row（reflector
// 删除并重新插入 Session 的 observation，同时级联删除其 embedding）。如果 embedding row
// 在两次 drain 之间消失，应每个 cooldown 最多重新 embedding 一次，而不是在相同 id 上
// 运行无界的 hot loop。
const DEFAULT_ATTEMPT_COOLDOWN_MS = 5 * 60_000;
// embedding-failure 日志行的片段长度。remote endpoint 偶尔会在路由错误时返回完整 HTML 页面
//（marketing site 的 404）；直接 dump 整个 body 会让每次失败的日志增加几十 KB。
const ERROR_BODY_LOG_MAX = 200;

export interface EmbeddingBackfillWorkerOptions {
  /** 拥有 PGlite handle 和跨进程 lock 的 Memory Session。 */
  session: MemorySession;
  /** embedding callable。默认使用 OpenRouter client；测试注入 stub。 */
  embed: EmbedFn;
  /** 追加 progress 行的路径。可选；省略时 worker 不记录日志。 */
  logPath?: string;
  /**
   * 因跨进程 lock 忙而无法执行 drain 时的重试延迟（毫秒）。默认为 10s，
   * 给持有 lock 的 peer relay-pi CLI 留出完成空间。
   */
  retrySleepMs?: number;
  /**
   * drain 失败后的退避时间（毫秒）。默认为 60s。
   * 测试会覆盖此值，以免 transient-error case 阻塞整个 suite 一分钟。
   */
  errorSleepMs?: number;
  /**
   * 同一 observation id 两次 re-embed attempt 的最短间隔（毫秒）。默认为 5 分钟。
   * 当某项工作（通常是 reflector 的 delete-and-reinsert cycle）持续在 worker 之后清除
   * row 的 embedding 时，限制无界的重新 embedding。
   */
  attemptCooldownMs?: number;
  /**
   * worker 释放跨进程 lock 后两次 drain batch 之间的暂停时间（毫秒），让等待的 peer relay-pi
   * 进程在下一批重新打开之前获得 lock。默认为 250ms。测试会覆盖此值以保持 suite 快速。
   */
  interBatchYieldMs?: number;
  /**
   * live log 文件在轮转到 `<logPath>.1`（替换之前的轮转文件）前的最大字节数。默认为 1 MB。
   * 每次调用 `log` 都会先检查当前大小，轮转后再追加，因此长期失败不会无限增长日志。
   */
  logMaxBytes?: number;
}

const DEFAULT_LOG_MAX_BYTES = 1024 * 1024;

export class EmbeddingBackfillWorker {
  private readonly options: EmbeddingBackfillWorkerOptions;
  private readonly retrySleepMs: number;
  private readonly errorSleepMs: number;
  private readonly attemptCooldownMs: number;
  private readonly interBatchYieldMs: number;
  private readonly logMaxBytes: number;
  // 每个 id 记录上次 attempt 的时间戳。selectBatch 会过滤 cooldown 内尝试过的 id，
  // 从而在 row 的 embedding 持续在 drain 之间消失时打破 hot loop。条目过期后惰性清理。
  private readonly recentAttempts = new Map<string, number>();
  private abortController?: AbortController;
  private runningPromise?: Promise<void>;
  // drain 进行期间由 `kick()` 设置，使循环在空结果上不退出，而是再 drain 一次，关闭 write
  // 发生在最终 select 与循环退出之间的 race。
  private pendingKick = false;
  // 当前 in-flight backoff sleep（如果有）的 resolver。`kick()` 会调用它，使新写入缩短
  // cooldown/retry/error backoff，而不是等待完毕。
  private wakeFromSleep?: () => void;
  // 由 `stop()` 设置，使较晚到达的 `kick()`（与 dispose 竞争的 write）无法针对即将关闭的
  // Session 重新启动循环。
  private stopped = false;

  constructor(options: EmbeddingBackfillWorkerOptions) {
    this.options = options;
    this.retrySleepMs = options.retrySleepMs ?? DEFAULT_RETRY_SLEEP_MS;
    this.errorSleepMs = options.errorSleepMs ?? DEFAULT_ERROR_SLEEP_MS;
    this.attemptCooldownMs = options.attemptCooldownMs ?? DEFAULT_ATTEMPT_COOLDOWN_MS;
    this.interBatchYieldMs = options.interBatchYieldMs ?? DEFAULT_INTER_BATCH_YIELD_MS;
    this.logMaxBytes = options.logMaxBytes ?? DEFAULT_LOG_MAX_BYTES;
  }

  /** 启动 drain loop。幂等——运行期间再次调用不会产生任何操作。 */
  start(): void {
    if (this.runningPromise) return;
    this.stopped = false;
    const controller = new AbortController();
    this.abortController = controller;
    this.runningPromise = this.run(controller.signal).finally(() => {
      if (this.abortController !== controller) return;
      this.runningPromise = undefined;
      this.abortController = undefined;
      // 如果 kick 在 loop 最后的空 drain 检查与此 cleanup 之间到达，否则会丢失；重启以兑现它。
      if (this.pendingKick && !controller.signal.aborted) this.start();
    });
  }

  /**
   * 发送新 observation 已写入的信号。如果 drain loop 已退出则重启；如果仍在运行，则安排
   * 再次 drain（并缩短 backoff sleep）。由 storage write helper 通过 `MemorySession.onWrite` 调用。
   */
  kick(): void {
    if (this.stopped) return;
    this.pendingKick = true;
    if (this.runningPromise) {
      this.wakeFromSleep?.();
      return;
    }
    this.start();
  }

  /**
   * 停止循环，并等待 in-flight tick（如果有）结算。
   * 由于每个 tick 都等待 `session.withDb`，这会传递地等待 worker 持有的 open 排空并释放 lock。
   */
  async stop(): Promise<void> {
    this.stopped = true;
    this.abortController?.abort();
    // start() 中附加的 finally 会在循环结算后清除 abortController 和 runningPromise，因此等待
    // 本身就是 stop 所需的全部 cleanup。
    await this.runningPromise;
  }

  private async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      this.pendingKick = false;
      try {
        const outcome = await this.drainInBatches(signal);
        if (signal.aborted) return;
        if (outcome === "drained") {
          if (!this.pendingKick) return;
          continue;
        }
        // “cooling”：唯一的未 embedding row 最近才尝试过——等 cooldown 可能到期后再重试。
        // “lock-busy”：预算内无法获取跨进程 lock——短暂 sleep 后重试，让持有 lock 的 peer 完成。
        await this.sleep(
          outcome === "cooling" ? this.attemptCooldownMs : this.retrySleepMs,
          signal,
        );
      } catch (error) {
        if (signal.aborted) return;
        this.log(`Embedding batch failed: ${summarizeError(error)}`);
        await this.sleep(this.errorSleepMs, signal);
      }
    }
  }

  /**
   * 每次处理一个 `BATCH_SIZE` chunk 排空 backlog，每个 chunk 使用自己的 `withDb`。batch 之间
   * worker 释放 memory Session 并暂停，避免 peer relay-pi 进程在整个 drain 期间饿死（见类文档）。
   * backlog 为空时返回 "drained"；唯一剩余 row 处于 attempt cooldown 时返回 "cooling"；
   * 某批无法获取跨进程 lock 时返回 "lock-busy"。
   */
  private async drainInBatches(signal: AbortSignal): Promise<"drained" | "cooling" | "lock-busy"> {
    let first = true;
    while (!signal.aborted) {
      if (!first) {
        // 现在释放跨进程 lock（而不是等 idle-close timer），并暂停，让轮询中的 peer 在 worker
        // 为下一批重新打开前获取 lock。
        await this.options.session.relinquish();
        await this.sleep(this.interBatchYieldMs, signal);
        if (signal.aborted) return "drained";
      }
      first = false;
      const outcome = await this.options.session.withDb((db) => this.drainBatch(db));
      if (signal.aborted) return "drained";
      // `undefined` 表示在预算内无法获取 lock；向调用方返回，让它退避并重试。
      if (outcome === undefined) return "lock-busy";
      if (outcome === "more") continue;
      return outcome;
    }
    return "drained";
  }

  /**
   * 在已经打开的 handle 上执行 embedding，直到写入一个完整 batch——这通常意味着还有 backlog，
   * 因此返回 "more"，让调用方在为下一批重新打开前释放 lock——或 backlog 耗尽，返回 terminal
   * 状态（"drained"/"cooling"）。
   *
   * 部分 batch（少于 `BATCH_SIZE` row）表示没有更多未排除 row，因此在同一次 open 中执行
   * terminal 检查，而不为几乎必空的 select 重新打开。这样单批 drain 保持 atomic（从不让出
   * event loop），所以 drain 刚结束后、尚未 kick 的 write 不会被后续 select 扫入——只有完整的
   * multi-batch drain 会在 batch 之间让出跨进程 lock。
   */
  private async drainBatch(db: PGlite): Promise<"more" | "drained" | "cooling"> {
    while (true) {
      const batch = await this.selectBatch(db);
      if (batch.length === 0) {
        return (await this.hasCooledBacklog(db)) ? "cooling" : "drained";
      }
      // 在等待 embedding 之前记录 attempt，因此即使调用中途失败也算一次 attempt，
      // 相同 id 不会在下一次 drain 中被紧密循环重试。
      const attemptAt = Date.now();
      for (const row of batch) this.recentAttempts.set(row.id, attemptAt);
      await embedAndPersistObservations(db, batch, this.options.embed);
      this.log(`Embedded ${batch.length} observations`);
      // 完整 batch：在排空下一批前让出 lock。
      if (batch.length >= BATCH_SIZE) return "more";
      // 部分 batch：在同一次 open 中继续解析 terminal state。
    }
  }

  /** 当存在未 embedding row 且 `selectBatch` 因每条都处于 attempt cooldown 而看不到它们时为 true。
   * 只有 exclusion list 非空时才值得查询——空 list 表示空 batch 已经证明 backlog 全部排空。 */
  private async hasCooledBacklog(db: PGlite): Promise<boolean> {
    if (this.collectCooledIds().length === 0) return false;
    const result = await db.query<{ pending: boolean }>(
      `SELECT EXISTS(
         SELECT 1 FROM observations o
         LEFT JOIN observation_embeddings e ON e.observation_id = o.id
         WHERE e.observation_id IS NULL
       ) AS pending`,
    );
    return result.rows[0]?.pending ?? false;
  }

  /** 在 abort 或 `kick()` 时提前结束的 backoff sleep。 */
  private sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal.aborted || this.pendingKick) {
        resolve();
        return;
      }
      const finish = (): void => {
        clearTimeout(timer);
        signal.removeEventListener("abort", finish);
        this.wakeFromSleep = undefined;
        resolve();
      };
      const timer = setTimeout(finish, ms);
      this.wakeFromSleep = finish;
      signal.addEventListener("abort", finish, { once: true });
    });
  }

  private async selectBatch(db: PGlite): Promise<{ id: string; content: string }[]> {
    // 对 embeddings 表做 LEFT JOIN 是找出尚无 embedding 的 row 的最低成本方式。复合 index
    //（kind、priority、created_at DESC）直接承担 ORDER BY，无需单独排序。
    //
    // exclusion list 来自 `recentAttempts`，限制 worker 重试同一 id 的频率，即使其 embedding
    // row 在两次 drain 之间持续被级联删除。
    const excludedIds = this.collectCooledIds();
    const result = await db.query<{ id: string; content: string }>(
      `SELECT o.id, o.content
       FROM observations o
       LEFT JOIN observation_embeddings e ON e.observation_id = o.id
       WHERE e.observation_id IS NULL
         AND NOT (o.id = ANY($2::text[]))
       ORDER BY
         CASE o.priority WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END DESC,
         o.created_at DESC
       LIMIT $1`,
      [BATCH_SIZE, excludedIds],
    );
    return result.rows;
  }

  /** 返回当前位于 attempt-cooldown 窗口内的 id，并忘掉更旧的条目，防止 map 无界增长。 */
  private collectCooledIds(): string[] {
    const now = Date.now();
    const cutoff = now - this.attemptCooldownMs;
    const active: string[] = [];
    for (const [id, at] of this.recentAttempts) {
      if (at < cutoff) {
        this.recentAttempts.delete(id);
        continue;
      }
      active.push(id);
    }
    return active;
  }

  private log(message: string): void {
    const logPath = this.options.logPath;
    if (!logPath) return;
    try {
      mkdirSync(dirname(logPath), { recursive: true });
      // 追加前轮转，使 live 文件最多超过上限一行。单个 `.1` rotation 保留最近的 overflow
      // 供 post-mortem 使用，同时不累积无界的文件 ring。
      try {
        if (statSync(logPath).size >= this.logMaxBytes) {
          renameSync(logPath, `${logPath}.1`);
        }
      } catch {
        // 没有现有文件，或 stat 失败；appendFileSync 会创建文件。
      }
      // 写入 pid，使多 CLI 运行可以区分（它们通过同一个由 HOME 支持的 `.relay-pi/logs/` 路径
      // 共享日志文件）。每次 appendFileSync 只写入一行，远小于 PIPE_BUF，因此 O_APPEND 即使
      // 进程交错写入，也能保持不同进程的行完整。
      appendFileSync(
        logPath,
        `[${new Date().toISOString()} pid=${process.pid}] ${message}\n`,
        "utf8",
      );
    } catch {
      // 日志尽力而为；这里失败不能让 worker 停止。下一批日志会重试创建目录。
    }
  }
}

/**
 * 在给定的 open handle 上 embedding `rows`，并 upsert 其 `observation_embeddings` row。
 * worker drain loop、`appendObservation` 的同步 insert-time embed，以及 `loadStoredMemory` 的
 * startup catch-up pass 共用此函数。embed 调用失败或 vector 数量不匹配时抛出；调用方决定
 * 是否致命（worker 记录日志并退避，insert-time caller 退化到异步 backfill）。
 *
 * upsert 在一个 transaction 中运行，因此部分写入失败不会让 embeddings 表相对 `rows` 处于
 * 半填充状态。`model` 按 server 报告的原值存储，以便未来 re-embedding pass 匹配已弃用的
 * tag，仅刷新受影响的 row。
 *
 * `observation_embeddings` 与 `observations` 之间没有 FK（migration 7 删除了 cascade），
 * 因此即使 parent row 在选中后被删除，裸 INSERT 也安全。产生的 orphan embedding 无害——
 * recall path 会 JOIN 回 `observations` 并过滤 orphan——且同 id reinsert 时仍会保留，无需重新 embedding。
 */
export async function embedAndPersistObservations(
  db: PGlite,
  rows: readonly { id: string; content: string }[],
  embed: EmbedFn,
): Promise<void> {
  if (rows.length === 0) return;
  const result = await embed(rows.map((row) => row.content));
  if (result.embeddings.length !== rows.length) {
    throw new Error(
      `Embedding response length (${result.embeddings.length}) did not match batch size (${rows.length})`,
    );
  }
  await db.transaction(async (tx: Transaction) => {
    const now = Date.now();
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index]!;
      const vector = result.embeddings[index]!;
      await tx.query(
        `INSERT INTO observation_embeddings (observation_id, model, vector, created_at)
         VALUES ($1, $2, $3::vector, $4)
         ON CONFLICT (observation_id) DO UPDATE SET
           model = EXCLUDED.model,
           vector = EXCLUDED.vector,
           created_at = EXCLUDED.created_at`,
        [row.id, result.model, formatVector(vector), now],
      );
    }
  });
}

/**
 * 对 embedding backlog 做一次有界 catch-up：为尚无 embedding row 的最新 `limit` 条 observation
 * 做 embedding。由 `loadStoredMemory` 在第一次 dispatch 前运行，使无 embedding 的流程
 *（embedding 不可用时的 `relay-pi memory add` / `relay-pi train`，或旧版 CLI 写入的 row）
 * 能立即进行 vector recall，而不是等异步 worker 处理到它们。按最新优先，因为新 row 最可能
 * 被首回合 recall 命中；其余 backlog 由 worker 负责。返回 embedding 的 row 数量（跨进程 lock
 * 无法获取时为 0）。embed 失败时抛出——调用方会将该 pass 视为 best-effort。
 */
export async function backfillNewestEmbeddings(
  session: MemorySession,
  embed: EmbedFn,
  limit: number,
): Promise<number> {
  const embedded = await session.withDb(async (db) => {
    const result = await db.query<{ id: string; content: string }>(
      `SELECT o.id, o.content
       FROM observations o
       LEFT JOIN observation_embeddings e ON e.observation_id = o.id
       WHERE e.observation_id IS NULL
       ORDER BY o.created_at DESC
       LIMIT $1`,
      [limit],
    );
    await embedAndPersistObservations(db, result.rows, embed);
    return result.rows.length;
  });
  return embedded ?? 0;
}

/** pgvector 接受 `[1,2,3]` 这类 text-format literal 进行 INSERT。
 * 使用 text 路径可以避开 PGlite client surface 未暴露的 vector binary protocol。 */
function formatVector(values: number[]): string {
  return `[${values.join(",")}]`;
}

/** 为 worker 日志渲染错误，但不 dump 多 KB 的 HTML body。embedding endpoint 路由错误时可能
 * 返回完整的 Next.js 404 页面（超过 50KB），否则 raw message 会在每次 retry 时逐字追加。 */
function summarizeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const collapsed = raw
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (collapsed.length <= ERROR_BODY_LOG_MAX) return collapsed;
  return `${collapsed.slice(0, ERROR_BODY_LOG_MAX)}… (truncated ${collapsed.length - ERROR_BODY_LOG_MAX} chars)`;
}
