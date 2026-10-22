import { complete } from "@earendil-works/pi-ai/compat";
import type { ImageContent, TextContent, ThinkingLevel, Usage } from "@earendil-works/pi-ai";
import { resolveProviderApiKey } from "../model-resolution/provider-catalog.js";
import { resolveModelName } from "../model-resolution/resolver.js";
import { ADVISOR_SYSTEM_PROMPT } from "./prompts.js";

/** Anthropic's advisor guide recommends 2,048 as the starting output cap for compact guidance. */
export const ADVISOR_MAX_OUTPUT_TOKENS = 2_048;

/** Inputs for one advisor generation after catalog shorthand resolution. */
export interface CallAdvisorInput {
  /** Wire-faithful executor context sent as quoted advisor-call content. */
  contextText: string;
  /** Executor images forwarded as real multimodal inputs in transcript order. */
  images: readonly ImageContent[];
  /** Catalog model id, already resolved by the composition site. */
  modelName: string;
  /** Reasoning effort forwarded to the provider. */
  thinkingLevel: ThinkingLevel;
  /** Cancels the advisor request with the parent tool execution. */
  signal?: AbortSignal;
}

/** Compact text returned to the executor after an advisor consultation. */
export interface AdvisorResult {
  /** Compact strategic guidance returned to the executor tool. */
  advice: string;
  /** Provider-reported token usage for pricing and live turn attribution. */
  usage: Usage;
}

/**
 * Run one advisor call through pi-ai's completion path. No provider options
 * are supplied beyond the output cap and effort, so this side call opts into
 * neither prompt caching nor any provider-specific request behavior.
 */
export async function callAdvisor(input: CallAdvisorInput): Promise<AdvisorResult> {
  const model = resolveModelName(input.modelName);
  const apiKey = resolveProviderApiKey(model.provider);
  const content: Array<TextContent | ImageContent> = [
    { type: "text", text: input.contextText },
    ...input.images.map((image) => ({
      type: "image" as const,
      data: image.data,
      mimeType: image.mimeType,
    })),
  ];
  const response = await complete(
    model,
    {
      systemPrompt: ADVISOR_SYSTEM_PROMPT,
      messages: [{ role: "user", content, timestamp: Date.now() }],
    },
    {
      maxTokens: ADVISOR_MAX_OUTPUT_TOKENS,
      reasoningEffort: input.thinkingLevel,
      ...(input.signal ? { signal: input.signal } : {}),
      ...(apiKey ? { apiKey } : {}),
    },
  );
  const advice = response.content
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
  return { advice, usage: response.usage };
}
