import { readFile } from "node:fs/promises";

import type { CampaignConfigName } from "./config-override.js";
import type { RolloutAttempt } from "./artifacts.js";
import { scoringModelName } from "./scoring-identity.js";

/** 官方 SWE-bench predictions loader 接受的精确记录。 */
export interface SwebenchPrediction {
  instance_id: string;
  /** 不透明的官方运行身份；重复 trial 必须使用不同值。 */
  model_name_or_path: string;
  model_patch: string;
}

/** 将已完成的不可变 attempt 转换为每个逻辑 rollout 一条 prediction。 */
export async function buildPredictions(
  attempts: readonly RolloutAttempt[],
  config: CampaignConfigName,
): Promise<SwebenchPrediction[]> {
  const latestByRollout = new Map<string, RolloutAttempt>();
  for (const attempt of attempts) {
    if (attempt.spec.config !== config || attempt.status.phase !== "completed") continue;
    const key = `${attempt.spec.instanceId}:t${attempt.spec.trial}`;
    const existing = latestByRollout.get(key);
    if (!existing || existing.status.attempt < attempt.status.attempt) {
      latestByRollout.set(key, attempt);
    }
  }
  return Promise.all(
    [...latestByRollout.values()]
      .sort(
        (left, right) =>
          left.spec.instanceId.localeCompare(right.spec.instanceId) ||
          left.spec.trial - right.spec.trial,
      )
      .map(async (attempt) => ({
        instance_id: attempt.spec.instanceId,
        model_name_or_path: scoringModelName(config, attempt.spec.trial),
        model_patch: await readFile(`${attempt.directory}/patch.diff`, "utf8"),
      })),
  );
}

export function serializePredictions(predictions: readonly SwebenchPrediction[]): string {
  return (
    predictions.map((prediction) => JSON.stringify(prediction)).join("\n") +
    (predictions.length > 0 ? "\n" : "")
  );
}
