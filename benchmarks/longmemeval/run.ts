#!/usr/bin/env bun
/**
 * relay-pi 观察式记忆流水线的 LongMemEval harness。
 *
 * 每个样本执行：
 *   1. 在 benchmarks/longmemeval/results/sessions/<question_id>/ 下创建
 *      每个问题独立的 MemorySession dataDir。
 *   2. 通过 updateObservationalMemory 导入每个 haystack_session，并使用
 *      sessionId=haystack_session_ids[i] 和 now=Date(haystack_dates[i])，
 *      使观察记录携带真实墙上时钟时间，从而可以回答时间推理/知识更新问题。
 *   3. 读取所有已保存的观察记录，并通过 relay-pi model gateway 回答问题。
 *      observer（memory model）和 reader（actor model）使用同一个 shorthand model。
 *   4. 将 {question_id, hypothesis} 追加到
 *      benchmarks/longmemeval/results/<run-name>.hyp.jsonl。
 *
 * 用法：
 *   bun benchmarks/longmemeval/run.ts \
 *     --dataset benchmarks/longmemeval/data/longmemeval_oracle.json \
 *     --limit 20 \
 *     --run-name smoke-oracle-20
 *
 * 添加 --stratify 后，会按 question_type 分组按比例抽取 --limit 个样本
 *（通过 --seed 确定性抽样，默认值为 42），而不是直接取数据集开头的样本。
 */
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { complete, type AssistantMessage, type Message } from "@earendil-works/pi-ai";
import { MemorySession } from "../../src/memory/session.js";
import { runMigrations } from "../../src/memory/migrations.js";
import {
  resolveObservationalMemorySettings,
  updateObservationalMemory,
} from "../../src/memory/observational.js";
import { rebuildMemoryContextPack } from "../../src/memory/context-pack.js";
import { MemoryContextCache } from "../../src/memory/store.js";
import { readAllObservations } from "../../src/memory/storage.js";
import { stripObservationGroups } from "../../src/memory/observation-groups.js";
import { resolveModelName } from "../../src/model-resolution/resolver.js";

interface Instance {
  question_id: string;
  question_type: string;
  question: string;
  answer: string;
  question_date: string;
  haystack_dates: string[];
  haystack_session_ids: string[];
  haystack_sessions: { role: "user" | "assistant"; content: string }[][];
  answer_session_ids: string[];
}

interface CliOpts {
  dataset: string;
  /** 要运行的样本上限；设置 --stratify 时，这是分层样本的大小。 */
  limit: number;
  runName: string;
  model: string;
  concurrency: number;
  /** 为 true 时，按 question_type 分组按比例选择 `limit` 个样本，而不是取数据集开头。 */
  stratify: boolean;
  /** 确定性分层抽样所用的 seed。 */
  seed: number;
}

function parseArgs(): CliOpts {
  const args = process.argv.slice(2);
  let dataset = "benchmarks/longmemeval/data/longmemeval_oracle.json";
  let limit = 20;
  let runName = "smoke-oracle-20";
  let model = "luna";
  let concurrency = 8;
  let stratify = false;
  let seed = 42;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const next = () => {
      const v = args[++i];
      if (!v) throw new Error(`missing value for ${a}`);
      return v;
    };
    switch (a) {
      case "--dataset":
        dataset = next();
        break;
      case "--limit":
        limit = Number(next());
        break;
      case "--run-name":
        runName = next();
        break;
      case "--model":
        model = next();
        break;
      case "--concurrency":
        concurrency = Number(next());
        break;
      case "--stratify":
        stratify = true;
        break;
      case "--seed":
        seed = Number(next());
        break;
      default:
        throw new Error(`unknown flag: ${a}`);
    }
  }
  if (!Number.isFinite(concurrency) || concurrency < 1) {
    throw new Error(`--concurrency must be a positive integer, got ${concurrency}`);
  }
  if (!Number.isFinite(seed)) {
    throw new Error(`--seed must be a finite number, got ${seed}`);
  }
  return { dataset, limit, runName, model, concurrency, stratify, seed };
}

