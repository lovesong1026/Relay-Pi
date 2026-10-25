// 验证 ChatGPT 计划通过 codex transport 提供哪些模型，以及 Relay Pi 形状的系统提示词是否原样通过。
// 从 ~/.relay-pi/codex-probe-auth.json 读取凭据（由设备码登录写入），在过期时刷新并持久化。
// 只打印经过脱敏的矩阵，不打印 token 内容。
//
//   bun scripts/probe-connected-providers.ts codex [modelId ...]
import { getModel, complete, type Model } from "@earendil-works/pi-ai";
import { refreshOpenAICodexToken } from "@earendil-works/pi-ai/oauth";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const AUTH_PATH = join(process.env.HOME ?? "", ".relay-pi", "codex-probe-auth.json");
const DEFAULT_IDS = ["gpt-6-astra", "gpt-6-sol", "gpt-6-luna"];

// 具有代表性的 Relay Pi 形状系统提示词：分节、祈使式，并包含工具使用说明，
// 足以检测指令是否被重写或拒绝。实时资格验证可以改用生产提示词构建器。
const SYSTEM_PROMPT = [
  "You are Relay Pi, an autonomous coding agent operating inside a user's workspace VM.",
  "Follow the user's instructions exactly. Prefer small, verifiable steps.",
  "When tools are available, call them rather than describing what you would do.",
  "Report outcomes faithfully; if a step fails, say so with the error.",
  "## Response discipline",
  "Answer tersely. This probe expects a single word.",
].join("\n");

const ids = process.argv.slice(3).length > 0 ? process.argv.slice(3) : DEFAULT_IDS;

const stored = JSON.parse(readFileSync(AUTH_PATH, "utf8"));
let credentials = stored.credentials;
let rotated = "not-refreshed";
if (credentials.expires < Date.now() + 60_000) {
  const before = credentials.refresh;
  credentials = await refreshOpenAICodexToken(credentials);
  rotated = credentials.refresh === before ? "refresh-token-stable" : "refresh-token-ROTATED";
  writeFileSync(
    AUTH_PATH,
    JSON.stringify({ ...stored, credentials, savedAt: Date.now() }, null, 2),
  );
}
console.log(`auth: expires=${new Date(credentials.expires).toISOString()} rotation=${rotated}`);

const donor = getModel("openai-codex", "gpt-5.5");
if (!donor) throw new Error("pi-ai no longer ships openai-codex:gpt-5.5 (synthesis donor)");

for (const id of ids) {
  const model = { ...donor, id, name: id } as Model<typeof donor.api>;
  const startedAt = Date.now();
  try {
    const message = await complete(
      model,
      {
        systemPrompt: SYSTEM_PROMPT,
        messages: [{ role: "user", content: "Reply with the single word: ok" }],
      },
      { apiKey: credentials.access },
    );
    const text = message.content
      .filter((block: { type: string }) => block.type === "text")
      .map((block: { text?: string }) => block.text ?? "")
      .join("")
      .trim();
    console.log(
      `${id}: SERVED in ${Date.now() - startedAt}ms stop=${message.stopReason} ` +
        `tokens=${JSON.stringify(message.usage ?? {})} text=${JSON.stringify(text.slice(0, 60))}`,
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.log(`${id}: REFUSED ${JSON.stringify(detail.slice(0, 300))}`);
  }
}
