import {
  type BoxRenderable,
  type KeyEvent,
  type TextareaRenderable,
  type TextRenderable,
  fg,
  t,
} from "@opentui/core";
import {
  type AutocompleteToken,
  activeFileAutocompleteToken,
  activeSkillAutocompleteToken,
  type FileAutocompleteItem,
  fileAutocompleteMatches,
  formatSkillAutocompleteDescription,
  moveSkillAutocompleteSelection,
  replaceFileAutocompleteToken,
  type SkillAutocompleteItem,
  skillAutocompleteMatches,
  type SlashAutocompleteGroup,
} from "./autocomplete.js";
import { buildFileIndex } from "./file-index.js";
import { COLORS } from "./theme.js";

export interface AutocompleteControllerOptions {
  /** 输入文本区，其 `plainText` + `cursorOffset` 驱动 token 检测，
   * 其 `setSelection` / `deleteSelection` / `insertText` 方法在原位完成补全，
   * 使附件占位符和光标模型保持一致。
   */
  inputField: TextareaRenderable;
  /** 斜杠命令与技能选择面板；由 render() 切换 `visible`。 */
  skillAutocompletePanel: BoxRenderable;
  /** 内置斜杠命令可选行的固定池。 */
  commandRows: TextRenderable[];
  /** 命令分区上方的标题行；没有命令行匹配查询时隐藏。 */
  commandHeader: TextRenderable;
  /** 匹配技能可选行的固定池。 */
  skillRows: TextRenderable[];
  /** 技能分区上方的标题行；没有技能行匹配查询时隐藏。 */
  skillHeader: TextRenderable;
  /** `@` 文件选择面板；结构与斜杠面板相同。 */
  fileAutocompletePanel: BoxRenderable;
  /** 匹配文件可选行的固定池。 */
  fileAutocompleteRows: TextRenderable[];
  /** 首次触发 `@` 时用于构建文件索引的工作目录。 */
  workDir: string;
  /** 用户在已打开的选择器中按 Escape 时调用。全局 escape 处理器在此处理器
   * 之后运行，否则会退出 TUI；调用方使用此钩子设置一次性抑制标记，
   * 让关闭选择器的 escape 到此为止。
   */
  onEscapeClose: () => void;
  /** 斜杠选择器打开的瞬间触发（token 从无到有）。用于重新发现已安装技能，
   * 让会话期间新增的技能也能显示；先显示缓存目录，回调再异步更新。
   */
  onSkillTokenOpened?: () => void;
}

/** 负责两个自动补全选择器（斜杠/技能与 `@`/文件）及其驱动按键。
 * 选择器共享刷新/渲染生命周期（每次内容和光标变化时检测 token、延迟加载文件索引、
 * 更新固定池行），因此由同一个控制器管理。生产环境通过
 * `inputField.setSelection / deleteSelection / insertText` 内联执行补全，
 * 使其能与附件占位符配合。
 */
export class AutocompleteController {
  private skills: readonly SkillAutocompleteItem[] = [];
  private skillToken: AutocompleteToken | undefined;
  private skillItems: SkillAutocompleteItem[] = [];
  private skillSelectedIndex = 0;

  // 文件索引在首次 @ 触发后延迟加载，之后不再重建。否则大型仓库会阻塞首次按键；
  // 为换取快速的首次绘制，索引少更新几个文件是可以接受的。
  private fileAllFiles: readonly FileAutocompleteItem[] = [];
  private fileIndexPromise: Promise<readonly FileAutocompleteItem[]> | undefined;
  private fileToken: AutocompleteToken | undefined;
  private fileItems: FileAutocompleteItem[] = [];
  private fileSelectedIndex = 0;

  constructor(private readonly opts: AutocompleteControllerOptions) {}

  /** 设置技能目录（内置斜杠命令 + 发现的技能）。
   * 幂等：调用方通常在会话设置完成后调用一次。
   */
  setSkillItems(skills: readonly SkillAutocompleteItem[]): void {
    this.skills = skills;
  }

  isSkillPickerOpen(): boolean {
    return Boolean(this.skillToken && this.skillItems.length > 0);
  }

  isFilePickerOpen(): boolean {
    return Boolean(this.fileToken && this.fileItems.length > 0);
  }

  /** 根据当前输入重新评估两个选择器。文本区每次内容变化和光标变化时调用。 */
  refresh(): void {
    this.refreshSkill();
    this.refreshFile();
  }

  /** 强制关闭两个选择器。供 `/` 命令提交路径和全局 escape 处理器使用。 */
  hideAll(): void {
    this.hideSkill();
    this.hideFile();
  }

