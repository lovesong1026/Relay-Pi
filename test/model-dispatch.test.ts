import { afterEach, beforeEach, expect, test } from "bun:test";

import { relayPiModels, relayPiStreamFn } from "../src/model-resolution/models.js";
import { resolveModelName } from "../src/model-resolution/resolver.js";

/**
 * ChatGPT tokens are JWTs the Codex transport reads the account id out of, so
 * a bare string never reaches the wire whatever auth decides. This carries the
 * one claim it needs and nothing else.
 */
const CALLER_TOKEN = [
  "e30",
  btoa(
    JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-test" } }),
  ).replace(/=+$/, ""),
  "caller-supplied-token",
].join(".");

const ROUTER_KEY = process.env.OPENROUTER_API_KEY;

beforeEach(() => {
  process.env.OPENROUTER_API_KEY = "openrouter-test-key";
});

afterEach(() => {
  if (ROUTER_KEY === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = ROUTER_KEY;
});

/**
 * The turn runner resolves a connected provider's token itself — Relay Pi stores
 * and refreshes ChatGPT/Copilot credentials, pi-ai's credential store never
 * sees them — and hands it to the loop as `apiKey`. That override is honored
 * only for a provider that declares api-key auth, and `openai-codex` declares
 * OAuth alone, so if the registry stops saying Relay Pi holds the credential,
 * every connected turn is refused before a request is built.
 */
test.each(["openai-codex", "github-copilot", "openrouter"])(
  "%s dispatch sends the caller's key instead of refusing the request",
  async (provider) => {
    const model =
      provider === "openrouter"
        ? resolveModelName("openrouter:moonshotai/kimi-k3")
        : (relayPiModels().getModels(provider)[0] ?? undefined);
    expect(model, `${provider} serves no models`).toBeDefined();

    let sentAuthorization: string | undefined;
    const stream = relayPiStreamFn(
      model!,
      { messages: [{ role: "user", content: "hi", timestamp: 0 }] },
      {
        apiKey: CALLER_TOKEN,
        fetch: (async (_input: unknown, init?: RequestInit) => {
          sentAuthorization = new Headers(init?.headers).get("authorization") ?? undefined;
          return new Response("", { status: 500 });
        }) as never,
      },
    );

    let errorMessage = "";
    for await (const event of await stream) {
      const message = (event as { message?: { errorMessage?: string } }).message;
      if (message?.errorMessage) errorMessage = message.errorMessage;
    }

    // A 500 from the fake upstream is the expected end state; being refused
    // before the request is built is the regression.
    expect(errorMessage).not.toContain("Provider is not configured");
    expect(sentAuthorization ?? "<no request was made>").toContain("caller-supplied-token");
  },
  30_000,
);

/**
 * A model's `api` is a claim about how its request is serialized. The claim
 * is not self-enforcing: serialization belongs to the provider, so a spec that
 * says one transport and a provider that implements another silently send the
 * wrong shape.
 */
// The two OpenAI-shaped payloads and the Anthropic one all carry `messages`,
// so the token-limit field is the discriminator that actually separates them.
const WIRE_SHAPES = {
  "openai-responses": { present: "input", absent: "messages" },
  "openai-completions": { present: "max_completion_tokens", absent: "thinking" },
  "anthropic-messages": { present: "thinking", absent: "max_completion_tokens" },
} as const;

test.each([
  ["openrouter:openai/gpt-6.1-sol", "openai-completions"],
  ["openrouter:openai/gpt-6-sol", "openai-completions"],
  ["openrouter:openai/gpt-6-luna", "openai-completions"],
  ["openrouter:anthropic/claude-opus-5.5", "anthropic-messages"],
  ["openrouter:x-ai/grok-4.7", "openai-completions"],
  ["openrouter:z-ai/glm-5.3", "openai-completions"],
  ["openrouter:moonshotai/kimi-k3", "openai-completions"],
])("%s is serialized as %s, the transport it declares", async (pin, api) => {
  const model = resolveModelName(pin);
  expect(model.api).toBe(api);

  let payload: Record<string, unknown> | undefined;
  const stream = relayPiModels().streamSimple(
    model,
    { messages: [{ role: "user", content: "hi", timestamp: 0 }] },
    {
      apiKey: "test-key",
      reasoning: "high",
      onPayload: (sent) => {
        payload = sent as Record<string, unknown>;
        return undefined;
      },
      fetch: (async () => new Response("", { status: 500 })) as never,
    },
  );
  for await (const _event of await stream) void _event;

  const shape = WIRE_SHAPES[api as keyof typeof WIRE_SHAPES];
  expect(payload, "no request was built").toBeDefined();
  expect(payload).toHaveProperty(shape.present);
  expect(payload).not.toHaveProperty(shape.absent);

  // The reasoning ask has a different field name per transport; what matters
  // is that a reasoning-capable model carries one at all.
  if (model.reasoning) {
    const asked = payload?.reasoning ?? payload?.reasoning_effort ?? payload?.thinking ?? undefined;
    expect(asked, `${pin} sent no reasoning request`).toBeDefined();
  }
});
