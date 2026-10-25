/** 在 TaskManager 内单调分配的稳定任务标识。 */
export type TaskId = `t${number}`;

/** 负责任务的执行界面。 */
export type TaskKind = "tool" | "subagent" | "scheduled";

/**
 * 结构化并发所有者：回合的根作用域，或已创建子 agent 的
 * 子作用域。通过类型约束，防止随意的自由格式 id 悄然脱离
 * 级联树。
 */
export type ScopeId = `turn-${number}` | `task:${TaskId}`;

/**
 * 持久化生命周期状态。
 *
 * `running` 表示进程内执行器仍保持回合开放，
 * 进程必须保持唤醒。`scheduled` 是持久化的实际时间工作：它
 * 不使进程保持唤醒，并于 `wakeAt` 恢复。其他所有状态
 * 均为终止状态。`stopped` 记录显式 task_stop、中断或作用域关闭
 * 请求；`lost` 记录在先前进程中仍在运行的工作，
 * 因而在状态加载后无法恢复。
 */
export type TaskStatus = "running" | "scheduled" | "completed" | "failed" | "stopped" | "lost";

/** 调用方提供的解释，供执行器对中止进行分类。 */
export type TaskStopReason = string;

/** 运行时、持久化、协议和 UI 代码共用的可序列化任务结构。 */
export interface TaskDescriptor {
  /** 管理器生成的单调标识，跨恢复过程也保持单调。 */
  id: TaskId;
  /** 选择任务是进程内工作还是持久化的定时等待。 */
  kind: TaskKind;
  /** 用于日志和任务列表的稳定机器可读名称。 */
  name: string;
  /** 描述正在进行的具体工作、面向用户的文本。 */
  label: string;
  /** 拥有此任务，并在关闭时级联停止此任务的作用域。 */
  ownerScopeId: ScopeId;
  /** 当前生命周期状态；终止状态不会再次转换。 */
  status: TaskStatus;
  /** 任务创建时记录的 Unix 纪元时间戳。 */
  startedAt: number;
  /** Unix 纪元唤醒时间，仅定时任务具有此值。 */
  wakeAt?: number;
}

/** 恰好发出一次、按结算时间排队的终止值。 */
export type TaskSettlement =
  | { id: TaskId; status: "completed"; settledAt: number; result: unknown }
  | { id: TaskId; status: "failed"; settledAt: number; error: unknown }
  | { id: TaskId; status: "stopped"; settledAt: number; reason: TaskStopReason }
  | { id: TaskId; status: "lost"; settledAt: number };

/** 可观察的任务状态，包含缓冲值而非派生计数。 */
export interface TaskSnapshot {
  /** 检查时的持久化描述符副本。 */
  descriptor: TaskDescriptor;
  /** 保留的有序输出块，供后续 task_output 检查。 */
  output: readonly string[];
  /** 任务结算后的终止值。 */
  settlement?: TaskSettlement;
}

/** 每次外部可观察的任务变化后同步发出的事件。 */
export type TaskEvent =
  | { type: "started"; descriptor: TaskDescriptor }
  | { type: "output"; id: TaskId; chunk: string }
  | { type: "settled"; settlement: TaskSettlement };
