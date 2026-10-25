import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { CHARS_PER_TOKEN } from "../memory/observational.js";
import type { WireGuardHorizon } from "../types/protocol.js";

/**
 * 已派发消息列表的字节预算安全网。`createObservationalContextTransform` 中的 token 预算触发器
 * 是普通文本和工具 Session 的主要闸门，但图像附件会破坏这道闸门：单张内联图像可能携带数百 KB
 * 的 base64，而 provider 按图像收取的 token 费用有上限（且在不同 provider 和分辨率之间不可预测）。
 * 没有字节闸门时，几张大截图可能在 token 估算追上之前，就把序列化请求推过任何合理限制。
 *
 * 15 MB 远高于典型的纯文本上下文，但仍有明确上限；无论 provider 声称图像 token 多么便宜，
 * 它都会限制单个派发 body 在触发压缩前可以携带的图像 payload 量。
 */
export const WIRE_BYTE_TRIGGER = 15 * 1024 * 1024;

/**
 * 发生淘汰时，丢弃最旧消息，直到 wire payload 达到此目标——远低于触发阈值——这样接下来几回合
 * 可以重新增长，之后才会再次触发淘汰。每次越过阈值时进行一次大的块状淘汰，比每回合渐进式裁剪
 * 更有利于提示词缓存（每次前进只会使缓存前缀失效一次，因此前进次数越少，失效次数越少）。
 */
export const WIRE_BYTE_TARGET = Math.floor(WIRE_BYTE_TRIGGER * 0.8);

/**
 * 单张内联图像在 wire 上的保守跨 provider 费用。
 * Claude vision 每张图像最高约 1,568 tokens，OpenAI 的高细节图像会按 512px tile 增长，
 * 因此 1,600 是一个四舍五入后的估计：能产生真实的上下文压力，又不会随 base64 payload 大小膨胀。
 *
 * 图像的 base64 字节长度没有 token 信号意义：对 2 MB 内联图像使用 `ceil(bytes/4)` 会得到约
 * 500K 个“tokens”，而 provider 实际只收取几千。该不匹配曾触发图像密集回合的
 * `messageTokens` 淘汰闸门，并从 wire 中提前淘汰较早的用户消息（参见 thread-context-loss eval）。
 * 图像 payload 大小由 {@link WIRE_BYTE_TRIGGER} 单独限制。
 */
export const IMAGE_WIRE_TOKEN_ESTIMATE = 1_600;

/**
 * 淘汰不会裁剪到少于此数量的最近消息。最新的 user 消息是 actor 当前的 prompt，必须始终保留；
 * 更深层的预算缺口由 memory transform 预置到派发消息列表中的持久观察记忆吸收。
 */
const MIN_HISTORY_TAIL = 1;

/**
 * 新 runner 的默认值。持久化会通过 `TurnState.wireGuardHorizon` 往返传递 `WireGuardHorizon`，
 * 因此恢复的 Session 会通过 `Object.assign` 原地覆盖此默认对象，以保留 observational context
 * transform 持有的引用身份。
 */
export function createInitialHorizon(): WireGuardHorizon {
  return { evictionHorizon: 0 };
}

interface ImageBlock {
  type: "image";
  data: string;
}

interface TextBlock {
  type: "text";
  text: string;
}

function isImageBlock(value: unknown): value is ImageBlock {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "image" &&
    typeof (value as { data?: unknown }).data === "string"
  );
}

function isTextBlock(value: unknown): value is TextBlock {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "text" &&
    typeof (value as { text?: unknown }).text === "string"
  );
}

function messageTimestamp(msg: AgentMessage): number {
  return (msg as { timestamp?: number }).timestamp ?? 0;
}

/**
 * 单条消息对序列化 wire payload 贡献的字节数。图像块按 base64 长度计数，文本块按 UTF-16 长度计数；
 * 其他结构化块（带 `thinkingSignature` 的 thinking、toolCall、toolResult details）回退到 JSON 序列化估算。
 * 对这些块而言，JSON 路径就是实际发送到 wire 的内容，因此计算 `JSON.stringify(block).length`
 * 是最简单且最准确的选择。它虽是近似值，但足以紧密跟踪请求 body 大小，用于预算闸门和上下文栏。
 */
function calculateMessageBytes(msg: AgentMessage): number {
  const content = (msg as { content?: unknown }).content;
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;
  let total = 0;
  for (const block of content) {
    if (isImageBlock(block)) total += block.data.length;
    else if (isTextBlock(block)) total += block.text.length;
    else if (block && typeof block === "object") {
      try {
        total += JSON.stringify(block).length;
      } catch {
        total += 256;
      }
    }
  }
  return total;
}

export function calculateWireBytes(messages: AgentMessage[]): number {
  let total = 0;
  for (const msg of messages) total += calculateMessageBytes(msg);
  return total;
}

