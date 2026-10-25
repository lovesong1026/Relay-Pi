import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ThinkingLevel, Usage } from "@earendil-works/pi-ai";
import {
  type BashOperations,
  createCodingTools,
  createLocalBashOperations,
  type Skill,
} from "@earendil-works/pi-coding-agent";
import { Ajv } from "ajv";
import dedent from "dedent";
import { systemReminder } from "../lib/system-reminder.js";
import { statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { toXML } from "../lib/xml.js";
import { parseDurationToMs, parseWakeAtToMs } from "./duration.js";
import type { TurnMode, TurnQuestion, TurnTodo } from "../types/protocol.js";
import type {
  StateMachineSession,
  StateMachineSessionEvent,
  StateMachineAgentState,
  StateMachineDefinition,
  StateMachinePollState,
  StateMachineParkState,
  StateMachineProgress,
  StateMachineScriptState,
  StateMachineState,
  StateMachineTimerState,
  StateMachineTerminalResult,
} from "../types/state-machine.js";
import { INTERRUPTED_STATE_MACHINE_STATE } from "../types/state-machine.js";
import type { EmbedFn } from "../memory/embedding.js";
import { recallMemoryExpanded, type RecallScope } from "../memory/recall.js";
import {
  buildAdvisorContext,
  type AdvisorExecutorContext,
} from "../model-routing/advisor-context.js";
import {
  ADVISOR_MAX_OUTPUT_TOKENS,
  callAdvisor,
  type AdvisorResult,
  type CallAdvisorInput,
} from "../model-routing/advisor.js";
import { ASK_ADVISOR_TOOL_DESCRIPTION } from "../model-routing/prompts.js";
import type { AdvisorGate } from "../model-routing/router.js";
import type { Observation } from "../types/memory.js";
import type { MemorySession } from "../memory/session.js";
export type ActiveStateOutput =
  | { state?: string; kind: "agent"; output?: { assistantText?: string } }
  | { state: string; kind: "script" | "poll"; output?: ShellPartialOutput };
import { applyStateOverride } from "./state-machine-decisions.js";
import { withBundledRipgrep } from "./bundled-ripgrep.js";
import { SystemRuntimeClock, type RuntimeClock } from "./runtime-clock.js";
import { parkNudge } from "./prompts.js";
import type { ShellPartialOutput } from "./shell-state-handle.js";

const jsonSchemaValidator = new Ajv({ strictSchema: false });

/**
 * 在执行边界移除 pi 的 kill-timeout 输入。公开 bash 的 `timeout` 字段由 task wrapper
 * 作为前台等待预算消费；只有显式的 task_stop、interrupt 或作用域关闭才能中止命令。
 */
export function withoutBashKillTimeout(base: BashOperations): BashOperations {
  return {
    exec: (command, cwd, options) => base.exec(command, cwd, { ...options, timeout: undefined }),
  };
}

const questionOptionSchema = Type.Object(
  {
    label: Type.String({ description: "向用户展示的选项文本。" }),
    description: Type.Optional(
      Type.String({ description: "解释此选项的可选背景信息。" }),
    ),
  },
  { additionalProperties: false },
);

const questionSchema = Type.Object(
  {
    question: Type.String({ description: "要向用户提出的问题。" }),
    header: Type.Optional(
      Type.String({ description: "此问题的可选分节标题。" }),
    ),
    options: Type.Array(questionOptionSchema, {
      minItems: 1,
      description:
        "用户可以选择的答案选项。每个问题至少要有一个选项，以便用户有所选择。",
    }),
    multiSelect: Type.Optional(
      Type.Boolean({ description: "用户是否可以选择多个选项。" }),
    ),
  },
  { additionalProperties: false },
);

const askUserQuestionSchema = Type.Object(
  {
    questions: Type.Array(questionSchema, {
      description: "继续之前必须得到回答的结构化选择题。",
    }),
  },
  { additionalProperties: false },
);

type AskUserQuestionParams = Static<typeof askUserQuestionSchema>;

const todoStatusSchema = Type.Union(
  [
    Type.Literal("pending"),
    Type.Literal("in_progress"),
    Type.Literal("completed"),
    Type.Literal("failed"),
  ],
  {
    description:
      "pending = 尚未开始；in_progress = 正在处理（最多保留一项）；completed = 已完成；failed = 未能完成，必要时可在 content 中说明原因。",
  },
);

const todoItemSchema = Type.Object(
  {
    id: Type.String({
      description:
        "稳定且唯一的标识符，用于后续调用中编辑此待办。选择简短、易记的值，以便通过 merge=true 更新其状态。",
    }),
    content: Type.String({
      description:
        "使用祈使句描述任务，例如“运行测试”或“更新 README 中的模型章节”。用一句话表达，不要叙述过程。",
    }),
    status: todoStatusSchema,
  },
  { additionalProperties: false },
);

const todoWriteSchema = Type.Object(
  {
    merge: Type.Boolean({
      description:
        "false = 替换整个列表（首次规划时使用）。true = 按 id 更新或插入（只需更新单项状态时使用，不必重新发送其他待办）。",
    }),
    todos: Type.Array(todoItemSchema, {
      description:
        "要写入的待办。merge=false 时传入完整列表；merge=true 时只传入新增或更新的项目。",
    }),
  },
  { additionalProperties: false },
);

 type TodoWriteParams = Static<typeof todoWriteSchema>;

export interface TodoWriteToolStorage {
  getTodos(): TurnTodo[];
  setTodos(todos: TurnTodo[]): void;
}

const agentOverrideSchema = Type.Partial(
  Type.Object(
    {
      prompt: Type.String({ description: "替换此 agent 状态的用户提示词。" }),
      systemPrompt: Type.String({
        description: "仅追加到此子 Agent 的系统提示词。",
      }),
      allowedSkills: Type.Array(Type.String(), {
        description:
          "注入此子 Agent 的技能名称。省略时注入所有可用技能。",
      }),
      cwd: Type.String({
        description:
          "替换此子 Agent 编程工具（bash、read、write、edit）的工作目录。如果工作位于会话 cwd 之外（例如先前状态创建的 git worktree、克隆目录或临时目录），应在此设置，而不要在提示词中要求子 Agent 执行 `cd`；工具会从此目录启动，写在提示词中的路径不会重定向工具。",
      }),
      inputSchema: Type.Record(Type.String(), Type.Any(), {
        description:
          '替换此状态接受的有效 JSON Schema 对象，用于定义转换输入，例如 { "type": "object", "properties": { "email": { "type": "string" }, "followUpCount": { "type": "integer" } }, "required": ["email"] }。未列入 required 的字段为可选字段。',
      }),
      forkContext: Type.Boolean({
        description:
          "为 true 时，此子 Agent 会从父运行器完整对话上下文的逐字副本（先前讨论、决策、工具历史）开始，而不是使用空白的新转录。默认 false（新上下文），适用于范围明确且独立的任务。只有当任务依赖于难以或不适合通过 prompt/input 重述的先前对话上下文时才设为 true；fork 会复制整个父级转录，因此独立任务应保持关闭。",
      }),
    },
    { additionalProperties: false },
  ),
);

const scriptOverrideSchema = Type.Partial(
  Type.Object(
    {
      command: Type.String({ description: "替换此脚本状态的 shell 命令。" }),
      cwd: Type.String({
        description: "替换命令的工作目录。",
      }),
      timeoutMs: Type.Number({ description: "替换命令的超时时间，单位为毫秒。" }),
      successCodes: Type.Array(Type.Number(), {
        description: "替换视为成功完成的退出码列表。",
      }),
      inputSchema: Type.Record(Type.String(), Type.Any(), {
        description:
          '替换此状态接受的有效 JSON Schema 对象，用于定义转换输入，例如 { "type": "object", "properties": { "email": { "type": "string" }, "followUpCount": { "type": "integer" } }, "required": ["email"] }。未列入 required 的字段为可选字段。',
      }),
    },
    { additionalProperties: false },
  ),
);

const pollOverrideSchema = Type.Partial(
  Type.Object(
    {
      intervalMs: Type.Union([Type.Number(), Type.String()], {
        description:
          'Replacement recurring delay between poll wake attempts. Accepts a duration string like "3h" or "5d", or a raw number of milliseconds.',
      }),
      timeoutMs: Type.Number({ description: "Replacement maximum poll-state runtime." }),
      command: Type.String({
        description: "Replacement shell command for one poll attempt.",
      }),
      cwd: Type.String({
        description: "Replacement working directory for the poll command.",
      }),
      successCodes: Type.Array(Type.Number(), {
        description: "Replacement exit codes that mean this poll attempt found a result.",
      }),
      inputSchema: Type.Record(Type.String(), Type.Any(), {
        description:
          '替换此状态接受的有效 JSON Schema 对象，用于定义转换输入，例如 { "type": "object", "properties": { "messageId": { "type": "string" } }, "required": ["messageId"] }. Fields omitted from required are optional.',
      }),
    },
    { additionalProperties: false },
  ),
);

const timerOverrideSchema = Type.Partial(
  Type.Object(
    {
      wakeAt: Type.Union([Type.Number(), Type.String()], {
        description:
          'Replacement absolute wake time for this timer state. Accepts an ISO 8601 date string like "2026-05-24T18:00:00Z" or a Unix-epoch millisecond number.',
      }),
      wakeAfterMs: Type.Union([Type.Number(), Type.String()], {
        description:
          'Replacement relative duration measured from the moment the parent selects this timer state. Accepts a duration string like "3h" or "5d", or a raw number of milliseconds. Mutually exclusive with wakeAt.',
      }),
      inputSchema: Type.Record(Type.String(), Type.Any(), {
        description:
          '替换此状态接受的有效 JSON Schema 对象，用于定义转换输入，例如 { "type": "object", "properties": { "scheduledAt": { "type": "number" } }, "required": ["scheduledAt"] }. Fields omitted from required are optional.',
      }),
    },
    { additionalProperties: false },
  ),
);

const parkOverrideSchema = Type.Partial(
  Type.Object(
    {
      inputSchema: Type.Record(Type.String(), Type.Any(), {
        description:
          "Replacement valid JSON Schema object for transition input accepted by this park state.",
      }),
    },
    { additionalProperties: false },
  ),
);

const stateOverrideSchema = Type.Union([
  Type.Object(
    { kind: Type.Literal("agent"), state: agentOverrideSchema },
    { additionalProperties: false },
  ),
  Type.Object(
    { kind: Type.Literal("script"), state: scriptOverrideSchema },
    { additionalProperties: false },
  ),
  Type.Object(
    { kind: Type.Literal("poll"), state: pollOverrideSchema },
    { additionalProperties: false },
  ),
  Type.Object(
    { kind: Type.Literal("timer"), state: timerOverrideSchema },
    { additionalProperties: false },
  ),
  Type.Object(
    { kind: Type.Literal("park"), state: parkOverrideSchema },
    { additionalProperties: false },
  ),
]);

const baseStateSchema = {
  name: Type.String({ description: "供 select_state_machine_state 使用的状态名称。" }),
  when: Type.Optional(
    Type.String({ description: "指导父运行器在什么情况下应选择此状态。" }),
  ),
  inputSchema: Type.Optional(
    Type.Record(Type.String(), Type.Any(), {
      description:
        '有效 JSON Schema 对象，用于定义父运行器选择此状态时必须传入的输入，例如 { "type": "object", "properties": { "email": { "type": "string" }, "followUpCount": { "type": "integer" } }, "required": ["email"] }。未列入 required 的字段为可选字段。模板字符串可从此对象读取值。',
    }),
  ),
};

const agentStateSchema = Type.Object(
  {
    ...baseStateSchema,
    kind: Type.Literal("agent", { description: "为此状态运行子 Agent。" }),
    prompt: Type.String({
      description: "发送给子 Agent 的用户提示词。可使用 {{ input.email }} 等模板。",
    }),
    systemPrompt: Type.Optional(
      Type.String({ description: "仅追加给此子 Agent 的可选系统提示词。" }),
    ),
    allowedSkills: Type.Optional(
      Type.Array(Type.String(), {
        description:
          "注入此子 Agent 的技能名称。省略时注入所有可用技能。",
      }),
    ),
    cwd: Type.Optional(
      Type.String({
        description:
          "此子 Agent 编程工具（bash、read、write、edit）的工作目录。如果工作位于会话 cwd 之外（例如先前状态创建的 git worktree、克隆目录或临时目录），应在此设置，而不要在提示词中要求子 Agent 执行 `cd`；工具会从此目录启动，写在提示词中的路径不会重定向工具。默认使用状态机 session cwd。",
      }),
    ),
    forkContext: Type.Optional(
      Type.Boolean({
        description:
          "为 true 时，子 Agent 会从父运行器完整对话上下文的逐字副本（先前讨论、决策、工具历史）开始，而不是使用空白的新转录。默认 false（新上下文），适用于范围明确且独立的任务。只有当任务依赖于难以或不适合通过 prompt 重述的先前对话上下文时才设为 true；fork 会复制整个父级转录，因此独立任务应保持关闭，以减少委派成本并保持上下文清晰。",
      }),
    ),
  },
  { additionalProperties: false },
);

const scriptStateSchema = Type.Object(
  {
    ...baseStateSchema,
    kind: Type.Literal("script", { description: "为此状态运行 shell 命令。" }),
    command: Type.String({
      description: "要执行的 shell 命令。可使用 {{ input.email }} 等模板。",
    }),
    cwd: Type.Optional(
      Type.String({
        description: "命令的工作目录。默认使用状态机 session cwd。",
      }),
    ),
    timeoutMs: Type.Optional(Type.Number({ description: "命令超时时间，单位为毫秒。" })),
    successCodes: Type.Optional(
      Type.Array(Type.Number(), {
        description: "视为成功完成的退出码。默认为 [0]。",
      }),
    ),
  },
  { additionalProperties: false },
);

const pollStateSchema = Type.Object(
  {
    ...baseStateSchema,
    kind: Type.Literal("poll", { description: "执行一次外部等待/检查。" }),
    intervalMs: Type.Union([Type.Number(), Type.String()], {
      description:
        '下一次计划轮询前的重复等待时间。可使用 "3h" 或 "5d" 等时长字符串，也可使用毫秒数。',
    }),
    timeoutMs: Type.Optional(
      Type.Number({ description: "此状态最多可保持轮询的时间。" }),
    ),
    command: Type.String({
      description:
        "每次轮询尝试执行的 shell 命令。只有在轮询发现结果时才返回非空 JSON。",
    }),
    cwd: Type.Optional(
      Type.String({
        description: "轮询命令的工作目录。默认使用状态机 session cwd。",
      }),
    ),
    successCodes: Type.Optional(
      Type.Array(Type.Number(), {
        description: "表示此次轮询发现结果的退出码。",
      }),
    ),
  },
  { additionalProperties: false },
);

const timerStateSchema = Type.Object(
  {
    ...baseStateSchema,
    kind: Type.Literal("timer", {
      description:
        "休眠至未来某个时间，然后以 elapsedMs 和 timestamp 输出恢复。wakeAt（绝对时间）与 wakeAfterMs（相对时长）必须且只能指定一个。",
    }),
    wakeAt: Type.Optional(
      Type.Union([Type.Number(), Type.String()], {
        description:
          '此 timer 状态应完成的绝对唤醒时间。可使用 ISO 8601 日期字符串，例如 "2026-05-24T18:00:00Z"，或 Unix 纪元毫秒数。不能与 wakeAfterMs 同时使用。',
      }),
    ),
    wakeAfterMs: Type.Optional(
      Type.Union([Type.Number(), Type.String()], {
        description:
          '从父运行器选择此 timer 状态时开始计算的相对时长，计时结束后状态完成。可使用 "3h" 或 "5d" 等时长字符串，也可使用毫秒数。不能与 wakeAt 同时使用。',
      }),
    ),
  },
  { additionalProperties: false },
);

const parkStateSchema = Type.Object(
  {
    ...baseStateSchema,
    kind: Type.Literal("park", {
      description:
        "暂停状态机，不运行任务也不安排唤醒，由父运行器决定后续操作。",
    }),
  },
  { additionalProperties: false },
);

const terminalStateSchema = Type.Object(
  {
    ...baseStateSchema,
    kind: Type.Literal("terminal", { description: "结束状态机 session。" }),
    status: Type.Union([
      Type.Literal("completed", { description: "状态机已成功完成。" }),
      Type.Literal("failed", { description: "状态机执行失败。" }),
      Type.Literal("cancelled", { description: "状态机已取消。" }),
    ]),
    reason: Type.Optional(Type.String({ description: "可选的最终说明，供用户查看。" })),
  },
  { additionalProperties: false },
);

const stateMachineStateSchema = Type.Union([
  agentStateSchema,
  scriptStateSchema,
  pollStateSchema,
  timerStateSchema,
  parkStateSchema,
  terminalStateSchema,
]);

export type StateMachineAgentStateOverride = Partial<
  Pick<
    StateMachineAgentState,
    "prompt" | "systemPrompt" | "allowedSkills" | "cwd" | "inputSchema" | "forkContext"
  >
>;

export type StateMachineScriptStateOverride = Partial<
  Pick<StateMachineScriptState, "command" | "cwd" | "timeoutMs" | "successCodes" | "inputSchema">
>;

export type StateMachinePollStateOverride = Partial<
  Pick<
    StateMachinePollState,
    "intervalMs" | "timeoutMs" | "command" | "cwd" | "successCodes" | "inputSchema"
  >
>;
export type StateMachineTimerStateOverride = Partial<
  Pick<StateMachineTimerState, "wakeAt" | "wakeAfterMs" | "inputSchema">
>;
export type StateMachineParkStateOverride = Partial<Pick<StateMachineParkState, "inputSchema">>;

export type StateMachineStateOverride =
  | { kind: "agent"; state: StateMachineAgentStateOverride }
  | { kind: "script"; state: StateMachineScriptStateOverride }
  | { kind: "poll"; state: StateMachinePollStateOverride }
  | { kind: "timer"; state: StateMachineTimerStateOverride }
  | { kind: "park"; state: StateMachineParkStateOverride };

const stateMachineDefinitionSchema = Type.Object(
  {
    name: Type.String({ description: "便于识别的状态机名称。" }),
    prompt: Type.String({
      description: "说明此状态机定义适用场景的路由指导。",
    }),
    states: Type.Array(stateMachineStateSchema, {
      description: "父运行器可选择的状态列表。",
    }),
  },
  {
    additionalProperties: false,
    description:
      "状态机定义。若状态提示词或命令需要转换输入，请使用 inputSchema 和 {{ input.foo }} 模板。",
  },
);

const createDefinitionSchema = Type.Object(
  {
    definition: stateMachineDefinitionSchema,
    firstState: Type.String({
      description:
        "创建定义后首先运行的状态名称；该状态必须存在于 `definition.states` 中。",
    }),
    replaceActive: Type.Optional(
      Type.Boolean({
        description:
          "仅当确实要放弃当前正在运行的状态机并用此新状态机替换时设为 true。若当前仍有活动状态机，创建新定义会被拒绝；必须先通过 select_state_machine_state 推进至终态或结束它。设为 true 时，运行器会取消活动状态机并以此状态机替代。默认 false，避免 Agent 未意识到已有状态机运行时意外覆盖它。",
      }),
    ),
  },
  { additionalProperties: false },
);

type CreateDefinitionParams = Static<typeof createDefinitionSchema>;
type ToolStateMachineDefinition = CreateDefinitionParams["definition"];

const selectStateSchema = Type.Object(
  {
    decision: Type.Object(
      {
        state: Type.String({
          description:
            "要推进到的状态名称。必须与活动定义中声明的某个名称完全匹配（包括自动注入的 `failed` 和 `cancelled` 终态出口）。选择终态会结束状态机。",
        }),
        reason: Type.Optional(
          Type.String({
            description:
              "当 `state` 指向终态时，附加到终态的自由文本说明。对非终态无效。",
          }),
        ),
        override: Type.Optional(stateOverrideSchema),
        persistOverride: Type.Optional(
          Type.Boolean({
            description:
              "设置 `override` 时，用于控制是否将覆盖合并到活动状态机定义中（让更改持续应用于此状态的后续每次运行），还是仅对本次转换生效。默认为 true——编排者通常通过覆盖来调整子 Agent 提示词或修复脚本命令，这些调整通常应保留。设为 false 可临时试用某种变化，例如先测试子 Agent 能否恢复，再决定是否保留。省略 `override` 时此字段无效。选择终态时只接受 decision.state 和 decision.reason；不要传入 override、input 或 persistOverride。",
          }),
        ),
        input: Type.Optional(
          Type.Record(Type.String(), Type.Any(), {
            description:
              "传给所选状态的输入对象。当状态的 inputSchema 要求字段时必须提供；模板可通过 {{ input.field }} 读取值。",
          }),
        ),
      },
      {
        additionalProperties: false,
        description:
          "State transition decision. Use `input` when selecting states with inputSchema or {{ input.foo }} templates; `reason` carries through to terminal states.",
      },
    ),
  },
  { additionalProperties: false },
);

export interface CurrentStateMachineStateResult {
  currentState?: string;
  currentInput?: Record<string, unknown>;
  terminal?: StateMachineTerminalResult;
  /** 每个状态的紧凑计数，用于回答明显的进度问题。 */
  progress?: StateMachineProgress;
  /** 状态机历史记录总数；下面的 `history` 仅包含最近的尾部。 */
  historyCount: number;
  /** 当前运行状态的临时输出（如果有活动状态）。 */
  activeOutput?: ActiveStateOutput;
  history: StateMachineSessionEvent[];
}

// runner decision 只是“前往此状态，可选地携带这些转换附加项”。定义中的状态自身
// `kind`（agent/script/poll/timer/terminal）驱动分发；decision 不需要重复声明它。
// 要让机器以失败结束，请选择自动注入的 `failed` 终态（并可附加 `reason`）——
// 不存在独立的 fail 动词。
export interface StateMachineRunnerDecision {
  state: string;
  reason?: string;
  override?: StateMachineStateOverride;
  /**
   * 为 true（默认）时，`override` 会合并到当前状态机定义中，使同一状态的未来运行
   * 看到调整后的 prompt/command/schedule。为 false 时，override 只应用于本次转换，
   * 保存的定义不变。当 `override` 未定义或目标状态为终态时忽略此字段。
   */
  persistOverride?: boolean;
  input?: Record<string, unknown>;
}

export type TurnRunnerControlResult =
  | { type: "none" }
  | ({
      type: "ask_user_question";
      questions: TurnQuestion[];
    } & AskUserQuestionParams)
  | ({
      type: "create_state_machine_definition";
      definition: ToolStateMachineDefinition;
    } & Pick<CreateDefinitionParams, "firstState">)
  | { type: "select_state_machine_state"; decision: StateMachineRunnerDecision };

export function isTurnRunnerControlResult(value: unknown): value is TurnRunnerControlResult {
  if (!value || typeof value !== "object" || !("type" in value)) return false;
  const type = value.type;
  return (
    type === "none" ||
    type === "ask_user_question" ||
    type === "create_state_machine_definition" ||
    type === "select_state_machine_state"
  );
}

interface TurnRunnerToolsInput {
  cwd: string;
  mode: TurnMode;
  todoStorage: TodoWriteToolStorage;
  getDefinition?: () => StateMachineDefinition | undefined;
  getStateMachine?: () => StateMachineSession | undefined;
  /** 保存编辑后的定义但不选择它；拒绝仍在执行或已有计划唤醒的状态。 */
  updateStateDefinition?: (state: StateMachineState) => void;
  getActiveStateOutput?: () => ActiveStateOutput | undefined;
  skills?: readonly Skill[];
  recallStorage?: RecallMemoryToolStorage;
  advisorStorage?: AskAdvisorToolStorage;
  clock?: RuntimeClock;
  minimumScheduledDelayMs?: number;
}

export interface RecallMemoryToolStorage {
  /**
   * 返回支撑 runner 持久化记忆的 Memory session；禁用记忆持久化时返回 undefined
   *（一次性工具、测试）。undefined 时，recall_memory 工具不执行任何操作，模型不会
   * 看到一个缺少后端存储的工具。每次调用都重新获取 session，使 recall 在本次 session
   * 中延迟加载完成后仍能看到 runner 当前的持久化句柄。
   */
  getSession: () => MemorySession | undefined;
  /**
   * embedding callable。可选：未定义或调用失败时，recall 回退为仅关键词检索。
   * 每个 runner 通过 embedding client 创建一次，以摊薄连接复用的 TLS 开销。
   */
  embed?: EmbedFn;
  /** 用于 scope 过滤的当前 session id。 */
  sessionId?: string;
  /**
   * `expand` flag 用来生成改写的模型。由 runner 解析，使查询扩展与 observer/reflector
   * 使用同一个 memory model——通常是 Haiku 或 Gemini Flash 这类低成本模型。
   */
  expansionModel?: string;
}

/** parent-only advisor 工具使用的延迟运行时输入和 router 操作。 */
export interface AskAdvisorToolStorage {
  /** 为解析后的 advisor 捕获并按策略限制 executor 上下文，以适配其硬窗口。 */
  getContext: (contextWindowTokens: number) => Promise<AdvisorExecutorContext>;
  /** 在工具执行时延迟解析 advisor 身份和硬模型窗口。 */
  resolveModel: () => {
    /** 传给 advisor 调用的已解析 catalog model id。 */
    modelName: string;
    /** 作为最终安全上限的、对外公布的输入加输出上下文窗口。 */
    contextWindowTokens: number;
    /** 此具体 provider model 是否接受图像请求部分。 */
    acceptsImages: boolean;
  };
  /** 由路由 tier 选择的 reasoning effort。 */
  thinkingLevel: ThinkingLevel;
  /** 获准时原子地检查下限并预留 router 的 advisor slot。 */
  advisorGate: () => AdvisorGate;
  /** 释放已预留的 slot；false 不会写入下限或请求分类。 */
  noteAdvisorConsult: (success?: boolean) => void;
  /** 在工具返回前，将已完成的 advisor 请求归因到正在运行的 turn。 */
  recordUsage: (usage: Usage) => void;
  /** 报告 accounting 失败，但不丢弃 provider 已返回的建议。 */
  onUsageError?: (error: unknown) => void;
  /** 报告咨询失败，同时允许 executor 继续。 */
  onAdvisorError?: (error: unknown) => void;
  /** 用于确定性工具测试的网络接缝；生产环境使用 callAdvisor。 */
  callAdvisor?: (input: CallAdvisorInput) => Promise<AdvisorResult>;
}

export function createDefaultTurnRunnerTools(
  cwd: string,
  todoStorage: TodoWriteToolStorage,
  recallStorage?: RecallMemoryToolStorage,
  advisorStorage?: AskAdvisorToolStorage,
): AgentTool[] {
  const tools: AgentTool[] = [
    ...createCodingTools(cwd, {
      bash: {
        operations: withBundledRipgrep(withoutBashKillTimeout(createLocalBashOperations())),
      },
    }),
    createTodoWriteTool(todoStorage),
    createAskUserQuestionTool(),
  ];
  if (recallStorage) {
    tools.push(createRecallMemoryTool(recallStorage));
  }
  if (advisorStorage) {
    tools.push(createAskAdvisorTool(advisorStorage));
  }
  return tools;
}

export function createTurnRunnerTools(input: TurnRunnerToolsInput): AgentTool[] {
  const tools = [
    ...createDefaultTurnRunnerTools(
      input.cwd,
      input.todoStorage,
      input.recallStorage,
      input.advisorStorage,
    ),
  ];
  if (input.mode === "agent") {
    return tools;
  }

  if (input.mode === "auto") {
    tools.push(
      createStateMachineDefinitionTool(input.getStateMachine, input.cwd, {
        clock: input.clock ?? new SystemRuntimeClock(),
        minimumScheduledDelayMs: input.minimumScheduledDelayMs ?? MINIMUM_STATE_MACHINE_DELAY_MS,
      }),
    );
  }

  const getDefinition = () =>
    input.getDefinition?.() ?? (typeof input.mode === "object" ? input.mode : undefined);
  tools.push(createSelectStateTool(getDefinition, input.cwd));
  if (input.updateStateDefinition) {
    tools.push(
      createUpdateStateTool(input.getStateMachine, input.updateStateDefinition, input.cwd),
    );
  }
  tools.push(createCurrentStateMachineStateTool(input.getStateMachine, input.getActiveStateOutput));
  return tools;
}

const askAdvisorSchema = Type.Object({}, { additionalProperties: false });

/** 构造无参数、不会终止回合的 advisor 咨询工具。 */
export function createAskAdvisorTool(
  storage: AskAdvisorToolStorage,
): AgentTool<typeof askAdvisorSchema> {
  return {
    name: "ask_advisor",
    label: "Ask advisor",
    description: ASK_ADVISOR_TOOL_DESCRIPTION,
    parameters: askAdvisorSchema,
    async execute(...args) {
      const signal = args[2];
      const gate = storage.advisorGate();
      const endConsult = (success: boolean) => storage.noteAdvisorConsult(success);
      if (!gate.allowed) {
        const text = gate.inFlight
          ? "An advisor consultation is already in progress. Continue without starting another."
          : `The advisor was consulted too recently. Continue for ${gate.stepsUntilAllowed} more assistant step${gate.stepsUntilAllowed === 1 ? "" : "s"} before asking again.`;
        return {
          content: [{ type: "text", text }],
          details: {
            type: "ask_advisor",
            rateLimited: true,
            stepsUntilAllowed: gate.stepsUntilAllowed,
            ...(gate.inFlight ? { inFlight: true } : {}),
          },
          terminate: false,
        };
      }

      let resolvedModel: ReturnType<AskAdvisorToolStorage["resolveModel"]>;
      try {
        resolvedModel = storage.resolveModel();
        if (!resolvedModel.modelName) throw new Error("advisor model unavailable");
      } catch {
        endConsult(false);
        return {
          content: [
            {
              type: "text",
              text: "The advisor model is unavailable for the configured providers.",
            },
          ],
          details: { type: "ask_advisor", unavailable: true },
          terminate: false,
        };
      }
      try {
        const advisorContext = buildAdvisorContext({
          context: await storage.getContext(resolvedModel.contextWindowTokens),
          contextWindowTokens: resolvedModel.contextWindowTokens,
          reservedOutputTokens: ADVISOR_MAX_OUTPUT_TOKENS,
        });
        if (advisorContext.images.length > 0 && !resolvedModel.acceptsImages) {
          throw new Error(
            `Advisor model ${resolvedModel.modelName} cannot inspect ${advisorContext.images.length} image attachment(s).`,
          );
        }
        const result = await (storage.callAdvisor ?? callAdvisor)({
          contextText: advisorContext.text,
          images: advisorContext.images,
          modelName: resolvedModel.modelName,
          thinkingLevel: storage.thinkingLevel,
          signal,
        });
        try {
          storage.recordUsage(result.usage);
        } catch (error) {
          try {
            storage.onUsageError?.(error);
          } catch {
            // 日志记录尽力而为；只要 advisor 输出有效，仍以该输出为准。
          }
        }
        endConsult(true);
        return {
          content: [{ type: "text", text: result.advice }],
          details: {
            type: "ask_advisor",
            model: resolvedModel.modelName,
            context: advisorContext.metadata,
          },
          terminate: false,
        };
      } catch (error) {
        endConsult(false);
        if (signal?.aborted) throw error;
        try {
          storage.onAdvisorError?.(error);
        } catch {
          // 日志记录尽力而为；executor 仍必须继续。
        }
        return {
          content: [
            {
              type: "text",
              text: "The advisor consultation failed. Continue using the available context.",
            },
          ],
          details: { type: "ask_advisor", failed: true },
          terminate: false,
        };
      }
    },
  };
}

/**
 * 构造在机器仍运行且未设置 `replaceActive` 时调用
 * `create_state_machine_definition` 所抛出的、面向 Agent 的错误。
 * 消息会列出活动机器及其当前状态，使可能没有意识到机器正在运行的 Agent
 * 能决定是否使用 select_state_machine_state 推进/结束它，或使用
 * `replaceActive: true` 有意替换它。
 */
function activeStateMachineCreateError(session: StateMachineSession): string {
  const name = session.definition.name;
  const currentState = session.currentState ?? "unknown";
  const kind = session.definition.states.find((state) => state.name === currentState)?.kind;
  const stateDescription = kind ? `${currentState} (${kind})` : currentState;
  return dedent`
    Cannot create a new state machine: a state machine is already active.

    Active machine: "${name}", currently at state "${stateDescription}".

    Advance or end it with select_state_machine_state before creating a new one. If you instead intend to abandon this machine and run a different one in its place, call create_state_machine_definition again with replaceActive: true to cancel the active machine and replace it.
  `;
}

function createAskUserQuestionTool(): AgentTool<typeof askUserQuestionSchema> {
  return {
    name: "ask_user_question",
    executionMode: "sequential",
    label: "Ask user question",
    description:
      "向用户提出一个或多个结构化选择题。继续任务需要用户输入时使用。",
    parameters: askUserQuestionSchema,
    async execute(_toolCallId, params) {
      // schema 在 options 上声明了 minItems: 1，但运行时仍需防御：某些 provider 仍会
      // 产生空 options 数组，这会让用户没有可选答案并使 turn 停滞。
      const emptyIndex = params.questions.findIndex((question) => question.options.length === 0);
      if (emptyIndex !== -1) {
        throw new Error(
          `ask_user_question rejected: questions[${emptyIndex}] has no options. Each question must include at least one option.`,
        );
      }
      const result: TurnRunnerControlResult = {
        type: "ask_user_question",
        questions: params.questions,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: result,
        terminate: true,
      };
    },
  };
}

const recallMemorySchema = Type.Object(
  {
    query: Type.String({
      description:
        "用自然语言描述要回忆的内容。可使用专有名词、代码符号或对用户先前表述的简短改写；检索采用向量与关键词混合方式，因此模糊改写和精确匹配均可。",
    }),
    limit: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 20,
        description: "最多返回的结果数。默认值为 8。",
      }),
    ),
    scope: Type.Optional(
      Type.Union([Type.Literal("session"), Type.Literal("global"), Type.Literal("all")], {
        description:
          "'session' 仅搜索当前对话，'global' 仅搜索其他会话，'all'（默认值）搜索两者。",
      }),
    ),
    expand: Type.Optional(
      Type.Boolean({
        description:
          "为 true 时，Agent 会将原始查询和两个改写版本一并检索，并融合结果集。首次查询结果较弱时可启用；默认关闭以降低延迟。",
      }),
    ),
  },
  { additionalProperties: false },
);

