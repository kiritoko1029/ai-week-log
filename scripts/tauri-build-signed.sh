#!/usr/bin/env bash
#
# macOS 打包（Tauri 2）。默认用本机自签名证书「WeekLog Dev」签名，不公证——
# 解决「每次启动弹钥匙串密码」+ 避免「已损坏」提示（自签名足够本机/内部使用）。
#
# 若设置了 Developer ID 相关环境变量，则自动升级为正式签名 + 公证 + staple（对外分发用）：
#   export APPLE_SIGNING_IDENTITY="Developer ID Application: 你的名字 (TEAMID)"
#   export APPLE_ID=...  APPLE_PASSWORD=...(App专用密码)  APPLE_TEAM_ID=...
#
# 用法： pnpm tauri:dist:mac    （= 本脚本）
set -euo pipefail

cd "$(dirname "$0")/.."
HERE="$(cd "$(dirname "$0")" && pwd)"
KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"

# 签名身份：默认自签名 WeekLog Dev；可用 APPLE_SIGNING_IDENTITY 覆盖为 Developer ID
IDENTITY="${APPLE_SIGNING_IDENTITY:-WeekLog Dev}"

# 用默认自签名身份时：缺证书则自动创建
if [[ "$IDENTITY" == "WeekLog Dev" ]]; then
  if ! security find-identity -p codesigning "$KEYCHAIN" 2>/dev/null | grep -q "WeekLog Dev"; then
    echo "→ 未找到自签名身份「WeekLog Dev」，自动创建…"
    bash "$HERE/create-dev-signing-cert.sh"
  fi
fi
export APPLE_SIGNING_IDENTITY="$IDENTITY"

# 公证：仅当提供 Apple ID 或 App Store Connect API 凭据时启用（自签名不公证）
notarize="否（自签名，仅本机/内部）"
if { [[ -n "${APPLE_ID:-}" && -n "${APPLE_PASSWORD:-}" && -n "${APPLE_TEAM_ID:-}" ]]; } ||
   { [[ -n "${APPLE_API_ISSUER:-}" && -n "${APPLE_API_KEY:-}" && -n "${APPLE_API_KEY_PATH:-}" ]]; }; then
  notarize="是（Developer ID + 公证）"
fi

echo "✓ 签名身份：$APPLE_SIGNING_IDENTITY"
echo "✓ 公证：$notarize"
echo "→ 开始打包（arm64）…"

# 直接调用本地 tauri CLI：--bundles 是 tauri build 的参数，
# 经 `pnpm tauri:build -- ...` 会被 `--` 误转发给 cargo，故用 pnpm exec 直传。
# Tauri 读取 APPLE_* 环境变量，自动完成签名 / 公证 / staple。
pnpm exec tauri build --bundles app,dmg

echo "✓ 完成。产物在 src-tauri/target/release/bundle/"
echo "  验证签名：codesign -dvv src-tauri/target/release/bundle/macos/WeekLog.app"
