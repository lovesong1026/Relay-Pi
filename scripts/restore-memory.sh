#!/usr/bin/env bash
# Restore ~/.relay-pi/memory.db from the most recent rotating backup or, failing
# that, the newest .corrupted-* snapshot Relay Pi wrote when it gave up opening
# the live dir.
#
# Run this AFTER quitting every Relay Pi CLI. It will refuse to run if anything
# still holds the open-lock on the current memory.db.
set -euo pipefail

RELAY_PI_DIR="${RELAY_PI_HOME:-$HOME/.relay-pi}"
MEMORY_DIR="$RELAY_PI_DIR"
CURRENT="$MEMORY_DIR/memory.db"

# Prefer rotating .backup-* snapshots (taken on every clean startup) over
# .corrupted-* (quarantined unreadable copies). Within each pool, newest first.
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

# Refuse if anything is still holding the current memory.db.
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

# Stale locks inside the restored snapshot would block the next open.
rm -f "$CURRENT/.relay-pi-open.lock" "$CURRENT/postmaster.pid"

echo "done. start relay-pi again; it will replay WAL and reopen the restored db."
