import { randomBytes } from "node:crypto";

import { createEmbeddingClient, type EmbedFn } from "../memory/embedding.js";
import { createMemoryId } from "../memory/id.js";
import { listStore, writeEntry } from "../memory/store/store.js";
import { resolveSources, type MemorySourceFlags } from "../memory/store/sources.js";
import { appendObservation } from "../memory/storage.js";
import { DEFAULT_MEMORY_DB_PATH } from "../session/session-manager.js";
import type { ObservationPriority, ObservationSource } from "../types/memory.js";
import { printMemoryAddHelp } from "./help.js";
import { toMemoryJson } from "./memory-json.js";
import { scoreObservation, withMemorySession } from "./memory-db.js";
import { PRIORITIES, parseEnum, SOURCES } from "./memory-query.js";
import {
  lexMemorySourceFlags,
  requireSingleExplicitWriteTarget,
  requireWriteTarget,
} from "./memory-sources.js";
import { fail, loadCliEnvFiles, usageError } from "./shared.js";

type SourceKind = ObservationSource["kind"];

interface AddCommandOptions {
  /** 显式后端标志；为空表示不带标志的存储发现。 */
  sourceFlags: MemorySourceFlags;
  /** 为检查单个选定数据库的调用方提供的兼容投影。 */
  dbPath: string;
  /** 用空格连接的位置参数内容；调用方改用 stdin 管道时为空。 */
  content: string;
  priority: ObservationPriority;
  /** 标记在记录上并回显的来源；默认为 `user`。 */
  source: SourceKind;
  tags: string[];
  /** 创建该记录的会话；省略则记录保持全局/无归属。 */
  sessionId?: string;
  /** 输出所选后端的 JSON 记录，而非供人阅读的单行文本。 */
  json: boolean;
  waitBudgetMs?: number;
}

interface AddCommandIO {
  stdout: NodeJS.WritableStream;
  stdin: NodeJS.ReadableStream & { isTTY?: boolean };
  /** 用于相对路径和无标志来源发现的工作目录。 */
  cwd?: string;
  /**
   * 插入时同步生成 embedding 所用的客户端。默认使用
   * OpenRouter 端点客户端；测试注入桩（或抛出异常的桩），
   * 无需网络调用即可验证 embedding 成功/降级路径。
   */
  embed?: EmbedFn;
}

/**
 * 运行 `relay-pi memory add`，将一条整理后的笔记写入记忆文件存储
 * 或旧版观察式数据库。不带标志的写入会创建最近 agent 的
 * `.agents/memories` 目录。数据库笔记保留其排名、反思、
 * 会话归属和同步 embedding 行为；文件笔记将
 * 优先级/来源/标签保存在 frontmatter 中，并通过存储上下文加载。
 *
 * 内容来自位置参数；未提供时则从 stdin 读取，
 * 以便调用方通过管道传入较长文本（`echo "…" | relay-pi memory add`）。
 *
 * 对于数据库目标，embedding 与记录同步写入
 * （这个单次进程不运行回填 worker），因此 `relay-pi memory recall`
 * 和下次会话的 `recall_memory` 可以立即通过语义检索找到它。
 * embedding 不可用时，添加仍会成功，后续
 * 运行器的回填过程会为该记录生成 embedding。
 */
export async function runMemoryAddCommand(
  args: string[],
  io: AddCommandIO = { stdout: process.stdout, stdin: process.stdin },
): Promise<void> {
  const cwd = io.cwd ?? process.cwd();
  const options = parseMemoryAddArgs(args, cwd);
  if (!options) return;
  // 即使共享凭据只存在于 env 文件中，embedding 写入也需要它，
  // 加载顺序与 run 命令一致。
  loadCliEnvFiles(cwd);

  const content = await resolveContent(options.content, io);
  const sources = await resolveSources(options.sourceFlags, cwd);
  const writeTarget = requireWriteTarget(sources);
  if (writeTarget.kind === "store") {
    if (options.sessionId) usageError("--session is only supported with --db <file>.");
    await writeStoreNote(writeTarget.path, content, options, io);
    return;
  }
  const embed = io.embed ?? createEmbeddingClient();

  const observation = await withMemorySession(
    writeTarget.path,
    (session) =>
      appendObservation(
        session,
        {
          kind: "note",
          priority: options.priority,
          source: { kind: options.source },
          content,
          tags: options.tags,
          observedDate: new Date().toISOString().slice(0, 10),
          ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
        },
        { embed },
      ),
    { waitBudgetMs: options.waitBudgetMs },
  );
  if (!observation) {
    fail(`Could not write memory to ${writeTarget.path} (lock contention).`);
  }

  if (options.json) {
    // 使用同一个 `now` 评分；插入时 `lastUsedAt == createdAt`，因此
    // 记忆包分数反映刚存储的记录。省略 `relevanceScore`，
    // 因为添加时没有可用于排名的查询。
    const packScore = scoreObservation(observation, Date.now());
    io.stdout.write(`${JSON.stringify(toMemoryJson(observation, { packScore }), null, 2)}\n`);
    return;
  }

  const tagSuffix = observation.tags.length > 0 ? ` [${observation.tags.join(", ")}]` : "";
  io.stdout.write(
    `Added ${observation.priority}-priority memory ${observation.id} (${observation.observedDate})${tagSuffix}\n`,
  );
}

