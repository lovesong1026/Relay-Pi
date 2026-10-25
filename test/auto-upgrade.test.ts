import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { EventEmitter } from "node:events";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import {
  __testing,
  PACKAGE_MANAGER_SPAWN_OPTIONS,
  createUpgradeStatusStream,
  defaultRunUpgrade,
  describeUpgradeStatus,
  isLikelyGlobalInstall,
  NO_AUTO_UPGRADE_ENV,
  UPGRADE_ENABLED_ENV,
  runAutoUpgrade,
  type UpgradeStatus,
} from "../src/cli/auto-upgrade.js";
import { testIfDocker } from "./helpers/docker-only.js";

const ORIGINAL_HOME = process.env.HOME;
let scratchHome: string | undefined;

const GLOBAL_PATH = "/lib/node_modules/relay-pi/dist/src/cli.js";

beforeEach(() => {
  // 每个测试使用独立的伪造 $HOME，因此 .relay-pi/upgrade.lock 的写入不会泄漏。
  scratchHome = mkdtempSync(join(tmpdir(), "relay-pi-auto-upgrade-"));
  process.env.HOME = scratchHome;
});

afterEach(() => {
  if (scratchHome) rmSync(scratchHome, { recursive: true, force: true });
  if (ORIGINAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIGINAL_HOME;
});

describe("isLikelyGlobalInstall", () => {
  testIfDocker("accepts npm global lib path", () => {
    expect(
      isLikelyGlobalInstall(
        "/Users/x/.nvm/versions/node/v22/lib/node_modules/relay-pi/dist/src/cli.js",
      ),
    ).toBe(true);
  });
  testIfDocker("accepts bun global path", () => {
    expect(
      isLikelyGlobalInstall("/Users/x/.bun/install/global/node_modules/relay-pi/dist/src/cli.js"),
    ).toBe(true);
  });
  testIfDocker("rejects source checkout", () => {
    expect(isLikelyGlobalInstall("/Users/x/dev/relay-pi/src/cli.ts")).toBe(false);
  });
});

describe("describeUpgradeStatus", () => {
  testIfDocker("renders user-facing copy for each visible state", () => {
    expect(describeUpgradeStatus("relay-pi", { kind: "checking" })).toBe("Checking for updates…");
    expect(
      describeUpgradeStatus("relay-pi", {
        kind: "upgrading",
        from: "0.1.62",
        to: "0.1.63",
        manager: "npm",
      }),
    ).toBe("Updating relay-pi 0.1.62 → 0.1.63…");
    expect(
      describeUpgradeStatus("relay-pi", {
        kind: "upgraded",
        from: "0.1.62",
        to: "0.1.63",
        manager: "npm",
      }),
    ).toBe("Updated relay-pi to 0.1.63. Restart relay-pi to use it.");
    expect(
      describeUpgradeStatus("relay-pi", {
        kind: "failed",
        from: "0.1.62",
        to: "0.1.63",
        manager: "npm",
        error: "EACCES",
      }),
    ).toBe("Update to 0.1.63 failed (EACCES). Run: relay-pi upgrade");
  });

  testIfDocker("hides current/locked/skipped from the header", () => {
    expect(
      describeUpgradeStatus("relay-pi", { kind: "current", version: "0.1.62" }),
    ).toBeUndefined();
    expect(describeUpgradeStatus("relay-pi", { kind: "locked" })).toBeUndefined();
    expect(
      describeUpgradeStatus("relay-pi", { kind: "skipped", reason: "disabled" }),
    ).toBeUndefined();
  });
});

describe("cleanStaleStagingDirs", () => {
  testIfDocker("removes .agent-* staging dirs left behind by a killed install", () => {
    const scopeDir = join(scratchHome!, "lib", "node_modules");
    const agentDir = join(scopeDir, "relay-pi");
    const stagingA = join(scopeDir, ".agent-MtyTJGUn");
    const stagingB = join(scopeDir, ".agent-xxxxxxxx");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(stagingA, { recursive: true });
    mkdirSync(stagingB, { recursive: true });
    writeFileSync(join(stagingA, "package.json"), "{}");

    __testing.cleanStaleStagingDirs(join(agentDir, "dist", "src", "cli.js"));

    expect(existsSync(stagingA)).toBe(false);
    expect(existsSync(stagingB)).toBe(false);
    // 真实的软件包安装目录会保留——我们只清理暂存目录。
    expect(existsSync(agentDir)).toBe(true);
  });

  testIfDocker("is a no-op for source-checkout script paths", () => {
    // 不抛出异常，也没有文件系统副作用。
    __testing.cleanStaleStagingDirs("/Users/x/dev/relay-pi/src/cli.ts");
  });
});

describe("runAutoUpgrade", () => {
  test("stays skipped until relay-pi has a published release", async () => {
    let fetched = false;
    const final = await runAutoUpgrade({
      packageName: "relay-pi",
      currentVersion: "0.3.36",
      scriptPath: GLOBAL_PATH,
      env: {
        ...process.env,
        [NO_AUTO_UPGRADE_ENV]: undefined,
        [UPGRADE_ENABLED_ENV]: undefined,
      },
      fetchLatest: async () => {
        fetched = true;
        return "0.3.37";
      },
      runUpgrade: async () => ({ ok: true }),
    });
    expect(final).toEqual({ kind: "skipped", reason: "package-not-published" });
    expect(fetched).toBe(false);
  });

  testIfDocker("emits checking → current when already on latest", async () => {
    const statuses: UpgradeStatus[] = [];
    const final = await runAutoUpgrade({
      packageName: "relay-pi",
      currentVersion: "0.1.62",
      scriptPath: GLOBAL_PATH,
      env: { ...process.env, [NO_AUTO_UPGRADE_ENV]: undefined, [UPGRADE_ENABLED_ENV]: "1" },
      fetchLatest: async () => "0.1.62",
      runUpgrade: async () => ({ ok: true }),
      onStatus: (status) => statuses.push(status),
    });
    expect(statuses.map((s) => s.kind)).toEqual(["checking", "current"]);
    expect(final.kind).toBe("current");
  });

  testIfDocker("emits checking → upgrading → upgraded when a newer version exists", async () => {
    const statuses: UpgradeStatus[] = [];
    const calls: string[][] = [];
    const final = await runAutoUpgrade({
      packageName: "relay-pi",
      currentVersion: "0.1.62",
      scriptPath: GLOBAL_PATH,
      env: { ...process.env, [NO_AUTO_UPGRADE_ENV]: undefined, [UPGRADE_ENABLED_ENV]: "1" },
      detectManager: () => "npm",
      fetchLatest: async () => "0.1.63",
      runUpgrade: async (command) => {
        calls.push(command);
        return { ok: true };
      },
      onStatus: (status) => statuses.push(status),
    });
    expect(statuses.map((s) => s.kind)).toEqual(["checking", "upgrading", "upgraded"]);
    expect(calls).toEqual([["npm", "install", "--global", "relay-pi@0.1.63"]]);
    expect(final.kind).toBe("upgraded");
    const log = readFileSync(join(homedir(), ".relay-pi", "logs", "upgrade.log"), "utf8");
    expect(log).toContain("upgraded package=relay-pi from=0.1.62 to=0.1.63 manager=npm");
  });

  testIfDocker(
    "emits failed and surfaces stderr when the package manager exits non-zero",
    async () => {
      const statuses: UpgradeStatus[] = [];
      const final = await runAutoUpgrade({
        packageName: "relay-pi",
        currentVersion: "0.1.62",
        scriptPath: GLOBAL_PATH,
        env: { ...process.env, [NO_AUTO_UPGRADE_ENV]: undefined, [UPGRADE_ENABLED_ENV]: "1" },
        detectManager: () => "npm",
        fetchLatest: async () => "0.1.63",
        runUpgrade: async () => ({ ok: false, stderr: "EACCES" }),
        onStatus: (status) => statuses.push(status),
      });
      expect(statuses.at(-1)).toEqual({
        kind: "failed",
        from: "0.1.62",
        to: "0.1.63",
        manager: "npm",
        error: "EACCES",
      });
      expect(final.kind).toBe("failed");
    },
  );

  testIfDocker("emits locked when another worker holds a fresh lock", async () => {
    const { lockPath, homeDir } = __testing.upgradePaths();
    mkdirSync(homeDir, { recursive: true });
    writeFileSync(lockPath, JSON.stringify({ pid: 999999, startedAt: Date.now() - 1_000 }));
    const final = await runAutoUpgrade({
      packageName: "relay-pi",
      currentVersion: "0.1.62",
      scriptPath: GLOBAL_PATH,
      env: { ...process.env, [NO_AUTO_UPGRADE_ENV]: undefined, [UPGRADE_ENABLED_ENV]: "1" },
      fetchLatest: async () => {
        throw new Error("should not be called when locked");
      },
      runUpgrade: async () => ({ ok: true }),
    });
    expect(final.kind).toBe("locked");
    expect(existsSync(lockPath)).toBe(true);
  });

  testIfDocker("reclaims a stale lock and proceeds", async () => {
    const { lockPath, homeDir } = __testing.upgradePaths();
    mkdirSync(homeDir, { recursive: true });
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: 999999, startedAt: Date.now() - (__testing.STALE_LOCK_MS + 1_000) }),
    );
    const final = await runAutoUpgrade({
      packageName: "relay-pi",
      currentVersion: "0.1.62",
      scriptPath: GLOBAL_PATH,
      env: { ...process.env, [NO_AUTO_UPGRADE_ENV]: undefined, [UPGRADE_ENABLED_ENV]: "1" },
      fetchLatest: async () => "0.1.62",
      runUpgrade: async () => ({ ok: true }),
    });
    expect(final.kind).toBe("current");
    expect(existsSync(lockPath)).toBe(false);
  });

  testIfDocker("returns skipped when RELAY_PI_NO_AUTO_UPGRADE=1", async () => {
    const final = await runAutoUpgrade({
      packageName: "relay-pi",
      currentVersion: "0.1.62",
      scriptPath: GLOBAL_PATH,
      env: { ...process.env, [NO_AUTO_UPGRADE_ENV]: "1" },
      fetchLatest: async () => "0.1.63",
      runUpgrade: async () => ({ ok: true }),
    });
    expect(final).toEqual({ kind: "skipped", reason: "disabled" });
  });

  testIfDocker("returns skipped when invoked from a source checkout", async () => {
    const final = await runAutoUpgrade({
      packageName: "relay-pi",
      currentVersion: "0.1.62",
      scriptPath: "/Users/x/dev/relay-pi/src/cli.ts",
      env: { ...process.env, [NO_AUTO_UPGRADE_ENV]: undefined, [UPGRADE_ENABLED_ENV]: "1" },
      fetchLatest: async () => "0.1.63",
      runUpgrade: async () => ({ ok: true }),
    });
    expect(final).toEqual({ kind: "skipped", reason: "source-checkout" });
  });

  testIfDocker(
    "returns skipped with reason memory-in-use when another relay-pi process holds the memory db open-lock",
    async () => {
      let fetchCalled = false;
      let upgradeCalled = false;
      const final = await runAutoUpgrade({
        packageName: "relay-pi",
        currentVersion: "0.1.62",
        scriptPath: GLOBAL_PATH,
        env: { ...process.env, [NO_AUTO_UPGRADE_ENV]: undefined, [UPGRADE_ENABLED_ENV]: "1" },
        peekMemoryHolder: () => 999_999,
        fetchLatest: async () => {
          fetchCalled = true;
          return "0.1.63";
        },
        runUpgrade: async () => {
          upgradeCalled = true;
          return { ok: true };
        },
      });
      expect(final).toEqual({ kind: "skipped", reason: "memory-in-use" });
      // 跳过必须在任何 registry 探测或安装之前短路返回。
      expect(fetchCalled).toBe(false);
      expect(upgradeCalled).toBe(false);
    },
  );

  testIfDocker("proceeds when no peer holds the memory db open-lock", async () => {
    let upgradeCalled = false;
    const final = await runAutoUpgrade({
      packageName: "relay-pi",
      currentVersion: "0.1.62",
      scriptPath: GLOBAL_PATH,
      env: { ...process.env, [NO_AUTO_UPGRADE_ENV]: undefined, [UPGRADE_ENABLED_ENV]: "1" },
      peekMemoryHolder: () => null,
      detectManager: () => "npm",
      fetchLatest: async () => "0.1.63",
      runUpgrade: async () => {
        upgradeCalled = true;
        return { ok: true };
      },
    });
    expect(final).toEqual({
      kind: "upgraded",
      from: "0.1.62",
      to: "0.1.63",
      manager: "npm",
    });
    expect(upgradeCalled).toBe(true);
  });
});

