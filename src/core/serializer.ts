import type { AgentMessage } from "@earendil-works/pi-agent-core";

interface TextContentBlock {
  type: "text";
  text: string;
}

function isTextContentBlock(block: unknown): block is TextContentBlock {
  return (
    typeof block === "object" &&
    block !== null &&
    "type" in block &&
    (block as { type: unknown }).type === "text" &&
    "text" in block &&
    typeof (block as { text: unknown }).text === "string"
  );
}

export function assistantText(messages: AgentMessage[]): string {
  const assistant = [...messages].reverse().find((message) => message.role === "assistant");
  if (!assistant) return "";
  const content = (assistant as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(isTextContentBlock)
    .map((block) => block.text)
    .join("\n")
    .trim();
}

/**
 * 按顺序拼接每条助手消息的文本内容。当调用方关心某个
 * token 是否出现在父对话记录中的任意位置，而不仅是最新
 * 助手消息时很有用——例如确认回合评测，模型
 * 可能在 SM1 的确认中输出该 token，而 SM2 的确认追加
 * 了尾部摘要，否则会在 `assistantText` 中将其遮蔽。
 */
export function allAssistantText(messages: AgentMessage[]): string {
  return messages
    .filter((message) => message.role === "assistant")
    .flatMap((message) => {
      const content = (message as { content?: unknown }).content;
      return Array.isArray(content) ? content.filter(isTextContentBlock).map((b) => b.text) : [];
    })
    .join("\n");
}