/**
 * 解析 `relay-pi memory add` 标志和位置参数内容。处理了 `--help`
 * 后返回 `undefined`。它是纯函数（无 I/O），可进行单元测试；内容为空时
 * 从 stdin 读取的后备处理稍后在 {@link resolveContent} 中执行。
 */
export function parseMemoryAddArgs(
  args: string[],
  cwd: string = process.cwd(),
): AddCommandOptions | undefined {
  const sourceArgs = lexMemorySourceFlags(args, cwd);
  requireSingleExplicitWriteTarget(sourceArgs.flags);
  let priority: ObservationPriority = "medium";
  let source: SourceKind = "user";
  let sessionId: string | undefined;
  let json = false;
  const tags: string[] = [];
  let waitBudgetMs: number | undefined;
  const contentParts: string[] = [];

  for (let i = 0; i < sourceArgs.args.length; i++) {
    const arg = sourceArgs.args[i]!;
    switch (arg) {
      case "--priority":
        priority = parseEnum(sourceArgs.args[++i], PRIORITIES, arg);
        break;
      case "--source":
        source = parseEnum(sourceArgs.args[++i], SOURCES, arg);
        break;
      case "--session":
        if (!sourceArgs.args[i + 1] || sourceArgs.args[i + 1]?.startsWith("-")) {
          usageError(`Missing value for ${arg}`);
        }
        sessionId = sourceArgs.args[++i]!;
        break;
      case "--json":
        json = true;
        break;
      case "--tag":
        if (!sourceArgs.args[i + 1] || sourceArgs.args[i + 1]?.startsWith("-")) {
          usageError(`Missing value for ${arg}`);
        }
        tags.push(sourceArgs.args[++i]!);
        break;
      case "--wait": {
        const raw = sourceArgs.args[++i];
        const seconds = Number(raw);
        if (!raw || !Number.isFinite(seconds) || seconds < 0) {
          usageError(`Invalid --wait value: ${raw} (expected non-negative number of seconds)`);
        }
        waitBudgetMs = Math.round(seconds * 1000);
        break;
      }
      case "--help":
      case "-h":
        printMemoryAddHelp();
        return undefined;
      default:
        if (arg.startsWith("-")) usageError(`Unknown add option: ${arg}`);
        contentParts.push(arg);
    }
  }

  return {
    sourceFlags: sourceArgs.flags,
    dbPath: sourceArgs.flags.dbs[0] ?? DEFAULT_MEMORY_DB_PATH,
    content: contentParts.join(" ").trim(),
    priority,
    source,
    tags,
    json,
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(waitBudgetMs !== undefined ? { waitBudgetMs } : {}),
  };
}

/**
 * 解析记忆文本：存在位置参数内容时使用它，否则从 stdin 读取，
 * 以便通过管道传入较长记忆。TTY 下无内容视为用法错误，
 * 而不是无限等待；解析后的内容为空时也会拒绝。
 */
async function resolveContent(positional: string, io: AddCommandIO): Promise<string> {
  let content = positional;
  if (content.length === 0) {
    if (io.stdin.isTTY) {
      usageError("No memory content provided. Pass it as an argument or pipe via stdin.");
    }
    content = (await readStream(io.stdin)).trim();
  }
  if (content.length === 0) usageError("Refusing to add an empty memory.");
  return content;
}

async function readStream(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function writeStoreNote(
  storeDir: string,
  content: string,
  options: AddCommandOptions,
  io: AddCommandIO,
): Promise<void> {
  const slug = await createNoteSlug(storeDir, content);
  const id = createMemoryId();
  const createdAt = Date.now();
  const stored = await writeEntry(storeDir, {
    slug,
    version: 1,
    id,
    kind: "note",
    createdAt,
    priority: options.priority,
    source: options.source,
    tags: options.tags,
    content,
  });

  if (options.json) {
    io.stdout.write(
      `${JSON.stringify(
        {
          slug: stored.slug,
          id: stored.id,
          kind: stored.kind,
          createdAt: new Date(stored.createdAt).toISOString(),
          content: stored.content,
          priority: options.priority,
          source: options.source,
          tags: options.tags,
          store: stored.storeDir,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  const tagSuffix = options.tags.length > 0 ? ` [${options.tags.join(", ")}]` : "";
  io.stdout.write(
    `Added ${options.priority}-priority memory ${stored.id} as ${stored.slug} (${new Date(createdAt)
      .toISOString()
      .slice(0, 10)})${tagSuffix}\n`,
  );
}

async function createNoteSlug(storeDir: string, content: string): Promise<string> {
  const words =
    content
      .toLowerCase()
      .match(/[a-z0-9]+/g)
      ?.slice(0, 5) ?? [];
  const stem = (words.join("-") || "note").slice(0, 48).replace(/-+$/g, "") || "note";
  const existing = new Set((await listStore(storeDir)).map((entry) => entry.slug));
  while (true) {
    const slug = `${stem}-${randomBytes(3).toString("hex")}`;
    if (!existing.has(slug)) return slug;
  }
}