interface FakeChild extends EventEmitter {
  unref(): void;
}

function buildFakeChild(onUnref: () => void = () => {}): FakeChild {
  return Object.assign(new EventEmitter(), { unref: onUnref }) as FakeChild;
}

describe("defaultRunUpgrade spawn contract", () => {
  testIfDocker(
    "spawns the package manager detached with stderr redirected to a log file so the install survives the parent exit",
    async () => {
      let capturedOptions: SpawnOptions | undefined;
      let unrefCalls = 0;

      const fakeSpawn = (
        _command: string,
        _args: string[],
        options: SpawnOptions,
      ): ChildProcess => {
        capturedOptions = options;
        const child = buildFakeChild(() => {
          unrefCalls += 1;
        });
        queueMicrotask(() => {
          child.emit("exit", 0);
        });
        return child as unknown as ChildProcess;
      };

      const result = await defaultRunUpgrade(
        ["npm", "install", "--global", "relay-pi@0.1.63"],
        fakeSpawn,
      );
      expect(result).toEqual({ ok: true });
      expect(capturedOptions?.detached).toBe(true);
      // stdin/stdout 会被丢弃，因此安装不会争抢 TTY，
      // 而 stderr 是继承的文件描述符（一个数字），而不是管道——
      // 父进程退出时管道的读端会关闭，
      // 导致 npm 下一次写入 stderr 时收到 SIGPIPE。
      const stdio = capturedOptions?.stdio as readonly unknown[];
      expect(stdio[0]).toBe("ignore");
      expect(stdio[1]).toBe("ignore");
      expect(typeof stdio[2]).toBe("number");
      expect(unrefCalls).toBe(1);
    },
  );

  testIfDocker("surfaces stderr from a failed install", async () => {
    const fakeSpawn = (_command: string, _args: string[], options: SpawnOptions): ChildProcess => {
      // 模拟真实的 spawn 契约：软件包管理器会写入
      // 继承的 stderr 文件描述符。这里也这样做，以便运行器能在
      // 失败退出后读回它。
      const stdio = options.stdio as readonly unknown[];
      const errFd = stdio[2] as number;
      writeSync(errFd, "npm ERR! permission denied\n");
      const child = buildFakeChild();
      queueMicrotask(() => {
        child.emit("exit", 1);
      });
      return child as unknown as ChildProcess;
    };

    const result = await defaultRunUpgrade(["npm", "install", "--global", "x"], fakeSpawn);
    expect(result.ok).toBe(false);
    expect(result.stderr).toBe("npm ERR! permission denied");
  });

  testIfDocker(
    "PACKAGE_MANAGER_SPAWN_OPTIONS is the single source of truth for the detached contract",
    () => {
      expect(PACKAGE_MANAGER_SPAWN_OPTIONS.detached).toBe(true);
    },
  );
});

