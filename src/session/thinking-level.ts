import type { ThinkingLevel } from "@earendil-works/pi-ai";

/**
 * pi-ai `ThinkingLevel` 值的规范列表，按强度升序排列。
 * 保留为运行时常量，使调用方既能验证用户输入，又能
 * 在错误消息中展示合法值，而无需重复定义
 * 上游类型。`satisfies` 子句确保字面量数组
 * 与上游联合类型保持同步。
 */
export const THINKING_LEVELS = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const satisfies readonly ThinkingLevel[];

/** 将任意字符串收窄为 `ThinkingLevel` 的类型守卫。 */
export function isThinkingLevel(value: string): value is ThinkingLevel {
  return (THINKING_LEVELS as readonly string[]).includes(value);
}

/**
 * 规范化并验证用户提供的思考级别。比较前去除首尾
 * 空白并转为小写，使 CLI / TUI 输入
 * 无需单独清理。输入不匹配任何已知级别时，
 * 抛出列出合法值的错误。
 */
export function validateThinkingLevel(raw: string): ThinkingLevel {
  const normalized = raw.trim().toLowerCase();
  if (!isThinkingLevel(normalized)) {
    throw new Error(
      `Unknown thinking level: ${raw}. Expected one of ${THINKING_LEVELS.join(", ")}.`,
    );
  }
  return normalized;
}
