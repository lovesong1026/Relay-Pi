import type { PGlite, Transaction } from "@electric-sql/pglite";

/**
 * observational memory database 的只前进 schema migration。
 *
 * 为什么使用真实 migration framework，而不是裸的 `CREATE TABLE IF NOT EXISTS`：memory schema
 * 正在改变形状（添加 `session_id` 和 `kind`、删除 `scope`、重塑 `source_json`），用户升级
 * Relay Pi 时必须原地转换已有 row——不重写数据就删除 column 会丢失信息，而且我们不希望
 * 要求额外的 `relay-pi memory migrate` CLI 步骤。
 *
 * 设计说明：
 *   - Migration 在 `loadStoredMemory()` 和 `MemoryDb.open()` 中运行，因此 runner 和
 *     `relay-pi memory` CLI 看到同一份升级后的 schema。失败会以清晰消息中止启动；不可读时，
 *     底层 PGlite 目录也由 `quarantineDataDirectory()` 负责处理（见 `pglite.ts`）。
 *   - 每个 migration 在单个 transaction 中运行。Postgres DDL 支持 transaction，因此部分失败
 *     会回滚到之前的版本。
 *   - `schema_version` table 记录每个已应用 migration 及其 wall-clock 时间戳。打开时只读取一次
 *     以找到当前版本；我们绝不回退。
 *   - 设计为只前进。错误 migration 通过编写下一个 migration 修复，而不是回滚。这与 gbrain
 *     在六个 schema version 间遇到“upgrade-wedge”bug 后采用的模式一致。
 *   - embedding table 优先使用删除并重建，而不是保留数据的 rebuild。Embedding 很容易重新
 *     生成（backfill worker 会在 CLI 启动后数分钟内惰性填充），而保留数据的路径需要读取每个
 *     现有 row；重负载 UPSERT `vector(3072)` column 时，这曾触发 PGlite TOAST corruption
 *    （见 migration 7 的 comment）。Observation row 是唯一真正需要原地转换的数据。
 */
