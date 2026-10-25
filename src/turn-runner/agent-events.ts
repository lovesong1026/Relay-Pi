import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { TurnStepEvent } from "../types/protocol.js";

/**
 * 将 pi Agent 事件转换为回合步骤事件。
 *
 * 转换器是有状态的：pi 的 `tool_execution_end` 不携带工具参数，但规范的
 * `tool_call` 步骤是自包含的（会回显调用的 `input`，这与 `text_delta` 之后
 * 规范的 `text` 步骤携带完整文本的方式一致）。每次调用的 input 都会从
 * `tool_execution_start` 记住，直到对应的结束事件到达。工具调用 ID 在父
 * Agent 与 state Agent 之间也是唯一的，因此每个 runner 只需一个转换器。
 */
export function createAgentEventTranslator(): (event: AgentEvent) => TurnStepEvent[] {
  const inputByToolCallId = new Map<string, Record<string, any> | undefined>();

  return (event) => {
    switch (event.type) {
      case "message_update": {
        const update = event.assistantMessageEvent;
        switch (update.type) {
          case "text_delta":
            return [{ type: "step", step: { type: "text_delta", delta: update.delta } }];
          case "thinking_delta":
            return [{ type: "step", step: { type: "reasoning_delta", delta: update.delta } }];
          case "text_end":
            return [{ type: "step", step: { type: "text", text: update.content } }];
          case "thinking_end":
            return [{ type: "step", step: { type: "reasoning", text: update.content } }];
        }
        return [];
      }
      case "tool_execution_start":
        inputByToolCallId.set(event.toolCallId, event.args);
        return [
          {
            type: "step",
            step: {
              type: "tool_call_start",
              toolName: event.toolName,
              toolCallId: event.toolCallId,
              input: event.args,
            },
          },
        ];
      case "tool_execution_end": {
        const input = inputByToolCallId.get(event.toolCallId);
        inputByToolCallId.delete(event.toolCallId);
        return [
          {
            type: "step",
            step: {
              type: "tool_call",
              toolName: event.toolName,
              toolCallId: event.toolCallId,
              input,
              isError: event.isError,
              output: event.result?.content,
              details: event.result?.details,
            },
          },
        ];
      }
      default:
        return [];
    }
  };
}

export function agentMessageText(message: AgentMessage): string {
  const content = "content" in message ? message.content : undefined;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part) =>
      part && typeof part === "object" && "text" in part && typeof part.text === "string"
        ? [part.text]
        : [],
    )
    .join("\n");
}

/** 判断 Agent 事件是否已越过传输回退重放边界。 */
export function isExternallyVisibleAgentEvent(event: AgentEvent): boolean {
  if (event.type === "tool_execution_start" || event.type === "tool_execution_end") return true;
  if (event.type !== "message_update") return false;
  const update = event.assistantMessageEvent;
  return (
    ((update.type === "text_delta" || update.type === "thinking_delta") &&
      update.delta.length > 0) ||
    ((update.type === "text_end" || update.type === "thinking_end") && update.content.length > 0)
  );
}
