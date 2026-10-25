import type {
  StateMachineDefinition,
  StateMachineExecutionReceipt,
  StateMachineParkState,
  StateMachinePollState,
  StateMachineProgress,
  StateMachineSession,
  StateMachineSessionEvent,
  StateMachineStateProgress,
  StateMachineState,
  StateMachineTimerState,
} from "../types/state-machine.js";
import { INTERRUPTED_STATE_MACHINE_STATE as INTERRUPTED_STATE } from "../types/state-machine.js";
import type { StateMachineRunnerDecision } from "./tools.js";

/**
 * 保留的 `StateMachineSession.history` 条目的硬上限。长期 relay（poll 循环、follow-up 节奏）
 * 否则可能无限增长，使每个发出的 `state_machine` 事件 payload 和每个持久化 Session 快照
 * 都变得臃肿。上限保留最近的转换——这正是 UI 和 debugger 实际查看的内容——并丢弃最旧的。
 * 开始时的 `state_machine_started` 标记也可能随其他内容一起被淘汰；消费者不得依赖它存在。
 */
export const STATE_MACHINE_HISTORY_LIMIT = 100;

function appendHistory(
  history: StateMachineSessionEvent[],
  ...events: StateMachineSessionEvent[]
): StateMachineSessionEvent[] {
  const combined = [...history, ...events];
  return combined.length > STATE_MACHINE_HISTORY_LIMIT
    ? combined.slice(combined.length - STATE_MACHINE_HISTORY_LIMIT)
    : combined;
}

export function createStateMachineSession(
  prompt: string,
  definition: StateMachineDefinition,
  currentState: string,
): StateMachineSession {
  const now = Date.now();
  return {
    definition,
    prompt,
    currentState,
    history: [{ type: "state_machine_started", timestamp: now }],
    createdAt: now,
    updatedAt: now,
  };
}

export function findState(
  stateMachine: StateMachineSession,
  name: string,
): StateMachineState | undefined {
  return stateMachine.definition.states.find((state) => state.name === name);
}

export type StateMachineScheduledState = StateMachinePollState | StateMachineTimerState;

export function currentScheduledState(
  stateMachine: StateMachineSession | undefined,
): StateMachineScheduledState | undefined {
  const currentState = stateMachine?.currentState;
  if (!stateMachine || !currentState) return undefined;
  const definitionState = findState(stateMachine, currentState);
  return definitionState?.kind === "poll" || definitionState?.kind === "timer"
    ? definitionState
    : undefined;
}

export function isWaitingOnScheduledState(stateMachine: StateMachineSession | undefined): boolean {
  return Boolean(currentScheduledState(stateMachine) && !stateMachine?.terminal);
}

/** 如果 machine 当前保持在不执行工作且没有唤醒的 active inert park，则返回它。 */
export function currentParkState(
  stateMachine: StateMachineSession | undefined,
): StateMachineParkState | undefined {
  if (!stateMachine?.currentState || stateMachine.terminal) return undefined;
  const state = findState(stateMachine, stateMachine.currentState);
  return state?.kind === "park" ? state : undefined;
}

export function recordRunnerDecision(
  stateMachine: StateMachineSession,
  decision: StateMachineRunnerDecision,
): StateMachineSession {
  return {
    ...stateMachine,
    history: appendHistory(stateMachine.history, {
      type: "runner_decided",
      timestamp: Date.now(),
      decision,
    }),
    updatedAt: Date.now(),
  };
}

/**
 * 用合并后的版本替换 active definition 中的一个 state，并记录 state_definition_updated 事件，
 * 使持久化在 Session 历史中可见。调用方应传入已经合并好的 state（通常由
 * `applyStateOverride` 产生）。`definition.states` 数组会以不可变方式重建；对之前 definition
 * 对象的其他引用不受影响。
 */
