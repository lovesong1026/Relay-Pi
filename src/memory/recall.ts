import type { PGlite } from "@electric-sql/pglite";
import { Type } from "typebox";
import { generateStructuredOutput } from "../core/structured-output.js";
import type { Observation, ObservationKind, ObservationPriority } from "../types/memory.js";
import type { EmbedFn } from "./embedding.js";
import type { MemorySession } from "./session.js";

/**
 * 对持久化记忆数据库执行混合检索。
 *
 * 实现 gbrain / Zep / Letta 采用的模式：向量检索和关键词检索并行运行，
 * 结果通过 Reciprocal Rank Fusion 合并。向量检索覆盖模糊改写；关键词检索
 * 覆盖嵌入容易漏掉的精确 token（专有名词、ID、代码符号）。RRF 不需要分数
 * 归一化，并且对两侧排名调整都保持稳定。
 *
 * 两条路径可以独立降级：
 *   - 没有 embedding client 或 endpoint 不可用：跳过向量路径，函数返回仅含
 *     关键词结果的结果。工具层只记录一次；用户仍然可以获得召回结果。
 *   - 关键词查询为空（空白或标点）：关键词路径不返回结果；向量路径单独提供结果。
 *
 * 如果两条路径都没有返回任何结果（没有 API key 且没有 FTS 匹配），函数返回
 * 空列表而不是抛错，使工具可以回答“没有匹配项”，而不会产生错误界面。
 */

/** 每条检索路径在融合前返回的默认 top-K。经验上这是健康的过采样数量。 */
const PER_PATH_TOP_K = 30;
/**
 * RRF 常数。取值与 gbrain 及原始 Cormack 等人的 RRF 论文建议一致。
 * 较小的 k 会更强地提高列表顶部的权重；默认值在 top-1 的敏锐度和
 * 不同分数尺度路径之间的稳定性之间取得平衡。
 */
const RRF_K = 60;

/**
 * 对融合后的 recall 分数施加温和的 kind 先验，使整理过的行在可比结果中略占优势，
 * 但不会压制相关性。
 *
 * 该值有意远小于 loader 的 `manualBias`（100）：全局 pack 是始终启用且与相关性
 * 无关的排序，因此使用很大的因子；recall 则是相关性优先的搜索。这里如果使用
 * 100 倍因子，任何弱匹配的手工行都会浮到顶部，违背查询目的，所以先验只作为
 * 已经通过关键词/向量匹配的行之间的平局裁决。
 */
const RECALL_KIND_BIAS: Record<ObservationKind, number> = {
  manual: 1.5,
  note: 1.3,
  reflection: 1.25,
  observation: 1.0,
};

/** 温和的 priority 先验；平局裁决理由与 {@link RECALL_KIND_BIAS} 相同。 */
const RECALL_PRIORITY_BIAS: Record<ObservationPriority, number> = {
  high: 1.2,
  medium: 1.0,
  low: 0.9,
};

export type RecallScope = "session" | "global" | "all";

export interface RecallMemoryOptions {
  /** 拥有 PGlite 句柄和跨进程锁的 Memory session。
   * recall 会把每次查询包装在一次 `withDb` 中，确保关键词、向量和 hydration
   * 使用同一个打开的数据库。无法获取锁时，recall 返回空结果而不是抛错，
   * 使工具层能够优雅降级。
   */
  session: MemorySession;
  /**
   * embedding callable。未提供（或调用抛错）时，会静默跳过向量路径，
   * recall 回退为仅关键词检索。
   */
  embed?: EmbedFn;
  /** 用户或 Agent 的自由文本查询。 */
  query: string;
  /** 返回的融合结果最大数量，默认为 8。 */
  limit?: number;
  /** 限定为当前 session、其他所有 session，或两者；默认为 "all"。 */
  scope?: RecallScope;
  /**
   * 用于评估 `scope` 过滤器的 session id。scope 为 "session" 或 "global" 时必填；
   * scope 为 "all" 时忽略。
   */
  sessionId?: string;
}

export interface RecallMemoryResult {
  observations: Observation[];
  /** 向量路径是否实际运行。可用于工具输出标记降级模式。 */
  vectorSearchAttempted: boolean;
  /**
   * 向量路径是否运行完成。只有 embed 调用或向量查询抛错时才为 false；
   * 健康（即使为空）的索引返回零条结果仍算检索成功，因此调用方不能
   * 将空结果视为降级模式。
   */
  vectorSearchSucceeded: boolean;
}