function createRecallMemoryTool(
  storage: RecallMemoryToolStorage,
): AgentTool<typeof recallMemorySchema> {
  return {
    name: "recall_memory",
    label: "Recall memory",
    description: dedent`
      搜索用户的持久记忆，以查找过去对话中的事实、决策和背景信息。

      混合检索（向量嵌入 + 关键词）使用 reciprocal rank fusion 对结果排序。若只搜索其他会话，使用 \`scope: "global"\`；若只搜索当前会话，使用 \`"session"\`；不确定时使用 \`"all"\`（默认值）。首次查询结果较弱时，可传入 \`expand: true\`，同时检索原始查询及其改写版本。
    `,
    parameters: recallMemorySchema,
    async execute(_toolCallId, params) {
      const session = storage.getSession();
      if (!session) {
        return {
          content: [
            {
              type: "text",
              text: "Memory persistence is disabled for this session, so there is nothing to recall.",
            },
          ],
          details: { type: "recall_memory", disabled: true },
        };
      }
      const scope: RecallScope = params.scope ?? "all";
      const limit = params.limit ?? 8;

      const { observations, vectorSearchAttempted, vectorSearchSucceeded, expanded } =
        await recallMemoryExpanded({
          session,
          ...(storage.embed ? { embed: storage.embed } : {}),
          query: params.query,
          limit,
          scope,
          ...(storage.sessionId ? { sessionId: storage.sessionId } : {}),
          // 只有模型请求扩展且已配置 paraphrase model 时才扩展；否则保持低成本的单查询路径。
          ...(params.expand && storage.expansionModel
            ? { expansionModel: storage.expansionModel }
            : {}),
        });

      const summary = observations.length
        ? observations.map(formatRecallHit).join("\n\n")
        : "(no matches)";
      // 只有向量路径实际失败时才算降级（embed 抛错或查询出错）。健康索引返回零条向量命中
      // 仍是成功检索，应渲染正常标题。
      const header =
        vectorSearchAttempted && !vectorSearchSucceeded
          ? "# Memory recall (keyword-only fallback; semantic search unavailable)"
          : "# Memory recall";

      return {
        content: [{ type: "text", text: `${header}\n\n${summary}` }],
        details: {
          type: "recall_memory",
          query: params.query,
          scope,
          expanded,
          hits: observations.length,
          vectorSearchSucceeded,
        },
      };
    },
  };
}

