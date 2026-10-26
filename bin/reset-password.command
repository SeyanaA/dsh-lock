#!/bin/bash
# dsh-lock: forget the password → restore the default password 4396.
#
# This only rewrites dsh-lock's own small state file; it never touches the
# DSH profile or any session data. Run it from a terminal, reopen DSH, and
# enter 4396, then set a new password under Settings → 安全锁定.
#
# Security posture is kept: an enabled independent app lock stays enabled and
# the local-unlock (Touch ID) preference is carried over, because resetting the
# password must not silently weaken the lock.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
TARGET="$DSH_HOME/dsh-lock"
STATE="$TARGET/state.json"

mkdir -p "$TARGET"

if [ -f "$STATE" ]; then
  cp "$STATE" "$STATE.bak-$(date +%Y%m%d-%H%M%S)"
fi

# Read the flags from the current state before it is replaced.
read_flag() {
  [ -f "$STATE" ] || return 0
  grep -o "\"$1\"[[:space:]]*:[[:space:]]*[a-z]*" "$STATE" 2>/dev/null \
    | head -1 | sed 's/.*:[[:space:]]*//'
}
INDEPENDENT="$(read_flag independent)"
BIOMETRIC="$(read_flag biometric)"

cp "$HERE/default-state.json" "$STATE"
if [ -n "${INDEPENDENT:-}" ]; then
  sed -i '' -E "s/(\"independent\"[[:space:]]*:[[:space:]]*)[a-z]+/\1${INDEPENDENT}/" "$STATE"
fi
if [ -n "${BIOMETRIC:-}" ]; then
  sed -i '' -E "s/(\"biometric\"[[:space:]]*:[[:space:]]*)[a-z]+/\1${BIOMETRIC}/" "$STATE"
fi
chmod 600 "$STATE" 2>/dev/null || true

echo "已恢复默认密码：4396"
if [ "${INDEPENDENT:-false}" = "true" ]; then
  echo "独立应用锁保持开启：仍然只能用插件解锁密码解锁（本机指纹 / Mac 登录密码不可用）。"
fi
echo "文件：$STATE"
echo "现在重新打开 DSH（或切回 DSH 窗口），输入 4396 解锁；"
echo "解锁后请到 设置 → 安全锁定 修改为自己的密码。"
