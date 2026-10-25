import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { TurnEvent } from "../../../src/types/protocol.js";
import type { CampaignConfigName } from "./config-override.js";
import type { RolloutTelemetry } from "./telemetry.js";

/** 不可变重试 attempt 共享的逻辑 rollout 身份。 */
export interface RolloutIdentity {
  campaignId: string;
  config: CampaignConfigName;
  instanceId: string;
  trial: number;
}

/** 哈希决定 artifact 能否恢复的冻结输入。 */
export interface RolloutArtifactSpec extends RolloutIdentity {
  /** 为此任务解析出的可读官方 harness 引用。 */
  image: string;
  /** 实际用于启动 rollout 的不可变 Docker 内容身份。 */
  imageId: string;
  relayPiSha256: string;
  configSha256: string;
  /** 传给每个 arm 且完全相同的基准测试自有系统指令哈希。 */
  systemPromptSha256: string;
  promptSha256: string;
  limits: {
    costUsd: number;
    wallClockMs: number;
    interruptGraceMs?: number;
    patchBytes: number;
  };
}

export type RolloutFailureKind = "agent" | "infra" | "patch";

/** 原子完成标记；缺失或处于 `running` 阶段表示工作崩溃。 */
export interface RolloutStatus {
  schemaVersion: 1;
  phase: "running" | "completed" | "failed";
  specHash: string;
  attempt: number;
  startedAt: string;
  finishedAt?: string;
  failureKind?: RolloutFailureKind;
  message?: string;
  terminalType?: string;
  costUsd?: number;
}

/** 一个不可变 filesystem attempt 及其当前标记。 */
export interface RolloutAttempt {
  directory: string;
  spec: RolloutArtifactSpec;
  status: RolloutStatus;
}

/** 对由调用方控制键顺序的 JSON 兼容值计算稳定 SHA-256。 */
export function hashJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** 对 prompt 或已提交 render 等精确文本字节计算 SHA-256。 */
export function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** 分配新的 attempt，不修改任何更早的失败或崩溃 attempt。 */
export async function beginRolloutAttempt(
  runsRoot: string,
  spec: RolloutArtifactSpec,
): Promise<RolloutAttempt> {
  validateIdentity(spec);
  const configRoot = join(runsRoot, spec.campaignId, spec.config);
  await mkdir(configRoot, { recursive: true });
  const prefix = `${spec.instanceId}-t${spec.trial}`;
  const names = await readdir(configRoot);
  const attempt =
    1 +
    names.reduce((highest, name) => {
      if (name === prefix) return Math.max(highest, 1);
      const match = name.match(new RegExp(`^${escapeRegExp(prefix)}-a(\\d+)$`));
      return match ? Math.max(highest, Number(match[1])) : highest;
    }, 0);
  const directory = join(configRoot, attempt === 1 ? prefix : `${prefix}-a${attempt}`);
  const status: RolloutStatus = {
    schemaVersion: 1,
    phase: "running",
    specHash: hashJson(spec),
    attempt,
    startedAt: new Date().toISOString(),
  };
  await mkdir(directory);
  await atomicWriteJson(join(directory, "spec.json"), spec);
  await atomicWriteJson(join(directory, "status.json"), status);
  return { directory, spec, status };
}

/** 完成成功的 attempt；最后才重命名 `status.json`。 */
export async function completeRolloutAttempt(
  attempt: RolloutAttempt,
  values: {
    events: readonly TurnEvent[];
    patch: string;
    patchPaths: readonly string[];
    telemetry: RolloutTelemetry;
    terminalType: string;
  },
): Promise<RolloutStatus> {
  await writeAttemptEvidence(attempt.directory, values.events, values.telemetry);
  await Promise.all([
    atomicWrite(join(attempt.directory, "patch.diff"), values.patch),
    atomicWriteJson(join(attempt.directory, "patch-paths.json"), values.patchPaths),
  ]);
  const status: RolloutStatus = {
    ...attempt.status,
    phase: "completed",
    finishedAt: new Date().toISOString(),
    terminalType: values.terminalType,
    costUsd: values.telemetry.costUsdTotal,
  };
  await atomicWriteJson(join(attempt.directory, "status.json"), status);
  return status;
}

