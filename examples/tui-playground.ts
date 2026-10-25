/**
 * TUI 演示场。
 *
 * 在 stub `SessionTurnRunner` 上运行真实 TUI，因此无需实时模型即可验证布局、颜色
 * 和状态行组合。每条用户提示词都会驱动一个脚本化场景，而不是请求 provider：
 *
 *   /working <secs>            流式运行持续约 <secs> 的模拟工作回合
 *   /observe <secs>            相同操作，但作为观察式记忆阶段
 *   /queue <a,b,c>             发出包含给定提示词的后续队列
 *   /queue+observe <secs>      运行带有非空队列的观察阶段
 *   /follow-up-demo            将包含三个提示词的队列逐步清空，并把
 *                              每个已交付条目重放为 `you:` 块
 *   /tools <secs>              发出一个从运行到完成的模拟工具调用
 *   /tools-demo                使用详细数据运行一批格式化器
 *   /banner-demo               演示黏性的“最新用户消息”横幅
 *   /ask                       发出包含三个问题的 `ask` terminal
 *                              （单选、多选、单选）。按 Up/Down 移动高亮（并实时记录
 *                              单选答案）。Space/Enter 在单选时前进，在多选时切换行，
 *                              高亮模拟的“Done”行时前进。←/→ 可返回之前的问题
 *                              或前往后续问题。流程中输入提示词会通过
 *                              `session.answer({ ..., message })` 刷新最新答案。
 *   /sleep <secs>              发出会在 N 秒后唤醒的 `sleep` terminal
 *   /error <message>           发出系统错误并结束回合
 *   其他内容                   流式输出一段简短文本并完成
 *
 * 运行方式：
 *   bun run examples/tui-playground.ts
 *
 * 可选的第一个 CLI 参数会作为初始提示词自动提交，例如：
 *   bun run examples/tui-playground.ts "/queue+observe 30"
 * 这样可以立即观察组合后的状态行。
 */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Skill } from "@earendil-works/pi-coding-agent";
import type { Observation } from "../src/types/memory.js";
import { Session, type SessionTurnRunner } from "../src/session/session.js";
import { runTui } from "../src/tui/app.js";
import type { SkillCollision } from "../src/turn-runner/skills.js";
import type {
  TurnAgentFile,
  TurnCommand,
  TurnUsageEvent,
  TurnEditFollowUpQueueCommand,
  TurnEvent,
  TurnInterruptCommand,
  TurnQuestion,
  TurnStartCommand,
  TurnState,
  TurnTerminalEvent,
} from "../src/types/protocol.js";

export const INITIAL_STATE: TurnState = {
  status: "running",
  mode: "agent",
  agent: { status: "running", messages: [] },
};

// 保持此列表与下方的 runScenario 分支同步；它会作为第一个 transcript 块渲染，
// 让执行 `bun run examples/tui-playground.ts` 的用户无需滚回文件头即可发现各场景。
export const PLAYGROUND_MENU = [
  "Playground scenarios (type any of these and press Enter):",
  "  /working <secs>            stream a fake working turn for ~secs",
  "  /observe <secs>            same, but as an observational memory phase",
  "  /reflect <secs>            same, but as a reflection memory phase",
  "  /queue <a,b,c>             emit a follow-up queue with the given prompts",
  "  /queue+observe <secs>      observation phase with a non-empty queue",
  "  /follow-up-demo            walk a three-prompt queue down to empty,",
  "                             replaying each delivered entry as a `you:` block",
  "  /tools <secs>              one fake tool-call running -> completed",
  "  /tools-demo                run a batch of formatters with verbose data",
  "  /banner-demo               demo the sticky 'latest user message' banner",
  "                             (re-run with a multi-line paste to see the clamp)",
  "  /ask                       ask three questions (single, multi, single).",
  "                             ↑/↓ move highlight (single-select live-records);",
  "                             Space/Enter advance, or toggle on multi-select;",
  "                             a 'Done' row is the multi-select advance key;",
  "                             ←/→ revisit prior or upcoming questions;",
  "                             typing mid-flow flushes the latest answers.",
  "  /context [pct]             emit a usage event filling the bar to ~pct (default 60)",
  "  /sleep <secs>              emit a sleep terminal that wakes in N seconds",
  "  /error <message>           emit a system error and end the turn",
  "  /echo <text>               stream <text> back verbatim and complete (used by tests)",
  "  anything else              stream a short text reply and complete",
].join("\n");

