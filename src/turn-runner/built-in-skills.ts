import dedent from "dedent";
import type { Skill } from "@earendil-works/pi-coding-agent";
import { createSyntheticSourceInfo } from "@earendil-works/pi-coding-agent";

/**
 * 内置 skill 的 `filePath`/`baseDir` 使用的合成标记前缀。真实 skill 位于磁盘上可发现的
 * `baseDir` 下；内置 skill 随包发布，因此此前缀是一个虚拟哨兵，既能避免其路径与文件系统中的
 * 任何内容冲突，也能在日志或 `relay-pi skills` 输出中为人类提供清晰提示。
 * 内置 skill 的检测本身通过 `BUILT_IN_BY_PATH` 映射进行，而不是匹配前缀。
 */
const BUILTIN_PATH_PREFIX = "<relay-pi-builtin>";

export interface BuiltInSkill {
  /** 通过标准发现 API 暴露的 skill 元数据。 */
  skill: Skill;
  /** 内联的 SKILL.md 正文。由 `readSkillInstructions` 返回。 */
  instructions: string;
}

/**
 * 内置 `/relay` skill 的正文。用户在消息中任意位置输入 `/relay` 时，
 * 它会在标准 `<skill>` 包装器内原样渲染到提示词中。
 */
const RELAY_INSTRUCTIONS = dedent`
  The user requested relay mode for this prompt. Strongly prefer the
  state-machine tools (\`create_state_machine_definition\` or
  \`select_state_machine_state\`) over handling the work inline.

  - If no state machine is active, create one with agent/script/poll/timer/terminal
    states sized to the request.
  - If a state machine is already active, select the next state instead of
    replying directly.
  - Only fall back to a plain answer when the request is genuinely a
    one-shot question that cannot be expressed as a state.

  ## When the request is a goal, not a process

  Some requests have no process to model — just an outcome that must hold
  ("get the suite green", "make this page load under a second"). Those want
  a loop, not a pipeline: a \`park\` state where you do the work yourself,
  an \`agent\` state holding an evaluator sub-agent that judges the result
  against written criteria and answers \`VERDICT: complete\` or
  \`VERDICT: incomplete\` plus the specific gaps, and a terminal you select
  only after a pass you spot-checked. Incomplete sends the machine back to
  the park for another round. Give the evaluator fresh context and the
  criteria — never a summary of what you did, which only teaches it to
  accept your account.

  The built-in \`/goal\` skill is the full write-up of that loop: how to fix
  criteria before you start, how to prompt the judge, and how to stop a loop
  that will not converge. Suggest \`/goal\` when the user's request is
  shaped that way.

  ## Running multiple scheduled tasks (cron-style) in ONE state machine

  Only one state machine can be active per session, so when the user wants
  several recurring jobs ("replace my crons", "run these N tasks on
  different cadences"), do NOT try to spin up one relay per task. Build a
  single master relay that multiplexes them all. This pattern is proven
  in production.

  ### Architecture

  - **Schedule file** (e.g. \`~/.relay-pi/relay/schedule.json\`):
    \`{ "<task>": { "interval": <ms>, "next": <unix-ms>, "kind": "agent"|"script" } }\`.
    This is the only source of truth for "what's due when."
  - **Dispatcher script** (e.g. \`~/.relay-pi/relay/dispatch.sh\`): reads
    \`schedule.json\`, sorted by \`next\` ascending. For every due task:
      - If \`kind: "script"\` (shell-only): run inline inside the dispatcher,
        append output to a bounded log, then bump \`next += interval\` and
        keep looking. The orchestrator never wakes for these.
      - If \`kind: "agent"\` (needs an LLM): write the task name to
        \`next-agent.txt\` and \`exit 0\` (or another code in the poll's
        \`successCodes\`) so the poll completes and the orchestrator wakes.
        Stdout is captured and surfaced as the state output, so echoing
        the task name (or a JSON payload) is a useful debugging signal,
        but the *exit code is what makes the poll succeed*.
      - For known-noisy agents (e.g. inbox triage), pre-check cheaply
        from shell first (e.g. count IMAP unread). If there's nothing to
        do, skip the wake and just bump \`next\`.
    If no due task needed a wake: \`exit 1\` (poll keeps polling).
  - **Log file**: always size-bounded (\`tail -n 500\` rotate, or similar).
    Long-running relays will fill any unbounded log.

  ### State machine shape

  - One \`poll\` state with \`intervalMs\` ≥ the platform floor that runs
    the dispatcher script. \`successCodes: [0]\` so it only wakes the
    orchestrator when an agent task is queued.
  - One \`agent\` state **per agent task** (\`run-inbox\`,
    \`run-growth-report\`, etc.). Each prompt is narrow — just that one
    task's instructions — and ends with the same footer:
      1. Bump \`schedule.json\` for this task (\`while next <= now: next += interval\`).
      2. \`rm -f next-agent.txt\` to clear the signal.
      3. Reply with one terse line of result.
  - A \`stop\` terminal so the operator can cancel cleanly.

  ### Orchestrator loop

  On wake: read \`next-agent.txt\` (the dispatcher wrote which agent is due),
  select the matching \`run-*\` state. After the agent completes, re-select
  \`poll\`. That's it — no scheduling logic in the orchestrator; the
  dispatcher and the agent footers own the math.

  ### Why this works

  - The orchestrator only consumes parent-context tokens when there is
    actual agent work to do. Quiet hours cost zero.
  - Shell tasks and zero-work agent checks run silently inside the poll.
  - Bumping \`next\` with the \`while\` loop catches up automatically if a
    task fell several intervals behind (e.g. after sandbox downtime).
  - One file (\`schedule.json\`) plus one script (\`dispatch.sh\`) is the
    whole surface area; adding a new cron is a single JSON entry and a
    branch in the dispatcher (plus, for agent tasks, one new \`run-*\`
    state).
`;

