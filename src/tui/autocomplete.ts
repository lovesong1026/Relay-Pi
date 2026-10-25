import type { TurnQuestion } from "../types/protocol.js";

const SKILL_AUTOCOMPLETE_LIMIT = 8;
const SKILL_AUTOCOMPLETE_TOKEN = /^\/([A-Za-z0-9_.-]*)$/;
const SKILL_AUTOCOMPLETE_DESCRIPTION_WIDTH = 72;
const SKILL_AUTOCOMPLETE_DESCRIPTION_LINES = 2;

const FILE_AUTOCOMPLETE_LIMIT = 8;
const FILE_AUTOCOMPLETE_TOKEN = /^@([A-Za-z0-9_./-]*)$/;

const QUESTION_OPTION_LIMIT = 8;
const QUESTION_OPTION_DESCRIPTION_WIDTH = 72;

export const AUTOCOMPLETE_LIMITS = {
  skill: SKILL_AUTOCOMPLETE_LIMIT,
  file: FILE_AUTOCOMPLETE_LIMIT,
  questionOption: QUESTION_OPTION_LIMIT,
} as const;

/** 自动补全行所属的组。`commands` 是提交时拦截的 TUI 内置命令
 * （例如 `/image`、`/paste`、`/clear-images`）；`skills` 是运行器中的用户安装技能包。
 * 选择器将各组渲染在各自的标题下。
 */
export type SlashAutocompleteGroup = "commands" | "skills";

/** 斜杠选择器中的一行。`name` 显示为 `/<name>`，可选的 `path` 显示在旁边
 * （通常为技能的基础目录），描述在下方换行显示。`group` 控制该行所属的标题，
 * 默认为 `"skills"`。
 */
export interface SkillAutocompleteItem {
  name: string;
  description?: string;
  path?: string;
  group?: SlashAutocompleteGroup;
}

/** @ 文件选择器中的一行。`relativePath` 是实际插入的内容；basename 突出显示，
 * 目录部分显示在其旁边，让深层嵌套的文件仍便于浏览。
 */
export interface FileAutocompleteItem {
  /** 文件 basename，用作醒目的标签。 */
  name: string;
  /** 选择时插入输入框的仓库相对 POSIX 路径。 */
  relativePath: string;
}

/** 锚定于光标的 token，覆盖触发字符（`/` 或 `@`）及其后直到下一空白字符的所有内容。
 * 渲染器高亮该片段，并在选择时替换它。
 */
export interface AutocompleteToken {
  start: number;
  end: number;
  query: string;
}

export interface SkillAutocompleteReplacement {
  text: string;
  cursorOffset: number;
}

/** 定位包围光标的 `/skill` token。光标不在斜杠前缀标识符内时返回 undefined，
 * 调用方无需单独检查面板状态即可隐藏选择器。
 */
export function activeSkillAutocompleteToken(
  text: string,
  cursorOffset: number,
): AutocompleteToken | undefined {
  return activeTriggerToken(text, cursorOffset, "/", SKILL_AUTOCOMPLETE_TOKEN);
}

/** 结构与技能 token 相同，但锚定于文件提及的 `@<path>`。 */
export function activeFileAutocompleteToken(
  text: string,
  cursorOffset: number,
): AutocompleteToken | undefined {
  return activeTriggerToken(text, cursorOffset, "@", FILE_AUTOCOMPLETE_TOKEN);
}

function activeTriggerToken(
  text: string,
  cursorOffset: number,
  trigger: "/" | "@",
  pattern: RegExp,
): AutocompleteToken | undefined {
  const boundedOffset = Math.max(0, Math.min(cursorOffset, text.length));
  // 触发字符必须位于输入开头或前面有空白字符，
  // 否则 URL（https://…）和邮箱（a@b）也会打开选择器。
  const escapedTrigger = trigger === "/" ? "\\/" : "@";
  const tokenStart = text
    .slice(0, boundedOffset)
    .search(new RegExp(`(?:^|\\s)${escapedTrigger}[^\\s]*$`));
  if (tokenStart < 0) return undefined;

  const start = text[tokenStart] === trigger ? tokenStart : tokenStart + 1;
  const tokenEnd = text.slice(boundedOffset).search(/\s/);
  const end = tokenEnd < 0 ? text.length : boundedOffset + tokenEnd;
  const token = text.slice(start, end);
  if (!pattern.test(token)) return undefined;

  return { start, end, query: text.slice(start + 1, boundedOffset) };
}

/** 根据键入的查询筛选技能并排序。
 *
 * 前缀匹配让选择器行为可预测：键入 `/re` 时，`release` 应始终排在
 * 仅包含该子串的技能之前。
 */
