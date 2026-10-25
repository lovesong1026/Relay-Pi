// 交互式 TUI 的轻量编排器。`runTui` 将界面框架（渲染器、布局、控制器）
// 连接到实时 `Session`，并返回用户退出时生效的终止事件。
// 复杂行为由 `src/tui/` 下的叶模块负责；本文件只包含构建顺序
// 以及 `submit` / `handleSteer` 协调逻辑。
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type CliRenderer, type PasteEvent, type Selection } from "@opentui/core";
import { renderBootScreen } from "./boot-screen.js";
import { createTuiControllers } from "./controllers.js";
import { createDinoPanel } from "./dino/index.js";
import { replayResumeHistory } from "./history-replay.js";
import { bootstrapInitialPrompt } from "./initial-prompt.js";
import {
  type CtrlCSuppressionFlag,
  type EscapeSuppressionFlag,
  installKeyHandlers,
} from "./key-handlers.js";
import { buildLayout } from "./layout.js";
import { acquireRenderer, waitForRendererDestroy } from "./renderer-lifecycle.js";
import { bindSessionToUi, type FollowUpPopSuppression } from "./session-subscription.js";
import { TaskLaneRenderer } from "./task-lane-renderer.js";
import { StarterSection } from "./starter-section.js";
import { StatusController } from "./status-controller.js";
import { StepRenderer } from "./step-renderer.js";
import { applyInlineSlashCommands, tryDispatchSlashCommand } from "./slash-commands.js";
import { COLORS } from "./theme.js";
import { TranscriptWriter } from "./transcript-writer.js";
import type { TranscriptEntry } from "./transcript-log.js";
import type { Session } from "../session/session.js";
import type { UpgradeStatusStream } from "../cli/auto-upgrade.js";
import type { TurnTerminalEvent } from "../types/protocol.js";

export type { HistoryBlockKind, HistoryDisplayBlock, LimitedHistory } from "./history.js";
export type { StartupHeaderInput } from "./history.js";
export type {
  AutocompleteToken,
  AutocompleteToken as SkillAutocompleteToken,
  FileAutocompleteItem,
  SkillAutocompleteItem,
  SkillAutocompleteReplacement,
} from "./autocomplete.js";
// 保留历史上的 `tui/app.js` 再导出，供测试和外部调用方使用。
export {
  activeFileAutocompleteToken,
  activeSkillAutocompleteToken,
  commitActiveAnswer,
  fileAutocompleteMatches,
  formatQuestionOptionDescription,
  formatSkillAutocompleteDescription,
  moveQuestionHighlight,
  moveSkillAutocompleteSelection,
  NO_HIGHLIGHT,
  questionPickerAnswer,
  replaceFileAutocompleteToken,
  restoreSavedAnswer,
  skillAutocompleteMatches,
} from "./autocomplete.js";
export {
  RELAY_PI_BANNER_LINES,
  historyDisplayBlocks,
  limitHistoryDisplayMessages,
  startupHeaderLines,
} from "./history.js";

