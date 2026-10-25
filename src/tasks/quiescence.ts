import type { TaskDescriptor } from "./types.js";

/** 存在进程内工作时，运行器必须保持唤醒。 */
export type PendingWork =
  | { kind: "open" }
  | { kind: "sleep"; wakeAt: number }
  | { kind: "complete" };

/** 仅依据可序列化的任务描述符决定终止时的状态。 */
export function computePendingWork(descriptors: readonly TaskDescriptor[]): PendingWork {
  if (descriptors.some((descriptor) => descriptor.status === "running")) {
    return { kind: "open" };
  }

  const wakeTimes = descriptors.flatMap((descriptor) =>
    descriptor.status === "scheduled" && descriptor.wakeAt !== undefined ? [descriptor.wakeAt] : [],
  );
  if (wakeTimes.length > 0) return { kind: "sleep", wakeAt: Math.min(...wakeTimes) };
  return { kind: "complete" };
}
