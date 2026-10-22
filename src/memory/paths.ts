import { homedir } from "node:os";
import { join } from "node:path";

/** Directory name shared by Relay Pi's user-scoped runtime state. */
export const DEFAULT_RELAY_PI_DIR = ".relay-pi";
export const RELAY_PI_HOME_ENV = "RELAY_PI_HOME";

/**
 * 用户级根目录：会话、记忆库和训练归档都放在这里。
 *
 * 优先级为 `RELAY_PI_HOME` → `~/.relay-pi`。所有使用方都把它当常量，因此
 * 在模块加载时完成解析。
 */
export function resolveRelayPiHome(): string {
  return process.env[RELAY_PI_HOME_ENV]?.trim() || join(homedir(), DEFAULT_RELAY_PI_DIR);
}

export const DEFAULT_RELAY_PI_HOME = resolveRelayPiHome();
export const DEFAULT_SESSION_STORAGE_DIR = join(DEFAULT_RELAY_PI_HOME, "sessions");
/** Default observational-memory PGlite path. */
export const DEFAULT_MEMORY_DB_PATH = join(DEFAULT_RELAY_PI_HOME, "memory.db");