export class FakePlaygroundRunner implements SessionTurnRunner {
  private readonly handlers = new Set<(event: TurnEvent) => void>();
  private state: TurnState;
  private interrupted = false;
  private currentTurn?: { resolve: () => void; cancelled: boolean };

  constructor(initialState: TurnState = INITIAL_STATE) {
    this.state = structuredClone(initialState);
  }

  async start(_command: TurnStartCommand): Promise<TurnState> {
    this.emit({ type: "turn_started", state: this.state });
    this.emit({ type: "system", level: "info", message: PLAYGROUND_MENU });
    return this.state;
  }

  async turn(command: TurnCommand): Promise<TurnTerminalEvent> {
    if (command.type === "wake") {
      return this.complete("Woke up.");
    }
    this.interrupted = false;
    const terminal =
      command.type === "answer"
        ? await this.runAnswerScenario(command)
        : await this.runScenario(command.message.trim());
    this.state = terminal.state;
    this.emit(terminal);
    return terminal;
  }

  /**
   * 流式输出 TUI 选择器通过 `session.answer(...)` 派发的答案（以及任何已刷新提示词）摘要。
   * 让演示场景无需真实模型即可端到端演示选择器交接。
   */
  private async runAnswerScenario(
    command: Extract<TurnCommand, { type: "answer" }>,
  ): Promise<TurnTerminalEvent> {
    const lines: string[] = ["Answers received:"];
    for (const question of command.questions) {
      const labels = command.answers[question.question] ?? [];
      const rendered = labels.length === 0 ? "(no selection)" : labels.join(", ");
      lines.push(`- ${question.question} -> ${rendered}`);
    }
    const trailing = command.message?.trim();
    if (trailing) lines.push(`Trailing prompt: ${trailing}`);
    const summary = lines.join("\n");

    for (const chunk of summary.match(/.{1,32}/g) ?? []) {
      this.emit({ type: "step", step: { type: "text_delta", delta: chunk } });
      await this.sleep(60);
      if (this.interrupted) return this.interruptedTerminal();
    }
    this.emit({ type: "step", step: { type: "text", text: summary } });
    return this.complete(summary);
  }

  interrupt(_command: TurnInterruptCommand): void {
    if (this.currentTurn) {
      this.interrupted = true;
      this.currentTurn.cancelled = true;
      this.currentTurn.resolve();
    }
  }

  editFollowUpQueue(command: TurnEditFollowUpQueueCommand): void {
    this.emit({ type: "follow_up_queue", followUpQueue: command.prompts });
  }

  compact(): void {
    // 演示场景的 transcript 是合成的，不是真实模型会话，因此这里的
    // compact 不执行任何操作。不过仍需实现 SessionTurnRunner 接口，
    // 因为它与生产实现共享。
  }

  getState(): TurnState | undefined {
    return this.state;
  }

