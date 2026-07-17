#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if command -v brew >/dev/null 2>&1; then
  LLVM_BIN="$(brew --prefix llvm 2>/dev/null || true)/bin"
  RUSTUP_BIN="$(brew --prefix rustup 2>/dev/null || true)/bin"
  export PATH="$HOME/.cargo/bin:$RUSTUP_BIN:$LLVM_BIN:${PATH:-}"
else
  export PATH="$HOME/.cargo/bin:/opt/homebrew/opt/llvm/bin:/usr/local/opt/llvm/bin:${PATH:-}"
fi
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
ARTIFACTS_DIR="$ROOT/artifacts"
STAGING_DIR="$ARTIFACTS_DIR/windows-installer-${MODE}"
ZIP_PATH="$ARTIFACTS_DIR/huali-ai-mascot-${VERSION}-${MODE}-setup.zip"
BUNDLE_DIR="$CARGO_TARGET_DIR/x86_64-pc-windows-msvc/release/bundle/nsis"

if ! rustup target list --installed | grep -q '^x86_64-pc-windows-msvc$'; then
  echo "正在安装 Windows 编译目标..."
  rustup target add x86_64-pc-windows-msvc
fi

echo "开始交叉编译 Windows 安装包（环境: ${MODE}，当前用户模式，无需管理员权限）..."
mkdir -p "$BUNDLE_DIR"
rm -f "$BUNDLE_DIR"/*-setup.exe
npm run tauri build -- --runner cargo-xwin --target x86_64-pc-windows-msvc --bundles nsis

SETUP_EXE="$(find "$BUNDLE_DIR" -maxdepth 1 -type f -name "*_${VERSION}_*-setup.exe" -print -quit)"

if [[ -z "$SETUP_EXE" ]]; then
  echo "未在 $BUNDLE_DIR 找到当前版本 ${VERSION} 的 setup.exe"
  exit 1
fi

rm -rf "$STAGING_DIR"
mkdir -p "$STAGING_DIR"
OUTPUT="$STAGING_DIR/Huali-AI-Desktop-Assistant_${VERSION}_x64-setup.exe"
cp "$SETUP_EXE" "$OUTPUT"
cp "$ROOT/scripts/windows-installer/使用说明.txt" "$STAGING_DIR/README.txt"

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
