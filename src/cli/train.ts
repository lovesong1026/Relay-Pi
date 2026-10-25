import { readFile, rm, stat } from "node:fs/promises";
import path from "node:path";

import dedent from "dedent";

import { createEmbeddingClient } from "../memory/embedding.js";
import { createMemoryId } from "../memory/id.js";
import { runMigrations } from "../memory/migrations.js";
import { MemoryLockTimeoutError } from "../memory/pglite.js";
import { MemorySession } from "../memory/session.js";
import {
  deleteEntry,
  listStore,
  updateEntry,
  writeEntry,
  type StoredMemory,
} from "../memory/store/store.js";
import {
  mergeListings,
  resolveSources,
  type MemorySourceFlags,
  type MemorySources,
  type SourceListing,
} from "../memory/store/sources.js";
import { appendObservation } from "../memory/storage.js";
import { resolveCliModel } from "../model-resolution/resolver.js";
import { DEFAULT_MEMORY_DB_PATH, SessionManager } from "../session/session-manager.js";
import {
  archivedFilePath,
  collectArchiveFiles,
  readArchiveManifest,
  removeArchive,
  writeArchive,
} from "../train/archive.js";
import { TRAIN_TAG, trainSlugTag } from "../train/tags.js";
import type {
  SynthesisResult,
  TrainListEntry,
  TrainManifest,
  TrainRecord,
} from "../train/types.js";
import type { TurnRunnerConfig } from "../types/config.js";
import { printTrainHelp } from "./help.js";
import { withMemoryDb } from "./memory-db.js";
import {
  lexMemorySourceFlags,
  requireSingleExplicitWriteTarget,
  requireWriteTarget,
} from "./memory-sources.js";
import { fail, loadCliEnvFiles, resolveUserPath, usageError } from "./shared.js";
import { installShutdownHandlers } from "./shutdown.js";

export interface TrainCommandOptions {
  folder: string;
  slug: string;
  /** undefined 表示“运行时通过 resolveCliModel 解析”。 */
  model: string | undefined;
  /** 显式 backend 标志；为空时在执行时采用 skills 风格的发现。 */
  sourceFlags: MemorySourceFlags;
  /** 供检查单个选中 DB 的调用方使用的兼容投影。 */
  dbPath: string;
  waitBudgetMs?: number;
}

interface TrainCommandIO {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  /** 用于相对路径和无 flag 的 source discovery 的工作目录。 */
  cwd?: string;
  /** CLI 集成测试使用的确定性 synthesis 接缝。 */
  synthesize?: typeof runAgentSynthesis;
}

/**
 * 将基础名称转为小写，并把所有不是 a-z/0-9 的内容折叠为单个连字符，
 * 使 slug 可以作为 tag（`train:<slug>`）和无需引号的目录名。
 */
function sanitizeSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function parseTrainArgs(
  args: string[],
  cwd: string = process.cwd(),
): TrainCommandOptions | undefined {
  const sourceArgs = lexMemorySourceFlags(args, cwd);
  requireSingleExplicitWriteTarget(sourceArgs.flags);
  let folder: string | undefined;
  let slugOverride: string | undefined;
  // 默认模型在运行时通过 `resolveCliModel` 解析，与 `relay-pi run` 的 actor
  // 模型选择保持一致。环境变量 `RELAY_PI_MODEL` 由 resolver 自己处理；
  // 保留 `--model` 作为用户的显式覆盖。
  let model: string | undefined;
  let waitBudgetMs: number | undefined;

  for (let i = 0; i < sourceArgs.args.length; i++) {
    const arg = sourceArgs.args[i]!;
    switch (arg) {
      case "--slug":
        if (!sourceArgs.args[i + 1] || sourceArgs.args[i + 1]?.startsWith("-")) {
          usageError(`Missing value for ${arg}`);
        }
        slugOverride = sourceArgs.args[++i]!;
        break;
      case "--model":
        if (!sourceArgs.args[i + 1] || sourceArgs.args[i + 1]?.startsWith("-")) {
          usageError(`Missing value for ${arg}`);
        }
        model = sourceArgs.args[++i]!;
        break;
      case "--wait": {
        const raw = sourceArgs.args[++i];
        const seconds = Number(raw);
        if (!Number.isFinite(seconds) || seconds < 0) {
          usageError(`Invalid --wait value: ${raw} (expected non-negative number of seconds)`);
        }
        waitBudgetMs = Math.round(seconds * 1000);
        break;
      }
      case "--help":
      case "-h":
        printTrainHelp();
        return undefined;
      default:
        if (arg.startsWith("-")) usageError(`Unknown train option: ${arg}`);
        if (folder !== undefined) usageError(`Unexpected extra argument: ${arg}`);
        folder = arg;
    }
  }

  if (!folder) usageError("relay-pi train requires a <folder> argument");
  const resolved = path.resolve(cwd, folder);
  const slug = sanitizeSlug(slugOverride ?? path.basename(resolved));
  if (slug.length === 0) {
    usageError(`Could not derive a slug from "${folder}"; pass --slug <name>`);
  }
  return {
    folder: resolved,
    slug,
    model,
    sourceFlags: sourceArgs.flags,
    dbPath: sourceArgs.flags.dbs[0] ?? DEFAULT_MEMORY_DB_PATH,
    ...(waitBudgetMs !== undefined ? { waitBudgetMs } : {}),
  };
}

