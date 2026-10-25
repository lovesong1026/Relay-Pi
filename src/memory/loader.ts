import type { PGlite } from "@electric-sql/pglite";
import type { Observation, ObservationKind, ObservationPriority } from "../types/memory.js";
import { estimateTokens } from "./observational.js";

/**
 * 加载用于渲染在 message tail 之前的排序 memory pack。
 *
 * loader 沿一个轴将持久化 memory 分成两层——当前 row 的 session_id 是否匹配当前运行器的 Session？
 *
 *   - Local 层：session_id 等于当前 Session 的 row。当前 Session 对自身的压缩视图
 *     （observation 加上可能替换它们的 reflection）按时间顺序、不排序地渲染，因为它代表
 *     对话自身的压缩摘要；重新排序会丢失时间信号。
 *
 *   - Global 层：其他所有 Session 的 row，按 `priority * usageDecay * kindBias` 排序。
 *     Reflection 通过 `reflectionBias` 排在 raw observation 之前，manual（用户精选）row
 *     再通过 `manualBias` 排在更前。使用固定 token budget 贪心适配，使 prompt 前缀无论持久化
 *     memory 数据库增长到多大都保持有界。
 *
 * 两层刻意使用不同 heading 渲染，让 model 能区分当前对话内容和跨 Session 累积的知识。
 * 渲染顺序为 `system prompt -> global -> local -> message history`：global pack 最稳定
 *（只在压缩时重建），local 稳定性居中（每次 reflection 替换），message tail 是唯一逐回合增长的部分。
 *
 * 排序完全下推到 SQL。完整 score
 * `priority * 0.5^((now - last_used_at) / h) * kindBias` 可分解为
 * `const(now) * priority * 2^(last_used_at / h) * kindBias`；`const(now)` 在一次 ranking pass
 * 的所有候选中相同，因此不会影响顺序。等价的 log 空间形式是
 * `rank = ln(priority) + ln(kindBias) + last_used_at / h`。它只依赖 column 和 config——
 * Postgres 完成计算，`idx_obs_kind_priority_lastused` index 覆盖 ORDER BY，JS 只做最后的
 * greedy token-budget fit。
 */

export const PRIORITY_WEIGHT: Record<ObservationPriority, number> = {
  high: 3,
  medium: 2,
  low: 1,
};

/** `observationScore` 的可调输入；对应 loader 的 ranking config。 */
export interface ObservationScoreOptions {
  /** 应用于距 `lastUsedAt` 时间的半衰期（毫秒）。 */
  recencyHalfLifeMs: number;
  /** 应用于 `kind = 'reflection'` row 的乘数。 */
  reflectionBias: number;
  /** 应用于 `kind = 'manual'` row 的乘数。 */
  manualBias: number;
  /** 应用于 `kind = 'note'` row 的乘数。 */
  noteBias: number;
}

/**
 * 计算一条 observation 的绝对 global-pack score：
 * `priorityWeight * 0.5^((now - lastUsedAt)/halfLife) * kindBias`。
 *
 * {@link loadGlobalPack} 的 SQL ranking 只需要单调的 log-space 形式，因为 `0.5^(now/h)`
 * 在一次 ranking pass 内是常量。希望得到每个 row 的真实数值时——例如 `relay-pi memory`
 * TUI 渲染 score 列并按此 exact score 排序——调用此函数，确保显示值与运行器使用的公式一致。
 */
export function observationScore(
  observation: Pick<Observation, "priority" | "kind" | "lastUsedAt">,
  now: number,
  options: ObservationScoreOptions,
): number {
  const priorityWeight = PRIORITY_WEIGHT[observation.priority];
  const kindBias =
    observation.kind === "reflection"
      ? options.reflectionBias
      : observation.kind === "manual"
        ? options.manualBias
        : observation.kind === "note"
          ? options.noteBias
          : 1.0;
  const decay = Math.pow(0.5, (now - observation.lastUsedAt) / options.recencyHalfLifeMs);
  return priorityWeight * decay * kindBias;
}

export interface LoadGlobalPackOptions {
  /**
   * 从 global pack 中排除其 row 的 Session。当前运行器的 Session 以完整 fidelity 位于 local
   * pack，因此将它们计入 global ranking 会重复计算，并挤出跨 Session signal。传入 `undefined`
   * 会包含所有 row（例如用户希望不受限制地搜索时的 `recall_memory` tool）。
   */
  excludeSessionId?: string;
  /** 结果中 `content` 的最大 token 数，默认为 8000。 */
  tokenBudget?: number;
  /** 应用于距 `last_used_at` 时间的半衰期（毫秒）。 */
  recencyHalfLifeMs: number;
  /** 作为 `kind = 'reflection'` factor 应用的 reflection bias 乘数。 */
  reflectionBias: number;
  /** 作为 `kind = 'manual'` factor 应用的 manual bias 乘数。 */
  manualBias: number;
  /** 作为 `kind = 'note'` factor 应用的 note bias 乘数。 */
  noteBias: number;
}

