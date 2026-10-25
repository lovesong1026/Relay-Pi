import { describe, expect } from "bun:test";
import dedent from "dedent";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { TurnRunner } from "../src/turn-runner/turn-runner.js";
import type { TurnEvent, TurnState } from "../src/types/protocol.js";
import type { StateMachineDefinition, StateMachineState } from "../src/types/state-machine.js";
import { startTurn } from "../test/helpers/turn-runner-protocol.js";
import { testIfDocker } from "../test/helpers/docker-only.js";

const model = process.env.EVAL_MODEL ?? "sonnet-5";

/** Requirement tokens。随机性足够强，verdict 指出其中一个不可能只是碰巧。 */
const ALPHA = "STATUS: ALPHA-7Q2";
const BETA = "STATUS: BETA-4X8";
const GAMMA = "STATUS: GAMMA-9Z1";

/**
 * 针对内置 `/goal` skill 的 live 端到端覆盖。`test/built-in-skills.test.ts` 中的 unit test 证明 skill body 会被发现并注入；本 eval 证明该 body 确实会产生它所描述的 loop——一个 work state、一个根据现实判断 goal 的 evaluator sub-agent、至少一个把 machine 送回 work 的 incomplete round，以及只有 evaluator 通过后才出现的 terminal。
 *
 * 严密设计：harness 完全不向 model 下指令，却强制产生恰好一个 incomplete round。goal 是一个三行的 `report.md`，第一个 state agent 启动的瞬间，harness 就删除 parent 刚写入的 GAMMA 行。parent 以为 goal 已满足，且被禁止告诉 sub-agent 自己做了什么，因此第一次 verdict 指出 GAMMA 只能来自检查过文件而非相信 worker 的 judge——无需依赖 model 遵从指令即可复现。内联完成工作的 run（没有 skill body）不会调用 `create_state_machine_definition`；“evaluator”相信 parent 的 run 不会产生 incomplete→complete 翻转；park 阻塞 turn 的 run 不会得到第二次 evaluation。
 *
 * system instructions 刻意不提 state machines、evaluators 或 rounds——所有这些结构都必须来自 skill body，这正是反证（从 BUILT_IN_SKILLS 中删除 `goal`）会变红的原因。
 */
