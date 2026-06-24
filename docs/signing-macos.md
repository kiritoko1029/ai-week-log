# macOS 代码签名与公证（Tauri 2）

## 为什么需要

WeekLog 把 API Key / WebDAV 密码存进 **系统钥匙串**（`src-tauri/src/secrets.rs`，`keyring` crate）。
macOS 钥匙串按**代码签名**判断「是不是同一个 App」来决定是否免密读取：

- **未签名 / ad-hoc 签名**（`tauri dev` 与未配证书的 `tauri build`）：每次重建签名都变，钥匙串当成新 App，**每次启动都弹密码**，且「始终允许」不生效。
- **稳定的 Developer ID 签名**：签名身份固定，用户点一次「始终允许」长期有效，不再反复弹。

> Electron 版当初不弹，是因为 `Electron.app` 本体由 Electron 官方稳定签名。Tauri 把整个 App 编译成自有二进制，必须自己签名才能获得同样体验。

## 当前默认：自签名（本机/内部足够）

本项目 **默认用自签名证书 `WeekLog Dev` 签名**：

- `tauri.conf.json > bundle > macOS > signingIdentity` 已设为 `"WeekLog Dev"`，所以 **任何 `tauri build` 都会自动用它签名**（`tauri dev` 热重载仍是 ad-hoc，dev 模式下仍会弹）。
- 打包：
  ```bash
  bash scripts/create-dev-signing-cert.sh   # 一次性，创建并导入身份（缺则打包脚本会自动调用）
  pnpm tauri:dist:mac                        # 自签名打包，不公证
  ```
- 产物 `src-tauri/target/release/bundle/macos/WeekLog.app`，首次运行用到密钥时点 **「始终允许」**，之后同证书重建不再弹。

自签名能力边界（详见文末「对外分发对比」）：
- ✅ 本机/内部使用：不再反复弹钥匙串；避免「已损坏」死胡同。
- ⚠️ 对外分发：每个用户首装仍要去「系统设置 → 仍要打开」手动放行一次，且有「无法验证开发者」提示。
- ❌ 不能公证、不能做到「下载双击即开」——那需要下面的 Developer ID。

换机器/换证书会改变签名 → 钥匙串需重新「始终允许」一次。

## 升级为对外分发：Developer ID + 公证（一次性，需付费 Apple 开发者账号）

1. 加入 **Apple Developer Program**（$99/年）。
2. 创建并安装 **Developer ID Application** 证书到登录钥匙串
   （Xcode → Settings → Accounts → Manage Certificates，或 developer.apple.com）。
   仅「Account Holder」可创建此类证书。
3. 生成 **App 专用密码**：appleid.apple.com → 登录与安全 → App 专用密码。
4. 确认身份已就位：
   ```bash
   security find-identity -v -p codesigning
   # 应出现：Developer ID Application: 你的名字 (TEAMID)
   ```

## 打包（已封装为脚本）

```bash
export APPLE_SIGNING_IDENTITY="Developer ID Application: 你的名字 (TEAMID)"
export APPLE_ID="you@example.com"
export APPLE_PASSWORD="abcd-efgh-ijkl-mnop"   # App 专用密码
export APPLE_TEAM_ID="TEAMID"

pnpm tauri:dist:mac      # = scripts/tauri-build-signed.sh
```

