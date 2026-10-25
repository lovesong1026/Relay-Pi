/**
 * 检测上游/传输层的瞬态错误，并应用本地重试策略。
 *
 * pi-agent 会将 provider 失败表现为最后一条 assistant 消息，其
 * `stopReason: "error"` 且包含 `errorMessage` 字符串。大多数失败形态是终态
 * （鉴权、错误请求、找不到 model、拒绝）。其中一部分——gateway 5xx 响应、瞬态传输
 * 中断、websocket 关闭、Anthropic 的 "overloaded" 标记、重试等待耗尽——应该在本地重试：
 * 它们通常第二次就能成功，否则一次短暂的 proxy 抖动就会使长时间运行的 state machine
 * state 失败。
 *
 * ## 为什么使用本地 helper，而不是 pi 内置的重试？
 *
 * pi monorepo 已经在
 * `@earendil-works/pi-coding-agent` 的 `AgentSession` 中提供重试循环（参见
 * `node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js` 中的
 * `_isRetryableError` 和 `_handleRetryableError`）。它会弹出失败的 assistant 消息，使用
 * 指数退避等待，调用 `agent.continue()`，并发出 `auto_retry_start`/`auto_retry_end` 事件。
 *
 * TurnRunner 有意直接驱动 `Agent`，而不是经过 `AgentSession`，这样它可以拥有回合语义
 * （steer 队列、state machine 路由、父 Agent 与子 Agent transcript、memory transform、
 * wire-shaping）。这意味着 `AgentSession` 的重试路径不适用于我们。此模块刻意镜像
 * `AgentSession` 的检测正则（使用相同的 context-overflow 排除规则），使调用方无论使用
 * pi-coding-agent 还是 relay-pi，瞬态失败都能一致重试。覆盖的模式包括：
 *
 * - HTTP 429/500/502/503/504，可带或不带 "status code (no body)" 前缀。
 * - Anthropic 的 "overloaded" 标记和通用的 "provider returned error" 包装。
 * - 传输/socket 失败：`fetch failed`、`socket hang up`、`ECONN*`、`ETIMEDOUT`、
 *   `EAI_AGAIN`、`EPIPE`、"connection lost"。
 * - HTTP/2 和 websocket 抖动："websocket closed"、"other side closed"、
 *   "reset before headers"、"http2 request did not get a response"、
 *   "ended without sending chunks"、"terminated"。
 * - 流式传输截断："stream ended"（涵盖 Anthropic 的
 *   `Anthropic stream ended before message_stop`；当 SSE 流在没有终止的 `message_stop`
 *   事件时关闭，pi-ai 会抛出该错误——这是可以干净重试的瞬态传输失败）。
 * - 超时："request timed out"、通用的 "timeout"、"retry delay"（pi-ai 在超过
 *   `maxRetryDelayMs` 时发出的标记，以便更高层逻辑接管）。
 *
 * 除了镜像上述规则外，此模块还会重试没有归因原因的 provider 失败——参见
 * `UNATTRIBUTED_PROVIDER_FAILURE_PATTERN`。
 *
 * context-overflow 错误由 `tryRecoverFromContextOverflow` 处理，因此在此有意跳过。
 * 不重试客户端错误（除 429 外的 4xx），因为使用相同 payload 重试不会改变结果。
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";

/**
 * 组合的瞬态错误模式。保持在一个正则中，以镜像 pi-coding-agent 的
 * `_isRetryableError`，使 pi 生态中的两个重试位置保持一致。
 */
const TRANSIENT_PATTERN =
  /overloaded|provider.?returned.?error|rate.?limit|too many requests|429|500|502|503|504|service.?unavailable|server.?error|internal.?error|network.?error|connection.?error|connection.?refused|connection.?lost|websocket.?closed|websocket.?error|other side closed|fetch failed|upstream.?connect|reset before headers|socket hang up|ended without|stream ended|http2 request did not get a response|timed? out|timeout|terminated|retry delay|\bECONN(?:RESET|REFUSED|ABORTED)\b|\bETIMEDOUT\b|\bEPIPE\b|\bEAI_AGAIN\b/i;

