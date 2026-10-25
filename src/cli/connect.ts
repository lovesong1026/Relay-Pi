import type { OAuthAuth } from "@earendil-works/pi-ai";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { printConnectHelp } from "./help.js";
import { usageError } from "./shared.js";
import {
  probeConnectedProvider,
  type CapabilityProbeResult,
} from "../connected-providers/capability-probe.js";
import { installFakeIssuerIfConfigured } from "../connected-providers/fake-issuer.js";
import {
  connectedProviders,
  resolveConnectedProviderAlias,
} from "../connected-providers/registry.js";
import {
  createConnectedProviderStore,
  type ConnectedProviderId,
  type ConnectedProviderStore,
  type ConnectionRecord,
} from "../connected-providers/store.js";

export interface ConnectCommandIO {
  /** CLI 使用的凭据存储接入点，测试中可替换为内存存储。 */
  store?: ConnectedProviderStore;
  /** 将供人阅读的输出或仅含协议内容的 JSON 写入 stdout。 */
  write?: (text: string) => void;
  /** 将供人阅读的进度写入 stderr，可与协议 stdout 分别捕获。 */
  writeError?: (text: string) => void;
  /** 无需拦截全局 stdout 即可覆盖帮助打印器。 */
  printHelp?: () => void;
  /** 环境接入点，用于控制测试和预发布环境中的 fake-issuer 注册。 */
  env?: Record<string, string | undefined>;
  /** 覆盖 TTY 检测；非交互调用始终使用设备码登录。 */
  interactive?: boolean;
  /** 覆盖浏览器启动方式，不改变所运行的 OAuth 流程。 */
  openUrl?: (url: string) => void;
  /** 读取浏览器流程的后备输入或 Copilot 企业域名输入。 */
  prompt?: (message: string) => Promise<string>;
  /**
   * OAuth 实现接入点。实现归属于对应 provider，因此
   * 需要不同实现的测试在此注入，而不是在命令运行时
   * 替换其依赖的注册表。
   */
  oauth?: (id: ConnectedProviderId) => OAuthAuth;
  /** 能力检测接入点；生产环境会执行真实的单 token provider 补全请求。 */
  probe?: typeof probeConnectedProvider;
  /** 用于持久化时间戳和设备码过期事件的时钟。 */
  now?: () => number;
}

type ConnectionStatusJson = Pick<
  ConnectionRecord,
  "provider" | "connectedAt" | "eligibility" | "eligibilityCheckedAt" | "lastRefreshAt"
>;

export type ConnectedProviderCliEvent =
  | {
      type: "device_code";
      provider: ConnectedProviderId;
      verificationUri: string;
      userCode: string;
      expiresAt: number;
    }
  | { type: "progress"; provider: ConnectedProviderId; code: string }
  | {
      type: "complete";
      provider: ConnectedProviderId;
      state: "connected" | "plan_ineligible" | "disconnected";
    }
  | { type: "error"; provider: ConnectedProviderId; code: string };

