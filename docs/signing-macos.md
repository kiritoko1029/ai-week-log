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

## CI（可选，后续）

GitHub Actions 里通过 Secrets 注入证书与公证凭据：
`APPLE_CERTIFICATE`（base64 的 .p12）、`APPLE_CERTIFICATE_PASSWORD`、`APPLE_SIGNING_IDENTITY`、
`APPLE_ID`/`APPLE_PASSWORD`/`APPLE_TEAM_ID`。当前 `.github/workflows/release.yml` 仍是 Electron 流程，
迁移到 Tauri 打包时再补一个 job。

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