export function skillAutocompleteMatches(
  skills: readonly SkillAutocompleteItem[],
  query: string,
  limit = SKILL_AUTOCOMPLETE_LIMIT,
): SkillAutocompleteItem[] {
  const normalizedQuery = query.toLocaleLowerCase();
  return [...skills]
    .filter((skill) => skill.name.toLocaleLowerCase().startsWith(normalizedQuery))
    .sort(compareSlashItems)
    .slice(0, limit);
}

/** 排序：commands 组在前（让内置命令始终显示在选择器顶部），skills 在后。
 * 组内按名称的字母顺序排列。
 */
function compareSlashItems(a: SkillAutocompleteItem, b: SkillAutocompleteItem): number {
  const groupDelta = groupOrder(a.group) - groupOrder(b.group);
  if (groupDelta !== 0) return groupDelta;
  return a.name.localeCompare(b.name);
}

function groupOrder(group: SlashAutocompleteGroup | undefined): number {
  return group === "commands" ? 0 : 1;
}

/** 为 `@` 选择器筛选文件。
 *
 * 文件排序优先考虑 basename 前缀匹配（用户输入文件名时最有用），
 * 其次为 basename 子串匹配，最后以完整路径子串匹配兜底嵌套文件。
 */
export function fileAutocompleteMatches(
  files: readonly FileAutocompleteItem[],
  query: string,
  limit = FILE_AUTOCOMPLETE_LIMIT,
): FileAutocompleteItem[] {
  const normalizedQuery = query.toLocaleLowerCase();
  if (!normalizedQuery) {
    return files.slice(0, limit);
  }
  const ranked = files
    .map((file) => ({ file, score: scoreFileMatch(file, normalizedQuery) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score;
      return a.file.relativePath.localeCompare(b.file.relativePath);
    });
  return ranked.slice(0, limit).map((entry) => entry.file);
}

function scoreFileMatch(file: FileAutocompleteItem, normalizedQuery: string): number {
  const name = file.name.toLocaleLowerCase();
  const relativePath = file.relativePath.toLocaleLowerCase();
  if (name.startsWith(normalizedQuery)) return 3;
  if (name.includes(normalizedQuery)) return 2;
  if (relativePath.includes(normalizedQuery)) return 1;
  return 0;
}

export function formatSkillAutocompleteDescription(description: string | undefined): string {
  if (!description) return "";

  const wrapped = wrapText(description, SKILL_AUTOCOMPLETE_DESCRIPTION_WIDTH);
  const visible = wrapped.slice(0, SKILL_AUTOCOMPLETE_DESCRIPTION_LINES);
  if (wrapped.length > visible.length) {
    const lastIndex = visible.length - 1;
    visible[lastIndex] = `${visible[lastIndex]!.replace(/\s+$/, "")}...`;
  }
  return visible.join("\n");
}

function wrapText(text: string, width: number): string[] {
  const words = text.trim().split(/\s+/);
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    if (!current) {
      current = word;
      continue;
    }
    if (current.length + 1 + word.length <= width) {
      current = `${current} ${word}`;
      continue;
    }
    lines.push(current);
    current = word;
  }

  if (current) lines.push(current);
  return lines;
}

/** 循环移动高亮的技能行，在两端回绕。 */
export function moveSkillAutocompleteSelection(
  selectedIndex: number,
  itemCount: number,
  direction: -1 | 1,
): number {
  if (itemCount <= 0) return 0;
  return (selectedIndex + direction + itemCount) % itemCount;
}

/** 根据选择器状态，为单个问题构建答案数组。
 *
 * 对于单选问题（`multiSelect` 为假值），将高亮选项解析为单元素数组。
 * 对于多选问题，按原始选项顺序输出所有选中索引的标签，让序列化 XML
 * 保留问题的选项顺序，而不是用户切换选项的顺序。
 *
 * 选择器没有待回答问题时返回 `undefined`，调用方据此提前终止提交。
 * 多选题中用户未选任何项就继续时，空数组也是有效结果。
 */
export function questionPickerAnswer(
  question: TurnQuestion | undefined,
  selectedIndex: number,
  checkedIndices: ReadonlySet<number>,
): string[] | undefined {
  if (!question) return undefined;
  if (question.multiSelect) {
    const checked: string[] = [];
    for (const [index, option] of question.options.entries()) {
      if (checkedIndices.has(index)) checked.push(option.label);
    }
    return checked;
  }
  const selectedOption = question.options[selectedIndex];
  if (!selectedOption) return undefined;
  return [selectedOption.label];
}