const RELAY_DESCRIPTION =
  "Run durable, multi-step, or recurring work as a state machine of sub-agent, script, poll, and timer states so the work survives session boundaries and progress stays visible to the user.";

/**
 * 内置 `/goal` skill 的正文。它是参考模式而非预构建的 machine：用于教 Agent
 * 构建自己的工作/评估循环，使定义、条件和 state 名称符合当前目标。
 */
const GOAL_INSTRUCTIONS = dedent`
  The user gave you a goal to drive to completion, not a task to perform
  once. Build a state machine whose loop is: you do the work, an
  independent sub-agent judges whether the goal is actually met, and the
  machine terminates only when that judge says yes.

  This is a pattern to instantiate with
  \`create_state_machine_definition\`, not a fixed machine to invoke.
  Name the states, write the criteria, and size the loop to this goal.

  ## The two states (plus a terminal)

  1. **work** — a \`park\` state. Park runs nothing itself; it records that
     you, the main agent, own the next move, so the work happens in your own
     turn with your own tools and full context. Start here, take a complete
     pass at the goal, then select \`evaluate\`. This is also where the
     machine sits whenever a turn ends mid-goal — out of rounds, or waiting
     on the user — so the next turn resumes into the work phase. (If the
     work is better delegated — heavy, isolated, or parallelizable — make
     this an \`agent\` state instead; the loop is identical.)
  2. **evaluate** — an \`agent\` state. A sub-agent that judges, and only
     judges. It never does the work, and it never fixes what it finds.
  3. **goal_met** — a \`terminal\` with status \`"completed"\`, selected
     only on a verified pass.

  \`\`\`json
  {
    "name": "<goal in a few words>",
    "prompt": "Drive <the goal> to completion: work, then evaluate, until the evaluator passes.",
    "states": [
      { "name": "work", "kind": "park",
        "when": "Start here, and return here after every incomplete verdict, to do or fix the work." },
      { "name": "evaluate", "kind": "agent",
        "when": "After each work pass, to judge the goal against its criteria.",
        "prompt": "<the goal verbatim + criteria + verdict format>" },
      { "name": "goal_met", "kind": "terminal", "status": "completed" }
    ]
  }
  \`\`\`

  ## Criteria come first

  Before creating the definition, decide what "done" means, as checks
  someone else could run: the command that must exit 0, the file that must
  contain X, the behavior the user must be able to observe. Subjective
  goals ("make it feel faster", "clean this up") still need observable
  proxies — pick them now, because an unfalsifiable criterion makes the
  loop unterminable. If you cannot state a check for a criterion that
  matters, ask the user before you start.

  ## Writing the evaluator

  - **Fresh context, not forked.** Leave \`forkContext\` off. The judge
    must grade the artifact that exists, not your account of it — your
    narration of your own work is exactly the thing most likely to be
    wrong.
  - **Carry criteria, not history.** Its prompt restates the goal verbatim
    and lists the criteria. It gets no summary of what you tried; that
    only teaches it to accept your framing.
  - **Make it verify.** Instruct it to read the files, run the
    build/tests/command, and reproduce the user's scenario. A verdict
    reached by reading a diff is a guess.
  - **Fix the verdict shape** so the loop can branch on it:
    - \`VERDICT: complete\` — nothing left against the criteria.
    - \`VERDICT: incomplete\` — followed by a numbered list of gaps, each
      naming what is wrong, where, and what would satisfy it. "Needs
      polish" is not a gap; "src/cli/run.ts:88 still ignores --json" is.
  - **Bias it toward finding gaps.** Tell it to look for what a skeptical
    reviewer would reject, and to report a gap when unsure rather than
    passing on the benefit of the doubt.

  ## The loop

  Create the definition with \`firstState: "work"\`, then do a full work
  pass in that same turn and select \`evaluate\` when the pass is done —
  parking is not a reason to stop. From there:

  - **incomplete** → fix every gap, then select \`evaluate\` again. A state
    that completes hands you a pass that must end in a transition, so do the
    fixing in that pass rather than parking first for it — you already hold
    the gaps in your context, and nothing needs threading through state
    input.
  - **complete** → check one or two criteria yourself before you
    terminate. A pass verdict is a claim like any other sub-agent output;
    a judge can hallucinate a pass the same way a worker hallucinates a
    finish. Then select \`goal_met\`.
  - **blocked on the user** → this is what \`work\` is for. Select it, ask
    your question, and end the turn; the machine holds at \`work\` and the
    user's reply resumes the loop.

  ## Don't let the loop spin

  - Keep the criteria fixed across rounds. Re-scoping mid-loop is how a
    loop "passes" without the goal being met; change criteria only with
    the user.
  - If the same gap survives two rounds, your approach is the problem, not
    the effort. Change approach rather than retrying harder.
  - After a few rounds with no pass, or if the verdicts flip-flop, park at
    \`work\` and ask the user with \`ask_user_question\` — the criteria are
    wrong, the goal is underspecified, or the work is blocked.
  - A goal that turns out to be unachievable ends at a \`failed\` terminal
    with the reason recorded. That is a real outcome; an endless loop is
    not.
`;

