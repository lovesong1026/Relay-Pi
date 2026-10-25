import { DEFAULT_RELAY_PI_HOME } from "../memory/paths.js";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path, { dirname, join } from "node:path";

import type { ArchivedFile, TrainManifest } from "./types.js";

/**
 * 隐藏的、按 memory 划分的 archive 根目录。以 observation id 为键，使 archive 与 memory row
 * 共享生命周期；用户清理 memory 时可以一起清理。
 */
function archiveRootForMemoryId(memoryId: string): string {
  // 在 codec 的 frontmatter 校验之后再加一道防线：此路径会传给递归删除，
  // 因此 traversal id 绝不能离开根目录。
  if (!/^[A-Za-z0-9_-]+$/.test(memoryId)) {
    throw new Error(`Archive memory id must be a safe path segment: ${memoryId}`);
  }
  return join(DEFAULT_RELAY_PI_HOME, "train", memoryId);
}

export interface WriteArchiveInput {
  memoryId: string;
  files: ArchivedFile[];
  manifest: TrainManifest;
}

/**
 * 将每个 archive 文件复制到 `<archive>/files/<relPath>`，并将 manifest 写入
 * `<archive>/manifest.json`。返回 archive 根目录。
 */
export async function writeArchive(input: WriteArchiveInput): Promise<string> {
  const root = archiveRootForMemoryId(input.memoryId);
  await mkdir(join(root, "files"), { recursive: true });

  for (const file of input.files) {
    const destination = archivedFilePath(input.memoryId, file.relPath);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(file.absPath, destination);
  }

  await writeFile(join(root, "manifest.json"), JSON.stringify(input.manifest, null, 2));
  return root;
}

export async function removeArchive(memoryId: string): Promise<void> {
  await rm(archiveRootForMemoryId(memoryId), { recursive: true, force: true });
}

/** 一个 archive 副本的绝对路径：`<archive>/files/<relPath>`。此处负责维护 `writeArchive` 复制到的布局，以及 `TrainRecord.files` 报告的布局。 */
export function archivedFilePath(memoryId: string, relPath: string): string {
  return join(archiveRootForMemoryId(memoryId), "files", relPath);
}

/**
 * 读取训练 archive 的 manifest；archive 不存在或不可读时返回 `undefined`（例如被
 * 外部清理）。这里与 `writeArchive` 一起负责 archive 根目录布局。
 */
export async function readArchiveManifest(memoryId: string): Promise<TrainManifest | undefined> {
  try {
    const raw = await readFile(join(archiveRootForMemoryId(memoryId), "manifest.json"), "utf8");
    return JSON.parse(raw) as TrainManifest;
  } catch {
    return undefined;
  }
}

/**
 * corpus walk 的跳过规则。省略点文件/目录、版本控制和依赖缓存，以及子 Agent 用来向 CLI
 * 返回结构化字段的 JSON handoff 文件。
 */
function isSkippedName(name: string): boolean {
  if (name.startsWith(".")) return true;
  if (name === "node_modules" || name === ".git") return true;
  if (name === ".relay-pi-train.json") return true;
  return false;
}

function toPosix(relPath: string): string {
  return relPath.split(path.sep).join("/");
}

async function walk(current: string, out: string[]): Promise<void> {
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    if (isSkippedName(entry.name)) continue;
    const abs = path.join(current, entry.name);
    if (entry.isDirectory()) {
      await walk(abs, out);
    } else if (entry.isFile()) {
      out.push(abs);
    }
  }
}

/**
 * 遍历 corpus 文件夹，生成 archive 的 manifest row。
 * 这只是 provenance walker——不做文本提取，也不做 MIME 分派。
 * 结果按 `relPath` 排序，使 manifest 在重复训练之间确定且可 diff。
 */
export async function collectArchiveFiles(folder: string): Promise<ArchivedFile[]> {
  const root = path.resolve(folder);
  const absPaths: string[] = [];
  await walk(root, absPaths);

  const files: ArchivedFile[] = [];
  for (const absPath of absPaths) {
    const relPath = toPosix(path.relative(root, absPath));
    const buf = await readFile(absPath);
    const sha256 = createHash("sha256").update(buf).digest("hex");
    const { size: bytes } = await stat(absPath);
    files.push({ relPath, absPath, bytes, sha256 });
  }

  files.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  return files;
}
