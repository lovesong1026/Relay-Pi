import { describe, expect } from "bun:test";
import dedent from "dedent";
import { startTurn } from "../test/helpers/turn-runner-protocol.js";
import { TurnRunner } from "../src/turn-runner/turn-runner.js";
import type { TurnEvent } from "../src/types/protocol.js";
import { testIfDocker } from "../test/helpers/docker-only.js";

const model = process.env.EVAL_MODEL ?? "sonnet-5";

interface BashCall {
  command: string;
  timeout: number | undefined;
}

describe("bash task wait budget", () => {
  testIfDocker(
    "model uses timeout as a conversion budget rather than a kill deadline",
    async () => {
      const runner = new TurnRunner({
        model,
        mode: "agent",
        skillDiscovery: { includeDefaults: false },
      });

      const bashCalls: BashCall[] = [];
      const settlements: Array<{ id: string; status: string }> = [];
      runner.subscribe((event: TurnEvent) => {
        if (event.type === "task_settled") {
          settlements.push({ id: event.settlement.id, status: event.settlement.status });
          return;
        }
        if (event.type !== "step") return;
        const step = event.step;
        if (step.type !== "tool_call_start") return;
        if (step.toolName !== "bash") return;
        const input = step.input as { command?: string; timeout?: number } | undefined;
        bashCalls.push({
          command: input?.command ?? "",
          timeout: typeof input?.timeout === "number" ? input.timeout : undefined,
        });
      });

      // 反证记录（运行于 2026-07-19）：在
      // withoutBashKillTimeout 中恢复 5s 的内部终止会使已完成 settlement 的断言变红——
      // 8s 的 sleep 会在 5s 时终止并以 failed 状态 settlement。还原后恢复为绿色。
      const terminal = await (
        await startTurn(runner, {
          mode: "agent",
          prompt: dedent`
            Run this command for me: \`sleep 8 && echo build-finished\`.

            Give it a foreground wait budget of at most one second so it converts to a task instead of blocking. Do not stop it: wait for its settlement nudge, then confirm the build output.
          `,
        })
      ).turn;

      expect(terminal.type).toBe("complete");

      const longRunningCall = bashCalls.find((call) => call.command.includes("sleep"));
      expect(
        longRunningCall,
        `expected a bash call for the build; saw ${JSON.stringify(bashCalls)}`,
      ).toBeDefined();
      if (!longRunningCall) throw new Error("unreachable");

      expect(longRunningCall.timeout).toBeGreaterThan(0);
      expect(longRunningCall.timeout).toBeLessThanOrEqual(1);

      // The no-kill contract itself: the 8s process outlives any reinstated kill
      // deadline and settles completed, never failed/stopped.
      expect(settlements.length).toBeGreaterThan(0);
      expect(settlements.every((entry) => entry.status === "completed")).toBe(true);
    },
    120_000,
  );
});