export async function recallMemory(options: RecallMemoryOptions): Promise<RecallMemoryResult> {
  const limit = options.limit ?? 8;
  const scope = options.scope ?? "all";

  // 没有 session id 时执行 session-scoped recall 属于调用方错误；返回空结果，
  // 不要降级为不受限制的全局搜索。
  if (scope === "session" && !options.sessionId) {
    return { observations: [], vectorSearchAttempted: false, vectorSearchSucceeded: false };
  }

  const result = await options.session.withDb(async (db) => {
    const keywordHits = await keywordSearch(db, options.query, scope, options.sessionId);

    let vectorAttempted = false;
    let vectorFailed = false;
    let vectorHits: ScoredHit[] = [];
    if (options.embed) {
      vectorAttempted = true;
      try {
        vectorHits = await vectorSearch(db, options.embed, options.query, scope, options.sessionId);
      } catch {
        // embedding 不可用或网络短暂抖动——回退为仅关键词检索。调用方会向用户
        // 展示降级模式。
        vectorFailed = true;
      }
    }

    const fusedIds = reciprocalRankFusion([keywordHits, vectorHits]).slice(0, limit);
    const observations = await hydrate(db, fusedIds);

    return {
      observations,
      vectorSearchAttempted: vectorAttempted,
      vectorSearchSucceeded: vectorAttempted && !vectorFailed,
    };
  });
  return result ?? { observations: [], vectorSearchAttempted: false, vectorSearchSucceeded: false };
}

export interface RecallMemoryExpandedOptions extends RecallMemoryOptions {
  /**
   * 设置后，使用此模型生成 `query` 的改写，并在原始查询之上为每种表述
   * 执行一次 recall。这样可以提高模糊查询的召回率；未设置时使用单查询路径。
   * 没有模型（或希望降低延迟）的调用方可以省略它。
   */
  expansionModel?: string;
}

export interface RecallMemoryExpandedResult extends RecallMemoryResult {
  /** 改写扩展是否实际贡献了额外的查询执行。 */
  expanded: boolean;
  /**
   * 每个 observation id 的最终跨查询 RRF 融合相关性分数——与
   * {@link RecallMemoryResult.observations} 排序使用的分数相同。以 id 为键，
   * 这样序列化每行的调用方（例如 `memory recall --json`）可以附加
   * `relevanceScore`，而无需重新计算融合。`observations` 数组及其顺序不变；
   * 调用方可以完全忽略此字段。
   */
  relevanceById: Map<string, number>;
}

/**
 * `recall_memory` 工具和 `relay-pi memory recall` CLI 共用的完整 recall 流程：
 * 可选地将查询扩展为多种改写，为每种表述执行一次 {@link recallMemory}，
 * 再使用 Reciprocal Rank Fusion 融合排名结果，使任一表述中表现良好的行都能
 * 上升到顶部。将逻辑集中在这里，确保工具和 CLI 对同一个查询返回完全相同的排序。
 *
 * 没有 `expansionModel`（或改写生成失败）时，流程恰好只调用一次
 * {@link recallMemory}，因此单查询路径仍是低成本默认选项。
 */
export async function recallMemoryExpanded(
  options: RecallMemoryExpandedOptions,
): Promise<RecallMemoryExpandedResult> {
  const limit = options.limit ?? 8;

  const queries = [options.query];
  if (options.expansionModel) {
    queries.push(...(await generateQueryParaphrases(options.query, options.expansionModel)));
  }
  const expanded = queries.length > 1;

  const runs = await Promise.all(
    queries.map((query) =>
      recallMemory({
        session: options.session,
        ...(options.embed ? { embed: options.embed } : {}),
        query,
        // 每次查询都过采样，以便扩展开启时，后融合 top-K 能从更丰富的候选池中选取。
        limit: expanded ? limit * 2 : limit,
        ...(options.scope ? { scope: options.scope } : {}),
        ...(options.sessionId ? { sessionId: options.sessionId } : {}),
      }),
    ),
  );

  const fused = reciprocalRankFusionScored(
    runs.map((run) => run.observations.map((observation, rank) => ({ id: observation.id, rank }))),
  ).slice(0, limit);
  const byId = new Map(
    runs.flatMap((run) => run.observations).map((observation) => [observation.id, observation]),
  );
  const relevanceById = new Map<string, number>();
  const observations: Observation[] = [];
  for (const { id, score } of fused) {
    const observation = byId.get(id);
    if (!observation) continue;
    observations.push(observation);
    relevanceById.set(id, score);
  }

  return {
    observations,
    vectorSearchAttempted: runs.some((run) => run.vectorSearchAttempted),
    vectorSearchSucceeded: runs.some((run) => run.vectorSearchSucceeded),
    expanded,
    relevanceById,
  };
}

