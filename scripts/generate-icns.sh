#!/usr/bin/env bash
# SyncWave 图标资产导出脚本
# build/icon.svg（唯一矢量源）→ build/icon.png(1024) / build/icon.icns / build/icons/ 十规格 PNG
# 用法：bash scripts/generate-icns.sh（需 macOS，iconutil/sips 系统自带）
set -euo pipefail
cd "$(dirname "$0")/.."

echo "🌊 SyncWave 图标资源导出..."

SVG=build/icon.svg
MASTER=build/icon.png
ICONSET_DIR=AppIcon.iconset
TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR" "$ICONSET_DIR"' EXIT

# 1. 渲染 1024 母版。优先 qlmanage（QuickLook/WebKit，完整支持 SVG 滤镜：投影与光晕不失真；
#    rsvg-convert / magick / resvg 均不支持 <filter>，仅作后备，效果会有损失）
if qlmanage -t -s 1024 -o "$TMP_DIR" "$SVG" >/dev/null 2>&1 && [ -s "$TMP_DIR/icon.svg.png" ]; then
  cp "$TMP_DIR/icon.svg.png" "$MASTER"
elif command -v rsvg-convert >/dev/null 2>&1; then
  rsvg-convert -w 1024 -h 1024 "$SVG" -o "$MASTER"
elif command -v magick >/dev/null 2>&1; then
  magick -background none -density 300 "$SVG" -resize 1024x1024 "$MASTER"
else
  echo "❌ 未找到可用渲染器（macOS 自带 qlmanage，或 brew install librsvg）"
  exit 1
fi

# 2. 生成 iconset 十规格 PNG（sips 无损缩放）
mkdir -p "$ICONSET_DIR" build/icons
sips -z 16 16     "$MASTER" --out "$ICONSET_DIR/icon_16x16.png"      >/dev/null
sips -z 32 32     "$MASTER" --out "$ICONSET_DIR/icon_16x16@2x.png"   >/dev/null
sips -z 32 32     "$MASTER" --out "$ICONSET_DIR/icon_32x32.png"      >/dev/null
sips -z 64 64     "$MASTER" --out "$ICONSET_DIR/icon_32x32@2x.png"   >/dev/null
sips -z 128 128   "$MASTER" --out "$ICONSET_DIR/icon_128x128.png"    >/dev/null
sips -z 256 256   "$MASTER" --out "$ICONSET_DIR/icon_128x128@2x.png" >/dev/null
sips -z 256 256   "$MASTER" --out "$ICONSET_DIR/icon_256x256.png"    >/dev/null
sips -z 512 512   "$MASTER" --out "$ICONSET_DIR/icon_256x256@2x.png" >/dev/null
sips -z 512 512   "$MASTER" --out "$ICONSET_DIR/icon_512x512.png"    >/dev/null
cp "$MASTER" "$ICONSET_DIR/icon_512x512@2x.png"

# 3. macOS 原生 iconutil 打包 .icns（electron-builder mac.icon 直接引用）
iconutil -c icns "$ICONSET_DIR" -o build/icon.icns

# 4. 整理十规格 PNG 供 Windows/Linux/站点等场景取用
cp "$ICONSET_DIR"/* build/icons/

echo "🎉 已输出 build/icon.png、build/icon.icns 与 build/icons/*.png（10 规格）"
