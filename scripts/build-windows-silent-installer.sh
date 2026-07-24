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
require_cmd shasum "系统缺少 shasum，无法生成完整性校验文件"
require_cmd perl "系统缺少 perl，无法切换 NSIS 整机安装模式"

MODE="${BUILD_MODE:-prod}"
export BUILD_MODE="$MODE"
VERSION="$(node -p "require('./package.json').version")"
VERSION_4="$(node -e 'const [a = 0, b = 0, c = 0] = require("./package.json").version.split("."); process.stdout.write([a, b, c, 0].map((part) => String(part).replace(/\D.*$/, "") || "0").join("."))')"
ARTIFACTS_DIR="$ROOT/artifacts"
STAGING_DIR="$ARTIFACTS_DIR/windows-silent-installer-${MODE}"
ZIP_PATH="$ARTIFACTS_DIR/huali-ai-mascot-${VERSION}-${MODE}-windows-enterprise-silent-x64.zip"
NSIS_BUILD_DIR="$CARGO_TARGET_DIR/x86_64-pc-windows-msvc/release/nsis/x64"
APP_EXE="$CARGO_TARGET_DIR/x86_64-pc-windows-msvc/release/HualiAIDesktopAssistant.exe"
INNER_MACHINE_SETUP="$NSIS_BUILD_DIR/nsis-output.exe"
OUTPUT_NAME="Huali-AI-Desktop-Assistant_${VERSION}_${MODE}_x64-enterprise-silent-setup.exe"
OUTPUT="$STAGING_DIR/$OUTPUT_NAME"

if ! rustup target list --installed | grep -q '^x86_64-pc-windows-msvc$'; then
  echo "正在安装 Windows 编译目标..."
  rustup target add x86_64-pc-windows-msvc
fi

echo "开始交叉编译 Windows 企业静默安装包（环境: ${MODE}，整机安装）..."
echo "主程序使用与个人版完全相同的构建配置，仅在 NSIS 打包阶段切换整机安装模式。"

# Build the personal installer first and reuse that exact executable plus its
# generated NSIS script. Running a second Tauri build can relink an equivalent
# executable with different PE metadata, which makes byte-for-byte parity
# impossible to prove. This paired workflow always refreshes both deliverables
# from one application payload.
BUILD_MODE="$MODE" bash "$ROOT/scripts/build-windows-installer.sh"

if [[ ! -f "$APP_EXE" ]]; then
  echo "未找到 Windows 主程序: $APP_EXE"
  exit 1
fi

if ! grep -q '!define INSTALLMODE "currentUser"' "$NSIS_BUILD_DIR/installer.nsi"; then
  echo "共用主程序不是按个人版配置构建，为避免两包功能不一致已终止打包"
  exit 1
fi

# The Tauri config is compiled into the executable. Building once with a
# per-machine config would therefore produce a different application binary,
# even though only the installer mode changed. Keep the current-user build's
# application payload byte-for-byte intact and switch install scope only in
# the generated NSIS script.
perl -0pi -e 's/!define INSTALLMODE "currentUser"/!define INSTALLMODE "perMachine"/' "$NSIS_BUILD_DIR/installer.nsi"
if ! grep -q '!define INSTALLMODE "perMachine"' "$NSIS_BUILD_DIR/installer.nsi"; then
  echo "未能生成 per-machine 安装器脚本，已终止打包"
  exit 1
fi

rm -f "$INNER_MACHINE_SETUP"
(
  cd "$NSIS_BUILD_DIR"
  makensis installer.nsi
)

if [[ ! -f "$INNER_MACHINE_SETUP" ]]; then
  echo "未生成 per-machine 内层安装器: $INNER_MACHINE_SETUP"
  exit 1
fi

SETUP_EXE="$INNER_MACHINE_SETUP"

rm -rf "$STAGING_DIR"
mkdir -p "$STAGING_DIR"

makensis \
  -DSETUP_EXE="$SETUP_EXE" \
  -DOUTPUT_EXE="$OUTPUT" \
  -DPRODUCT_VERSION="$VERSION" \
  -DPRODUCT_VERSION_4="$VERSION_4" \
  -DINSTALLER_ICON="$ROOT/src-tauri/icons/icon.ico" \
  "$ROOT/scripts/windows-silent-installer/silent-wrapper.nsi"

cp "$ROOT/scripts/windows-silent-installer/平台部署说明.txt" "$STAGING_DIR/README.txt"
(
  cd "$STAGING_DIR"
  shasum -a 256 "$OUTPUT_NAME" > SHA256.txt
)
(
  cd "$(dirname "$APP_EXE")"
  shasum -a 256 "$(basename "$APP_EXE")" > "$STAGING_DIR/APPLICATION-SHA256.txt"
)

rm -f "$ZIP_PATH"
(
  cd "$STAGING_DIR"
  zip -r "$ZIP_PATH" .
)

echo ""
echo "企业静默包已完成:"
echo "  静默安装包: $OUTPUT"
echo "  发给平台管理员: $ZIP_PATH"
echo "  安装命令: 直接运行该 exe，不需要参数"
echo "  运行身份: 管理员或 SYSTEM"
