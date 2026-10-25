import { withRequestId } from "./helpers/rpc-command.js";
import { describe, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import type { TurnEvent, TurnRunnerCommand, TurnTerminalEvent } from "../src/types/protocol.js";
import { testIfDocker } from "../test/helpers/docker-only.js";

const model = process.env.EVAL_MODEL ?? "sonnet-5";

/**
 * Compact 是用户发起的 wire-shaping 命令。unit suite 会隔离覆盖 runner 机制；本 eval 固定端到端 RPC contract：`{type: "compact"}` 抵达一个实时 `relay-pi --rpc` 进程，runner 推进其 sticky horizon，terminal state 携带新的 `wireGuardHorizon` 对象，下游进程可以从该 state 恢复而不丢失 trim。
 *
 * `driveRpcLoop` 会在其单个 chain 的 terminal 后退出进程，因此“两次 turn 之间 compact”建模为：进程 A 运行一个 turn 并结束，进程 B 以 A 的 state 启动，在 runner 已 hydrated 但 idle（尚未收到任何 prompt）时派发 `compact`，然后运行下一个 turn。runner 允许在 loop 内的任意时点接收带外命令，包括第一个驱动 turn 的命令之前。
 */
describe("compact RPC command", () => {
  testIfDocker(
    "advances the wire-shaping horizon and round-trips through resume",
    async () => {
      const workDir = await mkdtemp(join(tmpdir(), "relay-pi-compact-"));
      try {
        // 进程 1：构建包含两个 turn 的 transcript，使 compact 有超出 MIN_HISTORY_TAIL 的内容可以驱逐。两个 prompt 都在 chain 的 terminal 之前到达，因此 runner 会把它们排入同一个 chain，并发出携带完整 history 的一个 terminal。
        const built = await runRpcSession(
          ["--workdir", workDir, "--incognito", "--model", model],
          [
            { type: "start" },
            {
              type: "prompt",
              message: "Reply with exactly: M1_OK_INTRO_MARKER",
              behavior: "follow_up",
            },
            {
              type: "prompt",
              message: "Reply with exactly: M2_OK",
              behavior: "follow_up",
            },
          ],
        );
        expect(built.exitCode).toBe(0);
        const builtTerminal = expectTerminal(built.events);
        expect(builtTerminal.type).toBe("complete");
        // 新 session 不得携带 wireGuardHorizon：auto-trigger 不会在这么小的 transcript 上触发，因此 snapshot pipeline 会省略该字段。这固定了“新 runner 默认保持 schema 干净”的 contract。
        expect(builtTerminal.state.wireGuardHorizon).toBeUndefined();

        // 进程 2：从进程 1 的 state 恢复，在 runner 已 hydrated 但 idle 时发送 compact，然后驱动一个 turn。compact 在 chain 启动前运行（loop 会在 start 与第一个 turn 命令之间内联处理带外命令），因此下一个 prompt 的 wire-tail 已反映新的 horizon。
        const compacted = await runRpcSession(
          ["--workdir", workDir, "--incognito", "--model", model],
          [
            { type: "start", state: builtTerminal.state },
            { type: "compact" },
            {
              type: "prompt",
              message: "Reply with exactly: M3_AFTER_COMPACT",
              behavior: "follow_up",
            },
          ],
        );
        expect(compacted.exitCode).toBe(0);
        // Compact 必须报告真实的 eviction，而不是 no-op。成功分支记录 "compact: dropped N older wire message(s)"；no-op 分支记录 "compact: nothing to evict"。这里出现 no-op 就意味着 wire-tail 无法在不违反 MIN_HISTORY_TAIL 的情况下减少任何 message，这会破坏“两次已完成 turn 留有 compact 空间”的假设。
        const compactSystem = compacted.events.find(
          (event): event is Extract<TurnEvent, { type: "system" }> => isCompactSystemEvent(event),
        );
        expect(compactSystem, "expected a compact system event").toBeDefined();
        expect(compactSystem!.message).toMatch(/^compact: dropped \d+ older wire message/);

        const compactedTerminal = expectTerminal(compacted.events);
        expect(compactedTerminal.type).toBe("complete");
        const compactedHorizon = compactedTerminal.state.wireGuardHorizon;
        expect(compactedHorizon, "post-compact terminal must carry wireGuardHorizon").toBeDefined();
        expect(compactedHorizon!.evictionHorizon).toBeGreaterThan(0);

        // Compact 还必须重新发布 context-bar payload，使侧边栏在下一个 prompt 到达前更新。runner 会在 horizon 推进后立刻发出 `usage` event，早于 M3 prompt 的 parent worker 启动。该 tick 必须携带一个严格小于进程 1 的 parent emission 的 `messages` segment；否则 TUI 会一直显示 compact 前的 slice，直到下一次 `message_end`。
        const lastBuiltUsage = lastParentUsageEvent(built.events);
        expect(
          lastBuiltUsage,
          "process 1 must have emitted at least one parent usage event",
        ).toBeDefined();
        const compactUsageIdx = compacted.events.findIndex(isCompactSystemEvent);
        expect(compactUsageIdx).toBeGreaterThanOrEqual(0);
        const postCompactUsage = compacted.events
          .slice(compactUsageIdx + 1)
          .find((event): event is Extract<TurnEvent, { type: "usage" }> => event.type === "usage");
        expect(
          postCompactUsage,
          "expected a usage event immediately after the compact system event",
        ).toBeDefined();
        expect(postCompactUsage).toBeDefined();
        expect(lastBuiltUsage).toBeDefined();
        if (!postCompactUsage || !lastBuiltUsage) {
          throw new Error("expected usage events around compact");
        }
        // 健全性检查：breakdown 会重新缩放到 totalTokens 之和，因此 bar 的分子和各 segment 宽度保持自洽。
        const sum =
          postCompactUsage.contextWindowUsage.systemPrompt +
          postCompactUsage.contextWindowUsage.messages +
          postCompactUsage.contextWindowUsage.localMemory +
          postCompactUsage.contextWindowUsage.globalMemory;
        expect(sum).toBe(postCompactUsage.lastMessageUsage.totalTokens);
        // bar 可见的行为：messages segment 相对于 compact 前最后一个 parent emission 变小。这是 `emitPostCompactUsage` 接入前会失败的断言。
        expect(postCompactUsage.contextWindowUsage.messages).toBeLessThan(
          lastBuiltUsage.contextWindowUsage.messages,
        );

        // 持久化 transcript 会保留：进程 1 的 M1 marker 在 compact 后仍位于 `state.agent.messages` 的某处。Compact 只做 wire-shaping，不修改 transcript。JSON.stringify 是最直接、且无需让 eval 了解每种 variant shape 就能适配 AgentMessage union 的工具。
        const transcriptJson = JSON.stringify(compactedTerminal.state.agent.messages);
        expect(transcriptJson).toContain("M1_OK_INTRO_MARKER");
        // Transcript 也必须跨进程增长。
        expect(compactedTerminal.state.agent.messages.length).toBeGreaterThan(
          builtTerminal.state.agent.messages.length,
        );

        // 进程 3：从 compact 后的 state 恢复并驱动另一个 turn。从 state.json hydrate 的 wireGuardHorizon 绝不能在这个新 runner 上回退为零；否则用户退出 TUI 前完成 compact 的 session 会在下一次启动时再次发送完整 wire-tail。
        const resumed = await runRpcSession(
          ["--workdir", workDir, "--incognito", "--model", model],
          [
            { type: "start", state: compactedTerminal.state },
            {
              type: "prompt",
              message: "Reply with exactly: M4_RESUMED",
              behavior: "follow_up",
            },
          ],
        );
        expect(resumed.exitCode).toBe(0);
        const resumedTerminal = expectTerminal(resumed.events);
        expect(resumedTerminal.type).toBe("complete");
        const resumedHorizon = resumedTerminal.state.wireGuardHorizon;
        expect(resumedHorizon, "resumed terminal must carry wireGuardHorizon").toBeDefined();
        // auto-trigger 或另一轮 compact 合法地再次推进 horizon；但它不得回退到低于从 state.json 带来的 compact 后数值。
        expect(resumedHorizon!.evictionHorizon).toBeGreaterThanOrEqual(
          compactedHorizon!.evictionHorizon,
        );
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
    },
    180_000,
  );
});

function isCompactSystemEvent(event: TurnEvent): event is Extract<TurnEvent, { type: "system" }> {
  return (
    event.type === "system" &&
    typeof event.message === "string" &&
    event.message.startsWith("compact:")
  );
}

/**
 * 在 `events` 中查找最近的 parent `usage` event。Parent tick 没有 `origin` 字段；state-agent tick 会设置 `origin.agentStateName`。当 transcript 还没有 parent emission 时返回 undefined。
 */
function lastParentUsageEvent(
  events: TurnEvent[],
): Extract<TurnEvent, { type: "usage" }> | undefined {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (event?.type === "usage" && event.origin === undefined) return event;
  }
  return undefined;
}

interface RpcSessionResult {
  exitCode: number;
  events: TurnEvent[];
}

/**
 * 使用 `args` 启动 `relay-pi --rpc`，将给定 commands 作为以换行分隔的 JSON 写入 stdin，收集 stdout events，并返回解析后的 transcript。runner 会把第一个 terminal 之前发送的 turn-driving commands 排入同一个 chain，因此多 prompt 设置会在一个进程退出时完成。
 */
async function runRpcSession(
  args: string[],
  commands: TurnRunnerCommand[],
): Promise<RpcSessionResult> {
  // --no-skill-sync 会跳过 relay-pi.so 默认 skill 的 fetch；当设置 RELAY_PI_API_KEY 时 CLI 通常会在启动时执行该 fetch；它与本 eval 的断言无关。
  const proc = Bun.spawn(["bun", "src/cli.ts", "--rpc", "--no-skill-sync", ...args], {
    cwd: process.cwd(),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  await writeCommandsToStdin(proc, commands);
  // 排空 stderr，避免缓冲区阻塞子进程；内容不会参与断言，但管道必须持续被读取。
  void new Response(proc.stderr).text();
  const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  const events = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as TurnEvent);
  return { exitCode, events };
}

async function writeCommandsToStdin(
  proc: Subprocess<"pipe", "pipe", "pipe">,
  commands: TurnRunnerCommand[],
): Promise<void> {
  const sink = proc.stdin;
  for (const command of commands) {
    sink.write(`${JSON.stringify(withRequestId(command))}\n`);
    await sink.flush();
  }
  await sink.end();
}

function expectTerminal(events: TurnEvent[]): TurnTerminalEvent {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (
      event?.type === "complete" ||
      event?.type === "ask" ||
      event?.type === "interrupted" ||
      event?.type === "sleep"
    ) {
      return event;
    }
  }
  throw new Error(`No terminal event in RPC output. Saw: ${events.map((e) => e.type).join(",")}`);
}
