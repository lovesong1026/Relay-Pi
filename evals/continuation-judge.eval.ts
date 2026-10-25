import { describe, expect } from "bun:test";
import { testIfDocker } from "../test/helpers/docker-only.js";
import { judgeContinuesRecentWork } from "./helpers/continuation-judge.js";

/**
 * 针对 `judgeContinuesRecentWork` 的 judge-the-judge eval。
 *
 * 在 `evals/session-compaction-continues-recent-work.eval.ts` 使用该 judge 为真实 model run 评分之前，这里先用人工构造的正、负 reply 测试它，且正确 verdict 对人类读者显而易见。如果 judge 开始通过字面上的冷问候 reply，或拒绝明显有实质内容的 continuation，该 eval 会在 live eval 因 wire-starvation 回归而误通过之前捕获问题。
 */

const RECENT_WORK = `
The user asked about missing OpenAI "thinking traces" from \`sol\`.
Investigation showed \`resolveModelName("sol")\` was routing
Relay Pi/OpenAI models through \`vercel-ai-gateway\` with
\`api: "anthropic-messages"\`, which would drop OpenAI reasoning
events. A red eval was added at \`evals/openai-thinking-traces.eval.ts\`
to reproduce. The fix in \`src/model-resolution/openrouter.ts\`
overrides Relay Pi-hosted OpenAI-prefixed models to the OpenAI-compatible
API path while leaving Anthropic models on the Anthropic path. The
recent tool calls were grepping through \`apiProviderRegistry\` and
nearby pi-ai provider wiring to confirm the OpenAI-Responses path
emits reasoning blocks.
`.trim();

// 失败 session 中的原样 reply，该 judge 必须拒绝它。如果我们把 judge 放宽到能通过这条 reply，就说明发生了回归。
const COLD_GREETING_REPLY = "I'm here — what would you like to work on next?";

const GENERIC_OFFER_REPLY = `
Happy to keep going! I can help with code, write tests, debug an
issue, or anything else you're working on. Where would you like to
start?
`.trim();

const SUBSTANTIVE_CONTINUATION_REPLY = `
The grep through \`apiProviderRegistry\` in
\`node_modules/@earendil-works/pi-ai\` confirmed that the
\`openai-responses\` API path is the one that surfaces reasoning
deltas, so the override in \`src/model-resolution/openrouter.ts\`
should resolve the missing-thinking-traces symptom for \`sol\`.
Next step: re-run \`evals/openai-thinking-traces.eval.ts\` against
the openrouter provider and assert \`hasReasoningRequest(payload)\`
is true. Want me to also add a regression in \`test/cli.test.ts\`
pinning the resolved API to \`openai-responses\`?
`.trim();

// 只提到一个具体工作锚点、但其他内容都推脱的 reply。Judge 仍应将其标为无效——仅仅提到一个文件不够；reply 还必须提出步骤或发现。
const NAME_DROP_ONLY_REPLY = `
We were looking at \`src/model-resolution/openrouter.ts\`. What
would you like me to do?
`.trim();

describe("judgeContinuesRecentWork judge-the-judge", () => {
  testIfDocker(
    "rejects the verbatim cold greeting from the failing session",
    async () => {
      const result = await judgeContinuesRecentWork({
        reply: COLD_GREETING_REPLY,
        recentWork: RECENT_WORK,
      });
      expect(result.valid, result.reason).toBe(false);
    },
    120_000,
  );

  testIfDocker(
    "rejects a generic 'happy to help' offer that lists capabilities",
    async () => {
      const result = await judgeContinuesRecentWork({
        reply: GENERIC_OFFER_REPLY,
        recentWork: RECENT_WORK,
      });
      expect(result.valid, result.reason).toBe(false);
    },
    120_000,
  );

  testIfDocker(
    "rejects a name-drop with no finding or proposed next step",
    async () => {
      const result = await judgeContinuesRecentWork({
        reply: NAME_DROP_ONLY_REPLY,
        recentWork: RECENT_WORK,
      });
      expect(result.valid, result.reason).toBe(false);
    },
    120_000,
  );

  testIfDocker(
    "passes a reply that names a concrete anchor and proposes a next step grounded in it",
    async () => {
      const result = await judgeContinuesRecentWork({
        reply: SUBSTANTIVE_CONTINUATION_REPLY,
        recentWork: RECENT_WORK,
      });
      expect(result.valid, result.reason).toBe(true);
    },
    120_000,
  );
});
