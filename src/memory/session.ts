import type { PGlite } from "@electric-sql/pglite";
import {
  DEFAULT_OPEN_LOCK_WAIT_BUDGET_MS,
  MemoryLockTimeoutError,
  type OpenPGliteOptions,
  openPGliteHoldingLock,
  pollAcquireOpenLock,
  releaseOpenLock,
} from "./pglite.js";

/**
 * 最后一次 `withDb` 调用 resolve 后，PGlite handle 继续打开的默认时间；之后关闭 handle 并
 * 释放跨进程 lock。这样短暂的写入突发（同一回合内的 observer + reflector + embedding upsert）
 * 可以复用一次 open，同时不会让停放的 CLI 永久占有 lock，阻塞第二个 CLI。
 */
const DEFAULT_IDLE_CLOSE_MS = 2_000;

export interface MemorySessionOptions {
  /** PGlite 数据目录的绝对路径。 */
  path: string;
  /**
   * 每次 open 都透传给 `openPGliteHoldingLock`——通常提供 `init`（migration）和
   * `onRecover`（quarantine surface）。
   */
  openOptions: OpenPGliteOptions;
  /**
   * 最后一个 in-flight op resolve 后继续保持 handle 打开的时间。在此窗口内新的 `withDb` 调用
   * 会复用 open handle，并取消 pending close。默认为 2s。
   */
  idleCloseMs?: number;
  /**
   * 单次 `withDb` 调用放弃前等待跨进程 lock 的 wall-time budget。超时后调用 resolve 为
   * `undefined`，并调用一次 `onWarn`。默认为 30s。
   */
  lockWaitBudgetMs?: number;
  /**
   * 当 `withDb` 调用因在 `lockWaitBudgetMs` 内无法获取 lock 而跳过时调用一次。
   * 让 host 展示一条面向用户的 warning，而不是每个 skipped op 都重复。
   */
  onWarn?: (message: string) => void;
}

/**
 * 为一个 dataDir 管理单个 PGlite handle，支持多个短暂工作 burst。Refcounted open 会在任一
 * `withDb` in-flight 时保持 handle（及跨进程 `.relay-pi-open.lock`）存活；最后一个 op resolve
 * 后不久由 idle timer 释放二者，让 peer 进程可以接手。
 *
 * 并发的进程内 `withDb` 调用共享一次 `PGlite.create`：第一个调用分配 `this.opening`，其余
 * 调用等待同一 promise，因此两个 open 不会在全新的 dataDir 上竞相执行 init、重复运行 migration。
 */
export class MemorySession {
  private readonly path: string;
  private readonly openOptions: OpenPGliteOptions;
  private readonly idleCloseMs: number;
  private readonly lockWaitBudgetMs: number;
  private readonly onWarn?: (message: string) => void;

  private readonly writeListeners = new Set<() => void>();
  private db: PGlite | undefined;
  private lockPath: string | undefined;
  private opening: Promise<PGlite | undefined> | undefined;
  private refs = 0;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  private disposing: Promise<void> | undefined;

  constructor(opts: MemorySessionOptions) {
    this.path = opts.path;
    this.openOptions = opts.openOptions;
    this.idleCloseMs = opts.idleCloseMs ?? DEFAULT_IDLE_CLOSE_MS;
    this.lockWaitBudgetMs = opts.lockWaitBudgetMs ?? DEFAULT_OPEN_LOCK_WAIT_BUDGET_MS;
    if (opts.onWarn) this.onWarn = opts.onWarn;
  }

  /**
   * 针对（惰性打开的）memory database 运行 `fn`。Session 已 dispose，或在预算内无法获取 lock
   * 时不调用 `fn`，直接返回 `undefined`；否则返回 `fn` 的结果。`fn` 抛出的错误会继续传播。
   */
  async withDb<T>(
    fn: (db: PGlite) => Promise<T>,
    opts?: { lockWaitBudgetMs?: number },
  ): Promise<T | undefined> {
    if (this.disposed) return undefined;
    this.cancelIdleClose();
    // 在等待 open 前增加 refs，使并发的 `dispose()` 即使在 `ensureOpen` resolve 后、fn 执行前，
    // 也会等待此调用完成。否则 dispose 可能看到 refs=0、关闭 handle，而 fn 继续操作已关闭的 db。
    this.refs++;
    try {
      const db = await this.ensureOpen(opts?.lockWaitBudgetMs);
      if (!db) return undefined;
      // 即使 dispose 在等待 `ensureOpen` 时被调用，handle 已打开后仍运行 fn。dispose 的 drain
      // loop 会等待 refs 归零，因此调用会在仍打开的 db 上完成；否则会在调用方已经决定运行它时
      // 静默跳过 fn。
      return await fn(db);
    } finally {
      this.refs--;
      if (this.refs === 0 && !this.disposed) {
        this.scheduleIdleClose();
      }
    }
  }

