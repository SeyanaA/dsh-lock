#!/bin/bash
# Rebuild bin/dsh-auth-helper from src/dsh-auth-helper.swift for this Mac.
# Requires the Xcode Command Line Tools (`xcode-select --install`).
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
cd "$HERE"
ARCH="$(uname -m)"
swiftc -O -target "${ARCH}-apple-macos11" -o bin/dsh-auth-helper src/dsh-auth-helper.swift
chmod +x bin/dsh-auth-helper
echo "built bin/dsh-auth-helper for ${ARCH}"
"$HERE/bin/dsh-auth-helper" --check || true
