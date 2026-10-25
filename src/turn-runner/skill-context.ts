import type { Skill } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { toXML } from "../lib/xml.js";
import type { TurnRunnerConfig } from "../types/config.js";
import type { TurnAgentFile } from "../types/protocol.js";
import { createSystemPromptWithAppendedLayers } from "./prompts.js";
import {
  loadDiscoveredSkills,
  mergeSkillsByName,
  prepareExplicitSkills,
  readSkillInstructions,
  type SkillCollision,
} from "./skills.js";

export class SkillContext {
  private skills: Skill[];
  private collisions: SkillCollision[] = [];
  private loaded = false;
  /** 共享异步发现流程，确保并发调用方不会观察到未展开的基线。 */
  private loading?: Promise<void>;

  constructor(private readonly config: TurnRunnerConfig) {
    this.skills = config.skills ? [...config.skills] : [];
  }

  async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    const loading = this.loading ?? this.load();
    this.loading = loading;
    try {
      await loading;
    } finally {
      if (this.loading === loading) this.loading = undefined;
    }
  }

  /**
   * 重新运行 skill 发现，使新安装的 skill 无需重启 Session 就能出现。
   * `config.skills` 中最初的显式 skill 列表会保留；磁盘上的发现结果会重新读取。
   */
  async reload(): Promise<void> {
    const prior = this.loading;
    const loading = (async () => {
      // 将 reload 排队，避免较旧的发现快照最后完成并覆盖较新的快照。
      // 之前的加载失败也不能阻止重试。
      await prior?.catch(() => undefined);
      this.loaded = false;
      await this.load();
    })();
    this.loading = loading;
    try {
      await loading;
    } finally {
      if (this.loading === loading) this.loading = undefined;
    }
  }

  private async load(): Promise<void> {
    const [baseline, discovered] = await Promise.all([
      prepareExplicitSkills(this.config.skills ?? []),
      loadDiscoveredSkills(this.config.skillDiscovery, this.config.cwd ?? process.cwd()),
    ]);
    this.skills = mergeSkillsByName(baseline, discovered.skills);
    this.collisions = discovered.collisions;
    this.loaded = true;
  }

  getSkills(): readonly Skill[] {
    return [...this.skills];
  }

  getSkillCollisions(): readonly SkillCollision[] {
    return this.collisions;
  }

  getSkillInstructions(skillId: string): string {
    const skill = this.skills.find((s) => s.name === skillId);
    return skill ? readSkillInstructions(skill) : "";
  }

  /** 解析子 Agent 的 allowlist，同时保留调用方特定的错误标签。 */
  resolveSubagentSkills(allowedSkills: string[] | undefined, owner: string): Skill[] | undefined {
    if (!allowedSkills) return undefined;

    const skillsByName = new Map(this.skills.map((skill) => [skill.name, skill]));
    const missing = allowedSkills.filter((name) => !skillsByName.has(name));
    if (missing.length > 0) {
      throw new Error(`Unknown allowedSkills for ${owner}: ${missing.join(", ")}`);
    }

    return allowedSkills.map((name) => skillsByName.get(name)!);
  }

  /**
   * 将 prompt 中的 `/skill` slash 命令展开为注入的 `<skill>` 块。
   * `skills` 限制可展开的 skill 范围；调用方传入受限集合（例如 state 的
   * `allowedSkills`），这样子 Agent 只会展开它实际拥有的 skill。默认使用所有已发现的
   * skill，这是父 prompt 路径所需的行为。对于不受限制的子 Agent，传入 `undefined` 也会
   * 回退到完整集合。
   */
  resolveSlashSkillPrompt(prompt: string, skills: readonly Skill[] = this.skills): string {
    const slash = parseSlashCommands(prompt);
    if (slash.commands.length === 0) return prompt;

    const skillBlocks: string[] = [];
    for (const command of slash.commands) {
      const skill = skills.find((item) => item.name === command);
      if (!skill) continue;

      const instructions = readSkillInstructions(skill).trim();
      skillBlocks.push(
        [
          // path= 允许 Agent 在用户要求修改 skill 本身时直接编辑 SKILL.md，
          // 无需执行发现步骤（例如“将此规则添加到 /review”）。
          `<skill name="${skill.name}" path="${skill.filePath}">`,
          "Use the following skill instructions for this request.",
          "<instructions>",
          instructions,
          "</instructions>",
          "</skill>",
        ].join("\n"),
      );
    }

    if (skillBlocks.length === 0) return prompt;

    return [prompt, ...skillBlocks].join("\n\n");
  }

  createSystemPromptWithAppendedLayers(input?: {
    prepend?: Array<string | undefined>;
    append?: Array<string | undefined>;
    skills?: readonly Skill[];
  }): string {
    return createSystemPromptWithAppendedLayers({
      config: this.config,
      skills: input?.skills ?? this.skills,
      systemPromptFiles: this.readSystemPromptFileLayers(),
      prepend: input?.prepend ?? [],
      append: input?.append ?? [],
    });
  }

  /** 磁盘上存在的系统提示词文件（默认是 AGENTS.md）。 */
  getResolvedAgentFiles(): TurnAgentFile[] {
    const cwd = this.config.cwd ?? process.cwd();
    const fileNames = this.config.systemPromptFiles ?? ["AGENTS.md"];
    const resolved: TurnAgentFile[] = [];
    for (const fileName of fileNames) {
      // chat-app agent-gateway 等宿主会传入位于 `cwd` 外部、属于 Session 的系统提示词文件绝对路径。
      // `join` 会去掉开头的斜杠，将其变成 `cwd` 下不存在的路径并静默丢弃该层，因此应原样
      // 使用绝对路径；只有调用方传入相对名称时才执行拼接。
      const path = isAbsolute(fileName) ? fileName : join(cwd, fileName);
      if (existsSync(path)) {
        resolved.push({ name: isAbsolute(fileName) ? basename(fileName) : fileName, path });
      }
    }
    return resolved;
  }

  private readSystemPromptFileLayers(): string[] {
    const layers: string[] = [];
    for (const file of this.getResolvedAgentFiles()) {
      layers.push(
        toXML({
          system_prompt_file: {
            _attrs: { path: file.name },
            content: readFileSync(file.path, "utf-8").trim(),
          },
        }),
      );
    }
    return layers;
  }
}

