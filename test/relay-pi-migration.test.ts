import { expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testIfDocker } from "./helpers/docker-only.js";

testIfDocker("uses the Relay Pi home instead of the legacy home override", async () => {
  const home = await mkdtemp(join(tmpdir(), "relay-pi-home-"));
  try {
    const proc = Bun.spawn(
      [
        "bun",
        "-e",
        'const paths = await import("./src/memory/paths.ts"); console.log(paths.DEFAULT_RELAY_PI_HOME)',
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          HOME: home,
          RELAY_PI_HOME: "",
          RELAYPI_HOME: join(home, "legacy-home"),
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(await proc.exited).toBe(0);
    expect((await new Response(proc.stdout).text()).trim()).toBe(join(home, ".relay-pi"));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
