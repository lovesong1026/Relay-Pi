import { resolveRelayPiHome } from "../memory/paths.js";
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { peekOpenLockHolderPid } from "../memory/pglite.js";
import { DEFAULT_MEMORY_DB_PATH } from "../session/session-manager.js";
import { acquireFileLock, DEFAULT_STALE_LOCK_MS, releaseFileLock } from "../file-lock.js";
import {
  detectPackageManagerFromContext,
  globalUpgradeCommand,
  type PackageManager,
} from "./package-manager.js";
import { compareSemverVersions, fetchLatestPackageVersion } from "./version-check.js";

/**
 * 设计缘由：CLI 每小时发布多个版本。手动执行 `relay-pi
 * upgrade` 会滞后，因此每次启动都会探测注册表，并在发现
 * 新版本时在后台运行包管理器的全局安装，
 * 同时用户已经可以使用 TUI。下次启动时
 * 就已是最新版本。
 *
 * 并发安全：
 *   - 包管理器会原地修改全局安装路径。已经运行的
 *     CLI 进程不会重新读取这些文件，因此不受影响。
 *   - 安装中途*启动*的 CLI 可能看到不完整的文件。我们通过独占
 *     锁文件尽量缩短此窗口，使同一时间只有一个进程升级；
 *     其他进程直接继续，读取当前已有的状态。
 *   - 超过 STALE_LOCK_MS 的陈旧锁（worker 崩溃、操作系统终止）
 *     会被回收，避免遗漏的 unlink 永久禁用升级。
 *
 * 状态流：`runAutoUpgrade` 通过 `onStatus` 发出每次状态转换，
 * 让 TUI 可以在标题中实时渲染“检查中 / 升级中 / 已升级，请重启”
 * 状态行。返回的 promise 在达到最终状态后
 * 完成。
 */

/** 用户设置此环境变量可完全禁用自动升级。 */
export const NO_AUTO_UPGRADE_ENV = "RELAY_PI_NO_AUTO_UPGRADE";
/**
 * 显式启用升级机制。Relay Pi 尚未发布到 npm，因此
 * 除非未来的发布版本（或测试）显式启用，否则探测保持关闭。
 */
export const UPGRADE_ENABLED_ENV = "RELAY_PI_UPGRADE_ENABLED";

/** 持有时间超过此值的锁会被视为已遗弃并替换。 */
const STALE_LOCK_MS = DEFAULT_STALE_LOCK_MS;

/** 等待注册表的时长。TUI 已启动并显示
 *  “检查中…”占位内容，因此可以比旧版内联通知等待更久，
 *  而不会让用户感到调用延迟。 */
const REGISTRY_TIMEOUT_MS = 8_000;

/**
 * 升级运行期间发出的实时状态流。设计上让 TUI
 * 可以渲染一条原地更新的状态行；每个变体都携带
 * 组织该行文字所需的字段，无需重新推导。
 */
export type UpgradeStatus =
  | { kind: "checking" }
  | { kind: "current"; version: string }
  | { kind: "upgrading"; from: string; to: string; manager: PackageManager }
  | { kind: "upgraded"; from: string; to: string; manager: PackageManager }
  | {
      kind: "failed";
      from: string;
      to: string;
      manager: PackageManager;
      error: string;
    }
  | { kind: "locked" }
  | {
      kind: "skipped";
      reason:
        | "disabled"
        | "package-not-published"
        | "source-checkout"
        | "registry-unreachable"
        /**
         * 另一个 relay-pi 进程持有 `~/.relay-pi/memory.db`
         * 的跨进程打开锁。已有记录表明，在该进程运行时
         * 由 npm 改写 `node_modules` 会触发
         * PGlite 隔离恢复路径，因此完全跳过升级，
         * 留待下次仅有一个 CLI 启动时执行。
         */
        | "memory-in-use";
    };

export type UpgradeStatusListener = (status: UpgradeStatus) => void;

/**
 * TUI 订阅此发布/订阅句柄来渲染实时升级
 * 状态行。每个中间状态都会调用一次 `publish`；最终状态通过
 * `complete` 传入，让晚到的订阅者（例如升级已完成后
 * 才挂载的 TUI）仍能看到终止状态。
 */
