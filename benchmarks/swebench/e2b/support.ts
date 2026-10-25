import type { PGliteRuntimeAssetName } from "../../../src/memory/pglite.js";

const GIT_SHA = /^[0-9a-f]{40}$/i;

/** 与每个已提交基准测试输入绑定的稳定 E2B 模板名称。 */
export function e2bTemplateName(repositorySha: string): string {
  if (!GIT_SHA.test(repositorySha)) throw new Error("E2B template requires a full git SHA.");
  return `relay-pi-swebench-${repositorySha.slice(0, 12).toLowerCase()}`;
}

/** 仅选择模型 gateway 凭据；E2B 控制密钥留在主机上。 */
export function providerEnvironment(source: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of ["RELAY_PI_API_KEY", "AI_GATEWAY_API_KEY", "OPENROUTER_API_KEY"] as const) {
    const value = source[name];
    if (value) result[name] = value;
  }
  if (Object.keys(result).length === 0) {
    throw new Error("No supported model gateway key is available for E2B workers.");
  }
  return result;
}

export interface E2BEnvironmentProbe {
  /** 从仓库 SHA 派生的不可变 E2B 模板名称。 */
  templateName: string;
  /** 构建后模板由 provider 分配的身份。 */
  templateId: string;
  /** 每个 worker 沙箱可见的资源。 */
  cpuCount: number;
  memoryMb: number;
  /** 模板中嵌入的精确已提交源码。 */
  repositorySha: string;
  architecture: string;
  osRelease: string;
  dockerClientVersion: string;
  dockerServerVersion: string;
  /** worker 模板中嵌入的唯一 Relay Pi 二进制的 SHA-256。 */
  relayPiArtifactSha256: string;
  /** 编译后二进制旁每个 PGlite sidecar 的 SHA-256。 */
  runtimeAssetSha256: Record<PGliteRuntimeAssetName, string>;
  pythonVersion: string;
  swebenchVersion: string;
}

/** 同一测试活动中所有沙箱逐字节共享的稳定 provenance。 */
export function buildE2BEnvironmentLock(probe: E2BEnvironmentProbe): object {
  return {
    schemaVersion: 1,
    backend: "e2b",
    template: {
      name: probe.templateName,
      id: probe.templateId,
      repositorySha: probe.repositorySha,
    },
    worker: {
      architecture: probe.architecture,
      cpuCount: probe.cpuCount,
      memoryMb: probe.memoryMb,
      osRelease: probe.osRelease,
    },
    docker: {
      clientVersion: probe.dockerClientVersion,
      serverVersion: probe.dockerServerVersion,
    },
    relayPiArtifact: {
      sha256: probe.relayPiArtifactSha256,
      runtimeAssetSha256: probe.runtimeAssetSha256,
    },
    python: {
      version: probe.pythonVersion,
      swebenchVersion: probe.swebenchVersion,
    },
  };
}

/** 为远程 POSIX shell 命令引用一个可信标量。 */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
