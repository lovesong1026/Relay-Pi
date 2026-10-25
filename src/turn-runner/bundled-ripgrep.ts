import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { dirname, delimiter } from "node:path";

/**
 * 解析通过 `@vscode/ripgrep` 捆绑的 ripgrep 二进制文件路径。
 *
 * 当未安装特定平台的可选依赖时返回 `null`（而不是抛出异常）——例如在不受支持的平台上，
 * 或使用 `npm install --no-optional` 时。此时调用方会回退到用户的 `$PATH`。
 */
async function resolveBundledRgPath(): Promise<string | null> {
  try {
    const mod = (await import("@vscode/ripgrep")) as { rgPath?: string };
    const rgPath = mod.rgPath;
    if (rgPath && existsSync(rgPath)) {
      return rgPath;
    }
  } catch {
    // 此平台缺少可选依赖；静默回退。
  }
  return null;
}

// 缓存结果，使每个进程只解析并探测一次文件系统。
let rgDirPromise: Promise<string | null> | undefined;

async function getBundledRgDir(): Promise<string | null> {
  if (!rgDirPromise) {
    rgDirPromise = resolveBundledRgPath().then((rg) => (rg ? dirname(rg) : null));
  }
  return rgDirPromise;
}

/**
 * 包装一个 `BashOperations` 实现，使每条命令的 `PATH` 中都包含捆绑的 `rg` 二进制文件。
 *
 * 有意将其置于开头（而非末尾）：捆绑版本是已经过 Agent 测试的已知可用 ripgrep，
 * 因此应优先于用户恰好在 PATH 中安装的旧版。需要不同 `rg` 的高级用户可以显式调用绝对路径。
 */
export function withBundledRipgrep(base: BashOperations): BashOperations {
  return {
    exec: async (command, cwd, options) => {
      const rgDir = await getBundledRgDir();
      if (!rgDir) {
        return base.exec(command, cwd, options);
      }
      const baseEnv = options.env ?? process.env;
      const currentPath = baseEnv.PATH ?? process.env.PATH ?? "";
      // 避免重复调用时重复添加该条目。
      const alreadyPresent = currentPath.split(delimiter).some((segment) => segment === rgDir);
      const nextPath = alreadyPresent ? currentPath : `${rgDir}${delimiter}${currentPath}`;
      return base.exec(command, cwd, {
        ...options,
        env: { ...baseEnv, PATH: nextPath },
      });
    },
  };
}
