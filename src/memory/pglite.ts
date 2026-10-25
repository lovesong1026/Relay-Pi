import { PGlite, type PGliteOptions } from "@electric-sql/pglite";
import { vector as upstreamVector } from "@electric-sql/pglite/vector";
import {
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, resolve as resolvePath, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * pgvector 作为可选 WASM extension 随 PGlite 提供。我们无条件加载它，使每个 memory database
 * 都能运行 hybrid retrieval，无需 feature flag——代价是每次安装多下载一个小 WASM 文件。
 * 每次 migration v3 创建 embedding table 和 HNSW index 时，`CREATE EXTENSION vector` 都会成功。
 */
const vector = {
  ...upstreamVector,
  async setup(...args: Parameters<typeof upstreamVector.setup>) {
    const setup = await upstreamVector.setup(...args);
    return { ...setup, bundlePath: resolvePGliteExtensionBundle(setup.bundlePath) };
  },
};
const MEMORY_EXTENSIONS = { vector } as const;

/** Relay Pi 作为 compiled executable 时，PGlite 必须从 host filesystem 加载的文件。 */
export const PGLITE_RUNTIME_ASSET_NAMES = [
  "pglite.data",
  "pglite.wasm",
  "initdb.wasm",
  "vector.tar.gz",
] as const;

/** 必需的 compiled-runtime PGlite sidecar 之一的 basename。 */
export type PGliteRuntimeAssetName = (typeof PGLITE_RUNTIME_ASSET_NAMES)[number];

type PGliteRuntimeOptions = Pick<
  PGliteOptions,
  "fsBundle" | "pgliteWasmModule" | "initdbWasmModule"
>;

let pgliteRuntimeOptionsPromise: Promise<PGliteRuntimeOptions> | undefined;

/**
 * Bun 的 single-file compiler 会将 extension 的 `import.meta.url` 保留在 `$bunfs` 中，但 PGlite
 * 通过普通 filesystem URL 加载 extension archive。Source/npm install 直接使用上游 archive；
 * compiled distribution 将同一 archive 作为 sidecar 放在 executable 旁边。
 */
export function resolvePGliteExtensionBundle(
  upstreamBundle: URL,
  executablePath = process.execPath,
  pathExists: (path: string) => boolean = existsSync,
): URL {
  if (upstreamBundle.protocol !== "file:") return upstreamBundle;
  const upstreamPath = fileURLToPath(upstreamBundle);
  if (pathExists(upstreamPath)) return upstreamBundle;
  const sidecarPath = join(dirname(executablePath), basename(upstreamPath));
  return pathExists(sidecarPath) ? pathToFileURL(sidecarPath) : upstreamBundle;
}

/**
 * 存在 executable sidecar 时从其中加载 PGlite core asset。普通 source 和 package install 继续使用
 * PGlite 自己的 import-relative URL。Partial compiled distribution 会清晰失败，而不是回退到
 * 不可读的 `$bunfs` path。
 */
async function pgliteRuntimeOptions(): Promise<PGliteRuntimeOptions> {
  pgliteRuntimeOptionsPromise ??= loadPGliteRuntimeOptions(process.execPath);
  return pgliteRuntimeOptionsPromise;
}

async function loadPGliteRuntimeOptions(executablePath: string): Promise<PGliteRuntimeOptions> {
  const assetPaths = Object.fromEntries(
    PGLITE_RUNTIME_ASSET_NAMES.map((name) => [name, join(dirname(executablePath), name)]),
  ) as Record<PGliteRuntimeAssetName, string>;
  const present = PGLITE_RUNTIME_ASSET_NAMES.filter((name) => existsSync(assetPaths[name]));
  if (present.length === 0) return {};
  if (present.length !== PGLITE_RUNTIME_ASSET_NAMES.length) {
    const missing = PGLITE_RUNTIME_ASSET_NAMES.filter((name) => !existsSync(assetPaths[name]));
    throw new Error(`Compiled PGlite runtime is missing sidecars: ${missing.join(", ")}.`);
  }

  const [fsBundleBytes, pgliteWasmBytes, initdbWasmBytes] = await Promise.all([
    readFile(assetPaths["pglite.data"]),
    readFile(assetPaths["pglite.wasm"]),
    readFile(assetPaths["initdb.wasm"]),
  ]);
  const [pgliteWasmModule, initdbWasmModule] = await Promise.all([
    WebAssembly.compile(new Uint8Array(pgliteWasmBytes)),
    WebAssembly.compile(new Uint8Array(initdbWasmBytes)),
  ]);
  return {
    fsBundle: new Blob([new Uint8Array(fsBundleBytes)]),
    pgliteWasmModule,
    initdbWasmModule,
  };
}

/**
 * 写入每个 managed data directory 的跨进程 open-lock 使用的文件名。第一行是持有者 pid；
 * 其他进程只有在该 pid 已不再存活时才会越过 O_EXCL。
 */
const OPEN_LOCK_FILE = ".relay-pi-open.lock";

export interface OpenPGliteOptions {
  /**
   * 在 database 打开后立即运行的 async hook，处于会触发 quarantine recovery 的 try block 中。
   * 通常用于应用 schema migration，使失败时目录移到一旁，而不是让 Agent 被不透明的 PGlite
   * abort 卡住。
   */
  init?: (db: PGlite) => Promise<void>;
  /**
   * 当不可读的 data directory 被 quarantine、并以 fresh directory 替代时调用一次。接收旧目录
   * 被移动到的路径，以便调用方展示；省略时向 stderr 写入 warning。
   */
  onRecover?: (info: { backupPath: string; cause: unknown }) => void;
}

/**
 * 在调用方 wait budget 内无法获取跨进程 open-lock 时抛出。`MemorySession` 会捕获它并优雅退化
 *（跳过 op，只 warning 一次），因此长时间运行的第一个 CLI 持有 memory db 时，第二个 relay-pi
 * CLI 不会崩溃。
 */
export class MemoryLockTimeoutError extends Error {
  readonly dataDir: string;
  readonly holderPid: number;
  readonly budgetMs: number;
  constructor(dataDir: string, holderPid: number, budgetMs: number) {
    super(
      `Timed out after ${budgetMs}ms waiting for the memory db open-lock at ${dataDir} ` +
        `(held by pid ${holderPid}).`,
    );
    this.name = "MemoryLockTimeoutError";
    this.dataDir = dataDir;
    this.holderPid = holderPid;
    this.budgetMs = budgetMs;
  }
}

export type TryAcquireOpenLockResult = { lockPath: string } | { holderPid: number };

/**
 * `openPGliteWaitingForLock` 和 `relay-pi memory` CLI 轮询跨进程 open-lock 时使用的默认 wall-time
 * budget。足够撑过并发 relay-pi 进程的中等 write burst，但有界，因此卡住的 peer 不会无限期
 * 阻塞调用方。
 */
export const DEFAULT_OPEN_LOCK_WAIT_BUDGET_MS = 30_000;

/**
 * 在结构完整的 cluster 上重试 open 的总 wall-time；超过后放弃并 quarantine。足够撑过缓慢的
 * `npm install -g` 重写 `node_modules`（唯一已知的、会伪装成 corruption 的 transient failure，
 * cold cache 通常需 5–12s），又远低于典型 Agent 回合，使真正 WAL-corrupted 的 dataDir 在同一
 * Session 中作为 quarantine event 暴露，而不是消失在长于回合的 poll 里。
 */
const RETRY_BEFORE_QUARANTINE_BUDGET_MS = 10_000;

/** 与 live dataDir 一起保留的磁盘轮转 backup 数。每次启动尽力 snapshot，因此 PGlite 无法再打开当前
 * cluster 时总有近期的 known-good cluster 可回退。五个足以覆盖几天的正常使用，又不会撑大
 * `~/.relay-pi`。 */
const MAX_BACKUPS = 5;

/** 轮转磁盘 backup 的文件名前缀。与 live `memory.db` 同级，并加 ISO timestamp 后缀，使从新到旧排序可直接使用 lexical 顺序。 */
const BACKUP_SUFFIX_PREFIX = ".backup-";

/**
 * 如果最近的 backup 比此值更新，则跳过 startup snapshot。MemorySession 每回合会多次 refcount-open；
 * 没有 dedupe 时每次 acquire 都会消耗 inode。该值比典型 Session 间隔短得多，因此 Relay Pi
 * 即使短暂停顿后重新启动，也会获得新的 backup。
 */
const BACKUP_DEDUPE_WINDOW_MS = 5 * 60 * 1_000;

/** quarantine grace window 中 retry attempt 之间的 backoff schedule。前段（250ms、500ms、1s）
 * 使快速升级很快恢复；上限 2s，避免长时间 `npm install` 在 budget 到期前造成 retry storm。 */
const RETRY_BACKOFF_MS = [250, 500, 1_000, 2_000];

/** `pollAcquireOpenLock` 使用的指数 backoff schedule。从 50ms 翻倍到 1s 上限，使 idle-close 间隙
 * 释放 lock 的 peer 能在约 50ms 内被发现，同时长时间运行的 peer 不会造成 poll storm。 */
const POLL_BACKOFF_MS = [50, 100, 200, 400, 800, 1000];

/**
 * 当前进程持有的 open-lock 文件的 process-global registry。Exit handler 用它在 crash 时丢弃 lock，
 * 使下一次启动（以及并发 relay-pi CLI）不会被指向已死亡 pid 的 stale lock 阻塞。
 */
const heldLockPaths = new Set<string>();

let exitHandlerInstalled = false;
function installExitCleanup(): void {
  if (exitHandlerInstalled) return;
  exitHandlerInstalled = true;
  process.on("exit", () => {
    for (const lockPath of heldLockPaths) {
      try {
        unlinkSync(lockPath);
      } catch {
        // exit 时尽力而为；文件已经不存在时无需处理。
      }
    }
  });
}

/**
 * 在 `path` 打开 PGlite database，恢复以下三种本来会阻止 Agent 启动的 failure mode：
 *
 *   1. 上次运行 crash 留下的 stale `postmaster.pid`——当其 PID 不属于存活进程时移除 lock。
 *   2. PGlite 完全无法读取的 data directory（损坏、部分写入，或由不兼容 Postgres version 写入）——
 *      通过运行 init hook 作为 probe 检测。坏目录改名为 `<path>.corrupted-<iso-timestamp>`，
 *      供用户稍后恢复，并在其位置打开 fresh database。
 *   3. 跨进程 open-lock，防止两个 relay-pi CLI 同时在同一 fresh dataDir 上调用 `PGlite.create`，
 *      破坏彼此的 migration。
 *
 * 如果 lock 由仍存活的 foreign process 持有，则以 reject 形式同步抛出。需要等待或优雅退化的
 * 调用方应使用 `MemorySession`，它会轮询 `tryAcquireOpenLock`。
 */
export async function openPGlite(path: string, options: OpenPGliteOptions = {}): Promise<PGlite> {
  installExitCleanup();
  const lockPath = acquireOpenLock(path);
  try {
    const opened = await openPGliteHoldingLock(path, options, lockPath);
    return installLockReleasingClose(opened.db, opened.lockPath);
  } catch (error) {
    releaseOpenLock(lockPath);
    throw error;
  }
}

/**
 * 类似 `openPGlite`，但以指数 backoff 轮询 `tryAcquireOpenLock`，最多等待 `waitBudgetMs`（默认
 * `DEFAULT_OPEN_LOCK_WAIT_BUDGET_MS`），再放弃；因此短生命周期 CLI 在 peer relay-pi process
 * 短暂持有 open-lock 时不会崩溃。由 `relay-pi memory` subcommand 使用；runner 的 hot path
 * 使用 `MemorySession`，以便跨多个 op refcount open。预算耗尽时抛出 `MemoryLockTimeoutError`，
 * 携带最近观察到的 holder pid，使调用方可以渲染有用的 message。
 */
export async function openPGliteWaitingForLock(
  path: string,
  options: OpenPGliteOptions = {},
  waitBudgetMs: number = DEFAULT_OPEN_LOCK_WAIT_BUDGET_MS,
): Promise<PGlite> {
  installExitCleanup();
  const lockPath = await pollAcquireOpenLock(path, waitBudgetMs);
  try {
    const opened = await openPGliteHoldingLock(path, options, lockPath);
    return installLockReleasingClose(opened.db, opened.lockPath);
  } catch (error) {
    releaseOpenLock(lockPath);
    throw error;
  }
}

/**
 * 以指数 backoff 轮询 `tryAcquireOpenLock`，直到获取 lock 或 `budgetMs` 到期。由 `MemorySession`
 *（每个 op 获取）和 `relay-pi memory` CLI（TUI 生命周期内单次获取）共享。耗尽时抛出
 * `MemoryLockTimeoutError`，其中带最近观察到的 holder pid。
 */
export async function pollAcquireOpenLock(dataDir: string, budgetMs: number): Promise<string> {
  const start = Date.now();
  let attempt = 0;
  let lastHolderPid = 0;
  while (true) {
    const result = tryAcquireOpenLock(dataDir);
    if ("lockPath" in result) return result.lockPath;
    // 在 retry 之间保留最近一个*已知*的 holder pid：stale-takeover subpath 在文件内容无法解析或
    // racer 已退出时，可能短暂报告 0。不要让它覆盖之前观察到的真实 pid，最终 timeout error
    // 不应显示“held by pid 0”。
    if (result.holderPid > 0) lastHolderPid = result.holderPid;
    const elapsed = Date.now() - start;
    if (elapsed >= budgetMs) {
      throw new MemoryLockTimeoutError(dataDir, lastHolderPid, budgetMs);
    }
    const base = POLL_BACKOFF_MS[Math.min(attempt, POLL_BACKOFF_MS.length - 1)] ?? 1000;
    const remaining = budgetMs - elapsed;
    const delay = Math.max(1, Math.min(base, remaining));
    attempt++;
    await sleep(delay);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 假设调用方已经为 dataDir 持有 `lockPath`，打开 database。Quarantine recovery 时目录会移到
 * 一旁，旧 lockPath 随之消失；函数返回重新获取的 lockPath。`MemorySession` 使用它，使自己的
 * poll-acquire loop 端到端拥有 lock lifecycle。
 */
export async function openPGliteHoldingLock(
  path: string,
  options: OpenPGliteOptions,
  lockPath: string,
): Promise<{ db: PGlite; lockPath: string }> {
  installExitCleanup();
  mkdirSync(dirname(path), { recursive: true });
  clearStalePostmasterLock(path);

  try {
    const db = await openAndProbe(path, options.init);
    // 成功 open + init 后 snapshot cluster，确保 backup pool 中每个 entry 都可验证读取。在 open 前
    // snapshot 会把 WAL-corrupted dataDir 复制进 pool，并轮转掉最后一个 good copy，抵消 rotation。
    // 先 CHECKPOINT，使磁盘字节与 PGlite 刚验证的内存状态一致。尽力而为：checkpoint 和 copy
    // 失败只 warning，不阻塞 startup。
    await snapshotAfterSuccessfulOpen(db, path);
    return { db, lockPath };
  } catch (error) {
    if (!isExistingDirectory(path)) throw error;
    // 如果失败涉及用户 dataDir 之外的内容，不要 quarantine——通常是 self-update 期间 node_modules
    // 缺少 PGlite runtime asset（例如 `pglite.data` 的 ENOENT）。此时将完全健康的 memory.db
    // 移到一旁曾让真实用户受损；让错误直接暴露，使下一次 launch（node_modules 完整解包后）
    // 可以针对现有 data 继续成功。
    if (isExternalAssetError(error, path)) throw error;
    // 结构完整的场景采用 retry-then-quarantine。并发运行的 `relay-pi upgrade` 与另一个 relay-pi
    // CLI 会在中途重写 node_modules，仍在运行的 relay-pi reopen 可能暴露并非严格 ENOENT 的
    // failure shape（部分写入的 wasm/data file 表现为 `WebAssembly.CompileError`、`RangeError`，
    // 或没有可解析 path 的 ENOENT）。npm 完成后这些都会自行恢复，因此在容忍窗口内轮询，可将
    // 它们与真正的 data corruption（write 中途被 kill 导致 WAL torn，每次 attempt 都确定失败）区分开。
    // 只有磁盘上的 cluster 看起来完整（存在 PG_VERSION + required subdir）时才重试；明显损坏的
    // layout 仍会在第一次失败时立即 quarantine。
    if (looksLikeIntactPGliteDirectory(path)) {
      const opened = await retryOpenWhileIntact(path, options.init);
      if (opened) return { db: opened, lockPath };
      // grace window 内每次 attempt 都失败——视为真实 corruption，并以原始 error 作为 cause
      // 继续 recovery。
    }

    // 在把 directory 移到一旁前释放 lock——lock file 位于该 directory 内，会随目录一起移动。
    releaseOpenLock(lockPath);

    // quarantine 并从 fresh 状态启动前，尝试从轮转 backup 恢复。
    // 按最新优先遍历；每个候选都通过实际打开来验证。
    // 成功时先 quarantine 不可读的 live dir，再让恢复的 backup 占据其位置，使用户保留 memory，
    // 而不是从空 database 开始。
    const restored = await tryRestoreFromBackup(path, options.init);
    if (restored) {
      if (options.onRecover) {
        options.onRecover({ backupPath: restored.quarantinedPath, cause: error });
      } else {
        const reason = error instanceof Error ? error.message || error.name : String(error);
        console.warn(
          `[relay-pi] memory database at ${path} could not be opened (${reason}). ` +
            `Restored from backup ${restored.backupSource}; ` +
            `the unreadable copy was moved to ${restored.quarantinedPath}.`,
        );
      }
      return { db: restored.db, lockPath: restored.lockPath };
    }

    const quarantinedPath = quarantineDataDirectory(path);
    if (options.onRecover) {
      options.onRecover({ backupPath: quarantinedPath, cause: error });
    } else {
      const reason = error instanceof Error ? error.message || error.name : String(error);
      console.warn(
        `[relay-pi] memory database at ${path} could not be opened (${reason}). ` +
          `Moved aside to ${quarantinedPath} and starting fresh.`,
      );
    }

    const fresh = acquireOpenLock(path);
    const db = await openAndProbe(path, options.init);
    return { db, lockPath: fresh };
  }
}

/**
 * 包装 `db.close`，使跨进程 lock 与 handle 一起释放。PGlite 内部使用 private class field，围绕
 * instance 的 Proxy 会破坏所有触碰 private field 的方法——替换 method 能保留 identity，并继续
 * 正常访问 private field。
 */
function installLockReleasingClose(db: PGlite, lockPath: string): PGlite {
  const originalClose = db.close.bind(db);
  let released = false;
  db.close = async () => {
    if (released) return;
    released = true;
    try {
      await originalClose();
    } finally {
      releaseOpenLock(lockPath);
    }
  };
  return db;
}

/**
 * 在磁盘 cluster 看起来完整期间，最多以 `RETRY_BEFORE_QUARANTINE_BUDGET_MS` 轮询
 * `openAndProbe`。成功返回打开的 db，budget 到期时返回 `undefined`（调用方随后 quarantine）。
 * External-asset ENOENT 会短路循环——这是 node_modules 侧 retry 无法修复的问题；原样暴露让用户
 * 处理真实 failure，而不是无效等待完整 budget。如果循环中 directory layout 结构损坏（例如
 * peer process 截断了它），也退出，以便执行 quarantine。
 */
async function retryOpenWhileIntact(
  path: string,
  init: ((db: PGlite) => Promise<void>) | undefined,
): Promise<PGlite | undefined> {
  const start = Date.now();
  for (let attempt = 0; ; attempt++) {
    const elapsed = Date.now() - start;
    if (elapsed >= RETRY_BEFORE_QUARANTINE_BUDGET_MS) return undefined;
    const backoff = RETRY_BACKOFF_MS[Math.min(attempt, RETRY_BACKOFF_MS.length - 1)] ?? 2_000;
    const remaining = RETRY_BEFORE_QUARANTINE_BUDGET_MS - elapsed;
    await sleep(Math.max(1, Math.min(backoff, remaining)));
    try {
      return await openAndProbe(path, init);
    } catch (retryError) {
      if (isExternalAssetError(retryError, path)) throw retryError;
      if (!looksLikeIntactPGliteDirectory(path)) return undefined;
      // 否则继续循环，直到 budget 到期。
    }
  }
}

async function openAndProbe(
  path: string,
  init: ((db: PGlite) => Promise<void>) | undefined,
): Promise<PGlite> {
  // PGlite.create 是唯一允许在构造时注册可加载 extension 的 API 路径——裸的 `new PGlite(path)`
  // 会跳过 extension registry，导致 migration v3 运行时 `CREATE EXTENSION vector` 失败并报
  // “extension is not available”。
  const db = await PGlite.create({
    dataDir: path,
    extensions: MEMORY_EXTENSIONS,
    ...(await pgliteRuntimeOptions()),
  });
  try {
    if (init) await init(db);
    return db;
  } catch (error) {
    // 这类 failure 会使 wasm module 处于 aborted state；close 自身也可能抛出。这里只尽力而为——
    // 目标是在从其下方重命名 directory 前停止持有任何 handle。
    try {
      await db.close();
    } catch {
      // 忽略。
    }
    throw error;
  }
}

/**
 * 打开 managed PGlite handle，但不运行 migration，也不因 read failure quarantine。Recovery tooling 用它
 * 从之前 quarantine 的 `memory.db.corrupted-*` directory 读取 row。
 *
 * 不参与 open-lock machinery；调用方拥有返回的 instance，并负责调用 `close()`。
 */
export async function openForRecovery(path: string): Promise<PGlite> {
  clearStalePostmasterLock(path);
  return PGlite.create({
    dataDir: path,
    extensions: MEMORY_EXTENSIONS,
    ...(await pgliteRuntimeOptions()),
  });
}

/**
 * 当 open failure 指向不在 `dataDir` 下的 filesystem path 时为 true——dataDir 本身正常，PGlite
 * 却撞上自己的 bundled runtime file（典型情况是 relay-pi self-update 重写 node_modules 时，
 * `pglite.data` 暂时缺失）。用于抑制 quarantine，避免因 transient packaging error 将健康的
 * memory.db 移到一旁。
 */
export function isExternalAssetError(error: unknown, dataDir: string): boolean {
  if (!error || typeof error !== "object") return false;
  const errno = error as NodeJS.ErrnoException & { path?: string };
  if (errno.code !== "ENOENT") return false;
  const candidates: string[] = [];
  if (typeof errno.path === "string") candidates.push(errno.path);
  if (typeof errno.message === "string") {
    // PGlite 会在 message 中嵌入 path 重抛 fs error，但不一定写入 `.path`；从 message 中提取看起来
    // 是绝对路径的部分。
    const match = errno.message.match(/['"]([^'"]+)['"]/);
    if (match?.[1]) candidates.push(match[1]);
  }
  if (candidates.length === 0) return false;
  const normalizedDir = resolvePath(dataDir);
  return candidates.every((candidate) => {
    const normalized = resolvePath(candidate);
    return normalized !== normalizedDir && !normalized.startsWith(`${normalizedDir}/`);
  });
}

/**
 * 每个磁盘上的 PGlite cluster 都有的子目录。如果这些目录和可解析的 `PG_VERSION` 都存在，
 * dataDir 的磁盘 layout 完整；open failure 是环境问题（升级中的 asset rewrite、权限、WASM load），
 * 而非 data corruption。
 */
const REQUIRED_PGLITE_SUBDIRS = ["base", "global", "pg_wal"] as const;

/**
 * 当 `path` 看起来是有效的 PGlite cluster 时为 true：包含非空 `PG_VERSION` 以及 PGlite bootstrap
 * cluster 所需的每个目录。作为 quarantine guard 使用，防止升级期间的 WASM/data load failure
 * 将健康的 memory.db 移到一旁。导出供测试使用。
 */
export function looksLikeIntactPGliteDirectory(path: string): boolean {
  if (!isExistingDirectory(path)) return false;
  const versionFile = join(path, "PG_VERSION");
  const version = tryReadFile(versionFile);
  if (!version || version.trim().length === 0) return false;
  return REQUIRED_PGLITE_SUBDIRS.every((sub) => isExistingDirectory(join(path, sub)));
}

/**
 * 列出与 live dataDir 同级的轮转 backup directory。返回按 timestamp lexical 顺序从新到旧排列的
 * absolute path。导出供测试使用。
 */
export function listBackups(path: string): string[] {
  const dir = dirname(path);
  const base = basename(path);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const prefix = `${base}${BACKUP_SUFFIX_PREFIX}`;
  return entries
    .filter((name) => name.startsWith(prefix))
    .map((name) => join(dir, name))
    .sort()
    .reverse();
}

/**
 * 尽力 snapshot `path`，供之后恢复。仅在成功 open + init 后调用，因此 rotation 中每个 entry 都
 * 可验证读取。先 CHECKPOINT 刷出 dirty buffer，使磁盘字节与 PGlite 刚验证的内存状态一致。
 * 如果 dedupe window 内已有 recent backup 则不操作（MemorySession refcount-open 否则会在每次
 * acquire 消耗 inode）。裁剪到最新的 `MAX_BACKUPS` 个。任何步骤失败只 warning，绝不阻塞 startup。
 */
async function snapshotAfterSuccessfulOpen(db: PGlite, path: string): Promise<void> {
  try {
    const existing = listBackups(path);
    if (existing.length > 0) {
      const newest = existing[0];
      if (newest) {
        try {
          const age = Date.now() - statSync(newest).mtimeMs;
          if (age < BACKUP_DEDUPE_WINDOW_MS) return;
        } catch {
          // 无法 stat 最新 backup 时，继续执行并创建新的 backup。
        }
      }
    }
    try {
      await db.exec("CHECKPOINT");
    } catch {
      // Checkpoint 失败不应阻塞 snapshot——磁盘上的 WAL 仍自洽，copy 只是可能略旧。
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backup = `${path}${BACKUP_SUFFIX_PREFIX}${stamp}`;
    // `cp -r` 语义；在 APFS 上使用 clonefile，因此 60MB 几乎立即完成。
    cpSync(path, backup, { recursive: true });
    pruneOldBackups(path);
  } catch (error) {
    const reason = error instanceof Error ? error.message || error.name : String(error);
    console.warn(`[relay-pi] could not snapshot memory db at ${path} for backup (${reason}).`);
  }
}

function pruneOldBackups(path: string): void {
  const backups = listBackups(path);
  for (const stale of backups.slice(MAX_BACKUPS)) {
    try {
      rmSync(stale, { recursive: true, force: true });
    } catch {
      // 尽力裁剪；下一次 startup 会再次尝试。
    }
  }
}

/**
 * 按最新优先从轮转 backup 恢复 `path`。对每个 candidate：将不可读的 live dir 移到一旁，将
 * backup 移到原位置，获取新的 open-lock，并通过实际打开 + probe 验证恢复的 dir。成功时返回
 * 打开的 db 以及原始不可读 live dir 被 quarantine 到的路径。失败则回滚 swap，并尝试下一个
 * backup。没有 backup 能得到可读 db 时返回 undefined。
 */
async function tryRestoreFromBackup(
  path: string,
  init: ((db: PGlite) => Promise<void>) | undefined,
): Promise<
  { db: PGlite; lockPath: string; backupSource: string; quarantinedPath: string } | undefined
> {
  const backups = listBackups(path);
  for (const candidate of backups) {
    let quarantinedPath: string;
    try {
      quarantinedPath = quarantineDataDirectory(path);
    } catch {
      // 无法 quarantine live dir 时，继续任何 candidate 都没有意义；交给调用方的 quarantine path 处理。
      return undefined;
    }
    try {
      renameSync(candidate, path);
    } catch {
      // Swap 回 live dir；尝试下一个 candidate。
      try {
        renameSync(quarantinedPath, path);
      } catch {
        // Live dir 现在已丢失；让调用方的 fresh-start path 处理。
      }
      continue;
    }
    try {
      clearStalePostmasterLock(path);
      const lockPath = acquireOpenLock(path);
      try {
        const db = await openAndProbe(path, init);
        return { db, lockPath, backupSource: candidate, quarantinedPath };
      } catch (verifyError) {
        releaseOpenLock(lockPath);
        throw verifyError;
      }
    } catch {
      // 这个 backup 也无法打开。将原始不可读目录 swap 回去，使下一个 candidate（或调用方的
      // fresh-start fallback）看到我们开始时的同一状态。
      try {
        renameSync(path, `${candidate}.failed-${Date.now()}`);
      } catch {
        // 无法将失败的 candidate 移到一旁时保留它；下一轮的 `rename(path, quarantinedPath)` 仍会成功。
      }
      try {
        renameSync(quarantinedPath, path);
      } catch {
        // 无法恢复原始状态；退出，让调用方 quarantine。
        return undefined;
      }
    }
  }
  return undefined;
}

/** 将疑似损坏的 data directory 改名移到一旁，以便在其位置创建 fresh database。返回新路径。导出供测试使用。 */
export function quarantineDataDirectory(path: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = `${path}.corrupted-${stamp}`;
  renameSync(path, backup);
  return backup;
}

/**
 * 不触碰 `<dataDir>/.relay-pi-open.lock`，只读取其内容。live *foreign* process 持有 lock 时返回
 * holder pid；其他情况（文件缺失、自己的 pid、内容无法解析，或死掉的 pid——下次 acquire 会按
 * stale 处理）返回 `null`。Auto-upgrade 用它在另一个 relay-pi CLI 已使用 memory db 时跳过升级——
 * npm 在运行中重写 node_modules 是 `memory.db.corrupted-*` recovery path 的既定触发条件，
 * 因此 peer 持有 db 时安全默认是完全不 upgrade。
 */
export function peekOpenLockHolderPid(dataDir: string): number | null {
  const lockPath = join(dataDir, OPEN_LOCK_FILE);
  const contents = tryReadFile(lockPath);
  if (contents === undefined) return null;
  const firstLine = contents.split("\n", 1)[0]?.trim() ?? "";
  const holderPid = Number.parseInt(firstLine, 10);
  if (!Number.isFinite(holderPid) || holderPid <= 0) return null;
  if (holderPid === process.pid) return null;
  if (!isProcessAlive(holderPid)) return null;
  return holderPid;
}

/**
 * 尝试一次获取 `<dataDir>/.relay-pi-open.lock` 的跨进程 lock。成功（包括接管 stale pid 后）返回
 * `{ lockPath }`；仍由 live foreign process 持有时返回 `{ holderPid }`。竞争时绝不抛出，使调用方
 * 可以轮询重试，而无需 try/catch。
 */
export function tryAcquireOpenLock(dataDir: string): TryAcquireOpenLockResult {
  mkdirSync(dataDir, { recursive: true });
  const lockPath = join(dataDir, OPEN_LOCK_FILE);

  const created = createLockFile(lockPath);
  if (created) {
    heldLockPaths.add(created);
    return { lockPath: created };
  }

  // Lock file 已存在。如果 live foreign process 拥有它，返回信息但不接管；否则视为 stale 并窃取。
  const contents = tryReadFile(lockPath) ?? "";
  const firstLine = contents.split("\n", 1)[0]?.trim() ?? "";
  const holderPid = Number.parseInt(firstLine, 10);
  if (
    Number.isFinite(holderPid) &&
    holderPid > 0 &&
    holderPid !== process.pid &&
    isProcessAlive(holderPid)
  ) {
    return { holderPid };
  }

  // 这是 stale（之前的 run 已 crash）或部分清理的 failed open 留下的自己的 pid。原子替换——
  // unlink 后使用 O_EXCL 创建。
  try {
    unlinkSync(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const recreated = createLockFile(lockPath);
  if (!recreated) {
    // stale-lock takeover 后另一个 opener 赢得 race。即使读取文件时新 holder 已退出（短生命周期
    // opener burst 频繁 churn 同一 dataDir 时会发生），仍视为 contention 并让调用方重新 poll——
    // 这里抛出会使健康 Session 因实际上只是“50ms 后重试”而 abort。
    const afterContents = tryReadFile(lockPath) ?? "";
    const after = Number.parseInt(afterContents.split("\n", 1)[0]?.trim() ?? "", 10);
    const reportedPid = Number.isFinite(after) && after > 0 ? after : 0;
    return { holderPid: reportedPid };
  }
  heldLockPaths.add(recreated);
  return { lockPath: recreated };
}

/**
 * 获取跨进程 open-lock；live foreign process 持有时抛出。`openPGlite` 的 fast/strict path 使用；
 * polling caller 应使用 `tryAcquireOpenLock`。
 */
export function acquireOpenLock(dataDir: string): string {
  const result = tryAcquireOpenLock(dataDir);
  if ("lockPath" in result) return result.lockPath;
  throw new Error(
    `PGlite data directory ${dataDir} is locked by another relay-pi process (pid ${result.holderPid}). ` +
      "Stop that process before opening the database.",
  );
}

/**
 * 释放之前由 `tryAcquireOpenLock` / `acquireOpenLock` 返回的 lock。幂等；文件已经消失时也安全。
 */
export function releaseOpenLock(lockPath: string): void {
  heldLockPaths.delete(lockPath);
  try {
    unlinkSync(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function createLockFile(lockPath: string): string | undefined {
  let fd: number;
  try {
    fd = openSync(lockPath, "wx");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return undefined;
    throw error;
  }
  try {
    writeSync(fd, `${process.pid}\n`);
  } finally {
    closeSync(fd);
  }
  return lockPath;
}

/**
 * 如果 `dataDir` 包含 `postmaster.pid`，且其中 PID 不属于存活进程，则移除 lock 使 PGlite 可以
 * 启动。如果 PID 存活，则抛出清晰错误，而不是让 PGlite 不透明地 abort。导出供测试使用。
 */
export function clearStalePostmasterLock(dataDir: string): void {
  if (!isExistingDirectory(dataDir)) return;

  const lockPath = join(dataDir, "postmaster.pid");
  const contents = tryReadFile(lockPath);
  if (contents === undefined) return;

  const firstLine = contents.split("\n", 1)[0]?.trim() ?? "";
  const pid = Number.parseInt(firstLine, 10);

  if (Number.isFinite(pid) && pid > 0 && isProcessAlive(pid)) {
    throw new Error(
      `PGlite data directory ${dataDir} is locked by an active process (pid ${pid}). ` +
        "Stop that process before opening the database.",
    );
  }

  unlinkSync(lockPath);
}

function isExistingDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function tryReadFile(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

// Internal：让测试访问 held-lock registry，以断言 exit cleanup 行为，而不在 public surface 导出它。
export const __testing = {
  heldLockPaths,
  resolvePath,
};
