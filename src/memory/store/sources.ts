import * as fileSystem from "node:fs/promises";
import { join, resolve } from "node:path";

import { walkAncestors } from "../../lib/walk-ancestors.js";
import { DEFAULT_MEMORY_DB_PATH } from "../paths.js";
import { discoverMemoryStores } from "./discovery.js";

/** 从可重复 CLI backend flag 收集的、有序 source 路径。 */
export interface MemorySourceFlags {
  /** 显式指定的 memory-file 目录，按命令行顺序排列。 */
  stores: string[];
  /** 显式指定的 PGlite 文件，按命令行顺序排列。 */
  dbs: string[];
}

/** create 操作选定的唯一 backend。 */
export interface MemoryWriteTarget {
  /** 选择 file-store 或旧版 PGlite 持久化路径。 */
  kind: "store" | "db";
  /** 绝对 store 目录或 PGlite 数据路径。 */
  path: string;
}

/** 有效的读取 source，以及由其推导出的 create-operation target。 */
export interface MemorySources {
  /** 按 collision precedence 排列的 file store。 */
  stores: string[];
  /** 在所有 file store 之后，按 collision precedence 排列的 PGlite 路径。 */
  dbs: string[];
  /** 仅当本次调用恰好选择了一个 write backend 时存在。 */
  writeTarget?: MemoryWriteTarget;
}

/** 一个 backend 已投影的 listing row。 */
export interface SourceListing<T> {
  /** 绝对 backend 路径；file-store group 会将它写入 row 作为 provenance。 */
  source: string;
  /** 该 backend 在 collision resolution 之前返回的 row。 */
  entries: readonly T[];
}

/**
 * 解析显式 flag，或 skills 风格的不带 flag source 集合。
 *
 * 任一显式 backend flag 都会替换发现结果。没有 flag 时，读取会继承从 cwd 向文件系统根目录
 * 的所有现有 memory store，然后查询默认 DB。写入目标是拥有 `.agents` 目录的最近 ancestor；
 * 如果没有 Agent 标记则回退到 cwd；`memories` 子目录本身可以不存在，因为 writer 会创建它。
 */
export async function resolveSources(
  flags: MemorySourceFlags,
  cwd: string,
): Promise<MemorySources> {
  const explicitCount = flags.stores.length + flags.dbs.length;
  if (explicitCount > 0) {
    const stores = unique(flags.stores);
    const dbs = unique(flags.dbs);
    const selected = flags.stores[0] ?? flags.dbs[0];
    const writeTarget: MemoryWriteTarget | undefined =
      explicitCount === 1 && selected
        ? { kind: flags.stores.length === 1 ? "store" : "db", path: selected }
        : undefined;
    return {
      stores,
      dbs,
      ...(writeTarget ? { writeTarget } : {}),
    };
  }

  const stores = await discoverMemoryStores(cwd);
  return {
    stores,
    dbs: [DEFAULT_MEMORY_DB_PATH],
    writeTarget: { kind: "store", path: await nearestAgentMemoryStore(cwd) },
  };
}

/**
 * 按唯一的 canonical ordering policy 合并投影后的 row。
 *
 * File-store group 位于 DB group 之前；每个 family 内部的最近 ancestor 或显式 flag 顺序由
 * 调用方提供。同一 slug 的 collision 取第一条。移除被遮蔽副本后，所有 winner 再按最新优先
 * 排序；时间戳相同则保留 precedence 顺序。
 */
export function mergeListings<T extends { slug: string; createdAt: number }>(
  storeEntries: readonly SourceListing<T>[],
  dbEntries: readonly SourceListing<T>[],
): Array<T & { store?: string }> {
  const winners = new Map<string, T & { store?: string }>();
  for (const listing of storeEntries) {
    for (const entry of listing.entries) {
      if (!winners.has(entry.slug)) winners.set(entry.slug, { ...entry, store: listing.source });
    }
  }
  for (const listing of dbEntries) {
    for (const entry of listing.entries) {
      if (!winners.has(entry.slug)) winners.set(entry.slug, { ...entry });
    }
  }
  return Array.from(winners.values()).sort((left, right) => right.createdAt - left.createdAt);
}

async function nearestAgentMemoryStore(cwd: string): Promise<string> {
  for (const ancestor of walkAncestors(cwd)) {
    const agentRoot = join(ancestor, ".agents");
    const status = await fileSystem.lstat(agentRoot).catch((error: unknown) => {
      if (isNodeError(error, "ENOENT") || isNodeError(error, "ENOTDIR")) return undefined;
      throw error;
    });
    if (!status) continue;
    if (status.isSymbolicLink())
      throw new Error(`Agent directories cannot be symlinks: ${agentRoot}`);
    if (!status.isDirectory()) throw new Error(`Agent path is not a directory: ${agentRoot}`);
    return join(agentRoot, "memories");
  }
  return join(resolve(cwd), ".agents", "memories");
}

function unique(paths: readonly string[]): string[] {
  return Array.from(new Set(paths));
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