  /** 在选择器打开时处理按键。若按键已被接管（且已调用 `key.preventDefault()`），
   * 返回 `true`，调用方应停止后续调度。两个选择器都未打开，
   * 或按键不属于此控制器处理范围时，返回 `false`。
   */
  handleKey(key: KeyEvent): boolean {
    if (this.isSkillPickerOpen()) {
      if (key.name === "up") {
        this.skillSelectedIndex = moveSkillAutocompleteSelection(
          this.skillSelectedIndex,
          this.skillItems.length,
          -1,
        );
        this.renderSkill();
        key.preventDefault();
        return true;
      }
      if (key.name === "down") {
        this.skillSelectedIndex = moveSkillAutocompleteSelection(
          this.skillSelectedIndex,
          this.skillItems.length,
          1,
        );
        this.renderSkill();
        key.preventDefault();
        return true;
      }
      if (key.name === "return" || key.name === "enter" || key.name === "tab") {
        key.preventDefault();
        this.completeSelectedSkill();
        return true;
      }
      if (key.name === "escape") {
        key.preventDefault();
        this.opts.onEscapeClose();
        this.hideSkill();
        return true;
      }
    }

    if (this.isFilePickerOpen()) {
      if (key.name === "up") {
        this.fileSelectedIndex = moveSkillAutocompleteSelection(
          this.fileSelectedIndex,
          this.fileItems.length,
          -1,
        );
        this.renderFile();
        key.preventDefault();
        return true;
      }
      if (key.name === "down") {
        this.fileSelectedIndex = moveSkillAutocompleteSelection(
          this.fileSelectedIndex,
          this.fileItems.length,
          1,
        );
        this.renderFile();
        key.preventDefault();
        return true;
      }
      if (key.name === "return" || key.name === "enter" || key.name === "tab") {
        key.preventDefault();
        this.completeSelectedFile();
        return true;
      }
      if (key.name === "escape") {
        key.preventDefault();
        this.opts.onEscapeClose();
        this.hideFile();
        return true;
      }
    }

    return false;
  }

  // ---- 内部实现 -----------------------------------------------------------

  private async ensureFileIndex(): Promise<readonly FileAutocompleteItem[]> {
    if (this.fileAllFiles.length > 0) return this.fileAllFiles;
    if (!this.fileIndexPromise) {
      this.fileIndexPromise = buildFileIndex(this.opts.workDir).catch(() => []);
    }
    this.fileAllFiles = await this.fileIndexPromise;
    return this.fileAllFiles;
  }

  private refreshSkill(): void {
    const { inputField } = this.opts;
    const token = activeSkillAutocompleteToken(inputField.plainText, inputField.cursorOffset);
    if (!token) {
      this.hideSkill();
      return;
    }

    const items = skillAutocompleteMatches(this.skills, token.query);
    if (items.length === 0) {
      this.hideSkill();
      return;
    }

    const previousToken = this.skillToken;
    this.skillToken = token;
    this.skillItems = items;
    const queryChanged =
      !previousToken ||
      previousToken.start !== token.start ||
      previousToken.end !== token.end ||
      previousToken.query !== token.query;
    if (queryChanged || this.skillSelectedIndex >= items.length) {
      this.skillSelectedIndex = 0;
    }
    this.renderSkill();
    // 在渲染缓存目录后触发，让选择器立即绘制；重新加载在后台进行，
    // 后续 setSkillItems()+refresh() 会原位更新已打开的选择器。
    if (!previousToken) {
      this.opts.onSkillTokenOpened?.();
    }
  }

  private refreshFile(): void {
    const { inputField } = this.opts;
    const token = activeFileAutocompleteToken(inputField.plainText, inputField.cursorOffset);
    if (!token) {
      this.hideFile();
      return;
    }

    // 捕获正在查找的 token ID，让缓慢的索引解析能够判断用户是否已输入到原始查询之外，
    // 并及时退出。
    const targetStart = token.start;
    const targetEnd = token.end;
    const targetQuery = token.query;
    void this.ensureFileIndex().then((files) => {
      const stillCurrent =
        this.fileToken !== undefined
          ? this.fileToken.start === targetStart &&
            this.fileToken.end === targetEnd &&
            this.fileToken.query === targetQuery
          : activeFileAutocompleteToken(inputField.plainText, inputField.cursorOffset)?.query ===
            targetQuery;
      if (!stillCurrent && this.fileToken === undefined) return;
      const items = fileAutocompleteMatches(files, targetQuery);
      if (items.length === 0) {
        this.hideFile();
        return;
      }
      const previousToken = this.fileToken;
      this.fileToken = { start: targetStart, end: targetEnd, query: targetQuery };
      this.fileItems = items;
      const queryChanged =
        !previousToken ||
        previousToken.start !== targetStart ||
        previousToken.end !== targetEnd ||
        previousToken.query !== targetQuery;
      if (queryChanged || this.fileSelectedIndex >= items.length) {
        this.fileSelectedIndex = 0;
      }
      this.renderFile();
    });
  }

