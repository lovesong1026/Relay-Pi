import type { Usage } from "@earendil-works/pi-ai";
import dedent from "dedent";
import { Type } from "typebox";
import * as structuredOutput from "../core/structured-output.js";
import type { TransportName } from "../model-resolution/catalog.js";
import { resolveMeteredModelName } from "../model-resolution/resolver.js";
import {
  CLASSIFIER_SYSTEM_PROMPT,
  renderCacheContinuity,
  renderClassifierRules,
} from "./prompts.js";
import type { ClassifierTarget, TierDefinition } from "./table.js";

const CONTEXT_HINT_LIMIT = 1_000;

function classifierResultTool(routeNames: string[]) {
  return {
    name: "select_route",
    description: "Select exactly one existing route for the agent's next work.",
    parameters: Type.Object(
      {
        route: Type.Union(
          routeNames.map((name) => Type.Literal(name)),
          { description: "Exactly one route name from AVAILABLE ROUTES." },
        ),
        rationale: Type.String({
          minLength: 1,
          description: "One sentence explaining why this route matches the current work.",
        }),
      },
      { additionalProperties: false },
    ),
  };
}

/**
 * The runtime milestone that requested a classification. Owned here — where
 * the concept originates — and consumed by the router, the protocol event,
 * and the CLI probe, so the union can never drift across layers.
 */
export type RouteTrigger = "turn_start" | "cadence" | "advisor" | "step_trigger" | "compaction";

/** Lean routing facts supplied at a turn boundary or intra-turn milestone. */
export interface ClassifierInput {
  /** Virtual tier whose complete route set is being classified in one call. */
  tierName: string;
  /** Tier rules shown to the classifier; concrete targets remain hidden. */
  tier: TierDefinition;
  /** Administrator-authored routing and cache-preference policy. */
  guidance: string;
  /** Current concrete target and selecting route, when continuity is possible. */
  currentTarget?: string;
  /** Bounded summary of the preceding turn, used only to judge task continuity. */
  prevTurnHint?: string;
  /** Bounded description of what changed in the most recent agent step. */
  lastStepDelta?: string;
  /** Whether the pending input includes images; the router handles capability after classification. */
  hasImages: boolean;
  /** Event that requested classification, for interpreting sparse cadence/advisor context. */
  trigger: RouteTrigger;
}

/** Pure system/user prompt pair consumed by the structured-output classifier call. */
export interface ClassifierMessages {
  /** Stable classifier policy. */
  systemPrompt: string;
  /** Tier rules plus the lean, request-specific routing facts. */
  prompt: string;
}

/** Structured-output call seam; production binds `generateStructuredOutput`. */
export type ClassifierGenerate = typeof structuredOutput.generateStructuredOutput;

/** One attributed classifier call, shaped the same whichever path ran it. */
export interface ClassifierUsageReport {
  /** Provider-specific model id the call billed under. */
  modelId: string;
  /** Backend that carried the call. */
  transport: TransportName;
  /** Priced usage for this classification call. */
  usage: Usage;
}

/** Options for one live route decision. */
export interface ClassifyRouteOptions {
  /** Classifier target from the routing table. */
  target: ClassifierTarget;
  /** Cancels the provider request when its owning turn is interrupted. */
  signal?: AbortSignal;
  /** Receives the attributed usage for this call. */
  onUsage?: (report: ClassifierUsageReport) => void;
  /** Chat-path network seam for deterministic tests. */
  generate?: ClassifierGenerate;
}

/** A classifier choice that still names policy, not a concrete execution target. */
export interface ClassifierDecision {
  /** Existing route name selected from the supplied tier. */
  route: string;
  /** One-sentence explanation returned by the chat classifier. */
  rationale?: string;
  /**
   * Probability per route. The chat classifier never reports one; the field
   * stays on the contract so router and CLI reporting need not branch on the
   * classifier implementation.
   */
  probabilities?: Record<string, number>;
}

function boundedText(value: string | undefined): string | null {
  if (!value?.trim()) return null;
  const normalized = value.trim();
  return normalized.length <= CONTEXT_HINT_LIMIT
    ? normalized
    : `${normalized.slice(0, CONTEXT_HINT_LIMIT)}…`;
}

function boundedHint(value: string | undefined): string {
  return boundedText(value) ?? "Not provided.";
}

/** Build the complete lean chat-classifier prompts without reading runtime state. */
export function buildClassifierMessages(input: ClassifierInput): ClassifierMessages {
  const continuity = renderCacheContinuity(input.currentTarget);

  return {
    systemPrompt: CLASSIFIER_SYSTEM_PROMPT,
    prompt: dedent`
      ${renderClassifierRules(input.tierName, input.tier, input.guidance)}

      CLASSIFICATION CONTEXT:
      Trigger: ${input.trigger}
      Images present: ${input.hasImages ? "yes" : "no"}
      ${continuity}
      Previous-turn hint: ${boundedHint(input.prevTurnHint)}
      Current request / last-step delta: ${boundedHint(input.lastStepDelta)}

      Pick exactly one name from AVAILABLE ROUTES and give a one-sentence rationale.
    `,
  };
}

/** Route choice from a chat model, forced through the `select_route` tool. */
async function classifyWithChatModel(
  input: ClassifierInput,
  options: ClassifyRouteOptions,
): Promise<ClassifierDecision> {
  const model = resolveMeteredModelName(options.target.modelName);
  const messages = buildClassifierMessages(input);
  const generate = options.generate ?? structuredOutput.generateStructuredOutput;
  return await generate({
    model: `${model.provider}:${model.id}`,
    tool: classifierResultTool(Object.keys(input.tier.routes)),
    systemPrompt: messages.systemPrompt,
    prompt: messages.prompt,
    ...(options.target.thinkingLevel
      ? { callOptions: { reasoningEffort: options.target.thinkingLevel } }
      : {}),
    signal: options.signal,
    onUsage: (usage) =>
      options.onUsage?.({
        modelId: model.id,
        transport: model.provider as TransportName,
        usage,
      }),
  });
}

/** Classify one tier in one model call and reject any route outside that tier. */
export async function classifyRoute(
  input: ClassifierInput,
  options: ClassifyRouteOptions,
): Promise<ClassifierDecision> {
  const decision = await classifyWithChatModel(input, options);
  if (!Object.hasOwn(input.tier.routes, decision.route)) {
    throw new Error(
      `Classifier selected unknown route "${decision.route}" for tier "${input.tierName}".`,
    );
  }
  return decision;
}
