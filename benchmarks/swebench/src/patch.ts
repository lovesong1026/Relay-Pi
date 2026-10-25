import { randomUUID } from "node:crypto";

import type { CommandResult } from "./container.js";
/** staged-index patch 处理所需的最小容器操作。 */
export interface PatchContainer {
  exec(
    argv: readonly string[],
    options?: { cwd?: string; env?: Record<string, string>; stdin?: string },
  ): Promise<CommandResult>;
}

/** 官方镜像在模型运行前的私有 Git tree。 */
export interface PatchBaseline {
  indexPath: string;
  tree: string;
  /** 为 provenance 保留的镜像已有修改，绝不提交。 */
  paths: string[];
}

/** 提交给官方 scorer 的精确 Agent 增量。 */
export interface ExtractedPatch {
  patch: string;
  bytes: number;
  /** Agent 修改并纳入官方 prediction 的每个路径。 */
  paths: string[];
}

/**
 * 对官方镜像的工作树创建快照，不要求 `git status` 干净。某些官方镜像会有意修改
 * 构建文件（例如 Druid 固定了 Maven resource bundle）；重置这些文件会改变基准测试。
 */
export async function capturePatchBaseline(container: PatchContainer): Promise<PatchBaseline> {
  const indexPath = `/tmp/relay-pi-index-${randomUUID()}`;
  const env = { GIT_INDEX_FILE: indexPath };
  await requireGit(container, ["git", "-C", "/testbed", "read-tree", "HEAD"], env);
  await requireGit(container, ["git", "-C", "/testbed", "add", "-A"], env);
  const tree = (
    await requireGit(container, ["git", "-C", "/testbed", "write-tree"], env)
  ).stdout.trim();
  if (!/^[0-9a-f]{40,64}$/.test(tree)) {
    throw new Error(`Could not capture official image baseline tree: ${JSON.stringify(tree)}.`);
  }
  const names = await requireGit(
    container,
    ["git", "-C", "/testbed", "diff", "--cached", "--name-only", "-z", "HEAD", "--"],
    env,
  );
  return { indexPath, tree, paths: splitPaths(names.stdout) };
}

/** 基于捕获的 baseline 暂存最终工作树，并只输出 Agent 增量。 */
export async function extractPatch(
  container: PatchContainer,
  baseline: PatchBaseline,
  maxBytes: number,
): Promise<ExtractedPatch> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new RangeError("maxBytes must be a positive safe integer.");
  }
  const env = { GIT_INDEX_FILE: baseline.indexPath };
  await requireGit(container, ["git", "-C", "/testbed", "add", "-A"], env);
  const names = await requireGit(
    container,
    ["git", "-C", "/testbed", "diff", "--cached", "--name-only", "-z", baseline.tree, "--"],
    env,
  );
  const changedPaths = splitPaths(names.stdout);
  const patch =
    changedPaths.length === 0
      ? ""
      : (
          await requireGit(
            container,
            [
              "git",
              "-C",
              "/testbed",
              "diff",
              "--cached",
              "--binary",
              "--full-index",
              baseline.tree,
              "--",
              ...changedPaths,
            ],
            env,
          )
        ).stdout;
  const bytes = Buffer.byteLength(patch);
  if (bytes > maxBytes) {
    throw new Error(`Rollout patch is ${bytes} bytes, above the ${maxBytes}-byte limit.`);
  }
  return { patch, bytes, paths: changedPaths };
}

/** 将 patch 应用到同一官方 baseline，并证明它还原了路径集合。 */
export async function verifyPatchRoundTrip(
  container: PatchContainer,
  extracted: ExtractedPatch,
): Promise<void> {
  const baseline = await capturePatchBaseline(container);
  const applied = await container.exec(["git", "-C", "/testbed", "apply", "--binary", "-"], {
    stdin: extracted.patch,
  });
  if (applied.exitCode !== 0) {
    throw new Error(`Extracted patch does not apply cleanly: ${applied.stderr || applied.stdout}`);
  }
  const env = { GIT_INDEX_FILE: baseline.indexPath };
  await requireGit(container, ["git", "-C", "/testbed", "add", "-A"], env);
  const names = await requireGit(
    container,
    ["git", "-C", "/testbed", "diff", "--cached", "--name-only", "-z", baseline.tree, "--"],
    env,
  );
  const actual = splitPaths(names.stdout).sort();
  const expected = [...extracted.paths].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Round-trip paths differ: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}.`,
    );
  }
  const diff = await requireGit(
    container,
    ["git", "-C", "/testbed", "diff", "--cached", "--binary", "--full-index", baseline.tree, "--"],
    env,
  );
  if (diff.stdout !== extracted.patch) {
    throw new Error("Round-trip patch bytes differ from the extracted patch.");
  }
}

function splitPaths(value: string): string[] {
  return value.split("\0").filter(Boolean);
}

async function requireGit(
  container: PatchContainer,
  argv: readonly string[],
  env: Record<string, string>,
) {
  const result = await container.exec(argv, { env });
  if (result.exitCode !== 0) {
    throw new Error(`Git command failed: ${argv.join(" ")}\n${result.stderr || result.stdout}`);
  }
  return result;
}
