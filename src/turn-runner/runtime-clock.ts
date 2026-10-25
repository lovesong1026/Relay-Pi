export type CancelScheduled = () => void;

/** 任务和已调度 state 生命周期使用的墙上时间操作。 */
export interface RuntimeClock {
  /** 返回当前 Unix 纪元时间戳（毫秒）。 */
  now(): number;
  /** 在 `signal` 先中止时，于 `ms` 后解析；或使用中止原因拒绝。 */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  /** 在 `delayMs` 后运行一次 `callback`；返回的函数会取消它。 */
  schedule(callback: () => void, delayMs: number): CancelScheduled;
  /** 每隔 `intervalMs` 运行 `callback`；返回的函数会取消后续运行。 */
  repeat(callback: () => void, intervalMs: number): CancelScheduled;
}

/** 由宿主墙上时钟和计时器 API 支持的生产时钟。 */
export class SystemRuntimeClock implements RuntimeClock {
  now(): number {
    return Date.now();
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(abortReason(signal));

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        reject(abortReason(signal));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  schedule(callback: () => void, delayMs: number): CancelScheduled {
    const timer = setTimeout(callback, delayMs);
    return () => clearTimeout(timer);
  }

  repeat(callback: () => void, intervalMs: number): CancelScheduled {
    const timer = setInterval(callback, intervalMs);
    return () => clearInterval(timer);
  }
}

function abortReason(signal?: AbortSignal): unknown {
  if (signal?.reason !== undefined) return signal.reason;
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}
