#!/usr/bin/env bash
# 打免安装的电脑版压缩包：自带 Node 运行时 + node_modules（含对应平台的 ffmpeg），解压双击即用。
# 用法：scripts/package-desktop.sh <mac-arm64|mac-x64|win-x64|linux-x64> [输出目录]
# 在 Linux / macOS 上都能给任意平台打包（ffmpeg 按 npm_config_platform/arch 下载）。
set -euo pipefail

TARGET=$1
OUT=${2:-dist}
NODE_MAJOR=${NODE_MAJOR:-22}

case $TARGET in
  mac-arm64)  PLATFORM=darwin; ARCH=arm64; NODE_DIST=darwin-arm64; EXT=tar.gz ;;
  mac-x64)    PLATFORM=darwin; ARCH=x64;   NODE_DIST=darwin-x64;   EXT=tar.gz ;;
  linux-x64)  PLATFORM=linux;  ARCH=x64;   NODE_DIST=linux-x64;    EXT=tar.gz ;;
  win-x64)    PLATFORM=win32;  ARCH=x64;   NODE_DIST=win-x64;      EXT=zip ;;
  *) echo "未知平台: $TARGET" >&2; exit 1 ;;
esac

ROOT=$(cd "$(dirname "$0")/.." && pwd)
mkdir -p "$OUT"
OUT=$(cd "$OUT" && pwd)
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
APP=$WORK/web-player
mkdir -p "$APP/runtime"

# 1. 代码（不带 .npmrc：里面是国内 ffmpeg 镜像，CI 上直连 GitHub 更快）
cp -R "$ROOT/server" "$ROOT/public" "$APP/"
cp "$ROOT/package.json" "$ROOT/package-lock.json" "$ROOT/LICENSE" "$ROOT/README.md" "$APP/"

# 2. 依赖：ffmpeg-static 按目标平台下载二进制
(cd "$APP" && npm_config_platform=$PLATFORM npm_config_arch=$ARCH npm ci --omit=dev --no-audit --no-fund)
# ffprobe-static 自带所有平台的二进制，只留目标平台
find "$APP/node_modules/ffprobe-static/bin" -mindepth 1 -maxdepth 1 ! -name "$PLATFORM" -exec rm -rf {} +
find "$APP/node_modules/ffprobe-static/bin/$PLATFORM" -mindepth 1 -maxdepth 1 ! -name "$ARCH" -exec rm -rf {} +

# 3. Node 运行时：取 NODE_MAJOR 的最新版（node:sqlite 需要 22.13+）
NODE_VER=$(curl -fsSL https://nodejs.org/dist/index.json | node -e "
  const all = JSON.parse(require('fs').readFileSync(0, 'utf8'));
  console.log(all.find(r => r.version.startsWith('v$NODE_MAJOR.')).version)")
NODE_NAME=node-$NODE_VER-$NODE_DIST
curl -fsSL "https://nodejs.org/dist/$NODE_VER/$NODE_NAME.$EXT" -o "$WORK/node.$EXT"
if [ "$EXT" = zip ]; then
  unzip -q "$WORK/node.zip" "$NODE_NAME/node.exe" -d "$WORK"
  mv "$WORK/$NODE_NAME/node.exe" "$APP/runtime/"
else
  tar -xzf "$WORK/node.tar.gz" -C "$WORK" "$NODE_NAME/bin/node"
  mv "$WORK/$NODE_NAME/bin/node" "$APP/runtime/"
fi
cp "$WORK/$NODE_NAME/LICENSE" "$APP/runtime/NODE-LICENSE" 2>/dev/null || true

# 4. 启动脚本
case $PLATFORM in
  darwin)
    cat > "$APP/start.command" <<'EOF'
#!/bin/bash
# 双击启动 web-player。第一次如果提示「无法验证开发者」：右键 → 打开。
cd "$(dirname "$0")"
# 去掉下载带来的隔离标记，否则内置的 node / ffmpeg 会被系统拦截
xattr -dr com.apple.quarantine . 2>/dev/null
PORT=$(./runtime/node -p "try { require('./config.json').port } catch { 8080 }")
(sleep 2; open "http://localhost:$PORT") &
exec ./runtime/node server/index.js
EOF
    chmod +x "$APP/start.command" "$APP/runtime/node" ;;
  linux)
    cat > "$APP/start.sh" <<'EOF'
#!/bin/sh
cd "$(dirname "$0")"
exec ./runtime/node server/index.js
EOF
    chmod +x "$APP/start.sh" "$APP/runtime/node" ;;
  win32)
    printf '%s\r\n' \
      '@echo off' \
      'chcp 65001 >nul' \
      'cd /d "%~dp0"' \
      'for /f %%p in ('"'"'runtime\node.exe -p "try { require(\"./config.json\").port } catch { 8080 }"'"'"') do set PORT=%%p' \
      'start "" cmd /c "timeout /t 2 >nul & start http://localhost:%PORT%"' \
      'runtime\node.exe server\index.js' \
      'pause' > "$APP/start.bat" ;;
esac

# 5. 打包
ZIP=$OUT/web-player-$TARGET.zip
rm -f "$ZIP"
(cd "$WORK" && zip -qry "$ZIP" web-player)
echo "$ZIP ($(du -h "$ZIP" | cut -f1), Node $NODE_VER)"
