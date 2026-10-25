import { Buffer } from "node:buffer";
import { basename } from "node:path";

/** 已建立的 Train API 上限，应用于 UTF-8 body 字节数。 */
export const MAX_TRAIN_RECORD_CONTENT_BYTES = 10 * 1024 * 1024;

/** memory 文件的角色：synthesized training 或直接精选的 note。 */
export type MemoryKind = "train" | "note";

/** 为向前兼容保留的未知 frontmatter key 的标量值。 */
export type MemoryFrontmatterValue = string | number | string[];

/** 一个 markdown memory 文件的类型化内容，不包含由文件名负责的 slug。 */
export interface MemoryFileRecord {
  /** 字节格式版本。目前只理解版本 1。 */
  version: 1;
  /** 与 API 和私有 archive metadata 共享的稳定 record identity。 */
  id: string;
  /** 内容来自 training synthesis，还是直接精选的 note。 */
  kind: MemoryKind;
  /** 用于推导 observed date 和从新到旧排序的 Unix epoch 毫秒数。 */
  createdAt: number;
  /** 精选内容的简短展示标签。 */
  headline?: string;
  /** 生成 synthesized 内容的 model 标识（适用时存在）。 */
  model?: string;
  /** synthesized 内容表示的 source 文件数。 */
  fileCount?: number;
  /** 私有 archive manifest 标识；绝不是绝对 archive 路径。 */
  archiveId?: string;
  /** memory-context selection 使用的排序提示。 */
  priority?: string;
  /** 将文件投影为 observational-memory shape 时使用的 origin 标签。 */
  source?: string;
  /** 附加到 record 的搜索和 provenance 标签。 */
  tags?: string[];
  /**
   * 按字节稳定保留未知 scalar key，使较新的 writer 可以添加 metadata，而较旧的 reader 在
   * 只更新内容时不会静默删除它。
   */
  extra?: Record<string, MemoryFrontmatterValue>;
  /** closing frontmatter delimiter 之后的精确精选 markdown。 */
  content: string;
}

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
// Identifier 会成为私有 archive 根目录下的路径片段，因此绝不能通过（`..`、分隔符）
// traversal 离开根目录。nanoid 的 alphabet 加上 `mem_` 前缀始终满足此条件。
const ID_SEGMENT_PATTERN = /^[A-Za-z0-9_-]+$/;
const KEY_PATTERN = /^[A-Za-z][A-Za-z0-9]*$/;
const NUMBER_PATTERN = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;
const KNOWN_KEYS = new Set([
  "version",
  "id",
  "kind",
  "createdAt",
  "headline",
  "model",
  "fileCount",
  "archiveId",
  "priority",
  "source",
  "tags",
]);
// Line ending 是字节格式状态，而不是 record metadata。将它保留在已解析对象上，可以在不向
// 调用方暴露格式字段的情况下保留 CRLF。
const parsedLineEndings = new WeakMap<MemoryFileRecord, "\n" | "\r\n">();

/**
 * reader 可为没有 frontmatter identity 的文件提供的 identity——store 从文件自身派生它
 *（见 `readEntry`）。每个字段只会在对应 frontmatter key 缺失时使用。
 */
export interface DerivedMemoryIdentity {
  /** 当 header 没有 `id` 时要采用的 record id。由于 id 会命名私有 archive 目录，必须满足安全路径片段规则（`[A-Za-z0-9_-]+`）；store 的派生值（`mem_` + digest）始终满足。 */
  id: string;
  /**
   * 当 header 没有 `createdAt` 时要采用的 Unix epoch 毫秒数；它决定从新到旧排序和 observed
   * date，因此 store 会传入文件自身的创建时间。
   */
  createdAt: number;
}

/**
 * 解析 memory 文件的 frontmatter。
 *
 * 输入时 grammar 刻意宽松，输出时严格：Agent 经常手写这些文件，也会通过
 * `relay-pi memory add` 写入，因此可以读取普通 YAML scalar（`kind: note`）、单引号或双
 * 引号、由普通 item 组成的 inline array、空行和 `#` 行，以及任意 key 顺序。`version` 默认
 * 为 1，`kind` 默认是 `note`；如果调用方可以从文件自身命名它们，`id` 和 `createdAt` 会
 * 回退到 `derived`。序列化始终输出唯一 canonical 形式，因此重写文件时无需宽松处理。
 */
