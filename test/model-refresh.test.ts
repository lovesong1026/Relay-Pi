import {
  normalizeSavedModelSelection,
  pinnedDefaultModel,
  pinnedMemoryModel,
} from "../src/model-resolution/catalog.js";
import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Session } from "../src/session/session.js";
import { resolveCliModel } from "../src/model-resolution/resolver.js";
import baseline from "./fixtures/model-refresh/standalone-baseline.json" with { type: "json" };
import { testIfDocker } from "./helpers/docker-only.js";

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

test("CLI selections retain the family intent before execution", () => {
  for (const input of ["opus", "sol", "terra", "luna"]) {
    expect(resolveCliModel(input, new Set()).modelName).toBe(input);
  }
}, 30_000);

testIfDocker(
  "resuming one session cannot change another session's saved selection",
  async () => {
    const { SessionManager } = await import("../src/session/session-manager.js");
    const dir = await mkdtemp(join(tmpdir(), "model-refresh-manager-"));
    tempDirs.push(dir);
    const previousKey = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = "controlled";
    const manager = new SessionManager(
      { cwd: dir, memoryDbPath: false, skillDiscovery: { includeDefaults: false } },
      { sessionStoragePath: dir },
    );
    try {
      for (const family of ["sol", "opus"]) {
        const receipt = baseline.receipts.find((item) => item.input === family)!;
        await mkdir(join(dir, family));
        await writeFile(join(dir, family, "state.json"), JSON.stringify(receipt.envelope));
        const session = manager.resume(family);
        await session.start();
        expect(session.getState()?.options?.model).toBe(family);
      }
      expect(manager.get("sol")?.config.model).toBe("sol");
      expect(manager.get("opus")?.config.model).toBe("opus");
    } finally {
      await manager.dispose();
      if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = previousKey;
    }
  },
  30_000,
);

test("provider defaults retain provider and family intent", () => {
  expect(pinnedDefaultModel("openrouter")).toBe("openrouter:opus");
  expect(pinnedMemoryModel("openrouter")).toBe("openrouter:luna");
});

test("retired saved selectors retain their provider while recovering family intent", () => {
  for (const [saved, current] of [
    ["opus-4.8", "opus"],
    ["opus-4.7", "opus"],
    ["glm-4.7", "glm"],
    ["openrouter:openai/gpt-5.6-terra", "openrouter:terra"],
    ["openai-codex:gpt-5.6-luna", "openai-codex:gpt-6-luna"],
    ["github-copilot:claude-opus-5", "github-copilot:claude-opus-5.5"],
  ])
    expect(normalizeSavedModelSelection(saved)).toBe(current);
});

testIfDocker(
  "saved chat tiers retain routing and advisors while memory names recover concrete intent",
  async () => {
    const { BUILT_IN_ROUTING_TABLE } = await import("../src/model-routing/table.js");
    const dir = await mkdtemp(join(tmpdir(), "saved-virtual-"));
    tempDirs.push(dir);
    const table = structuredClone(BUILT_IN_ROUTING_TABLE);
    table.defaultTier = "opus-4.7";
    table.tiers["opus-4.7"] = structuredClone(table.tiers.frontier!);
    table.tiers["opus-4.7"]!.advisor.enabled = true;
    table.tiers["gpt-5.6-luna"] = structuredClone(table.tiers.balanced!);
    const original = baseline.receipts.find((item) => item.input === "opus")!.envelope;
    const envelope = {
      ...original,
      state: {
        ...original.state,
        options: { ...original.state.options, model: "opus-4.7", memoryModel: "gpt-5.6-luna" },
      },
    };
    await mkdir(join(dir, ".relay-pi"));
    await writeFile(join(dir, ".relay-pi", "models.json"), JSON.stringify(table));
    await writeFile(join(dir, "state.json"), JSON.stringify(envelope));
    const previousKey = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = "controlled";
    const session = new Session(
      {
        cwd: dir,
        memoryDbPath: false,
        memoryStores: false,
        skillDiscovery: { includeDefaults: false },
      },
      { id: "saved-virtual", sessionPath: dir, resumeFromStorage: true },
    );
    try {
      await session.start();
      expect(session.getState()?.options).toMatchObject({ model: "opus-4.7", memoryModel: "luna" });
      expect(session.config.model).toBe("opus-4.7");
      expect(session.routeStatus()).toMatchObject({
        tier: "opus-4.7",
        advisorEnabled: true,
        pinned: false,
      });
      expect(session.getState()?.agent.messages as unknown).toEqual(original.state.agent.messages);
    } finally {
      await session.dispose();
      if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = previousKey;
    }
  },
);