export interface UpgradeStatusStream {
  subscribe(listener: UpgradeStatusListener): () => void;
  publish(status: UpgradeStatus): void;
  complete(final: UpgradeStatus): void;
  /** 最近发出的状态，首次发布前为 undefined。 */
  current(): UpgradeStatus | undefined;
}

export function createUpgradeStatusStream(): UpgradeStatusStream {
  const listeners = new Set<UpgradeStatusListener>();
  let latest: UpgradeStatus | undefined;
  const publish = (status: UpgradeStatus): void => {
    latest = status;
    for (const listener of listeners) {
      try {
        listener(status);
      } catch {
        // 监听器错误不得中断升级流程。
      }
    }
  };
  return {
    subscribe(listener) {
      listeners.add(listener);
      // 重放最近的状态，让晚到的订阅者不会错过
      // 当前状态，例如升级在 TUI 挂载之前已完成。
      if (latest) listener(latest);
      return () => listeners.delete(listener);
    },
    publish,
    complete(final) {
      if (latest !== final) publish(final);
    },
    current() {
      return latest;
    },
  };
}

export interface RunAutoUpgradeInput {
  packageName: string;
  currentVersion: string;
  /** 每次状态转换时触发的回调。不会向调用方抛出异常。 */
  onStatus?: UpgradeStatusListener;
  /** 无论环境变量如何都禁止运行（用于 `--no-auto-upgrade` 之后）。 */
  disabled?: boolean;
  /** process.argv[1] — 用于检测从源码检出目录发起的调用。 */
  scriptPath?: string;
  /** 调用处的 process.env；让测试能注入受控环境。 */
  env?: NodeJS.ProcessEnv;
  /** 测试用覆盖项；默认为 fetchLatestPackageVersion。 */
  fetchLatest?: (packageName: string) => Promise<string | undefined>;
  /** 测试用覆盖项；默认启动真实包管理器。 */
  runUpgrade?: (command: string[]) => Promise<{ ok: boolean; stderr?: string }>;
  /** 测试用覆盖项。 */
  now?: () => number;
  /** 测试用覆盖项。 */
  detectManager?: () => PackageManager;
  /**
   * 升级前要探测的记忆数据库数据目录路径。
   * 当另一个活跃的 relay-pi 进程持有其打开锁时，
   * 以 "memory-in-use" 原因跳过升级。默认为
   * `~/.relay-pi/memory.db`；测试会注入临时目录。
   */
  memoryDbPath?: string;
  /** 测试用覆盖项；默认为 `peekOpenLockHolderPid`。 */
  peekMemoryHolder?: typeof peekOpenLockHolderPid;
}

/**
 * 在进程内运行自动升级流程。通过 `onStatus` 发出状态转换，
 * 并以最终状态完成。不会抛出异常，每条错误路径
 * 都产生调用方可渲染的终止状态。
 */