// 匹配 chat-app compose-bar 的 `/` skill 选择器发出的自闭合 `<Skill name="..." path="..." />` 标签；
// 用户在 web 和 mobile 上选择 skill 时都会发出该标签（参见
// apps/web/components/chat/compose-bar/primitives/input/features/mention/mention-markdown-codec.ts
// 和 apps/mobile/src/lib/markdown.ts）。我们将此标签视为裸 `/<name>` slash 命令的别名，
// 使选择器驱动的激活与键盘输入的激活注入相同的 SKILL.md。标签拼写由 chat-app codec 固定，
// 因此大小写必须精确；正则表达式只对 `name="..."` 属性的位置保持宽松，以允许其他属性
// （如 `path="..."`）出现在它的任一侧。
const SKILL_TAG_PATTERN = /<Skill\b[^>]*\bname="([A-Za-z0-9_.-]+)"[^>]*\/>/g;

function parseSlashCommands(prompt: string): {
  commands: string[];
} {
  const commands: string[] = [];

  const tokens = prompt.trim().split(/\s+/);
  for (const token of tokens) {
    const match = token.match(/^\/([A-Za-z0-9_.-]+)$/);
    if (match) {
      commands.push(match[1]!);
    }
  }

  for (const match of prompt.matchAll(SKILL_TAG_PATTERN)) {
    const name = match[1];
    if (name) commands.push(name);
  }

  return { commands };
}
