import type { AgentMessage } from "@earendil-works/pi-agent-core";

export type AgentSessionStatus = "running" | "waiting" | "completed" | "failed" | "cancelled";

/**
 * Agent 模式的可序列化状态。
 *
 * turn 运行时，pi-agent-core 持有进程内活动的 Agent 实例。此类型是 turn runner 层的
 * 快照，终态事件可以返回它，使运行器之上的层能够持久化足够的状态，以便继续后续 turn。
 */
export interface AgentSession {
  status: AgentSessionStatus;
  messages: AgentMessage[];
}
