import type { Skill, loadSkills } from "@earendil-works/pi-coding-agent";
import type { GuardrailConfig } from "./guardrails.js";
import type { ObservationalMemorySettingsInput } from "./memory.js";
import type { TurnMode, TurnOptions } from "./protocol.js";
import type { AutoStateCompactionOptions } from "../turn-runner/state-compaction.js";

/** 直接镜像 pi-coding-agent 的 loadSkills 选项。 */
export type SkillDiscoveryOptions = Partial<Parameters<typeof loadSkills>[0]>;

/** 前台工作最多运行这么久，之后让出并返回仍在运行的结果。 */
export const DEFAULT_TASK_WAIT_BUDGET_MS = 120_000;

export interface TurnRunnerConfig extends TurnOptions {
  /**
   * 拥有此 runner 的 Session。它会写入新生成的观察记录，使 memory loader 能将记录拆分
   * 为本地层（当前 Session）和全局层（其他所有 Session）。为状态机工作创建的子 Agent
   * 会从此 id 派生自己的 id（`<parent>:sub:<taskId>`），因此其临时观察记录仍限定在子 Agent
   * 内，不会污染 parent 的本地层。
   *
   * 只有直接构造 TurnRunner（测试、一次性工具）时可能没有 Session，因此该字段可选。
   * 真正的 CLI/Session 调用方始终会设置它。
   */
  sessionId?: string;
  /**
   * actor model 每个 turn 输入的 token 目标上限。local-session memory 预算（原始消息压缩
   * 触发点、原始尾部缓冲区、反思触发点和缓冲区）通过 `deriveMemoryBudgets` 中的固定
   * 比例从这一个数值派生；比例表见 `src/memory/observational.ts` 中的
   * `MEMORY_BUDGET_RATIOS`。
   * cross-session 全局 pack 使用固定上限（`GLOBAL_CONTEXT_TOKEN_BUDGET`），不随此值缩放。
   *
   * 默认为 200_000。运行时会将解析后的值限制为
   * `min(effectiveContext, model.contextWindow)`，因此大于模型硬窗口的用户值会静默
   * 截断到窗口上限，而不会造成溢出。
   */
  effectiveContext?: number;
  /**
   * 前台 task 工作在 runner 返回仍在运行的结果、让工作继续在后台前所允许的墙上时钟预算。
   * 到期不会取消 task。默认为 120,000 ms（两分钟）。
   */
  taskWaitBudgetMs?: number;
  memory?: ObservationalMemorySettingsInput;
  /**
   * 持久化观察记忆使用的 PGlite 数据库目录。
   * SessionManager 默认使用 `~/.relay-pi/memory.db`；传入 `false` 可让记忆只存在于进程内。
   */
  memoryDbPath?: string | false;
  /**
   * 固定写入 observation prefix 的整理后 memory-store 目录。
   * 省略时会从 `cwd` 向文件系统根目录发现 store，并按距离从近到远排列；提供有序列表
   * 可替换发现结果，传入 `false` 则让此 runner 完全不使用文件记忆。
   */
  memoryStores?: string[] | false;
  cwd?: string;
  /** TurnRunner.turn 的默认 mode。"auto" 会让 runner 对每个 prompt 进行分类。 */
  mode?: TurnMode;
  guardrails?: GuardrailConfig[];
  systemInstructions?: string;
  /**
   * 从 `cwd` 加载并追加到基础 system prompt 的文件。
   *
   * 默认值为 `["AGENTS.md"]`，因此会自动包含仓库本地的 Agent 指导。设置为 `[]` 可禁用
   * 文件加载，或提供显式有序列表替换默认值。
   */
  systemPromptFiles?: string[];
  skills?: Skill[];
  /**
   * 控制文件系统 skill 发现。默认会在 `cwd` 和用户 home 目录中同时搜索 Relay Pi 专用的
   * `.relay-pi/skills` 及标准 `.agents/skills` 目录；设置 `includeDefaults: false` 后，
   * 只使用显式的 `skills` 或 `skillPaths`。
   */
  skillDiscovery?: SkillDiscoveryOptions;
  /**
   * 自动状态压缩。启用后，runner 会通过优先淘汰最早的 Agent 消息，将发出/返回的
   * `TurnState` 限制在 `maxBytes`（默认 100 MB）以内。它在 `snapshotState` 内应用，
   * 因此每个 event、terminal payload 和 `getState()` 返回值离开 runner 前都已裁剪。
   * 下游持久化（例如 `state.json`）会自动继承这一上限。
   *
   * - `true` 或省略：以 `DEFAULT_STATE_MAX_BYTES` 启用上限。
   * - `false`：完全禁用压缩。
   * - 传入 `{ maxBytes }`：覆盖此 runner 的上限。
   *
   * 默认启用，上限为 100 MB——否则 `state.json` 没有上限，失控的 transcript 最终会卡死
   * 持久化。如果测试或短生命周期 Session 需要逐字保留完整 transcript，可按 runner 设置
   *（`autoStateCompaction: false`）退出压缩。
   */
  autoStateCompaction?: AutoStateCompactionOptions | boolean;
}
