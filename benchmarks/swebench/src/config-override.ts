import {
  BUILT_IN_ROUTING_TABLE,
  validateRoutingTable,
  type RoutingTable,
} from "../../../src/model-routing/table.js";
import { routingCatalogAdapter } from "../../../src/model-resolution/resolver.js";
import type { ThinkingLevel } from "@earendil-works/pi-ai";

export const SWEBENCH_TIER = "swebench";

/** 一个明确测试活动 arm 的模型替换与 advisor 处理方式。 */
export interface RenderModelsJsonOptions {
  /** 此测试活动中每条基准提示词使用的主 coding model。 */
  executorModel: "fable-5.1" | "glm-5.3" | "gpt-6-sol" | "kimi-k3" | "opus-5.5";
  /** 此测试活动 arm 中每轮发送给 executor 的思考强度。 */
  executorThinkingLevel: ThinkingLevel;
  /** 在 pure 与 advised render 中都保留 advisor，因此 OFF 只改变可用性。 */
  advisorModel: "kimi-k3" | "fable-5.1";
  /** 成对的 OFF 与 ON arm 中保持相同的模型专属 advisor 强度。 */
  advisorThinkingLevel: ThinkingLevel;
  /** 暴露或移除 advisor 工具，但不改变其 target 或 policy。 */
  advisorEnabled: boolean;
}

export const CAMPAIGN_CONFIGS = {
  "glm-pure": {
    executorModel: "glm-5.3",
    executorThinkingLevel: "xhigh",
    advisorModel: "kimi-k3",
    advisorThinkingLevel: "medium",
    advisorEnabled: false,
  },
  "glm-kimi-advisor": {
    executorModel: "glm-5.3",
    executorThinkingLevel: "xhigh",
    advisorModel: "kimi-k3",
    advisorThinkingLevel: "medium",
    advisorEnabled: true,
  },
  "kimi-pure": {
    executorModel: "kimi-k3",
    executorThinkingLevel: "high",
    advisorModel: "fable-5.1",
    advisorThinkingLevel: "high",
    advisorEnabled: false,
  },
  "kimi-fable-advisor": {
    executorModel: "kimi-k3",
    executorThinkingLevel: "high",
    advisorModel: "fable-5.1",
    advisorThinkingLevel: "high",
    advisorEnabled: true,
  },
  "opus-pure": {
    executorModel: "opus-5.5",
    executorThinkingLevel: "xhigh",
    advisorModel: "fable-5.1",
    advisorThinkingLevel: "high",
    advisorEnabled: false,
  },
  "sol-fable-advisor": {
    executorModel: "gpt-6-sol",
    executorThinkingLevel: "xhigh",
    advisorModel: "fable-5.1",
    advisorThinkingLevel: "high",
    advisorEnabled: true,
  },
  "opus-fable-advisor": {
    executorModel: "opus-5.5",
    executorThinkingLevel: "xhigh",
    advisorModel: "fable-5.1",
    advisorThinkingLevel: "high",
    advisorEnabled: true,
  },
  "fable-pure": {
    executorModel: "fable-5.1",
    executorThinkingLevel: "high",
    advisorModel: "fable-5.1",
    advisorThinkingLevel: "high",
    advisorEnabled: false,
  },
} as const satisfies Record<string, RenderModelsJsonOptions>;

export type CampaignConfigName = keyof typeof CAMPAIGN_CONFIGS;

/** 生成、评分和报告使用的规范测试活动 arm 顺序。 */
export const CAMPAIGN_CONFIG_NAMES = Object.keys(CAMPAIGN_CONFIGS) as CampaignConfigName[];

/**
 * 构建 RPC rollout 使用的完整项目路由表。
 *
 * 基准测试拥有一个通用 tier，而不是选择 executor 可能漂移的产品 tier。
 * 分类器和 advisor policy 从产品表复制；executor、advisor 以及固定的 Kimi
 * vision fallback 都是测试活动自有 target。
 */
export function renderModelsJson(options: RenderModelsJsonOptions): RoutingTable {
  const productRoute = structuredClone(BUILT_IN_ROUTING_TABLE.tiers.balanced.routes.implement);
  const productAdvisor = structuredClone(BUILT_IN_ROUTING_TABLE.tiers.frontier.advisor);
  const table: RoutingTable = {
    defaultTier: SWEBENCH_TIER,
    tiers: {
      [SWEBENCH_TIER]: {
        routes: {
          general: {
            ...productRoute,
            target: {
              modelName: options.executorModel,
              thinkingLevel: options.executorThinkingLevel,
            },
            // GLM 仅支持文本。在所有已提交 render 中保留相同的图像能力 fallback，
            // 使其成为 policy，而不是另一个实验变量。
            visionFallbackModelName: "kimi-k3",
          },
        },
        advisor: {
          ...productAdvisor,
          enabled: options.advisorEnabled,
          target: {
            modelName: options.advisorModel,
            thinkingLevel: options.advisorThinkingLevel,
          },
        },
      },
    },
    classifier: structuredClone(BUILT_IN_ROUTING_TABLE.classifier),
  };

  const issues = validateRoutingTable(table, routingCatalogAdapter);
  if (issues.length > 0) {
    throw new Error(
      `Invalid SWE-bench routing table:\n${issues.map((issue) => `- ${issue.path}: ${issue.message}`).join("\n")}`,
    );
  }
  return table;
}

/** 按确定性名称顺序物化每个显式路由文件。 */
export function renderCampaignConfigs(): Record<CampaignConfigName, RoutingTable> {
  return Object.fromEntries(
    CAMPAIGN_CONFIG_NAMES.map((name) => [name, renderModelsJson(CAMPAIGN_CONFIGS[name])]),
  ) as Record<CampaignConfigName, RoutingTable>;
}

export function serializeModelsJson(table: RoutingTable): string {
  return `${JSON.stringify(table, null, 2)}\n`;
}
