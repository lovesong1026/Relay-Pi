import { execFile, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import type { ResourceDiagnostic, Skill } from "@earendil-works/pi-coding-agent";
import { loadSkills } from "@earendil-works/pi-coding-agent";
import type { SkillDiscoveryOptions } from "../types/config.js";
import { walkAncestors } from "../lib/walk-ancestors.js";
import {
  getBuiltInSkillInstructions,
  isBuiltInSkill,
  listBuiltInSkills,
} from "./built-in-skills.js";

export interface SkillCollision {
  /** 发生冲突的 skill 名称。 */
  name: string;
  /** 获胜的路径（即实际加载的 skill）。 */
  winnerPath: string;
  /** 因冲突而跳过的路径。 */
  loserPath: string;
}

export interface DiscoveredSkillsResult {
  skills: Skill[];
  collisions: SkillCollision[];
}

const SKILL_SHELL_EXPANSION_PATTERN = /!`([\s\S]*?)`/g;
const DEFAULT_SKILL_DIR_NAMES = [".relay-pi", ".agents", ".claude"] as const;

function buildSkillDiscoveryOptions(options: SkillDiscoveryOptions | undefined, cwd: string) {
  const effectiveCwd = options?.cwd ?? cwd;
  const globalSkillRoots = options?.agentDir
    ? [options.agentDir]
    : DEFAULT_SKILL_DIR_NAMES.map((dirName) => join(homedir(), dirName));
  const includeDefaults = options?.includeDefaults ?? true;
  return {
    cwd: effectiveCwd,
    agentDir: globalSkillRoots[0],
    includeDefaults: false,
    skillPaths: uniquePaths([
      ...(includeDefaults ? defaultSkillPaths(globalSkillRoots, effectiveCwd) : []),
      ...(options?.skillPaths ?? []),
    ]),
  };
}

function defaultSkillPaths(globalSkillRoots: string[], cwd: string): string[] {
  // 项目级优先于全局级，因此项目本地 skill 可以覆盖同名全局 skill。在每个作用域内，
  // .relay-pi > .agents > .claude（先扫描者在名称冲突中获胜）。项目作用域会从 cwd 向上遍历到
  // 文件系统根目录，因此可以发现任意祖先目录中声明的 skill（例如仓库根目录或当前 package
  // 之上的 workspace 根目录）；较近目录排在前面，所以在冲突中获胜。
  const ancestorPaths: string[] = [];
  for (const ancestor of walkAncestors(cwd)) {
    for (const dirName of DEFAULT_SKILL_DIR_NAMES) {
      ancestorPaths.push(join(ancestor, dirName, "skills"));
    }
  }
  return [...ancestorPaths, ...globalSkillRoots.map((root) => join(root, "skills"))];
}

function uniquePaths(paths: string[]): string[] {
  return Array.from(new Set(paths));
}

const SKILL_SHELL_EXPANSION_TIMEOUT_MS = 30_000;
/** 重叠执行卡住的元数据命令，避免资源受限的 runner 宿主发生拥塞。 */
const SKILL_METADATA_EXPANSION_CONCURRENCY = 4;
const SKILL_SHELL_EXPANSION_OPTIONS = {
  encoding: "utf-8",
  maxBuffer: 1024 * 1024,
  timeout: SKILL_SHELL_EXPANSION_TIMEOUT_MS,
} as const;

function expandSkillShellCommandsSync(content: string, cwd: string): string {
  return content.replace(SKILL_SHELL_EXPANSION_PATTERN, (match, command: string) => {
    try {
      const output = execFileSync("bash", ["-lc", command], {
        cwd,
        ...SKILL_SHELL_EXPANSION_OPTIONS,
      });
      return output.trimEnd();
    } catch (error) {
      return failedSkillShellExpansion(match, error);
    }
  });
}

async function expandSkillShellCommands(content: string, cwd: string): Promise<string> {
  const matches = [...content.matchAll(SKILL_SHELL_EXPANSION_PATTERN)];
  if (matches.length === 0) return content;

  // 同一 description 内的展开保持历史上的从左到右顺序，因为后续命令可能会使用前面命令的副作用。
  // 并发应发生在相互独立的 skill 之间，而不是同一个 skill 内。
  const expansions: string[] = [];
  for (const match of matches) {
    expansions.push(await runSkillShellCommand(match[0], match[1]!, cwd));
  }

  // `replace` 会按相同顺序重新遍历这些 match，因此将结果拼回去仍沿用同步路径的机制，
  // 而不是另写一套手工实现。函数替换会原样插入，因此命令输出中的 `$&` 不会被重新解释。
  let next = 0;
  return content.replace(SKILL_SHELL_EXPANSION_PATTERN, () => expansions[next++]!);
}

function runSkillShellCommand(match: string, command: string, cwd: string): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      "bash",
      ["-lc", command],
      {
        cwd,
        ...SKILL_SHELL_EXPANSION_OPTIONS,
      },
      (error, stdout) => {
        resolve(error ? failedSkillShellExpansion(match, error) : stdout.trimEnd());
      },
    );
  });
}