export async function runConnectCommand(args: string[], io: ConnectCommandIO = {}): Promise<void> {
  const write = io.write ?? ((text: string) => process.stdout.write(text));
  const writeError = io.writeError ?? ((text: string) => process.stderr.write(text));
  const store = io.store ?? createConnectedProviderStore();
  let status = false;
  let json = false;
  let deviceCode = false;
  let noBrowser = false;
  let disconnect: ConnectedProviderId | undefined;
  let target: ConnectedProviderId | undefined;

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    switch (arg) {
      case "--status":
        status = true;
        break;
      case "--json":
        json = true;
        break;
      case "--device-code":
        deviceCode = true;
        break;
      case "--no-browser":
        noBrowser = true;
        break;
      case "--disconnect": {
        const value = args[++index];
        if (!value || value.startsWith("-")) usageError("Missing value for --disconnect");
        disconnect = resolveProvider(value);
        break;
      }
      case "--help":
      case "-h":
        (io.printHelp ?? printConnectHelp)();
        return;
      default:
        if (arg.startsWith("-")) usageError(`Unknown connect option: ${arg}`);
        if (target !== undefined) usageError(`Unexpected connect argument: ${arg}`);
        target = resolveProvider(arg);
    }
  }

  if (!status && disconnect === undefined && target === undefined) {
    if (json) usageError("--json requires --status or a provider");
    (io.printHelp ?? printConnectHelp)();
    return;
  }
  const operationCount =
    Number(status) + Number(disconnect !== undefined) + Number(target !== undefined);
  if (operationCount > 1) usageError("Choose one of provider login, --status, or --disconnect");
  if ((deviceCode || noBrowser) && target === undefined) {
    usageError("--device-code and --no-browser require a provider login");
  }

  if (disconnect !== undefined) {
    const existing = await store.get(disconnect);
    if (!existing) usageError(`${providerLabel(disconnect)} is not connected`);
    await store.remove(disconnect);
    if (json) writeEvent(write, { type: "complete", provider: disconnect, state: "disconnected" });
    else write(`Disconnected ${providerLabel(disconnect)}.\n`);
    return;
  }

  if (status) {
    const connections = await store.read();
    if (json) {
      write(`${JSON.stringify({ connections: connections.map(toStatusJson) })}\n`);
      return;
    }
    if (connections.length === 0) {
      write("No connected providers. Run `relay-pi connect chatgpt`.\n");
      return;
    }
    write(`${connections.map(formatConnection).join("\n")}\n`);
    return;
  }

  if (target !== undefined) {
    await connectProvider(target, {
      ...io,
      store,
      write,
      writeError,
      json,
      // --no-browser 仅禁止自动打开 URL，不改变
      // OAuth 流程。--device-code、机器可读输出或
      // 非交互 stdin 会强制使用设备码模式。
      forceDeviceCode: deviceCode || json || !(io.interactive ?? Boolean(process.stdin.isTTY)),
      noBrowser,
    });
  }
}

function resolveProvider(value: string): ConnectedProviderId {
  return resolveConnectedProviderAlias(value) ?? usageError(`Unknown connected provider: ${value}`);
}

function toStatusJson(connection: ConnectionRecord): ConnectionStatusJson {
  return {
    provider: connection.provider,
    connectedAt: connection.connectedAt,
    eligibility: connection.eligibility,
    ...(connection.eligibilityCheckedAt === undefined
      ? {}
      : { eligibilityCheckedAt: connection.eligibilityCheckedAt }),
    ...(connection.lastRefreshAt === undefined ? {} : { lastRefreshAt: connection.lastRefreshAt }),
  };
}

function formatConnection(connection: ConnectionRecord): string {
  const state = connection.eligibility === "plan_ineligible" ? "plan not eligible" : "connected";
  return `${providerLabel(connection.provider)} — ${state}`;
}

function providerLabel(provider: ConnectedProviderId): string {
  return connectedProviders().find(({ id }) => id === provider)?.label ?? provider;
}

interface ConnectProviderOptions extends ConnectCommandIO {
  store: ConnectedProviderStore;
  write: (text: string) => void;
  writeError: (text: string) => void;
  json: boolean;
  forceDeviceCode: boolean;
  noBrowser: boolean;
}

