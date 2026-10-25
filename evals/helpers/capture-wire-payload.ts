import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { existsSync } from "node:fs";

import { rebuildMemoryContextPack } from "../../src/memory/context-pack.js";
import { SkillContext } from "../../src/turn-runner/skill-context.js";
import type { TurnRunnerConfig } from "../../src/types/config.js";
import {
  DEFAULT_EFFECTIVE_CONTEXT,
  createObservationalContextTransform,
  resolveObservationalMemorySettings,
  stripObservationalContextMessages,
} from "../../src/memory/observational.js";
import {
  applyEvictionHorizon,
  calculateWireBytes,
  calculateWireTokens,
  createInitialHorizon,
} from "../../src/turn-runner/wire-shaping.js";
import type { Observation } from "../../src/types/memory.js";
import type { WireGuardHorizon } from "../../src/types/protocol.js";
import type { MemoryFixture } from "../../test/helpers/memory-fixture.js";
import { createMemoryFixture } from "../../test/helpers/memory-fixture.js";

/**
 * `bun run scripts/dump-memory.ts` 写入的 row 原始 shape。wire-payload reproduction 的 memory dump 直接读取该脚本输出的 JSON——不需要派生的 seed file。
 */
interface DumpedRow {
  id: string;
  createdAt: number;
  lastUsedAt: number;
  sessionId?: string;
  kind: Observation["kind"];
  observedDate: string;
  referencedDate?: string;
  relativeDate?: string;
  timeOfDay?: string;
  priority: Observation["priority"];
  source: Observation["source"];
  content: string;
  tags?: string[];
}

/**
 * wire-shaping transform 实际读取的 `TurnState` 子集。数据来自真实 session 的 state.json，因此捕获的 payload 与 runner 在当时会派发的内容一致。
 */
interface MinimalTurnState {
  agent: { messages: AgentMessage[] };
  wireGuardHorizon?: WireGuardHorizon;
}

export interface CapturedWirePayloadOptions {
  /**
   * 要复现的 session 的已解析 `state.json`——可以传入完整的 `TurnState`，也可以传入 `~/.relay-pi/sessions/<id>/state.json` 写出的 `{ state: TurnState }`。
   */
  turnState: MinimalTurnState | { state: MinimalTurnState };
  /** 已解析的 `memory-dump.json`（`bun run scripts/dump-memory.ts --pretty` 的输出）。 */
  memoryDump: DumpedRow[];
  /** 传给 context-pack loader、使其 row 落入 local layer 的 session id。 */
  sessionId: string;
  /**
   * runner 使用的有效 context window。它驱动所有派生的 memory budget。默认值为生产默认值（`DEFAULT_EFFECTIVE_CONTEXT`），因此缺失时会复现大多数 session 所经历的 200k-window 行为。
   */
  effectiveContext?: number;
  /**
   * 原始 session 运行时所在的 working directory。用于按 runner 相同的方式重建 AGENTS.md system-prompt layer。默认值为 `process.cwd()`，因此从同一 repo 内调用 harness 时会逐字复现该 repo 的 AGENTS.md。session 上的 observations 通常带有明确命名路径的 `cwd="..."` 属性。
   */
  cwd?: string;
  /**
   * runner 启动时使用的 `systemInstructions`。多数 session 不设置它（CLI 不注入额外 instructions），但 eval 在确定 session 以非默认值启动时可以传入逐字副本。
   */
  systemInstructions?: string;
  /**
   * skill discovery overrides。默认使用生产 discovery，使 captured system prompt 包含 runner 原本会渲染的相同 skill block。传入 `{ includeDefaults: false }` 可在被测 bug 不依赖 skill 时降低 prompt 成本。
   */
  skillDiscovery?: TurnRunnerConfig["skillDiscovery"];
  /**
   * 固定的 system prompt 字符串。设置后 harness 会跳过实时的 `createSystemPromptWithAppendedLayers` 重建，并将该精确字符串作为 `payload.systemPrompt` 返回（`systemPromptFiles` 为空）。传入已提交的 `system-prompt.txt` fixture 内容，使 eval 复现 model 在捕获时实际看到的内容——否则重建会遍历当前 cwd 的 AGENTS.md 与已发现的 skills，它们会独立于 captured session 发生漂移。
   */
  systemPromptOverride?: string;
}