function failedSkillShellExpansion(match: string, error: unknown): string {
  // 失败时保留原始 token，使模型能看到曾尝试过什么。Node 会通过子进程 signal
  // 报告超时终止。
  const signal = (error as { signal?: string } | null)?.signal;
  const note =
    signal === "SIGTERM"
      ? `timed out after ${SKILL_SHELL_EXPANSION_TIMEOUT_MS / 1000}s`
      : `failed: ${error instanceof Error ? error.message : String(error)}`;
  return `${match} (${note})`;
}

async function expandSkillMetadata(skill: Skill): Promise<Skill> {
  return {
    ...skill,
    description: await expandSkillShellCommands(skill.description, skill.baseDir),
  };
}

export function prepareExplicitSkills(skills: readonly Skill[]): Promise<Skill[]> {
  return expandSkillMetadataConcurrently(skills);
}

export async function loadDiscoveredSkills(
  discoveryOptions: SkillDiscoveryOptions | undefined,
  cwd: string,
): Promise<DiscoveredSkillsResult> {
  const { skills, diagnostics } = loadSkills(buildSkillDiscoveryOptions(discoveryOptions, cwd));
  // 用户/项目 skill 在名称冲突中获胜，因此内置 skill 最后合并；被覆盖时会静默丢弃。
  return {
    skills: mergeSkillsByName(await expandSkillMetadataConcurrently(skills), listBuiltInSkills()),
    collisions: extractSkillCollisions(diagnostics),
  };
}

async function expandSkillMetadataConcurrently(skills: readonly Skill[]): Promise<Skill[]> {
  const expanded: Skill[] = [];
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(SKILL_METADATA_EXPANSION_CONCURRENCY, skills.length) },
    async () => {
      while (nextIndex < skills.length) {
        const index = nextIndex++;
        expanded[index] = await expandSkillMetadata(skills[index]!);
      }
    },
  );
  await Promise.all(workers);
  return expanded;
}

/**
 * 发现已安装的 skill，但不执行其元数据中的 shell-expansion。
 * 用于只读列表（例如 `relay-pi skills`），因为执行 skill 的 shell 命令会产生用户不希望
 * 出现的副作用。
 */
export function discoverInstalledSkills(cwd: string): DiscoveredSkillsResult {
  const { skills, diagnostics } = loadSkills(buildSkillDiscoveryOptions(undefined, cwd));
  return {
    skills: mergeSkillsByName(skills, listBuiltInSkills()),
    collisions: extractSkillCollisions(diagnostics),
  };
}

function extractSkillCollisions(diagnostics: ResourceDiagnostic[]): SkillCollision[] {
  const collisions: SkillCollision[] = [];
  for (const diagnostic of diagnostics) {
    const collision = diagnostic.collision;
    if (diagnostic.type !== "collision" || !collision || collision.resourceType !== "skill") {
      continue;
    }
    collisions.push({
      name: collision.name,
      winnerPath: collision.winnerPath,
      loserPath: collision.loserPath,
    });
  }
  return collisions;
}

export function mergeSkillsByName(primary: readonly Skill[], secondary: readonly Skill[]): Skill[] {
  const merged = [...primary];
  const seenNames = new Set(primary.map((skill) => skill.name));
  for (const skill of secondary) {
    if (!seenNames.has(skill.name)) {
      merged.push(skill);
    }
  }
  return merged;
}

export function readSkillInstructions(skill: Skill): string {
  // 内置 skill 随包内联发布，因此没有可读取的磁盘 SKILL.md。其正文是静态的，永远不包含
  // shell expansion，所以原样返回。
  const builtIn = getBuiltInSkillInstructions(skill.filePath);
  if (builtIn !== undefined) return builtIn;
  const content = readFileSync(skill.filePath, "utf-8");
  return expandSkillShellCommandsSync(content, skill.baseDir);
}

/**
 * 根据 skill 实际所在的发现根目录，解析其有效作用域。
 *
 * pi-coding-agent 只会将一个 user 目录和一个 project 目录标记为
 * "user"/"project"——其他位置都会归为 "temporary"。Relay Pi 每个作用域会扫描三个根目录
 *（.relay-pi、.agents、.claude），因此在此重新标记，让下游消费者获得真实结果，而不是
 * 几乎全是 "temporary"。
 */
export function resolveSkillScope(
  skill: Skill,
  cwd: string,
): "user" | "project" | "temporary" | "builtin" {
  if (isBuiltInSkill(skill)) return "builtin";
  const baseDir = resolve(skill.baseDir);
  const home = homedir();
  for (const dirName of DEFAULT_SKILL_DIR_NAMES) {
    if (isUnderPath(baseDir, join(home, dirName, "skills"))) return "user";
  }
  for (const ancestor of walkAncestors(cwd)) {
    for (const dirName of DEFAULT_SKILL_DIR_NAMES) {
      if (isUnderPath(baseDir, join(ancestor, dirName, "skills"))) return "project";
    }
  }
  return "temporary";
}

function isUnderPath(target: string, root: string): boolean {
  const normalizedRoot = resolve(root);
  if (target === normalizedRoot) return true;
  const prefix = normalizedRoot.endsWith(sep) ? normalizedRoot : `${normalizedRoot}${sep}`;
  return target.startsWith(prefix);
}
