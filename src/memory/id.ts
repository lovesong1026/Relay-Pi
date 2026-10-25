import { nanoid } from "nanoid";

/** 生成所有 memory backend 共享的稳定 `mem_…` 标识。 */
export function createMemoryId(): string {
  return `mem_${nanoid(12)}`;
}