export interface Migration {
  /** 单调递增的版本号。Migration 严格按升序应用。 */
  version: number;
  /** 为审计存储在 `schema_version.description` 中的单行摘要。 */
  description: string;
  /** 前进步骤。接收 transaction，使 DDL + DML 原子执行。 */
  up: (tx: Transaction) => Promise<void>;
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: "initial observations schema",
    up: async (tx) => {
      // Migration 出现前发布的 schema 快照。
      // 保持幂等，使全新安装和 migration 前的数据库都能在后续 migration 运行前收敛到同一基线。
      await tx.exec(`
        CREATE TABLE IF NOT EXISTS observations (
          id TEXT PRIMARY KEY,
          created_at BIGINT NOT NULL,
          observed_date TEXT NOT NULL,
          referenced_date TEXT,
          relative_date TEXT,
          time_of_day TEXT,
          priority TEXT NOT NULL,
          scope TEXT NOT NULL,
          source_json TEXT NOT NULL,
          content TEXT NOT NULL,
          tags_json TEXT NOT NULL
        )
      `);
    },
  },
  {
    version: 2,
    description: "add session_id, kind; drop scope; flatten tool source into tag",
    up: async (tx) => {
      // 为跨 Session memory 层重塑 schema。
      //
      //   - session_id 允许 NULL：标识创建 row 的 Session。NULL 表示“在 sessionId tracking 存在前创建”；
      //     loader 将 NULL 与任何非当前 Session 等同（始终可进入 global，永不可进入 local）。
      //     runner 接入后，新 row 始终会设置它。
      //     runner 接入后，新 row 始终会设置它。
      //     runner 接入后，新 row 始终会设置它。
      //
      //   - kind："observation" 与 "reflection" 的区分。Reflection 默认排名更高
      //     （loader 中的 reflectionBias multiplier），因为它们是跨 observation 的压缩摘要。
      //     根据 tags_json 回填，因为现有 reflector 会给其输出加上
      //     `[`"observational-memory","reflection"`]`。
      //     with `["observational-memory","reflection"]`.
      //
      //   - 删除 scope：Session/resource 轴由 `session_id matches current session?` 替代，
      //     这正是调用方实际需要的。"resource" scope 从未接入真实 query path。
      //     这正是调用方实际需要的。"resource" scope 从未接入真实 query path。
      //     这正是调用方实际需要的。"resource" scope 从未接入真实 query path。
      //
      //   - 重塑 source_json：删除 `{kind:"tool",toolName:X}` variant，并将 toolName 提升为
      //     `tool:X` tag。Tool provenance 变为可搜索的 tag，source enum 收紧为 user|agent|system。
      //     `tool:X` tag。Tool provenance 变为可搜索的 tag，source enum 收紧为 user|agent|system。
      //     幂等：已重塑的 row（或从未由 tool 写入的 row）原样通过。
      //     幂等：已重塑的 row（或从未由 tool 写入的 row）原样通过。
      await tx.exec(`ALTER TABLE observations ADD COLUMN IF NOT EXISTS session_id TEXT`);
      await tx.exec(
        `ALTER TABLE observations ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'observation'`,
      );

      // Backfill kind from existing tag convention before we trust the
      // column for queries.
      await tx.exec(
        `UPDATE observations
         SET kind = 'reflection'
         WHERE kind = 'observation' AND tags_json LIKE '%"reflection"%'`,
      );

      // Reshape source_json + tags_json for legacy tool rows. Done in JS
      // because PGlite has no native JSON manipulation that handles the
      // tags-array merge cleanly.
      const toolRows = await tx.query<{ id: string; source_json: string; tags_json: string }>(
        `SELECT id, source_json, tags_json
         FROM observations
         WHERE source_json LIKE '%"kind":"tool"%'`,
      );
      for (const row of toolRows.rows) {
        let parsedSource: { kind?: string; toolName?: string } = {};
        try {
          parsedSource = JSON.parse(row.source_json) as typeof parsedSource;
        } catch {
          // 格式错误的 JSON 来自此代码之前；保留 row 原样，而不是猜测。
          continue;
        }
        if (parsedSource.kind !== "tool") continue;

        let parsedTags: string[] = [];
        try {
          parsedTags = JSON.parse(row.tags_json) as string[];
        } catch {
          parsedTags = [];
        }
        const toolTag = parsedSource.toolName ? `tool:${parsedSource.toolName}` : undefined;
        const nextTags =
          toolTag && !parsedTags.includes(toolTag) ? [...parsedTags, toolTag] : parsedTags;

        await tx.query(`UPDATE observations SET source_json = $1, tags_json = $2 WHERE id = $3`, [
          JSON.stringify({ kind: "agent" }),
          JSON.stringify(nextTags),
          row.id,
        ]);
      }

      await tx.exec(`ALTER TABLE observations DROP COLUMN IF EXISTS scope`);

      // 新 query pattern 的 index：按 Session 限定的 local lookup，以及按（priority、recency）
      // 排名的 global lookup。复合 index 与 loader 的 ORDER BY 形状匹配，使 planner 能在
      // hot path 上避免排序。
      await tx.exec(`CREATE INDEX IF NOT EXISTS idx_obs_session_id ON observations(session_id)`);
      await tx.exec(
        `CREATE INDEX IF NOT EXISTS idx_obs_kind_priority_created
         ON observations(kind, priority, created_at DESC)`,
      );
    },
  },
  {
    version: 3,
    description: "pgvector embeddings table and tsvector keyword index",
    up: async (tx) => {
      // Hybrid retrieval（recall_memory tool）需要两个并列的 index：用于 semantic similarity 的
      // vector index，以及用于 keyword match 的 tsvector GIN index。Tool 中的 Reciprocal Rank
      // Fusion 合并两个排序 list；缺少任一个都会漏掉另一个能捕捉的 query 类别（keyword 的
      // proper-noun lookup，vector 的模糊 paraphrase）。
      //
      // pgvector 在构造时作为 PGlite extension 加载（见 memory/pglite.ts）；CREATE EXTENSION 是
      // 激活该类型和 operator definition 的 SQL-level hook。
      await tx.exec(`CREATE EXTENSION IF NOT EXISTS vector`);

      // Embedding 放在 observations 的 sibling table，而非 column 中，因为（a）backfill worker
      // 异步写入 embedding，通常远在 observation row 落库之后；（b）未来可能更换 embedding
      // model，而不必让所有现有 row 同步重新 embedding。`model` column 记录生成每个 vector
      // 的 model，以便未来 re-embedding pass 有选择地替换旧 entry。
      //
      // 1536 维对应 OpenAI text-embedding-3-small（重命名 embedding endpoint 之前暴露的 model）。
      // 切换到不同维度需要新的 migration，删除并重建此 table；维度属于 column type。
      await tx.exec(`
        CREATE TABLE IF NOT EXISTS observation_embeddings (
          observation_id TEXT PRIMARY KEY REFERENCES observations(id) ON DELETE CASCADE,
          model TEXT NOT NULL,
          vector vector(1536) NOT NULL,
          created_at BIGINT NOT NULL
        )
      `);

      // HNSW 是 memory-scale corpus 的正确默认值（典型用户有数千条，而非数百万条 observation）：
      // 构建快，query 小于毫秒，recall 高。Cosine operator class 与 recall_memory tool 的
      // similarity metric 匹配。
      await tx.exec(
        `CREATE INDEX IF NOT EXISTS idx_obs_emb_hnsw
         ON observation_embeddings USING hnsw (vector vector_cosine_ops)`,
      );

      // generated tsvector 上的 GIN index 让 hybrid retrieval 的 keyword path 在毫秒内运行，
      // 无需每次 query 进行 tokenization。English config 是合理默认值；之后可以切换到
      // `simple` 以支持多语言。
      await tx.exec(
        `CREATE INDEX IF NOT EXISTS idx_obs_content_fts
         ON observations USING gin (to_tsvector('english', content))`,
      );
    },
  },
  {
    version: 4,
    description: "add last_used_at column for usage-decay ranking",
    up: async (tx) => {
      // last_used_at 驱动 global-layer ranking，而不是 created_at。每回合结束时，observer 报告
      // 哪些 observation 影响了 assistant response，系统就为它们 bump；因此持续被使用的 memory
      // 会持续浮现。
      //
      // 分两步添加：column 先允许 NULL，再对每个现有 row 回填 created_at（使旧 row 以原始
      // recency 进入 ranking），最后收紧为 NOT NULL。PGlite 不接受引用其他 column 的
      // column-level default，因此不能用单个 ALTER TABLE 完成。
      await tx.exec(`ALTER TABLE observations ADD COLUMN IF NOT EXISTS last_used_at BIGINT`);
      await tx.exec(`UPDATE observations SET last_used_at = created_at WHERE last_used_at IS NULL`);
      await tx.exec(`ALTER TABLE observations ALTER COLUMN last_used_at SET NOT NULL`);

      // 用 last_used_at-keyed index 替换 created_at-keyed ranking index。loader 的 ORDER BY 现在
      // 按 last_used_at 排序；保留旧 index 没有意义，因为没有 query path 再将 created_at 用作
      // ranking key。
      await tx.exec(`DROP INDEX IF EXISTS idx_obs_kind_priority_created`);
      await tx.exec(
        `CREATE INDEX IF NOT EXISTS idx_obs_kind_priority_lastused
         ON observations(kind, priority, last_used_at DESC)`,
      );
    },
  },
  {
    version: 5,
    description: "self-heal: collapse duplicate observation rows that bypassed the PK index",
    up: async (tx) => {
      // 某些安装的 `observations` 中为同一 `id` 累积了多个物理 row，尽管 v1 起就声明了
      // `id TEXT PRIMARY KEY`；可能是之前的 PGlite corruption event（以 `memory.db.corrupted-*`
      // 目录出现），导致 unique index 与 heap 不同步。症状是每次 `INSERT ... ON CONFLICT (id)
      // DO UPDATE` 都抛出 `duplicate key value violates unique constraint "observations_pkey"`，
      // runner 再将它作为 TUI 中的 `[system]` error 展示。
      //
      // 我们不能信任旧 index，因此 dedupe 留在 heap 中：window function 按 id 为 row 排名
      //（最新的 `last_used_at`，然后是 `created_at`），外层 DELETE 以 `ctid` 为 key 移除
      // 所有没有胜出的 row。禁用此 transaction 的 index plan，强制 heap 使用 seq scan、
      // delete 使用 TID scan，避免 planner 绑定到损坏的 index。dedupe 后 heap 一致，REINDEX
      // 可以从干净数据重建 unique index。
      //
      // 只前进且幂等：健康 DB 没有重复 row，DELETE 不会移除任何内容。
      await tx.exec(`SET LOCAL enable_indexscan = off`);
      await tx.exec(`SET LOCAL enable_indexonlyscan = off`);
      await tx.exec(`SET LOCAL enable_bitmapscan = off`);

      await tx.exec(`
        DELETE FROM observations
        WHERE ctid IN (
          SELECT ctid FROM (
            SELECT ctid, ROW_NUMBER() OVER (
              PARTITION BY id
              ORDER BY last_used_at DESC, created_at DESC
            ) AS rn
            FROM observations
          ) ranked
          WHERE rn > 1
        )
      `);

      // heap 去重后重建 unique index，使其匹配。REINDEX 覆盖 index 存在但过期的生产场景；
      // ADD PRIMARY KEY 覆盖 unique index 被完全删除的恢复状态（例如 operator 运行
      // `DROP CONSTRAINT ... CASCADE`，在手工清理期间移除依赖对象）。如果重复仍存在，任一路径
      // 都会大声失败，暴露半修复状态而不是将其掩盖。
      const indexExists = await tx.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM pg_indexes
         WHERE tablename = 'observations' AND indexname = 'observations_pkey'`,
      );
      if ((indexExists.rows[0]?.count ?? 0) > 0) {
        await tx.exec(`REINDEX INDEX observations_pkey`);
      } else {
        await tx.exec(`ALTER TABLE observations ADD PRIMARY KEY (id)`);
      }
    },
  },
  {
    version: 6,
    description: "rebuild embeddings table at 3072 dims for google/gemini-embedding-2",
    up: async (tx) => {
      // 旧版 embed endpoint 以 3072 维提供 `google/gemini-embedding-2`，替代之前的
      // text-embedding-3-small 路径。每个现有 1536 维 vector 都处于不同的 latent space，因此
      // 保留它们会让它们与新 query embedding 的 cosine similarity 变成噪声。删除 table，
      // 让 backfill worker 在升级后惰性重新填充。
      //
      // 新 table 不建 HNSW index：pgvector 的默认 `vector_cosine_ops` opclass 将 HNSW 限制在
      // 2,000 维，而添加 `halfvec(3072)` 和半精度 opclass 会让 schema 复杂化；在此数据库
      // 运行的数千 row 规模上，brute-force scan 远低于 10ms。observations.content 上已有的
      // tsvector GIN index 原样保留，继续服务 keyword path。
      await tx.exec(`DROP TABLE IF EXISTS observation_embeddings`);
      await tx.exec(`
        CREATE TABLE observation_embeddings (
          observation_id TEXT PRIMARY KEY REFERENCES observations(id) ON DELETE CASCADE,
          model TEXT NOT NULL,
          vector vector(3072) NOT NULL,
          created_at BIGINT NOT NULL
        )
      `);
    },
  },
  {
    version: 7,
    description: "drop FK cascade on observation_embeddings so embeddings survive parent churn",
    up: async (tx) => {
      // 原始的 `REFERENCES observations(id) ON DELETE CASCADE` 会导致 hot-loop bug：reflector 的
      // Session-scoped delete-and-reinsert cycle 会通过 cascade 清除该 Session 的所有 embedding，
      // backfill worker 随后反复为相同 id 重新 embedding（或在加入 cooldown 后，让它们无声地
      // 处于五分钟未 embedding 状态）。
      //
      // 删除 table 并在没有 FK 的情况下重建，使 embedding row 的生命周期超过 parent delete。
      // Orphan 无害：recall path 会 JOIN 回 `observations` 并自然过滤；未来同 id reinsert 时，
      // worker 通过 ON CONFLICT path 刷新前，会继续保留现有 embedding。
      //
      // 不保留现有 row。早期 migration 草案尝试 `CREATE ... + INSERT SELECT * + DROP + RENAME`，
      // 但 PGlite 对 `vector(3072)` column 的 TOAST storage 在 worker 高负载 UPSERT 的生产 DB 中
      // 触发了 `missing chunk number 0 for toast value ...`。backfill worker 会在 CLI 启动后数分钟
      // 内惰性重新填充 table，因此删除并重建与 migration 6 的先例一致，也避开 toast read。
      await tx.exec(`DROP TABLE IF EXISTS observation_embeddings`);
      await tx.exec(`
        CREATE TABLE observation_embeddings (
          observation_id TEXT PRIMARY KEY,
          model TEXT NOT NULL,
          vector vector(3072) NOT NULL,
          created_at BIGINT NOT NULL
        )
      `);
    },
  },
  {
    version: 8,
    description: "rebuild embeddings table at 4096 dims for qwen/qwen3-embedding-8b",
    up: async (tx) => {
      // OpenRouter 以 4096 维提供 `qwen/qwen3-embedding-8b`。每个现有 3072 维 vector 都处于
      // 不同的 latent space，因此保留它们会让它们与新 query embedding 的 cosine similarity
      // 变成噪声。删除 table，让 backfill worker 惰性重新填充；与 migration 6、7 的先例一致。
      await tx.exec(`DROP TABLE IF EXISTS observation_embeddings`);
      await tx.exec(`
        CREATE TABLE observation_embeddings (
          observation_id TEXT PRIMARY KEY,
          model TEXT NOT NULL,
          vector vector(4096) NOT NULL,
          created_at BIGINT NOT NULL
        )
      `);
    },
  },
];

export interface MigrationResult {
  /** `runMigrations` 调用前数据库所在的 schema version。 */
  fromVersion: number;
  /** `runMigrations` 返回后数据库所在的 schema version。 */
  toVersion: number;
  /** 本次调用实际应用的 version（已是最新时为空）。 */
  applied: number[];
}

/**
 * 将 database 更新到已知的最新 schema version。幂等；每次打开都可以安全调用。首次失败时抛出
 * 错误，message 中包含触发 migration 的 version，用户无需 grep 就知道去哪里查看。
 */
export async function runMigrations(db: PGlite): Promise<MigrationResult> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at BIGINT NOT NULL,
      description TEXT NOT NULL
    )
  `);

  const result = await db.query<{ max: number | null }>(
    "SELECT MAX(version) AS max FROM schema_version",
  );
  const fromVersion = result.rows[0]?.max ?? 0;
  const applied: number[] = [];

  for (const migration of MIGRATIONS) {
    if (migration.version <= fromVersion) continue;
    try {
      await db.transaction(async (tx) => {
        await migration.up(tx);
        await tx.query(
          "INSERT INTO schema_version (version, applied_at, description) VALUES ($1, $2, $3)",
          [migration.version, Date.now(), migration.description],
        );
      });
      applied.push(migration.version);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Memory schema migration v${migration.version} (${migration.description}) failed: ${reason}. ` +
          "The database was rolled back to the previous version; rerun once the cause is fixed.",
      );
    }
  }

  return {
    fromVersion,
    toVersion: applied.at(-1) ?? fromVersion,
    applied,
  };
}

/** 此 build 已知的最新 version。导出供测试使用。 */
export const LATEST_SCHEMA_VERSION: number = MIGRATIONS.at(-1)?.version ?? 0;

/** 所有已注册的 migration。导出供测试使用。 */
export const REGISTERED_MIGRATIONS: readonly Migration[] = MIGRATIONS;
