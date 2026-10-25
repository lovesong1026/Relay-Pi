import type { RuntimeClock } from "../turn-runner/runtime-clock.js";
import { computePendingWork, type PendingWork } from "./quiescence.js";
import type {
  ScopeId,
  TaskDescriptor,
  TaskEvent,
  TaskId,
  TaskSettlement,
  TaskSnapshot,
  TaskStopReason,
} from "./types.js";

const MAX_SCOPE_DEPTH = 2;

/** 进程内任务执行器可用的运行时钩子。 */
export interface TaskExecutionContext {
  /** 在此执行器启动前分配的稳定标识。 */
  taskId: TaskId;
  /** 由 task_stop、中断或作用域关闭恰好中止一次。 */
  signal: AbortSignal;
  /** 将有序块追加到任务保留的输出中。 */
  onOutput(chunk: string): void;
  /** 对中止结果分类时读取调用方的原因。 */
  stopReason(): TaskStopReason | undefined;
}

interface TaskOwnership {
  /** 拥有任务并负责关闭任务的作用域。 */
  ownerScopeId: ScopeId;
  /** 新遇到的作用域的父作用域；仅根作用域省略。 */
  parentScopeId?: ScopeId;
}

/** 立即开始执行的工作规范。 */
export interface InProcessTaskSpec<T = unknown> extends TaskOwnership {
  /** 选择用于列表和下游展示的执行器类别。 */
  kind: "tool" | "subagent";
  /** 操作的稳定机器可读名称。 */
  name: string;
  /** 此次调用的面向用户描述。 */
  label: string;
  /** 运行任务；拒绝会被观察并转换为失败结算。 */
  execute(context: TaskExecutionContext): Promise<T>;
}

/** 无进程内执行器的持久化实际时间工作规范。 */
export interface ScheduledTaskSpec extends TaskOwnership {
  /** 将任务标记为持久化实际时间工作，而非活动进程。 */
  kind: "scheduled";
  /** 定时操作的稳定机器可读名称。 */
  name: string;
  /** 将要恢复的内容的面向用户描述。 */
  label: string;
  /** 静止状态决策器使用的 Unix 纪元时间戳。 */
  wakeAt: number;
}

export type TaskSpec<T = unknown> = InProcessTaskSpec<T> | ScheduledTaskSpec;

/** 不透明的启动结果，用于仅对选定前台交付的任务进行竞速。 */
export interface TaskHandle {
  readonly id: TaskId;
}

export type ForegroundRaceResult =
  | { kind: "settled"; settlement: TaskSettlement }
  | { kind: "still_running"; task: TaskSnapshot };

export type TaskReaper = (reason: TaskStopReason) => void | Promise<void>;

export interface TaskManagerOptions {
  /** 注入的时间与定时器所有者，允许无需实际休眠即可执行生命周期竞速。 */
  clock: RuntimeClock;
  /** 接收有序生命周期变化，但不拥有结算交付。 */
  onEvent?: (event: TaskEvent) => void;
}

export interface RecoverResult {
  /** 先前运行中但无法存在于本进程、已标记为 lost 的任务。 */
  lost: readonly TaskDescriptor[];
}

export interface TaskManager {
  /** 在工作开始前注册子作用域，以便在执行器边界拒绝超出深度限制的情况。 */
  openScope(scopeId: ScopeId, parentScopeId?: ScopeId): void;
  /** 分配 id，并创建进程内工作或记录计划。 */
  start<T>(spec: TaskSpec<T>): TaskHandle;
  /** 在前台预算内等待，到期时不中止任务。 */
  raceForeground(handle: TaskHandle, budgetMs: number): Promise<ForegroundRaceResult>;
  /** 返回描述符副本，可选地限制为其确切所属作用域。 */
  list(scopeId?: string): readonly TaskDescriptor[];
  /** 检查保留的输出和终止值，不消费结算交付。 */
  output(id: TaskId): TaskSnapshot | undefined;
  /** 观察某个任务或下一个任务结算，可选地以时钟驱动的等待限制时长。 */
  waitForSettlement(id?: TaskId, waitMs?: number): Promise<TaskSnapshot | undefined>;
  /** 取出最早的未交付结算；这是唯一会消费结算的操作。 */
  nextSettled(): TaskSettlement | undefined;
  /** 中止任务一次，仅在其执行器完全退出后才解析。 */
  stop(id: TaskId, reason: TaskStopReason): Promise<TaskSnapshot | undefined>;
  /** 先停止后代作用域，再停止直接拥有的任务，并等待每次退出完成。 */
  closeScope(scopeId: ScopeId, reason: TaskStopReason): Promise<void>;
  /** 中止所有活动和定时工作，回收进程，并等待完全退出。 */
  interruptAll(reason: TaskStopReason): Promise<void>;
  /** 根据任务描述符计算当前静止状态。 */
  pendingWork(): PendingWork;
  /** 加载描述符，将依赖旧进程的运行中工作转换为 lost 结算。 */
  recover(
    descriptors: readonly TaskDescriptor[],
    nextTaskId?: number,
    outputTails?: Readonly<Partial<Record<TaskId, readonly string[]>>>,
  ): RecoverResult;
  /** 返回下次 start() 调用将分配的数字后缀。 */
  nextTaskId(): number;
  /** 注册在下次回收边界执行一次的进程清理。 */
  registerReaper(reaper: TaskReaper): () => void;
  /** 调用并清空当前注册的所有进程清理回调。 */
  reapAll(reason: TaskStopReason): Promise<void>;
}