interface QueriedRow {
  id: string;
  tags_json: string;
}

/**
 * 发送原样的 system prompt 给 synthesis 子 Agent。子 Agent 的 cwd 是语料目录，
 * 因此文件读取工具会直接以它为相对路径基准。
 */
const TRAIN_SYSTEM_PROMPT = dedent`
  你的任务是将一个项目语料整理成一份可长期使用的记忆记录。

  当前工作目录就是语料目录。阅读所有有实质内容的文件，包括 Markdown、纯文本、CSV、PDF、电子表格、图片和源代码。跳过锁文件、构建产物、node_modules、.git 及其他明显无关的内容。使用文件读取工具（read、ls、grep）持续探索，直到理解这份语料的主题。

  请穷尽提取信息，不要只做摘要。较弱的阅读者往往只保留核心结论，却悄悄丢掉与结论关联的具体细节；必须避免这种情况。保留每一项有决定作用的具体事实：
    - 保留每个数字、数量、百分比、版本和日期，包括枚举中的第二项、第三项及后续项目（如果事实包含 A、B 和 C，就必须保留 A、B、C，不能只写 A）。
    - 按原名保留每个具名功能、产品、选项、工具、属性和 API，不要泛化改写。
    - 保留列表的每个成员及其限定条件（如果每个选项都支持 X 和 Y，就要明确说明这一点适用于列表中的所有选项）。
    - 按原样保留精确语法、标识符、代码值和配置片段，例如属性名称及其字面示例值。
  不要把枚举缩减为第一项，也不要把具体内容泛化为类别。有疑问时，优先保留细节。

  请使用 GitHub Flavored Markdown 编写综合结果：
    - 使用 \`##\` 作为章节标题；禁止使用顶级 \`#\` 标题，因为标题字段本身就是页面标题，重复标题会造成重复显示。
    - 枚举内容使用项目符号，使要求保留的成员各自清晰可见，而不是被揉进一句话里。
    - 仅当语料确实具有表格结构（例如计划矩阵、限制条件表）时才使用表格；否则使用段落。
    - 字面语法、标识符和配置片段使用围栏代码块。

  充分阅读并能够准确综合后，只在当前工作目录根目录创建且仅创建一个文件：

    \`.relay-pi-train.json\` —— 一个恰好包含两个字符串字段的 JSON 对象：
      {
        "headline": "<该语料的简短标题，不超过120个字符，末尾不加标点>",
        "observationContent": "<以 Markdown 编写的密集、具体、持久且高优先级的知识，供 Agent 据此处理相关材料。为保留上述所有关键事实，可按需增加篇幅；完整性优先于简洁。内容应是一份关于该语料的自包含文档，不要添加前言，也不要写‘本语料包含’之类的开场。>"
      }

  不要创建 \`AGENTS.md\` 或任何其他文件。JSON 交接文件是唯一交付物。两个字段都不得为空。写完文件后立即停止，不需要再回复其他内容。
`;

/**
 * 在语料目录中启动 relay-pi Agent，让它生成 `.relay-pi-train.json` 交接文件，
 * 并返回解析后的 synthesis 结果。启动前会移除交接文件（避免把失败运行留下的旧文件
 * 误认为新输出），成功读取后也会移除它（避免文件泄漏到语料或归档中）。
 */
