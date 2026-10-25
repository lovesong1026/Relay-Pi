import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { TSchema } from "typebox";
import type { McpHttpServerConfig } from "../types/protocol.js";

const MCP_TOOL_NAME_SEPARATOR = "__";

/**
 * 已连接的 MCP server 运行时。
 *
 * 每个已配置的 server 拥有一个 MCP client + transport；运行时将这些 server 的工具合并为
 * `AgentTool[]`，可直接提供给父 Agent 或 state Agent，并在 TurnRunner 关闭时释放连接。
 *
 * 工具名使用 `{server}__{tool}` 命名空间，因此单个 Agent 回合内多个名称重叠的 server
 * 也可以共存而不会冲突。
 */
export interface McpRuntime {
  /** 为所有已连接的 MCP server 提供的工具，顺序确定。 */
  tools: AgentTool[];
  /** 关闭每个 transport 和 client。幂等。 */
  dispose: () => Promise<void>;
}

interface McpSession {
  serverName: string;
  client: Client;
  transport: Transport;
}

/**
 * 连接所有已配置的 HTTP MCP server，并构建扁平的 `AgentTool` 列表。
 * 连接失败的 server 会被丢弃并发出警告，因此单个故障 server 不会阻止其余 server
 * 以及 TurnRunner 启动。
 */
export async function connectMcpServers(
  servers: Record<string, McpHttpServerConfig>,
  options?: {
    /** Optional sink for connection diagnostics. Defaults to `console.warn`. */
    onWarn?: (message: string) => void;
  },
): Promise<McpRuntime> {
  const warn = options?.onWarn ?? ((message: string) => console.warn(message));
  const sessions: McpSession[] = [];
  const tools: AgentTool[] = [];

  for (const [serverName, config] of Object.entries(servers)) {
    if (config.type !== "http") {
      warn(`mcp: unsupported transport "${config.type}" for server "${serverName}"; skipping.`);
      continue;
    }
    let url: URL;
    try {
      url = new URL(config.url);
    } catch {
      warn(`mcp: invalid url for server "${serverName}": ${config.url}; skipping.`);
      continue;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      warn(`mcp: unsupported protocol "${url.protocol}" for server "${serverName}"; skipping.`);
      continue;
    }

    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: config.headers ? { headers: config.headers } : undefined,
    });
    const client = new Client({ name: "relay-pi", version: "0.0.0" });

    try {
      await client.connect(transport);
    } catch (error) {
      warn(`mcp: failed to connect server "${serverName}": ${describeError(error)}`);
      await transport.close().catch(() => {});
      await client.close().catch(() => {});
      continue;
    }

    let listed: Awaited<ReturnType<Client["listTools"]>>;
    try {
      listed = await client.listTools();
    } catch (error) {
      warn(`mcp: failed to list tools for server "${serverName}": ${describeError(error)}`);
      await disposeSession({ serverName, client, transport });
      continue;
    }

    sessions.push({ serverName, client, transport });
    for (const tool of listed.tools) {
      tools.push(buildAgentTool(serverName, client, tool));
    }
  }

  // 只排序一次，使工具块在各回合间保持稳定，以便提示词缓存。
  tools.sort((a, b) => a.name.localeCompare(b.name));

  let disposed = false;
  return {
    tools,
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      await Promise.allSettled(sessions.map(disposeSession));
    },
  };
}

interface ListedMcpTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema: unknown;
}

function buildAgentTool(serverName: string, client: Client, tool: ListedMcpTool): AgentTool {
  const namespacedName = `${serverName}${MCP_TOOL_NAME_SEPARATOR}${tool.name}`;
  // MCP 工具的 inputSchema 是 JSON Schema；pi-agent 的 Ajv 校验器以
  // strictSchema:false 运行，因此可接受普通 JSON Schema 对象，放入类型标注为 TSchema 的
  // `parameters` 槽位。
  const parameters = (tool.inputSchema ?? { type: "object" }) as TSchema;
  return {
    name: namespacedName,
    label: tool.title ?? tool.name,
    description: tool.description ?? `MCP tool "${tool.name}" provided by server "${serverName}".`,
    parameters,
    // 中止信号是中断路径：用户中断会中止 Agent 循环的 controller，长轮询 MCP 工具
    // （例如 Composio 的 wait-for-connection）必须随之结束，而不能将回合固定到 SDK 的
    // 请求超时。
    execute: async (_toolCallId, params, signal) => {
      const result = (await client.callTool(
        {
          name: tool.name,
          arguments: isPlainObject(params) ? (params as Record<string, unknown>) : {},
        },
        undefined,
        { signal },
      )) as CallToolResult;
      return toAgentToolResult(serverName, tool.name, result);
    },
  };
}

function toAgentToolResult(
  serverName: string,
  toolName: string,
  result: CallToolResult,
): AgentToolResult<{ mcpServer: string; mcpTool: string; structuredContent?: unknown }> {
  const rawContent = Array.isArray(result.content) ? result.content : [];
  const content =
    rawContent.length > 0
      ? (rawContent as AgentToolResult<unknown>["content"])
      : ([
          {
            type: "text",
            text:
              result.structuredContent !== undefined
                ? JSON.stringify(result.structuredContent, null, 2)
                : JSON.stringify(
                    { status: result.isError ? "error" : "ok", server: serverName, tool: toolName },
                    null,
                    2,
                  ),
          },
        ] as AgentToolResult<unknown>["content"]);
  return {
    content,
    details: {
      mcpServer: serverName,
      mcpTool: toolName,
      structuredContent: result.structuredContent,
    },
  };
}

async function disposeSession(session: McpSession): Promise<void> {
  await session.transport.close().catch(() => {});
  await session.client.close().catch(() => {});
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