export function persistStateDefinition(
  stateMachine: StateMachineSession,
  updatedState: StateMachineState,
): StateMachineSession {
  const now = Date.now();
  const states = stateMachine.definition.states.map((state) =>
    state.name === updatedState.name ? updatedState : state,
  );
  return {
    ...stateMachine,
    definition: { ...stateMachine.definition, states },
    history: appendHistory(stateMachine.history, {
      type: "state_definition_updated",
      timestamp: now,
      state: updatedState.name,
      updatedState,
    }),
    updatedAt: now,
  };
}

export function recordStateStarted(
  stateMachine: StateMachineSession,
  state: StateMachineState,
  input?: Record<string, unknown>,
  execution?: StateMachineExecutionReceipt,
): StateMachineSession {
  const now = Date.now();
  const stateMachineWithoutScheduledWake = {
    ...stateMachine,
    progress: clearProgressWakeTimes(stateMachine.progress),
  };
  return {
    ...stateMachine,
    currentState: state.name,
    currentInput: input,
    progress: updateStateProgress(
      stateMachineWithoutScheduledWake,
      state.name,
      state.kind,
      (entry) => ({
        ...entry,
        runs: entry.runs + 1,
        startedAt: now,
      }),
    ),
    history: appendHistory(stateMachine.history, {
      type: "state_started",
      ...(execution ? { execution } : {}),
      timestamp: now,
      state: state.name,
      input,
    }),
    updatedAt: now,
  };
}

export function recordStateCompleted(
  stateMachine: StateMachineSession,
  state: string,
  output: unknown,
): StateMachineSession {
  const now = Date.now();
  const kind = findState(stateMachine, state)?.kind;
  return {
    ...stateMachine,
    progress: updateStateProgress(stateMachine, state, kind, (entry) => ({
      ...entry,
      nextWakeAt: undefined,
    })),
    history: appendHistory(stateMachine.history, {
      type: "state_completed",
      timestamp: now,
      state,
      output,
    }),
    updatedAt: now,
  };
}

export function recordStateSleep(
  stateMachine: StateMachineSession,
  state: StateMachineScheduledState,
  wakeAt: number,
): StateMachineSession {
  const now = Date.now();
  return {
    ...stateMachine,
    progress: updateStateProgress(stateMachine, state.name, state.kind, (entry) => ({
      ...entry,
      sleeps: entry.sleeps + 1,
      nextWakeAt: wakeAt,
    })),
    updatedAt: now,
  };
}

/**
 * 错误配置 poll-gate 启发式的阈值：同一 poll state 在中间没有其他 state 运行时连续成功完成多少次，
 * 才会被视为失控的“始终成功” poll，而不是合法的快速轮询。数值保持较小但大于 1，因此真正
 * 完成一次并再次被选择一次的 poll 不会触发保护。
 */
export const MISCONFIGURED_POLL_GATE_THRESHOLD = 3;

/**
 * 统计指定 poll state 在中间没有运行其他 state 的情况下，已经连续成功完成了多少次。
 *
 * 为什么这种形状能在不产生误报的情况下捕获陷阱：健康的 poll 要么以非成功退出——这会在
 * `progress` 中记录 sleep，而不是在 `history` 中记录 `state_completed`，因此不会增加计数——
 * 要么最终将 machine 推进到另一个 state，其事件会打断连续序列。唯一能累积相同 poll 连续完成的
 * 方式，是一个始终退出 0 的命令（例如 `echo waiting for review`）被重新选择为同一个 gate，
 * 这正是我们要暴露的热循环。回合循环调用此函数时当前正在进行的成功尚未记录，因此返回的计数
 * 只反映之前的完成次数。
 */