async function runAgentSynthesis(
  options: { folder: string; slug: string; model: string },
  io: TrainCommandIO,
): Promise<SynthesisResult> {
  const handoffPath = path.join(options.folder, ".relay-pi-train.json");
  await rm(handoffPath, { force: true });

  const config = buildTrainSynthesisConfig(options);

  const manager = new SessionManager(config);

  // 安静地展示子 Agent 正在做什么，避免长时间 synthesis 看起来像卡住。只转发
  // 工具调用（可见的工作）和系统级消息；跳过 assistant 文本及推理。
  const unsubscribe = manager.subscribe(({ event }) => {
    if (event.type === "step") {
      const step = event.step;
      if (step.type === "tool_call_start") {
        io.stderr.write(`[agent] ${step.toolName}\n`);
      } else if (step.type === "system") {
        io.stderr.write(`[agent] ${step.message}\n`);
      }
    } else if (event.type === "system") {
      io.stderr.write(`[agent] ${event.message}\n`);
    }
  });

  try {
    const session = manager.create({
      prompt: `请综合此目录下的语料。标识符：${options.slug}。`,
    });
    const terminal = await session.waitForTerminal();
    if (terminal.type !== "complete") {
      throw new Error(`train: agent terminated with type=${terminal.type}; expected "complete"`);
    }
  } finally {
    unsubscribe();
    await manager.dispose();
  }

  const raw = await readFile(handoffPath, "utf8").catch(() => {
    throw new Error(
      // 不建议“尝试更强模型”：调用方固定了 synthesis 模型，阅读者没有可升级的目标。
      // 只需说明实际发生了什么。
      `train: the synthesis agent finished without writing ${handoffPath}, so there is no memory to store. The corpus may be empty, unreadable, or too large to finish in one run.`,
    );
  });
  await rm(handoffPath, { force: true });

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`train: .relay-pi-train.json was not valid JSON: ${(err as Error).message}`);
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`train: .relay-pi-train.json must be a JSON object, got ${typeof parsed}`);
  }
  const { headline, observationContent } = parsed as Record<string, unknown>;
  if (typeof headline !== "string" || headline.trim().length === 0) {
    throw new Error(`train: .relay-pi-train.json missing non-empty string "headline"`);
  }
  if (typeof observationContent !== "string" || observationContent.trim().length === 0) {
    throw new Error(`train: .relay-pi-train.json missing non-empty string "observationContent"`);
  }

  return {
    headline: headline.trim(),
    observationContent: observationContent.trim(),
  };
}

/** 构造仅供语料 synthesis 使用的隔离运行器配置。 */
export function buildTrainSynthesisConfig(options: {
  folder: string;
  model: string;
}): TurnRunnerConfig {
  return {
    cwd: options.folder,
    model: options.model,
    // synthesis 期间不要写入持久化 memory DB；train 命令负责最后落下唯一一条观察记录。
    memoryDbPath: false,
    // 语料可能位于包含已训练记忆的 Agent 根目录下。将 synthesis 输入限制为语料文件，
    // 避免之前的训练影响结果，或递归污染新记录。
    memoryStores: false,
    // synthesis 不应受语料自身 AGENTS.md（如果存在）影响——Agent 将文件作为数据读取，
    // 而不是作为指令。
    systemPromptFiles: [],
    // 避免本地用户 skill 漂移影响子 Agent 的行为。
    skillDiscovery: { includeDefaults: false },
    systemInstructions: TRAIN_SYSTEM_PROMPT,
    mode: "agent",
  };
}

/**
 * 运行 `relay-pi train <folder>`——合成一份语料，将其持久化到选中的单个文件存储或旧版 DB，
 * 替换目标中此前相同 slug 的记录，并将未改变的私有语料归档保存在
 * `~/.relay-pi/train/<memoryId>/`。
 */
