#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

export PATH="/opt/homebrew/opt/llvm/bin:${PATH:-}"
export CARGO_TARGET_DIR="$ROOT/src-tauri/target"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "缺少依赖: $1"
    echo "$2"
    exit 1
  fi
}

require_cmd lld "请执行: brew install llvm lld"
require_cmd llvm-rc "请执行: brew install llvm"
require_cmd cargo-xwin "请执行: cargo install --locked cargo-xwin"
require_cmd makensis "请执行: brew install makensis"
require_cmd zip "请执行: brew install zip"

MODE="${BUILD_MODE:-prod}"
export BUILD_MODE="$MODE"
VERSION="$(node -p "require('./package.json').version")"
STAGING_DIR="$ROOT/dist/windows-installer-${MODE}"
ZIP_PATH="$ROOT/dist/huali-ai-mascot-${VERSION}-${MODE}-setup.zip"

if ! rustup target list --installed | grep -q '^x86_64-pc-windows-msvc$'; then
  echo "正在安装 Windows 编译目标..."
  rustup target add x86_64-pc-windows-msvc
fi

echo "开始交叉编译 Windows 安装包（环境: ${MODE}，当前用户模式，无需管理员权限）..."
npm run tauri build -- --runner cargo-xwin --target x86_64-pc-windows-msvc --bundles nsis

BUNDLE_DIR="$CARGO_TARGET_DIR/x86_64-pc-windows-msvc/release/bundle/nsis"
SETUP_EXE="$(find "$BUNDLE_DIR" -maxdepth 1 -name '*-setup.exe' -print -quit)"

if [[ -z "$SETUP_EXE" ]]; then
  echo "未在 $BUNDLE_DIR 找到 setup.exe"
  exit 1
fi

mkdir -p "$STAGING_DIR"
OUTPUT="$STAGING_DIR/$(basename "$SETUP_EXE")"
cp "$SETUP_EXE" "$OUTPUT"
cp "$ROOT/scripts/windows-installer/使用说明.txt" "$STAGING_DIR/"

rm -f "$ZIP_PATH"
(
  cd "$STAGING_DIR"
  zip -r "$ZIP_PATH" .
)

echo ""
echo "打包完成:"
echo "  安装包: $OUTPUT"
echo "  发给同事: $ZIP_PATH"
echo ""
echo "公司网络常拦截 .exe 直链下载，请发 zip 给同事解压后再安装。"