function formatRecallHit(observation: Observation): string {
  // 复用静态 memory section 中的渲染方式，使模型在 prompt 前缀和工具结果 payload
  // 中看到一致的形状。
  const time = observation.timeOfDay ? ` ${observation.timeOfDay}` : "";
  const referenced = observation.referencedDate ? ` [ref: ${observation.referencedDate}]` : "";
  const session = observation.sessionId ? ` (session ${observation.sessionId})` : "";
  const priority =
    observation.priority === "high" ? "HIGH" : observation.priority === "medium" ? "MED" : "LOW";
  return `- ${priority} ${observation.kind} ${observation.observedDate}${time}${referenced}${session}\n  ${observation.content}`;
}

export function createTodoWriteTool(
  storage: TodoWriteToolStorage,
): AgentTool<typeof todoWriteSchema> {
  return {
    name: "todo_write",
    label: "Write todos",
    description: dedent`
      使用结构化、可见的待办列表跟踪你在本次对话中亲自处理的多步骤工作。列表会实时展示给用户，作为双方共同查看的“约定事项”和“当前进度”记录。

      当步骤需要你在本次转录中持续推理和使用工具时，优先使用此工具：例如需要你审查的编辑、需要反复参考的搜索结果，或用户希望看到你逐步执行的工作。符合以下任一条件时应使用：
      - 用户消息包含多个独立任务（“做 X，也做 Y，别忘了 Z”），且由你亲自处理。
      - 工作需要三个或更多非平凡步骤才能完成（调查、编辑、测试、提交等），且会在本次对话中执行。
      - 你即将连续调用多个工具——先写出计划，让用户查看并纠正。
      - 你正在恢复或中断工作，希望明确当前状态。

      如果步骤的范围明确到可以由子 Agent 或脚本独立完成（“使用这些输入执行 X 并返回结果”），优先使用状态机，而不是此工具。状态机状态在本次转录之外运行，因此中间输出不会占用你的上下文；对这类工作使用 todo_write 会将你不需要保留的工具输出塞入父级上下文。

      Agent 状态没有最短持续时间；只有 poll 的 intervalMs 和 timer 的 wakeAt/wakeAfterMs 有 30 秒下限。如果你已看出工作无法在一个会话内完成，并准备建议用户“下个会话继续”，这表示你选错了工具，应使用状态机。若工作使用 create_state_machine_definition，不要同时调用 todo_write 来重复跟踪：状态机的各状态就是可见的实时计划，并行维护重复阶段的待办列表既多余也不正确。正确做法是删去待办列表，绝不能删去状态机——跨会话的多单元工作仍需要状态机。

      使用方法：
      - 开始时使用 merge=false 写出完整计划。每次恰好标记一项为 in_progress。
      - 完成一项后再次调用 merge=true，只传入该项并将其状态改为 completed；同时将下一项设为 in_progress。
      - 计划变化时（用户调整方向或发现新工作），立即更新列表，确保它如实反映进度。
      - 真正的一步请求无需使用此工具，例如一次性回答或单文件编辑。

      用户列出多个由你亲自处理的任务时，应立即调用此工具。
    `,
    parameters: todoWriteSchema,
    async execute(_toolCallId, params) {
      const todos = params.merge
        ? mergeTodos(storage.getTodos(), params.todos)
        : normalizeTodos(params.todos);
      storage.setTodos(todos);

      return {
        content: [{ type: "text", text: formatTodoWriteResult(todos) }],
        details: todos,
      };
    },
  };
}