export async function runAutoUpgrade(input: RunAutoUpgradeInput): Promise<UpgradeStatus> {
  const emit = (status: UpgradeStatus): UpgradeStatus => {
    try {
      input.onStatus?.(status);
    } catch {
      // 监听器错误绝不能影响升级流程。
    }
    return status;
  };

  const env = input.env ?? process.env;
  if (input.disabled || env[NO_AUTO_UPGRADE_ENV] === "1") {
    return emit({ kind: "skipped", reason: "disabled" });
  }
  if (env[UPGRADE_ENABLED_ENV] !== "1") {
    return emit({ kind: "skipped", reason: "package-not-published" });
  }
  const scriptPath = input.scriptPath ?? process.argv[1];
  if (!scriptPath || !isLikelyGlobalInstall(scriptPath)) {
    return emit({ kind: "skipped", reason: "source-checkout" });
  }

  // 另一个活跃的 relay-pi 进程正在使用记忆数据库时跳过。已有记录表明，
  // 在其他 CLI 打开 PGlite 时对该包执行 `npm install -g`
  // 会触发 `memory.db.corrupted-*` 恢复路径
  // （其他进程所依赖的 node_modules 被改写了一半，
  // 下次重新打开 PGlite 时遇到不完整的 WASM，
  // 最终触发先重试再隔离的后备机制）。下次仅有一个 CLI 启动时
  // 会继续处理升级。
  const memoryDbPath = input.memoryDbPath ?? DEFAULT_MEMORY_DB_PATH;
  const peekMemoryHolder = input.peekMemoryHolder ?? peekOpenLockHolderPid;
  const memoryHolderPid = peekMemoryHolder(memoryDbPath);
  if (memoryHolderPid !== null) {
    appendLog(
      `skip memory-in-use package=${input.packageName} current=${input.currentVersion} holder=${memoryHolderPid}`,
    );
    return emit({ kind: "skipped", reason: "memory-in-use" });
  }

  const now = input.now ?? (() => Date.now());
  const { homeDir, lockPath } = upgradePaths();
  ensureDir(homeDir);
  const handle = acquireFileLock(lockPath, { now: now(), staleAfterMs: STALE_LOCK_MS });
  if (handle === null) {
    appendLog(`skip locked package=${input.packageName} current=${input.currentVersion}`);
    return emit({ kind: "locked" });
  }
  try {
    // 在探测注册表或启动新安装前，自行修复上次运行遗留的
    // 不完整安装。npm 的全局安装最终通过两次重命名完成：
    // `agent` → `.agent-<rand>`（移开旧版），然后
    // `.agent-<rand>`（新版临时目录）→ `agent`。两者之间收到 SIGKILL（例如
    // 沙箱拆除 exec 进程树）会在作用域目录中留下
    // `.agent-*` 残余目录而没有 `agent`，导致下次安装
    // 因 `ENOTEMPTY` 失败，且 $PATH 中始终找不到 `relay-pi`。持有
    // 升级锁期间清理这些残余，避免并发 CLI 与我们
    // 发生竞争。
    cleanStaleStagingDirs(scriptPath);
    emit({ kind: "checking" });
    const fetchLatest =
      input.fetchLatest ?? ((name: string) => fetchLatestPackageVersion(name, REGISTRY_TIMEOUT_MS));
    let latest: string | undefined;
    try {
      latest = await fetchLatest(input.packageName);
    } catch (error) {
      appendLog(`fetch-error package=${input.packageName} error=${describeError(error)}`);
      return emit({ kind: "skipped", reason: "registry-unreachable" });
    }
    if (!latest) {
      appendLog(`no-latest package=${input.packageName}`);
      return emit({ kind: "skipped", reason: "registry-unreachable" });
    }
    if (compareSemverVersions(latest, input.currentVersion) <= 0) {
      appendLog(`current package=${input.packageName} version=${input.currentVersion}`);
      return emit({ kind: "current", version: input.currentVersion });
    }

    const detect =
      input.detectManager ??
      (() =>
        detectPackageManagerFromContext({
          userAgent: process.env.npm_config_user_agent,
          runtimeExecutable: process.argv[0],
          scriptPath: process.argv[1],
        }));
    const manager = detect();
    emit({ kind: "upgrading", from: input.currentVersion, to: latest, manager });

    const command = globalUpgradeCommand(manager, input.packageName, latest);
    const run = input.runUpgrade ?? defaultRunUpgrade;
    const result = await run(command);
    if (result.ok) {
      appendLog(
        `upgraded package=${input.packageName} from=${input.currentVersion} to=${latest} manager=${manager}`,
      );
      return emit({ kind: "upgraded", from: input.currentVersion, to: latest, manager });
    }
    const error = result.stderr ?? "package manager exited non-zero";
    appendLog(
      `failed package=${input.packageName} from=${input.currentVersion} to=${latest} manager=${manager} stderr=${error}`,
    );
    return emit({ kind: "failed", from: input.currentVersion, to: latest, manager, error });
  } finally {
    releaseFileLock(handle);
  }
}

/**
 * 启发式判断：仅当 CLI 看起来是全局安装的
 * 可执行文件时才运行自动升级。跳过从源码检出目录运行（`bun src/cli.ts`）
 * 和项目内安装，确保贡献者的工作副本
 * 不会被 `npm install --global` 覆盖。
 */
