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
#
# Portable on purpose: macOS/BSD and GNU/Linux userlands both run this script in
# CI, so it avoids `sed -i` (whose syntax differs) and rebuilds the state file
# with awk instead.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
TARGET="$DSH_HOME/dsh-lock"
STATE="$TARGET/state.json"

mkdir -p "$TARGET"

if [ -f "$STATE" ]; then
  cp "$STATE" "$STATE.bak-$(date +%Y%m%d-%H%M%S)"
fi

# Read one boolean flag from the current state before it is replaced.
read_flag() {
  [ -f "$STATE" ] || return 0
  grep -o "\"$1\"[[:space:]]*:[[:space:]]*[a-z]*" "$STATE" 2>/dev/null \
    | head -1 | sed 's/.*:[[:space:]]*//'
}
INDEPENDENT="$(read_flag independent)"
BIOMETRIC="$(read_flag biometric)"

# Rebuild the default state, carrying the two posture flags over when present.
awk -v independent="$INDEPENDENT" -v biometric="$BIOMETRIC" '
  /"independent"/ && independent != "" {
    sub(/"independent"[[:space:]]*:[[:space:]]*[a-z]+/, "\"independent\": " independent)
  }
  /"biometric"/ && biometric != "" {
    sub(/"biometric"[[:space:]]*:[[:space:]]*[a-z]+/, "\"biometric\": " biometric)
  }
  { print }
' "$HERE/default-state.json" > "$STATE"
chmod 600 "$STATE" 2>/dev/null || true

echo "已恢复默认密码：4396"
if [ "${INDEPENDENT:-false}" = "true" ]; then
  echo "独立应用锁保持开启：仍然只能用插件解锁密码解锁（本机指纹 / Mac 登录密码不可用）。"
fi
echo "文件：$STATE"
echo "现在重新打开 DSH（或切回 DSH 窗口），输入 4396 解锁；"
echo "解锁后请到 设置 → 安全锁定 修改为自己的密码。"
