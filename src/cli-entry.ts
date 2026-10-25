#!/usr/bin/env bun

/**
 * Relay Pi（`relay-pi`）CLI 可执行文件入口。
 *
 * 此文件有意保持精简：发布后的 `relay-pi` bin 在这里解析，因此默认运行命令中的
 * `relay-pi -v` / `relay-pi --version` 可以直接打印版本，而不必承担求值完整的
 * run/session/TUI 导入图约 ~0.3 秒的成本；该导入图由 `./cli.js` 静态拉取。其他调用
 * 都交给拥有真正子命令分发逻辑的 `runCli`。
 */

import packageJson from "../package.json" with { type: "json" };

const args = process.argv.slice(2);

// 以 `-v`/`--version` 开头的是版本调用；命名子命令和 `--rpc` 各自拥有参数解析，
// 因此只有第一个 token 会触发短路。
if (args[0] === "-v" || args[0] === "--version") {
  console.log(packageJson.version);
} else {
  const { runCli } = await import("./cli.js");
  await runCli();
}