describe("defaultRunUpgrade survives parent exit", () => {
  // 回归：软件包管理器的 stderr 接到父进程拥有的管道时，
  // relay-pi CLI 收到 Ctrl+C 会关闭管道读端，
  // SIGPIPE 会在 npm 安装过程中将其杀死，导致从 $PATH 中找不到
  // `relay-pi`。这里生成一个小型父进程，让它通过 defaultRunUpgrade
  // 启动一个长时间运行的伪造 "install"，随后很快杀死父进程，
  // 并验证父进程退出后安装仍会完成。
  testIfDocker("a fake install finishes even after the parent process is killed", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "relay-pi-upgrade-survive-"));
    try {
      const markerPath = join(workDir, "install-done");
      const installScript = join(workDir, "fake-install.sh");
      // 模拟 npm：在足够长的时间窗口内反复写入 stderr，
      // 确保父进程在运行中途已经退出。
      writeFileSync(
        installScript,
        `#!/bin/sh
for i in $(seq 1 30); do
  echo "fake install tick $i" 1>&2
  sleep 0.1
done
echo ok > ${JSON.stringify(markerPath)}
`,
      );
      chmodSync(installScript, 0o755);

      const parentScript = join(workDir, "parent.mjs");
      const repoRoot = join(import.meta.dir, "..");
      writeFileSync(
        parentScript,
        `import { defaultRunUpgrade } from ${JSON.stringify(join(repoRoot, "src/cli/auto-upgrade.ts"))};
process.env.HOME = ${JSON.stringify(workDir)};
defaultRunUpgrade([${JSON.stringify(installScript)}]).catch(() => {});
setTimeout(() => process.exit(130), 200);
`,
      );

      await new Promise<void>((resolve, reject) => {
        const child = spawn(process.execPath, [parentScript], { stdio: "ignore" });
        child.once("exit", () => resolve());
        child.once("error", reject);
      });

      // 父进程已退出；给分离出来的“安装”留出完成时间。
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        if (existsSync(markerPath)) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(existsSync(markerPath)).toBe(true);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });
});

