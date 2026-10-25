import type {
  Guardrail,
  GuardrailContext,
  GuardrailResult,
  PatternGuardrailRuleConfig,
} from "../types/guardrails.js";

/**
 * 基于模式的防护：使用正则表达式进行快速、确定性检查。
 * 用于已知危险模式（rm -rf /、DROP TABLE 等）。
 */
export class PatternGuardrail implements Guardrail {
  name = "pattern";
  description = "Regex-based action pattern matching";

  constructor(private readonly rules: PatternGuardrailRuleConfig[] = DEFAULT_RULES) {}

  async evaluate(context: GuardrailContext): Promise<GuardrailResult> {
    for (const rule of this.rules) {
      if (rule.pattern.test(context.content)) {
        if (rule.action === "block") {
          return { allowed: false, reason: rule.reason };
        }
        // "warn" 仍然允许执行，但会加以标记
        return {
          allowed: true,
          reason: `Warning: ${rule.reason}`,
        };
      }
    }
    return { allowed: true };
  }
}

const DEFAULT_RULES: PatternGuardrailRuleConfig[] = [
  {
    pattern: /rm\s+(-rf?|--recursive)\s+\/(?!\w)/,
    action: "block",
    reason: "Destructive: recursive delete at root",
  },
  {
    pattern: /DROP\s+(TABLE|DATABASE)/i,
    action: "block",
    reason: "Destructive: SQL DROP statement",
  },
  {
    pattern: /:(){ :\|:& };:/,
    action: "block",
    reason: "Fork bomb detected",
  },
  {
    pattern: />\s*\/dev\/sd[a-z]/,
    action: "block",
    reason: "Direct write to block device",
  },
  {
    pattern: /mkfs\./,
    action: "block",
    reason: "Filesystem format command",
  },
  {
    pattern: /curl\s.*\|\s*(bash|sh|zsh)/,
    action: "warn",
    reason: "Piping curl to shell — verify the source",
  },
  {
    pattern: /chmod\s+777/,
    action: "warn",
    reason: "Setting world-writable permissions",
  },
  {
    pattern: /--force|--hard|--no-verify/,
    action: "warn",
    reason: "Bypassing safety check",
  },
];
