import type { Model } from "@earendil-works/pi-ai";
import type { Observation } from "./memory.js";
import type { TurnState } from "./protocol.js";

export interface GuardrailResult {
  allowed: boolean;
  reason?: string;
  suggestion?: string;
}

export interface Guardrail {
  name: string;
  description: string;
  evaluate(context: GuardrailContext): Promise<GuardrailResult>;
}

export interface PatternGuardrailRuleConfig {
  pattern: RegExp;
  action: "block" | "warn";
  reason: string;
}

/** 叠加在 runner 默认策略之上的额外 guardrail 策略。 */
export type GuardrailConfig =
  | { kind: "pattern"; rules: PatternGuardrailRuleConfig[] }
  | { kind: "semantic"; model: Model<any>; policy: string };

export interface GuardrailContext {
  action: string;
  content: string;
  memories: Observation[];
  session: TurnState;
}