async function connectProvider(
  id: ConnectedProviderId,
  options: ConnectProviderOptions,
): Promise<void> {
  installFakeIssuerIfConfigured(options.env ?? process.env);
  const entry = connectedProviders().find((candidate) => candidate.id === id);
  if (!entry) throw new Error("Connected provider is not registered.");
  const now = options.now ?? (() => Date.now());
  const emit = (event: ConnectedProviderCliEvent) => writeEvent(options.write, event);

  let credentials: ConnectionRecord["credentials"];
  try {
    // pi-ai 返回其规范的带标签凭据；Relay Pi 的存储保存
    // 不带标签的令牌，并在每个 pi-ai 调用点重新添加标签。
    // pi-ai 用一个 `notify` 流和一个 `prompt` 替代了具名登录回调，
    // 因此 CLI 根据事件分支处理，而不是为每种类型注册
    // 处理器。设备码分支仍是 VM 唯一可用的方式。
    const { type: _tag, ...token } = await (options.oauth?.(id) ?? entry.oauth()).login({
      signal: new AbortController().signal,
      notify: (event) => {
        if (event.type === "auth_url") {
          options.writeError(`Open ${event.url} to connect ${entry.label}.\n`);
          if (!options.noBrowser) openUrl(event.url, options.openUrl);
          return;
        }
        if (event.type === "device_code") {
          if (options.json) {
            emit({
              type: "device_code",
              provider: id,
              verificationUri: event.verificationUri,
              userCode: event.userCode,
              expiresAt: now() + (event.expiresInSeconds ?? 900) * 1000,
            });
          } else {
            options.writeError(
              `User code: ${event.userCode}\nVerification URL: ${event.verificationUri}\n`,
            );
          }
          if (!options.noBrowser && !options.json) {
            openUrl(event.verificationUri, options.openUrl);
          }
          return;
        }
        if (event.type === "progress" && !options.json) {
          options.writeError(`Connecting ${entry.label}…\n`);
        }
      },
      prompt: async (request) => {
        if (request.type === "select") {
          const wanted = options.forceDeviceCode ? "device_code" : "browser";
          // 不提供选项的 provider 仍会收到我们的偏好；
          // 此时无从选择，任何答案都同样是任意选择。
          return (
            request.options.find((option) => option.id === wanted)?.id ??
            request.options[0]?.id ??
            wanted
          );
        }
        // Copilot 的流程会提示输入一个 VM 无法回答的可选值。
        if (id === "github-copilot" && !options.prompt) return "";
        return (options.prompt ?? promptInput)(request.message);
      },
    });
    credentials = token;
  } catch (error) {
    const code = loginErrorCode(error);
    if (options.json) emit({ type: "error", provider: id, code });
    throw new Error(loginErrorMessage(code));
  }

  if (options.json) emit({ type: "progress", provider: id, code: "probing_capability" });
  else options.writeError(`Checking ${entry.label} plan eligibility…\n`);
  const result = await runProbe(options.probe ?? probeConnectedProvider, id, credentials);
  const checkedAt = now();
  await options.store.withLock(id, async () => ({
    next: {
      provider: id,
      credentials,
      connectedAt: checkedAt,
      eligibility: result.eligibility,
      eligibilityCheckedAt: checkedAt,
    },
    result: undefined,
  }));

  if (result.eligibility === "unknown") {
    if (options.json) emit({ type: "error", provider: id, code: "capability_unknown" });
    throw new Error(`${entry.label} connected, but plan eligibility could not be confirmed.`);
  }

  const state = result.eligibility === "eligible" ? "connected" : "plan_ineligible";
  if (options.json) {
    emit({ type: "complete", provider: id, state });
    return;
  }
  if (result.eligibility === "plan_ineligible") {
    options.write(`Connected ${entry.label} — plan not eligible.\n`);
    return;
  }
  const coverage = result.servedModelIds.length
    ? ` — plan covers ${result.servedModelIds.join(", ")}`
    : "";
  options.write(`Connected ${entry.label}${coverage}.\n`);
}

async function runProbe(
  probe: typeof probeConnectedProvider,
  id: ConnectedProviderId,
  credentials: ConnectionRecord["credentials"],
): Promise<CapabilityProbeResult> {
  try {
    return await probe(id, credentials);
  } catch {
    return {
      eligibility: "unknown",
      servedModelIds: [],
      detail: "Capability probe request failed.",
    };
  }
}

function writeEvent(write: (text: string) => void, event: ConnectedProviderCliEvent): void {
  write(`${JSON.stringify(event)}\n`);
}

function loginErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (message.includes("denied")) return "login_denied";
  if (message.includes("expired") || message.includes("timed out")) return "login_expired";
  if (message.includes("cancel")) return "login_cancelled";
  return "login_failed";
}

function loginErrorMessage(code: string): string {
  switch (code) {
    case "login_denied":
      return "Connected-provider login was denied.";
    case "login_expired":
      return "Connected-provider device code expired.";
    case "login_cancelled":
      return "Connected-provider login was cancelled.";
    default:
      return "Connected-provider login failed.";
  }
}

function openUrl(url: string, override?: (url: string) => void): void {
  if (override) {
    override(url);
    return;
  }
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  const child = spawn(command, [url], { detached: true, stdio: "ignore" });
  child.on("error", () => undefined);
  child.unref();
}

async function promptInput(message: string): Promise<string> {
  const terminal = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await terminal.question(`${message} `);
  } finally {
    terminal.close();
  }
}
