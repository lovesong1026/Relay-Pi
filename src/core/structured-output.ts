import { complete } from "@earendil-works/pi-ai/compat";
import {
  validateToolArguments,
  type ImageContent,
  type Model,
  type ProviderStreamOptions,
  type TextContent,
  type Tool,
  type ToolCall,
  type Usage,
} from "@earendil-works/pi-ai";
import type { Static, TSchema } from "typebox";
import { resolveModelName } from "../model-resolution/resolver.js";
import { resolveProviderApiKey } from "../model-resolution/provider-catalog.js";
import { usageForTransport } from "../connected-providers/billing.js";

export type StructuredOutputPrompt = string | Array<TextContent | ImageContent>;

export interface StructuredOutputOptions<TSchemaValue extends TSchema> {
  model: string;
  tool: Tool<TSchemaValue>;
  prompt: StructuredOutputPrompt;
  systemPrompt?: string;
  /** 取消 provider 流，并向调用方呈现已中止的完成结果。 */
  signal?: AbortSignal;
  callOptions?: ProviderStreamOptions;
  onUsage?: (usage: Usage) => void;
}

export async function generateStructuredOutput<TSchemaValue extends TSchema>(
  options: StructuredOutputOptions<TSchemaValue>,
): Promise<Static<TSchemaValue>> {
  const model = resolveModelName(options.model);
  // api-dispatch 的 `complete()` 调用本身不解析 provider 认证，
  // 因此这里将 `resolveProviderApiKey` 找到的凭据传给它。
  // 每个请求中，显式 `callOptions.apiKey` 仍具有优先权。
  const resolvedApiKey = options.callOptions?.apiKey ?? resolveProviderApiKey(model.provider);
  const callerOnPayload = options.callOptions?.onPayload;
  const response = await complete(
    model,
    {
      systemPrompt: options.systemPrompt,
      tools: [options.tool],
      messages: [{ role: "user", content: options.prompt, timestamp: Date.now() }],
    },
    {
      ...options.callOptions,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(resolvedApiKey ? { apiKey: resolvedApiKey } : {}),
      toolChoice: forcedToolChoice(model, options.tool.name),
      onPayload: async (payload, payloadModel) => {
        const next = callerOnPayload ? await callerOnPayload(payload, payloadModel) : undefined;
        const base = next ?? payload;
        return injectResponsesToolChoice(payloadModel, base, options.tool.name);
      },
    },
  );
  options.onUsage?.(
    usageForTransport(
      response.usage,
      model.provider as import("../model-resolution/catalog.js").TransportName,
    ),
  );

  const toolCall = response.content.find((block) => isNamedToolCall(block, options.tool.name));
  if (!toolCall) {
    const contentTypes = response.content.map((block) => block.type).join(", ") || "empty";
    throw new Error(
      `Model did not call required structured output tool: ${options.tool.name}. Stop reason: ${response.stopReason}. Response content: ${contentTypes}${response.errorMessage ? `. Error: ${response.errorMessage}` : ""}`,
    );
  }

  return validateToolArguments(options.tool, toolCall) as Static<TSchemaValue>;
}

function isNamedToolCall(block: unknown, name: string): block is ToolCall {
  return (
    typeof block === "object" &&
    block !== null &&
    "type" in block &&
    block.type === "toolCall" &&
    "name" in block &&
    block.name === name &&
    "arguments" in block &&
    typeof block.arguments === "object" &&
    block.arguments !== null
  );
}

function forcedToolChoice(model: Model<any>, toolName: string): Record<string, unknown> {
  if (model.api === "anthropic-messages") {
    return { type: "tool", name: toolName };
  }

  return {
    type: "function",
    function: { name: toolName },
  };
}

/**
 * pi-ai 的 `openai-responses` provider 不读取 `options.toolChoice`，
 * 因此 {@link forcedToolChoice} 的值永远不会到达 OpenAI Responses
 * API。没有 `tool_choice` 时，模型可以自由地以文本回答，在
 * 大型输入（例如完整的 memory-reflect 池）上确实如此，最终表现
 * 为 `Model did not call required structured output tool`。
 *
 * 我们通过 `onPayload` 补齐这一缺口，它允许修改
 * pi-ai 即将发送的参数。Responses API 期望扁平的
 * `{ type: "function", name: "<tool>" }` 结构（而非 Chat Completions
 * 嵌套的 `{ function: { name } }`），因此当载荷看起来符合
 * Responses 请求结构时，我们直接注入该值。
 */
function injectResponsesToolChoice(model: Model<any>, payload: unknown, toolName: string): unknown {
  if (model.api !== "openai-responses" && model.api !== "azure-openai-responses") {
    return payload;
  }
  if (payload === null || typeof payload !== "object") return payload;
  return {
    ...(payload as Record<string, unknown>),
    tool_choice: { type: "function", name: toolName },
  };
}
