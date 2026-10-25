import type {
  Observation,
  ObservationKind,
  ObservationPriority,
  ObservationSource,
} from "../types/memory.js";

/**
 * 单条记忆记录的规范 JSON 结构，由所有输出观察记录的命令
 * （`memory recall`、`memory` 查询、`memory add`）共享。集中维护
 * 于一处（见 {@link toMemoryJson}），使使用方在各处解析同一种类型，
 * 而非为每个命令解析一种结构。
 *
 * 与内存中的 {@link Observation} 的差异：
 *   - `createdAt`/`lastUsedAt` 是 ISO 8601 字符串，而非毫秒级纪元时间，
 *     因此传输数据的使用方无需猜测单位。
 *   - `source` 被展平为其 `kind` 字符串；结构化的
 *     `{ kind, name? }` 联合类型仅为运行时细节。
 *   - 两个排名分数都有明确名称（`packScore`、
 *     `relevanceScore`）；有意不提供通用的 `score` 字段。
 */
export interface MemoryJson {
  /** 记录的稳定持久化键。 */
  id: string;
  /** 记忆文本。 */
  content: string;
  /** 原始观察记录、反思、单条用户笔记或批量整理的手工记录。 */
  kind: ObservationKind;
  /** 展平的来源，即结构化 {@link ObservationSource} 的 `kind`。 */
  source: ObservationSource["kind"];
  /** 回忆和上下文排名使用的重要性信号。 */
  priority: ObservationPriority;
  /** 记录存储时间，以 ISO 8601 时间戳表示。 */
  createdAt: string;
  /** 最近使用该记录的回合时间，以 ISO 8601 时间戳表示。 */
  lastUsedAt: string;
  /** 观察记录所锚定的日历日期。 */
  observedDate: string;
  /** 用户/工具提及的具体日期，与 `observedDate` 不同时提供。 */
  referencedDate?: string;
  /** 有用时保留原始相对日期短语（“明天”、“上周”）。 */
  relativeDate?: string;
  /** 若可用，附在观察记录上的 24 小时制本地时间。 */
  timeOfDay?: string;
  /**
   * 创建该记录的会话。早于会话跟踪机制的旧记录/全局记录没有此字段；
   * 仅在观察记录实际携带时回显。
   */
  sessionId?: string;
  /** 用于轻量筛选/分组的标签。 */
  tags: string[];
  /**
   * 全局记忆包的排名分数（新近度 × 优先级 × 类型偏置）。仅在
   * 调用方为该记录计算了记忆包分数时包含。
   */
  packScore?: number;
  /**
   * 查询相关度分数（跨多种表述进行 RRF 融合）。仅在
   * `memory recall` 输出中包含；其他情况下省略，绝不为 null。
   */
  relevanceScore?: number;
}

/**
 * 将 {@link Observation} 序列化为规范的 {@link MemoryJson}
 * 结构。仅在提供时附加可选排名分数，遵循
 * 两个分数均明确命名且缺失时省略、而不输出
 * null 的契约。
 */
export function toMemoryJson(
  observation: Observation,
  opts: { packScore?: number; relevanceScore?: number } = {},
): MemoryJson {
  return {
    id: observation.id,
    content: observation.content,
    kind: observation.kind,
    source: observation.source.kind,
    priority: observation.priority,
    createdAt: new Date(observation.createdAt).toISOString(),
    lastUsedAt: new Date(observation.lastUsedAt).toISOString(),
    observedDate: observation.observedDate,
    ...(observation.referencedDate !== undefined
      ? { referencedDate: observation.referencedDate }
      : {}),
    ...(observation.relativeDate !== undefined ? { relativeDate: observation.relativeDate } : {}),
    ...(observation.timeOfDay !== undefined ? { timeOfDay: observation.timeOfDay } : {}),
    ...(observation.sessionId !== undefined ? { sessionId: observation.sessionId } : {}),
    tags: observation.tags,
    ...(opts.packScore !== undefined ? { packScore: opts.packScore } : {}),
    ...(opts.relevanceScore !== undefined ? { relevanceScore: opts.relevanceScore } : {}),
  };
}
