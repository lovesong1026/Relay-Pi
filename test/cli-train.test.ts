import path from "node:path";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { buildTrainSynthesisConfig, parseTrainArgs } from "../src/cli/train.js";
import { DEFAULT_MEMORY_DB_PATH } from "../src/session/session-manager.js";

// `parseTrainArgs` 在错误输入上调用 `fail()`，而 `fail()` 会调用
// `process.exit(1)`。这里将 exit 改为抛出异常，使测试可以断言错误路径，
// 而不是直接终止测试运行器。
class ExitCalled extends Error {
  constructor(public code?: number | string | null) {
    super(`process.exit(${String(code)})`);
  }
}

let exitSpy: ReturnType<typeof spyOn> | undefined;
let errorSpy: ReturnType<typeof spyOn> | undefined;

beforeEach(() => {
  exitSpy = spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
    throw new ExitCalled(code);
  });
  errorSpy = spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  exitSpy?.mockRestore();
  errorSpy?.mockRestore();
});

describe("parseTrainArgs", () => {
  test("disables both durable memory sources for the synthesis sub-runner", () => {
    const config = buildTrainSynthesisConfig({ folder: "/tmp/corpus", model: "test:model" });
    expect(config.memoryDbPath).toBe(false);
    expect(config.memoryStores).toBe(false);
  });

  test("asks for Chinese markdown synthesis rather than English prose", () => {
    const instructions = buildTrainSynthesisConfig({
      folder: "/tmp/corpus",
      model: "test:model",
    }).systemInstructions;

    expect(instructions).toContain("请使用 GitHub Flavored Markdown 编写综合结果");
    expect(instructions).toContain("完整性优先于简洁");
    expect(instructions).not.toContain("Write the synthesis as GitHub-flavored markdown");
    expect(instructions).not.toContain("tight prose");
    expect(instructions).not.toContain("not a document dump");
    expect(instructions).toContain("禁止使用顶级 `#` 标题");
  });

  test("rejects an empty arg list", () => {
    expect(() => parseTrainArgs([])).toThrow(ExitCalled);
  });

  test("accepts a positional folder and resolves it to an absolute path", () => {
    const result = parseTrainArgs(["./docs"]);
    expect(result).toBeDefined();
    expect(result!.folder).toBe(path.resolve("./docs"));
    expect(result!.slug).toBe(path.basename(path.resolve("./docs")).toLowerCase());
    // 模型在运行时通过 `resolveCliModel` 解析；除非用户传入 `--model`，
    // 否则解析器会保留 undefined。
    expect(result!.model).toBeUndefined();
    expect(result!.dbPath).toBe(DEFAULT_MEMORY_DB_PATH);
    expect(result!.waitBudgetMs).toBeUndefined();
  });

  test("--slug overrides the derived slug", () => {
    const result = parseTrainArgs(["./docs", "--slug", "my-slug"]);
    expect(result!.slug).toBe("my-slug");
  });

  test("derives slug from basename via lowercase + non-alphanum collapse", () => {
    // `My Docs` 同时包含空格和大小写混合；sanitizer 应将两者都折叠为
    // 一个连字符，并将其余字母转换为小写。
    const result = parseTrainArgs(["./My Docs"]);
    expect(result!.slug).toBe("my-docs");
  });

  test("collapses runs of non-alphanum characters and trims edge dashes", () => {
    const result = parseTrainArgs(["./folder", "--slug", "!!Hello___World!!"]);
    expect(result!.slug).toBe("hello-world");
  });

  test("--model overrides the default memory model", () => {
    const result = parseTrainArgs(["./docs", "--model", "opus-4.7"]);
    expect(result!.model).toBe("opus-4.7");
  });

  test("--db resolves to an absolute path", () => {
    const result = parseTrainArgs(["./docs", "--db", "./foo.db"]);
    expect(result!.dbPath).toBe(path.resolve("./foo.db"));
  });

  test("--wait accepts a non-negative number of seconds", () => {
    const result = parseTrainArgs(["./docs", "--wait", "2.5"]);
    expect(result!.waitBudgetMs).toBe(2500);
  });

  test("--wait rejects non-numeric values", () => {
    expect(() => parseTrainArgs(["./docs", "--wait", "soon"])).toThrow(ExitCalled);
  });

  test("unknown flag fails", () => {
    expect(() => parseTrainArgs(["./docs", "--bogus"])).toThrow(ExitCalled);
  });

  test("a flag with a missing value fails", () => {
    expect(() => parseTrainArgs(["./docs", "--slug"])).toThrow(ExitCalled);
  });

  test("extra positional argument fails", () => {
    expect(() => parseTrainArgs(["./docs", "./other"])).toThrow(ExitCalled);
  });

  test("--help returns undefined without parsing further", () => {
    // `--help` 会在生成 slug 之前短路，因此不要求提供 folder。
    expect(parseTrainArgs(["--help"])).toBeUndefined();
    expect(parseTrainArgs(["-h"])).toBeUndefined();
  });

  test("a slug that sanitizes to empty fails", () => {
    expect(() => parseTrainArgs(["./folder", "--slug", "!!!"])).toThrow(ExitCalled);
  });
});