export interface CapturedWirePayload {
  /**
   * Full system prompt the runner would have sent on this turn.
   * When `systemPromptOverride` is set on the options, this is
   * that pinned string verbatim; otherwise it is composed via the
   * production `createSystemPromptWithAppendedLayers` over the
   * captured `cwd`'s AGENTS.md and discovered skills. Pair with
   * `dispatched` to reproduce the exact provider request.
   */
  systemPrompt: string;
  /**
   * 本次 capture 在磁盘上解析出的所有 AGENTS.md / system-prompt 文件的绝对路径。`systemPromptOverride` 跳过实时重建时为空，因为固定 snapshot 没有磁盘来源信息。
   */
  systemPromptFiles: string[];
  /** 从输入 state 读取、transform 运行前的 eviction horizon。 */
  horizonBefore: number;
  /** transform 运行后的 eviction horizon。只有 transform 自身推进了它（token/byte trigger 触发）时才不同。 */
  horizonAfter: number;
  /** 应用 horizon 前的原始 transcript message 数量。 */
  rawMessageCount: number;
  /**
   * 通过 horizon 后仍保留的真实（非 synthetic）message 数量。失败 shape 为零：所有真实的 user/tool message 都被 eviction。
   */
  retainedMessageCount: number;
  /**
   * The two synthetic user messages the transform prepends: the
   * `<observations>` block and the `<continuation hint>`. Captured by
   * byte length + a short preview so assertions can check "memory pack
   * is non-empty" without dumping the entire rendered prefix.
   */
  syntheticPrepends: Array<{
    role: AgentMessage["role"];
    kind: "observation-context" | "continuation-hint" | "other";
    bytes: number;
    preview: string;
  }>;
  /** Exact AgentMessage[] that would hit the provider on this turn. */
  dispatched: AgentMessage[];
  dispatchedBytes: number;
  dispatchedTokens: number;
  /** Whether the dispatch contains any real `user` role from the original transcript (post-horizon). */
  dispatchedHasRealUser: boolean;
}

const OBSERVATION_PREFIX = "<system-reminder>";

function unwrapTurnState(input: CapturedWirePayloadOptions["turnState"]): MinimalTurnState {
  if ("state" in input && (input as { state?: unknown }).state) {
    return (input as { state: MinimalTurnState }).state;
  }
  return input as MinimalTurnState;
}

function classifyPrepend(
  message: AgentMessage,
): "observation-context" | "continuation-hint" | "other" {
  if (message.role !== "user") return "other";
  const text = messageText(message);
  if (!text.startsWith(OBSERVATION_PREFIX)) return "other";
  // The continuation reminder is a single short system-reminder line;
  // the observations reminder carries the rendered `<observations>` block.
  if (text.includes("<observations>")) return "observation-context";
  return "continuation-hint";
}

function messageText(message: AgentMessage): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) =>
        block && typeof block === "object" && typeof (block as { text?: unknown }).text === "string"
          ? (block as { text: string }).text
          : "",
      )
      .join("");
  }
  return "";
}

function messageBytes(message: AgentMessage): number {
  return calculateWireBytes([message]);
}