export function consecutivePollGateSuccesses(
  stateMachine: StateMachineSession,
  pollName: string,
): number {
  let streak = 0;
  for (let i = stateMachine.history.length - 1; i >= 0; i--) {
    const event = stateMachine.history[i];
    if (event.type === "state_completed") {
      if (event.state !== pollName) break;
      streak++;
      continue;
    }
    // 命名同一 poll 的事件（它自身的选择/运行循环）只是两次完成之间的噪声；命名不同 state 的事件
    // 表明 machine 确实向前移动，因此连续序列结束。
    if (
      (event.type === "state_started" ||
        event.type === "state_failed" ||
        event.type === "state_interrupted" ||
        event.type === "state_definition_updated") &&
      event.state !== pollName
    ) {
      break;
    }
  }
  return streak;
}

/** 只有仍保留且已结束的 execution 才可比较；较旧或尚未开始的工作属于未知。 */
function* settledStateExecutions(
  session: StateMachineSession,
  state: string,
): Generator<{
  execution: StateMachineExecutionReceipt;
  outcome: "completed" | "failed" | "interrupted";
}> {
  let outcome: "completed" | "failed" | "interrupted" | undefined;
  for (let index = session.history.length - 1; index >= 0; index--) {
    const event = session.history[index]!;
    if (event.type === "runner_decided") {
      const decision = event.decision as { state?: unknown } | undefined;
      if (outcome && decision?.state === state && !event.execution) return;
    }
    if (!("state" in event) || event.state !== state) continue;
    if (event.type === "state_completed") outcome ??= "completed";
    if (event.type === "state_failed") outcome ??= "failed";
    if (event.type === "state_interrupted") outcome ??= "interrupted";
    if (event.type === "state_started") {
      if (!event.execution || !outcome) return;
      yield { execution: event.execution, outcome };
      outcome = undefined;
    }
  }
}

/** 比较该 state 最近一次已结束的尝试，绝不使用变更工作之后的过时匹配尝试。 */
export function annotateUnchangedExecution(
  session: StateMachineSession,
  execution: StateMachineExecutionReceipt,
): StateMachineExecutionReceipt {
  const previous = settledStateExecutions(session, execution.state).next().value;
  return previous?.execution.fingerprint === execution.fingerprint
    ? { ...execution, unchangedFrom: { id: previous.execution.id, outcome: previous.outcome } }
    : execution;
}

export const REPEATED_SELECTION_LOOP_THRESHOLD = 3;

/** 当相同的有效 agent/script 工作仍有已结束证据保留时，统计其重复次数。 */
export function repeatedSelectionLoopCount(
  session: StateMachineSession,
  stateName: string,
): number | undefined {
  const kind = findState(session, stateName)?.kind;
  if (kind !== "agent" && kind !== "script") return undefined;
  let fingerprint: string | undefined;
  let count = 0;
  for (const attempt of settledStateExecutions(session, stateName)) {
    fingerprint ??= attempt.execution.fingerprint;
    if (attempt.execution.fingerprint !== fingerprint) break;
    count++;
  }
  return count >= REPEATED_SELECTION_LOOP_THRESHOLD ? count : undefined;
}

export function elapsedSinceStateStarted(
  stateMachine: StateMachineSession | undefined,
  state: string,
): number {
  const startedAt = stateMachine?.progress?.states[state]?.startedAt;
  return startedAt === undefined ? 0 : Math.max(0, Date.now() - startedAt);
}

export function recordStateFailed(
  stateMachine: StateMachineSession,
  state: string,
  error: string,
): StateMachineSession {
  const now = Date.now();
  const terminal = { state, status: "error" as const, reason: error };
  const kind = findState(stateMachine, state)?.kind;
  return {
    ...stateMachine,
    terminal,
    progress: updateStateProgress(stateMachine, state, kind, (entry) => ({
      ...entry,
      nextWakeAt: undefined,
    })),
    history: appendHistory(
      stateMachine.history,
      { type: "state_failed", timestamp: now, state, error },
      { type: "state_machine_completed" as const, timestamp: now, terminal },
    ),
    updatedAt: now,
  };
}