export interface RunTuiInput {
  session: Session;
  initialPrompt?: string;
  /** 启动标题中显示的当前工作目录。 */
  workDir: string;
  /** 启动标题和恢复上下文中显示的会话 ID。 */
  sessionId: string;
  /** npm 包名，用于标记自动升级状态行。 */
  packageName: string;
  /** 启动标题中显示的已安装包版本。 */
  packageVersion: string;
  /** 此 CLI 会话中面向用户显示的模型名称。 */
  modelName: string;
  /** modelName 的来源（例如 "inferred from OPENROUTER_API_KEY in .env"）。 */
  modelSource?: string;
  /** 用于观察式记忆工作的、面向用户显示的模型名称。 */
  memoryModelName: string;
  /** memoryModelName 的来源。 */
  memoryModelSource?: string;
  /** 进程内自动升级流程的实时状态流。TUI 通过一条持续更新的介绍行依次显示
   * "Checking…"、"Updating…"、"Updated. Restart relay-pi to use it."。
   * 未定义的状态（current、locked、skipped）会完全隐藏该行。
   */
  upgradeStatus$?: UpgradeStatusStream;
  /** 恢复会话时要重放到对话记录中的历史消息。 */
  history?: AgentMessage[];
  /** 本次 TUI 挂载来自 `--resume <id>` 调用时为 true。
   * 隐藏启动引导菜单，让用户直接回到之前的对话，而不再看到引导提示词。
   */
  isResume?: boolean;
  /** 用户选择 "pick up the thread" 最近会话行时调用。外层调度器应释放当前会话，
   * 执行 `manager.resume(sessionId)` + `hydrate()` + `start()`，再以恢复后的会话
   * 及其重放历史重新进入 `runTui`。未提供时（测试、playground），选择器行会
   * 退回为在当前会话中将之前的提示词作为新回合重新提交。
   */
  onResumeRequest?: (sessionId: string) => void;
  /** 用户提交 `/clear` 时调用。外层调度器应释放当前会话，执行 `manager.create({})`，
   * 再以新会话和空重放历史重新进入 `runTui`。TUI 调用后会立即销毁自己的渲染器，
   * 使调度器的 `runTui` promise 完成，让循环能够重建。
   */
  onClearRequest?: () => void;
  /** 从历史中重放的末尾用户回合交互数。每次交互包括用户提示词及其后的助手内容块。
   * `0` 禁用重放；未设置时重放所有内容块。
   */
  resumeHistoryMessages?: number;
  /** 供测试使用的预构建渲染器。提供后，`runTui` 会跳过 `createCliRenderer`
   * 及其外围的 `globalThis.window` 兼容处理。`test/helpers/tui-harness.ts` 中的
   * 测试框架传入 `createTestRenderer` 实例，让模拟按键无需真实 TTY 即可驱动选择器。
   */
  renderer?: CliRenderer;
}

