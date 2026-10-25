import { DEFAULT_MEMORY_DB_PATH } from "../session/session-manager.js";
import type { Observation, ObservationKind, ObservationPriority } from "../types/memory.js";
import { printMemoryHelp } from "./help.js";
import { type MemoryQueryFilters, scoreObservation, withMemoryDb } from "./memory-db.js";
import { toMemoryJson } from "./memory-json.js";
import { resolveUserPath, usageError } from "./shared.js";

interface MemoryQueryIO {
  stdout: NodeJS.WritableStream;
}

/**
 * 观察记录及其全局记忆包排名分数。`packScore` 与
 * 规范的 {@link toMemoryJson} 结构输出的字段同名，因此表格
 * 渲染器和 JSON 输出读取同一个字段，避免偏离。
 */
type ScoredObservation = Observation & { packScore: number };

/**
 * 构建必须枚举 `T` 的*每个*成员的运行时筛选列表。
 * 单独的 `satisfies readonly T[]` 只检查各元素是否为有效的 `T`；
 * 它会默许成员缺失，正是这个缺口使 `note` 从
 * 类型筛选中遗漏，导致 `--type note` 被拒绝。此辅助函数会在
 * 数组遗漏任一联合类型成员时编译失败，因此新增
 * `ObservationKind`/优先级/来源时，必须同步扩展对应筛选列表。
 */
function exhaustiveList<T extends string>() {
  return <L extends readonly T[]>(list: [T] extends [L[number]] ? L : never): L => list;
}

const KINDS = exhaustiveList<ObservationKind>()(["observation", "reflection", "note", "manual"]);
/**
 * 规范的 `--priority` 和 `--source` 值集合，通过编译期检查
 * 确保枚举所有联合类型成员。导出给同级记忆命令
 * （例如 `memory add`），使其依据同一事实来源校验相同维度，
 * 而非重复声明可能悄然偏离的并行字面量列表。
 */
export const PRIORITIES = exhaustiveList<ObservationPriority>()(["high", "medium", "low"]);
type SourceKind = Observation["source"]["kind"];
export const SOURCES = exhaustiveList<SourceKind>()(["user", "agent", "system", "api", "import"]);

export interface MemoryQueryOptions {
  dbPath: string;
  json: boolean;
  filters: MemoryQueryFilters;
  waitBudgetMs?: number;
  /**
   * 调用请求非 TUI 查询时为 true，即传入了
   * `--json` 或任意筛选标志。直接调用 `relay-pi memory`（仅 `--db`/`--wait`）
   * 时保持 false，改为打开交互式 TUI。
   */
  queryMode: boolean;
}

/** 解析 UTC 日期筛选条件；仅含日期的边界覆盖全天。 */
function parseDateBound(raw: string, flag: string, edge: "start" | "end"): number {
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const iso = `${raw}T${edge === "start" ? "00:00:00.000" : "23:59:59.999"}Z`;
    const ms = Date.parse(iso);
    if (Number.isNaN(ms)) usageError(`Invalid ${flag} date: ${raw}`);
    // 拒绝不存在的日历日期（如 2026-02-31），JS 会将其静默
    // 规范化为另一天，而不是返回 NaN；否则输入错误会
    // 移动 createdAt 窗口，导致导出错误的记录。
    if (new Date(ms).toISOString().slice(0, 10) !== raw) {
      usageError(`Invalid ${flag} date: ${raw} is not a real calendar date`);
    }
    return ms;
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(raw)) {
    const ms = Date.parse(`${raw}Z`);
    if (Number.isNaN(ms)) usageError(`Invalid ${flag} datetime: ${raw}`);
    // 对日期时间形式（如 2026-02-31T00:00:00）进行相同的往返校验。
    if (new Date(ms).toISOString().slice(0, 19) !== raw) {
      usageError(`Invalid ${flag} datetime: ${raw} is not a real calendar datetime`);
    }
    return ms;
  }
  usageError(`Invalid ${flag} value: ${raw} (expected YYYY-MM-DD or YYYY-MM-DDTHH:MM:SS)`);
}

/**
 * 根据封闭集合校验标志值；缺失或不在集合中时以 `64`
 * （用法错误）退出。各记忆子命令共享此函数，使每个枚举
 * 标志都报告相同格式的消息和退出码。
 */
export function parseEnum<T extends string>(
  raw: string | undefined,
  allowed: readonly T[],
  flag: string,
): T {
  if (!raw || raw.startsWith("-")) usageError(`Missing value for ${flag}`);
  if (!(allowed as readonly string[]).includes(raw)) {
    usageError(`Invalid ${flag} value: ${raw} (expected one of ${allowed.join(", ")})`);
  }
  return raw as T;
}

/**
 * 解析共享的 `relay-pi memory` 参数集合。同一组标志同时驱动
 * 交互式 TUI（直接调用）和可脚本化查询（任意筛选条件或
 * `--json`）；`queryMode` 记录调用方请求的路径。处理了
 * `--help` 后返回 `undefined`。
 */