function preview(message: AgentMessage, limit = 200): string {
  const text =
    messageText(message) || JSON.stringify((message as { content?: unknown }).content ?? "");
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

async function seedDump(fixture: MemoryFixture, dump: DumpedRow[]): Promise<void> {
  for (const row of dump) {
    const observation = await fixture.append({
      ...(row.sessionId !== undefined ? { sessionId: row.sessionId } : {}),
      kind: row.kind,
      observedDate: row.observedDate,
      ...(row.referencedDate !== undefined ? { referencedDate: row.referencedDate } : {}),
      ...(row.relativeDate !== undefined ? { relativeDate: row.relativeDate } : {}),
      ...(row.timeOfDay !== undefined ? { timeOfDay: row.timeOfDay } : {}),
      priority: row.priority,
      source: row.source,
      content: row.content,
      tags: row.tags ?? [],
    });
    // Preserve the original timestamps from the dump so recency-bias
    // scoring in `loadGlobalPack` reproduces the relative ordering the
    // failing session actually saw.
    await fixture.session.withDb(
      async (db: { query: (sql: string, params: unknown[]) => Promise<unknown> }) => {
        await db.query("UPDATE observations SET created_at = $1, last_used_at = $2 WHERE id = $3", [
          row.createdAt,
          row.lastUsedAt,
          observation.id,
        ]);
      },
    );
  }
}

/**
 * Reproduce the exact `AgentMessage[]` the runner would have dispatched
 * to the provider on the next turn of a saved session.
 *
 * Builds a fresh `MemorySession` populated from a `dump-memory.ts`
 * fixture, calls `rebuildMemoryContextPack` with the failing session id
 * so global + local layers split the same way they did live, then runs
 * `createObservationalContextTransform` over the session's stored
 * messages with the persisted `wireGuardHorizon`. The returned wire
 * payload is the same shape pi-agent would send — useful for evals
 * that need to assert what the model actually saw at the failure
 * moment instead of guessing from logs.
 *
 * Callers must `dispose()` the returned fixture handle so the temp
 * memory.db is removed.
 */
export async function capturedWirePayload(
  options: CapturedWirePayloadOptions,
): Promise<{ payload: CapturedWirePayload; dispose: () => Promise<void> }> {
  const turnState = unwrapTurnState(options.turnState);
  const effectiveContext = options.effectiveContext ?? DEFAULT_EFFECTIVE_CONTEXT;
  const settings = resolveObservationalMemorySettings(effectiveContext);
  const fixture = await createMemoryFixture();
  try {
    await seedDump(fixture, options.memoryDump);
    await rebuildMemoryContextPack({
      session: fixture.session,
      cache: fixture.cache,
      settings,
      sessionId: options.sessionId,
    });

    const horizon: WireGuardHorizon = turnState.wireGuardHorizon
      ? { ...turnState.wireGuardHorizon }
      : createInitialHorizon();
    const horizonBefore = horizon.evictionHorizon;

    const transform = createObservationalContextTransform({
      memory: fixture.cache,
      effectiveContext,
      horizon,
    });

    const dispatched = await transform(turnState.agent.messages);
    const stripped = stripObservationalContextMessages(dispatched);
    const synthetic = dispatched.filter((m) => !stripped.includes(m));
    const retained = applyEvictionHorizon(
      stripObservationalContextMessages(turnState.agent.messages),
      horizon.evictionHorizon,
    );

    const { systemPrompt, systemPromptFiles } =
      options.systemPromptOverride !== undefined
        ? { systemPrompt: options.systemPromptOverride, systemPromptFiles: [] as string[] }
        : await buildSystemPrompt({
            cwd: options.cwd ?? process.cwd(),
            ...(options.systemInstructions !== undefined
              ? { systemInstructions: options.systemInstructions }
              : {}),
            ...(options.skillDiscovery !== undefined
              ? { skillDiscovery: options.skillDiscovery }
              : {}),
          });

    const payload: CapturedWirePayload = {
      systemPrompt,
      systemPromptFiles,
      horizonBefore,
      horizonAfter: horizon.evictionHorizon,
      rawMessageCount: turnState.agent.messages.length,
      retainedMessageCount: retained.length,
      syntheticPrepends: synthetic.map((m) => ({
        role: m.role,
        kind: classifyPrepend(m),
        bytes: messageBytes(m),
        preview: preview(m),
      })),
      dispatched,
      dispatchedBytes: calculateWireBytes(dispatched),
      dispatchedTokens: calculateWireTokens(dispatched),
      dispatchedHasRealUser: stripped.some((m) => m.role === "user"),
    };

    return {
      payload,
      dispose: async () => {
        await fixture.dispose();
      },
    };
  } catch (error) {
    await fixture.dispose();
    throw error;
  }
}

/**
 * Reproduce the runner-shaped system prompt for a captured session.
 *
 * Mirrors what `TurnRunner.createBaseSystemPromptWithAppendedLayers`
 * does: assemble `systemInstructions` + the resolved AGENTS.md layers
 * (walked from the captured cwd) + the tool-execution prompt + the
 * skills block + the current-date layer, via the same exported
 * `createSystemPromptWithAppendedLayers` the runner uses. The skills
 * are discovered with production defaults so the rendered prompt
 * matches what the runner would have sent for the same cwd today.
 *
 * Note: this is a best-effort snapshot — if AGENTS.md or installed
 * skills changed between the original session and the capture run,
 * the system prompt will reflect the current state rather than the
 * historical one. Pin known historical values via `systemInstructions`
 * or commit the original AGENTS.md alongside the fixture when fidelity
 * matters.
 */
async function buildSystemPrompt(input: {
  cwd: string;
  systemInstructions?: string;
  skillDiscovery?: TurnRunnerConfig["skillDiscovery"];
}): Promise<{ systemPrompt: string; systemPromptFiles: string[] }> {
  const config: TurnRunnerConfig = {
    cwd: input.cwd,
    ...(input.systemInstructions !== undefined
      ? { systemInstructions: input.systemInstructions }
      : {}),
    ...(input.skillDiscovery !== undefined ? { skillDiscovery: input.skillDiscovery } : {}),
  };
  const skillContext = new SkillContext(config);
  await skillContext.ensureLoaded();
  const systemPrompt = skillContext.createSystemPromptWithAppendedLayers();
  const systemPromptFiles = skillContext
    .getResolvedAgentFiles()
    .map((file) => file.path)
    .filter((path) => existsSync(path));
  return { systemPrompt, systemPromptFiles };
}