  /**
   * 订阅 observation-write notification。Storage write helper 在新 observation row 落库后调用
   * `notifyWrite()`；`loadStoredMemory` 使用它唤醒 embedding backfill worker，而不是让 worker
   * 按 timer 轮询 database。返回 unsubscribe 函数。
   */
  onWrite(listener: () => void): () => void {
    this.writeListeners.add(listener);
    return () => this.writeListeners.delete(listener);
  }

  /**
   * 通知 subscriber observation row 已写入。Storage write helper 在成功写入后调用，使后台
   * consumer（embedding backfill worker）事件驱动地唤醒，而不是轮询。
   */
  notifyWrite(): void {
    if (this.disposed) return;
    for (const listener of this.writeListeners) listener();
  }

  /**
   * 等待所有 in-flight `withDb` 排空，取消 pending idle close，然后关闭 handle 并释放 lock。
   * 后续 `withDb` 调用会 resolve 为 `undefined`。
   */
  async dispose(): Promise<void> {
    if (this.disposing) return this.disposing;
    this.disposing = this.runDispose();
    return this.disposing;
  }

  private async runDispose(): Promise<void> {
    this.disposed = true;
    this.cancelIdleClose();
    // 等待 in-flight withDb fn 结算。这里轮询无妨：dispose 很少发生，refs 在 microtask boundary
    // 递减，因此最多循环几次。
    while (this.refs > 0) {
      await sleep(5);
    }
    await this.closeNow();
  }

  /**
   * 当没有 in-flight `withDb` 时立即关闭 handle 并释放跨进程 lock，而不是等待 idle-close timer。
   * embedding backfill worker 在每个 batch 边界调用它，使排空同一 memory.db 的 peer relay-pi 进程
   * 不会在整个（多批）drain 期间饿死。任何 op in-flight（`refs > 0`）时不执行——该 op 仍拥有
   * open——Session disposed/opening 时也不执行。
   */
  async relinquish(): Promise<void> {
    if (this.disposed || this.refs > 0 || this.opening) return;
    this.cancelIdleClose();
    await this.closeNow();
  }

  private async ensureOpen(lockWaitBudgetMs?: number): Promise<PGlite | undefined> {
    if (this.db) return this.db;
    if (this.opening) return this.opening;
    this.opening = this.openWithPolling(lockWaitBudgetMs)
      .then((db) => {
        this.db = db;
        return db;
      })
      .catch((error: unknown) => {
        if (error instanceof MemoryLockTimeoutError) {
          this.onWarn?.("memory db busy, skipping op");
          return undefined;
        }
        throw error;
      })
      .finally(() => {
        this.opening = undefined;
      });
    return this.opening;
  }

  private async openWithPolling(lockWaitBudgetMs?: number): Promise<PGlite> {
    // 每次调用的 budget（由 `withDb` 传入）覆盖 Session default，并只作用于此次调用发起的 open。
    // 加入 in-flight open（`this.opening`）的并发调用继承该 open 的 budget；per-call budget
    // 仅在本调用启动 open 时适用。
    const budget = lockWaitBudgetMs ?? this.lockWaitBudgetMs;
    const lockPath = await pollAcquireOpenLock(this.path, budget);
    const opened = await openPGliteHoldingLock(this.path, this.openOptions, lockPath);
    this.lockPath = opened.lockPath;
    return opened.db;
  }

  private scheduleIdleClose(): void {
    this.cancelIdleClose();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      // 如果 timer 触发与 callback 执行之间有新的 withDb 到达，再次检查 refs。
      if (this.refs > 0 || this.disposed) return;
      void this.closeNow();
    }, this.idleCloseMs);
  }

  private cancelIdleClose(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
  }

  private async closeNow(): Promise<void> {
    const db = this.db;
    const lockPath = this.lockPath;
    this.db = undefined;
    this.lockPath = undefined;
    if (db) {
      try {
        await db.close();
      } catch {
        // PGlite 偶尔会在 aborted op 后 close 抛错；仍需释放 lock，以便 peer 可以打开。
      }
    }
    if (lockPath) releaseOpenLock(lockPath);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
