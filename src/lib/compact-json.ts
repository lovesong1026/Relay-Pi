/**
 * 面向工具调用参数、感知宽度的 JSON 格式化器。
 *
 * `JSON.stringify(value, null, 2)` 总是将开闭花括号和
 * 每个键放到单独的行上，使较短的工具输入如
 * `{"path": "src/cli.ts"}` 渲染成四行。此格式化器将小型
 * 对象和数组保持在行内，仅当行内形式在当前缩进深度下
 * 超出 `maxWidth` 列时才换行。
 */
export function formatCompactJson(value: unknown, maxWidth = 100, indent = 2): string {
  return format(value, 0, maxWidth, indent);
}

function format(value: unknown, depth: number, maxWidth: number, indent: number): string {
  const inline = JSON.stringify(value);
  if (inline === undefined) return "undefined";

  // 叶节点和较短的复合值在行内渲染。
  if (typeof value !== "object" || value === null) return inline;
  if (depth * indent + inline.length <= maxWidth) return inline;

  const pad = " ".repeat((depth + 1) * indent);
  const closePad = " ".repeat(depth * indent);

  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const items = value.map((item) => `${pad}${format(item, depth + 1, maxWidth, indent)}`);
    return `[\n${items.join(",\n")}\n${closePad}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return "{}";
  const items = entries.map(
    ([key, item]) => `${pad}${JSON.stringify(key)}: ${format(item, depth + 1, maxWidth, indent)}`,
  );
  return `{\n${items.join(",\n")}\n${closePad}}`;
}