export function parseMemoryFile(
  text: string,
  options: { derived?: DerivedMemoryIdentity } = {},
): MemoryFileRecord {
  const lineEnding = text.startsWith("---\r\n")
    ? "\r\n"
    : text.startsWith("---\n")
      ? "\n"
      : undefined;
  if (!lineEnding) throw new Error("Memory file must start with a frontmatter delimiter");

  const closingDelimiter = `${lineEnding}---${lineEnding}`;
  const closingIndex = text.indexOf(closingDelimiter, 3 + lineEnding.length);
  if (closingIndex === -1) throw new Error("Memory file is missing its closing delimiter");

  const header = text.slice(3 + lineEnding.length, closingIndex);
  const content = text.slice(closingIndex + closingDelimiter.length);
  assertContent(content);

  const values = new Map<string, MemoryFrontmatterValue>();
  const seenKeys = new Set<string>();
  for (const line of header.split(lineEnding)) {
    if (line.trim().length === 0 || line.trimStart().startsWith("#")) continue;
    const match = /^([^:]+):(?:\s+(.*))?$/.exec(line);
    if (!match) throw new Error(`Invalid frontmatter line: ${line}`);
    const key = match[1]!.trim();
    const rawValue = (match[2] ?? "").trim();
    if (!KEY_PATTERN.test(key)) throw new Error(`Invalid frontmatter key: ${key}`);
    if (seenKeys.has(key)) throw new Error(`Duplicate frontmatter key: ${key}`);
    seenKeys.add(key);
    if (key === "sourceFolder") {
      throw new Error("sourceFolder is private archive metadata and cannot enter a memory file");
    }
    if (rawValue.length === 0) continue;
    values.set(key, parseScalar(rawValue));
  }

  const version = optionalNumber(values, "version") ?? 1;
  if (version !== 1) throw new Error(`Unsupported memory file version: ${version}`);
  const kind = optionalString(values, "kind") ?? "note";
  if (kind !== "train" && kind !== "note") throw new Error(`Invalid memory kind: ${kind}`);

  const id = values.has("id") ? requireIdSegment(values, "id") : options.derived?.id;
  if (id === undefined) throw new Error("Frontmatter id is required");
  const createdAt = optionalNumber(values, "createdAt") ?? options.derived?.createdAt;
  if (createdAt === undefined) throw new Error("Frontmatter createdAt is required");
  if (!Number.isSafeInteger(createdAt) || createdAt < 0) {
    throw new Error("createdAt must be a non-negative integer");
  }
  const fileCount = optionalNumber(values, "fileCount");
  if (fileCount !== undefined && (!Number.isSafeInteger(fileCount) || fileCount < 0)) {
    throw new Error("fileCount must be a non-negative integer");
  }

  const record: MemoryFileRecord = {
    version: 1,
    id,
    kind,
    createdAt,
    ...optionalStringProperty(values, "headline"),
    ...optionalStringProperty(values, "model"),
    ...(fileCount === undefined ? {} : { fileCount }),
    ...optionalIdSegmentProperty(values, "archiveId"),
    ...optionalStringProperty(values, "priority"),
    ...optionalStringProperty(values, "source"),
    ...optionalStringArrayProperty(values, "tags"),
    ...extraProperties(values),
    content,
  };
  parsedLineEndings.set(record, lineEnding);
  return record;
}

