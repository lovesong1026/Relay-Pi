/**
 * 将 `memory.db` PGlite 存储中的观察记录转储为 JSON，用于调试或创建 fixture。
 * 默认来源是当前用户的 `~/.relay-pi/memory.db`，默认目标为 stdout。
 *
 * 这是观察式记忆出现问题时的规范复现步骤：转储实时存储，再将 JSON
 * 传给 eval（`evals/fixtures/global-reflect/seed.ts`），这样无需触碰生产记忆
 * 就能得到确定性复现。
 *
 * 用法：
 *   bun run scripts/dump-memory.ts [options]
 *
 * 选项：
 *   --db <path>            PGlite 来源路径（默认：~/.relay-pi/memory.db）
 *   --out <path>           写入文件（默认：stdout）
 *   --kind <k>             按记录类型筛选：observation | reflection | all（默认：all）
 *   --since <iso|days>     仅保留在此日期或之后创建的记录。接受
 *                          ISO-8601（`2026-05-01T00:00:00Z`）、`YYYY-MM-DD`，
 *                          或 `7d` / `48h` 这类相对形式，表示“距今不超过该时长”。
 *   --until <iso|days>     仅保留在此日期或之前创建的记录。格式相同。
 *   --session <id>         仅保留指定会话 id 的记录。可重复传入；
 *                          对全局 prune 记录传入 `__global_reflection__`。
 *   --priority <p>         按优先级筛选：high | medium | low。可重复传入。
 *   --tag <name>           仅保留带有 <name> 标签的记录。可重复传入；多个选项之间为 AND。
 *   --limit <n>            限制写出的记录数（按最新优先）。
 *   --pretty               以易读格式输出 JSON（默认：紧凑格式）。
 *   --stats                将单行摘要输出到 stderr（数量、token、年龄范围）。
 *   -h, --help             显示此帮助。
 */
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { runMigrations } from "../src/memory/migrations.js";
import { MemorySession } from "../src/memory/session.js";
import { readAllObservations } from "../src/memory/storage.js";
import type { Observation } from "../src/types/memory.js";

interface Options {
  db: string;
  out?: string;
  kind: "observation" | "reflection" | "all";
  since?: number;
  until?: number;
  sessions: Set<string>;
  priorities: Set<string>;
  tags: string[];
  limit?: number;
  pretty: boolean;
  stats: boolean;
}

const DAY_MS = 86_400_000;

function parseTime(raw: string): number {
  const relative = raw.match(/^(\d+(?:\.\d+)?)(d|h|m)$/i);
  if (relative) {
    const n = Number(relative[1]);
    const unit = relative[2]!.toLowerCase();
    const ms = unit === "d" ? n * DAY_MS : unit === "h" ? n * 3_600_000 : n * 60_000;
    return Date.now() - ms;
  }
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) fail(`Invalid time: ${raw}`);
  return parsed;
}

function fail(message: string): never {
  process.stderr.write(`dump-memory: ${message}\n`);
  process.exit(1);
}