同一个 `pnpm tauri:dist:mac` 脚本会自动识别：**设了上面这组 Developer ID 环境变量** → 升级为正式签名 + 公证 + staple；不设则走默认自签名。
`APPLE_SIGNING_IDENTITY` 环境变量会**覆盖** `tauri.conf.json` 里的 `"WeekLog Dev"`（[env 优先级](https://v2.tauri.app/reference/environment-variables/)），所以无需改配置。
产物在 `src-tauri/target/release/bundle/`。

公证也可改用 App Store Connect API（替代 Apple ID 三件套）：
`APPLE_API_ISSUER` + `APPLE_API_KEY` + `APPLE_API_KEY_PATH`。

> 注意：`tauri.conf.json` 里硬编码了自签名身份 `"WeekLog Dev"` 作为默认。在**没有该证书的机器/CI** 上跑 `tauri build` 会因找不到身份而失败——换机器先跑 `scripts/create-dev-signing-cert.sh`，或用 `APPLE_SIGNING_IDENTITY` 覆盖，或临时删掉该配置项。

## 验证

```bash
APP="src-tauri/target/release/bundle/macos/WeekLog.app"
codesign -dvv --verbose=4 "$APP"
#   自签名：Authority=WeekLog Dev，非 adhoc
#   Developer ID：TeamIdentifier 为你的 TEAMID
spctl -a -vvv -t install "$APP"
#   自签名：rejected（未公证，属正常，本机首装去「系统设置 → 仍要打开」）
#   Developer ID：accepted / Notarized Developer ID
```

签名稳定后，首次运行用到密钥时点 **「始终允许」**，后续版本（同证书 + 同 bundle id）不再弹。

## CI

`.github/workflows/release.yml` 的 macOS job 默认用**自签名 `WeekLog Dev`** 签名（不公证），
与本机 `pnpm tauri:dist:mac` 行为一致——保证 CI 产物与本地签名身份相同，用户点一次「始终允许」即长期生效。

### 实现方式（为什么不用 tauri 的 APPLE_CERTIFICATE 自动导入）

tauri-macos-sign 有两条钥匙串路径（`sign.rs::keychain()`）：

- **设了 `APPLE_CERTIFICATE` + `APPLE_CERTIFICATE_PASSWORD`** → `with_certificate()`：创建临时钥匙串 → 导入 → 用 `identity::list()` 解析身份。但该函数**硬编码只接受 Apple Developer 证书前缀**（`Developer ID Application:` / `Apple Development:` 等），自签名 `WeekLog Dev` 不匹配 → `ResolveSigningIdentity` 失败。
- **只设 `APPLE_SIGNING_IDENTITY`** → `with_signing_identity()`：用默认钥匙串里已有的身份，按 CN 直接签名，**不过滤前缀**。本机 `tauri-build-signed.sh` 走的就是这条。

所以 CI workflow **手动导入 `.p12` 到 runner 默认登录钥匙串**（`security import` + `set-key-partition-list` 授权 codesign），**只设 `APPLE_SIGNING_IDENTITY=WeekLog Dev`**，让 tauri 走第二条路径。两个 Secret 仍是：

- `APPLE_CERTIFICATE`：自签名 `.p12` 的 **base64**（workflow 里 base64 --decode 后 `security import`）
- `APPLE_CERTIFICATE_PASSWORD`：导出 `.p12` 时设置的密码
- `APPLE_SIGNING_IDENTITY`：固定为 `WeekLog Dev`（workflow 内按 `runner.os` 注入，
  且须与 `tauri.conf.json > bundle.macOS.signingIdentity` 一致）

### 一次性导出自签名证书到 GitHub Secrets

在**本机**执行一次（已用 `scripts/create-dev-signing-cert.sh` 创建过 `WeekLog Dev` 身份为前提）：

```bash
# 从登录钥匙串导出 .p12（导出时设置一个密码）
security export -k ~/Library/Keychains/login.keychain-db \
  -t identities -f pkcs12 -o WeekLog-Dev.p12

# base64 编码后复制到剪贴板 → 粘进 GitHub Secrets
base64 -i WeekLog-Dev.p12 | pbcopy
```

然后在仓库 **Settings → Secrets and variables → Actions** 添加：
`APPLE_CERTIFICATE`（粘贴 base64）、`APPLE_CERTIFICATE_PASSWORD`（导出密码）。

> 未配置这两个 Secret 时，CI 的 macOS job 会跳过导入步骤，`APPLE_SIGNING_IDENTITY`
> 虽仍为 `WeekLog Dev` 但钥匙串里找不到该身份，tauri 自动回退 ad-hoc 签名——不会失败，
> 只是失去稳定签名的好处。

### 升级 CI 为对外分发（Developer ID + 公证）

换用付费 Apple Developer 证书后，**改回 tauri 的自动导入路径更省事**（Developer ID 证书匹配前缀过滤，`with_certificate()` 能正常解析）。把 workflow 里手动导入那步删掉，改设：

- `APPLE_CERTIFICATE` = Developer ID `.p12` 的 base64
- `APPLE_CERTIFICATE_PASSWORD` = 导出密码
- `APPLE_SIGNING_IDENTITY` = `Developer ID Application: 你的名字 (TEAMID)`
- `APPLE_ID` / `APPLE_PASSWORD`（App 专用密码）/ `APPLE_TEAM_ID`（公证用）

tauri-cli 检测到这三件套后会自动签名 + 公证 + staple。

或改用 App Store Connect API：`APPLE_API_ISSUER` + `APPLE_API_KEY` + `APPLE_API_KEY_PATH`。
workflow 无需改结构，仅靠环境变量切换。

## 没有付费账号但想本机不弹？（免费替代）

若暂时不打算分发、只想自己机器上不再弹钥匙串，可用**自签名代码签名证书**。
已封装为脚本（幂等，可重复跑）：

```bash
bash scripts/create-dev-signing-cert.sh          # 创建身份「WeekLog Dev」并导入登录钥匙串
APPLE_SIGNING_IDENTITY="WeekLog Dev" pnpm tauri:build -- --bundles app,dmg
```

打出来的 `WeekLog.app`（在 `src-tauri/target/release/bundle/macos/`）首次运行用到密钥时点
**「始终允许」**，之后用同一证书重新构建不再弹。

注意：
- 自签名**只解决本机弹窗，不能用于公证 / 对外分发**（对外仍需上面的 Developer ID 流程）。
- 仅 `tauri build`（正式包）会用此身份签名；`tauri dev` 热重载的二进制仍是 ad-hoc，**dev 模式下仍会弹**。要无弹窗体验请运行构建出的 `.app`。
- 撤销：`security delete-identity -c "WeekLog Dev" ~/Library/Keychains/login.keychain-db`