function mergeTodos(existing: TurnTodo[], incoming: TodoWriteParams["todos"]): TurnTodo[] {
  const merged = existing.map((todo) => ({ ...todo }));
  const indexes = new Map(merged.map((todo, index) => [todo.id, index]));

  for (const todo of normalizeTodos(incoming)) {
    const index = indexes.get(todo.id);
    if (index === undefined) {
      indexes.set(todo.id, merged.length);
      merged.push(todo);
    } else {
      merged[index] = todo;
    }
  }

  return merged;
}

function normalizeTodos(todos: TodoWriteParams["todos"]): TurnTodo[] {
  return todos.map((todo) => ({ ...todo }));
}

function formatTodoWriteResult(todos: TurnTodo[]): string {
  if (todos.length === 0) return "Current task list is empty.";
  const lines = todos.map((todo) => `- [${todo.status}] ${todo.id}: ${todo.content}`);
  const body = ["Current task list:", ...lines].join("\n");
  const hasOpenTodos = todos.some(
    (todo) => todo.status === "pending" || todo.status === "in_progress",
  );
  if (!hasOpenTodos) return body;
  const reminder = dedent`
    <system-reminder>
    The todo list still has unfinished items. As you complete each one, call todo_write again with merge=true to flip its status to completed (and advance the next item to in_progress). Keep calling todo_write until every item is in a terminal state.
    </system-reminder>
  `;
  return `${body}\n\n${reminder}`;
}