/** 按确定性的 mulberry32 算法生成伪随机数。 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 从 `all` 中抽取 `total` 个样本，并按比例分配到各个
 * `question_type` 分组。使用最大余数法取整，使各组数量之和恰好等于
 * `total`，并使用带 seed 的 PRNG 在组内抽样。返回数据集原始顺序，
 * 让运行日志保持可读。
 */
function stratifiedSample(all: Instance[], total: number, seed: number): Instance[] {
  if (total >= all.length) return all.slice();
  const buckets = new Map<string, Instance[]>();
  for (const inst of all) {
    const key = inst.question_type;
    const arr = buckets.get(key);
    if (arr) arr.push(inst);
    else buckets.set(key, [inst]);
  }
  const entries = Array.from(buckets.entries()).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const allocations = entries.map(([key, items]) => {
    const exact = (items.length / all.length) * total;
    return { key, items, exact, base: Math.floor(exact), frac: exact - Math.floor(exact) };
  });
  let allocated = allocations.reduce((sum, a) => sum + a.base, 0);
  // 按最大余数分配剩余名额。
  const byFrac = allocations.slice().sort((a, b) => b.frac - a.frac);
  let idx = 0;
  while (allocated < total) {
    const a = byFrac[idx++ % byFrac.length]!;
    if (a.base < a.items.length) {
      a.base++;
      allocated++;
    }
  }

  const rng = mulberry32(seed);
  const chosen: Instance[] = [];
  for (const a of allocations) {
    // 使用 Fisher-Yates 部分洗牌，以确定性地从 `items` 中选出 `base` 个样本。
    const pool = a.items.slice();
    for (let i = 0; i < a.base; i++) {
      const j = i + Math.floor(rng() * (pool.length - i));
      [pool[i], pool[j]] = [pool[j]!, pool[i]!];
    }
    chosen.push(...pool.slice(0, a.base));
  }
  // 保留数据集顺序。
  const order = new Map(all.map((inst, i) => [inst.question_id, i] as const));
  chosen.sort((x, y) => (order.get(x.question_id) ?? 0) - (order.get(y.question_id) ?? 0));
  return chosen;
}

/** 将 "2023/04/10 (Mon) 23:07" 转换为 Date。 */
function parseLmeDate(s: string): Date {
  const m = s.match(/^(\d{4})\/(\d{2})\/(\d{2})\s+\([A-Za-z]+\)\s+(\d{2}):(\d{2})/);
  if (!m) throw new Error(`Bad LME date: ${s}`);
  const [, y, mo, d, hh, mm] = m;
  return new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(hh), Number(mm)));
}

function sessionToMessages(
  turns: { role: "user" | "assistant"; content: string }[],
  sessionDate: Date,
  actorModel: string,
) {
  let t = sessionDate.getTime();
  return turns.map((turn) => {
    t += 1000;
    if (turn.role === "user") {
      return { role: "user" as const, content: turn.content, timestamp: t };
    }
    return {
      role: "assistant" as const,
      content: [{ type: "text" as const, text: turn.content }],
      api: "anthropic-messages" as const,
      provider: "anthropic" as const,
      model: actorModel,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop" as const,
      timestamp: t,
    };
  });
}