const paraphraseSchema = Type.Object({
  paraphrases: Type.Array(Type.String(), { minItems: 1, maxItems: 4 }),
});

/** 将查询改写为最多两种替代表述，并通过低成本模型生成。两种是 gbrain 消融实验中的最佳平衡点：足以捕获改写后的查询，同时不会让延迟过高。任何失败都返回空列表，使外围流程降级为仅使用原始查询，而不是抛错。 */
async function generateQueryParaphrases(query: string, model: string): Promise<string[]> {
  try {
    const result = await generateStructuredOutput({
      model,
      tool: {
        name: "emit_paraphrases",
        description: "返回用户查询的其他表述。",
        parameters: paraphraseSchema,
      },
      systemPrompt:
        "将记忆检索查询改写为 2 种不同表述。保持意图不变，替换术语表达。不要回答查询。",
      prompt: `原始查询：${query}`,
    });
    return result.paraphrases.slice(0, 2);
  } catch {
    return [];
  }
}

interface ScoredHit {
  id: string;
  rank: number;
  /** 行类型；{@link reciprocalRankFusion} 用它应用 recall 先验。可选，以便调用方（和测试）仅按 rank 融合。 */
  kind?: ObservationKind;
  /** 行优先级；{@link reciprocalRankFusion} 用它应用 recall 先验。可选，以便调用方仅按 rank 融合。 */
  priority?: ObservationPriority;
}

async function keywordSearch(
  db: PGlite,
  query: string,
  scope: RecallScope,
  sessionId: string | undefined,
): Promise<ScoredHit[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];

  // websearch_to_tsquery 接受用户在搜索框中输入的带引号和 OR 语法的自由文本，
  // 形式与用户实际输入一致。针对 GIN 索引使用 ts_rank 会返回相关性顺序，
  // 而不是所有“匹配”行的统一集合。
  const baseSql = `SELECT id, kind, priority
     FROM observations
     WHERE to_tsvector('english', content) @@ websearch_to_tsquery('english', $1)`;
  const orderSql = `
     ORDER BY ts_rank(to_tsvector('english', content), websearch_to_tsquery('english', $1)) DESC,
              created_at DESC
     LIMIT ${PER_PATH_TOP_K}`;

  const { rows } = await runScopedQuery<HitRow>(db, baseSql, orderSql, [trimmed], scope, sessionId);
  return rows.map((row, index) => ({
    id: row.id,
    rank: index,
    kind: row.kind,
    priority: row.priority,
  }));
}

async function vectorSearch(
  db: PGlite,
  embed: EmbedFn,
  query: string,
  scope: RecallScope,
  sessionId: string | undefined,
): Promise<ScoredHit[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const { embeddings } = await embed([trimmed]);
  const vector = embeddings[0];
  if (!vector) return [];

  const baseSql = `SELECT o.id, o.kind, o.priority
     FROM observation_embeddings e
     JOIN observations o ON o.id = e.observation_id
     WHERE TRUE`;
  const orderSql = `
     ORDER BY e.vector <=> $1::vector
     LIMIT ${PER_PATH_TOP_K}`;

  const { rows } = await runScopedQuery<HitRow>(
    db,
    baseSql,
    orderSql,
    [`[${vector.join(",")}]`],
    scope,
    sessionId,
    // 向量检索对 observations 使用 `o.` 别名，因此 scope 条件必须跟在该别名之后。
    "o.",
  );
  return rows.map((row, index) => ({
    id: row.id,
    rank: index,
    kind: row.kind,
    priority: row.priority,
  }));
}

/**
 * 将 scope 条件（如果有）追加到基础查询并执行。基础查询必须以
 * `WHERE <something>` 结尾，以便用 `AND` 追加条件。global 分支使用
 * IS DISTINCT FROM，使 session 为空的旧行仍留在候选池中（它们无法匹配任何当前
 * session），与 loader 的行为一致。
 */