function printHelp(): void {
  process.stdout.write(`Usage: bun run scripts/dump-memory.ts [options]

Options:
  --db <path>           Source PGlite path (default: ~/.relay-pi/memory.db)
  --out <path>          Write to file (default: stdout)
  --kind <k>            observation | reflection | all (default: all)
  --since <iso|Nd|Nh>   Only rows created on/after this time
  --until <iso|Nd|Nh>   Only rows created on/before this time
  --session <id>        Filter by session id (repeatable)
  --priority <p>        high | medium | low (repeatable)
  --tag <name>          Filter by tag (repeatable, AND)
  --limit <n>           Cap rows written (newest first)
  --pretty              Pretty-print JSON
  --stats               Print summary to stderr
  -h, --help            Show this help
`);
}

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    db: join(homedir(), ".relay-pi", "memory.db"),
    kind: "all",
    sessions: new Set(),
    priorities: new Set(),
    tags: [],
    pretty: false,
    stats: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const next = () => {
      const v = argv[++i];
      if (v === undefined) fail(`Missing value for ${arg}`);
      return v;
    };
    switch (arg) {
      case "-h":
      case "--help":
        printHelp();
        process.exit(0);
      case "--db":
        opts.db = resolve(next());
        break;
      case "--out":
        opts.out = resolve(next());
        break;
      case "--kind": {
        const v = next();
        if (v !== "observation" && v !== "reflection" && v !== "all") {
          fail(`--kind must be observation | reflection | all (got ${v})`);
        }
        opts.kind = v;
        break;
      }
      case "--since":
        opts.since = parseTime(next());
        break;
      case "--until":
        opts.until = parseTime(next());
        break;
      case "--session":
        opts.sessions.add(next());
        break;
      case "--priority": {
        const v = next();
        if (v !== "high" && v !== "medium" && v !== "low") {
          fail(`--priority must be high | medium | low (got ${v})`);
        }
        opts.priorities.add(v);
        break;
      }
      case "--tag":
        opts.tags.push(next());
        break;
      case "--limit": {
        const n = Number(next());
        if (!Number.isFinite(n) || n <= 0) fail(`--limit must be a positive number`);
        opts.limit = Math.floor(n);
        break;
      }
      case "--pretty":
        opts.pretty = true;
        break;
      case "--stats":
        opts.stats = true;
        break;
      default:
        fail(`Unknown option: ${arg}`);
    }
  }
  return opts;
}

function matches(row: Observation, opts: Options): boolean {
  if (opts.kind !== "all" && row.kind !== opts.kind) return false;
  if (opts.since !== undefined && row.createdAt < opts.since) return false;
  if (opts.until !== undefined && row.createdAt > opts.until) return false;
  if (
    opts.sessions.size > 0 &&
    (row.sessionId === undefined || !opts.sessions.has(row.sessionId))
  ) {
    return false;
  }
  if (opts.priorities.size > 0 && !opts.priorities.has(row.priority)) return false;
  for (const tag of opts.tags) {
    if (!row.tags.includes(tag)) return false;
  }
  return true;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const session = new MemorySession({
    path: opts.db,
    openOptions: { init: async (db) => runMigrations(db) },
    lockWaitBudgetMs: 60_000,
    idleCloseMs: 1_000,
  });

  try {
    const snapshot = await readAllObservations(session);
    let rows = snapshot.observations.filter((row) => matches(row, opts));
    // 按最新优先，这样 --limit 会保留最新的一段记录。
    rows.sort((a, b) => b.createdAt - a.createdAt);
    if (opts.limit !== undefined) rows = rows.slice(0, opts.limit);

    const now = Date.now();
    const dumped = rows.map((row) => ({
      id: row.id,
      createdAt: row.createdAt,
      lastUsedAt: row.lastUsedAt,
      ageDays: (now - row.createdAt) / DAY_MS,
      ...(row.sessionId !== undefined ? { sessionId: row.sessionId } : {}),
      kind: row.kind,
      observedDate: row.observedDate,
      ...(row.referencedDate !== undefined ? { referencedDate: row.referencedDate } : {}),
      ...(row.relativeDate !== undefined ? { relativeDate: row.relativeDate } : {}),
      ...(row.timeOfDay !== undefined ? { timeOfDay: row.timeOfDay } : {}),
      priority: row.priority,
      source: row.source,
      content: row.content,
      tags: row.tags,
    }));

    const json = opts.pretty
      ? `${JSON.stringify(dumped, null, 2)}\n`
      : `${JSON.stringify(dumped)}\n`;
    if (opts.out) {
      writeFileSync(opts.out, json);
    } else {
      process.stdout.write(json);
    }

    if (opts.stats) {
      const chars = dumped.reduce((sum, r) => sum + r.content.length, 0);
      const ages = dumped.map((r) => r.ageDays);
      const youngest = ages.length > 0 ? Math.min(...ages).toFixed(2) : "n/a";
      const oldest = ages.length > 0 ? Math.max(...ages).toFixed(2) : "n/a";
      process.stderr.write(
        `dump-memory: ${dumped.length} row(s) (${snapshot.observations.length} total), ` +
          `~${Math.round(chars / 4)} content tokens, age ${youngest}d–${oldest}d\n`,
      );
    }
  } finally {
    await session.dispose();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
