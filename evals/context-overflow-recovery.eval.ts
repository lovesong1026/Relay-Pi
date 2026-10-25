import { describe, expect } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { TurnRunner } from "../src/turn-runner/turn-runner.js";
import { applyEvictionHorizon } from "../src/turn-runner/wire-shaping.js";
import type { TurnEvent } from "../src/types/protocol.js";
import { createAssistantMessage } from "../test/helpers/messages.js";
import { testIfDocker } from "../test/helpers/docker-only.js";

const model = process.env.EVAL_MODEL ?? "haiku-4.5";

/**
 * 针对 runner 在 `runAgentWorker` 中 provider-overflow recovery 分支的 live test。生产环境中，wire-shaping 会在基于字节的估算触发时预先 eviction，因此只有本地估算低估了真实 provider tokenizer（大量 tool/thinking block、结构化 payload 等）时才会走 provider rejection 路径。为确定性地执行同一代码路径，该 eval 将 memory transform 替换为只应用 sticky horizon 的版本——不触发预先 trim——因此第一次尝试会派发完整的 seeded history，第二次尝试会看到 recovery 分支生成的减半列表。
 *
 * 其他部分（model、gateway、`isContextOverflow` detection、`agent.continue()`、system event emission）都实时运行，因此其中任何 layer 回归都会在这里暴露。
 */
class ProviderOverflowEvalRunner extends TurnRunner {
  getEvictionHorizon(): number {
    return this.wireGuardHorizon.evictionHorizon;
  }

  protected override createMemoryTransform() {
    return async (messages: AgentMessage[]) =>
      applyEvictionHorizon(messages, this.wireGuardHorizon.evictionHorizon);
  }
}

describe("provider context-overflow recovery", () => {
  testIfDocker(
    "halves history and retries after the provider rejects an oversized prompt",
    async () => {
      const runner = new ProviderOverflowEvalRunner({
        model,
        mode: "agent",
        skillDiscovery: { includeDefaults: false },
      });

      // 为 parent agent 的 transcript seed 足够多的 prior turn，使第一次发送超过 model 的硬 context window。将 `state` 传给 `start` 是协议层面的 resume 方式，因此 live agent transcript 会直接从我们构造的大小开始，不需要单独的 ingest 步骤。
      await runner.start({
        type: "start",
        state: {
          status: "running",
          mode: "agent",
          agent: { status: "running", messages: buildOversizedHistory() },
        },
      });
      const events: TurnEvent[] = [];
      runner.subscribe((event) => events.push(event));

      const terminal = await runner.turn({
        type: "prompt",
        message: "Reply with exactly one word: recovered.",
        behavior: "follow_up",
      });

      expect(terminal.type).toBe("complete");
      if (terminal.type !== "complete") throw new Error("expected complete terminal");
      expect(terminal.status).toBe("completed");
      expect(terminal.result?.toLowerCase()).toContain("recovered");

      // recovery 分支将 sticky horizon 推进到至少一个可观察 message 之后——正是这一点让 retry 能够适配。
      expect(runner.getEvictionHorizon()).toBeGreaterThan(0);

      const recoveryNotices = events.filter(
        (event): event is Extract<TurnEvent, { type: "system" }> =>
          event.type === "system" && event.message.startsWith("Context overflow"),
      );
      expect(recoveryNotices).toHaveLength(1);
      expect(recoveryNotices[0]!.level).toBe("info");
      expect(recoveryNotices[0]!.message).toMatch(/dropped \d+ older message/);
    },
    180_000,
  );
});

/**
 * 构造一个 synthetic prior-turn transcript，其总 wire size 能稳定地让第一次发送超过 200k-token context window。重复的 "lorem ipsum" 很容易被 tokenizer 压缩，因此将原始字节扩大到远超朴素 chars/token 估算，以确保 provider 确实拒绝第一次尝试——该拒绝正是要测试的 recovery 分支触发条件。recovery 分支将 sticky horizon 推过较旧的一半后，剩余 transcript 应能适配。
 */
function buildOversizedHistory(): AgentMessage[] {
  // 每条 message 约 14 KB * 100 条 = 原始文本约 1.4 MB。大小经过设计，使完整 transcript 超过 haiku-4.5 的 window，而 recovery 分支生成的减半 transcript 可以适配。
  const filler = "lorem ipsum dolor sit amet consectetur adipiscing elit ".repeat(250);
  const messages: AgentMessage[] = [];
  for (let pair = 0; pair < 50; pair++) {
    const userTimestamp = pair * 2 + 1;
    const assistantTimestamp = pair * 2 + 2;
    messages.push({
      role: "user",
      content: [{ type: "text", text: `Turn ${pair} user notes: ${filler}` }],
      timestamp: userTimestamp,
    });
    messages.push(
      createAssistantMessage({
        text: `Turn ${pair} assistant notes: ${filler}`,
        timestamp: assistantTimestamp,
      }),
    );
  }
  return messages;
}
