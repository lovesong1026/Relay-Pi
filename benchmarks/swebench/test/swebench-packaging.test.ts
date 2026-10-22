import { afterEach, describe, expect } from "bun:test";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { CommandRunner } from "../src/container.js";
import { loadPrebuiltRelayPiArtifact, prepareRelayPiArtifact } from "../src/packaging.js";
import { testIfDocker } from "./helpers/docker-only.js";

let root: string | undefined;

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

describe("SWE-bench Relay Pi packaging", () => {
  testIfDocker("carries declared dependency patches into the isolated Linux build", async () => {
    root = await mkdtemp(join(tmpdir(), "relay-pi-swebench-package-"));
    const repoRoot = join(root, "repo");
    const outputDir = join(root, "output");
    const patchName = "@earendil-works%2Fpi-ai@0.79.10.patch";
    await mkdir(repoRoot);
    await Promise.all([
      writeFile(
        join(repoRoot, "package.json"),
        `${JSON.stringify({
          patchedDependencies: {
            "@earendil-works/pi-ai@0.79.10": `patches/${patchName}`,
          },
        })}\n`,
      ),
      writeFile(join(repoRoot, "bun.lock"), ""),
      writeFile(join(repoRoot, "tsconfig.json"), "{}\n"),
      mkdir(join(repoRoot, "src"), { recursive: true }),
      mkdir(join(repoRoot, "patches"), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(repoRoot, "src", "cli-entry.ts"), ""),
      writeFile(join(repoRoot, "patches", patchName), "dependency patch"),
    ]);

    const commands: CommandRunner = {
      async run(argv, options) {
        const cwd = options?.cwd;
        if (!cwd) throw new Error("Packaging command must have a working directory.");
        if (argv[1] === "install") {
          try {
            await access(join(cwd, "patches", patchName));
          } catch {
            return { stdout: "", stderr: "declared patch is missing", exitCode: 1 };
          }
          const pgliteDir = join(cwd, "node_modules", "@electric-sql", "pglite", "dist");
          await mkdir(pgliteDir, { recursive: true });
          await Promise.all(
            ["pglite.data", "pglite.wasm", "initdb.wasm", "vector.tar.gz"].map((name) =>
              writeFile(join(pgliteDir, name), name),
            ),
          );
        } else if (argv[1] === "build") {
          const outputIndex = argv.indexOf("--outfile");
          const output = argv[outputIndex + 1];
          if (!output) throw new Error("Packaging build must declare its output.");
          await writeFile(output, "compiled relay-pi");
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      },
      stream() {
        throw new Error("Packaging does not stream commands.");
      },
    };

    const artifact = await prepareRelayPiArtifact({ repoRoot, outputDir, commands });
    expect(artifact.localPath).toBe(join(outputDir, "relay-pi-linux-x64"));
    expect(artifact.runtimeAssets.map((asset) => asset.name)).toEqual([
      "pglite.data",
      "pglite.wasm",
      "initdb.wasm",
      "vector.tar.gz",
    ]);
  });

  testIfDocker("loads the exact prebuilt worker artifact without rebuilding it", async () => {
    root = await mkdtemp(join(tmpdir(), "relay-pi-swebench-package-"));
    const path = join(root, "relay-pi-linux-x64");
    await Promise.all([
      writeFile(path, "prebuilt-relay-pi"),
      writeFile(join(root, "pglite.data"), "pglite-data"),
      writeFile(join(root, "pglite.wasm"), "pglite-wasm"),
      writeFile(join(root, "initdb.wasm"), "initdb-wasm"),
      writeFile(join(root, "vector.tar.gz"), "vector-bundle"),
    ]);

    const artifact = await loadPrebuiltRelayPiArtifact(path);
    expect(artifact).toMatchObject({
      localPath: resolve(path),
      installPath: "/opt/relay-pi/relay-pi",
      sha256: "704a265f2943584a181f68874a2de4a6216d8b369186cab918608dee253ed170",
      packagingMode: "compiled-linux-x64",
    });
    expect(artifact.runtimeAssets).toEqual([
      {
        name: "pglite.data",
        localPath: resolve(root, "pglite.data"),
        installPath: "/opt/relay-pi/pglite.data",
        sha256: "1e080a964119f869f42c0c02ac868913f482a887724afa0c821b1a02da1c8447",
      },
      {
        name: "pglite.wasm",
        localPath: resolve(root, "pglite.wasm"),
        installPath: "/opt/relay-pi/pglite.wasm",
        sha256: "a6ca6c3ae6c10f6eb0b1e6d511c7f7ce906d93d53535b53d2e0b245ba8870399",
      },
      {
        name: "initdb.wasm",
        localPath: resolve(root, "initdb.wasm"),
        installPath: "/opt/relay-pi/initdb.wasm",
        sha256: "ed4af33b09e17be37145d476f812121d5e225393f54970d01aa6d26fb539b877",
      },
      {
        name: "vector.tar.gz",
        localPath: resolve(root, "vector.tar.gz"),
        installPath: "/opt/relay-pi/vector.tar.gz",
        sha256: "e9b62d5569b52f792a3ef57c5be23ee638036791344acecafe27b069744f06ea",
      },
    ]);
  });
});
