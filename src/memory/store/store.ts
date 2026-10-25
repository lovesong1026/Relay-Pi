import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import * as fileSystem from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import {
  parseMemoryFile,
  serializeMemoryFile,
  slugFromFilename,
  type DerivedMemoryIdentity,
  type MemoryFileRecord,
} from "./file.js";

/** 从具体 memory-store 目录读取的一条 record 的公开视图。 */
export interface StoredMemory {
  /** Filename stem，以及 store 内的权威 identity。 */
  slug: string;
  /** 包含 record 的绝对目录，作为 provenance layer 使用。 */
  storeDir: string;
  /** 与 API 和私有 archive metadata 共享的稳定 record identity。 */
  id: string;
  /** 内容是 synthesized training，还是直接精选的 note。 */
  kind: MemoryFileRecord["kind"];
  /** 用于 observed date 和从新到旧排序的 Unix epoch 毫秒数。 */
  createdAt: number;
  /** 精选内容的简短展示标签。 */
  headline?: string;
  /** 生成 synthesized 内容的 model 标识（适用时存在）。 */
  model?: string;
  /** synthesized 内容表示的 source 文件数。 */
  fileCount?: number;
  /** 私有 archive manifest 标识；绝不是绝对 archive 路径。 */
  archiveId?: string;
  /** 精确的精选 markdown body。 */
  content: string;
}

/** 新文件的输入；slug 选择文件名，且不会被序列化。 */
export interface MemoryEntryInput extends MemoryFileRecord {
  /** 用于 `<slug>.md` 的安全 filename stem。 */
  slug: string;
}

/** 按 lexical slug 顺序列出有效的 markdown record。 */
export async function listStore(dir: string): Promise<StoredMemory[]> {
  return listStoreWithInvalidPolicy(dir);
}

/**
 * 列出有效 record，同时隔离格式错误的文件。Runtime prompt 加载使用此 best-effort 形式，
 * 因此手工编辑的单个文件不会阻塞启动；管理命令仍保留 {@link listStore} 的严格失败行为。
 */
export async function listStoreTolerant(
  dir: string,
  onInvalidEntry: (path: string, error: unknown) => void,
): Promise<StoredMemory[]> {
  return listStoreWithInvalidPolicy(dir, onInvalidEntry);
}

async function listStoreWithInvalidPolicy(
  dir: string,
  onInvalidEntry?: (path: string, error: unknown) => void,
): Promise<StoredMemory[]> {
  const storeDir = await requireStoreDirectory(dir, false);
  if (!storeDir) return [];
  const directoryEntries = await fileSystem.readdir(storeDir, { withFileTypes: true });
  const memoryEntries = directoryEntries
    .filter((entry) => entry.name.endsWith(".md"))
    .sort((left, right) => left.name.localeCompare(right.name));
  const loaded = await Promise.all(
    memoryEntries.map(async (entry) => {
      const path = join(storeDir, entry.name);
      try {
        if (entry.isSymbolicLink())
          throw new Error(`Memory files cannot be symlinks: ${entry.name}`);
        if (!entry.isFile()) throw new Error(`Memory entry is not a regular file: ${entry.name}`);
        return await readEntry(storeDir, slugFromFilename(entry.name));
      } catch (error) {
        if (!onInvalidEntry) throw error;
        onInvalidEntry(path, error);
        return undefined;
      }
    }),
  );
  return loaded.filter((entry): entry is StoredMemory => entry !== undefined);
}

/** 按安全的 filename stem 读取一条 record。 */
export async function readEntry(dir: string, slug: string): Promise<StoredMemory> {
  const safeSlug = assertSlug(slug);
  const storeDir = await requireStoreDirectory(dir, false);
  if (!storeDir) throw new Error(`Memory store does not exist: ${resolve(dir)}`);
  return (await readParsedEntry(storeDir, safeSlug)).stored;
}