export async function runTrainCommand(
  args: string[],
  io: TrainCommandIO = { stdout: process.stdout, stderr: process.stderr },
): Promise<void> {
  const cwd = io.cwd ?? process.cwd();
  // 管理子命令是 synthesis 命令的 list/show/update/delete 同级命令。它们必须在 synthesis
  // 参数解析器之前分流，否则子命令单词会被当成语料 folder。其他参数继续进入默认的
  // `train <folder>` 创建流程。
  switch (args[0]) {
    case "list":
      return runTrainListCommand(args.slice(1), io);
    case "show":
      return runTrainShowCommand(args.slice(1), io);
    case "update":
      return runTrainUpdateCommand(args.slice(1), io);
    case "delete":
      return runTrainDeleteCommand(args.slice(1), io);
  }

  const options = parseTrainArgs(args, cwd);
  if (!options) return;
  const sources = await resolveSources(options.sourceFlags, cwd);
  const writeTarget = requireWriteTarget(sources);

  // 解析参数后的失败通过抛出异常处理，而不是调用 `fail()`：CLI 入口（`runCli`）会以相同方式
  // 打印它们，同时进程内调用方（eval harness、model sweep）可以捕获异常并执行清理。
  const folderStat = await stat(options.folder).catch(() => undefined);
  if (!folderStat || !folderStat.isDirectory()) {
    throw new Error(`Folder not found or not a directory: ${options.folder}`);
  }

  // 按与 `relay-pi run` 相同的方式解析模型，使 shorthand 和 provider 路由保持一致。
  // 语料目录中的环境文件可以提供 provider 凭据；在解析前加载它们。
  const dotenvKeys = loadCliEnvFiles(options.folder);
  const modelResolution = resolveCliModel(options.model, dotenvKeys);
  const resolvedModel = modelResolution.modelName;

  if (writeTarget.kind === "store") {
    await runStoreTrain(options, writeTarget.path, resolvedModel, io);
    return;
  }

  const dbPath = writeTarget.path;

  const session = new MemorySession({
    path: dbPath,
    openOptions: {
      init: async (db) => {
        await runMigrations(db);
      },
    },
    ...(options.waitBudgetMs !== undefined ? { lockWaitBudgetMs: options.waitBudgetMs } : {}),
    idleCloseMs: 60_000,
  });
  const removeShutdownHandlers = installShutdownHandlers(() => session.dispose());

  try {
    await session.withDb(async () => {});

    io.stderr.write(`[synthesize] model=${resolvedModel}\n`);
    const synthesis = await (io.synthesize ?? runAgentSynthesis)(
      { folder: options.folder, slug: options.slug, model: resolvedModel },
      io,
    );

    // 在删除旧记录之前写入新记录：如果进程在两步之间退出，最坏情况是出现重复的
    // `train:<slug>` 行（下次 train 会清理），而不会出现零行。该行写成
    // `kind: "manual"`，使 loader 的 manualBias 将其排在全局 pack 顶部（没有 sessionId
    // 的手工行永远不会匹配实时 session，因此会通过 loader 的 NULL-session 处理进入全局
    // pack），并且 `relay-pi memory reflect` 会按 kind 保留它，不受年龄影响。
    const trainTag = trainSlugTag(options.slug);
    const observedDate = new Date().toISOString().slice(0, 10);
    // embed 使 train 退出后记录立即可通过向量检索；这个 one-shot 进程不会运行 backfill worker。
    // embed 失败会静默降级——记录仍会写入，之后由 backfill 补齐 embedding。
    const observation = await appendObservation(
      session,
      {
        kind: "manual",
        priority: "high",
        source: { kind: "system" },
        content: synthesis.observationContent,
        tags: [TRAIN_TAG, trainTag],
        observedDate,
      },
      { embed: createEmbeddingClient() },
    );
    if (!observation) {
      throw new Error(`Could not write training memory to ${dbPath} (lock contention).`);
    }

    // SELECT 和 DELETE 共用一次 `withDb`，使替换步骤相对于并行写入者保持原子性，
    // 锁失败也会在同一处暴露。
    // 此代码块结束后的不变量：恰好存在一条 `train:<slug>` 行，即上面写入的那一条。
    const priorIds = await session.withDb(async (db) => {
      const result = await db.query<QueriedRow>("SELECT id, tags_json FROM observations");
      const ids: string[] = [];
      for (const row of result.rows) {
        if (row.id === observation.id) continue;
        let tags: unknown;
        try {
          tags = JSON.parse(row.tags_json);
        } catch {
          continue;
        }
        if (Array.isArray(tags) && tags.includes(trainTag)) {
          ids.push(row.id);
        }
      }
      for (const id of ids) {
        await db.query("DELETE FROM observations WHERE id = $1", [id]);
      }
      return ids;
    });
    if (priorIds === undefined) {
      throw new Error(
        `Could not remove prior training rows from ${dbPath} (lock contention); ` +
          `the new row ${observation.id} was written. Re-run train to clean up the duplicate.`,
      );
    }
    for (const id of priorIds) {
      await removeArchive(id);
    }
    const replacedSuffix = priorIds.length > 0 ? ` (replaced ${priorIds.length} prior row(s))` : "";
    io.stderr.write(`[persist] memory id=${observation.id}${replacedSuffix}\n`);

    // `runAgentSynthesis` 已经移除了 `.relay-pi-train.json`；walker 的跳过列表属于深度防御。
    const archivedFiles = await collectArchiveFiles(options.folder);
    const manifest: TrainManifest = {
      memoryId: observation.id,
      slug: options.slug,
      createdAt: observation.createdAt,
      sourceFolder: options.folder,
      model: resolvedModel,
      headline: synthesis.headline,
      files: archivedFiles.map((file) => ({
        relPath: file.relPath,
        bytes: file.bytes,
        sha256: file.sha256,
      })),
    };
    const archivePath = await writeArchive({
      memoryId: observation.id,
      files: archivedFiles,
      manifest,
    });

    const verifyRows = await session.withDb(async (db) =>
      db.query<{ content: string }>("SELECT content FROM observations WHERE id = $1", [
        observation.id,
      ]),
    );
    if (verifyRows === undefined) {
      throw new Error(`Could not verify training memory at ${dbPath} (lock contention).`);
    }
    if (verifyRows.rows[0]?.content !== synthesis.observationContent) {
      throw new Error(
        `Verification failed: observation ${observation.id} did not round-trip through the DB.`,
      );
    }

    io.stdout.write(`Trained "${synthesis.headline}"\n`);
    io.stdout.write(`  memory id  : ${observation.id}\n`);
    io.stdout.write(`  archive    : ${archivePath}\n`);
    io.stdout.write(`  files      : ${archivedFiles.length} file(s)\n`);
    io.stdout.write(`  model      : ${resolvedModel}\n`);
    io.stdout.write(`\n${synthesis.observationContent}\n`);
  } catch (error) {
    if (error instanceof MemoryLockTimeoutError) {
      throw new Error(
        `Memory database at ${error.dataDir} is still locked by relay-pi pid ${error.holderPid} after ${
          error.budgetMs / 1000
        }s. Stop that process (or pass --wait <seconds> to wait longer) and retry.`,
      );
    }
    throw error;
  } finally {
    removeShutdownHandlers();
    await session.dispose();
  }
}

