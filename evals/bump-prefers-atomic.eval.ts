import { describe, expect } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { rebuildMemoryContextPack } from "../src/memory/context-pack.js";
import {
  DEFAULT_EFFECTIVE_CONTEXT,
  resolveObservationalMemorySettings,
  updateObservationalMemory,
} from "../src/memory/observational.js";
import { DEFAULT_CLI_MEMORY_MODEL } from "../src/model-resolution/resolver.js";
import { ATOMIC_REFLECTIONS, SUMMARY_REFLECTION } from "./fixtures/bumping/blob-vs-atomic.js";
import { seedObservations } from "./fixtures/global-reflect/seed.js";
import { createAssistantMessage } from "../test/helpers/messages.js";
import { createMemoryFixture, type MemoryFixture } from "../test/helpers/memory-fixture.js";
import { testIfDocker } from "../test/helpers/docker-only.js";

/**
 * 面向实时 observer 的 usage-bumping 路径中选择部分的 live-observer eval：当 observer 引用一条 memory，而全局池同时包含覆盖同一事实的宽泛 summary reflection 和狭窄、unit-sized siblings 时，只有该 turn 实际依赖的 atomic rows 才应推进 `last_used_at`。
 *
 * Harness：full-observer（端到端驱动 `updateObservationalMemory`，使用实时 memory model）。`applyUsageBumps` 是私有的，而选择逻辑同时包含 observer 引用正确 id 以及只对这些 row 应用 bump，因此端到端路径是合适的测试层级，尽管它需要一次实时 model 调用。断言检查存储的 `last_used_at` 值，而不是提示词输出。
 */

const memoryModel = process.env.EVAL_MEMORY_MODEL ?? DEFAULT_CLI_MEMORY_MODEL;
const settings = resolveObservationalMemorySettings(DEFAULT_EFFECTIVE_CONTEXT);

async function readLastUsed(
  fixture: MemoryFixture,
): Promise<Map<string, { lastUsedAt: number; content: string }>> {
  const result = await fixture.session.withDb(async (db) =>
    db.query<{ id: string; last_used_at: number; content: string }>(
      "SELECT id, last_used_at, content FROM observations",
    ),
  );
  const out = new Map<string, { lastUsedAt: number; content: string }>();
  for (const row of result?.rows ?? []) {
    out.set(row.id, { lastUsedAt: row.last_used_at, content: row.content });
  }
  return out;
}

async function runObserverTurn(
  fixture: MemoryFixture,
  sessionId: string,
  userText: string,
  assistantText: string,
): Promise<void> {
  await rebuildMemoryContextPack({
    session: fixture.session,
    cache: fixture.cache,
    settings,
    sessionId,
  });

  const messages: AgentMessage[] = [
    {
      role: "user",
      content: [{ type: "text", text: userText }],
      timestamp: Date.now(),
    },
    createAssistantMessage({
      text: assistantText,
      timestamp: Date.now() + 1,
    }),
  ];

  await updateObservationalMemory({
    session: fixture.session,
    memory: fixture.cache,
    sessionId,
    effectiveContext: DEFAULT_EFFECTIVE_CONTEXT,
    actorModel: memoryModel,
    messages,
  });
}

