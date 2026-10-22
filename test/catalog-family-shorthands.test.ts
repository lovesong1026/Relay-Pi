import { describe, expect, test } from "bun:test";
import {
  FAMILY_LATEST,
  canonicalizeModelName,
  getModelCandidates,
  isKnownShorthand,
  resolveFamilyShorthand,
  type FamilyName,
  type RouterProviderName,
  getProviderMemoryModel,
  DEFAULT_CLI_MEMORY_MODEL,
} from "../src/model-resolution/catalog.js";
import { resolveModelName } from "../src/model-resolution/resolver.js";

interface FamilyCase {
  family: FamilyName;
  latest: string;
  modelsByProvider: Partial<Record<RouterProviderName, string>>;
}

const familyCases: readonly FamilyCase[] = [
  {
    family: "fable",
    latest: "fable-5.1",
    modelsByProvider: {
      openrouter: "anthropic/claude-fable-5.1",
    },
  },
  {
    family: "opus",
    latest: "opus-5.5",
    modelsByProvider: {
      openrouter: "anthropic/claude-opus-5.5",
    },
  },
  {
    family: "sonnet",
    latest: "sonnet-4.6",
    modelsByProvider: {
      openrouter: "anthropic/claude-sonnet-4.6",
    },
  },
  {
    family: "haiku",
    latest: "haiku-4.5",
    modelsByProvider: {
      openrouter: "anthropic/claude-haiku-4.5",
    },
  },
  {
    family: "sol",
    latest: "gpt-6.1-sol",
    modelsByProvider: {
      openrouter: "openai/gpt-6.1-sol",
    },
  },
  {
    family: "terra",
    latest: "gpt-6.1-sol",
    modelsByProvider: {
      openrouter: "openai/gpt-6.1-sol",
    },
  },
  {
    family: "astra",
    latest: "gpt-6-astra",
    modelsByProvider: {
      openrouter: "openai/gpt-6-astra",
    },
  },
  {
    family: "luna",
    latest: "gpt-6-luna",
    modelsByProvider: {
      openrouter: "openai/gpt-6-luna",
    },
  },
  {
    family: "kimi",
    latest: "kimi-k3",
    modelsByProvider: {
      openrouter: "moonshotai/kimi-k3",
    },
  },
  {
    family: "grok",
    latest: "grok-4.7",
    modelsByProvider: {
      openrouter: "x-ai/grok-4.7",
    },
  },
  {
    family: "deepseek",
    latest: "deepseek-v4.1-flash",
    modelsByProvider: {
      openrouter: "deepseek/deepseek-v4.1-flash",
    },
  },
  {
    family: "glm",
    latest: "glm-5.3",
    modelsByProvider: {
      openrouter: "z-ai/glm-5.3",
    },
  },
  {
    family: "jev",
    latest: "jev-router",
    modelsByProvider: {
      openrouter: "typesafe/jev-router",
    },
  },
];

const providers: readonly RouterProviderName[] = ["openrouter"];

describe("catalog family shorthands", () => {
  test("resolves every family to one latest shorthand and its provider models", () => {
    expect(Object.entries(FAMILY_LATEST).sort()).toEqual(
      familyCases.map(({ family, latest }): [string, string] => [family, latest]).sort(),
    );

    for (const { family, latest, modelsByProvider } of familyCases) {
      expect(resolveFamilyShorthand(family), family).toBe(latest);
      expect(canonicalizeModelName(family), family).toBe(latest);
      expect(isKnownShorthand(family), family).toBe(true);
      expect(getModelCandidates(family), family).toEqual(
        providers.flatMap((provider) => {
          const modelId = modelsByProvider[provider];
          return modelId ? [{ provider, modelName: `${provider}:${modelId}` }] : [];
        }),
      );
    }
  });

  test("keeps every surviving versioned shorthand resolvable", () => {
    const survivingShorthands = [
      "fable-5.1",
      "fable-5",
      "opus-5.5",
      "sonnet-4.6",
      "haiku-4.5",
      "gpt-6.1-sol",
      "gpt-6-sol",
      "gpt-6-luna",
      "gpt-6-astra",
      "kimi-k3",
      "grok-4.7",
      "deepseek-v4.1-flash",
      "deepseek-v4-pro",
      "glm-5.3",
      "jev-router",
    ];

    for (const shorthand of survivingShorthands) {
      expect(isKnownShorthand(shorthand), shorthand).toBe(true);
      expect(canonicalizeModelName(shorthand), shorthand).toBe(shorthand);
      expect(getModelCandidates(shorthand).length, shorthand).toBeGreaterThan(0);
    }
  });

  test("does not resolve deleted pre-5.6 OpenAI shorthands or aliases", () => {
    for (const deletedName of [
      "gpt-5.5",
      "openai/gpt-5.5",
      "openai/gpt-5-5",
      "gpt-5.4-mini",
      "openai/gpt-5.4-mini",
      "openai/gpt-5-4-mini",
    ]) {
      expect(isKnownShorthand(deletedName), deletedName).toBe(false);
      expect(getModelCandidates(deletedName), deletedName).toEqual([]);
    }
  });
});

test("openrouter memory model resolves to a defined luna spec with real cost", () => {
  const resolution = resolveModelName("openrouter:openai/gpt-6-luna");
  expect(resolution.id).toBe("openai/gpt-6-luna");
  expect(resolution.provider).toBe("openrouter");
  expect(resolution.cost.input).toBeGreaterThan(0);
  expect(getProviderMemoryModel("openrouter")).toBe(DEFAULT_CLI_MEMORY_MODEL);
});

test("Sonnet 4.6 resolves its OpenRouter transport", () => {
  const model = resolveModelName("openrouter:sonnet-4.6");
  expect(model.id).toBe("anthropic/claude-sonnet-4.6");
  expect(model.api).toBe("anthropic-messages");
  expect(model.input).toContain("image");
  expect(getModelCandidates("sonnet-5.5")).toEqual([]);
  expect(getModelCandidates("sonnet-5")).toEqual([]);
});
