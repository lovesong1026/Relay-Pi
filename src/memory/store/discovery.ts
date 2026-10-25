import { lstat } from "node:fs/promises";
import { join } from "node:path";

import { walkAncestors } from "../../lib/walk-ancestors.js";

const MEMORY_ROOT_NAMES = [".relay-pi", ".agents", ".claude"] as const;

/** 从 cwd 向文件系统根目录收集的真实 memory-store 目录。
 * 最近的 ancestor 自然优先，因为调用方先消费此顺序；共享的 project-scope ancestor walk 会排除 `$HOME`。 */
export async function discoverMemoryStores(cwd: string): Promise<string[]> {
  const stores: string[] = [];
  for (const ancestor of walkAncestors(cwd)) {
    for (const rootName of MEMORY_ROOT_NAMES) {
      const storeDir = join(ancestor, rootName, "memories");
      const status = await lstat(storeDir).catch((error: unknown) => {
        if (isNodeError(error, "ENOENT") || isNodeError(error, "ENOTDIR")) return undefined;
        throw error;
      });
      if (!status) continue;
      if (status.isSymbolicLink()) throw new Error(`Memory stores cannot be symlinks: ${storeDir}`);
      if (!status.isDirectory()) throw new Error(`Memory store is not a directory: ${storeDir}`);
      stores.push(storeDir);
    }
  }
  return stores;
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
