import dedent from "dedent";

/** 所有 arm 逐字节共享的最小无人值守运行契约。 */
export const SWEBENCH_SYSTEM_PROMPT = dedent`
  Resolve the task in the repository and leave the working tree with the complete solution. Work unattended.
`;

/** 所有 arm 逐字节共享的规范 issue 输入。 */
export interface RolloutPromptInput {
  /** 固定数据集 revision 中规范的 `problem_statement`。 */
  problemStatement: string;
}

/** 原样返回数据集 issue，除了去除首尾空白。 */
export function buildRolloutPrompt(input: RolloutPromptInput): string {
  if (!input.problemStatement.trim()) {
    throw new Error("Problem statement is empty.");
  }
  return input.problemStatement.trim();
}
