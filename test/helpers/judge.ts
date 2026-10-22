import { type Tool } from "@earendil-works/pi-ai";
import dedent from "dedent";
import { Type, type Static } from "typebox";
import { generateStructuredOutput } from "../../src/core/structured-output.js";

const judgeSchema = Type.Object({
  valid: Type.Boolean({ description: "Whether the input satisfies the judgment prompt" }),
  reason: Type.String({ description: "One concise sentence explaining the decision" }),
});

export type JudgeResult = Static<typeof judgeSchema>;

const judgeTool: Tool<typeof judgeSchema> = {
  name: "judgeInput",
  description: "Judge whether arbitrary input satisfies the prompt",
  parameters: judgeSchema,
};

// Use the shorthand so the judge resolves through the configured router
// (OpenRouter with OPENROUTER_API_KEY). Pinning the provider here would make
// the helper unusable wherever that credential is absent.
const judgeModel = "gpt-6-sol";

export async function judge(input: {
  prompt: string;
  value: unknown;
  model?: string;
  systemPrompt?: string;
  /** Bound a live evaluation without leaving the provider request in flight. */
  signal?: AbortSignal;
}): Promise<JudgeResult> {
  return generateStructuredOutput({
    model: input.model ?? process.env.JUDGE_MODEL ?? judgeModel,
    signal: input.signal,
    tool: judgeTool,
    systemPrompt:
      input.systemPrompt ??
      dedent`
        You are a test judge. Return valid=true only when the provided input
        satisfies the user's judgment prompt.
      `,
    prompt: dedent`
      JUDGMENT PROMPT:
      ${input.prompt}

      INPUT:
      ${JSON.stringify(input.value, null, 2)}
    `,
  });
}
