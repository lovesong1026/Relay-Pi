import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { CampaignConfigName } from "./config-override.js";
import type { DatasetRow, ManifestEntry } from "./manifest.js";
import type { RunRolloutDependencies, RunRolloutSpec, RolloutContainer } from "./rollout.js";
import { runRollout } from "./rollout.js";
import { verifyPatchRoundTrip, type ExtractedPatch } from "./patch.js";
import type { RolloutTelemetry } from "./telemetry.js";

const SMOKE_CONFIG = "glm-pure" satisfies CampaignConfigName;
const SENTINEL_PATH = "relay-pi-swebench-smoke.txt";

/** 官方镜像中一次付费 packaging 与 gateway smoke 所需的输入。 */
export interface ContainerSmokeSpec {
  entry: ManifestEntry;
  datasetRow: DatasetRow;
  image: string;
  configPath: string;
  configSha256: string;
  limits: RunRolloutSpec["limits"];
}

/** patch 应用后在全新容器中也能复现的实时证据。 */
export interface ContainerSmokeResult {
  instanceId: string;
  artifactDirectory: string;
  terminalType: string;
  costUsd: number;
  patchBytes: number;
  patchPaths: string[];
  usageByModel: RolloutTelemetry["usageByModel"];
}

/**
 * 使用一个确定性的单文件任务执行精确的生产 rollout 路径，随后证明其 patch
 * 可逐字节应用到全新的官方镜像。
 */
export async function runContainerSmoke(
  dependencies: RunRolloutDependencies,
  spec: ContainerSmokeSpec,
): Promise<ContainerSmokeResult> {
  const sentinel = `relay-pi swebench smoke ${spec.entry.instanceId}\n`;
  const result = await runRollout(dependencies, {
    campaignId: "mac-live-smoke",
    config: SMOKE_CONFIG,
    entry: spec.entry,
    datasetRow: {
      ...spec.datasetRow,
      problemStatement: [
        "This is a packaging smoke check, not an issue investigation.",
        `In /testbed create ${SENTINEL_PATH} with exactly this one line:`,
        sentinel.trimEnd(),
        "Do not modify any other file. Verify the file, then finish without asking questions.",
      ].join("\n"),
    },
    trial: 1,
    image: spec.image,
    configPath: spec.configPath,
    configSha256: spec.configSha256,
    limits: spec.limits,
  });
  if (result.status.phase !== "completed" || result.status.terminalType !== "complete") {
    throw new Error(
      `Smoke ${spec.entry.instanceId} did not complete: ${result.status.failureKind ?? result.status.terminalType ?? result.status.message ?? "unknown"}. Evidence: ${result.attempt.directory}`,
    );
  }

  const [patch, patchPaths, telemetry] = await Promise.all([
    readFile(join(result.attempt.directory, "patch.diff"), "utf8"),
    readJson<string[]>(join(result.attempt.directory, "patch-paths.json")),
    readJson<RolloutTelemetry>(join(result.attempt.directory, "telemetry.json")),
  ]);
  if (JSON.stringify(patchPaths) !== JSON.stringify([SENTINEL_PATH])) {
    throw new Error(
      `Smoke ${spec.entry.instanceId} changed ${JSON.stringify(patchPaths)}, expected only ${SENTINEL_PATH}. Evidence: ${result.attempt.directory}`,
    );
  }
  if (telemetry.advisorCalls.total !== 0) {
    throw new Error(`Pure smoke unexpectedly called the advisor for ${spec.entry.instanceId}.`);
  }
  if (telemetry.terminalStatus !== "completed") {
    throw new Error(
      `Smoke ${spec.entry.instanceId} ended with runner status ${telemetry.terminalStatus}.`,
    );
  }

  const extracted: ExtractedPatch = {
    patch,
    bytes: Buffer.byteLength(patch),
    paths: patchPaths,
  };
  const roundTrip = dependencies.containerFactory(
    `relay-pi-swebench-smoke-roundtrip-${randomUUID()}`,
    spec.image,
  );
  await verifyFreshContainer(roundTrip, extracted, sentinel);

  return {
    instanceId: spec.entry.instanceId,
    artifactDirectory: result.attempt.directory,
    terminalType: result.status.terminalType,
    costUsd: telemetry.costUsdTotal,
    patchBytes: extracted.bytes,
    patchPaths,
    usageByModel: telemetry.usageByModel,
  };
}

async function verifyFreshContainer(
  container: RolloutContainer,
  extracted: ExtractedPatch,
  sentinel: string,
): Promise<void> {
  try {
    await container.start();
    await verifyPatchRoundTrip(container, extracted);
    const content = await container.exec(["cat", `/testbed/${SENTINEL_PATH}`]);
    if (content.exitCode !== 0 || content.stdout !== sentinel) {
      throw new Error(
        `Smoke round trip produced the wrong sentinel: ${content.stderr || JSON.stringify(content.stdout)}.`,
      );
    }
  } finally {
    await container.stop();
  }
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}
