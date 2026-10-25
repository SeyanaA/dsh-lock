#!/bin/bash
# dsh-lock: forget the password → restore the default password 4396.
#
# This only rewrites dsh-lock's own small state file; it never touches the
# DSH profile or any session data. Run it from a terminal, reopen DSH, and
# enter 4396, then set a new password under Settings → 安全锁定.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
TARGET="$DSH_HOME/dsh-lock"
STATE="$TARGET/state.json"

mkdir -p "$TARGET"

if [ -f "$STATE" ]; then
  cp "$STATE" "$STATE.bak-$(date +%Y%m%d-%H%M%S)"
fi

cp "$HERE/default-state.json" "$STATE"
chmod 600 "$STATE" 2>/dev/null || true

echo "已恢复默认密码：4396"
echo "文件：$STATE"
echo "现在重新打开 DSH（或切回 DSH 窗口），输入 4396 解锁；"
echo "解锁后请到 设置 → 安全锁定 修改为自己的密码。"
