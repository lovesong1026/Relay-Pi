/**
 * OpenRouter embedding client。
 *
 * 通过 OpenRouter 的 OpenAI-compatible endpoint（`POST https://openrouter.ai/api/v1/embeddings`）
 * 发送请求，由用户的 `OPENROUTER_API_KEY` 控制访问；这是承载 model 流量的同一凭据。
 *
 * 请求的 model 默认是 `qwen/qwen3-embedding-8b`，可通过 `RELAY_PI_EMBEDDING_MODEL` 覆盖。
 * 我们将 response 返回的 model 与每个 vector 一起存储，以便未来更换 model 时按 tag 使旧 row 失效。
 *
 * 行为：
 *   - 输入会按每次 HTTP 调用最多 `EMBEDDING_BATCH_LIMIT` 条分批，因此一次 backfill batch
 *     不会超过 request body 上限。
 *   - 5xx response、429 rate limit 和 network error 使用指数退避重试；其他 4xx response
 *    （认证、格式错误）快速失败，因为重试不会改变结果。
 *   - 缺少 `OPENROUTER_API_KEY` 时函数抛出带类型的错误，使调用方可以退化为仅 keyword 检索
 *    （recall_memory tool 负责捕获并只记录一次；backfill worker 记录日志并休眠，直到凭据出现）。
 */

/** pgvector 列所需的 embedding 维度。 */
export const EMBEDDING_DIMENSIONS = 4096;
/** 单次 embedding request 发送的输入字符串最大数量。 */
export const EMBEDDING_BATCH_LIMIT = 100;
/** 当前 embedding 默认值；与 4096 维 pgvector 表一致。 */
export const DEFAULT_EMBEDDING_MODEL = "qwen/qwen3-embedding-8b";
export const EMBEDDING_MODEL_ENV = "RELAY_PI_EMBEDDING_MODEL";

const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api";
export const OPENROUTER_API_KEY_ENV = "OPENROUTER_API_KEY";

const ENDPOINT_PATH = "/v1/embeddings";
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 500;

/**
 * `EmbedFn` 调用的结果。`model` 是 server 随 vector 返回的标识；storage 将它写入每个
 * row 的 tag，使未来更换 model 时可以使旧 row 失效。
 */
export interface EmbedResult {
  embeddings: number[][];
  model: string;
}

/** backfill worker 和 recall_memory tool 使用的可调用形状。输入与 `embeddings` 一一对应。 */
export type EmbedFn = (inputs: string[]) => Promise<EmbedResult>;

export class EmbeddingUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmbeddingUnavailableError";
  }
}

export interface CreateEmbeddingClientOptions {
  /**
   * 覆盖 API key resolver。默认从 `process.env` 读取 `OPENROUTER_API_KEY`。
   * 测试注入固定值，以便不触碰环境状态地测试 client。
   */
  apiKey?: string | (() => string | undefined);
  /** 覆盖 API base URL。默认使用 OpenRouter 的公开 API origin。 */
  baseUrl?: string;
  /** 覆盖请求的 embedding model。默认依次使用 `RELAY_PI_EMBEDDING_MODEL` 和 `DEFAULT_EMBEDDING_MODEL`。 */
  model?: string;
  /**
   * 覆盖 fetch 实现。测试使用它断言 request shape 并 stub response，而无需启动真实 server。
   */
  fetch?: typeof fetch;
}

/**
 * 构造绑定到 OpenRouter embedding endpoint 的 `EmbedFn`。每个进程只构造一次，并复用于
 * 每个 backfill batch 和每个 `recall_memory` query，使连接复用可以摊薄 TLS 建连成本。
 */
export function createEmbeddingClient(options: CreateEmbeddingClientOptions = {}): EmbedFn {
  const baseUrl = options.baseUrl ?? DEFAULT_OPENROUTER_BASE_URL;
  const requestedModel = options.model ?? resolveEmbeddingModel();
  const fetchImpl = options.fetch ?? fetch;

  return async (inputs) => {
    if (inputs.length === 0) return { embeddings: [], model: "" };
    const apiKey = resolveApiKey(options.apiKey);
    if (!apiKey) {
      // 抛出带类型的错误，让调用方无需通过字符串匹配 message 就能分支处理优雅退化。
      throw new EmbeddingUnavailableError(
        "OPENROUTER_API_KEY is not set; embeddings unavailable. Run `relay-pi env --keys` to enable hybrid memory retrieval.",
      );
    }

    const embeddings: number[][] = [];
    let responseModel = "";
    for (let offset = 0; offset < inputs.length; offset += EMBEDDING_BATCH_LIMIT) {
      const slice = inputs.slice(offset, offset + EMBEDDING_BATCH_LIMIT);
      const batch = await postBatch({
        url: `${baseUrl}${ENDPOINT_PATH}`,
        apiKey,
        model: requestedModel,
        inputs: slice,
        fetchImpl,
      });
      if (batch.embeddings.length !== slice.length) {
        throw new Error(
          `Embedding response length (${batch.embeddings.length}) did not match request size (${slice.length})`,
        );
      }
      embeddings.push(...batch.embeddings);
      // server 在一次调用的每个 batch 中返回相同的 model。取最后一个，使调用方看到 server
      // 最近确认的值；当前无需协调调用中途的 mismatch。
      responseModel = batch.model;
    }
    return { embeddings, model: responseModel };
  };
}

interface PostBatchOptions {
  url: string;
  apiKey: string;
  model: string;
  inputs: string[];
  fetchImpl: typeof fetch;
}

async function postBatch(options: PostBatchOptions): Promise<EmbedResult> {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const response = await options.fetchImpl(options.url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: options.model, input: options.inputs }),
      });

      if (response.ok) {
        const body = (await response.json()) as EmbeddingResponseEnvelope;
        return { embeddings: body.data.map((entry) => entry.embedding), model: body.model };
      }

      // 4xx 错误（认证、格式错误）重试也不会改善，因此立即返回，让调用方看到真实原因。
      // 429 是例外：rate limit 会自行清除，因此走与 5xx 相同的退避重试路径。
      if (response.status >= 400 && response.status < 500 && response.status !== 429) {
        const detail = await safeReadText(response);
        throw new EmbeddingUnavailableError(
          `Embedding endpoint returned ${response.status}: ${detail}`,
        );
      }

      lastError = new Error(`Embedding endpoint returned ${response.status}`);
    } catch (error) {
      // 立即重新抛出带类型的错误；只对 transport 层失败重试。
      if (error instanceof EmbeddingUnavailableError) throw error;
      lastError = error;
    }

    if (attempt < MAX_RETRIES - 1) {
      await sleep(BASE_BACKOFF_MS * 2 ** attempt);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`Embedding request failed after ${MAX_RETRIES} attempts`);
}

/** OpenRouter 返回的 OpenAI-compatible embedding response。 */
interface EmbeddingResponseEnvelope {
  data: Array<{ embedding: number[] }>;
  model: string;
}

function resolveApiKey(override: CreateEmbeddingClientOptions["apiKey"]): string | undefined {
  if (typeof override === "function") return override();
  if (typeof override === "string") return override;
  return process.env[OPENROUTER_API_KEY_ENV];
}

function resolveEmbeddingModel(): string {
  return process.env[EMBEDDING_MODEL_ENV]?.trim() || DEFAULT_EMBEDDING_MODEL;
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "<unreadable response body>";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
