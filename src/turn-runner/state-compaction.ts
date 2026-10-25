import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { TurnState } from "../types/protocol.js";

/**
 * 自动 state 压缩的默认上限，以序列化 `TurnState` 的字节数计。
 * 长期 Session 会不断累积工具调用和工具结果；没有上限时，每次 emit 和磁盘持久化最终都会
 * 受到数百 MB transcript 的拖累。
 *
 * 100 MB 足以为数小时密集的工具调用工作留出余量，同时又足够小，使 emit/persist 在普通硬件
 * 上保持敏捷。可通过 `TurnRunnerConfig.autoStateCompaction.maxBytes` 按 runner 调整。
 */
export const DEFAULT_STATE_MAX_BYTES = 100 * 1024 * 1024;

/**
 * 即使单条消息超过上限，也至少保留这么多条消息，使下一回合仍有锚点上下文。
 * runner 可以从截断的 transcript 中恢复，但无法从空 transcript 中恢复。
 */
export const MIN_RETAINED_MESSAGES = 1;

export interface AutoStateCompactionOptions {
  /** `JSON.stringify(state).length` 的硬上限。默认为 100 MB。 */
  maxBytes?: number;
}

export interface CompactionResult {
  state: TurnState;
  evicted: number;
  /** 压缩后的序列化字节长度，供调用方记录日志/指标。 */
  bytes: number;
}

/**
 * 按父 Agent 有效上下文窗口的比例计算按需 `compact` 命令针对保留 wire 尾部的目标。
 * 20% 是有意设置的激进上限：剩余 80% 留给系统提示词、memory pack、下一条用户 prompt
 * 和下一条 assistant 响应，使刚压缩的 Session 为下一回合保留真实余量，而不是立刻再次触发
 * auto-compaction 上限。runner 通过 wire-shaping 的 `WireGuardHorizon` 使用此值；磁盘上不会
 * 发生变化。
 */
export const COMPACT_MESSAGE_TOKENS_RATIO = 0.2;

/**
 * Anthropic 和 OpenAI 都会拒绝首条消息不是 `user` 的对话。
 * 从前端淘汰可能留下 `toolResult`（没有其 assistant 调用而成为孤儿）或位于开头的
 * `assistant` 消息；这两种情况都会使恢复后的下一回合卡住。
 */
function isInvalidHead(message: AgentMessage | undefined): boolean {
  if (!message || !("role" in message)) return false;
  return message.role === "toolResult" || message.role === "assistant";
}

function taskIdsReferencedBy(message: AgentMessage): Set<string> {
  return new Set(JSON.stringify(message).match(/\bt\d+\b/g) ?? []);
}

function toolCallIds(message: AgentMessage): Set<string> {
  if (!("role" in message) || message.role !== "assistant" || !("content" in message)) {
    return new Set();
  }
  const content = Array.isArray(message.content) ? message.content : [];
  return new Set(
    content.flatMap((block) => {
      if (!block || typeof block !== "object" || !("type" in block) || block.type !== "toolCall") {
        return [];
      }
      const candidate = block as { id?: unknown; toolCallId?: unknown };
      const id = candidate.id ?? candidate.toolCallId;
      return typeof id === "string" ? [id] : [];
    }),
  );
}

/**
 * 查找每个工具调用/结果配对中的两条消息，结果中携带仍在运行的 task ID。
 * 结果可能被同级结果与其 assistant 调用隔开，因此应匹配结构上的工具调用 ID，而不是依赖相邻关系。
 */
function findLiveTaskPairMessages(
  state: TurnState,
  messages: readonly AgentMessage[],
): Set<AgentMessage> {
  const liveTaskIds = new Set<string>(
    (state.tasks ?? [])
      .filter(({ status }) => status === "running" || status === "scheduled")
      .map(({ id }) => id),
  );
  const pinned = new Set<AgentMessage>();
  if (liveTaskIds.size === 0) return pinned;

  for (let resultIndex = 0; resultIndex < messages.length; resultIndex += 1) {
    const result = messages[resultIndex];
    if (!result || !("role" in result) || result.role !== "toolResult") continue;
    const referencesLiveTask = [...taskIdsReferencedBy(result)].some((id) => liveTaskIds.has(id));
    if (!referencesLiveTask) continue;

    const resultCallId = "toolCallId" in result ? result.toolCallId : undefined;
    if (typeof resultCallId !== "string") continue;
    for (let callIndex = resultIndex - 1; callIndex >= 0; callIndex -= 1) {
      const call = messages[callIndex];
      if (!call) continue;
      if (toolCallIds(call).has(resultCallId)) {
        pinned.add(call);
        pinned.add(result);
        break;
      }
    }
  }
  return pinned;
}

/**
 * 返回一个新的 `TurnState`，其序列化大小不超过 `maxBytes`，优先淘汰最旧的 Agent 消息。
 * 每次淘汰后，继续丢弃开头的 `toolResult` 或 `assistant` 消息，直到开头变为 `user`——这是
 * 每个 provider 都接受的唯一位置 0 角色。
 *
 * 前端淘汰通过构造保证工具调用/工具结果配对不被破坏。当结果携带仍在运行的 task ID 时，
 * 配对双方都会被固定：移除前会检查完整的无效开头级联，并在前一个有效边界处停止，而不会
 * 拆分或淘汰该配对。如果找不到 transcript 配对，`TurnState.tasks` 仍是权威来源。
 *
 * 保留原始 state 引用（不修改），以及 `TurnState` 和 `state.agent` 上每个非消息字段
 *（`status`、`mode`、`options`、`stateMachine`、`todos`、`followUpQueue`、`queuedCommands`、
 * `tasks` 和 `nextTaskId`）。
 *
 * 当 `messages.length <= MIN_RETAINED_MESSAGES` 时停止。如果剩余内容仍超过 `maxBytes`，
 * 调用方会持久化/emit 超大 state：可恢复的截断 transcript 胜过卡死的 Session。
 */
export function compactTurnState(
  state: TurnState,
  options: AutoStateCompactionOptions = {},
): CompactionResult {
  const maxBytes = options.maxBytes ?? DEFAULT_STATE_MAX_BYTES;
  let serialized = JSON.stringify(state);
  if (serialized.length <= maxBytes) {
    return { state, evicted: 0, bytes: serialized.length };
  }

  const messages = state.agent?.messages;
  if (!messages || messages.length === 0) {
    // 非消息膨胀（例如巨大的 queuedCommands）。此层无能为力。
    return { state, evicted: 0, bytes: serialized.length };
  }

  const trimmed: AgentMessage[] = [...messages];
  const pinned = findLiveTaskPairMessages(state, messages);
  let current: TurnState = state;
  let evicted = 0;

  while (serialized.length > maxBytes && trimmed.length > MIN_RETAINED_MESSAGES) {
    let removeCount = 1;
    while (
      trimmed.length - removeCount > MIN_RETAINED_MESSAGES &&
      isInvalidHead(trimmed[removeCount])
    ) {
      removeCount += 1;
    }
    const removal = trimmed.slice(0, removeCount);
    if (removal.some((message) => pinned.has(message))) break;
    trimmed.splice(0, removeCount);
    evicted += removeCount;
    current = { ...current, agent: { ...current.agent, messages: trimmed } };
    serialized = JSON.stringify(current);
  }

  return { state: current, evicted, bytes: serialized.length };
}