/** 完成失败的 attempt，同时保留失败时可用的所有证据。 */
export async function failRolloutAttempt(
  attempt: RolloutAttempt,
  values: {
    kind: RolloutFailureKind;
    message: string;
    events?: readonly TurnEvent[];
    telemetry?: RolloutTelemetry;
    patch?: string;
    patchPaths?: readonly string[];
    terminalType?: string;
  },
): Promise<RolloutStatus> {
  if (values.events && values.telemetry) {
    await writeAttemptEvidence(attempt.directory, values.events, values.telemetry);
  }
  if (values.patch !== undefined)
    await atomicWrite(join(attempt.directory, "patch.diff"), values.patch);
  if (values.patchPaths !== undefined) {
    await atomicWriteJson(join(attempt.directory, "patch-paths.json"), values.patchPaths);
  }
  const status: RolloutStatus = {
    ...attempt.status,
    phase: "failed",
    finishedAt: new Date().toISOString(),
    failureKind: values.kind,
    message: values.message,
    ...(values.terminalType ? { terminalType: values.terminalType } : {}),
    ...(values.telemetry ? { costUsd: values.telemetry.costUsdTotal } : {}),
  };
  await atomicWriteJson(join(attempt.directory, "status.json"), status);
  return status;
}

/** 读取每个 attempt 的标记，用于状态、预算和恢复规划。 */
export async function loadRolloutAttempts(
  runsRoot: string,
  campaignId: string,
): Promise<RolloutAttempt[]> {
  const campaignRoot = join(runsRoot, campaignId);
  const attempts: RolloutAttempt[] = [];
  for (const configName of await safeReaddir(campaignRoot)) {
    const configRoot = join(campaignRoot, configName);
    for (const attemptName of await safeReaddir(configRoot)) {
      const directory = join(configRoot, attemptName);
      try {
        const [spec, status] = await Promise.all([
          readJson<RolloutArtifactSpec>(join(directory, "spec.json")),
          readJson<RolloutStatus>(join(directory, "status.json")),
        ]);
        attempts.push({ directory, spec, status });
      } catch {
        // 进程可能在创建目录到写入首个原子标记之间退出。此目录是未完成的证据，绝不能视为已完成工作。
      }
    }
  }
  return attempts;
}

async function writeAttemptEvidence(
  directory: string,
  events: readonly TurnEvent[],
  telemetry: RolloutTelemetry,
): Promise<void> {
  const ndjson = events.map((event) => JSON.stringify(event)).join("\n");
  await Promise.all([
    atomicWrite(join(directory, "events.ndjson"), ndjson ? `${ndjson}\n` : ""),
    atomicWriteJson(join(directory, "telemetry.json"), telemetry),
  ]);
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await atomicWrite(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function atomicWrite(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${randomUUID()}`;
  await writeFile(temporary, value);
  await rename(temporary, path);
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function safeReaddir(path: string): Promise<string[]> {
  try {
    return (await readdir(path)).sort();
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return [];
    throw error;
  }
}

function validateIdentity(identity: RolloutIdentity): void {
  for (const [name, value] of [
    ["campaignId", identity.campaignId],
    ["config", identity.config],
    ["instanceId", identity.instanceId],
  ] as const) {
    if (typeof value !== "string" || !/^[A-Za-z0-9_.-]+$/.test(value)) {
      throw new Error(`${name} is not a safe artifact path component.`);
    }
  }
  if (!Number.isSafeInteger(identity.trial) || identity.trial < 1) {
    throw new Error("trial must be a positive integer.");
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
