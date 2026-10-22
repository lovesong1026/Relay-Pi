import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Usage } from "@earendil-works/pi-ai";
import {
  buildClassifierMessages,
  classifyRoute,
  type ClassifierGenerate,
  type ClassifierInput,
  type ClassifierUsageReport,
} from "../src/model-routing/classifier.js";
import { BUILT_IN_ROUTING_TABLE } from "../src/model-routing/table.js";

const fixture: ClassifierInput = {
  tierName: "frontier",
  tier: BUILT_IN_ROUTING_TABLE.tiers.frontier,
  guidance: "Keep implementation work on the implementation route.",
  currentTarget: "gpt-5.6-sol because route implement",
  prevTurnHint: "The previous turn planned a settings-page redesign.",
  lastStepDelta: "The plan is complete; the next step is editing TypeScript.",
  hasImages: true,
  trigger: "cadence",
};

const CHAT_USAGE: Usage = {
  input: 420,
  output: 24,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 444,
  cost: { input: 0.0004, output: 0.00014, cacheRead: 0, cacheWrite: 0, total: 0.00054 },
};

const CREDENTIAL_ENV = ["OPENROUTER_API_KEY"] as const;
const savedCredentials = Object.fromEntries(
  CREDENTIAL_ENV.map((name) => [name, process.env[name]]),
);

beforeEach(() => {
  for (const name of CREDENTIAL_ENV) delete process.env[name];
});

afterEach(() => {
  for (const name of CREDENTIAL_ENV) {
    const value = savedCredentials[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function generating(
  route: string,
  rationale: string,
): { generate: ClassifierGenerate; calls: Parameters<ClassifierGenerate>[0][] } {
  const calls: Parameters<ClassifierGenerate>[0][] = [];
  const generate = (async (options: Parameters<ClassifierGenerate>[0]) => {
    calls.push(options);
    options.onUsage?.(CHAT_USAGE);
    return { route, rationale };
  }) as ClassifierGenerate;
  return { generate, calls };
}

describe("buildClassifierMessages", () => {
  test("renders all rules, guidance, lean context, and cache preference", () => {
    const messages = buildClassifierMessages(fixture);

    expect(messages.systemPrompt).toContain("Choose the single route");
    expect(messages.systemPrompt).toContain("prompt cache");
    expect(messages.prompt).toContain("TIER: frontier");
    for (const [name, rule] of Object.entries(fixture.tier.routes)) {
      expect(messages.prompt).toContain(`- ${name}: ${rule.description}`);
    }
    expect(messages.prompt).toContain(fixture.guidance);
    expect(messages.prompt).toContain("Images present: yes");
    expect(messages.prompt).toContain("Trigger: cadence");
    expect(messages.prompt).toContain("gpt-5.6-sol because route implement");
    expect(messages.prompt).toContain("Switching away discards the current model's prompt cache");
    expect(messages.prompt).toContain(fixture.prevTurnHint!);
    expect(messages.prompt).toContain(fixture.lastStepDelta!);
  });

  test("bounds previous-turn and last-step hints", () => {
    const messages = buildClassifierMessages({
      ...fixture,
      prevTurnHint: "p".repeat(2_000),
      lastStepDelta: "d".repeat(2_000),
    });

    expect(messages.prompt).not.toContain("p".repeat(1_001));
    expect(messages.prompt).not.toContain("d".repeat(1_001));
    expect(messages.prompt).toContain(`${"p".repeat(1_000)}…`);
    expect(messages.prompt).toContain(`${"d".repeat(1_000)}…`);
  });
});

describe("classifyRoute on a catalog target", () => {
  // No AI Gateway key anywhere: a catalog classifier resolves through the
  // metered router order like any other auxiliary actor, so a workspace whose
  // only credential is OpenRouter still classifies.
  beforeEach(() => {
    process.env.OPENROUTER_API_KEY = "openrouter-test-key";
  });

  test("forces the select_route tool at the configured effort and returns the rationale", async () => {
    const { generate, calls } = generating("implement", "The next step is implementation work.");
    const usage: ClassifierUsageReport[] = [];
    const controller = new AbortController();

    await expect(
      classifyRoute(fixture, {
        target: { modelName: "luna", thinkingLevel: "low" },
        generate,
        signal: controller.signal,
        onUsage: (report) => usage.push(report),
      }),
    ).resolves.toEqual({ route: "implement", rationale: "The next step is implementation work." });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.tool.name).toBe("select_route");
    expect(calls[0]!.callOptions).toEqual({ reasoningEffort: "low" });
    expect(calls[0]!.signal).toBe(controller.signal);
    expect(calls[0]!.systemPrompt).toBe(buildClassifierMessages(fixture).systemPrompt);
    expect(calls[0]!.prompt).toBe(buildClassifierMessages(fixture).prompt);
    expect(calls[0]!.model).toContain("gpt-6-luna");
    // The attributed row must name exactly the provider:model the call used,
    // whichever metered provider the workspace credential resolved to.
    expect(usage).toHaveLength(1);
    expect(`${usage[0]!.transport}:${usage[0]!.modelId}`).toBe(calls[0]!.model);
    expect(usage[0]!.usage).toEqual(CHAT_USAGE);
  });

  test("omits reasoning effort when the target configures none", async () => {
    const { generate, calls } = generating("general", "Nothing more specific fits.");

    await expect(
      classifyRoute(fixture, { target: { modelName: "luna" }, generate }),
    ).resolves.toEqual({ route: "general", rationale: "Nothing more specific fits." });
    expect(calls[0]!.callOptions).toBeUndefined();
  });

  test("rejects an invented route name returned by the chat model", async () => {
    const { generate } = generating("invented", "This route does not exist.");

    await expect(
      classifyRoute(fixture, { target: { modelName: "luna", thinkingLevel: "low" }, generate }),
    ).rejects.toThrow('Classifier selected unknown route "invented" for tier "frontier".');
  });

  test("classifies with only the OpenRouter credential", async () => {
    const { generate, calls } = generating("implement", "Implementation work.");

    await expect(
      classifyRoute(fixture, { target: { modelName: "luna" }, generate }),
    ).resolves.toMatchObject({ route: "implement" });
    expect(calls).toHaveLength(1);
  });
});