async function runScopedQuery<TRow>(
  db: PGlite,
  baseSql: string,
  orderSql: string,
  baseParams: unknown[],
  scope: RecallScope,
  sessionId: string | undefined,
  columnPrefix = "",
): Promise<{ rows: TRow[] }> {
  const nextParam = baseParams.length + 1;
  if (scope === "session" && sessionId) {
    return db.query<TRow>(`${baseSql} AND ${columnPrefix}session_id = $${nextParam}${orderSql}`, [
      ...baseParams,
      sessionId,
    ]);
  }
  if (scope === "global" && sessionId) {
    return db.query<TRow>(
      `${baseSql} AND ${columnPrefix}session_id IS DISTINCT FROM $${nextParam}${orderSql}`,
      [...baseParams, sessionId],
    );
  }
  return db.query<TRow>(`${baseSql}${orderSql}`, baseParams);
}

/**
 * Reciprocal Rank Fusion。每个排名列表为候选人的合并分数贡献
 * `1 / (RRF_K + rank)`；在任一列表中排名靠前的候选人会升到顶部，
 * 一个列表占据优势但在另一个列表中表现平庸时，也不会压过两个列表中都排名良好的行。
 *
 * 之后会将融合分数乘以由行类型和优先级派生的温和先验（{@link
 * RECALL_KIND_BIAS} / {@link RECALL_PRIORITY_BIAS}），使整理过且高优先级的行在
 * 可比结果中略占优势——这是相关性之上的平局裁决，不是替代相关性。缺少
 * kind/priority 元数据的命中使用中性的 1.0 先验，因此只按 rank 融合仍保持纯 RRF 行为。
 *
 * 返回按偏置分数降序排列的 id。分数相同则按首次出现顺序解决，这与 gbrain 的
 * 插入顺序平局裁决一致。
 */
export function reciprocalRankFusion(rankedLists: ScoredHit[][]): string[] {
  return reciprocalRankFusionScored(rankedLists).map((entry) => entry.id);
}

/**
 * 与 {@link reciprocalRankFusion} 相同，但返回每个 id 及其最终偏置融合分数
 *（`sum(1 / (RRF_K + rank)) * kindPriorityBias`），顺序也相同。调用方需要
 * 排名分数本身（例如为每行提供 `relevanceScore`）而不只是有序 id 时使用。
 */
export function reciprocalRankFusionScored(
  rankedLists: ScoredHit[][],
): Array<{ id: string; score: number }> {
  const scores = new Map<string, { score: number; firstSeen: number; prior: number }>();
  let order = 0;
  for (const list of rankedLists) {
    for (const hit of list) {
      const contribution = 1 / (RRF_K + hit.rank);
      const existing = scores.get(hit.id);
      if (existing) {
        existing.score += contribution;
      } else {
        scores.set(hit.id, { score: contribution, firstSeen: order++, prior: recallPrior(hit) });
      }
    }
  }

  return Array.from(scores.entries())
    .map(([id, entry]) => ({ id, score: entry.score * entry.prior, firstSeen: entry.firstSeen }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.firstSeen - b.firstSeen;
    })
    .map(({ id, score }) => ({ id, score }));
}

/**
 * 单个命中的乘法 recall 先验：`kindBias * priorityBias`；对应元数据缺失时
 * 各自默认为 1.0。
 */
function recallPrior(hit: Pick<ScoredHit, "kind" | "priority">): number {
  const kindBias = hit.kind ? RECALL_KIND_BIAS[hit.kind] : 1.0;
  const priorityBias = hit.priority ? RECALL_PRIORITY_BIAS[hit.priority] : 1.0;
  return kindBias * priorityBias;
}

interface HitRow {
  id: string;
  kind: ObservationKind;
  priority: ObservationPriority;
}

async function hydrate(db: PGlite, ids: string[]): Promise<Observation[]> {
  if (ids.length === 0) return [];
  const { rows } = await db.query<HydratedRow>(
    `SELECT id, created_at, last_used_at, session_id, kind, observed_date, referenced_date,
            relative_date, time_of_day, priority, source_json, content, tags_json
     FROM observations
     WHERE id = ANY($1::text[])`,
    [ids],
  );
  // 数据库返回的行顺序任意；重新排序以匹配融合排名，使调用方可以直接将数组
  // 当作已排名的结果列表处理。
  const byId = new Map(rows.map((row) => [row.id, row]));
  return ids
    .map((id) => byId.get(id))
    .filter((row): row is HydratedRow => row !== undefined)
    .map(rowToObservation);
}

interface HydratedRow {
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

function rowToObservation(row: HydratedRow): Observation {
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
