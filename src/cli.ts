#!/usr/bin/env bun

/**
 * Relay Pi（`relay-pi`）CLI 入口。
 *
 * 用法：
 *   relay-pi "build a todo app in React"
 *   relay-pi --model opus-5.5 "refactor auth system"
 *   echo "fix the bug in server.ts" | relay-pi
 *
 * 真正的命令实现位于 `src/cli/` 下。本文件负责子命令分发，并作为测试和调用方的
 * 公开重新导出层，兼容过去从 `src/cli.ts` 导入辅助函数的代码。
 */

import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import packageJson from "../package.json" with { type: "json" };
import { runConfigCommand } from "./cli/config.js";
import { runConnectCommand } from "./cli/connect.js";
import { runEnvCommand } from "./cli/env.js";
import { runMemoryCommand } from "./cli/memory.js";
import { runRpcCommand } from "./cli/rpc.js";
import { runRouteCommand } from "./cli/route.js";
import { runRunCommand } from "./cli/run.js";
import { runSkillsCommand } from "./cli/skills.js";
import { runTrainCommand } from "./cli/train.js";
import { runUpgradeCommand } from "./cli/upgrade.js";
import { loadConnectedTransportSnapshot } from "./cli/shared.js";

// ---- 公开重新导出 ----------------------------------------------------
// 外部测试和调用方过去一直从 `src/cli.ts` 导入这些辅助函数；现在实现已
// 与各自的命令放在同一个目录下。

export type { CliTurnConfigInput, CliTurnConfigResolution, PackageMetadata } from "./cli/run.js";
export { buildCliTurnConfig, runRunCommand, shouldUseTui } from "./cli/run.js";
export { runRpcCommand } from "./cli/rpc.js";
export { runEnvCommand } from "./cli/env.js";
export type { EnvCommandIO } from "./cli/env.js";
export { runSkillsCommand } from "./cli/skills.js";
export { runUpgradeCommand } from "./cli/upgrade.js";
export { runMemoryCommand } from "./cli/memory.js";
export { runRouteCommand } from "./cli/route.js";
export { runConfigCommand } from "./cli/config.js";
export { runConnectCommand } from "./cli/connect.js";
export type { ConnectCommandIO } from "./cli/connect.js";
export { runMemoryAddCommand } from "./cli/memory-add.js";
export { runMemoryRecallCommand } from "./cli/memory-recall.js";
export { runMemoryReflectCommand } from "./cli/memory-reflect.js";
export { runTrainCommand } from "./cli/train.js";
export {
  cliEnvFilePaths,
  defaultRelayPiEnvFilePath,
  expandHomeDir,
  fileExists,
  formatEnvEntries,
  loadCliEnvFiles,
  connectedTransportSnapshot,
  loadConnectedTransportSnapshot,
  parseResumeHistoryMessages,
  resolveUserPath,
  shellQuote,
} from "./cli/shared.js";
export { detectPackageManagerFromContext, globalUpgradeCommand } from "./cli/package-manager.js";
export type { PackageManager, PackageManagerDetectionContext } from "./cli/package-manager.js";
export { compareSemverVersions, fetchLatestPackageVersion } from "./cli/version-check.js";
export { resumeCommand } from "./cli/resume-hint.js";
export type { ResumeCommandInput } from "./cli/resume-hint.js";

const PACKAGE_METADATA = {
  name: packageJson.name,
  version: packageJson.version,
} as const;

export async function runCli(): Promise<void> {
  const args = process.argv.slice(2);
  const subcommand = args[0];

  try {
    await loadConnectedTransportSnapshot();
    if (subcommand === "upgrade") {
      await runUpgradeCommand(args.slice(1), PACKAGE_METADATA.name);
      return;
    }
    if (subcommand === "skills") {
      runSkillsCommand(args.slice(1));
      return;
    }
    if (subcommand === "env") {
      await runEnvCommand(args.slice(1));
      return;
    }
    if (subcommand === "connect") {
      await runConnectCommand(args.slice(1));
      return;
    }
    if (subcommand === "memory" || subcommand === "memories") {
      await runMemoryCommand(args.slice(1));
      return;
    }
    if (subcommand === "route") {
      await runRouteCommand(args.slice(1));
      return;
    }
    if (subcommand === "config") {
      await runConfigCommand(args.slice(1));
      return;
    }
    if (subcommand === "train") {
      await runTrainCommand(args.slice(1));
      return;
    }

    // `--rpc` 是顶层路由 flag 而不是子命令，因为它与默认运行命令共享所有 model/workdir/env
    // flag；区别只有 I/O 表面（stdin commands、stdout events）。
    if (args.includes("--rpc")) {
      await runRpcCommand(args, PACKAGE_METADATA);
      return;
    }

    await runRunCommand(args, PACKAGE_METADATA);
  } catch (err: any) {
    console.error(`Fatal: ${err.message}`);
    process.exitCode = 1;
  }
}

/** 仅当直接调用 dispatcher 文件本身，而不是 cli-entry 或测试时才为 true。 */
export function isDirectCliInvocation(moduleUrl: string, invokedPath: string | undefined): boolean {
  if (!invokedPath) return false;
  const moduleName = basename(fileURLToPath(moduleUrl));
  return ["cli.ts", "cli.js"].includes(moduleName) && basename(invokedPath) === moduleName;
}

// Bun 的单文件编译器会为动态导入的模块提供可执行文件的 URL。显式文件名检查确保
// cli-entry 是唯一的编译归属者。
if (isDirectCliInvocation(import.meta.url, process.argv[1])) {
  void runCli();
}