/** 将当前问题的当前选择合并到累计答案映射中。单选题在 Up/Down 时实时记录，
 * 使高亮等于选择；多选题在每次 Space/Enter 切换时实时记录。
 * 箭头导航也会调用此函数，以便在移动前保存离开的问题的答案。
 *
 * 没有活动问题、单选题没有高亮（`selectedIndex === NO_HIGHLIGHT`，
 * 即用户尚未在此问题上按 Up/Down），或高亮指向问题选项数组之外的行
 * （例如多选题中合成的 Done 行）时，原样返回输入映射。
 */
export function commitActiveAnswer(
  question: TurnQuestion | undefined,
  selectedIndex: number,
  checkedIndices: ReadonlySet<number>,
  accumulated: Record<string, string[]>,
): Record<string, string[]> {
  if (!question) return accumulated;
  const answer = questionPickerAnswer(question, selectedIndex, checkedIndices);
  if (answer === undefined) return accumulated;
  return { ...accumulated, [question.question]: answer };
}

/** 表示“尚无高亮行”的哨兵值。选择器初始状态和刚进入的问题都从此值开始；
 * 首次 Up/Down 会落到具体行上，并在单选题中实时记录该高亮。
 */
export const NO_HIGHLIGHT = -1;

/** 根据指定问题之前保存的答案重建选择器选择状态。用于用户通过 Left 箭头返回时，
 * 恢复先前的切换项/高亮，而非显示空白状态；也用于前进到尚未访问的问题
 * （默认为 `NO_HIGHLIGHT`，用户必须明确按 Up/Down 才能确定单选答案）。
 */
export function restoreSavedAnswer(
  question: TurnQuestion | undefined,
  accumulated: Record<string, string[]>,
): { selectedIndex: number; checked: Set<number> } {
  if (!question) return { selectedIndex: NO_HIGHLIGHT, checked: new Set<number>() };
  const saved = accumulated[question.question];
  if (question.multiSelect) {
    const checked = new Set<number>();
    if (saved) {
      for (const [index, option] of question.options.entries()) {
        if (saved.includes(option.label)) checked.add(index);
      }
    }
    return { selectedIndex: NO_HIGHLIGHT, checked };
  }
  if (!saved || saved.length === 0) {
    return { selectedIndex: NO_HIGHLIGHT, checked: new Set<number>() };
  }
  const matchIndex = question.options.findIndex((option) => option.label === saved[0]);
  return {
    selectedIndex: matchIndex >= 0 ? matchIndex : NO_HIGHLIGHT,
    checked: new Set<number>(),
  };
}

/** 将选择器高亮移动一步，在两端回绕，并按方向将 `NO_HIGHLIGHT` 哨兵值
 * 移到首行或末行。`itemCount` 包含多选题中合成的 Done 行。
 */
export function moveQuestionHighlight(
  selectedIndex: number,
  itemCount: number,
  direction: -1 | 1,
): number {
  if (itemCount <= 0) return NO_HIGHLIGHT;
  if (selectedIndex === NO_HIGHLIGHT) return direction === 1 ? 0 : itemCount - 1;
  return (selectedIndex + direction + itemCount) % itemCount;
}

export function formatQuestionOptionDescription(description: string | undefined): string {
  if (!description) return "";

  return wrapText(description, QUESTION_OPTION_DESCRIPTION_WIDTH).join("\n");
}

/** 将光标下的 @ token 替换为 `[@<basename>](<repo-relative-path>)` 形式的
 * markdown 链接。可见标签保留 `@` 前缀，仍显示为提及；链接目标是模型可交给
 * `read` 工具的路径。仅当下一字符不是空白时插入尾随空格，让连续提及保持整洁。
 */
export function replaceFileAutocompleteToken(
  text: string,
  token: AutocompleteToken,
  relativePath: string,
): SkillAutocompleteReplacement {
  const slash = relativePath.lastIndexOf("/");
  const basename = slash === -1 ? relativePath : relativePath.slice(slash + 1);
  // 为目标加上 `./` 前缀，明确表示仓库相对路径，而不是 URL、包名或绝对路径。
  return replaceTriggerToken(text, token, `[@${basename}](./${relativePath})`);
}

function replaceTriggerToken(
  text: string,
  token: AutocompleteToken,
  insertionWithoutTrailing: string,
): SkillAutocompleteReplacement {
  const insertion = text[token.end]?.match(/\s/)
    ? insertionWithoutTrailing
    : `${insertionWithoutTrailing} `;
  const nextText = `${text.slice(0, token.start)}${insertion}${text.slice(token.end)}`;
  return { text: nextText, cursorOffset: token.start + insertion.length };
}

// ---- 旧版别名 --------------------------------------------------------
// 保留这些别名，让导入旧版仅技能名称的现有调用方（和测试）继续工作，
// 避免重命名波及多处。

/** @deprecated 使用 {@link AutocompleteToken}。 */
export type SkillAutocompleteToken = AutocompleteToken;