/**
 * 即使 `TRANSIENT_PATTERN` 匹配，也要排除的模式。这些是客户端失败，其 payload 在重试时
 * 会以相同方式失败。除 429 外的 4xx code 会在此阻止；429 则有意重试，因为 server 要求
 * 调用方退避后再次尝试。
 */
const NON_RETRYABLE_PATTERN =
  /\b(?:400|401|402|403|404|405|406|407|408|410|411|412|413|414|415|416|417|418|421|422|423|424|425|426|428|431|451)\b|\bunauthorized\b|\bforbidden\b|\bnot found\b/i;

/**
 * 一个未归因原因的 provider 流失败。
 *
 * pi-ai 的 `response.failed` handler 在 provider 没有发送 code 时，会将失败渲染为
 * `${error.code || "unknown"}: ${error.message}`；而完全没有 error 对象时，则渲染为
 * `Unknown error (no error details in response)`——OpenRouter 透传是两者的常见来源。这正是
 * 瞬态上游抖动在响应中途发生时的形态，因此应再尝试一次：否则一次通常下个调用就会消失的
 * 抖动会丢掉整个回合的工作。
 *
 * 有意锚定在消息开头。任意位置的裸 `unknown` 还会匹配 "unknown model" 或 "unknown parameter"
 * 等真正的终态失败；无论运行多少次，它们都会以相同方式失败。仍会先检查
 * `NON_RETRYABLE_PATTERN`，因此包裹 4xx 的无归因错误仍保持终态。
 *
 * 它与 `TRANSIENT_PATTERN` 分开，因为后者镜像 pi-coding-agent；这个规则属于我们自己。
 */
const UNATTRIBUTED_PROVIDER_FAILURE_PATTERN = /^unknown:|^unknown error \(no error details/i;

/**
 * 当 `errorMessage` 看起来像另一次尝试可能解决的瞬态 gateway/传输失败时返回 true。
 * 客户端错误，以及任何不能明确表明 server 端故障的消息，返回 false。
 */
export function isTransientServerError(errorMessage: string | undefined): boolean {
  if (!errorMessage) return false;
  if (NON_RETRYABLE_PATTERN.test(errorMessage)) return false;
  return (
    TRANSIENT_PATTERN.test(errorMessage) || UNATTRIBUTED_PROVIDER_FAILURE_PATTERN.test(errorMessage)
  );
}

/**
 * 当 `messages` 的最后一条 assistant 消息是瞬态错误，且恢复逻辑可以弹出它并通过
 * `agent.continue()` 重试时返回 true。
 */
export function lastMessageIsTransientFailure(messages: AgentMessage[]): boolean {
  const last = messages[messages.length - 1];
  if (!last || last.role !== "assistant") return false;
  if (last.stopReason !== "error") return false;
  return isTransientServerError(last.errorMessage);
}

/**
 * 同时应用于父 Agent 和 state machine 子 Agent 的重试策略。
 *
 * - `maxAttempts` 统计 prompt+continue 的总尝试次数，因此 `3` 表示初始 prompt 加最多两次重试。
 * - `baseDelayMs` 是第一次重试的延迟；后续重试会将其加倍（带 jitter），上限为 `maxDelayMs`。
 *
 * 默认值镜像 `AgentSession` 的默认值（3 次重试、2s 基础延迟），使 pi 生态中的两个重试位置保持同步。
 */
export interface TransientRetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_TRANSIENT_RETRY_POLICY: TransientRetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 2_000,
  maxDelayMs: 30_000,
};

export function transientRetryDelayMs(
  attempt: number,
  policy: TransientRetryPolicy = DEFAULT_TRANSIENT_RETRY_POLICY,
): number {
  const exponential = policy.baseDelayMs * 2 ** Math.max(0, attempt - 1);
  const capped = Math.min(exponential, policy.maxDelayMs);
  const jitter = capped * 0.25 * Math.random();
  return Math.round(capped + jitter);
}
