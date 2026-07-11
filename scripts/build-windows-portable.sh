#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

export PATH="/opt/homebrew/opt/llvm/bin:${PATH:-}"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "缺少依赖: $1"
    echo "$2"
    exit 1
  fi
}

require_cmd lld "请执行: brew install llvm lld"
require_cmd llvm-rc "请执行: brew install llvm，并确保 /opt/homebrew/opt/llvm/bin 在 PATH 中"
require_cmd cargo-xwin "请执行: cargo install --locked cargo-xwin"
require_cmd zip "请执行: brew install zip"

if ! rustup target list --installed | grep -q '^x86_64-pc-windows-msvc$'; then
  echo "正在安装 Windows 编译目标..."
  rustup target add x86_64-pc-windows-msvc
fi

VERSION="$(node -p "require('./package.json').version")"
MODE="${BUILD_MODE:-prod}"
export BUILD_MODE="$MODE"
export CARGO_TARGET_DIR="$ROOT/src-tauri/target"
RELEASE_DIR="$CARGO_TARGET_DIR/x86_64-pc-windows-msvc/release"
OUT_DIR="$ROOT/dist/windows-portable-${MODE}"
ZIP_PATH="$ROOT/dist/huali-ai-mascot-${VERSION}-${MODE}-windows-portable.zip"

echo "开始交叉编译 Windows 便携版（环境: ${MODE}）..."
BUILD_LOG="$(mktemp)"
if ! npm run tauri build -- --runner cargo-xwin --target x86_64-pc-windows-msvc --no-bundle 2>&1 | tee "$BUILD_LOG"; then
  rm -f "$BUILD_LOG"
  exit 1
fi

EXE="$(sed -n 's/.*Built application at: //p' "$BUILD_LOG" | tail -1 | tr -d '\r')"
rm -f "$BUILD_LOG"

if [[ -z "$EXE" || ! -f "$EXE" ]]; then
  EXE="$(find "$RELEASE_DIR" -maxdepth 1 -name '*.exe' -print -quit 2>/dev/null || true)"
fi
if [[ -z "$EXE" ]]; then
  echo "未在 $RELEASE_DIR 找到 .exe，编译可能失败"
  exit 1
fi

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"
cp "$EXE" "$OUT_DIR/"
cp "$ROOT/scripts/windows-portable/使用说明.txt" "$OUT_DIR/"

rm -f "$ZIP_PATH"
(
  cd "$OUT_DIR"
  zip -r "$ZIP_PATH" .
)

echo ""
echo "打包完成:"
echo "  目录: $OUT_DIR"
echo "  压缩包: $ZIP_PATH"
echo ""
echo "把 zip 发给同事，解压后双击 .exe 即可使用。"
echo "若公司拦截 .exe 直链下载，请只发 zip，不要直接发 exe 链接。"
