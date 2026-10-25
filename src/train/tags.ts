/**
 * 每个 `relay-pi train` row 都携带的标签方案集中定义于此，确保创建/替换路径与
 * list/show/update/delete 命令使用同一方案。
 *
 * 每条训练 observation 同时带有 `TRAIN_TAG`（标记该 row 由 train 管理）和
 * `trainSlugTag(slug)`（corpus 的身份）。slug 是稳定且面向用户的句柄：CRUD 命令
 * 通过这些 helper 将 slug 解析为对应 row，而不是暴露内部的 `mem_…` id。
 */
export const TRAIN_TAG = "train";

const TRAIN_SLUG_PREFIX = "train:";

/** 每个 corpus 的身份标签，例如 `train:acme-research`。 */
export function trainSlugTag(slug: string): string {
  return `${TRAIN_SLUG_PREFIX}${slug}`;
}

/** observation 是 `relay-pi train` row 时返回 true。 */
export function isTrainTagged(tags: readonly string[]): boolean {
  return tags.includes(TRAIN_TAG);
}

/** 从 train row 的标签中提取 slug；不存在时返回 `undefined`。 */
export function slugFromTags(tags: readonly string[]): string | undefined {
  return tags.find((tag) => tag.startsWith(TRAIN_SLUG_PREFIX))?.slice(TRAIN_SLUG_PREFIX.length);
}