/**
 * 构造发送给 parent 的 acknowledgment turn 的 prompt body——每次状态机进入终态后，
 * turn runner 额外运行一次 parent prompt，使 parent 能在控制权返回用户前用自然语言
 * 对结果作出回应。
 *
 * 这里对“主动决定还是运行时失败”有意保持中性：parent 自身的 transcript 已显示它是
 * 主动选择了终态（前一条 `select_state_machine_state` 工具调用），还是状态机自行结束；
 * 终态的 `status`/`reason` 会提供 parent 组织回复所需的其余信息。prompt 引导 parent
 * 使用纯文本总结，并默认避免在本回合执行控制动作：机器已经结束，parent 通常应总结
 * 并交还控制权，而不是主动启动更多工作。后续工作由用户驱动——等待用户请求或持续
 * 执行的既有指令，而不是 parent 自己发起。
 */
export function formatStateMachineTerminalAcknowledgmentPrompt(input: {
  session: StateMachineSession;
}): string {
  const { session } = input;
  const terminal = session.terminal;
  if (!terminal) {
    throw new Error("formatStateMachineTerminalAcknowledgmentPrompt requires a terminal session.");
  }
  return systemReminder(dedent`
    The state machine "${session.definition.name}" has reached a terminal state and is no longer running.

    ${toXML({
      state_machine_terminal: {
        state: terminal.state,
        status: terminal.status,
        reason: terminal.reason ?? null,
      },
    })}

    Usually: reply to the user in plain text — summarize what happened and recommend what to do next, then let control return to them. Don't proactively spin up new work or resume this machine just because the tools are available.

    The exception is a standing instruction the user already gave: if they told you to keep going until the work is finished (or asked for follow-up this terminal does not yet satisfy), continuing is fine — call create_state_machine_definition for new work, or select a non-terminal state to reactivate and continue this machine. Absent that signal, default to summarizing and handing back.
  `);
}