describe("createUpgradeStatusStream", () => {
  testIfDocker("replays the latest status to late subscribers", () => {
    const stream = createUpgradeStatusStream();
    stream.publish({ kind: "checking" });
    stream.publish({ kind: "upgrading", from: "0.1.62", to: "0.1.63", manager: "npm" });

    const seen: UpgradeStatus[] = [];
    stream.subscribe((status) => seen.push(status));
    expect(seen).toEqual([{ kind: "upgrading", from: "0.1.62", to: "0.1.63", manager: "npm" }]);
  });

  testIfDocker("publish() fans out to every active subscriber and skips after unsubscribe", () => {
    const stream = createUpgradeStatusStream();
    const a: UpgradeStatus[] = [];
    const b: UpgradeStatus[] = [];
    const unsubscribeA = stream.subscribe((status) => a.push(status));
    stream.subscribe((status) => b.push(status));

    stream.publish({ kind: "checking" });
    unsubscribeA();
    stream.complete({ kind: "current", version: "0.1.62" });

    expect(a).toEqual([{ kind: "checking" }]);
    expect(b).toEqual([{ kind: "checking" }, { kind: "current", version: "0.1.62" }]);
  });

  testIfDocker("complete() does not re-emit when the final status was already published", () => {
    const stream = createUpgradeStatusStream();
    const seen: UpgradeStatus[] = [];
    stream.subscribe((status) => seen.push(status));

    const upgraded: UpgradeStatus = {
      kind: "upgraded",
      from: "0.1.62",
      to: "0.1.63",
      manager: "npm",
    };
    stream.publish(upgraded);
    stream.complete(upgraded);

    expect(seen).toEqual([upgraded]);
  });
});
