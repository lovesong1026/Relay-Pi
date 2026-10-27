import {
  pinnedDefaultModel,
  pinnedMemoryModel,
  PROVIDER_SHORTHANDS,
  resolveProviderShorthand,
} from "../model-resolution/catalog.js";
import {
  describeModelResolution,
  resolveCliMemoryModel,
  resolveCliModel,
  routingCatalogAdapter,
  type ModelResolution,
} from "../model-resolution/resolver.js";
import { loadRoutingTable } from "../model-routing/loader.js";
import { BUILT_IN_ROUTING_TABLE, type RoutingTable } from "../model-routing/table.js";
import { DEFAULT_MEMORY_DB_PATH, SessionManager } from "../session/session-manager.js";
import { runTui } from "../tui/app.js";
import { applyInlineSlashCommandsToCliConfig } from "./inline-slash.js";
import type { TurnRunnerConfig } from "../types/config.js";
import { DEFAULT_RESUME_HISTORY_MESSAGES, printRunHelp } from "./help.js";
import { resumeCommand } from "./resume-hint.js";
import {
  expandHomeDir,
  fail,
  isInteractive,
  loadCliEnvFiles,
  parseResumeHistoryMessages,
} from "./shared.js";
import { installShutdownHandlers } from "./shutdown.js";
import {
  createUpgradeStatusStream,
  describeUpgradeStatus,
  runAutoUpgrade,
} from "./auto-upgrade.js";

export interface CliTurnConfigInput {
  /** 恢复时保留已持久化的选择，除非显式传入模型参数覆盖它们。 */
  resume?: boolean;
  modelName?: string;
  memoryModelName?: string;
  /** 同时禁用观察式数据库记忆和精选文件记忆的加载。 */
  incognito?: boolean;
  /**
   * 显式指定记忆数据库文件路径。省略时，配置回退到
   * {@link DEFAULT_MEMORY_DB_PATH}（`~/.relay-pi/memory.db`）。`incognito` 为 true 时忽略此字段，
   * 并强制设置 `memoryDbPath: false`。
   */
  dbPath?: string;
  /**
   * 由调用方持有的 Session ID，用于归属记忆写入。TUI 路径从活动的 `SessionManager` Session 设置它；
   * `relay-pi --rpc` 则从 `--session <id>` 启动参数设置它。进程写入的每条 observation 都会携带此 ID
   * 作为 `session_id`，这是 Session 范围 recall 筛选所依据的轴。
   */
  sessionId?: string;
  workDir: string;
  systemInstructions?: string;
  systemPromptFiles?: string[];
}

export interface CliTurnConfigResolution {
  config: TurnRunnerConfig;
  modelResolution: ModelResolution;
  memoryModelResolution: ModelResolution;
}

export interface ProjectCliTurnConfigResolution extends CliTurnConfigResolution {
  /** 用于默认值和启动时虚拟名称检查的、经过完整校验的替换配置。 */
  routingTable: RoutingTable;
}

export interface PackageMetadata {
  name: string;
  version: string;
}

/**
 * 决定显示交互式 TUI，还是使用一次性的流式路径。只有终端可交互且调用方未提供 prompt 参数时
 * 才运行 TUI；否则通过 SessionManager 执行一次 turn，并在其结束后退出。
 */
export function shouldUseTui(input: { interactive: boolean; prompt?: string }): boolean {
  return input.interactive && !input.prompt;
}

/**
 * 构建 CLI 传给 SessionManager 的 {@link TurnRunnerConfig}，同时返回用于显示模型来源的解析结果。
 */