export function formatCarriedTodosReminder(todos: TurnTodo[] | undefined): string | undefined {
  if (!todos || todos.length === 0) return undefined;
  const openTodos = todos.filter(
    (todo) => todo.status === "pending" || todo.status === "in_progress",
  );
  if (openTodos.length === 0) return undefined;
  const lines = todos.map((todo) => `- [${todo.status}] ${todo.id}: ${todo.content}`);
  return systemReminder(dedent`
    <system-reminder>
    You have an existing todo list from earlier in this conversation:
    ${lines.join("\n")}
    This list is shown to the user, so it must accurately reflect what you are actually working on right now. Update it with todo_write (merge=true) as you make progress, and keep calling todo_write until every item is in a terminal state. If the list is no longer relevant to the current request, call todo_write with merge=false and an empty todos array to clear it.
    </system-reminder>
  `);
}

function createStateMachineDefinitionTool(
  getStateMachine: (() => StateMachineSession | undefined) | undefined,
  // 用于在检查相对状态 `cwd` 是否存在前解析它的基础目录，与状态实际运行时使用的解析方式一致。
  baseCwd: string,
  scheduleValidation: {
    clock: RuntimeClock;
    minimumScheduledDelayMs: number;
  },
): AgentTool<typeof createDefinitionSchema> {
  return {
    name: "create_state_machine_definition",
    executionMode: "sequential",
    label: "Create state machine definition",
    description: dedent`
      为持久、多步骤或周期性工作创建新的状态机定义。完整路由规则（何时优先选择此工具而非 todo_write、状态如何恢复、终态确认等）请参阅系统提示词。此处仅说明调用结构。你定义的状态就是这项工作的可见计划，因此不要再调用 todo_write 镜像或跟踪相同阶段；状态机本身就是计划界面。

      调用结构（顶层键仅限 \`definition\`、\`firstState\` 和可选的 \`replaceActive\`；所有状态必须放在 \`definition.states\` 中，不能放在顶层）：
      {
        "definition": {
          "name": "<易读的状态机名称>",
          "prompt": "<说明何时适用此状态机的路由指导>",
          "states": [
            { "name": "step-1", "kind": "agent", "prompt": "..." },
            { "name": "step-2", "kind": "script", "command": "..." },
            { "name": "done", "kind": "terminal", "status": "completed" }
          ]
        },
        "firstState": "step-1"
      }

      状态 \`kind\` 可取 \`agent\`、\`script\`、\`poll\`、\`timer\`、\`park\`、\`terminal\`。park 会暂停状态机，不运行工作也不安排唤醒，让你继续与用户交流或向用户提问。poll 的 \`intervalMs\`、timer 的 \`wakeAt\` 和 \`wakeAfterMs\` 必须至少为 30 秒；agent/script 状态没有最短时长。时长可使用 \`ms\` 包解析的可读字符串，例如 \`"3h"\` 或 \`"5d"\`；\`wakeAt\` 可使用 ISO 8601 字符串，例如 \`"2026-05-24T18:00:00Z"\`；也可使用毫秒数。timer 状态必须且只能设置一个字段：\`wakeAt\`（绝对时间）或 \`wakeAfterMs\`（从选择时刻起算的相对时长）。每个定义至少需要一个 status 为 "completed" 的 \`terminal\` 状态；若未提供，系统会自动注入 "failed" 和 "cancelled" 终态。

      状态提示词和脚本命令可使用 \`{{ input.foo }}\` 模板——请在相应状态声明 \`inputSchema\`，并在通过 select_state_machine_state 选择时传入匹配的 \`decision.input\`。Agent 状态可通过 \`allowedSkills\` 限制子 Agent 可用技能。

      创建时，每个状态的 \`cwd\` 必须解析为现有目录；相对 \`cwd\` 会相对于系统提示词 \`<cwd>\` 区块中显示的会话工作目录解析。如果先前状态会在运行时创建该目录（worktree、克隆目录或临时目录），此处请省略 \`cwd\`，待目录存在后再通过 select_state_machine_state 的 \`decision.override.state.cwd\` 设置——不要将 \`cwd\` 指向尚不存在的路径。

      仅当当前没有活动状态机或先前状态机已到达终态时使用此工具；否则应调用 select_state_machine_state。若活动状态机仍在运行，创建新定义会被拒绝，除非设置 \`replaceActive: true\`，明确取消并替换当前状态机。
    `,
    parameters: createDefinitionSchema,
    async execute(_toolCallId, params) {
      // 除非 Agent 显式选择替换正在运行的机器，否则拒绝“运行中创建”。控制工具一次调用后
      // 会终止 worker turn，因此 Agent 无法在同一回合结束旧机器——要求 replaceActive
      // 会强制它确认当前机器，而不是覆盖一个它可能不知道正在运行的机器。抛出错误
      //（而不是返回）可以让 worker turn 继续，使 Agent 能推进活动机器、或使用
      // replaceActive: true 重试。
      const active = getStateMachine?.();
      if (active && !active.terminal && params.replaceActive !== true) {
        throw new Error(activeStateMachineCreateError(active));
      }
      assertValidDefinition(params.definition, baseCwd, scheduleValidation);
      const firstState = requireDefinedState(params.definition, params.firstState);
      const result: TurnRunnerControlResult = {
        type: "create_state_machine_definition",
        definition: params.definition,
        firstState: params.firstState,
      };
      const text =
        firstState.kind === "park"
          ? `${JSON.stringify(result, null, 2)}\n\n${parkNudge(firstState.name)}`
          : JSON.stringify(result, null, 2);
      return {
        content: [{ type: "text", text }],
        details: result,
        terminate: true,
      };
    },
  };
}

