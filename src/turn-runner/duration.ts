import ms from "ms";

import type { StateMachinePollState, StateMachineTimerState } from "../types/state-machine.js";

/**
 * 将 duration 值解析为毫秒。
 *
 * state machine 的调度字段（poll 的 `interval`、timer 的 `wakeAfter`）接受以下两种形式：
 * - 数字（原始毫秒数；这是兼容旧版的形式，因此现有定义和程序化调用方仍可工作）；
 * - 由 `ms` 包解析的人类可读 duration 字符串，例如
 *   `"30s"`、`"15m"`、`"3h"`、`"5d"`、`"2 weeks"`。
 *
 * 返回解析出的毫秒数；当输入既不是有限的正数，也不是可解析的 duration 字符串时抛出异常。
 */
export function parseDurationToMs(value: unknown, label: string): number {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`${label} must be a positive, finite number of milliseconds.`);
    }
    return value;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      throw new Error(`${label} must be a non-empty duration string (e.g. "3h", "5d").`);
    }
    const parsed = ms(trimmed as ms.StringValue);
    if (typeof parsed !== "number" || !Number.isFinite(parsed) || parsed <= 0) {
      throw new Error(
        `${label} could not parse duration string ${JSON.stringify(value)}. Use forms like "30s", "15m", "3h", "5d", or a positive number of milliseconds.`,
      );
    }
    return parsed;
  }
  throw new Error(
    `${label} must be a duration string (e.g. "3h") or a positive number of milliseconds.`,
  );
}

/**
 * 将绝对唤醒目标解析为 Unix 纪元毫秒时间戳。
 *
 * Timer 的 `wakeAt` 接受以下两种形式：
 * - 数字（Unix 纪元毫秒数；这是兼容旧版的形式）；
 * - ISO 8601 / RFC 3339 / 任何与 `Date.parse` 兼容的字符串，例如
 *   `"2026-05-24T18:00:00Z"` 或 `"2026-05-24 18:00"`。
 *
 * 返回解析出的纪元毫秒数；当输入既不是有限数值，也不是可解析的日期字符串时抛出异常。
 */
export function parseWakeAtToMs(value: unknown, label: string): number {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`${label} must be a finite Unix-epoch millisecond timestamp.`);
    }
    return value;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      throw new Error(`${label} must be a non-empty ISO date string.`);
    }
    const parsed = Date.parse(trimmed);
    if (!Number.isFinite(parsed)) {
      throw new Error(
        `${label} could not parse date string ${JSON.stringify(value)}. Use an ISO 8601 timestamp like "2026-05-24T18:00:00Z" or a Unix-epoch millisecond number.`,
      );
    }
    return parsed;
  }
  throw new Error(
    `${label} must be an ISO date string (e.g. "2026-05-24T18:00:00Z") or a Unix-epoch millisecond number.`,
  );
}

/**
 * 用于缺少回合循环上下文的 sleep 事件重放路径的尽力而为唤醒时间回退值。
 * 当底层值无法解析时返回 `Date.now()` 而不是抛出异常，因为这些调用方是在重建 UI
 * 横幅，而不是在强制校验调度有效性（回合循环路径会在每次进入 state 时自行严格解析）。
 */
export function scheduledStateFallbackWakeAt(
  state: StateMachinePollState | StateMachineTimerState | undefined,
): number {
  if (!state) return Date.now();
  try {
    if (state.kind === "poll") {
      return Date.now() + parseDurationToMs(state.intervalMs, "intervalMs");
    }
    if (state.wakeAt !== undefined) {
      return parseWakeAtToMs(state.wakeAt, "wakeAt");
    }
    if (state.wakeAfterMs !== undefined) {
      return Date.now() + parseDurationToMs(state.wakeAfterMs, "wakeAfterMs");
    }
  } catch {
    // 回退到 Date.now()；回合循环中的严格路径会在下次进入 state 时
    // 暴露真正的错误。
  }
  return Date.now();
}
