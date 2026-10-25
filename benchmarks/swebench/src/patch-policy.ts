/** rollout 准入与报告共享的精确路径级 patch-policy 结果。 */
export interface PatchLint {
  /** 已 staged 到最终相对于 baseline 的 patch 中的路径。 */
  paths: string[];
  /** 可读的 findings，包括空内容等可评分的模型结果。 */
  violations: string[];
  /** 阻止导出的完整性违规；空模型答案仍可评分。 */
  admissionViolations: string[];
}

/** 记录与评分相关的 patch 事实，但不强加基准测试自有的路径 policy。 */
export function lintPatch(patch: string, paths: readonly string[], maxBytes: number): PatchLint {
  const violations: string[] = [];
  const bytes = Buffer.byteLength(patch);
  if (bytes === 0) violations.push("patch is empty");
  if (bytes > maxBytes) violations.push(`patch is ${bytes} bytes (limit ${maxBytes})`);
  return {
    paths: [...paths],
    violations,
    admissionViolations: violations.filter((violation) => violation !== "patch is empty"),
  };
}