export function buildCliTurnConfig(
  input: CliTurnConfigInput,
  dotenvKeys: Set<string>,
  routingTable: RoutingTable = BUILT_IN_ROUTING_TABLE,
): CliTurnConfigResolution {
  const modelResolution = resolveCliModel(input.modelName, dotenvKeys, routingTable);
  const memoryModelResolution = resolveCliMemoryModel(input.memoryModelName, dotenvKeys);

  return {
    config: {
      ...(!input.resume || input.modelName ? { model: modelResolution.modelName } : {}),
      ...(!input.resume || input.memoryModelName
        ? { memoryModel: memoryModelResolution.modelName }
        : {}),
      memoryDbPath: input.incognito ? false : (input.dbPath ?? DEFAULT_MEMORY_DB_PATH),
      ...(input.incognito ? { memoryStores: false } : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      cwd: input.workDir,
      ...(input.systemInstructions ? { systemInstructions: input.systemInstructions } : {}),
      ...(input.systemPromptFiles ? { systemPromptFiles: input.systemPromptFiles } : {}),
    },
    modelResolution,
    memoryModelResolution,
  };
}

/** 只加载一次项目路由表，然后据此解析完整的启动配置。 */
export async function buildProjectCliTurnConfig(
  input: CliTurnConfigInput,
  dotenvKeys: Set<string>,
): Promise<ProjectCliTurnConfigResolution> {
  const loaded = await loadRoutingTable({
    cwd: input.workDir,
    catalogAdapter: routingCatalogAdapter,
  });
  return {
    ...buildCliTurnConfig(input, dotenvKeys, loaded.table),
    routingTable: loaded.table,
  };
}

/**
 * 默认的 `relay-pi` 调用：解析参数、加载环境文件、构建配置、决定使用 TUI 还是 JSON 输出，
 * 然后通过一个 Session 驱动 SessionManager。无论 Session 是否正常结束，最后都会打印恢复提示。
 */
export async function runRunCommand(args: string[], pkg: PackageMetadata): Promise<void> {
  let modelName: string | undefined;
  let memoryModelName: string | undefined;
  // 保存 --provider 的原始值，以便在下方固定默认模型，并在同时传入 --model 时给出更清晰的错误。
  let providerFlag: string | undefined;
  let workDir = process.cwd();
  let resumeSessionId: string | undefined;
  let systemInstructions: string | undefined;
  let systemPromptFiles: string[] | undefined;
  let resumeHistoryMessages = DEFAULT_RESUME_HISTORY_MESSAGES;
  let resumeHistoryMessagesExplicit = false;
  let envFilePath: string | undefined;
  let dbPath: string | undefined;
  let incognito = false;
  let noAutoUpgrade = false;
  const promptParts: string[] = [];
  const interactive = isInteractive();

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--model":
      case "-m":
        if (!args[i + 1] || args[i + 1]?.startsWith("-")) fail(`Missing value for ${args[i]}`);
        modelName = args[++i];
        break;
      case "--memory-model":
        if (!args[i + 1] || args[i + 1]?.startsWith("-")) fail(`Missing value for ${args[i]}`);
        memoryModelName = args[++i];
        break;
      case "--provider":
        if (!args[i + 1] || args[i + 1]?.startsWith("-")) fail(`Missing value for ${args[i]}`);
        providerFlag = args[++i];
        break;
      case "--incognito":
      case "-i":
        incognito = true;
        break;
      case "--workdir":
      case "-w":
        if (!args[i + 1] || args[i + 1]?.startsWith("-")) fail(`Missing value for ${args[i]}`);
        workDir = expandHomeDir(args[++i]!);
        break;
      case "--resume":
      case "-r":
        if (!args[i + 1] || args[i + 1]?.startsWith("-")) fail(`Missing value for ${args[i]}`);
        resumeSessionId = args[++i];
        break;
      case "--resume-history-messages":
        if (!args[i + 1] || args[i + 1]?.startsWith("-")) fail(`Missing value for ${args[i]}`);
        try {
          resumeHistoryMessages = parseResumeHistoryMessages(args[++i]!, args[i - 1]!);
        } catch (error) {
          fail(error instanceof Error ? error.message : String(error));
        }
        resumeHistoryMessagesExplicit = true;
        break;
      case "--system-prompt":
        if (!args[i + 1] || args[i + 1]?.startsWith("-")) fail(`Missing value for ${args[i]}`);
        systemInstructions = args[++i];
        break;
      case "--system-prompt-file":
        if (!args[i + 1] || args[i + 1]?.startsWith("-")) fail(`Missing value for ${args[i]}`);
        systemPromptFiles = [...(systemPromptFiles ?? []), args[++i]!];
        break;
      case "--no-system-prompt-files":
        systemPromptFiles = [];
        break;
      case "--env-file":
        if (!args[i + 1] || args[i + 1]?.startsWith("-")) fail(`Missing value for ${args[i]}`);
        envFilePath = args[++i];
        break;
      case "--db":
        if (!args[i + 1] || args[i + 1]?.startsWith("-")) fail(`Missing value for ${args[i]}`);
        dbPath = args[++i];
        break;
      case "--no-auto-upgrade":
        noAutoUpgrade = true;
        break;
      case "--no-skill-sync":
        // 已弃用的空操作；保留此参数，以免宿主脚本传入它时中断。
        break;
      case "--version":
      case "-v":
        console.log(pkg.version);
        process.exit(0);
      // eslint-disable-next-line no-fallthrough
      case "--help":
      case "-h":
        printRunHelp();
        process.exit(0);
      // eslint-disable-next-line no-fallthrough
      default:
        if (args[i]?.startsWith("-")) {
          fail(`Unknown option: ${args[i]}`);
        }
        promptParts.push(args[i]!);
    }
  }

  // 使用 `string | undefined`，这样内联 slash 命令处理器可以在整个 prompt 只有 slash 命令时将其清空
  //（例如 `relay-pi "/model X"`），与 TUI 的整条消息分发器跳过 Agent turn 的行为保持一致。
  let prompt: string | undefined = promptParts.join(" ");

  // 未提供 prompt 时从 stdin 读取。
  if (!prompt && !interactive) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk as Buffer);
    }
    prompt = Buffer.concat(chunks).toString("utf-8").trim();
  }

  if (!prompt && !resumeSessionId && !interactive) {
    console.error("Usage: relay-pi <prompt>");
    console.error('  e.g., relay-pi "build a todo app"');
    process.exit(1);
  }

  if (providerFlag) {
    if (modelName || memoryModelName) {
      fail("--provider cannot be combined with --model or --memory-model");
    }
    const provider = resolveProviderShorthand(providerFlag);
    if (!provider) {
      fail(`Unknown provider: ${providerFlag}. Accepted values: ${PROVIDER_SHORTHANDS.join(", ")}`);
    }
    // 将聊天模型和记忆模型都固定到该 provider 的目录条目，避免在同时存在多个密钥时，解析过程
    // 通过环境变量推断出其他 provider。
    modelName = pinnedDefaultModel(provider);
    memoryModelName = pinnedMemoryModel(provider);
  }

  const dotenvKeys = loadCliEnvFiles(workDir, envFilePath);

  // 在 TUI 已挂载时探测 registry，并在有新版本时让包管理器在进程内运行。TUI 订阅
  // upgradeStatus$ 来渲染实时的标题栏信息；JSON 路径等待最终状态，并将一行摘要写入 stderr。
  //
  // 自动升级要求有 TTY：非交互调用（例如由沙箱终端通道执行的 `relay-pi <prompt>`）在命令
  //“结束”后经常会立即结束整个进程树，从而杀掉正在重命名中的 npm 子进程，导致全局
  // node_modules 树处于不完整状态（`relay-pi/.agent-<random>` 暂存目录存在但没有 `agent` 符号链接）。
  const nonInteractive = !process.stdin.isTTY && !process.stdout.isTTY;
  const upgradeStatus$ = createUpgradeStatusStream();
  const upgradePromise = runAutoUpgrade({
    packageName: pkg.name,
    currentVersion: pkg.version,
    disabled: noAutoUpgrade || nonInteractive,
    onStatus: (status) => upgradeStatus$.publish(status),
  }).then((status) => {
    upgradeStatus$.complete(status);
    return status;
  });

  const builtConfig = await buildProjectCliTurnConfig(
    {
      ...(modelName ? { modelName } : {}),
      ...(memoryModelName ? { memoryModelName } : {}),
      incognito,
      resume: Boolean(resumeSessionId),
      ...(dbPath ? { dbPath } : {}),
      workDir,
      ...(systemInstructions ? { systemInstructions } : {}),
      ...(systemPromptFiles ? { systemPromptFiles } : {}),
    },
    dotenvKeys,
  );
  const { config, memoryModelResolution, routingTable } = builtConfig;
  let { modelResolution } = builtConfig;
  modelName = modelResolution.modelName;
  memoryModelName = memoryModelResolution.modelName;

  const useTui = shouldUseTui({ interactive, prompt });

  // 在将 prompt 交给 Session 之前，处理非 TUI 一次性 prompt 中嵌入的 `/model` 和 `/thinking` 命令。
  // prompt 文本本身会原样传给 Agent；这与 TUI 保留消息中的 slash 形式，以及保留 `/skill-name`
  // 引用的行为一致。
  if (!useTui && prompt) {
    const configuredModel = config.model;
    const { residue } = applyInlineSlashCommandsToCliConfig(
      prompt,
      config,
      (line) => process.stderr.write(line),
      routingTable,
    );
    // 同步缓存的显示名称，使启动摘要信息反映任何内联覆盖，包括当前保留的选择是否仍由路由决定。
    modelName = config.model ?? modelName;
    if (config.model !== configuredModel) {
      modelResolution = resolveCliModel(modelName, dotenvKeys, routingTable);
    }
    // 分发 prompt 时去掉 slash 命令。当整个 prompt 只有 slash 命令时（例如 `relay-pi "/model X"`），
    // residue 为空，因此完全跳过 Agent turn；这与 TUI 的整条消息分发器在进入 dispatchTurn 前返回的行为一致。
    prompt = residue.length > 0 ? residue : undefined;
  }

  // 一次性调用只需要一行摘要，不需要流式状态。等待最终的升级状态，并在常规启动信息前打印人类可读的提示
  //（如果有）。TUI 则订阅实时流，并在界面中渲染“检查中……/更新中……”等中间状态。
  if (!useTui) {
    const finalStatus = await upgradePromise;
    const notice = describeUpgradeStatus(pkg.name, finalStatus);
    if (notice) process.stderr.write(`${notice}\n`);
    if (!resumeSessionId) {
      process.stderr.write(`Model: ${modelName}\n`);
      process.stderr.write(`Source: ${describeModelResolution(modelResolution)}\n`);
      process.stderr.write(`Memory model: ${memoryModelName}\n`);
      process.stderr.write(`Memory source: ${describeModelResolution(memoryModelResolution)}\n`);
    }
  }

  const manager = new SessionManager({
    ...config,
    model: config.model ?? modelResolution.modelName,
    memoryModel: config.memoryModel ?? memoryModelResolution.modelName,
  });
  if (!useTui) {
    // 非 TUI 运行（一次性 prompt、管道 stdin）以 JSONL 形式流式输出事件，便于 CI 脚本解析。
    // TUI 使用自己的渲染管线，不需要 stdout 上的 JSONL。
    manager.subscribe(({ event }) => {
      process.stdout.write(`${JSON.stringify(event)}\n`);
    });
  }

  // 确保在 Ctrl+C / SIGTERM 时 PGlite 有机会刷新 WAL。下面的 `finally` 会处理正常返回和抛出错误的情况，
  // 但信号会绕过它；如果没有这里的处理，记忆数据库可能处于不干净状态。
  const removeShutdownHandlers = installShutdownHandlers(() => manager.dispose());

  try {
    const session = resumeSessionId
      ? manager.resume(resumeSessionId)
      : manager.create({
          ...(config.mode ? { mode: config.mode } : {}),
          ...(useTui || !prompt ? {} : { prompt }),
        });
    let resumedHistory: import("@earendil-works/pi-agent-core").AgentMessage[] | undefined;

    if (resumeSessionId) {
      if (modelResolution.source !== "explicit") session.config.model = undefined;
      if (memoryModelResolution.source !== "explicit") session.config.memoryModel = undefined;
      // 强制加载持久化的 state.json，使 setup 能将恢复后的状态交给 runner，并让 TUI 在新 turn 前回放历史。
      await session.hydrate();
      if (!session.getState()) {
        throw new Error(`Unknown session: ${resumeSessionId}`);
      }
      // setup 会针对 hydrate 后的状态运行；对于新建 Session，manager.create() 已经分发了 setup。
      await session.start();
      modelName = session.config.model ?? modelName;
      memoryModelName = session.config.memoryModel ?? memoryModelName;
      // 显式的启动偏好会在 clear 和后续通过选择器恢复时继续生效，包括从旧保存命令中恢复的具体选择。
      if (modelResolution.source === "explicit") manager.config.model = modelName;
      if (memoryModelResolution.source === "explicit") manager.config.memoryModel = memoryModelName;
      if (!useTui) {
        process.stderr.write(`Model: ${modelName}\n`);
        process.stderr.write(
          `Source: ${modelResolution.source === "explicit" ? "explicit CLI flag" : "saved session selection"}\n`,
        );
        process.stderr.write(`Memory model: ${memoryModelName}\n`);
        process.stderr.write(
          `Memory source: ${memoryModelResolution.source === "explicit" ? "explicit CLI flag" : "saved session selection"}\n`,
        );
      }
      resumedHistory = session.getState()?.agent.messages;
    }

    if (prompt && resumeSessionId) {
      await session.prompt({ message: prompt });
      await session.waitForTerminal();
    } else if (prompt && !resumeSessionId) {
      await session.waitForTerminal();
    }

    // TUI 循环使用的活动 Session 指针。初始指向启动时创建的 Session（新建或通过 `--resume <id>` 恢复），
    // 每次用户从启动菜单选择“继续会话”时都会重新指向新的 Session。
    // 它与命令行的 `--resume <id>` 使用同一条路径：释放当前 Session，执行
    // `manager.resume(newId)`、`hydrate()` 和 `start()`，再用已 hydrate 的 Session 及其消息历史重新进入 `runTui`。
    let activeSession = session;
    let activeHistory = resumedHistory;
    let activeIsResume = Boolean(resumeSessionId);

    if (useTui) {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        let pendingResumeSessionId: string | undefined;
        let pendingClear = false;
        await runTui({
          session: activeSession,
          ...(activeHistory ? { history: activeHistory } : {}),
          ...(activeIsResume ? { isResume: true } : {}),
          onResumeRequest: (id: string) => {
            pendingResumeSessionId = id;
          },
          onClearRequest: () => {
            pendingClear = true;
          },
          resumeHistoryMessages,
          modelName: activeSession.config.model ?? modelName,
          modelSource:
            activeIsResume && modelResolution.source !== "explicit"
              ? "saved session selection"
              : describeModelResolution(modelResolution),
          memoryModelName: activeSession.config.memoryModel ?? memoryModelName,
          memoryModelSource:
            activeIsResume && memoryModelResolution.source !== "explicit"
              ? "saved session selection"
              : describeModelResolution(memoryModelResolution),
          workDir,
          sessionId: activeSession.id,
          packageName: pkg.name,
          packageVersion: pkg.version,
          upgradeStatus$,
        });

        if (pendingClear) {
          // slash 分发器触发 `/clear`：释放当前 Session（刷新 state.json），然后创建新的 Session。
          // 新 Session 会显示启动项，行为与不带 `--resume` 启动 `relay-pi` 相同。
          await activeSession.dispose();
          activeSession = manager.create(config.mode ? { mode: config.mode } : {});
          await activeSession.start();
          activeHistory = undefined;
          activeIsResume = false;
          continue;
        }

        if (!pendingResumeSessionId) break;

        // 用户从启动菜单选择了最近的 Session。先释放当前 Session，以便刷新其 state.json；然后 hydrate
        // 目标 Session，使 `agent.messages` 可用于转录回放。
        await activeSession.dispose();
        activeSession = manager.resume(pendingResumeSessionId);
        if (modelResolution.source !== "explicit") activeSession.config.model = undefined;
        if (memoryModelResolution.source !== "explicit")
          activeSession.config.memoryModel = undefined;
        await activeSession.hydrate();
        if (!activeSession.getState()) {
          throw new Error(`Unknown session: ${pendingResumeSessionId}`);
        }
        await activeSession.start();
        activeHistory = activeSession.getState()?.agent.messages;
        activeIsResume = true;
      }
    }

    modelName = activeSession.config.model ?? modelName;
    memoryModelName = activeSession.config.memoryModel ?? memoryModelName;
    process.stderr.write(
      `To resume this session:\n${resumeCommand(activeSession.id, {
        ...(modelName ? { modelName } : {}),
        ...(memoryModelName ? { memoryModelName } : {}),
        workDir,
        incognito,
        ...(dbPath ? { dbPath } : {}),
        ...(systemInstructions ? { systemInstructions } : {}),
        ...(systemPromptFiles ? { systemPromptFiles } : {}),
        ...(envFilePath ? { envFilePath } : {}),
        ...(resumeHistoryMessagesExplicit ? { resumeHistoryMessages } : {}),
      })}\n`,
    );
  } catch (err: any) {
    console.error(`Fatal: ${err.message}`);
    process.exitCode = 1;
  } finally {
    removeShutdownHandlers();
    await manager.dispose();
  }
}
