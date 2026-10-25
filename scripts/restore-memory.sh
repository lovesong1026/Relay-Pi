#!/usr/bin/env bash
# 从最近的轮换备份恢复 ~/.relay-pi/memory.db；如果没有备份，则使用 Relay Pi
# 在放弃打开实时目录时写入的最新 .corrupted-* 快照。
#
# 必须在退出所有 Relay Pi CLI 后运行。如果当前 memory.db 仍被任何进程持有 open-lock，
# 脚本会拒绝运行。
set -euo pipefail

RELAY_PI_DIR="${RELAY_PI_HOME:-$HOME/.relay-pi}"
MEMORY_DIR="$RELAY_PI_DIR"
CURRENT="$MEMORY_DIR/memory.db"

# 优先使用轮换的 .backup-* 快照（每次干净启动时创建），而不是 .corrupted-*
#（被隔离的不可读副本）。每个池内都优先选择最新的文件。
NEWEST_BACKUP="$(ls -d "$MEMORY_DIR"/memory.db.backup-* 2>/dev/null | sort | tail -1 || true)"
NEWEST_QUARANTINE="$(ls -d "$MEMORY_DIR"/memory.db.corrupted-* 2>/dev/null | sort | tail -1 || true)"
if [[ -n "$NEWEST_BACKUP" ]]; then
  RESTORE_SRC="$NEWEST_BACKUP"
else
  RESTORE_SRC="$NEWEST_QUARANTINE"
fi

if [[ -z "$RESTORE_SRC" ]]; then
  echo "no memory.db.backup-* or memory.db.corrupted-* found under $MEMORY_DIR" >&2
  exit 1
fi

# 如果当前 memory.db 仍被任何进程持有，则拒绝继续。
if [[ -f "$CURRENT/.relay-pi-open.lock" ]]; then
  HOLDER="$(head -1 "$CURRENT/.relay-pi-open.lock" 2>/dev/null || echo "")"
  if [[ -n "$HOLDER" ]] && kill -0 "$HOLDER" 2>/dev/null; then
    echo "relay-pi pid $HOLDER still holds $CURRENT/.relay-pi-open.lock; quit it before restoring" >&2
    exit 2
  fi
fi
if [[ -f "$CURRENT/postmaster.pid" ]]; then
  HOLDER="$(head -1 "$CURRENT/postmaster.pid" 2>/dev/null || echo "")"
  if [[ -n "$HOLDER" && "$HOLDER" =~ ^[0-9]+$ ]] && kill -0 "$HOLDER" 2>/dev/null; then
    echo "live postgres process pid $HOLDER still owns $CURRENT/postmaster.pid; quit it before restoring" >&2
    exit 2
  fi
fi

STAMP="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
ASIDE="$MEMORY_DIR/memory.db.fresh-pre-restore-$STAMP"

echo "moving current (fresh, empty) $CURRENT aside -> $ASIDE"
mv "$CURRENT" "$ASIDE"

echo "restoring $RESTORE_SRC -> $CURRENT"
mv "$RESTORE_SRC" "$CURRENT"

# 恢复的快照中如果有旧锁，会阻止下一次打开。
rm -f "$CURRENT/.relay-pi-open.lock" "$CURRENT/postmaster.pid"

echo "done. start relay-pi again; it will replay WAL and reopen the restored db."
