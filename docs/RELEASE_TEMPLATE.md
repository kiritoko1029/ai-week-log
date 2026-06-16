# Release Notes 模板

> 每次发版复制下面的「正文模板」,填好 `## ✨ 本次更新` 即可发布。
> macOS 安装提示段（解决"已损坏"）是固定内容，每个版本都要保留，直到接入 Apple 签名公证。

---

## 正文模板

```markdown
## 📥 下载

| 平台 | 文件 | 说明 |
| --- | --- | --- |
| 🪟 Windows | `WeekLog Setup {{版本号}}.exe` | NSIS 安装包，支持自定义安装路径 |
| 🍎 macOS (Apple Silicon) | `WeekLog-{{版本号}}-arm64.dmg` | M1/M2/M3/M4 芯片 |
| 🍎 macOS (Apple Silicon) | `WeekLog-{{版本号}}-arm64-mac.zip` | 自动更新用的增量包，普通用户无需下载 |

---

## ⚠️ macOS 用户必读：解决"已损坏，无法打开"提示

本应用是开源、免费的桌面软件，**没有购买 Apple 付费开发者签名**（$99/年）。
macOS 的安全机制（Gatekeeper）会给从浏览器下载的未签名应用自动加上隔离标记，
导致打开时提示 **"已损坏，应移到废纸篓"**。

**这并不是文件真的损坏了**，去掉隔离属性即可正常安装：

**方法一：对 dmg 文件操作（推荐，安装前执行）**

```bash
xattr -cr ~/Downloads/WeekLog-{{版本号}}-arm64.dmg
```

然后重新双击 dmg 拖入「应用程序」即可。

**方法二：对已安装的 App 操作（已拖进应用程序但打不开时）**

```bash
sudo xattr -cr /Applications/WeekLog.app
```

> 💡 `xattr` 是 macOS 自带命令，`-c` 清除扩展属性、`-r` 递归处理包内所有文件，
> 不会修改应用本身，安全可放心使用。
> Windows 用户无需此操作。

---

## ✨ 本次更新（v{{版本号}}）

<!-- 在这里填本次版本的新功能 / 修复，例如：
- 🆕 新增 XXX
- 🐛 修复 YYY
- ⚡ 优化 ZZZ
-->
``