describe("/goal loop", () => {
  testIfDocker(
    "builds a work/evaluate state machine that loops on an incomplete verdict and terminates on a pass",
    async () => {
      const workDir = await mkdtemp(join(tmpdir(), "goal-eval-"));
      const report = join(workDir, "report.md");
      const diagnosticEvents: TurnEvent[] = [];
      try {
        await writeFile(
          join(workDir, "requirements.md"),
          dedent`
            # Requirements for report.md

            report.md must contain each of these lines, one per line:

            - ${ALPHA}
            - ${BETA}
            - ${GAMMA}
          `,
        );
        await writeFile(report, "");

        const runner = new TurnRunner({
          model,
          mode: "auto",
          cwd: workDir,
          // `includeDefaults: false` skips user/project skill discovery; the
          // built-in `/goal` skill is still merged in by
          // `loadDiscoveredSkills` so the slash token resolves.
          skillDiscovery: { includeDefaults: false },
          systemInstructions: dedent`
            This is a live eval in a sandboxed temp directory. Nothing here is
            production and every file is disposable.

            The user is not present: never ask a question, and drive this to a
            terminal outcome within this turn.

            Never tell a sub-agent what you did, skipped, or plan to do next. A
            sub-agent may receive the goal and its criteria, nothing more.
          `,
        });

        const parentToolCalls: Array<{ name: string; input: any }> = [];
        const subAgentToolCalls: Array<{ name: string; input: any }> = [];
        let clobbered = false;
        let stateStarting = false;
        // The bait: once the first state agent starts, drop GAMMA back out of
        // report.md. The parent wrote that line and has no way to know it
        // vanished, so a first verdict naming GAMMA can only come from a judge
        // that inspected the file instead of trusting the worker.
        const dropGamma = () => {
          const current = readFileSync(report, "utf8");
          if (!current.includes("GAMMA-9Z1")) return;
          writeFileSync(
            report,
            current
              .split("\n")
              .filter((line) => !line.includes("GAMMA-9Z1"))
              .join("\n"),
          );
          clobbered = true;
        };
        runner.subscribe((event: TurnEvent) => {
          // Retain complete relay snapshots and tool results, not streaming deltas.
          if (
            event.type === "state_machine" ||
            event.type === "usage" ||
            event.type === "router_switch" ||
            event.type === "complete" ||
            event.type === "ask" ||
            event.type === "sleep" ||
            event.type === "interrupted" ||
            (event.type === "step" && event.step.type === "tool_call")
          )
            diagnosticEvents.push(event);
          if (
            event.type === "task_started" &&
            !clobbered &&
            event.task.label.startsWith("Run state ")
          ) {
            stateStarting = true;
            dropGamma();
            return;
          }
          if (event.type !== "step") return;
          // Re-apply right before the sub-agent's first tool call. A parent that
          // batches its write with the transition lands the file *after* the
          // state starts, which would otherwise hand the judge a complete file
          // and silently turn this into a one-round run.
          if (event.origin && stateStarting && event.step.type === "tool_call_start") {
            stateStarting = false;
            dropGamma();
          }
          const step = event.step;
          if (step.type !== "tool_call_start") return;
          const call = { name: step.toolName, input: step.input };
          if (event.origin) subAgentToolCalls.push(call);
          else parentToolCalls.push(call);
        });

        const { turn } = await startTurn(runner, {
          mode: "auto",
          prompt: "/goal make report.md satisfy every requirement in requirements.md",
        });
        const terminal = await turn;

        // 1. The skill routed the prompt into a state machine at all.
        const creates = parentToolCalls.filter(
          (call) => call.name === "create_state_machine_definition",
        );
        expect(creates.length).toBeGreaterThanOrEqual(1);
        const definition = creates[0]?.input?.definition as StateMachineDefinition | undefined;
        expect(definition).toBeTruthy();
        const states = definition?.states ?? [];
        // 2. Shape: something that evaluates (a sub-agent) plus a completed terminal.
        expect(states.some((state: StateMachineState) => state.kind === "agent")).toBe(true);
        expect(
          states.some(
            (state: StateMachineState) => state.kind === "terminal" && state.status === "completed",
          ),
        ).toBe(true);

        // 3. The evaluator looped: the same agent state ran at least twice,
        //    which only happens when a verdict sent the machine back to work.
        const runs = agentStateRuns(terminal.state);
        const byState = new Map<string, string[]>();
        for (const run of runs) {
          byState.set(run.state, [...(byState.get(run.state) ?? []), run.output]);
        }
        const evaluator = [...byState.entries()].find(([, outputs]) => outputs.length >= 2);
        expect(
          evaluator,
          `Expected one agent state to run at least twice; runs were ${JSON.stringify(
            runs.map((run) => run.state),
          )}`,
        ).toBeTruthy();
        const verdicts = evaluator?.[1] ?? [];

        // 3b. The work really was parent-owned: the machine entered a park and
        //     the parent worked from there. The bait depends on this shape —
        //     it clobbers the file the parent wrote — so a run that delegated
        //     work to a sub-agent instead is not the scenario under test.
        const progress = (terminal.state.stateMachine?.progress?.states ?? {}) as Record<
          string,
          { kind?: string; runs: number }
        >;
        const parkRuns = Object.entries(progress).filter(([, entry]) => entry.kind === "park");
        expect(
          parkRuns.some(([, entry]) => entry.runs >= 1),
          `Expected the machine to enter a park state; progress was ${JSON.stringify(progress)}`,
        ).toBe(true);

        // 4. The first verdict caught the clobbered line — a gap the parent
        //    believed it had already written and never disclosed.
        expect(clobbered).toBe(true);
        const first = verdicts[0] ?? "";
        expect(first.toLowerCase()).toContain("incomplete");
        expect(first).toContain("GAMMA-9Z1");

        // 5. The last verdict passed, and it did so without the word incomplete.
        const last = verdicts[verdicts.length - 1] ?? "";
        expect(last.toLowerCase()).toContain("complete");
        expect(last.toLowerCase()).not.toContain("incomplete");

        // 6. That first verdict came from inspecting reality, not from the
        //    parent's account: a sub-agent read report.md itself.
        const inspected = subAgentToolCalls.filter(
          (call) =>
            (call.name === "read" || call.name === "bash") &&
            JSON.stringify(call.input ?? {}).includes("report.md"),
        );
        expect(
          inspected.length,
          `Expected a sub-agent to inspect report.md; sub-agent calls were ${JSON.stringify(
            subAgentToolCalls.map((call) => call.name),
          )}`,
        ).toBeGreaterThanOrEqual(1);

        // 7. The machine ended at a completed terminal, and the goal is really met.
        expect(terminal.type).toBe("complete");
        expect(terminal.state.stateMachine?.terminal?.status).toBe("completed");
        const finalReport = await readFile(report, "utf8");
        for (const requirement of [ALPHA, BETA, GAMMA]) {
          expect(finalReport).toContain(requirement);
        }
      } catch (error) {
        const artifactDirectory = resolve(process.env.EVAL_ARTIFACT_DIR ?? "tmp/eval-artifacts");
        const artifactPath = join(artifactDirectory, `goal-command-failure-${randomUUID()}.json`);
        await mkdir(artifactDirectory, { recursive: true });
        await writeFile(
          artifactPath,
          JSON.stringify(
            {
              model,
              candidateRevision: process.env.EVAL_CANDIDATE_REVISION ?? null,
              error: error instanceof Error ? (error.stack ?? error.message) : String(error),
              events: diagnosticEvents,
            },
            null,
            2,
          ),
          { flag: "wx" },
        );
        console.error(`Goal failure diagnostics: ${artifactPath}`);
        throw error;
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
    },
    420_000,
  );
});

/** Every completed agent-state run, oldest first, with its output text. */
function agentStateRuns(state: TurnState): Array<{ state: string; output: string }> {
  const definition = state.stateMachine?.definition;
  const agentStates = new Set(
    (definition?.states ?? [])
      .filter((entry: StateMachineState) => entry.kind === "agent")
      .map((entry: StateMachineState) => entry.name),
  );
  const runs: Array<{ state: string; output: string }> = [];
  for (const event of state.stateMachine?.history ?? []) {
    if (event.type !== "state_completed" || !agentStates.has(event.state)) continue;
    const output = event.output;
    const text =
      output &&
      typeof output === "object" &&
      "result" in output &&
      typeof output.result === "string"
        ? output.result
        : output === undefined
          ? ""
          : JSON.stringify(output);
    runs.push({ state: event.state, output: text });
  }
  return runs;
}