/** 将 memory record 序列化为唯一的 canonical 字节表示。 */
export function serializeMemoryFile(record: MemoryFileRecord): string {
  validateRecord(record);
  const lineEnding = parsedLineEndings.get(record) ?? "\n";
  const fields: Array<[string, MemoryFrontmatterValue]> = [
    ["version", record.version],
    ["id", record.id],
    ["kind", record.kind],
    ["createdAt", record.createdAt],
  ];
  appendOptional(fields, "headline", record.headline);
  appendOptional(fields, "model", record.model);
  appendOptional(fields, "fileCount", record.fileCount);
  appendOptional(fields, "archiveId", record.archiveId);
  appendOptional(fields, "priority", record.priority);
  appendOptional(fields, "source", record.source);
  appendOptional(fields, "tags", record.tags);
  for (const [key, value] of Object.entries(record.extra ?? {})) {
    if (!KEY_PATTERN.test(key) || KNOWN_KEYS.has(key) || key === "sourceFolder") {
      throw new Error(`Invalid extra frontmatter key: ${key}`);
    }
    fields.push([key, value]);
  }

  const header = fields.map(([key, value]) => `${key}: ${serializeScalar(value)}`).join(lineEnding);
  return `---${lineEnding}${header}${lineEnding}---${lineEnding}${record.content}`;
}

/** 返回由裸 `<slug>.md` 文件名负责的安全 slug。 */
export function slugFromFilename(name: string): string {
  if (basename(name) !== name || !name.endsWith(".md")) {
    throw new Error(`Memory filename must be a bare .md filename: ${name}`);
  }
  const slug = name.slice(0, -3);
  if (!SLUG_PATTERN.test(slug)) throw new Error(`Unsafe memory slug: ${slug}`);
  return slug;
}

function parseScalar(rawValue: string): MemoryFrontmatterValue {
  if (NUMBER_PATTERN.test(rawValue)) {
    const value = Number(rawValue);
    if (Number.isFinite(value) && String(value) === rawValue) return value;
  }
  const quoted = unquote(rawValue);
  if (quoted !== undefined) return quoted;
  if (rawValue.startsWith("[") && rawValue.endsWith("]")) {
    const inner = rawValue.slice(1, -1).trim();
    if (inner.length === 0) return [];
    return splitInlineList(inner).map((item) => unquote(item) ?? item);
  }
  // 其他内容都是普通 YAML scalar：按其原本的文本读取。
  return rawValue;
}

function unquote(value: string): string | undefined {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed === "string") return parsed;
    } catch {
      // 不是有效 JSON：回退为引号之间的字面文本。
    }
    return value.slice(1, -1);
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replaceAll("''", "'");
  }
  return undefined;
}