function createSelectStateTool(
  getDefinition: (() => StateMachineDefinition | undefined) | undefined,
  // 用于在检查相对状态/override `cwd` 是否存在前解析基础目录。它复刻 runner 对每个状态 cwd
  // 的解析方式（`cwdOverride ?? config.cwd ?? process.cwd()`），因此校验会拒绝与子 Agent
  // 工具实际启动目录相同的缺失目录。
  baseCwd: string,
): AgentTool<typeof selectStateSchema> {
  return {
    name: "select_state_machine_state",
    executionMode: "sequential",
    label: "Select state machine state",
    description: dedent`
      选择下一个状态机状态。所有选择字段都必须放在 \`decision\` 中，例如：{"decision":{"state":"work","override":{"kind":"agent","state":{"prompt":"更新后的任务","cwd":"/absolute/worktree"}}}}。顶层的 override/input/persistOverride 字段无效。\`decision.state\` 必须与活动定义中声明的某个状态名称完全匹配；该状态在定义中指定的 kind（agent、script、poll、timer、park 或 terminal）决定实际执行内容。所选状态定义了 inputSchema 或 {{ input.email }} 等模板时，在此传入匹配的 input 对象。poll 覆盖必须保留 intervalMs；timer 覆盖可替换 wakeAt 或 wakeAfterMs（二者只能选一）。

      将编排者现在掌握的信息传递下去。默认情况下，agent 状态会在全新的子 Agent 上下文中运行，无法查看前一状态的转录、工具输出或输出值——它只能看到渲染后的提示词和你在此传入的 input。因此，如果前一状态发现了下一状态需要的信息（文件路径、ID、错误消息、决策、摘要、根因），要么通过 \`decision.input\` 传递（前提是该状态的 inputSchema 有匹配字段），要么通过 \`decision.override.state.prompt\` 在运行下一状态前将发现写入其提示词。如果静态提示词仅写着“使用上一步的发现”，却没有提供输入或 override，就是错误做法：全新子 Agent 无法读取这些发现，你的推理和回复文本也不会传给它——此调用中的 \`decision.input\`/\`decision.override.state.prompt\` 是唯一传递渠道。首次进入依赖先前发现的状态时就传递事实；先裸选状态，等它回来困惑后再补上下文，不是解决办法。若重述所需上下文会造成信息丢失，可在 agent 状态设置 \`decision.override.state.forkContext: true\`，让它从父级转录副本开始；独立任务应保持关闭，因为这会复制完整上下文。

      工作目录也是上下文传递的一部分，也是编排者最常出错之处。只要状态在会话 cwd 之外执行——例如 git worktree、克隆目录、子包或由先前状态返回路径的临时目录——就设置 agent 状态的 \`decision.override.state.cwd\`，或 script/poll 的 \`cwd\`。任何树外工作都应默认且及时设置，不要等子 Agent 自行定位。不要仅在提示词中写“cd 到 /path”或“在 /path 的 worktree 中工作”来传递位置：子 Agent 的编程工具（bash、read、write、edit）会从所设的 \`cwd\` 启动，而不是从提示词提到的位置启动；因此虽然文字看起来正确，工具仍可能指向错误的工作树。该路径通常来自先前状态的输出（例如实现步骤打印的 worktree 路径）——请捕获它，并在该转换中传给 \`decision.override.state.cwd\`。相对 cwd 会相对于系统提示词 \`<cwd>\` 区块中显示的会话工作目录解析；worktree 或克隆目录位于其外部时优先使用绝对路径。

      Overrides persist by default. When you pass \`decision.override\`, the merged state (prompt, command, schedule — whichever fields you set) is written back into the active definition, so every future run of that state uses the tuned version. This is the right shape when you are tightening a sub-agent prompt that hallucinated, fixing a script command that misbehaved, or tuning poll/timer cadence. Set \`decision.persistOverride: false\` when you want a one-shot variation that does not commit — for example, probing a different prompt to see if the sub-agent recovers before deciding whether to keep the change. Terminal selections accept only \`decision.state\` and \`decision.reason\`; omit \`decision.override\`, \`decision.input\`, and \`decision.persistOverride\`. \`decision.override.kind\` must match the target state's kind; a mismatch is rejected outright (rather than silently dropping the override), and a per-state \`cwd\` that does not resolve to an existing directory is rejected too — fix the kind or the path before re-selecting.

      Selecting a terminal state ends the state machine. Every definition is guaranteed to have the auto-injected \`failed\` and \`cancelled\` terminals available, so to fail or cancel, just select one of those by name and optionally attach a \`decision.reason\`. After a terminal you will be woken once more for an acknowledgment turn — the runner re-prompts you with the terminal details (state, status, reason) so you can summarize the outcome to the user in plain text. Default to that summary and let control return to the user; don't proactively start new work or call select_state_machine_state on the acknowledgment turn just because the tools are available.

      Follow-up is user-driven, not your own initiative. When the user asks to redo or continue a finished machine ("that's wrong, run X again"), reactivate it by selecting a non-terminal state, which clears the prior terminal and runs it live again from that state; for unrelated new work, call create_state_machine_definition. A standing instruction counts as that ask — if the user already told you to keep going until the work is done, continuing is appropriate.
    `,
    parameters: selectStateSchema,
    async execute(_toolCallId, params) {
      const definition = getDefinition?.();
      const decision: StateMachineRunnerDecision = {
        state: params.decision.state,
        reason: params.decision.reason,
        override: params.decision.override as StateMachineStateOverride | undefined,
        persistOverride: params.decision.persistOverride,
        input: params.decision.input,
      };
      assertValidSelectedState(decision, definition, baseCwd);

      const result: TurnRunnerControlResult = { type: "select_state_machine_state", decision };
      const selectedState = definition?.states.find((state) => state.name === decision.state);
      const text =
        selectedState?.kind === "park"
          ? `${JSON.stringify(result, null, 2)}\n\n${parkNudge(selectedState.name)}`
          : JSON.stringify(result, null, 2);
      return {
        content: [{ type: "text", text }],
        details: result,
        terminate: true,
      };
    },
  };
}

const updateStateSchema = Type.Object(
  {
    state: Type.String({ description: "Name of an existing state to edit without executing it." }),
    override: stateOverrideSchema,
  },
  { additionalProperties: false },
);

function createUpdateStateTool(
  getStateMachine: (() => StateMachineSession | undefined) | undefined,
  updateStateDefinition: (state: StateMachineState) => void,
  baseCwd: string,
): AgentTool<typeof updateStateSchema> {
  return {
    name: "update_state_machine_state",
    executionMode: "sequential",
    label: "Update state machine state",
    description: dedent`
      Persist instruction or configuration changes to an existing state without selecting or running it.
      Use this to revise a future agent prompt or script while a recurring relay sleeps. The current
      state, its input, running tasks, and scheduled wake stay unchanged. The override has the same
      shape as select_state_machine_state and applies to future selections. This does not end your turn.
      A state with a running task or scheduled wake cannot be edited through this tool: select it
      explicitly with an override to restart or reschedule it instead. Terminal states cannot be edited.
    `,
    parameters: updateStateSchema,
    async execute(_toolCallId, params) {
      const session = getStateMachine?.();
      if (!session) throw new Error("No state machine exists to edit.");
      const selected = session.definition.states.find((state) => state.name === params.state);
      if (!selected) throw new Error(`Unknown state: ${params.state}.`);
      if (selected.kind === "terminal") throw new Error("Terminal states cannot be edited.");
      const updated = validatedStateOverride(selected, params.override, baseCwd);
      updateStateDefinition(updated);
      const details = { type: "state_definition_updated", state: updated };
      return {
        content: [{ type: "text", text: JSON.stringify(details) }],
        details,
      };
    },
  };
}

function createCurrentStateMachineStateTool(
  getStateMachine: (() => StateMachineSession | undefined) | undefined,
  getActiveStateOutput: (() => ActiveStateOutput | undefined) | undefined,
): AgentTool {
  return {
    name: "get_current_state_machine_state",
    label: "Get current state-machine state",
    description:
      "Inspect current state-machine progress, including background work that ran after selecting a state. Use this after resume, interruption, or uncertainty before selecting the next state, and before answering user questions about state-machine progress, poll/wake status, what has already happened, or why the session is waiting.",
    parameters: Type.Object({}, { additionalProperties: false }),
    async execute() {
      const stateMachine = getStateMachine?.();
      const activeOutput = getActiveStateOutput?.();
      const result: CurrentStateMachineStateResult = {
        currentState: stateMachine?.currentState,
        currentInput: stateMachine?.currentInput,
        terminal: stateMachine?.terminal,
        progress: stateMachine?.progress,
        historyCount: stateMachine?.history.length ?? 0,
        history: stateMachine?.history.slice(-10) ?? [],
      };
      if (activeOutput) {
        result.activeOutput = activeOutput;
      }
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: result,
      };
    },
  };
}

function requireDefinedState(definition: StateMachineDefinition, name: string): StateMachineState {
  const state = definition.states.find((state) => state.name === name);
  if (!state) {
    throw new Error(
      `Unknown state: ${name}. Valid states: ${definition.states.map((state) => state.name).join(", ")}`,
    );
  }
  return state;
}

function assertValidSelectedState(
  decision: StateMachineRunnerDecision,
  definition: StateMachineDefinition | undefined,
  baseCwd: string,
): void {
  if (!definition) return;

  const selectedState = requireDefinedState(definition, decision.state);

  // 一个最小的终态选择总能避开损坏状态的 input/cwd。
  // 没有工作会消费额外控制字段时，不能让它们看起来像已被接受。
  if (selectedState.kind === "terminal") {
    if (
      decision.override !== undefined ||
      decision.input !== undefined ||
      decision.persistOverride !== undefined
    ) {
      throw new Error(
        "Terminal states accept only decision.state and decision.reason; omit override, input, and persistOverride.",
      );
    }
    return;
  }

  const effectiveState = validatedStateOverride(selectedState, decision.override, baseCwd);
  assertValidStateInput(effectiveState, decision.input);
}

function validatedStateOverride(
  selectedState: StateMachineState,
  override: StateMachineStateOverride | undefined,
  baseCwd: string,
): StateMachineState {
  // applyStateOverride 会忽略 kind 不匹配的 override，因此拒绝它，而不是报告一个已被丢弃的编辑。
  if (override && override.kind !== selectedState.kind) {
    throw new Error(
      `Override kind "${override.kind}" does not match state "${selectedState.name}", which is a "${selectedState.kind}" state. Set the override kind to "${selectedState.kind}" so the override is applied instead of silently dropped.`,
    );
  }
  const effectiveState = applyStateOverride(selectedState, override);
  assertValidStateInputSchema(effectiveState);
  assertValidStateSchedule(effectiveState);
  assertValidStateCwd(effectiveState, baseCwd, SELECT_CWD_GUIDANCE);
  return effectiveState;
}

// 根据校验执行的位置，将其追加到“cwd 不存在”错误中。选择状态时目录应已存在
//（前一状态有机会创建它）；创建状态时目录通常还不存在，因此一般应省略 cwd，
// 等目录创建后再通过 select_state_machine_state 的 `decision.override.state.cwd` 设置。
const SELECT_CWD_GUIDANCE =
  "Set the overridden state's cwd to a directory that exists — typically the worktree or clone an earlier state created.";