export function recordStateInterrupted(
  stateMachine: StateMachineSession,
  state: string,
  reason?: string,
  output?: { assistantText?: string } | { stdout: string; stderr: string },
): StateMachineSession {
  const now = Date.now();
  const kind = findState(stateMachine, state)?.kind;
  return {
    ...stateMachine,
    currentState: INTERRUPTED_STATE,
    currentInput: undefined,
    progress: updateStateProgress(stateMachine, state, kind, (entry) => ({
      ...entry,
      nextWakeAt: undefined,
    })),
    history: appendHistory(stateMachine.history, {
      type: "state_interrupted" as const,
      timestamp: now,
      state,
      reason,
      output,
    }),
    updatedAt: now,
  };
}

export function recordStateMachineCompleted(
  stateMachine: StateMachineSession,
  terminal: { state: string; status: "completed" | "failed" | "cancelled"; reason?: string },
): StateMachineSession {
  const now = Date.now();
  return {
    ...stateMachine,
    terminal,
    history: appendHistory(stateMachine.history, {
      type: "state_machine_completed" as const,
      timestamp: now,
      terminal,
    }),
    updatedAt: now,
  };
}

/**
 * 清除终态记录，使之前完成的 Session 再次作为活动 Session 运行。只有显式的用户驱动恢复才允许
 * reactivation：当 Session 设置了 `terminal`，且用户要求重做或继续已完成工作时，父 Agent 选择
 * 一个非终态 state。`terminal` 和一次性的 `terminalAcknowledged` 标记都会被丢弃，使该 Session
 * 到达的下一个终态拥有自己的 acknowledgment 回合；之前的结果则保留在
 * `state_machine_reactivated` 事件中，因此 replay 会显示 completed→running 的转换，而不是静默改写。
 */
export function recordStateMachineReactivated(
  stateMachine: StateMachineSession,
  state: string,
): StateMachineSession {
  const priorTerminal = stateMachine.terminal;
  if (!priorTerminal) return stateMachine;
  const now = Date.now();
  return {
    ...stateMachine,
    terminal: undefined,
    terminalAcknowledged: undefined,
    history: appendHistory(stateMachine.history, {
      type: "state_machine_reactivated",
      timestamp: now,
      state,
      priorTerminal,
    }),
    updatedAt: now,
  };
}

function updateStateProgress(
  stateMachine: StateMachineSession,
  state: string,
  kind: StateMachineState["kind"] | undefined,
  update: (entry: StateMachineStateProgress) => StateMachineStateProgress,
): StateMachineProgress {
  const states = stateMachine.progress?.states ?? {};
  const current = normalizeStateProgress(states[state], kind);
  return {
    states: {
      ...states,
      [state]: update(current),
    },
  };
}

function normalizeStateProgress(
  entry: StateMachineStateProgress | undefined,
  kind: StateMachineState["kind"] | undefined,
): StateMachineStateProgress {
  return {
    kind: entry?.kind ?? kind,
    runs: entry?.runs ?? 0,
    sleeps: entry?.sleeps ?? 0,
    nextWakeAt: entry?.nextWakeAt,
    startedAt: entry?.startedAt,
  };
}

function clearProgressWakeTimes(
  progress: StateMachineProgress | undefined,
): StateMachineProgress | undefined {
  if (!progress) return undefined;
  const states: Record<string, StateMachineStateProgress> = {};
  for (const [state, entry] of Object.entries(progress.states)) {
    states[state] = { ...entry, nextWakeAt: undefined };
  }
  return { states };
}

/** 将已构造工作被接受的事实附加到现有决策，而不创建第二条 ledger。 */
export function recordAcceptedExecution(
  session: StateMachineSession,
  execution: StateMachineExecutionReceipt,
): StateMachineSession {
  const history = [...session.history];
  for (let index = history.length - 1; index >= 0; index--) {
    const event = history[index]!;
    if (event.type === "runner_decided") {
      history[index] = { ...event, execution };
      break;
    }
  }
  return { ...session, history };
}