/**
 * 从除调用方外的每个 Session 加载最高排名的 row，直到达到 token budget。返回值按排名
 * 降序排列，使 renderer 可以在视觉上保留排序。
 *
 * SQL `ORDER BY` 物化 `ln(priority) + ln(kindBias) + last_used_at / h`；它相对于完整
 * score 单调，因此数据库返回的顺序与 runtime ranking 完全一致。JS 随后贪心遍历结果，
 * 跳过会超出 token budget 的 row 但继续向后看——排名更后面的较小 row 仍可能适配；仅因为
 * 最高排名的 row 是长 reflection 就让预算空一半，会浪费 prompt 空间。
 */
export async function loadGlobalPack(
  db: PGlite,
  options: LoadGlobalPackOptions,
): Promise<Observation[]> {
  const tokenBudget = options.tokenBudget ?? 8000;

  // 能够适配的 row 数量上限：假设每条 row 至少有约 50 token 的内容。向 planner 请求更多是
  // 无用工作；请求更少则有风险在 budget 用尽前耗尽 greedy-fit 候选。
  const candidateLimit = Math.max(50, Math.ceil(tokenBudget / 50));

  const params: unknown[] = [
    PRIORITY_WEIGHT.high,
    PRIORITY_WEIGHT.medium,
    PRIORITY_WEIGHT.low,
    options.reflectionBias,
    options.manualBias,
    options.noteBias,
    options.recencyHalfLifeMs,
  ];
  let scopeClause = "";
  if (options.excludeSessionId !== undefined) {
    // NULL session_id row（旧版、sessionId tracking 之前）保留在 global pool，因为它们不可能
    // 匹配任何当前 Session。没有 `IS DISTINCT FROM` 时，Postgres 会将 NULL = X 视为 NULL，
    // 从而在每次 query 中过滤掉这些旧 row。
    scopeClause = `WHERE session_id IS DISTINCT FROM $${params.length + 1}`;
    params.push(options.excludeSessionId);
  }
  params.push(candidateLimit);
  const limitParam = params.length;

  const sql = `SELECT id, created_at, last_used_at, session_id, kind, observed_date, referenced_date,
              relative_date, time_of_day, priority, source_json, content, tags_json
       FROM observations
       ${scopeClause}
       ORDER BY
         ln(CASE priority WHEN 'high' THEN $1::float
                          WHEN 'medium' THEN $2::float
                          ELSE $3::float END)
         + ln(CASE kind WHEN 'reflection' THEN $4::float
                        WHEN 'manual' THEN $5::float
                        WHEN 'note' THEN $6::float
                        ELSE 1.0 END)
         + last_used_at::float / $7::float
         DESC
       LIMIT $${limitParam}`;

  const result = await db.query<GlobalRow>(sql, params);
  const ranked = result.rows.map(rowToObservation);

  const packed: Observation[] = [];
  let usedTokens = 0;
  for (const observation of ranked) {
    const tokens = estimateTokens(observation.content);
    if (usedTokens + tokens > tokenBudget) {
      continue;
    }
    packed.push(observation);
    usedTokens += tokens;
  }
  return packed;
}

export interface LoadLocalPackOptions {
  sessionId: string;
}

/**
 * 加载此 Session 产生的每个 row，按时间顺序排列。Local pack 表示 Session 自己的压缩摘要——
 * 替换早期 transcript 的 observation 和 reflection——因此无论大小都完整渲染。Local 层的
 * 有界性由现有 observer/reflector pipeline 负责：它们的阈值防止集合无限增长，过大时由
 * reflection 再次将其压缩。
 */
export async function loadLocalPack(
  db: PGlite,
  options: LoadLocalPackOptions,
): Promise<Observation[]> {
  const result = await db.query<GlobalRow>(
    `SELECT id, created_at, last_used_at, session_id, kind, observed_date, referenced_date,
            relative_date, time_of_day, priority, source_json, content, tags_json
     FROM observations
     WHERE session_id = $1
     ORDER BY created_at ASC`,
    [options.sessionId],
  );
  return result.rows.map(rowToObservation);
}

interface GlobalRow {
  id: string;
  created_at: number;
  last_used_at: number;
  session_id: string | null;
  kind: ObservationKind;
  observed_date: string;
  referenced_date: string | null;
  relative_date: string | null;
  time_of_day: string | null;
  priority: ObservationPriority;
  source_json: string;
  content: string;
  tags_json: string;
}

function rowToObservation(row: GlobalRow): Observation {
  return {
    id: row.id,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    ...(row.session_id !== null ? { sessionId: row.session_id } : {}),
    kind: row.kind,
    observedDate: row.observed_date,
    ...(row.referenced_date !== null ? { referencedDate: row.referenced_date } : {}),
    ...(row.relative_date !== null ? { relativeDate: row.relative_date } : {}),
    ...(row.time_of_day !== null ? { timeOfDay: row.time_of_day } : {}),
    priority: row.priority,
    source: JSON.parse(row.source_json) as Observation["source"],
    content: row.content,
    tags: JSON.parse(row.tags_json) as string[],
  };
}