export function parseMemoryArgs(args: string[]): MemoryQueryOptions | undefined {
  let dbPath = DEFAULT_MEMORY_DB_PATH;
  let json = false;
  let waitBudgetMs: number | undefined;
  let hasFilter = false;
  const filters: MemoryQueryFilters = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    switch (arg) {
      case "--db":
        if (!args[i + 1] || args[i + 1]?.startsWith("-")) usageError(`Missing value for ${arg}`);
        dbPath = resolveUserPath(args[++i]!);
        break;
      // `--type` 和 `--kind` 是同一 `Observation.kind` 维度的别名。
      case "--type":
      case "--kind":
        filters.kind = parseEnum(args[++i], KINDS, arg);
        hasFilter = true;
        break;
      case "--priority":
        filters.priority = parseEnum(args[++i], PRIORITIES, arg);
        hasFilter = true;
        break;
      case "--source":
        filters.source = parseEnum(args[++i], SOURCES, arg);
        hasFilter = true;
        break;
      case "--session": {
        const raw = args[++i];
        if (!raw || raw.startsWith("-")) usageError(`Missing value for ${arg}`);
        filters.sessionId = raw;
        hasFilter = true;
        break;
      }
      case "--from": {
        const raw = args[++i];
        if (!raw || raw.startsWith("-")) usageError(`Missing value for ${arg}`);
        filters.fromMs = parseDateBound(raw, arg, "start");
        hasFilter = true;
        break;
      }
      case "--to": {
        const raw = args[++i];
        if (!raw || raw.startsWith("-")) usageError(`Missing value for ${arg}`);
        filters.toMs = parseDateBound(raw, arg, "end");
        hasFilter = true;
        break;
      }
      case "--json":
        json = true;
        break;
      case "--wait": {
        const raw = args[++i];
        const seconds = Number(raw);
        if (!Number.isFinite(seconds) || seconds < 0) {
          usageError(`Invalid --wait value: ${raw} (expected non-negative number of seconds)`);
        }
        waitBudgetMs = seconds * 1000;
        break;
      }
      case "--help":
      case "-h":
        printMemoryHelp();
        return undefined;
      default:
        usageError(`Unknown memory option: ${arg}`);
    }
  }

  if (filters.fromMs !== undefined && filters.toMs !== undefined && filters.fromMs > filters.toMs) {
    usageError("--from must not be after --to");
  }

  return { dbPath, json, filters, waitBudgetMs, queryMode: json || hasFilter };
}

function truncate(value: string, max: number): string {
  const collapsed = value.replace(/\s+/g, " ");
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max - 1)}…`;
}

export function formatMemoryTable(observations: ScoredObservation[]): string {
  if (observations.length === 0) {
    return "No memories matched. Adjust the filters or run `relay-pi memory --help`.";
  }
  const rows = observations.map((o) => ({
    created: new Date(o.createdAt).toISOString().slice(0, 10),
    kind: o.kind,
    priority: o.priority,
    source: o.source.kind,
    score: o.packScore.toFixed(2),
    content: truncate(o.content, 60),
    id: o.id,
  }));
  const headers = {
    created: "CREATED",
    kind: "KIND",
    priority: "PRIORITY",
    source: "SOURCE",
    score: "SCORE",
    content: "CONTENT",
    id: "MEMORY ID",
  };
  const width = (key: keyof typeof headers, cap: number) =>
    Math.min(cap, Math.max(headers[key].length, ...rows.map((row) => row[key].length)));
  const w = {
    created: width("created", 10),
    kind: width("kind", 11),
    priority: width("priority", 8),
    source: width("source", 6),
    score: width("score", 8),
    content: width("content", 60),
    id: width("id", 20),
  };
  const line = (cells: typeof headers) =>
    [
      cells.created.padEnd(w.created),
      cells.kind.padEnd(w.kind),
      cells.priority.padEnd(w.priority),
      cells.source.padEnd(w.source),
      cells.score.padStart(w.score),
      truncate(cells.content, w.content).padEnd(w.content),
      cells.id,
    ].join("  ");
  return [line(headers), ...rows.map(line)].join("\n");
}

/**
 * 运行 `relay-pi memory` 的非 TUI 查询路径：获取筛选后的记录，
 * 计算每条记录的全局记忆包分数，并打印 JSON 或对齐表格。
 */
export async function runMemoryQuery(
  options: MemoryQueryOptions,
  io: MemoryQueryIO = { stdout: process.stdout },
): Promise<void> {
  const observations = await withMemoryDb(
    options.dbPath,
    (db) => db.queryObservations(options.filters),
    { waitBudgetMs: options.waitBudgetMs },
  );
  // 使用同一个 `now` 评分，使每条记录的值可比较。
  const now = Date.now();
  const scored: ScoredObservation[] = observations.map((o) => ({
    ...o,
    packScore: scoreObservation(o, now),
  }));

  if (options.json) {
    const json = scored.map((o) => toMemoryJson(o, { packScore: o.packScore }));
    io.stdout.write(`${JSON.stringify(json, null, 2)}\n`);
    return;
  }
  io.stdout.write(`${formatMemoryTable(scored)}\n`);
}