/**
 * {@link calculateWireBytes} 在 token 侧的配套值。文本和结构化块使用 memory pipeline 在其他位置
 * 采用的同一 `ceil(chars / CHARS_PER_TOKEN)` 启发式，但无论 base64 大小如何，图像块都贡献固定的
 * {@link IMAGE_WIRE_TOKEN_ESTIMATE}；provider 的单图像费用有上限，且与 payload 字节数无关。
 * 这是淘汰闸门和上下文窗口用量栏应与 `messageTokens` 比较的值；字节大小安全网由
 * {@link WIRE_BYTE_TRIGGER} 单独处理。
 */
function calculateMessageTokens(msg: AgentMessage): number {
  const content = (msg as { content?: unknown }).content;
  if (typeof content === "string") return Math.ceil(content.length / CHARS_PER_TOKEN);
  if (!Array.isArray(content)) return 0;
  let total = 0;
  for (const block of content) {
    if (isImageBlock(block)) total += IMAGE_WIRE_TOKEN_ESTIMATE;
    else if (isTextBlock(block)) total += Math.ceil(block.text.length / CHARS_PER_TOKEN);
    else if (block && typeof block === "object") {
      try {
        total += Math.ceil(JSON.stringify(block).length / CHARS_PER_TOKEN);
      } catch {
        total += 64;
      }
    }
  }
  return total;
}

export function calculateWireTokens(messages: AgentMessage[]): number {
  let total = 0;
  for (const msg of messages) total += calculateMessageTokens(msg);
  return total;
}

/**
 * 丢弃时间戳早于或等于 eviction horizon 的消息，然后为保留的尾部选择一个 provider 有效的开头。
 *
 * 首选锚点是下一个真正的 `user` 回合：最干净的开头，也是最强的上下文锚点。但长时间的
 * autonomous run（没有用户输入介入的工具循环）可能会留下完全没有 user 回合的 horizon 后尾部。
 * 此时跳到 user 消息会走到末尾并返回空列表——这会耗尽 wire，让 model 永远循环，因为每回合都从
 * durable memory 中以相同方式重新规划，却看不到自己的近期工作（参见 session_rUjMi_pUNzhB）。
 * 当没有 user 回合保留时，回退为将近期尾部锚定到第一条非孤儿消息：只丢弃开头的 `toolResult`，
 * 因为匹配的 tool call 已被淘汰的 tool result 是 provider 拒绝的开头形态。当尾部只有 tool result
 * 时，也保留它们的调用：当最终结果本身超过软预算时，完整交互优先于软预算。
 */
export function applyEvictionHorizon(messages: AgentMessage[], horizon: number): AgentMessage[] {
  if (horizon <= 0) return messages;
  let firstKept = 0;
  while (firstKept < messages.length && messageTimestamp(messages[firstKept]!) <= horizon) {
    firstKept += 1;
  }
  if (firstKept === 0) return messages;

  let userAnchor = firstKept;
  while (userAnchor < messages.length && messages[userAnchor]!.role !== "user") {
    userAnchor += 1;
  }
  if (userAnchor < messages.length) return messages.slice(userAnchor);

  let nonOrphan = firstKept;
  while (nonOrphan < messages.length && messages[nonOrphan]!.role === "toolResult") {
    nonOrphan += 1;
  }
  // 单个大型最终 tool result 可能超过整个预算。即使无法满足软预算，也要保留完整交互：
  // 仅发送 result 会在工作恢复前被 provider 拒绝。
  if (nonOrphan >= messages.length) {
    const resultIds = new Set(
      messages
        .slice(firstKept)
        .flatMap((message) => (message.role === "toolResult" ? [message.toolCallId] : [])),
    );
    for (let index = 0; index < firstKept; index += 1) {
      const message = messages[index]!;
      if (
        message.role === "assistant" &&
        message.content.some((part) => part.type === "toolCall" && resultIds.has(part.id))
      ) {
        return messages.slice(index);
      }
    }
    return [];
  }
  return messages.slice(nonOrphan);
}

/**
 * 从最旧消息开始遍历，依次将 horizon 推过每条消息；当调用方提供的谓词报告两个预算都满足时停止。
 * `canEvict` 可以保护最近的语义单元，例如最近一次完整的工具交互；受保护单元优先于调用方的软预算。
 * 不会裁剪到少于 {@link MIN_HISTORY_TAIL} 条最近消息。返回至少和 `current` 一样前进的 horizon
 *（只前进）。
 *
 * 需要将可淘汰范围保留到持久 memory 的调用方，必须在调用此函数前完成保存——此处推进 horizon
 * 会丢弃只能通过 memory store 读取内容的消息，因此 runner 会在每条到达此遍历的路径上先运行
 * `ensureMemoryCoverageForCompaction`。
 */
export function findEvictionHorizon(
  messages: AgentMessage[],
  current: number,
  satisfiesBudget: (candidate: AgentMessage[]) => boolean,
  canEvict: (message: AgentMessage) => boolean = () => true,
): number {
  if (messages.length <= MIN_HISTORY_TAIL) return current;
  const evictable = messages.slice(0, messages.length - MIN_HISTORY_TAIL);
  let horizon = current;
  for (const msg of evictable) {
    if (!canEvict(msg)) break;
    horizon = Math.max(horizon, messageTimestamp(msg));
    if (satisfiesBudget(applyEvictionHorizon(messages, horizon))) break;
  }
  return horizon;
}