const GOAL_DESCRIPTION =
  "Drive a goal to completion with a state machine that loops your own work against an independent sub-agent evaluator, terminating only when the evaluator verifies the goal's success criteria are met.";

function buildBuiltIn(
  name: string,
  description: string,
  instructions: string,
  /**
   * 隐藏 skill，使其仅在用户输入 `/name` 或某个 state 的 prompt 命名它时激活。
   * 对于其模式已经可通过另一个 skill 的正文触达的 skill，应使用此选项：同时展示两者
   * 会让模型每回合都在两个重叠的菜单项之间进行选择。
   */
  disableModelInvocation = false,
): BuiltInSkill {
  const baseDir = `${BUILTIN_PATH_PREFIX}/${name}`;
  const filePath = `${baseDir}/SKILL.md`;
  return {
    skill: {
      name,
      description,
      filePath,
      baseDir,
      sourceInfo: createSyntheticSourceInfo(filePath, {
        source: "relay-pi:builtin",
        scope: "user",
        origin: "top-level",
        baseDir,
      }),
      disableModelInvocation,
    },
    instructions,
  };
}

/**
 * 运行器随附的内置 skill 注册表。它们会与用户/项目 skill 一起出现在 skill 发现结果中，
 * 并可被安装在任意发现根目录下的同名 skill 覆盖。
 */
export const BUILT_IN_SKILLS: readonly BuiltInSkill[] = [
  buildBuiltIn("relay", RELAY_DESCRIPTION, RELAY_INSTRUCTIONS),
  // 仅由用户调用：`/relay` 携带 goal 循环的结构，因此模型通过 relay 触达此模式，
  // 而不是自行在两个 state machine skill 之间进行选择。
  buildBuiltIn("goal", GOAL_DESCRIPTION, GOAL_INSTRUCTIONS, true),
];

const BUILT_IN_BY_PATH = new Map(
  BUILT_IN_SKILLS.map(({ skill, instructions }) => [skill.filePath, instructions]),
);

/**
 * 返回内置 skill 的内存中 SKILL.md 正文；如果该 skill 不是内置 skill，则返回 `undefined`
 * （调用方可以回退到从磁盘读取）。
 */
export function getBuiltInSkillInstructions(filePath: string): string | undefined {
  return BUILT_IN_BY_PATH.get(filePath);
}

export function isBuiltInSkill(skill: Skill): boolean {
  return BUILT_IN_BY_PATH.has(skill.filePath);
}

/** 将内置 skill 快照为普通 `Skill` 记录，以便合并到发现结果中。 */
export function listBuiltInSkills(): Skill[] {
  return BUILT_IN_SKILLS.map(({ skill }) => skill);
}
