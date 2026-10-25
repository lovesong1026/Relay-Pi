import { closeSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";

/** 超过此时间的锁默认视为属于已终止的进程。 */
export const DEFAULT_STALE_LOCK_MS = 10 * 60 * 1000;

export interface FileLockHandle {
  /** 保持锁文件所有权直到释放的打开文件描述符。 */
  fd: number;
  /** 受保护操作完成时要 unlink 的确切文件。 */
  lockPath: string;
}

export interface AcquireFileLockOptions {
  /** 当前墙上时钟时间；可注入，以便锁过期行为在测试中保持确定性。 */
  now?: number;
  /** 放弃的锁经过多久后可以回收。 */
  staleAfterMs?: number;
}

interface LockPayload {
  pid: number;
  startedAt: number;
}

/**
 * 尝试一次获取 advisory lock 文件；必要时回收一个过期锁。
 * 需要等待的调用方应使用自己的预算重试此基础操作。
 */
export function acquireFileLock(
  lockPath: string,
  options: AcquireFileLockOptions = {},
): FileLockHandle | null {
  const now = options.now ?? Date.now();
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_LOCK_MS;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockPath, "wx");
      writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: now } satisfies LockPayload));
      return { fd, lockPath };
    } catch (error: unknown) {
      if (!hasCode(error, "EEXIST")) return null;
      if (!isStaleLock(lockPath, now, staleAfterMs)) return null;
      try {
        unlinkSync(lockPath);
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** 关闭并移除锁。释放操作尽力而为，避免清理过程掩盖受保护操作的结果。 */
export function releaseFileLock(handle: FileLockHandle): void {
  try {
    closeSync(handle.fd);
  } catch {
    // 中断操作后描述符可能已经关闭。
  }
  try {
    unlinkSync(handle.lockPath);
  } catch {
    // 锁文件不存在时，说明它已经释放。
  }
}

function isStaleLock(lockPath: string, now: number, staleAfterMs: number): boolean {
  try {
    const payload = JSON.parse(readFileSync(lockPath, "utf8")) as Partial<LockPayload>;
    if (typeof payload.startedAt === "number") return now - payload.startedAt > staleAfterMs;
  } catch {
    // 回退到 mtime 检查：无法读取的 payload 可能是持有者刚创建文件、尚未写入，
    // 而不是已死亡的进程。
  }
  // 无法读取或没有 payload 的锁按文件年龄过期，但绝不会立即过期——
  // 写入过程中回收锁会让两个 writer 竞争同一个 store。
  try {
    return now - statSync(lockPath).mtimeMs > staleAfterMs;
  } catch {
    return false;
  }
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