describe("bump prefers the narrowest row that carries the cited fact", () => {
  testIfDocker(
    "bumps narrow siblings, not the broad summary, when both cover the cited fact",
    async () => {
      const fixture = await createMemoryFixture();
      try {
        const [summaryId, ...atomicIds] = await seedObservations(fixture, [
          SUMMARY_REFLECTION,
          ...ATOMIC_REFLECTIONS,
        ]);
        const before = await readLastUsed(fixture);
        const seededTime = before.get(summaryId)?.lastUsedAt ?? 0;
        expect(seededTime).toBeGreaterThan(0);

        await runObserverTurn(
          fixture,
          "session_bump_atomic",
          "Remind me what shipped in v0.1.131 and what Vitest 4 upgrade commit landed on staging.",
          "v0.1.131 released the transient-retry fix for `Anthropic stream ended before message_stop` " +
            "in `src/turn-runner/transient-error.ts`, and the Vitest 4 upgrade was pushed as commit " +
            "`885746567` to staging.",
        );

        const after = await readLastUsed(fixture);

        // 覆盖两个被引用事实的 atomic siblings 必须 bump。
        const transientAtomic = atomicIds.find((id) => after.get(id)?.content.includes("v0.1.131"));
        const vitestAtomic = atomicIds.find((id) => after.get(id)?.content.includes("885746567"));
        expect(transientAtomic).toBeDefined();
        expect(vitestAtomic).toBeDefined();
        expect(after.get(transientAtomic!)!.lastUsedAt).toBeGreaterThan(seededTime);
        expect(after.get(vitestAtomic!)!.lastUsedAt).toBeGreaterThan(seededTime);

        // summary row 覆盖相同事实，但不是最窄的 sibling；observer 必须优先选择窄 row。至少，summary 的 lastUsedAt 必须保持低于任何被 bump 的 row。
        const summaryLastUsed = after.get(summaryId)!.lastUsedAt;
        expect(summaryLastUsed).toBeLessThan(after.get(transientAtomic!)!.lastUsedAt);
        expect(summaryLastUsed).toBeLessThan(after.get(vitestAtomic!)!.lastUsedAt);
        expect(summaryLastUsed).toBe(seededTime);
      } finally {
        await fixture.dispose();
      }
    },
    60_000,
  );

  testIfDocker(
    "falls back to the summary row when no narrower row carries the cited fact",
    async () => {
      const fixture = await createMemoryFixture();
      try {
        const [summaryId] = await seedObservations(fixture, [SUMMARY_REFLECTION]);
        const before = await readLastUsed(fixture);
        const seededTime = before.get(summaryId)!.lastUsedAt;

        await runObserverTurn(
          fixture,
          "session_bump_fallback",
          "Remind me what shipped in v0.1.131 and what Vitest 4 upgrade commit landed on staging.",
          "v0.1.131 released the transient-retry fix for `Anthropic stream ended before message_stop` " +
            "in `src/turn-runner/transient-error.ts`, and the Vitest 4 upgrade was pushed as commit " +
            "`885746567` to staging.",
        );

        const after = await readLastUsed(fixture);
        // 没有 atomic siblings；覆盖这些事实的唯一 row 就是这唯一的 row，因此 bump 会落在它上面。
        expect(after.get(summaryId)!.lastUsedAt).toBeGreaterThan(seededTime);
      } finally {
        await fixture.dispose();
      }
    },
    60_000,
  );

  testIfDocker(
    "multiple atomic citations all get bumped",
    async () => {
      const fixture = await createMemoryFixture();
      try {
        const atomicIds = await seedObservations(fixture, ATOMIC_REFLECTIONS);
        const before = await readLastUsed(fixture);
        const seededTime = before.get(atomicIds[0]!)!.lastUsedAt;

        await runObserverTurn(
          fixture,
          "session_bump_multi",
          "Quick recap: what changed for transient Anthropic retries, bundled ripgrep, and the " +
            "memory-observation formatting?",
          "v0.1.131 made `Anthropic stream ended before message_stop` transient in " +
            "`src/turn-runner/transient-error.ts`. Bundled ripgrep ships via `@vscode/ripgrep` " +
            "optional platform deps and `withBundledRipgrep` is wired in `src/turn-runner/tools.ts`. " +
            "Memory-observation formatting (v0.1.130) now skips completed events when both " +
            "`observation` and `usageBumped` are empty, otherwise keeps the `Memory observation " +
            "recorded.` prefix with the optional `Reinforced N prior memor{y,ies}.` suffix.",
        );

        const after = await readLastUsed(fixture);
        const bumped = atomicIds.filter((id) => {
          const row = after.get(id);
          return row !== undefined && row.lastUsedAt > seededTime;
        });
        // 引用了三个不同事实；每个事实都应落在自己的 atomic row 上，而不是合并成一次 bump。
        expect(bumped.length).toBeGreaterThanOrEqual(3);
      } finally {
        await fixture.dispose();
      }
    },
    60_000,
  );
});