/** 为会话运行交互式 TUI，并以用户退出时生效的终止事件完成。 */
export async function runTui(input: RunTuiInput): Promise<TurnTerminalEvent | undefined> {
  const renderer = await acquireRenderer(input.renderer);
  const ui = buildLayout(renderer);

  // 从渲染器的 `selection` 事件缓存拖选文本，让 /copy 和复制快捷键优先使用
  // 用户高亮的内容，而非最后一条消息的启发式选择；底部提示也只在存在选区时
  // 显示该快捷键。
  let lastSelectionText = "";

  const transcriptWriter = new TranscriptWriter(renderer, ui.transcript, {
    getLastSelectionText: () => lastSelectionText,
    onBufferDestroyed: () => {
      statusController.shutdown();
      clearInterval(bannerWatcher);
    },
  });

  // 记录并渲染归属于用户的对话记录块。集中处理，以便所有显示 `you:` 块的路径
  // 都刷新横幅锚点和正文。返回渲染后的行，供调用方将后续行
  // （例如附件摘要）与用户块归为一组。
  function appendUserBlock(message: string) {
    transcriptWriter.recordEntry("user", message);
    const lines = transcriptWriter.appendBlock("you:", message, COLORS.user);
    transcriptWriter.setLatestUserBlock(lines);
    ui.latestUserBannerText.content = clampBannerBody(message);
    refreshLatestUserBannerVisibility();
    return lines;
  }

  const appendLine = (content: string, fg: string) => transcriptWriter.appendLine(content, fg);
  const appendBlock = (label: string | null, body: string, fg: string) =>
    transcriptWriter.appendBlock(label, body, fg);
  const recordTranscriptEntry = (kind: TranscriptEntry["kind"], text: string) =>
    transcriptWriter.recordEntry(kind, text);

  // 仅在最新的 `you:` 块已滚出对话记录视口顶部时显示固定横幅
  // （即用户向下滚动，越过了自己的最后一条消息）。该块仍在屏幕内，
  // 或位于视口下方（用户向上滚动查看更早历史）时，横幅保持隐藏。
  // OpenTUI 的 `Renderable#y` getter 会沿父链遍历，并已计入
  // `content.translateY = -scrollTop`，所以子节点的 `screenY` 与
  // `viewport.screenY` 位于同一根节点累计坐标系；与内容坐标系中的
  // `scrollTop` 比较会混用坐标系。
  function refreshLatestUserBannerVisibility(): void {
    const lines = transcriptWriter.getLatestUserBlock();
    if (lines.length === 0) {
      ui.latestUserBanner.visible = false;
      return;
    }
    const last = lines[lines.length - 1]!;
    const viewTop = ui.transcript.viewport.screenY;
    const scrolledAboveViewport = last.screenY + last.height <= viewTop;
    ui.latestUserBanner.visible = scrolledAboveViewport;
  }

  // Yoga 异步布局子节点，ScrollBoxRenderable 又不会发出滚动事件，
  // 因此以短间隔轮询，让横幅同时跟上新增内容（会移动贴底视图）和手动滚动。
  // 100 ms 足以保持响应灵敏，开销也远低于逐帧处理；可见性检查只需读取几个属性。
  const bannerWatcher = setInterval(refreshLatestUserBannerVisibility, 100);

  let refreshActiveTools: () => void = () => undefined;
  let refreshTaskLane: () => void = () => undefined;
  const statusController = new StatusController({
    renderer,
    status: ui.status,
    hint: ui.hint,
    refreshActiveWork: () => {
      refreshActiveTools();
      refreshTaskLane();
    },
  });

  const stepRenderer = new StepRenderer({
    renderer,
    transcriptWriter,
    statusController,
    onStepStart: () => {
      if (questionPicker.isOpen()) questionPicker.hide();
    },
  });
  const taskLaneRenderer = new TaskLaneRenderer({ renderer, transcriptWriter, statusController });
  refreshActiveTools = () => stepRenderer.refreshActiveToolBlocks();
  refreshTaskLane = () => taskLaneRenderer.refresh();

  // 恐龙面板是位于输入框下方、按需开启的小游戏。Ctrl-G 可随时切换；
  // Agent 的忙碌/空闲转换驱动冻结与恢复，在需要用户时立即自动暂停世界，
  // 工作恢复时执行 3-2-1 倒计时。
  const dinoPanel = createDinoPanel({ renderer });
  ui.dinoPanel.add(dinoPanel.view);
  const unsubscribeDino = statusController.onRunningChange((running) => {
    if (running) dinoPanel.resume();
    else dinoPanel.freeze();
  });

  const reportError = (error: unknown): void => {
    appendBlock("[error]", error instanceof Error ? error.message : String(error), COLORS.error);
  };

  const escapeState: EscapeSuppressionFlag = { suppress: false };
  const ctrlCState: CtrlCSuppressionFlag = { suppress: false };
  const popSuppression: FollowUpPopSuppression = { pending: [] };
  const setEscapeSuppress = () => {
    escapeState.suppress = true;
  };

  // 启动引导提示词；--resume 时跳过，因此调用处需要检查 null。
  const starters = input.isResume
    ? undefined
    : new StarterSection({
        workDir: input.workDir,
        sessionId: input.sessionId,
        history: input.history,
        inputField: ui.inputField,
        transcript: ui.transcript,
        transcriptWriter,
        renderer,
        submit: (text) => submit(text),
        onResumeRequest: input.onResumeRequest,
      });

  const { autocomplete, questionPicker, pasteController, copyController } = createTuiControllers({
    renderer,
    ui,
    session: input.session,
    sessionId: input.sessionId,
    workDir: input.workDir,
    transcriptWriter,
    statusController,
    appendBlock,
    appendUserBlock,
    recordTranscriptEntry,
    reportError,
    onPickerEscapeClose: setEscapeSuppress,
    getLastSelectionText: () => lastSelectionText,
    clearLastSelectionText: () => {
      lastSelectionText = "";
    },
  });

  renderer.on("selection", (selection: Selection) => {
    lastSelectionText = selection.getSelectedText();
    transcriptWriter.logSelection(lastSelectionText);
    statusController.setSelectionText(lastSelectionText);
  });

  const unsubscribe = bindSessionToUi({
    session: input.session,
    sidebar: ui.sidebar,
    followUpPanel: ui.followUpPanel,
    followUpPanelBody: ui.followUpPanelBody,
    stepRenderer,
    taskLaneRenderer,
    statusController,
    questionPicker,
    appendLine,
    appendBlock,
    appendUserBlock,
    popSuppression,
  });

  // Esc 取消进行中的回合；空闲时 Esc 不做任何操作。
  function handleEscape(): void {
    if (!statusController.isRunning()) return;
    void input.session.interrupt().catch(reportError);
  }

  // Ctrl+C 使用一个小状态机，而非立即退出：
  //   0. 回合运行中 + 输入框为空 + 有排队的后续消息 → 将最新排队项弹回输入框
  //                      （每次按键弹出一项），让回合继续运行。
  //   1. 回合运行中 → 中断回合（与 Esc 相同），不显示退出提示。
  //   2. 输入框有文本 → 只清空输入框（包括多行文本）；
  //                       附件、自动补全和选择器状态保持不变。
  //   3. 空闲 + 输入框为空 → 首次按键启用持续显示的退出确认，
  //                          再次按键（或 Enter）退出。
  // 退出本身复用 `renderer.destroy()`，与原 OpenTUI exitOnCtrlC 处理器
  // 使用的销毁方式相同，因此关闭语义不变。
  function handleCtrlC(): void {
    if (
      statusController.isRunning() &&
      ui.inputField.plainText.length === 0 &&
      pasteController.attachments().length === 0
    ) {
      const queue = input.session.getState()?.followUpQueue ?? [];
      const popped = queue.at(-1);
      if (popped) {
        popSuppression.pending.push(popped);
        input.session.editFollowUpQueue({ prompts: queue.slice(0, -1) });
        pasteController.stageImages(popped.images ?? []);
        ui.inputField.insertText(popped.message);
        return;
      }
    }
    if (statusController.isRunning()) {
      handleEscape();
      return;
    }
    if (ui.inputField.plainText.length > 0) {
      ui.inputField.clear();
      return;
    }
    if (statusController.isExitConfirmActive()) {
      renderer.destroy();
      return;
    }
    statusController.showExitConfirm();
  }

  // submit（follow_up）和 Ctrl+Enter（steer）的共享调度：记录用户消息与附件，
  // 将提示词交给会话，并将界面框架切换为 "running"。
  async function dispatchTurn(message: string, behavior: "follow_up" | "steer"): Promise<void> {
    // 自动附加用户键入或拖入编辑缓冲区的图像路径。主要场景是 macOS 上从截图缩略图
    // 拖入：终端会合成按键，而非触发粘贴事件，且 `NSIRD_screencaptureui_*` 下的
    // 临时文件会在缩略图关闭后几秒内消失。提交时扫描可在竞态导致失败前捕获字节。
    await pasteController.autoAttachFromMessage(message).catch(reportError);
    const pending = pasteController.consume();
    // 对于即将排在进行中回合之后的后续消息，不显示对话记录中的 `you:` 块：
    // 运行器会将其保留在 `state.followUpQueue` 中，直到当前工作结束，
    // 而编辑行上方的后续消息面板已经展示了它们。运行器取出该项并交给 Agent 时，
    // 会话订阅才发出延迟的 `you:` 块。Steer 消息完全绕过队列，因此始终在此渲染。
    const queued = behavior === "follow_up" && statusController.isRunning();
    if (!queued) {
      appendUserBlock(message);
      if (pending.length > 0) {
        const lines = pending.map((p) => `📎 ${p.label}: ${p.path}`).join("\n");
        appendBlock(null, lines, COLORS.hint);
      }
    }
    const images = pending.map((p) => p.attachment);
    // 将键入消息视为一次刷新，以免丢失已收集的部分答案。
    if (behavior === "follow_up" && questionPicker.isOpen()) {
      questionPicker.flushWithMessage(message, images);
      return;
    }
    void input.session.prompt({ message, behavior, images }).catch(reportError);
    if (!statusController.isRunning()) statusController.markRunning();
  }

  // Ctrl+Enter 使用 behavior:"steer"，让运行器在下一个推理边界调用
  // agent.steer()，而不是排在整个回合之后。
  function handleSteer(): void {
    const message = ui.inputField.plainText.trim();
    if (message.length === 0) return;
    ui.inputField.clear();
    void dispatchTurn(message, "steer").catch(reportError);
  }

  // 普通 Enter：斜杠式本地命令 → 共享调度（处理问题选择器刷新 → follow_up 回合）。
  // 首次由用户发起提交时销毁启动引导界面。
  function submit(message: string): void {
    if (starters && !starters.isPermanentlyDismissed()) {
      starters.destroyPermanently();
    }
    const slashCtx = {
      pasteController,
      copyController,
      transcriptWriter,
      appendBlock,
      onClear: () => {
        input.onClearRequest?.();
        renderer.destroy();
      },
      setModel: (model: string) => input.session.setModel(model),
      setThinkingLevel: (level: string) => input.session.setThinkingLevel(level),
      routeStatus: () => input.session.routeStatus(),
      compact: () => {
        void input.session.compact();
      },
    };
    if (tryDispatchSlashCommand(message, slashCtx)) {
      return;
    }
    // 整条消息调度未命中；退回到内联应用，让命令可在较长提示词的任意位置生效
    // （`hey can you review this /model gpt-5.5`）。每个匹配的斜杠形式都会触发
    // 对应处理器，并从消息中移除；剩余的 `residue` 才是 Agent 看到的内容。
    // 若剩余内容为空（整条提示词都是斜杠命令），则完全跳过回合，
    // 与上面的 `tryDispatchSlashCommand` 提前返回行为一致。
    const { residue } = applyInlineSlashCommands(message, slashCtx);
    if (residue.length === 0) return;
    void dispatchTurn(residue, "follow_up").catch(reportError);
  }

  installKeyHandlers({
    renderer,
    inputField: ui.inputField,
    transcript: ui.transcript,
    autocomplete,
    questionPicker,
    pasteController,
    copyController,
    starters,
    transcriptWriter,
    escapeState,
    onSubmit: submit,
    onEscape: handleEscape,
    onSteer: handleSteer,
    dinoPanel,
    ctrlCState,
    onCtrlC: handleCtrlC,
    isExitConfirmActive: () => statusController.isExitConfirmActive(),
    onExitConfirmAccept: () => renderer.destroy(),
    onExitConfirmCancel: () => statusController.clearExitConfirm(),
  });

  // 键入时隐藏引导界面；在用户提交前，退格至空会再次显示。
  ui.inputField.onContentChange = () => {
    starters?.syncVisibility();
    autocomplete.refresh();
  };
  ui.inputField.onCursorChange = () => autocomplete.refresh();

  // 二进制剪贴板粘贴：转发图像字节的终端（kitty、ghostty、新版 iTerm2）进入此处；
  // 文本粘贴则继续走 Textarea 的默认插入路径。
  ui.inputField.onPaste = (event: PasteEvent) => {
    void pasteController.handlePasteEvent(event).catch((error) => {
      appendBlock("[paste]", error instanceof Error ? error.message : String(error), COLORS.error);
    });
  };

  await renderBootScreen({
    renderer,
    transcript: ui.transcript,
    appendLine,
    session: input.session,
    sidebar: ui.sidebar,
    autocomplete,
    starters,
    packageName: input.packageName,
    packageVersion: input.packageVersion,
    workDir: input.workDir,
    modelName: input.modelName,
    memoryModelName: input.memoryModelName,
    upgradeStatus$: input.upgradeStatus$,
  });

  replayResumeHistory(
    {
      appendLine,
      appendBlock,
      recordTranscriptEntry,
      setLatestUserBlock: (lines) => transcriptWriter.setLatestUserBlock(lines),
    },
    { history: input.history, resumeHistoryMessages: input.resumeHistoryMessages },
  );

  bootstrapInitialPrompt({
    session: input.session,
    initialPrompt: input.initialPrompt,
    statusController,
    stepRenderer,
    appendUserBlock,
    reportError,
  });

  await waitForRendererDestroy(renderer, () => {
    // Ctrl+C 会同步销毁文本缓冲区。在完成前先销毁计时器，并停止接受界面写入，
    // 避免进行中的会话事件落到已销毁的 TextBuffer 上。
    transcriptWriter.markDestroyed();
    statusController.shutdown();
    unsubscribeDino();
    dinoPanel.destroy();
  });

  clearInterval(bannerWatcher);
  unsubscribe();
  return statusController.lastTerminal();
}

/** 限制固定的“最新用户消息”横幅正文，避免长粘贴内容占满屏幕。
 * 最多保留 {@link BANNER_MAX_LINES} 个原始行，截去更多内容时追加省略号；
 * 横幅本身会软换行，所以实际显示高度仍可能超过原始行数。
 */
const BANNER_MAX_LINES = 3;
function clampBannerBody(text: string): string {
  const lines = text.split("\n");
  if (lines.length <= BANNER_MAX_LINES) return text;
  return `${lines.slice(0, BANNER_MAX_LINES).join("\n")}…`;
}