export function isLikelyGlobalInstall(scriptPath: string): boolean {
  const normalized = scriptPath.replace(/\\/g, "/");
  if (
    normalized.includes("/.bun/install/global/") ||
    normalized.includes("/.bun/bin/") ||
    normalized.includes("/.pnpm/") ||
    normalized.includes("/share/pnpm/") ||
    normalized.includes("/.config/yarn/global/") ||
    normalized.includes("/yarn/global/")
  ) {
    return true;
  }
  // npm 全局安装位于 `<prefix>/lib/node_modules/<pkg>/...` 下。
  if (/\/lib\/node_modules\//.test(normalized)) return true;
  // Volta、fnm、nvm 的前缀各异；将任意 node_modules 下的该包视为全局安装。
  if (normalized.includes("/node_modules/relay-pi/")) return true;
  return false;
}

/**
 * 为任意 UpgradeStatus 生成供人阅读的单行描述。JSON 模式的
 * stderr 路径和 TUI 标题共用它，以保持措辞一致。
 */
export function describeUpgradeStatus(
  packageName: string,
  status: UpgradeStatus,
): string | undefined {
  switch (status.kind) {
    case "checking":
      return "Checking for updates…";
    case "upgrading":
      return `Updating ${packageName} ${status.from} → ${status.to}…`;
    case "upgraded":
      return `Updated ${packageName} to ${status.to}. Restart relay-pi to use it.`;
    case "failed":
      return `Update to ${status.to} failed (${status.error}). Run: relay-pi upgrade`;
    case "locked":
    case "current":
    case "skipped":
      // 不显示通知：当前已是最新版本、另一进程正在处理，
      // 或自动升级被有意关闭。保持标题简洁。
      return undefined;
  }
}

/** 延迟解析，以便测试逐例替换 $HOME。 */
function upgradePaths(): { homeDir: string; lockPath: string; logPath: string } {
  const homeDir = resolveRelayPiHome();
  return {
    homeDir,
    lockPath: join(homeDir, "upgrade.lock"),
    logPath: join(homeDir, "logs", "upgrade.log"),
  };
}

function ensureDir(path: string): void {
  try {
    mkdirSync(path, { recursive: true });
  } catch {
    // 忽略
  }
}

/**
 * 删除先前被终止的 `npm install -g relay-pi`
 * 在 `node_modules` 中留下的 `.agent-<rand>` 暂存目录。可安全地
 * 重复调用；忽略不存在的条目。目录通过从 `scriptPath`
 * 向上查找 `relay-pi` 安装路径段推导而来，
 * 该路径段已由上面的 `isLikelyGlobalInstall` 验证。
 */
function cleanStaleStagingDirs(scriptPath: string): void {
  const normalized = scriptPath.replace(/\\/g, "/");
  const marker = "/node_modules/relay-pi/";
  const idx = normalized.indexOf(marker);
  if (idx === -1) return;
  // 使用原始（未规范化的）路径以保留 Windows 分隔符，
  // 尽管 relay-pi 目前仅在 POSIX 上发布。
  const scopeDir = scriptPath.slice(0, idx + "/node_modules".length);
  let entries: string[];
  try {
    entries = readdirSync(scopeDir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.startsWith(".agent-")) continue;
    const stagingPath = join(scopeDir, entry);
    try {
      rmSync(stagingPath, { recursive: true, force: true });
      appendLog(`cleaned-staging path=${stagingPath}`);
    } catch (error) {
      appendLog(`cleaned-staging-error path=${stagingPath} error=${describeError(error)}`);
    }
  }
}

function appendLog(line: string): void {
  try {
    const { logPath } = upgradePaths();
    ensureDir(join(logPath, ".."));
    appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`);
  } catch {
    // 忽略
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * 包管理器升级的基本 spawn 选项。`detached: true` 将
 * npm 放入独立进程组，使父进程终端中的 Ctrl+C 不会
 * 传播到安装进程。完整的 `stdio` 数组在 spawn 时组装，
 * 因为 stderr 槽位是每次调用各自的文件描述符；
 * 此处不能安全使用管道的原因见 `defaultRunUpgrade`。
 */
export const PACKAGE_MANAGER_SPAWN_OPTIONS: Pick<SpawnOptions, "detached"> = {
  detached: true,
};

export type SpawnFn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

/**
 * 包管理器 stderr 重定向到的文件路径。路径
 * 固定，因此下次启动 `relay-pi` 时能展示上次的安装
 * 失败，即使写入者是上一个进程的分离子进程。
 */
function upgradeStderrPath(): string {
  return join(upgradePaths().homeDir, "logs", "upgrade-stderr.log");
}

/**
 * 包管理器升级命令的默认进程内运行器。
 *
 * 存活契约（为何不用 `"pipe"`）：
 *   父 CLI 是交互式的，会在 Ctrl+C 或 `/exit` 时退出。如果
 *   子进程的 stderr 是父进程拥有的管道，父进程退出会关闭
 *   读取端，npm 下次写入 stderr 就会触发 SIGPIPE，
 *   在重命名中途终止安装，导致全局安装目录中留下
 *   `.agent-<rand>` 暂存目录却没有 `agent`（因而在用户重新安装前，
 *   `relay-pi` 会从 $PATH 中消失）。将 stderr 重定向到继承的
 *   文件描述符，就没有会断开的读取端，安装便能在
 *   父进程退出后继续写入。
 *
 * 我们仍希望在 `failed` 状态中报告安装错误，因此在启动前
 * 记录文件大小，并在非零退出时读取
 * 本次运行追加的尾部内容。
 */
export function defaultRunUpgrade(
  command: string[],
  spawn: SpawnFn = nodeSpawn,
): Promise<{ ok: boolean; stderr?: string }> {
  return new Promise((resolve) => {
    const stderrPath = upgradeStderrPath();
    ensureDir(join(stderrPath, ".."));
    let stderrFd: number | undefined;
    let stderrStartByte = 0;
    try {
      stderrStartByte = statSync(stderrPath).size;
    } catch {
      // 文件尚不存在；偏移量保持为 0。
    }
    try {
      stderrFd = openSync(stderrPath, "a");
    } catch (error) {
      // 若无法打开日志文件，则退回到丢弃 stderr，
      // 确保安装在父进程退出后仍可继续。失败消息
      // 会较为笼统，但升级本身能够完成。
      appendLog(`stderr-open-error path=${stderrPath} error=${describeError(error)}`);
    }
    const child = spawn(command[0]!, command.slice(1), {
      ...PACKAGE_MANAGER_SPAWN_OPTIONS,
      stdio: ["ignore", "ignore", stderrFd ?? "ignore"],
    });
    // 已将文件描述符传给子进程；关闭父进程的副本，避免它
    // 在本进程的整个生命周期内一直保持文件打开。
    if (stderrFd !== undefined) {
      try {
        closeSync(stderrFd);
      } catch {
        // 忽略
      }
    }
    child.unref();
    child.once("error", (error) => {
      resolve({ ok: false, stderr: describeError(error) });
    });
    child.once("exit", (code) => {
      if (code === 0) {
        resolve({ ok: true });
        return;
      }
      resolve({ ok: false, stderr: readStderrTail(stderrPath, stderrStartByte) });
    });
  });
}

/**
 * 读取本次运行追加到共享 stderr 日志的内容。限制大小，避免
 * 冗长的 npm 跟踪信息使失败状态行膨胀。
 */
function readStderrTail(path: string, startByte: number): string | undefined {
  const MAX_BYTES = 4096;
  try {
    const fd = openSync(path, "r");
    try {
      const size = statSync(path).size;
      const from = Math.max(startByte, size - MAX_BYTES);
      const length = Math.max(0, size - from);
      if (length === 0) return undefined;
      const buf = Buffer.alloc(length);
      readSync(fd, buf, 0, length, from);
      const trimmed = buf.toString("utf8").trim();
      return trimmed.length > 0 ? trimmed : undefined;
    } finally {
      try {
        closeSync(fd);
      } catch {
        // 忽略
      }
    }
  } catch {
    return undefined;
  }
}

// 仅供测试访问内部路径和常量。
export const __testing = {
  upgradePaths,
  STALE_LOCK_MS,
  cleanStaleStagingDirs,
};