function asText(content: AssistantMessage["content"]): string {
  return content
    .filter((b): b is { type: "text"; text: string } => (b as { type: string }).type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

async function ingestInstance(
  inst: Instance,
  dataDir: string,
  memoryModel: string,
): Promise<{ contextText: string }> {
  await mkdir(dataDir, { recursive: true });
  const session = new MemorySession({
    path: dataDir,
    openOptions: {
      init: async (db) => {
        await runMigrations(db);
      },
    },
    idleCloseMs: 200,
  });
  await session.withDb(async () => {});

  const cache = new MemoryContextCache();
  const settings = resolveObservationalMemorySettings(200_000);
  const cwd = `longmemeval/${inst.question_id}`;

  try {
    for (let i = 0; i < inst.haystack_sessions.length; i++) {
      const turns = inst.haystack_sessions[i]!;
      const sid = inst.haystack_session_ids[i]!;
      const date = parseLmeDate(inst.haystack_dates[i]!);
      const messages = sessionToMessages(turns, date, memoryModel);
      await updateObservationalMemory({
        session,
        memory: cache,
        sessionId: sid,
        effectiveContext: 200_000,
        actorModel: memoryModel,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        messages: messages as any,
        cwd,
        now: date,
      });
    }

    await rebuildMemoryContextPack({ session, cache, settings });

    const all = (await readAllObservations(session)).observations;
    const text = all
      .map((o) => {
        const date = o.observedDate ?? "????-??-??";
        const time = o.timeOfDay ?? "??:??";
        const stripped = stripObservationGroups(o.content).trim();
        return `[${date} ${time}] (${o.sessionId ?? "?"})\n${stripped}`;
      })
      .join("\n\n");
    return { contextText: text };
  } finally {
    await session.dispose();
  }
}

const READER_SYSTEM = `你需要仅根据下方记忆日志回答用户问题。记忆日志是助手对先前与该用户聊天会话的压缩观察；每条都有日期。

规则：
- 用一个简短句子或短语回答。不要添加“根据记忆日志”等开场白。
- 使用记忆日志中的日期，根据问题日期理解“何时”“多久以前”“最新的”“最近的”等表述。
- 如果记忆日志没有足够信息回答，请准确回复：“我不知道。”
- 对于情况随时间变化的“知识更新”类问题，优先使用日期最新的 observation。
`;

interface ReaderResult {
  hypothesis: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
}

async function answerQuestion(
  inst: Instance,
  memoryText: string,
  readerModelName: string,
): Promise<ReaderResult> {
  const model = resolveModelName(readerModelName);
  const userMessage = `QUESTION DATE: ${inst.question_date}

MEMORY LOG:
${memoryText || "(empty)"}

QUESTION:
${inst.question}

答案请简洁：`;
  const response = await complete(
    model,
    {
      systemPrompt: READER_SYSTEM,
      messages: [{ role: "user", content: userMessage, timestamp: Date.now() }] as Message[],
    },
    { maxTokens: 400 },
  );
  return {
    hypothesis: asText(response.content),
    tokensIn: response.usage.input,
    tokensOut: response.usage.output,
    costUsd: response.usage.cost.total,
  };
}

async function main() {
  const opts = parseArgs();
  const repoRoot = resolve(__dirname, "..", "..");
  const datasetPath = resolve(repoRoot, opts.dataset);
  const resultsDir = resolve(repoRoot, "benchmarks/longmemeval/results");
  const sessionsRoot = join(resultsDir, "sessions");
  const hypPath = join(resultsDir, `${opts.runName}.hyp.jsonl`);
  const logPath = join(resultsDir, `${opts.runName}.run.log`);
  const usagePath = join(resultsDir, `${opts.runName}.usage.jsonl`);

  await mkdir(resultsDir, { recursive: true });
  for (const p of [hypPath, logPath, usagePath]) {
    if (existsSync(p)) await rm(p);
  }

  console.log(`# LongMemEval harness`);
  console.log(`dataset:     ${datasetPath}`);
  console.log(`limit:       ${opts.limit}`);
  console.log(`run-name:    ${opts.runName}`);
  console.log(`model:       ${opts.model} (actor + memory)`);
  console.log(`concurrency: ${opts.concurrency}`);
  console.log(`hyp:         ${hypPath}`);

  const raw = await readFile(datasetPath, "utf8");
  const all = JSON.parse(raw) as Instance[];
  const items = opts.stratify
    ? stratifiedSample(all, opts.limit, opts.seed)
    : all.slice(0, opts.limit);
  if (opts.stratify) {
    const counts = new Map<string, number>();
    for (const inst of items)
      counts.set(inst.question_type, (counts.get(inst.question_type) ?? 0) + 1);
    const breakdown = Array.from(counts.entries())
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => `${k}=${v}`)
      .join(", ");
    console.log(`stratified:  ${items.length} items (seed=${opts.seed}) — ${breakdown}`);
  }

  const start = Date.now();
  let okCount = 0;
  let totalReaderIn = 0;
  let totalReaderOut = 0;
  let totalReaderCost = 0;
  let nextIndex = 0;
  let completed = 0;

  // 在 worker 之间串行化 JSONL append，避免行内容交错。
  let appendChain: Promise<void> = Promise.resolve();
  const appendLine = (path: string, line: string) => {
    appendChain = appendChain.then(() => appendFile(path, line));
    return appendChain;
  };

  async function worker(workerId: number) {
    while (true) {
      const i = nextIndex++;
      if (i >= items.length) return;
      const inst = items[i]!;
      const t0 = Date.now();
      const dataDir = join(sessionsRoot, inst.question_id);
      try {
        const { contextText } = await ingestInstance(inst, dataDir, opts.model);
        const reader = await answerQuestion(inst, contextText, opts.model);
        const wallMs = Date.now() - t0;
        await appendLine(
          hypPath,
          JSON.stringify({ question_id: inst.question_id, hypothesis: reader.hypothesis }) + "\n",
        );
        await appendLine(
          usagePath,
          JSON.stringify({
            question_id: inst.question_id,
            question_type: inst.question_type,
            reader_tokens_in: reader.tokensIn,
            reader_tokens_out: reader.tokensOut,
            reader_cost_usd: reader.costUsd,
            wall_ms: wallMs,
          }) + "\n",
        );
        totalReaderIn += reader.tokensIn;
        totalReaderOut += reader.tokensOut;
        totalReaderCost += reader.costUsd;
        okCount++;
        completed++;
        const dt = (wallMs / 1000).toFixed(1);
        const line = `[w${workerId} ${completed}/${items.length}] ${inst.question_id} (${inst.question_type}) ${dt}s — hyp="${reader.hypothesis.slice(0, 80).replace(/\n/g, " ")}"`;
        console.log(line);
        await appendLine(logPath, line + "\n");
      } catch (e) {
        completed++;
        const msg = e instanceof Error ? e.stack || e.message : String(e);
        const line = `[w${workerId} ${completed}/${items.length}] ${inst.question_id} FAILED: ${msg.slice(0, 600)}`;
        console.error(line);
        await appendLine(logPath, line + "\n");
        await appendLine(
          hypPath,
          JSON.stringify({ question_id: inst.question_id, hypothesis: "I don't know." }) + "\n",
        );
      }
    }
  }

  const workers = Array.from({ length: Math.min(opts.concurrency, items.length) }, (_, w) =>
    worker(w),
  );
  await Promise.all(workers);
  await appendChain;

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  await writeFile(
    join(resultsDir, `${opts.runName}.summary.json`),
    JSON.stringify(
      {
        dataset: datasetPath,
        limit: opts.limit,
        runName: opts.runName,
        model: opts.model,
        concurrency: opts.concurrency,
        stratify: opts.stratify,
        seed: opts.stratify ? opts.seed : undefined,
        ok: okCount,
        total: items.length,
        elapsedSec: Number(elapsed),
        readerTokensIn: totalReaderIn,
        readerTokensOut: totalReaderOut,
        readerCostUsd: Number(totalReaderCost.toFixed(6)),
      },
      null,
      2,
    ),
  );
  console.log(`Done: ${okCount}/${items.length} answered in ${elapsed}s.`);
  console.log(
    `Reader tokens: in=${totalReaderIn} out=${totalReaderOut} cost=$${totalReaderCost.toFixed(4)}`,
  );
  console.log(`hyp file: ${hypPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
