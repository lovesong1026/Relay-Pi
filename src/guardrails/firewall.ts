import type { Guardrail, GuardrailContext, GuardrailResult } from "../types/guardrails.js";

/**
 * 创建防护防火墙：串联多个防护，并在首次阻止时失败。
 * 将模式、语义和自定义防护组合成单次检查。
 */
export function createFirewall(guardrails: Guardrail[]): Guardrail {
  return {
    name: "firewall",
    description: `Composite firewall of ${guardrails.length} guardrails`,
    async evaluate(context: GuardrailContext): Promise<GuardrailResult> {
      const warnings: string[] = [];

      for (const g of guardrails) {
        const result = await g.evaluate(context);
        if (!result.allowed) {
          return {
            allowed: false,
            reason: `[${g.name}] ${result.reason}`,
            suggestion: result.suggestion,
          };
        }
        if (result.reason) {
          warnings.push(`[${g.name}] ${result.reason}`);
        }
      }

      return {
        allowed: true,
        reason: warnings.length > 0 ? warnings.join("; ") : undefined,
      };
    },
  };
}