  subscribe(handler: (event: TurnEvent) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  async getSkills(): Promise<readonly Skill[]> {
    return [];
  }

  async reloadSkills(): Promise<readonly Skill[]> {
    return [];
  }

  async getResolvedAgentFiles(): Promise<readonly TurnAgentFile[]> {
    return [];
  }

  async getSkillCollisions(): Promise<readonly SkillCollision[]> {
    return [];
  }

  async dispose(): Promise<void> {}

  /**
   * 发出一个合成的 `ask` terminal，让测试或演示扩展无需经过 slash 场景层，
   * 就能把选择器推入已知状态。它模拟 `/ask` 场景的结果，但允许调用方
   * 手动构造问题列表。
   */
  emitAskTerminal(questions: TurnQuestion[]): void {
    const terminal: TurnTerminalEvent = {
      type: "ask",
      state: { ...this.state, status: "waiting_for_human" },
      questions,
    };
    this.state = terminal.state;
    this.emit(terminal);
  }

  /** 为需要明确分段总数的测试发出 `usage`。 */
  emitUsage(event: Omit<TurnUsageEvent, "type">): void {
    this.emit({ type: "usage", ...event });
  }

  /**
   * 通过场景引擎使用的同一广播路径推送手工构造的事件。
   * 测试依靠它驱动独立的 step / memory / usage 流程，避免承担完整脚本场景的延迟。
   */
  emitEvent(event: TurnEvent): void {
    this.emit(event);
  }

  // ---- 场景管线 -------------------------------------------------------------

  private emit(event: TurnEvent): void {
    // 保持 getState() 返回的快照与我们发出的队列事件一致，模拟生产运行器，
    // 这样读取 state.followUpQueue 的消费者（例如 Ctrl+C 弹出处理器）能看到实时队列。
    if (event.type === "follow_up_queue") {
      this.state = { ...this.state, followUpQueue: [...event.followUpQueue] };
    } else if (event.type === "task_started") {
      const tasks = (this.state.tasks ?? []).filter((task) => task.id !== event.task.id);
      this.state = { ...this.state, tasks: [...tasks, { ...event.task }] };
    } else if (event.type === "task_settled") {
      this.state = {
        ...this.state,
        tasks: (this.state.tasks ?? []).map((task) =>
          task.id === event.settlement.id ? { ...task, status: event.settlement.status } : task,
        ),
      };
    }
    for (const handler of this.handlers) handler(event);
  }

  private async runScenario(message: string): Promise<TurnTerminalEvent> {
    if (message.startsWith("/working")) {
      const secs = parseSeconds(message, 8);
      await this.sleep(secs * 1000);
      if (this.interrupted) return this.interruptedTerminal();
      this.emit({ type: "step", step: { type: "text", text: `Worked for ${secs}s.` } });
      return this.complete(`Worked for ${secs}s.`);
    }

    if (message.startsWith("/tools-demo")) {
      const askTerminal = await this.runToolsDemo();
      return askTerminal ?? this.complete("Tools demo finished.");
    }

    if (message.startsWith("/banner-demo")) {
      return this.runBannerDemo();
    }

    if (message.startsWith("/tools")) {
      const secs = parseSeconds(message, 4);
      this.emit({
        type: "step",
        step: {
          type: "tool_call_start",
          toolName: "fake_search",
          toolCallId: "tool_1",
          input: { query: "playground" },
        },
      });
      await this.sleep(secs * 1000);
      if (this.interrupted) return this.interruptedTerminal();
      this.emit({
        type: "step",
        step: {
          type: "tool_call",
          toolName: "fake_search",
          toolCallId: "tool_1",
          input: { query: "playground" },
          isError: false,
          output: [{ type: "text", text: "Found 3 results." }],
        },
      });
      return this.complete("Tool call finished.");
    }

    if (message.startsWith("/observe")) {
      const secs = parseSeconds(message, 20);
      return this.runMemoryPhase("observation", secs);
    }

    if (message.startsWith("/reflect")) {
      const secs = parseSeconds(message, 20);
      return this.runMemoryPhase("reflection", secs);
    }

    if (message.startsWith("/follow-up-demo")) {
      return this.runFollowUpDemo();
    }

    if (message.startsWith("/queue+observe")) {
      const secs = parseSeconds(message, 30);
      this.emit({
        type: "follow_up_queue",
        followUpQueue: [
          { message: "draft release notes" },
          { message: "ping reviewers" },
          { message: "merge once green" },
        ],
      });
      const terminal = await this.runMemoryPhase("observation", secs);
      this.emit({ type: "follow_up_queue", followUpQueue: [] });
      return terminal;
    }

    if (message.startsWith("/queue")) {
      const arg = message.slice("/queue".length).trim();
      const messages =
        arg.length > 0
          ? arg
              .split(",")
              .map((entry) => entry.trim())
              .filter(Boolean)
          : ["follow-up one", "follow-up two", "follow-up three"];
      this.emit({
        type: "follow_up_queue",
        followUpQueue: messages.map((m) => ({ message: m })),
      });
      await this.sleep(2000);
      if (this.interrupted) return this.interruptedTerminal();
      this.emit({ type: "follow_up_queue", followUpQueue: [] });
      return this.complete(`Queued ${messages.length} follow-ups.`);
    }

    if (message.startsWith("/ask")) {
      const terminal: TurnTerminalEvent = {
        type: "ask",
        state: { ...this.state, status: "waiting_for_human" },
        questions: [
          {
            question: "Pick a deployment target",
            options: [
              { label: "staging" },
              { label: "production", description: "requires approval" },
            ],
          },
          {
            question: "Which test suites should run before promotion?",
            multiSelect: true,
            options: [
              { label: "unit", description: "fast, runs on every push" },
              { label: "integration", description: "hits live services" },
              { label: "e2e", description: "drives the browser" },
              { label: "load", description: "long-running soak" },
            ],
          },
          {
            question: "Confirm rollout window",
            options: [
              { label: "now" },
              { label: "tonight", description: "after 22:00 local" },
              { label: "next morning" },
            ],
          },
        ],
      };
      return terminal;
    }

    if (message.startsWith("/sleep")) {
      const secs = parseSeconds(message, 10);
      return {
        type: "sleep",
        state: { ...this.state, status: "sleeping" },
        wakeAt: Date.now() + secs * 1000,
      };
    }

    if (message.startsWith("/context")) {
      // Synthetic `usage` for the sidebar bar. Optional arg: target
      // fill percent (default 60). Breakdown uses fixed-ish system + memory
      // caps, ~7% untracked overhead, remainder as messages; usage fields
      // are shaped so the title-row cost readout is non-zero (Opus 4 $/M).
      const arg = message.slice("/context".length).trim();
      const target = Math.max(1, Math.min(120, Number.parseInt(arg, 10) || 60));
      const cap = 200_000;
      const total = Math.round((target / 100) * cap);

      const systemPrompt = Math.min(total, 6_400);
      const localMemory = Math.min(Math.round(total * 0.06), Math.round(cap * 0.05));
      const globalMemory = Math.min(Math.round(total * 0.025), Math.round(cap * 0.03));
      const overhead = Math.round(total * 0.07);
      const messages = Math.max(0, total - systemPrompt - localMemory - globalMemory - overhead);

      const output = Math.round(total * 0.04);
      const cacheRead = Math.round(total * 0.7);
      const cacheWrite = Math.round(total * 0.05);
      const input = Math.max(0, total - cacheRead - cacheWrite);
      const cost = {
        input: (input / 1_000_000) * 15,
        output: (output / 1_000_000) * 75,
        cacheRead: (cacheRead / 1_000_000) * 1.5,
        cacheWrite: (cacheWrite / 1_000_000) * 18.75,
        total: 0,
      };
      cost.total = cost.input + cost.output + cost.cacheRead + cost.cacheWrite;

      const usage = { input, output, cacheRead, cacheWrite, totalTokens: total, cost };
      this.emitUsage({
        turnUsage: usage,
        usageByModel: [
          {
            model: "playground-model",
            transport: { provider: "openrouter", billing: "metered" },
            usage,
          },
        ],
        lastMessageUsage: usage,
        effectiveContextWindow: cap,
        contextWindowUsage: { systemPrompt, messages, localMemory, globalMemory },
      });
      return this.complete(`Emitted usage at ~${target}% of ${cap} tokens.`);
    }

    if (message.startsWith("/echo")) {
      // Streams the trailing text back verbatim. Deterministic and free of
      // incidental tokens (no timing strings or queue counts) so callers
      // can assert on an exact substring of the rendered transcript.
      const reply = message.slice("/echo".length).trim() || "echo";
      for (const chunk of reply.match(/.{1,8}/g) ?? []) {
        this.emit({ type: "step", step: { type: "text_delta", delta: chunk } });
        await this.sleep(10);
        if (this.interrupted) return this.interruptedTerminal();
      }
      this.emit({ type: "step", step: { type: "text", text: reply } });
      return this.complete(reply);
    }

    if (message.startsWith("/error")) {
      const detail = message.slice("/error".length).trim() || "synthetic failure";
      this.emit({ type: "system", level: "error", message: detail });
      return {
        type: "complete",
        status: "failed",
        error: detail,
        state: { ...this.state, status: "failed" },
      };
    }

    // Default: stream a short reply.
    const reply = `playground reply for: ${message}`;
    for (const chunk of reply.match(/.{1,12}/g) ?? []) {
      this.emit({ type: "step", step: { type: "text_delta", delta: chunk } });
      await this.sleep(120);
      if (this.interrupted) return this.interruptedTerminal();
    }
    this.emit({ type: "step", step: { type: "text", text: reply } });
    return this.complete(reply);
  }

  /**
   * Walks through the per-tool formatters with intentionally chunky inputs
   * and outputs so the per-tool result clamp (`assembleToolBlock`) can be eyeballed
   * without standing up a real model. Each call runs briefly with a spinner
   * before completing so live-finalize logic also exercises.
   */
  private async runToolsDemo(): Promise<TurnTerminalEvent | undefined> {
    const longJson = `interface AgentMessage { role: "user" | "assistant" | "tool"; content: ContentBlock[]; metadata: { traceId: string; createdAt: number; tags: string[]; }; }`;
    const grepHits = Array.from(
      { length: 42 },
      (_, i) =>
        `src/tui/app.ts:${100 + i}: const handler${i} = (event: TurnEvent) => sidebar.refresh();`,
    ).join("\n");
    const bashOutput = Array.from(
      { length: 18 },
      (_, i) =>
        `[2026-05-09T17:${String(i).padStart(2, "0")}:00] worker-${i}: built target ${i} in ${(Math.random() * 4 + 1).toFixed(2)}s with cache hit ratio 0.${(Math.random() * 100) | 0}`,
    ).join("\n");

    const fixtures: Array<{
      toolName: string;
      input: Record<string, unknown>;
      output?: string;
      isError?: boolean;
    }> = [
      {
        toolName: "bash",
        input: { command: "rg --json 'AgentMessage' node_modules/@earendil-works/" },
        output: bashOutput,
      },
      {
        toolName: "bash",
        input: {
          command: "set -euo pipefail\nfor i in $(seq 1 5); do echo run $i; done\necho done",
          timeout: 600,
        },
        output: "run 1\nrun 2\nrun 3\nrun 4\nrun 5\ndone",
      },
      {
        toolName: "read",
        input: { path: "src/tui/app.ts", offset: 100, limit: 40 },
        output: longJson,
      },
      {
        toolName: "grep",
        input: { pattern: "TurnEvent", path: "src/", glob: "*.ts", ignoreCase: true },
        output: grepHits,
      },
      {
        toolName: "edit",
        input: {
          path: "src/tui/sidebar.ts",
          edits: [
            { old: "width: 36", new: "width: SIDEBAR_WIDTH" },
            { old: "fixedHeight: 5", new: "fixedHeight: 6" },
            { old: "(waiting for usage)", new: "(no usage yet)" },
          ],
        },
        output: "applied 3 edits",
      },
      {
        toolName: "todo_write",
        input: {
          merge: false,
          todos: [
            { id: "1", content: "Audit tool block clamping", status: "completed" },
            { id: "2", content: "Wrap then clamp visual rows", status: "in_progress" },
            { id: "3", content: "Update playground with verbose fixtures", status: "pending" },
            { id: "4", content: "Add session cost in sidebar", status: "completed" },
          ],
        },
      },
      {
        toolName: "ls",
        input: { path: "src/tui" },
        output: ["app.ts", "history.ts", "paste.ts", "sidebar.ts", "theme.ts", "tool-formatters.ts"]
          .map((name) => `- ${name}`)
          .join("\n"),
      },
      {
        toolName: "find",
        input: { pattern: "*.eval.ts", path: "evals/" },
        output: [
          "evals/observer-priority.eval.ts",
          "evals/state-machine.eval.ts",
          "evals/memory-recall.eval.ts",
        ].join("\n"),
      },
      {
        toolName: "write",
        input: {
          path: "src/tui/scratch.ts",
          content: `// auto-generated scratchpad\nexport const HELLO = "world";\n`,
        },
        output: "wrote 56 bytes",
      },
      {
        toolName: "read",
        input: { path: "/home/relay-pi/.relay-pi/skills/release/SKILL.md" },
        output:
          "# Release\n\nUse this workflow to publish a new version through the GitHub release workflow.",
      },
      {
        toolName: "ask_user_question",
        input: {
          questions: [
            {
              question: "Pick a deployment target",
              header: "Deploy",
              options: [
                { label: "staging" },
                { label: "production", description: "requires approval" },
              ],
            },
          ],
        },
        // 实时格式化器会隐藏 ask_user_question（运行器会为选择器发出 `ask`
        // terminal 事件）。这里主要用于记录这条路径；演示会直接跳过，不写入 transcript。
      },
      {
        toolName: "create_state_machine_definition",
        input: {
          definition: {
            name: "release-pipeline",
            prompt: "Cut a release once verify passes and CI is green.",
            states: [
              {
                name: "verify",
                kind: "agent",
                when: "start of the release",
                prompt: "Run pre-publish checks: typecheck, lint, and the docker test suite.",
              },
              {
                name: "prebuild",
                kind: "script",
                when: "after verify",
                command: "bun run build && bun run check-types",
              },
              {
                name: "wait-for-ci",
                kind: "poll",
                intervalMs: 15 * 60_000,
                command: "gh run list --limit 1 --json status,conclusion",
              },
              {
                name: "cooldown",
                kind: "timer",
                wakeAt: Date.UTC(2026, 4, 13, 18, 30),
              },
              {
                name: "publish",
                kind: "agent",
                prompt: "Publish the package and push the tag once CI is green.",
              },
              {
                name: "done",
                kind: "terminal",
                status: "completed",
                reason: "release published",
              },
            ],
          },
          firstState: "verify",
        },
        // create_state_machine_definition 会回显完整定义；格式化器会将其抑制，
        // 因为 roster 正文已经包含相同数据。
        output: JSON.stringify({ type: "create_state_machine_definition", ok: true }, null, 2),
      },
      {
        toolName: "select_state_machine_state",
        input: {
          decision: {
            state: "wait-for-ci",
            reason: "verify completed; CI workflow dispatched, polling for green checks",
            input: { runId: "12345" },
          },
        },
        output: JSON.stringify({ type: "select_state_machine_state", ok: true }, null, 2),
      },
      {
        toolName: "select_state_machine_state",
        input: {
          decision: {
            state: "done",
            reason: "all states completed successfully",
          },
        },
        output: JSON.stringify({ type: "select_state_machine_state", ok: true }, null, 2),
      },
      {
        toolName: "get_current_state_machine_state",
        input: {},
        output: JSON.stringify(
          {
            currentState: "wait-for-ci",
            currentInput: { runId: "12345" },
            progress: { verify: 1, prebuild: 1, "wait-for-ci": 3 },
            historyCount: 7,
            history: [
              { type: "state_entered", state: "verify" },
              { type: "state_completed", state: "verify", status: "ok" },
              { type: "state_entered", state: "prebuild" },
              { type: "state_completed", state: "prebuild", status: "ok" },
              { type: "state_entered", state: "wait-for-ci" },
            ],
          },
          null,
          2,
        ),
      },
      {
        toolName: "mystery_tool",
        input: {
          deeplyNested: {
            config: {
              retries: 3,
              backoffMs: [100, 200, 400, 800, 1600],
              flags: { strict: true, dryRun: false },
            },
            payload: longJson,
          },
        },
        output: longJson,
      },
      {
        toolName: "bash",
        input: { command: "cargo test --workspace --no-fail-fast" },
        output:
          "error[E0277]: the trait bound is not satisfied\n  --> src/lib.rs:42:9\n   |\n42 |         do_thing();\n   |         ^^^^^^^^ the trait `Send` is not implemented for `Rc<T>`",
        isError: true,
      },
    ];

    // 推理块：流式发送 6 个增量，随后用完整文本结束，这样能看到推理内容
    // 的 3 行上限（标签 + 最多 2 行正文）。
    const reasoningLines = [
      "Considering whether to clamp the reasoning body to 3 visual lines.",
      "The streaming path needs the same cap as the finalized path.",
      "Memory observation bodies should drop the observation text entirely.",
      "Only the completion message belongs under [memory:observation].",
      "Bumps stay surfaced through the message, not through extra content.",
      "This last line should fall into the '+N more lines' tail.",
    ];
    for (const line of reasoningLines) {
      this.emit({ type: "step", step: { type: "reasoning_delta", delta: `${line}\n` } });
      await this.sleep(120);
      if (this.interrupted) return undefined;
    }
    this.emit({ type: "step", step: { type: "reasoning", text: reasoningLines.join("\n") } });
    await this.sleep(200);

    // 观察式记忆完成：载荷包含 observations 和 usage-bumped 列表，
    // 以便渲染正文覆盖仅消息路径（观察文本会有意从 transcript 中省略）。
    this.emit({
      type: "memory",
      phase: "observation",
      status: "running",
      message: "Observing conversation into memory…",
    });
    await this.sleep(400);
    if (this.interrupted) return undefined;
    const now = Date.now();
    const fakeObservation = (id: string, content: string, ageMs: number): Observation => ({
      id,
      createdAt: now - ageMs,
      lastUsedAt: now - ageMs,
      kind: "observation",
      observedDate: new Date(now - ageMs).toISOString().slice(0, 10),
      priority: "medium",
      source: { kind: "agent" },
      content,
      tags: [],
    });
    this.emit({
      type: "memory",
      phase: "observation",
      status: "completed",
      message: "Memory observation recorded. Reinforced 3 prior memories.",
      observations: [
        fakeObservation(
          "obs_demo_1",
          "User wants the TUI reasoning block capped at 3 lines and memory observation blocks to show only the completion message.",
          0,
        ),
      ],
      usageBumpedObservations: [
        fakeObservation("obs_prior_1", "prior memory 1", 60_000),
        fakeObservation("obs_prior_2", "prior memory 2", 120_000),
        fakeObservation("obs_prior_3", "prior memory 3", 180_000),
      ],
    });
    await this.sleep(200);

    for (const [index, fixture] of fixtures.entries()) {
      const toolCallId = `demo_${index}`;
      this.emit({
        type: "step",
        step: {
          type: "tool_call_start",
          toolName: fixture.toolName,
          toolCallId,
          input: fixture.input,
        },
      });
      await this.sleep(400);
      if (this.interrupted) return undefined;
      this.emit({
        type: "step",
        step: {
          type: "tool_call",
          toolName: fixture.toolName,
          toolCallId,
          isError: fixture.isError ?? false,
          input: fixture.input,
          ...(fixture.output ? { output: [{ type: "text", text: fixture.output }] } : {}),
        },
      });
      await this.sleep(120);
      if (this.interrupted) return undefined;
    }

    // 用 `ask` terminal 收尾演示，这样问题 UI 也会被演示，
    // 即使 ask_user_question 在实时运行中会隐藏自身（运行器通过该 terminal 事件负责选择器）。
    return {
      type: "ask",
      state: { ...this.state, status: "waiting_for_human" },
      questions: [
        {
          question: "Pick a deployment target",
          header: "Deploy",
          options: [
            { label: "staging" },
            { label: "production", description: "requires approval" },
          ],
        },
      ],
    };
  }

  /**
   * 将包含三个条目的后续队列逐步清空，中间暂停，让用户观察完整生命周期：
   *
   *   1. 初次发出事件时，compose bar 上方的面板会填入三个提示词；transcript 还为空。
   *   2. 后续每次发出事件都会移除队首条目——session 订阅会比较队列，
   *      将已交付提示词作为真实 `you:` 块重放到 transcript，同时缩小面板。
   *   3. 最后一次空队列事件会清空末尾条目、隐藏面板，并在 transcript 中留下三个 `you:` 块。
   */
  private async runFollowUpDemo(): Promise<TurnTerminalEvent> {
    const prompts = [
      { message: "draft the email" },
      { message: "share a screenshot" },
      { message: "check the analytics" },
    ];
    this.emit({ type: "follow_up_queue", followUpQueue: prompts });
    await this.sleep(1200);
    if (this.interrupted) return this.interruptedTerminal();
    this.emit({ type: "follow_up_queue", followUpQueue: prompts.slice(1) });
    await this.sleep(1200);
    if (this.interrupted) return this.interruptedTerminal();
    this.emit({ type: "follow_up_queue", followUpQueue: prompts.slice(2) });
    await this.sleep(1200);
    if (this.interrupted) return this.interruptedTerminal();
    this.emit({ type: "follow_up_queue", followUpQueue: [] });
    return this.complete("Follow-up queue drained.");
  }

  /**
   * 引导用户观察黏性的“最新用户消息”横幅：只有最近的 `you:` 块滚出视口后，
   * 横幅才会出现在 transcript 上方。该场景会流式输出较长的 Agent 回复，
   * 让用户的 `/banner-demo` 块明显滚出顶部；这正是横幅出现的条件，旁白也会
   * 提示其他触发方式。
   */
  private async runBannerDemo(): Promise<TurnTerminalEvent> {
    const lines = [
      "The bordered row at the top of the screen pins your latest message,",
      "but only when that message is no longer visible in the transcript.",
      "",
      "Watch what happens as this reply streams: once `you: /banner-demo`",
      "scrolls past the top edge of the transcript, the banner appears.",
      "Scroll the transcript back down with the mouse wheel or PageDown",
      "until the original `you:` block is on screen and the banner hides",
      "itself again.",
      "",
      "Other ways to exercise it:",
      "  1. Send a short prompt - the banner stays hidden because the",
      "     block is still visible right above the input.",
      "  2. Send a multi-line paste (Shift+Enter to add newlines) - the",
      "     banner body clamps to 3 lines with an ellipsis when it shows.",
      "  3. Run /working 8 and scroll up while the agent streams - the",
      "     banner pops in as soon as your prompt scrolls off the top.",
      "  4. Run /ask, accept with a typed flush message - the flush is",
      "     recorded as a `you:` block that the banner tracks.",
      "",
      "(Padding follows so this reply is tall enough to push the original",
      "`you: /banner-demo` block off the top of the transcript on most",
      "terminal sizes; resize smaller if it's still visible.)",
      ...Array.from(
        { length: 20 },
        (_, i) =>
          `  line ${String(i + 1).padStart(2, " ")} of padding to force the prompt off screen.`,
      ),
    ];
    const summary = lines.join("\n");
    for (const chunk of summary.match(/.{1,40}/g) ?? []) {
      this.emit({ type: "step", step: { type: "text_delta", delta: chunk } });
      await this.sleep(30);
      if (this.interrupted) return this.interruptedTerminal();
    }
    this.emit({ type: "step", step: { type: "text", text: summary } });
    return this.complete(summary);
  }

  private async runMemoryPhase(
    phase: "observation" | "reflection",
    seconds: number,
  ): Promise<TurnTerminalEvent> {
    this.emit({
      type: "memory",
      phase,
      status: "running",
      message:
        phase === "observation"
          ? "Observing conversation into memory…"
          : "Reflecting on observations…",
    });
    await this.sleep(seconds * 1000);
    if (this.interrupted) return this.interruptedTerminal();
    this.emit({
      type: "memory",
      phase,
      status: "completed",
      message: `${phase} complete`,
    });
    return this.complete(`${phase} finished after ${seconds}s.`);
  }

  private complete(result: string): TurnTerminalEvent {
    return {
      type: "complete",
      status: "completed",
      result,
      state: { ...this.state, status: "completed" },
    };
  }

  private interruptedTerminal(): TurnTerminalEvent {
    return {
      type: "interrupted",
      state: {
        ...this.state,
        status: "interrupted",
        agent: { ...this.state.agent, status: "cancelled" },
      },
    };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const handle = setTimeout(() => {
        this.currentTurn = undefined;
        resolve();
      }, ms);
      this.currentTurn = {
        cancelled: false,
        resolve: () => {
          clearTimeout(handle);
          this.currentTurn = undefined;
          resolve();
        },
      };
    });
  }
}

function parseSeconds(message: string, fallback: number): number {
  const match = message.match(/(\d+)/);
  if (!match) return fallback;
  const value = Number.parseInt(match[1] ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

async function main(): Promise<void> {
  const initialPrompt = process.argv[2];
  const sessionPath = await mkdtemp(join(tmpdir(), "relay-pi-tui-playground-"));
  const runner = new FakePlaygroundRunner();
  const session = new Session(
    { model: "playground", cwd: process.cwd() },
    { id: "playground", sessionPath, runner, resumeFromStorage: false },
  );

  await runTui({
    session,
    workDir: process.cwd(),
    sessionId: "playground",
    packageName: "relay-pi",
    packageVersion: "playground",
    modelName: "playground",
    memoryModelName: "playground",
    ...(initialPrompt ? { initialPrompt } : {}),
  });

  await session.dispose();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
