const OPEN = "<system-reminder>";
const CLOSE = "</system-reminder>";

/**
 * 将运行时注入的文本包装在单个 `<system-reminder>` 块中——这是
 * harness 在面向用户通道中发言统一使用的标签。具有幂等性：
 * 已经是完整提醒块的文本原样通过。
 */
export function systemReminder(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith(OPEN) && trimmed.endsWith(CLOSE)) return trimmed;
  return `${OPEN}\n${trimmed}\n${CLOSE}`;
}

/**
 * 移除每个 `<system-reminder>…</system-reminder>` 片段，同时保留
 * 周围文本。记忆观察和路由步骤触发器通过此函数处理
 * 对话记录，使 harness 的内部机制永远不会成为记忆或
 * 重新路由信号。
 */
export function stripSystemReminders(text: string): string {
  let stripped = text;
  let start = stripped.indexOf(OPEN);
  while (start !== -1) {
    // 感知深度：注入的提醒可能嵌套（被包装的消息本身
    // 包含提醒块）；移除到匹配的结束标签，而不是第一个。
    let depth = 0;
    let cursor = start;
    let end = -1;
    while (cursor < stripped.length) {
      const nextOpen = stripped.indexOf(OPEN, cursor + 1);
      const nextClose = stripped.indexOf(CLOSE, cursor + 1);
      if (nextClose === -1) break;
      if (nextOpen !== -1 && nextOpen < nextClose) {
        depth += 1;
        cursor = nextOpen;
        continue;
      }
      if (depth === 0) {
        end = nextClose;
        break;
      }
      depth -= 1;
      cursor = nextClose;
    }
    if (end === -1) break;
    stripped = `${stripped.slice(0, start)}\n${stripped.slice(end + CLOSE.length)}`;
    start = stripped.indexOf(OPEN);
  }
  return stripped.trim();
}
