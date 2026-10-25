export interface ArchivedFile {
  /** 相对于 corpus 文件夹根目录的路径，使用 posix 分隔符。 */
  relPath: string;
  /** 磁盘上的绝对路径；用于将文件复制到 archive。 */
  absPath: string;
  /** 磁盘上的原始字节大小，复制到 manifest 中作为 provenance。 */
  bytes: number;
  /** 文件字节的 SHA-256，使未来的重新训练能够检测未变化的 source。 */
  sha256: string;
}

export interface SynthesisResult {
  /** 简短标题（<120 字符），显示在报告块中；不会单独持久化。 */
  headline: string;
  /** 作为一条高优先级 observation 插入的持久化 memory 文本。 */
  observationContent: string;
}

/**
 * `relay-pi train list` / `show` 展示的一条精选 memory。文件 store 和旧版 DB 都会映射为
 * 此共同形状；archive manifest 会为训练条目补充私有 corpus provenance，也可能不存在。
 */
export interface TrainListEntry {
  /** Filename stem 或 `train:<slug>` 标签；稳定的 source-local 身份。 */
  slug: string;
  /** 稳定的 memory id；训练条目同时将它作为 archive 文件夹名。 */
  memoryId: string;
  /** 写入 memory 的 Unix ms 时间；合并列表按此时间从新到旧排序。 */
  createdAt: number;
  /** 记录训练日期，格式为 YYYY-MM-DD。 */
  observedDate: string;
  /** archive 存在时来自 archive manifest 的标题。 */
  headline?: string;
  /** 存在 manifest 时来自其中的 synthesis model id。 */
  model?: string;
  /** 从 manifest 中读取、传给 `relay-pi train` 的绝对 corpus 文件夹。 */
  sourceFolder?: string;
  /** 来自 manifest 的 archive source 文件数。 */
  fileCount?: number;
  /** 无法读取 manifest 时为 false（archive 已删除或移动）。 */
  hasArchive: boolean;
  /** 提供此条目的绝对 file-store 目录；旧版 DB row 没有此字段。 */
  store?: string;
}

/** `TrainListEntry` 加上完整的 synthesized observation 文本和 archive 内容，作为单行查询（`relay-pi train show` / `update`）的返回值。 */
export interface TrainRecord extends TrainListEntry {
  /** 存储在 observation row 中的持久化 memory 文本。 */
  content: string;
  /** manifest 中 archive `files/` 文件夹下副本的绝对路径。相比可能已移动或删除的原始 source 路径，优先使用这些路径。 */
  files?: string[];
}

export interface TrainManifest {
  /** 与插入的 observation row 的 id 一致；同时作为 archive 文件夹名。 */
  memoryId: string;
  slug: string;
  /** Unix ms 时间；与 observation 的 createdAt 一致。 */
  createdAt: number;
  /** 用户传给 `relay-pi train` 的绝对路径。 */
  sourceFolder: string;
  /** 用于 synthesis 的已解析 model id。 */
  model: string;
  headline: string;
  files: Array<Pick<ArchivedFile, "relPath" | "bytes" | "sha256">>;
}