const CREATE_CWD_GUIDANCE =
  "If an earlier state creates this directory at runtime, omit cwd here and set it via decision.override.state.cwd on select_state_machine_state once the directory exists. Otherwise point it at a directory that already exists.";

// 将每个状态的 `cwd`（来自定义或 override）相对于 runner 的基础 cwd 解析。相对路径相对于
// `baseCwd` 解析——即由 --workDir 设置的 runner config.cwd，回退到 process.cwd()——
// 因此会落在 `<cwd>` system-prompt 区块公布的目录，而不是 Node 默认使用的启动进程 cwd。
// runtime（agent/script/poll 执行）和 select/create 校验都使用此函数，确保任何检查或运行
// 都得到相同的 cwd。没有每状态 cwd 时，`undefined` 回退到基础目录。
export function resolveStateCwd(cwd: string | undefined, baseCwd: string): string {
  if (cwd === undefined) return resolve(baseCwd);
  return isAbsolute(cwd) ? cwd : resolve(baseCwd, cwd);
}

// 每个状态的 `cwd`（来自定义或 override）会成为子 Agent 编程工具启动时使用的工作目录。
// 不存在或不是目录的路径会让子 Agent 进入损坏/空白的树，在那里找不到要求处理的文件，
// 并报告“无事可做”。
function assertValidStateCwd(state: StateMachineState, baseCwd: string, guidance: string): void {
  const cwd =
    state.kind === "agent" || state.kind === "script" || state.kind === "poll"
      ? state.cwd
      : undefined;
  if (!cwd) return;

  const resolved = resolveStateCwd(cwd, baseCwd);
  let stats: ReturnType<typeof statSync>;
  try {
    stats = statSync(resolved);
  } catch {
    throw new Error(
      `cwd "${cwd}" for state "${state.name}" does not exist (resolved to "${resolved}"). ${guidance}`,
    );
  }
  if (!stats.isDirectory()) {
    throw new Error(
      `cwd "${cwd}" for state "${state.name}" is not a directory (resolved to "${resolved}").`,
    );
  }
}

function assertValidStateInput(state: StateMachineState, input: unknown): void {
  if (!state.inputSchema) return;

  const candidate = input ?? {};
  if (Value.Check(state.inputSchema as never, candidate)) return;

  const errors = [...Value.Errors(state.inputSchema as never, candidate)];
  const first = errors[0] as { path?: string; message?: string } | undefined;
  const path = first?.path ?? "/";
  const message = first?.message ?? "does not match schema";
  throw new Error(`Invalid input for state "${state.name}" at ${path}: ${message}`);
}

// poll/timer 的最小 cadence。状态机用于能跨 sleep、wake 和后台执行持续的长生命周期工作；
// 短于此值的工作应直接在 parent turn 中完成，而不是承担状态机编排开销。
export const MINIMUM_STATE_MACHINE_DELAY_MS = 30_000;

function assertValidDefinition(
  definition: StateMachineDefinition,
  baseCwd: string,
  scheduleValidation: { clock: RuntimeClock; minimumScheduledDelayMs: number },
): void {
  for (const state of definition.states) {
    if (state.name === INTERRUPTED_STATE_MACHINE_STATE) {
      throw new Error(`State name "${INTERRUPTED_STATE_MACHINE_STATE}" is reserved.`);
    }
    assertValidStateInputSchema(state);
    assertValidStateSchedule(state);
    assertValidStateScheduleMinimum(state, scheduleValidation);
    assertValidStateCwd(state, baseCwd, CREATE_CWD_GUIDANCE);
  }
  injectMissingTerminalEscapeHatches(definition);
  assertHasCompletedTerminal(definition);
}

// 作者定义成功路径的出口；自动添加 failed/cancelled 逃生出口，使每个 definition
// 都能被中止或完成，而不要求调用方记住样板终态。
function injectMissingTerminalEscapeHatches(definition: StateMachineDefinition): void {
  const existingNames = new Set(definition.states.map((state) => state.name));
  if (!existingNames.has("failed")) {
    definition.states.push({ kind: "terminal", name: "failed", status: "failed" });
  }
  if (!existingNames.has("cancelled")) {
    definition.states.push({ kind: "terminal", name: "cancelled", status: "cancelled" });
  }
}

function assertHasCompletedTerminal(definition: StateMachineDefinition): void {
  const hasCompletedTerminal = definition.states.some(
    (state) => state.kind === "terminal" && state.status === "completed",
  );
  if (!hasCompletedTerminal) {
    throw new Error(
      'State-machine definition must include at least one terminal state with status "completed" representing successful completion of the lifecycle.',
    );
  }
}

function assertValidStateInputSchema(state: StateMachineState): void {
  if (!state.inputSchema) return;

  if (jsonSchemaValidator.validateSchema(state.inputSchema)) return;

  const message = jsonSchemaValidator.errorsText(jsonSchemaValidator.errors, {
    dataVar: `inputSchema for state "${state.name}"`,
  });
  throw new Error(`Invalid inputSchema for state "${state.name}": ${message}`);
}

// 形状校验：intervalMs / wakeAt 必须存在且可解析。在 definition 创建和状态选择时都运行，
// 因此 malformed override 也会被拒绝。除原始毫秒数外，还接受 "3h" / "5d" 等时长字符串；
// 绝对 wakeAt 接受 ISO 8601 字符串。
function assertValidStateSchedule(state: StateMachineState): void {
  if (state.kind === "poll") {
    parseDurationToMs(
      state.intervalMs,
      `Invalid poll schedule for state "${state.name}": intervalMs`,
    );
  }
  if (state.kind === "timer") {
    const hasWakeAt = state.wakeAt !== undefined;
    const hasWakeAfter = state.wakeAfterMs !== undefined;
    if (hasWakeAt === hasWakeAfter) {
      throw new Error(
        `Invalid timer schedule for state "${state.name}": specify exactly one of wakeAt or wakeAfterMs.`,
      );
    }
    if (hasWakeAt) {
      parseWakeAtToMs(state.wakeAt, `Invalid timer schedule for state "${state.name}": wakeAt`);
    } else {
      parseDurationToMs(
        state.wakeAfterMs,
        `Invalid timer schedule for state "${state.name}": wakeAfterMs`,
      );
    }
  }
}

// 最小 cadence 指导：仅在创建新 definition 时强制。通过 `mode:` 交给 runner 的现有 definition
// 可能来自 Agent 未编写的配置，合法地使用更短 cadence；runtime 应按原样运行，而不是重新
// 争论这个边界。
function assertValidStateScheduleMinimum(
  state: StateMachineState,
  input: { clock: RuntimeClock; minimumScheduledDelayMs: number },
): void {
  if (state.kind === "poll" && state.intervalMs !== undefined) {
    const intervalMs = parseDurationToMs(
      state.intervalMs,
      `Invalid poll schedule for state "${state.name}": intervalMs`,
    );
    if (intervalMs < input.minimumScheduledDelayMs) {
      throw new Error(
        `Invalid poll schedule for state "${state.name}": intervalMs must be at least ${scheduleFloorDescription(input.minimumScheduledDelayMs, true)}. Anything shorter should run directly in the parent turn instead of through a state machine.`,
      );
    }
  }
  if (state.kind === "timer" && state.wakeAt !== undefined) {
    const wakeAt = parseWakeAtToMs(
      state.wakeAt,
      `Invalid timer schedule for state "${state.name}": wakeAt`,
    );
    const minWakeAt = input.clock.now() + input.minimumScheduledDelayMs;
    if (wakeAt < minWakeAt) {
      throw new Error(
        `Invalid timer schedule for state "${state.name}": wakeAt must be at least ${scheduleFloorDescription(input.minimumScheduledDelayMs)} in the future. Anything shorter should run directly in the parent turn instead of through a state machine.`,
      );
    }
  }
  if (state.kind === "timer" && state.wakeAfterMs !== undefined) {
    const wakeAfterMs = parseDurationToMs(
      state.wakeAfterMs,
      `Invalid timer schedule for state "${state.name}": wakeAfterMs`,
    );
    if (wakeAfterMs < input.minimumScheduledDelayMs) {
      throw new Error(
        `Invalid timer schedule for state "${state.name}": wakeAfterMs must be at least ${scheduleFloorDescription(input.minimumScheduledDelayMs, true)}. Anything shorter should run directly in the parent turn instead of through a state machine.`,
      );
    }
  }
}

function scheduleFloorDescription(delayMs: number, includeMilliseconds = false): string {
  if (delayMs === MINIMUM_STATE_MACHINE_DELAY_MS) {
    return includeMilliseconds ? `30 seconds (${delayMs} ms)` : "30 seconds";
  }
  return `${delayMs} ms`;
}