/** 原子地创建或替换一个 memory 文件。 */
export async function writeEntry(dir: string, record: MemoryEntryInput): Promise<StoredMemory> {
  const slug = assertSlug(record.slug);
  const bytes = serializeMemoryFile(record);
  const storeDir = await requireStoreDirectory(dir, true);
  if (!storeDir) throw new Error("Memory store could not be created");
  const destination = join(storeDir, `${slug}.md`);
  await rejectSymlinkIfPresent(destination);

  const temporary = join(storeDir, `.${slug}.${randomUUID()}.tmp`);
  const handle = await fileSystem.open(temporary, "wx", 0o600);
  try {
    try {
      await handle.writeFile(bytes, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fileSystem.rename(temporary, destination);
  } catch (error) {
    await fileSystem.rm(temporary, { force: true });
    throw error;
  }
  return toStoredMemory(storeDir, slug, record);
}

/** 仅替换 record 的精选 body，同时保留所有 frontmatter。 */
export async function updateEntry(
  dir: string,
  slug: string,
  content: string,
): Promise<StoredMemory> {
  const safeSlug = assertSlug(slug);
  const storeDir = await requireStoreDirectory(dir, false);
  if (!storeDir) throw new Error(`Memory store does not exist: ${resolve(dir)}`);
  const { record } = await readParsedEntry(storeDir, safeSlug);
  record.content = content;
  // 保留解析对象的 identity，让 serializeMemoryFile 能够保留 CRLF；在这里使用 spread 会
  // 脱离 codec 的私有 line-ending metadata。
  return writeEntry(storeDir, Object.assign(record, { slug: safeSlug }));
}

/** 删除一条 record，并返回其 bytes 的已解析公开视图。 */
export async function deleteEntry(dir: string, slug: string): Promise<StoredMemory> {
  const safeSlug = assertSlug(slug);
  const storeDir = await requireStoreDirectory(dir, false);
  if (!storeDir) throw new Error(`Memory store does not exist: ${resolve(dir)}`);
  const { stored } = await readParsedEntry(storeDir, safeSlug);
  const path = join(storeDir, `${safeSlug}.md`);
  await rejectSymlinkIfPresent(path);
  await fileSystem.unlink(path);
  return stored;
}

async function readParsedEntry(
  storeDir: string,
  slug: string,
): Promise<{ stored: StoredMemory; record: MemoryFileRecord }> {
  const path = join(storeDir, `${slug}.md`);
  const status = await fileSystem.lstat(path);
  if (status.isSymbolicLink()) throw new Error(`Memory files cannot be symlinks: ${path}`);
  if (!status.isFile()) throw new Error(`Memory entry is not a regular file: ${path}`);
  const handle = await fileSystem.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const text = await handle.readFile("utf8").finally(() => handle.close());
  const record = parseMemoryFile(text, { derived: derivedIdentity(storeDir, slug, status) });
  return { stored: toStoredMemory(storeDir, slug, record), record };
}

// 手写文件没有 id 或创建时间。因此它的 identity 由所在位置决定：读取之间稳定，
// 在共享 slug 的不同 store 之间互不相同，并会在首次重新序列化时写入文件。
function derivedIdentity(
  storeDir: string,
  slug: string,
  status: { birthtimeMs: number; mtimeMs: number },
): DerivedMemoryIdentity {
  const digest = createHash("sha256")
    .update(`${resolve(storeDir)}\n${slug}`)
    .digest("base64url");
  return {
    id: `mem_${digest.slice(0, 12)}`,
    createdAt: Math.round(status.birthtimeMs > 0 ? status.birthtimeMs : status.mtimeMs),
  };
}

function toStoredMemory(storeDir: string, slug: string, record: MemoryFileRecord): StoredMemory {
  return {
    slug,
    storeDir,
    id: record.id,
    kind: record.kind,
    createdAt: record.createdAt,
    ...(record.headline === undefined ? {} : { headline: record.headline }),
    ...(record.model === undefined ? {} : { model: record.model }),
    ...(record.fileCount === undefined ? {} : { fileCount: record.fileCount }),
    ...(record.archiveId === undefined ? {} : { archiveId: record.archiveId }),
    content: record.content,
  };
}

function assertSlug(slug: string): string {
  if (basename(slug) !== slug) throw new Error(`Unsafe memory slug: ${slug}`);
  return slugFromFilename(`${slug}.md`);
}

async function requireStoreDirectory(dir: string, create: boolean): Promise<string | undefined> {
  const storeDir = resolve(dir);
  const status = await fileSystem.lstat(storeDir).catch((error: unknown) => {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw error;
  });
  if (!status && create) {
    await fileSystem.mkdir(storeDir, { recursive: true, mode: 0o700 });
    const createdStatus = await fileSystem.lstat(storeDir);
    if (!createdStatus.isDirectory() || createdStatus.isSymbolicLink()) {
      throw new Error(`Memory store must be a real directory: ${storeDir}`);
    }
    return storeDir;
  }
  if (!status) return undefined;
  if (status.isSymbolicLink()) throw new Error(`Memory stores cannot be symlinks: ${storeDir}`);
  if (!status.isDirectory()) throw new Error(`Memory store is not a directory: ${storeDir}`);
  return storeDir;
}

async function rejectSymlinkIfPresent(path: string): Promise<void> {
  const status = await fileSystem.lstat(path).catch((error: unknown) => {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw error;
  });
  if (status?.isSymbolicLink()) throw new Error(`Memory files cannot be symlinks: ${path}`);
  if (status && !status.isFile()) throw new Error(`Memory entry is not a regular file: ${path}`);
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
