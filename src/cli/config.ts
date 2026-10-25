import { exportRoutingTable } from "../model-routing/loader.js";

/** 路由配置命令使用的进程级副作用。 */
export interface ConfigCommandOptions {
  /** 写入 `.relay-pi/models.json` 的项目目录。 */
  cwd?: string;
  /** 输出接收端；默认为 stdout。 */
  write?: (text: string) => void;
}

function printConfigHelp(write: (text: string) => void): void {
  write(
    `relay-pi config — Export editable project configuration\n\nUSAGE\n  relay-pi config export [--force]\n`,
  );
}

/** 导出完整的内置路由表，不静默覆盖已有编辑。 */
export async function runConfigCommand(
  args: string[],
  options: ConfigCommandOptions = {},
): Promise<void> {
  const write = options.write ?? ((text: string) => process.stdout.write(text));
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    printConfigHelp(write);
    return;
  }
  const [action, ...flags] = args;
  if (action !== "export") throw new Error(`Unknown config action: ${action}`);
  const unknown = flags.find((flag) => flag !== "--force");
  if (unknown) throw new Error(`Unknown config export option: ${unknown}`);
  const exported = await exportRoutingTable({
    cwd: options.cwd ?? process.cwd(),
    force: flags.includes("--force"),
  });
  write(`${exported.path}\n`);
}
