import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

/**
 * 依次返回 cwd、其父目录、祖父目录……直到文件系统根目录。
 * 排除主目录，避免 cwd 位于 $HOME 内时，全局（主目录范围）
 * 配置又被计作项目配置。
 * 技能发现和路由表发现共用——二者必须对
 *“项目范围向上遍历”的含义达成一致，因此遍历逻辑只有一个所有者。
 */
export function walkAncestors(cwd: string, home: string = homedir()): string[] {
  const resolvedHome = resolve(home);
  const seen = new Set<string>();
  const result: string[] = [];
  let current = resolve(cwd);
  while (true) {
    if (seen.has(current)) break;
    seen.add(current);
    if (current !== resolvedHome) result.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return result;
}
