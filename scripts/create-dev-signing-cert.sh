#!/usr/bin/env bash
#
# 创建一个免费的「自签名代码签名证书」，用于本机签名 WeekLog，
# 让 macOS 钥匙串把每次构建认作同一个 App → 点一次「始终允许」长期生效，不再反复弹密码。
#
# 注意：自签名证书只解决本机弹窗，不能用于公证 / 对外分发（那需要 Developer ID）。
# 用完想撤销：security delete-identity -c "WeekLog Dev" ~/Library/Keychains/login.keychain-db
set -euo pipefail

NAME="${1:-WeekLog Dev}"
KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"

if security find-identity -p codesigning "$KEYCHAIN" 2>/dev/null | grep -q "$NAME"; then
  echo "✓ 身份「$NAME」已存在，跳过创建。"
  security find-identity -p codesigning "$KEYCHAIN" | grep "$NAME"
  exit 0
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

cat > "$TMP/cfg" <<EOF
[req]
distinguished_name = dn
x509_extensions = v3
prompt = no
[dn]
CN = $NAME
[v3]
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature
extendedKeyUsage = critical, codeSigning
EOF

echo "→ 生成自签名证书 + 私钥…"
openssl req -x509 -newkey rsa:2048 -sha256 -days 3650 -nodes \
  -keyout "$TMP/key.pem" -out "$TMP/cert.pem" -config "$TMP/cfg" 2>/dev/null

# 用临时非空密码：空密码的 p12 在 macOS security import 下 MAC 校验会失败
P12PASS="weeklog-temp"
openssl pkcs12 -export -inkey "$TMP/key.pem" -in "$TMP/cert.pem" \
  -name "$NAME" -out "$TMP/id.p12" -passout "pass:$P12PASS" 2>/dev/null

echo "→ 导入登录钥匙串（-A：允许 codesign 等本机工具免密使用）…"
security import "$TMP/id.p12" -k "$KEYCHAIN" -P "$P12PASS" -A

echo
echo "✓ 完成。当前可用代码签名身份："
security find-identity -p codesigning "$KEYCHAIN" | grep "$NAME" || true
echo
echo "下一步：用它打一个签名版 App（不公证）："
echo "  APPLE_SIGNING_IDENTITY=\"$NAME\" pnpm tauri:build -- --bundles app,dmg"
echo "首次运行 App 用到密钥时点「始终允许」，之后同证书构建不再弹。"