async function runStoreTrain(
  options: TrainCommandOptions,
  storeDir: string,
  resolvedModel: string,
  io: TrainCommandIO,
): Promise<void> {
  const prior = (await listStore(storeDir)).find((entry) => entry.slug === options.slug);
  io.stderr.write(`[synthesize] model=${resolvedModel}\n`);
  const synthesis = await (io.synthesize ?? runAgentSynthesis)(
    { folder: options.folder, slug: options.slug, model: resolvedModel },
    io,
  );

  const memoryId = createMemoryId();
  const createdAt = Date.now();
  const archivedFiles = await collectArchiveFiles(options.folder);
  const manifest: TrainManifest = {
    memoryId,
    slug: options.slug,
    createdAt,
    sourceFolder: options.folder,
    model: resolvedModel,
    headline: synthesis.headline,
    files: archivedFiles.map((file) => ({
      relPath: file.relPath,
      bytes: file.bytes,
      sha256: file.sha256,
    })),
  };
  const archivePath = await writeArchive({ memoryId, files: archivedFiles, manifest });
  try {
    await writeEntry(storeDir, {
      slug: options.slug,
      version: 1,
      id: memoryId,
      kind: "train",
      createdAt,
      headline: synthesis.headline,
      model: resolvedModel,
      fileCount: archivedFiles.length,
      archiveId: memoryId,
      content: synthesis.observationContent,
    });
  } catch (error) {
    await removeArchive(memoryId);
    throw error;
  }

  if (prior?.archiveId && prior.archiveId !== memoryId) await removeArchive(prior.archiveId);
  const replacedSuffix = prior ? " (replaced prior entry)" : "";
  io.stderr.write(`[persist] memory id=${memoryId}${replacedSuffix}\n`);
  io.stdout.write(`Trained "${synthesis.headline}"\n`);
  io.stdout.write(`  memory id  : ${memoryId}\n`);
  io.stdout.write(`  archive    : ${archivePath}\n`);
  io.stdout.write(`  files      : ${archivedFiles.length} file(s)\n`);
  io.stdout.write(`  model      : ${resolvedModel}\n`);
  io.stdout.write(`\n${synthesis.observationContent}\n`);
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/**
 * 将 list/record 映射为 `--json` 的 wire shape，把内部 epoch-ms 的 `createdAt`
 * 替换为 ISO 8601 字符串。内存中的 `TrainListEntry`/`TrainRecord` 仍将
 * `createdAt` 保持为数字（用于按最新优先排序）；ISO 转换只发生在输出边界，
 * 使 JSON 契约不受内存表示影响。
 */
function toTrainListEntryJson(entry: TrainListEntry) {
  return { ...entry, createdAt: new Date(entry.createdAt).toISOString() };
}

function toTrainRecordJson(record: TrainRecord) {
  return { ...record, createdAt: new Date(record.createdAt).toISOString() };
}

/** 渲染对齐的文本表格。保持纯函数，以便无需数据库即可进行单元测试。 */
export function formatTrainList(entries: TrainListEntry[]): string {
  if (entries.length === 0) {
    return "No trainings found. Run `relay-pi train <folder>` to create one.";
  }
  const rows = entries.map((entry) => ({
    slug: entry.slug,
    headline: entry.headline ?? (entry.hasArchive ? "—" : "(archive missing)"),
    model: entry.model ?? "—",
    files: entry.fileCount === undefined ? "—" : String(entry.fileCount),
    trained: entry.observedDate,
    id: entry.memoryId,
  }));
  const headers = {
    slug: "SLUG",
    headline: "HEADLINE",
    model: "MODEL",
    files: "FILES",
    trained: "TRAINED",
    id: "MEMORY ID",
  };
  const width = (key: keyof typeof headers, cap: number) =>
    Math.min(cap, Math.max(headers[key].length, ...rows.map((row) => row[key].length)));
  const w = {
    slug: width("slug", 24),
    headline: width("headline", 48),
    model: width("model", 18),
    files: width("files", 5),
    trained: width("trained", 10),
    id: width("id", 20),
  };
  const line = (cells: typeof headers) =>
    [
      truncate(cells.slug, w.slug).padEnd(w.slug),
      truncate(cells.headline, w.headline).padEnd(w.headline),
      truncate(cells.model, w.model).padEnd(w.model),
      cells.files.padStart(w.files),
      cells.trained.padEnd(w.trained),
      cells.id,
    ].join("  ");
  return [line(headers), ...rows.map(line)].join("\n");
}

/** 单条 training 的多行详情视图（`relay-pi train show`）。 */
function formatTrainRecord(record: TrainRecord): string {
  return [
    `slug       : ${record.slug}`,
    `headline   : ${record.headline ?? "—"}`,
    `memory id  : ${record.memoryId}`,
    `model      : ${record.model ?? "—"}`,
    `files      : ${record.fileCount ?? "—"}`,
    `source     : ${record.sourceFolder ?? "—"}`,
    `trained    : ${record.observedDate}`,
    `archive    : ${record.hasArchive ? "present" : "missing"}`,
    "",
    record.content,
  ].join("\n");
}

interface TrainSubOptions {
  /** 位置参数 slug；show/update/delete 必填，list 不使用。 */
  slug?: string;
  /** 显式 backend 标志；为空时使用继承的存储以及默认 DB。 */
  sourceFlags: MemorySourceFlags;
  json: boolean;
  /** `update` 使用的新增 observation 文本路径。 */
  contentFile?: string;
  waitBudgetMs?: number;
}

/**
 * 管理子命令共用的参数解析器。每个命令会校验自己实际需要的字段（例如 show 需要
 * slug，update 还需要 `--content-file`）；此处只负责词法解析。
 */
function parseTrainSubArgs(args: string[], cwd: string): TrainSubOptions | undefined {
  const sourceArgs = lexMemorySourceFlags(args, cwd);
  let slug: string | undefined;
  let json = false;
  let contentFile: string | undefined;
  let waitBudgetMs: number | undefined;
  for (let i = 0; i < sourceArgs.args.length; i++) {
    const arg = sourceArgs.args[i]!;
    switch (arg) {
      case "--content-file":
        if (!sourceArgs.args[i + 1] || sourceArgs.args[i + 1]?.startsWith("-")) {
          usageError(`Missing value for ${arg}`);
        }
        contentFile = resolveUserPath(sourceArgs.args[++i]!, cwd);
        break;
      case "--json":
        json = true;
        break;
      case "--wait": {
        const raw = sourceArgs.args[++i];
        const seconds = Number(raw);
        if (!Number.isFinite(seconds) || seconds < 0) {
          usageError(`Invalid --wait value: ${raw} (expected non-negative number of seconds)`);
        }
        waitBudgetMs = seconds * 1000;
        break;
      }
      case "--help":
      case "-h":
        printTrainHelp();
        return undefined;
      default:
        if (arg.startsWith("-")) usageError(`Unknown train option: ${arg}`);
        if (slug !== undefined) usageError(`Unexpected extra argument: ${arg}`);
        slug = arg;
    }
  }
  return { slug, sourceFlags: sourceArgs.flags, json, contentFile, waitBudgetMs };
}

export async function runTrainListCommand(args: string[], io: TrainCommandIO): Promise<void> {
  const cwd = io.cwd ?? process.cwd();
  const options = parseTrainSubArgs(args, cwd);
  if (!options) return;
  if (options.slug !== undefined) usageError(`Unexpected argument for train list: ${options.slug}`);
  const sources = await resolveSources(options.sourceFlags, cwd);
  const entries = await listTrainSources(sources, options.waitBudgetMs);
  io.stdout.write(
    options.json
      ? `${JSON.stringify(entries.map(toTrainListEntryJson), null, 2)}\n`
      : `${formatTrainList(entries)}\n`,
  );
}

export async function runTrainShowCommand(args: string[], io: TrainCommandIO): Promise<void> {
  const cwd = io.cwd ?? process.cwd();
  const options = parseTrainSubArgs(args, cwd);
  if (!options) return;
  if (!options.slug) usageError("relay-pi train show requires a <slug> argument");
  const slug = options.slug;
  const sources = await resolveSources(options.sourceFlags, cwd);
  const record = await findTrainRecord(sources, slug, options.waitBudgetMs);
  if (!record) fail(`No training found for slug "${slug}".`);
  io.stdout.write(
    options.json
      ? `${JSON.stringify(toTrainRecordJson(record), null, 2)}\n`
      : `${formatTrainRecord(record)}\n`,
  );
}

export async function runTrainUpdateCommand(args: string[], io: TrainCommandIO): Promise<void> {
  const cwd = io.cwd ?? process.cwd();
  const options = parseTrainSubArgs(args, cwd);
  if (!options) return;
  if (!options.slug) usageError("relay-pi train update requires a <slug> argument");
  if (!options.contentFile) usageError("relay-pi train update requires --content-file <path>");
  const slug = options.slug;
  const content = await readFile(options.contentFile, "utf8");
  if (content.trim().length === 0) {
    fail(`Refusing to write empty content from ${options.contentFile}.`);
  }
  const sources = await resolveSources(options.sourceFlags, cwd);
  const updated = await updateTrainRecord(sources, slug, content, options.waitBudgetMs);
  if (!updated) fail(`No training found for slug "${slug}".`);
  if (options.json) {
    io.stdout.write(`${JSON.stringify(toTrainRecordJson(updated), null, 2)}\n`);
    return;
  }
  io.stdout.write(`Updated "${slug}" (memory id ${updated.memoryId}).\n`);
}

export async function runTrainDeleteCommand(args: string[], io: TrainCommandIO): Promise<void> {
  const cwd = io.cwd ?? process.cwd();
  const options = parseTrainSubArgs(args, cwd);
  if (!options) return;
  if (!options.slug) usageError("relay-pi train delete requires a <slug> argument");
  const slug = options.slug;
  const sources = await resolveSources(options.sourceFlags, cwd);
  const deleted = await deleteTrainRecord(sources, slug, options.waitBudgetMs);
  if (!deleted) fail(`No training found for slug "${slug}".`);
  if (options.json) {
    io.stdout.write(
      `${JSON.stringify({ deleted: true, slug: deleted.slug, memoryId: deleted.memoryId }, null, 2)}\n`,
    );
    return;
  }
  io.stdout.write(`Deleted "${deleted.slug}" (memory id ${deleted.memoryId}) and its archive.\n`);
}

async function listTrainSources(
  sources: MemorySources,
  waitBudgetMs: number | undefined,
): Promise<TrainListEntry[]> {
  const storeListings: Array<SourceListing<TrainListEntry>> = [];
  for (const store of sources.stores) {
    const entries = await Promise.all((await listStore(store)).map(toStoreTrainRecord));
    storeListings.push({ source: store, entries });
  }
  const dbListings: Array<SourceListing<TrainListEntry>> = [];
  for (const dbPath of sources.dbs) {
    const entries = await withMemoryDb(dbPath, (db) => db.listTrainings(), { waitBudgetMs });
    dbListings.push({ source: dbPath, entries });
  }
  return mergeListings(storeListings, dbListings);
}

async function findTrainRecord(
  sources: MemorySources,
  slug: string,
  waitBudgetMs: number | undefined,
): Promise<TrainRecord | undefined> {
  for (const store of sources.stores) {
    const entry = (await listStore(store)).find((candidate) => candidate.slug === slug);
    if (entry) return toStoreTrainRecord(entry);
  }
  for (const dbPath of sources.dbs) {
    const record = await withMemoryDb(dbPath, (db) => db.findTrainingBySlug(slug), {
      waitBudgetMs,
    });
    if (record) return record;
  }
  return undefined;
}

async function updateTrainRecord(
  sources: MemorySources,
  slug: string,
  content: string,
  waitBudgetMs: number | undefined,
): Promise<TrainRecord | undefined> {
  for (const store of sources.stores) {
    const existing = (await listStore(store)).find((candidate) => candidate.slug === slug);
    if (!existing) continue;
    return toStoreTrainRecord(await updateEntry(store, slug, content));
  }
  for (const dbPath of sources.dbs) {
    const updated = await withMemoryDb(
      dbPath,
      async (db): Promise<TrainRecord | undefined> => {
        const record = await db.findTrainingBySlug(slug);
        if (!record) return undefined;
        await db.updateContent(record.memoryId, content);
        return { ...record, content };
      },
      { waitBudgetMs },
    );
    if (updated) return updated;
  }
  return undefined;
}

async function deleteTrainRecord(
  sources: MemorySources,
  slug: string,
  waitBudgetMs: number | undefined,
): Promise<TrainRecord | undefined> {
  for (const store of sources.stores) {
    const existing = (await listStore(store)).find((candidate) => candidate.slug === slug);
    if (!existing) continue;
    const record = await toStoreTrainRecord(existing);
    const deleted = await deleteEntry(store, slug);
    if (deleted.archiveId) await removeArchive(deleted.archiveId);
    return record;
  }
  for (const dbPath of sources.dbs) {
    const deleted = await withMemoryDb(
      dbPath,
      async (db): Promise<TrainRecord | undefined> => {
        const record = await db.findTrainingBySlug(slug);
        if (!record) return undefined;
        await db.delete(record.memoryId);
        return record;
      },
      { waitBudgetMs },
    );
    if (deleted) return deleted;
  }
  return undefined;
}

async function toStoreTrainRecord(entry: StoredMemory): Promise<TrainRecord> {
  const archiveId = entry.archiveId;
  const manifest = archiveId ? await readArchiveManifest(archiveId) : undefined;
  return {
    slug: entry.slug,
    memoryId: entry.id,
    createdAt: entry.createdAt,
    observedDate: new Date(entry.createdAt).toISOString().slice(0, 10),
    ...(entry.headline === undefined ? {} : { headline: entry.headline }),
    ...(entry.model === undefined ? {} : { model: entry.model }),
    ...(manifest?.sourceFolder === undefined ? {} : { sourceFolder: manifest.sourceFolder }),
    ...(entry.fileCount === undefined ? {} : { fileCount: entry.fileCount }),
    hasArchive: manifest !== undefined,
    store: entry.storeDir,
    content: entry.content,
    ...(archiveId && manifest
      ? {
          files: manifest.files.map((file) => archivedFilePath(archiveId, file.relPath)),
        }
      : {}),
  };
}
