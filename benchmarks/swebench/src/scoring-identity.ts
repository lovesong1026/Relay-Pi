import { CAMPAIGN_CONFIG_NAMES, type CampaignConfigName } from "./config-override.js";

/** 编码在官方 scorer 模型身份中的测试活动 arm 与 repetition。 */
export interface ScoringIdentity {
  /** 官方 scorer 评估其 patch 的基准测试配置。 */
  config: CampaignConfigName;
  /** 此实例和配置使用的从 1 开始的测试活动 repetition。 */
  trial: number;
}

/**
 * 为每个逻辑 rollout 提供独立的官方 scorer 身份。
 *
 * Trial 1 保留原始测试活动名称，这样已有的单 trial artifact 仍可直接比较。
 * 重复 trial 会添加显式后缀，因为 SWE-bench 按 model 加 instance 为输出和缓存建立 key。
 */
export function scoringModelName(config: CampaignConfigName, trial: number): string {
  if (!Number.isSafeInteger(trial) || trial < 1) {
    throw new Error("Scoring trial must be a positive integer.");
  }
  return `relay-pi-${config}${trial === 1 ? "" : `-trial-${trial}`}`;
}

/** 从官方 scorer 模型身份恢复测试活动 arm 与 trial。 */
export function parseScoringModelName(model: string): ScoringIdentity {
  const trialOneConfig = CAMPAIGN_CONFIG_NAMES.find(
    (config) => model === scoringModelName(config, 1),
  );
  if (trialOneConfig) return { config: trialOneConfig, trial: 1 };
  for (const config of CAMPAIGN_CONFIG_NAMES) {
    const prefix = `${scoringModelName(config, 1)}-trial-`;
    if (!model.startsWith(prefix)) continue;
    const suffix = model.slice(prefix.length);
    const trial = Number(suffix);
    if (Number.isSafeInteger(trial) && trial > 1 && String(trial) === suffix) {
      return { config, trial };
    }
  }
  throw new Error(`Unknown campaign model_name_or_path: ${model}.`);
}