/** 在引号外的逗号上拆分 `a, "b, c", 'd'`。 */
function splitInlineList(inner: string): string[] {
  const items: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  for (let index = 0; index < inner.length; index += 1) {
    const char = inner[index]!;
    // 双引号内的反斜杠会按 JSON 规则转义下一个字符，因此转义的引号既不会关闭字符串，
    // 也不会拆分它。
    if (quote === '"' && char === "\\") {
      current += char + (inner[index + 1] ?? "");
      index += 1;
      continue;
    }
    if (quote === undefined && (char === '"' || char === "'")) quote = char;
    else if (quote === char) quote = undefined;
    if (char === "," && quote === undefined) {
      items.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  items.push(current.trim());
  return items.filter((item) => item.length > 0);
}

function serializeScalar(value: MemoryFrontmatterValue): string {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || /[eE]/.test(String(value))) {
      throw new Error(`Frontmatter numbers must be finite decimals: ${value}`);
    }
    return String(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return `[${value.map((item) => JSON.stringify(item)).join(", ")}]`;
  }
  throw new Error("Frontmatter values must be strings, numbers, or string arrays");
}

function optionalNumber(
  values: Map<string, MemoryFrontmatterValue>,
  key: string,
): number | undefined {
  const value = values.get(key);
  if (value === undefined) return undefined;
  if (typeof value !== "number") throw new Error(`Frontmatter ${key} must be a number`);
  return value;
}

function optionalString(
  values: Map<string, MemoryFrontmatterValue>,
  key: string,
): string | undefined {
  const value = values.get(key);
  if (value === undefined) return undefined;
  // 预期文本的位置写入 number 时，按其文本读取。
  if (typeof value === "number") return String(value);
  if (typeof value !== "string") throw new Error(`Frontmatter ${key} must be a string`);
  return value;
}

function requireString(values: Map<string, MemoryFrontmatterValue>, key: string): string {
  const value = optionalString(values, key);
  if (value === undefined) throw new Error(`Frontmatter ${key} must be a string`);
  return value;
}

function requireNonBlankString(values: Map<string, MemoryFrontmatterValue>, key: string): string {
  const value = requireString(values, key);
  if (value.trim().length === 0) throw new Error(`Frontmatter ${key} cannot be blank`);
  return value;
}

function requireIdSegment(values: Map<string, MemoryFrontmatterValue>, key: string): string {
  return assertIdSegment(key, requireNonBlankString(values, key));
}

function optionalIdSegmentProperty(
  values: Map<string, MemoryFrontmatterValue>,
  key: "archiveId",
): Partial<Pick<MemoryFileRecord, "archiveId">> {
  if (!values.has(key)) return {};
  return { [key]: requireIdSegment(values, key) };
}

function assertIdSegment(key: string, value: string): string {
  if (!ID_SEGMENT_PATTERN.test(value)) {
    throw new Error(`Frontmatter ${key} must be a safe path segment: ${value}`);
  }
  return value;
}

function optionalStringProperty<K extends "headline" | "model" | "priority" | "source">(
  values: Map<string, MemoryFrontmatterValue>,
  key: K,
): Partial<Pick<MemoryFileRecord, K>> {
  if (!values.has(key)) return {};
  return { [key]: requireNonBlankString(values, key) } as Pick<MemoryFileRecord, K>;
}

function optionalStringArrayProperty(
  values: Map<string, MemoryFrontmatterValue>,
  key: "tags",
): Partial<Pick<MemoryFileRecord, "tags">> {
  const raw = values.get(key);
  if (raw === undefined) return {};
  // 单个普通 scalar 表示只有一个 item 的 list。
  const value = typeof raw === "string" ? [raw] : raw;
  if (!Array.isArray(value) || value.some((item) => item.trim().length === 0)) {
    throw new Error(`Frontmatter ${key} must be a string array without blank items`);
  }
  return { tags: value };
}

function extraProperties(
  values: Map<string, MemoryFrontmatterValue>,
): Partial<Pick<MemoryFileRecord, "extra">> {
  const extra = Object.fromEntries(Array.from(values).filter(([key]) => !KNOWN_KEYS.has(key)));
  return Object.keys(extra).length === 0 ? {} : { extra };
}

function appendOptional(
  fields: Array<[string, MemoryFrontmatterValue]>,
  key: string,
  value: MemoryFrontmatterValue | undefined,
): void {
  if (value !== undefined) fields.push([key, value]);
}

function validateRecord(record: MemoryFileRecord): void {
  if (record.version !== 1) throw new Error(`Unsupported memory file version: ${record.version}`);
  if (record.id.trim().length === 0) throw new Error("Frontmatter id cannot be blank");
  assertIdSegment("id", record.id);
  if (record.archiveId !== undefined) assertIdSegment("archiveId", record.archiveId);
  if (record.kind !== "train" && record.kind !== "note") {
    throw new Error(`Invalid memory kind: ${String(record.kind)}`);
  }
  if (!Number.isSafeInteger(record.createdAt) || record.createdAt < 0) {
    throw new Error("createdAt must be a non-negative integer");
  }
  if (
    record.fileCount !== undefined &&
    (!Number.isSafeInteger(record.fileCount) || record.fileCount < 0)
  ) {
    throw new Error("fileCount must be a non-negative integer");
  }
  for (const [key, value] of Object.entries({
    headline: record.headline,
    model: record.model,
    archiveId: record.archiveId,
    priority: record.priority,
    source: record.source,
  })) {
    if (value !== undefined && value.trim().length === 0) {
      throw new Error(`Frontmatter ${key} cannot be blank`);
    }
  }
  if (record.tags?.some((tag) => tag.trim().length === 0)) {
    throw new Error("Frontmatter tags cannot contain blank items");
  }
  assertContent(record.content);
}

function assertContent(content: string): void {
  if (content.trim().length === 0) throw new Error("Memory content cannot be blank");
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > MAX_TRAIN_RECORD_CONTENT_BYTES) {
    throw new Error(`Memory content exceeds ${MAX_TRAIN_RECORD_CONTENT_BYTES} UTF-8 bytes`);
  }
}