interface TaskRecord {
  descriptor: TaskDescriptor;
  readonly output: string[];
  readonly abortController?: AbortController;
  stopReason?: TaskStopReason;
  settlement?: TaskSettlement;
  readonly finished: Promise<TaskSettlement>;
  resolveFinished(settlement: TaskSettlement): void;
}

interface ScopeRecord {
  readonly id: string;
  readonly parentScopeId?: ScopeId;
  readonly depth: number;
  closed: boolean;
}

/** 创建任务生命周期和结算交付的唯一所有者。 */
export function createTaskManager(options: TaskManagerOptions): TaskManager {
  const records = new Map<TaskId, TaskRecord>();
  const scopes = new Map<string, ScopeRecord>();
  const settlements: TaskSettlement[] = [];
  const settlementWaiters = new Set<(settlement: TaskSettlement) => void>();
  const reapers = new Set<TaskReaper>();
  let nextTaskNumber = 1;

  const copyDescriptor = (descriptor: TaskDescriptor): TaskDescriptor => ({ ...descriptor });
  const snapshot = (record: TaskRecord): TaskSnapshot => ({
    descriptor: copyDescriptor(record.descriptor),
    output: [...record.output],
    ...(record.settlement ? { settlement: record.settlement } : {}),
  });

  const emit = (event: TaskEvent): void => options.onEvent?.(event);

  const registerScope = (ownerScopeId: ScopeId, parentScopeId?: ScopeId): ScopeRecord => {
    const existing = scopes.get(ownerScopeId);
    if (existing) {
      if (existing.parentScopeId !== parentScopeId && parentScopeId !== undefined) {
        throw new Error(`Scope ${ownerScopeId} already has a different parent`);
      }
      if (existing.closed) throw new Error(`Scope ${ownerScopeId} is closed`);
      return existing;
    }

    let depth = 0;
    if (parentScopeId !== undefined) {
      const parent = scopes.get(parentScopeId);
      if (!parent) throw new Error(`Parent scope ${parentScopeId} must be registered first`);
      if (parent.closed) throw new Error(`Parent scope ${parentScopeId} is closed`);
      depth = parent.depth + 1;
    }
    if (depth > MAX_SCOPE_DEPTH) {
      throw new RangeError(`Task scope depth ${depth} exceeds maximum ${MAX_SCOPE_DEPTH}`);
    }

    const scope: ScopeRecord = {
      id: ownerScopeId,
      ...(parentScopeId === undefined ? {} : { parentScopeId }),
      depth,
      closed: false,
    };
    scopes.set(ownerScopeId, scope);
    return scope;
  };

  const createRecord = (
    descriptor: TaskDescriptor,
    abortController?: AbortController,
  ): TaskRecord => {
    let resolveFinished!: (settlement: TaskSettlement) => void;
    const finished = new Promise<TaskSettlement>((resolve) => {
      resolveFinished = resolve;
    });
    return {
      descriptor,
      output: [],
      ...(abortController ? { abortController } : {}),
      finished,
      resolveFinished,
    };
  };

  const settle = (record: TaskRecord, settlement: TaskSettlement): TaskSettlement => {
    if (record.settlement) return record.settlement;
    record.settlement = settlement;
    record.descriptor = { ...record.descriptor, status: settlement.status };
    settlements.push(settlement);
    record.resolveFinished(settlement);
    emit({ type: "settled", settlement });
    for (const notify of settlementWaiters) notify(settlement);
    return settlement;
  };

  const manager: TaskManager = {
    openScope(scopeId, parentScopeId) {
      registerScope(scopeId, parentScopeId);
    },

    start<T>(spec: TaskSpec<T>): TaskHandle {
      if (spec.kind === "scheduled" && !Number.isFinite(spec.wakeAt)) {
        throw new RangeError("wakeAt must be a finite Unix-epoch timestamp");
      }
      registerScope(spec.ownerScopeId, spec.parentScopeId);
      const id = `t${nextTaskNumber++}` as TaskId;
      const descriptor: TaskDescriptor = {
        id,
        kind: spec.kind,
        name: spec.name,
        label: spec.label,
        ownerScopeId: spec.ownerScopeId,
        status: spec.kind === "scheduled" ? "scheduled" : "running",
        startedAt: options.clock.now(),
        ...(spec.kind === "scheduled" ? { wakeAt: spec.wakeAt } : {}),
      };

      if (spec.kind === "scheduled") {
        const record = createRecord(descriptor);
        records.set(id, record);
        emit({ type: "started", descriptor: copyDescriptor(descriptor) });
        return { id };
      }

      const abortController = new AbortController();
      const record = createRecord(descriptor, abortController);
      records.set(id, record);
      emit({ type: "started", descriptor: copyDescriptor(descriptor) });

      const execution = Promise.resolve().then(() =>
        spec.execute({
          taskId: id,
          signal: abortController.signal,
          onOutput(chunk) {
            if (record.settlement) return;
            record.output.push(chunk);
            emit({ type: "output", id, chunk });
          },
          stopReason: () => record.stopReason,
        }),
      );

      // 同步附加两个分支：创建执行器时始终观察其拒绝。
      void execution.then(
        (result) => {
          if (record.stopReason !== undefined) {
            settle(record, {
              id,
              status: "stopped",
              settledAt: options.clock.now(),
              reason: record.stopReason,
            });
            return;
          }
          settle(record, { id, status: "completed", settledAt: options.clock.now(), result });
        },
        (error: unknown) => {
          if (record.stopReason !== undefined) {
            settle(record, {
              id,
              status: "stopped",
              settledAt: options.clock.now(),
              reason: record.stopReason,
            });
            return;
          }
          settle(record, { id, status: "failed", settledAt: options.clock.now(), error });
        },
      );
      return { id };
    },

    async raceForeground(handle, budgetMs) {
      if (!Number.isFinite(budgetMs) || budgetMs < 0) {
        throw new RangeError("budgetMs must be a finite non-negative number");
      }
      const record = records.get(handle.id);
      if (!record) throw new Error(`Unknown task ${handle.id}`);
      if (record.settlement) return { kind: "settled", settlement: record.settlement };

      let cancelBudget = (): void => undefined;
      const budgetElapsed = new Promise<void>((resolve) => {
        cancelBudget = options.clock.schedule(resolve, budgetMs);
      });
      await Promise.race([record.finished, budgetElapsed]);
      cancelBudget();

      // 恰好在截止时间排队的完成结果在这场同时到达的竞速中获胜。
      await Promise.resolve();
      if (record.settlement) return { kind: "settled", settlement: record.settlement };
      return { kind: "still_running", task: snapshot(record) };
    },

    list(scopeId) {
      return [...records.values()]
        .filter((record) => scopeId === undefined || record.descriptor.ownerScopeId === scopeId)
        .map((record) => copyDescriptor(record.descriptor));
    },

    output(id) {
      const record = records.get(id);
      return record ? snapshot(record) : undefined;
    },

    async waitForSettlement(id, waitMs) {
      if (waitMs !== undefined && (!Number.isFinite(waitMs) || waitMs < 0)) {
        throw new RangeError("waitMs must be a finite non-negative number");
      }
      const record = id === undefined ? undefined : records.get(id);
      if (id !== undefined && !record) return undefined;
      if (record?.settlement) return snapshot(record);
      if (id === undefined && settlements.length > 0) {
        return snapshot(records.get(settlements[0]!.id)!);
      }

      const notify = (settlement: TaskSettlement): void => {
        if (id === undefined || settlement.id === id) {
          settlementWaiters.delete(notify);
          resolveObserved(settlement);
        }
      };
      let resolveObserved!: (settlement: TaskSettlement) => void;
      const observed = new Promise<TaskSettlement>((resolve) => {
        resolveObserved = resolve;
        settlementWaiters.add(notify);
      });
      if (waitMs === undefined) {
        const settlement = await observed;
        return snapshot(records.get(settlement.id)!);
      }

      let cancelWait = (): void => undefined;
      const elapsed = new Promise<undefined>((resolve) => {
        cancelWait = options.clock.schedule(() => resolve(undefined), waitMs);
      });
      const settlement = await Promise.race([observed, elapsed]);
      cancelWait();
      settlementWaiters.delete(notify);
      return settlement ? snapshot(records.get(settlement.id)!) : undefined;
    },

    nextSettled() {
      return settlements.shift();
    },

    async stop(id, reason) {
      const record = records.get(id);
      if (!record) return undefined;
      if (record.settlement || isTerminal(record.descriptor)) return snapshot(record);
      record.stopReason ??= reason;
      if (record.abortController) {
        record.abortController.abort(reason);
        await record.finished;
      } else {
        settle(record, { id, status: "stopped", settledAt: options.clock.now(), reason });
      }
      return snapshot(record);
    },

    async closeScope(scopeId, reason) {
      const scope = scopes.get(scopeId);
      if (!scope || scope.closed) return;
      const descendants = [...scopes.values()]
        .filter((candidate) => isDescendantOf(candidate, scopeId, scopes))
        .sort((left, right) => right.depth - left.depth);

      for (const descendant of descendants) {
        const owned = [...records.values()].filter(
          (record) =>
            record.descriptor.ownerScopeId === descendant.id && !isTerminal(record.descriptor),
        );
        await Promise.all(owned.map((record) => manager.stop(record.descriptor.id, reason)));
        descendant.closed = true;
      }
      const directlyOwned = [...records.values()].filter(
        (record) => record.descriptor.ownerScopeId === scopeId && !isTerminal(record.descriptor),
      );
      await Promise.all(directlyOwned.map((record) => manager.stop(record.descriptor.id, reason)));
      scope.closed = true;
    },

    async interruptAll(reason) {
      const pending = [...records.values()].filter((record) => !isTerminal(record.descriptor));
      const barriers = pending.map((record) => manager.stop(record.descriptor.id, reason));
      await manager.reapAll(reason);
      await Promise.all(barriers);
    },

    pendingWork() {
      return computePendingWork(manager.list());
    },

    recover(descriptors, persistedNextTaskId, outputTails) {
      const lost: TaskDescriptor[] = [];
      for (const source of descriptors) {
        if (records.has(source.id)) throw new Error(`Duplicate recovered task ${source.id}`);
        const match = /^t(\d+)$/.exec(source.id);
        if (!match) throw new Error(`Invalid task id ${source.id}`);
        nextTaskNumber = Math.max(nextTaskNumber, Number(match[1]) + 1);
        registerScope(source.ownerScopeId);

        const descriptor = copyDescriptor(source);
        const record = createRecord(descriptor);
        record.output.push(...(outputTails?.[descriptor.id] ?? []));
        records.set(descriptor.id, record);
        if (
          descriptor.status === "running" ||
          (descriptor.status === "scheduled" && !Number.isFinite(descriptor.wakeAt))
        ) {
          descriptor.status = "lost";
          lost.push(copyDescriptor(descriptor));
          settle(record, {
            id: descriptor.id,
            status: "lost",
            settledAt: options.clock.now(),
          });
        }
      }
      if (persistedNextTaskId !== undefined) {
        if (!Number.isInteger(persistedNextTaskId) || persistedNextTaskId < 1) {
          throw new RangeError("nextTaskId must be a positive integer");
        }
        nextTaskNumber = Math.max(nextTaskNumber, persistedNextTaskId);
      }
      return { lost };
    },

    nextTaskId() {
      return nextTaskNumber;
    },

    registerReaper(reaper) {
      reapers.add(reaper);
      return () => reapers.delete(reaper);
    },

    async reapAll(reason) {
      const active = [...reapers];
      reapers.clear();
      await Promise.all(active.map((reaper) => reaper(reason)));
    },
  };

  return manager;
}

function isDescendantOf(
  candidate: ScopeRecord,
  ancestorId: string,
  scopes: ReadonlyMap<string, ScopeRecord>,
): boolean {
  let parentScopeId = candidate.parentScopeId;
  while (parentScopeId !== undefined) {
    if (parentScopeId === ancestorId) return true;
    parentScopeId = scopes.get(parentScopeId)?.parentScopeId;
  }
  return false;
}

function isTerminal(descriptor: TaskDescriptor): boolean {
  return !["running", "scheduled"].includes(descriptor.status);
}