  private renderSkill(): void {
    const { skillAutocompletePanel, commandRows, commandHeader, skillRows, skillHeader } =
      this.opts;
    skillAutocompletePanel.visible = this.skillItems.length > 0;

    // 按组将匹配项分配到两个分区行池。选择索引在扁平列表中导航，
    // 因此跟踪每项的扁平位置，以便无论位于哪个分区都能高亮正确的行。
    const groups: Record<SlashAutocompleteGroup, { rows: TextRenderable[]; cursor: number }> = {
      commands: { rows: commandRows, cursor: 0 },
      skills: { rows: skillRows, cursor: 0 },
    };
    for (const row of [...commandRows, ...skillRows]) {
      row.visible = false;
      row.content = "";
    }

    for (const [flatIndex, item] of this.skillItems.entries()) {
      const groupKey = item.group ?? "skills";
      const slot = groups[groupKey];
      const row = slot.rows[slot.cursor];
      if (!row) continue;
      slot.cursor += 1;
      const selected = flatIndex === this.skillSelectedIndex;
      const nameColor = selected ? COLORS.status : COLORS.user;
      const pathColor = selected ? COLORS.agent : COLORS.hint;
      const description = formatSkillAutocompleteDescription(item.description);
      const tail = description ? `\n${description}` : "";
      row.content = item.path
        ? t`${fg(nameColor)(`/${item.name}`)} ${fg(pathColor)(`(${item.path})`)}${tail}`
        : t`${fg(nameColor)(`/${item.name}`)}${tail}`;
      // 高度 = 名称行 + 每个换行后的描述行。否则框默认只有一行，会截断多行描述。
      row.height = description ? 1 + description.split("\n").length : 1;
      row.fg = selected ? COLORS.agent : COLORS.hint;
      row.visible = true;
    }

    commandHeader.visible = groups.commands.cursor > 0;
    skillHeader.visible = groups.skills.cursor > 0;
  }

  private renderFile(): void {
    const { fileAutocompletePanel, fileAutocompleteRows } = this.opts;
    fileAutocompletePanel.visible = this.fileItems.length > 0;
    for (const [index, row] of fileAutocompleteRows.entries()) {
      const item = this.fileItems[index];
      if (!item) {
        row.visible = false;
        row.content = "";
        continue;
      }
      const selected = index === this.fileSelectedIndex;
      const nameColor = selected ? COLORS.status : COLORS.user;
      const pathColor = selected ? COLORS.agent : COLORS.hint;
      // 并排显示 basename 和相对目录。目录部分是移除末尾 basename 后的路径；
      // 对于仓库根目录的文件，这会变成 "./"，让每一行的形态保持一致。
      const directory = item.relativePath.includes("/")
        ? item.relativePath.slice(0, item.relativePath.lastIndexOf("/") + 1)
        : "./";
      row.content = t`${fg(nameColor)(item.name)} ${fg(pathColor)(directory)}`;
      row.fg = selected ? COLORS.agent : COLORS.hint;
      row.visible = true;
    }
  }

  private hideSkill(): void {
    const { skillAutocompletePanel, commandRows, commandHeader, skillRows, skillHeader } =
      this.opts;
    this.skillToken = undefined;
    this.skillItems = [];
    this.skillSelectedIndex = 0;
    skillAutocompletePanel.visible = false;
    commandHeader.visible = false;
    skillHeader.visible = false;
    for (const row of [...commandRows, ...skillRows]) {
      row.visible = false;
      row.content = "";
    }
  }

  private hideFile(): void {
    const { fileAutocompletePanel, fileAutocompleteRows } = this.opts;
    this.fileToken = undefined;
    this.fileItems = [];
    this.fileSelectedIndex = 0;
    fileAutocompletePanel.visible = false;
    for (const row of fileAutocompleteRows) {
      row.visible = false;
      row.content = "";
    }
  }

  private completeSelectedSkill(): boolean {
    const { inputField } = this.opts;
    const token = this.skillToken;
    const item = this.skillItems[this.skillSelectedIndex];
    if (!token || !item) return false;

    const insertion = inputField.plainText[token.end]?.match(/\s/)
      ? `/${item.name}`
      : `/${item.name} `;
    inputField.setSelection(token.start, token.end);
    inputField.deleteSelection();
    inputField.insertText(insertion);
    this.hideSkill();
    return true;
  }

  private completeSelectedFile(): boolean {
    const { inputField } = this.opts;
    const token = this.fileToken;
    const item = this.fileItems[this.fileSelectedIndex];
    if (!token || !item) return false;

    // 插入 markdown 链接 `[@<basename>](./<relative-path>)`，让可见 token
    // 仍显示为 `@` 提及，而链接目标则是 Agent 可直接交给 `read` 工具的路径。
    // 格式契约位于 `replaceFileAutocompleteToken`；此调用点通过
    // setSelection/insertText 原位修改 inputField，以便与附件占位符及光标模型配合。
    const replacement = replaceFileAutocompleteToken(
      inputField.plainText,
      token,
      item.relativePath,
    );
    const insertion = replacement.text.slice(token.start, replacement.cursorOffset);
    inputField.setSelection(token.start, token.end);
    inputField.deleteSelection();
    inputField.insertText(insertion);
    this.hideFile();
    return true;
  }
}
