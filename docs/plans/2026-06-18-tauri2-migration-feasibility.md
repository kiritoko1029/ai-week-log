# WeekLog → Tauri 2 迁移可行性评估

## Goal

评估将 WeekLog 从 Electron 迁移到 Tauri 2 的技术可行性、工作量分布、收益与风险。本评估采用用户确认的最彻底路线假设：**主进程逻辑用 Rust 全量重写**，**本地 ONNX 嵌入用 Rust `ort` crate 重写**。文档仅作决策依据，不涉及代码改动。

Tauri 2.0 于 2024-10-02 正式发布，截至 2026-06 桌面端已成熟；文档站 `v2.tauri.app`，要求 Rust ≥ 1.77.2。

## Baseline（现状基线）

| 维度 | 现状 |
|---|---|
| 外壳 | Electron `^42.4.0` + electron-builder `^26.15.3` |
| 打包 | Windows NSIS x64；macOS dmg+zip arm64-only；发布到 GitHub Releases；**无任何代码签名配置** |
| 主进程 | `src/main/` 下 32 个 CommonJS 模块（index/ipc/git/pipeline/aggregator/render/notes/preferences/memory/chat/tasks/webdav/local-backup/proxy/updater/secrets/config/logger/codex-* × 4 / zcode-* × 4 / icon/utils/llm/*） |
| 渲染层 | React 19 + Vite 8 + TypeScript 5.9 + Tailwind 4 + shadcn/Radix；纯 Web 栈 |
| 桥接 | `window.weeklog` 单一对象，约 75 个 `invoke` 通道 + 5 个事件流 + 1 个 `send` |
| 原生依赖 | **无任何 `.node` 模块**（无 keytar / better-sqlite3 / sharp / node-pty 等）。唯一的"重"依赖是 `@huggingface/transformers ^4.2.0`（JS + WASM/ONNX，在主进程跑语义检索） |
| 安全存储 | `electron.safeStorage`（Win DPAPI / macOS Keychain 加密）→ 落盘 `secrets.json`（非钥匙串逐条目存储） |
| 自动更新 | Windows 走 electron-updater（GitHub Releases）；macOS 因未签名走自写 bash dmg 安装脚本 |

## Renderer 迁移评估 🟢 低

这是迁移中最干净的部分。**整个 `src/renderer/src/` 源码零 Node/Electron API 调用**（grep `ipcRenderer|require('fs'|'electron')|__dirname|process.platform` 无命中）。所有原生能力都收敛到 `window.weeklog` 这一个对象上（`src/renderer/src/lib/api.ts:7`，类型定义于 `src/renderer/src/types/weeklog.d.ts`）。

需要机械替换的改动点：

1. **桥接重实现** —— `lib/api.ts` 由 `window.weeklog` 改为手写对象：方法体调 `@tauri-apps/api/core` 的 `invoke('config_get', ...)`，事件方法调 `@tauri-apps/api/event` 的 `listen()`。`WeeklogAPI` 类型与全部实体接口原样保留，**所有页面/组件零改动**。
2. **拖拽区属性** —— `data-app-region="drag"` / `"no-drag"`（AppShell.tsx:126,170,205、Statusbar.tsx:75,89、quicknote.tsx:91,99 及 `styles/globals.css:122-125`）→ `data-tauri-drag-region`。
3. **双窗口** —— Vite 两个入口（index.html + quicknote.html）对应两个 `WebviewWindow`（label 区分）。注意授予 capability `webview:allow-create-webview-window`，这是多窗口最常见的坑。
4. **平台判断** —— `navigator.platform`（App.tsx:17、useShortcut.ts:7、SettingsPage.tsx:606,1593）在 WebView 里仍可用，建议换 `navigator.userAgentData` 或 Tauri OS 插件以避免弃用告警。
5. **Vite 配置** —— `base: './'` 保留无害；`stripCrossorigin` 插件（vite.config.ts:15-26，为 `file://` 而生）可删可留；`__APP_VERSION__` define 保留；接入 `@tauri-apps/cli` 作为 dev runner（`tauri dev` 默认拉起 Vite，HMR 照常）。

Vite 配置里**无 dev proxy**（渲染层从不直接发 HTTP），无 electron-vite / vite-plugin-electron——是一个纯 Web Vite 应用，这极其理想。

## 主进程逐模块评估

采用三档难度：🟢 直接移植 / 🟡 需重设计 / 🔴 架构级挑战。

| 模块 | 现状 | Rust 方案 | 难度 |
|---|---|---|---|
| `index.js` | BrowserWindow/Tray/Menu/globalShortcut/Notification/原生主题 | Tauri 2 均原生支持（多窗口、托盘、全局快捷键、通知插件）；窗口生命周期等价 | 🟢 |
| `git.js` | `spawnSync('git', [...])` + 自定义 `\x1e`/`\x1f` numstat 解析 | `std::process::Command` + 逐字节移植解析（`scanGitRepos` 的 BFS 目录扫描用 `walkdir`） | 🟢 |
| `config.js` | `config.json` 读写/合并 + 默认值 | `serde_json` + `tauri::path::app_data_dir` | 🟢 |
| `preferences.js` | `preferences.json` + AI 规则抽取 | 同上 | 🟢 |
| `notes.js` | 每日 markdown `notes/YYYY-MM-DD.md` | `std::fs` | 🟢 |
| `render.js` | 纯字符串渲染（compact/text/md/json + 格式转换） | 纯 Rust 字符串处理 | 🟢 |
| `aggregator.js` | 按 (day, project) 聚合 commit + note | 纯 Rust 数据处理 | 🟢 |
| `tasks.js` | 进程内任务注册表 + `task:update` 事件 | `tauri::State` + `app.emit` | 🟢 |
| `logger.js` | JSONL 日志 + 环形缓冲 | `tracing` 或自写 | 🟢 |
| `utils.js` | 日期/token 纯工具 | 纯 Rust | 🟢 |
| `icon.js` | 运行时用 zlib 生成托盘 PNG buffer | `image` crate 或保留为静态资源 | 🟢 |
| `webdav.js` | `fetch` PROPFIND/MKCOL/PUT/DELETE + gzip + SSRF 防护 | `reqwest_dav` crate（异步、reqwest 基座）；SSRF 白名单逻辑需重写在 reqwest 层 | 🟢 |
| `local-backup.js` | **手写 ZIP 编码器**（CRC32 表 + 本地/中央目录）+ 写 Downloads | 直接移植或换 `zip` crate | 🟢 |
| `proxy.js` | undici ProxyAgent + 全局 http(s) Agent | 在 reqwest client 构造层注入 proxy | 🟢 |
| `ipc.js` | ~75 个 `ipcMain.handle` | 每个变 `#[tauri::command]`（见下节映射） | 🟡（量大但机械） |
| `pipeline.js` | 采集→AI 摘要→渲染编排 | Rust 编排；依赖 LLM 模块 | 🟡 |
| `llm/*` | 全局 `fetch` POST + SSE 流式（`stream.js:getReader()`） | **`tauri-plugin-http` 不能流式（会全量缓冲）**；必须 Rust `reqwest` + `tauri::ipc::Channel` 推送 token（见难点②） | 🟡 |
| `chat.js` | 流式会话 + RAG + AbortController | Rust 编排 + Channel 流式 + cancel 令牌 | 🟡 |
| `codex-hook-server.js` / `zcode-hook-server.js` | `http.createServer` 绑 127.0.0.1:17321 / :17322，Bearer 鉴权 | Rust `axum` 内嵌重建（见难点外的说明）；或 sidecar 隔离运行时 | 🟡 |
| `codex-hook-config.js` / `zcode-hook-config.js` | 写 `~/.codex/hooks.json` / `~/.zcode/...` 插件包 + 注入 node hook 脚本 | 文件写入移植；但注入的 hook 脚本本身是 `node -e` + `git diff`——外部 Codex/ZCode CLI 执行它，需保证目标机器有 node，或改写为不依赖 node 的脚本 | 🟡 |
| `secrets.js` | `electron.safeStorage` → `secrets.json` | `keyring` crate（OS 钥匙串逐条目）；**需设计 `secrets.json` → keyring 迁移路径** | 🟡 |
| `updater.js` | Win: electron-updater；Mac: 自写免签名 dmg 脚本 | `tauri-plugin-updater`（minisign 强制签名）；**与 Electron updater 不互通，需桥接版本**（见难点③） | 🔴 |
| `memory.js` | **`@huggingface/transformers` 本地 ONNX 推理**（`multilingual-e5-small`）+ 混合检索 + HF/ModelScope 模型下载 fallback | **Rust `ort` crate 重写**（用户选定路线，见难点①） | 🔴 |

## IPC 迁移映射

渲染层只消费 `window.weeklog`，全部通过 `api.ts` 一点重实现即可。映射规则：

- 每个 `ipcMain.handle('xxx:yyy')` → `#[tauri::command] async fn xxx_yyY(...) -> Result<T, String>`，JS 侧 `invoke('xxx_yyY', {...})`。
- 5 个事件流（推送型）→ Rust `app_handle.emit("event", payload)` + JS `listen("event", cb)`（返回 unlisten）：
  - `generate:progress` ← `onProgress`
  - `chat:stream` ← `chat.onStream`
  - `task:update` ← `tasks.onUpdate`
  - `updates:update` ← `updates.onUpdate`
  - `quicknote:show` ← `quicknote.onShow`
- 1 个 `send`（`quicknote:hide`）→ 单向 command。

对于 LLM token 流这种连续增量数据，推荐用 **`tauri::ipc::Channel<T>`**（2.0 头号新特性）而非事件系统——前端创建 Channel 传入 command，Rust 侧反复 `channel.send(...)`。

通道清单见 `src/preload/index.js`（约 75 项），类型契约见 `src/renderer/src/types/weeklog.d.ts`（`WeeklogAPI` 接口，564-720 行）。SettingsPage 是最大消费者（约占一半面）。

## 三大难点深入分析

### 难点①：本地嵌入 `ort` 重写（memory.js）🔴

**为何是最大挑战**：当前 `memory.js:201` 用 `@huggingface/transformers` 在主进程内跑 `feature-extraction` ONNX pipeline（`multilingual-e5-small`），含：

- 模型下载（HF → ModelScope fallback，带连通性探测，`memory.js:129-189`）
- 模型缓存于 `userData/models`
- 分词 → ONNX 推理 → mean pooling → L2 归一化 → 余弦相似度混合检索
- 与 `embeddingSource:'api'` 双源并存

**Rust 重写要点（用户选定路线）**：
- 用 `ort` crate 加载同一 `model.onnx`；`tokenizers` crate 加载 `tokenizer.json`，**必须与 JS 版分词结果逐 token 对齐**（这是最容易出错的地方，e5 系列对前缀 `query:`/`passage:` 敏感）。
- Pooling/归一化是确定数学运算，移植无歧义。
- 模型下载 fallback：用 `reqwest` 重写 HF/ModelScope 两源探测。
- 缓存目录迁移：可复用 `userData/models`，模型文件本身跨运行时通用。
- **风险**：向量维度/数值若与历史已存向量不一致，会导致检索质量退化，可能需要重建索引。建议保留重建能力（对应 `memory.rebuild`）。

**备选**（本次不采用，但记录）：API embedding（已支持，最省事但需联网+成本）、Node sidecar 保留 Transformers.js（逻辑零改但弱化 Tauri 优势）。

### 难点②：LLM 流式（reqwest + Channel）🟡

**问题**：`tauri-plugin-http` **不支持流式响应**，会全量缓冲后再返回（官方 issue plugins-workspace #2129）。当前 `chat.js`/`llm/stream.js` 依赖 SSE 增量推送 token，直接用该插件会破坏打字机效果。

**方案**：LLM HTTP 调用全部下沉到 Rust，用 `reqwest` 的 `bytes_stream()` + SSE 解析（`eventsource-stream` 或手写），token 经 `tauri::ipc::Channel` 推到前端。这反而是更好的设计——API key 不进 WebView、cancel 用 Rust 的取消令牌等价 AbortController。

涉及模块：`llm/stream.js`、`llm/base.js`（retry/backoff）、`llm/openai.js`（Responses API + reasoning 流）、`llm/anthropic.js`（Messages API）、`chat.js`（RAG 编排 + session 存储 `chats.json`）。

### 难点③：自动更新断层 + 签名 🔴

**断层**：Electron 的 `electron-updater` 与 Tauri 的 `tauri-plugin-updater` **完全不互通**。老用户无法被自动迁到 Tauri 版。需要规划"桥接版本"：在最后一个 Electron 版本里提示用户手动下载 Tauri 版（Fluxzy 迁移案例显示即使如此，仍有用户长期滞留旧版）。

**Tauri updater 特性**：
- **minisign 签名强制**（`tauri signer generate`，公钥进 `tauri.conf.json`，私钥经 `TAURI_SIGNING_PRIVATE_KEY` 环境变量，**不能用 .env**）。
- 支持动态服务器或静态 JSON（GitHub Releases 的 `latest.json`）。
- 自动产出各平台 `.sig`（Win: `.msi`/NSIS + sig；Mac: `.app.tar.gz` + sig；Linux: `.AppImage` + sig）。

**两个关键坑**：
1. **Windows 两遍签名顺序**：Authenticode 会改写二进制导致 minisign `.sig` 失效。正确顺序是 **Authenticode 先签 → 再重新生成 `.sig`**。官方文档未明说，Fluxzy 案例踩过。错则静默失效。
2. **macOS 现状不匹配**：当前 `package.json` mac 块**无任何签名/公证配置**，所以现在才走自写免签名 dmg 脚本。迁 Tauri 后要么补齐 Apple Developer ID + notarization（Apple Developer Program 付费），要么放弃官方更新器走自写流程（但 Tauri 强制签名，绕不过）。

## 收益 vs 成本

### 收益
- **包体积**：Fluxzy 实测安装包 ↓ 约 70%（190MB→55MB）。Electron 运行时被系统 WebView 替代。
- **空闲内存**：显著下降。
- **冷启动/文件打开**：更快。
- **安全模型**：Tauri 的 capability + scope 权限模型比手写 paranoid IPC 更系统（"框架替你偏执"）。
- **IPC 类型往返**：serde 自动序列化，比 contextBridge + 手写类型更省。

### 成本
- **Rust 全量重写**：32 模块，周/月级工作量。
- **`ort` 嵌入重写**：分词对齐是高风险点。
- **签名/公证一次性投入**：Windows 证书（EV/ OV/ Azure Trusted Signing）+ Apple Developer Program。
- **构建链变更**：Rust 工具链、`tauri build`、跨平台 CI 重配；Windows 自托管 runner 需 pin host triple（Fluxzy 踩过 `dlltool.exe not found`）。
- **跨 WebView 测试**：WebView2(Win)/WKWebView(Mac)/WebKitGTK(Linux) 行为不一，不像捆绑 Chromium 稳定；本项目是保守 React UI，回归风险低，但仍需三平台实测。
- **更新器断层**：必然有部分用户滞留旧版。

### 净评估
渲染层近乎零成本，收益主要来自外壳。**当前 Electron 实现运行良好且无原生依赖负担**，迁移的唯一硬动机是体积/内存与安全模型；是否值得取决于这些收益对项目的权重。建议先做最小骨架验证再决定全量投入。

## 分阶段路线（参考，不在本次执行）

1. **骨架验证**：建 Tauri 2 工程，跑通 React 渲染层 + 1~2 个 command（如 `config_get`），双窗口、托盘、快捷键。
2. **IO/纯逻辑移植**：config/preferences/notes/render/aggregator/logger/utils/git/webdav/local-backup。
3. **IPC 批量迁移**：按 `ipc.js` 通道清单逐批转 command，桥接 `api.ts` 同步更新。
4. **LLM 流式**：reqwest + Channel，覆盖 chat/generate/ai:test。
5. **嵌入 ort 重写**：memory.js 全套，含模型下载与索引重建。
6. **Hook 服务器**：axum 内嵌 17321/17322 + hook-config 文件写入。
7. **更新器与签名**：minisign + Authenticode/Apple 公证，规划桥接版本。
8. **双轨切换**：老用户引导，数据兼容验证，正式发布。

## Risks / Open Questions

- **签名证书**：Windows 需 EV/OV/Azure Trusted Signing 之一；macOS 需 Apple Developer ID（付费）。当前两者皆无。
- **macOS 架构**：现仅 arm64-only，是否补 x86_64 / universal？
- **嵌入索引兼容**：ort 重写后向量若与历史不一致，需强制 `memory.rebuild`，用户数据迁移策略？
- **Codex/ZCode hook 注入脚本**：依赖目标机有 node；Tauri 版是否仍假设用户装了 node，或改写为无 node 脚本？
- **WebView2 引导 UX**：Windows 无 WebView2 时安装体验差（Issue #4389），Win10/11 实测普遍预装，但需确认。
- **更新断层**：可接受多少比例用户滞留旧 Electron 版？

## Conclusion

**技术上可行。** 渲染层近乎零成本（零 Node/Electron API、单一桥接点、纯 Web 栈）；主要工作量在主进程 Rust 全量重写，其中绝大多数模块是直接移植，真正的架构级挑战只有三项：**本地嵌入 `ort` 重写**（最高风险，分词对齐）、**LLM 流式下沉 Rust + Channel**、**自动更新断层与签名体系重建**。无任何原生 `.node` 依赖是迁移的有利前提。建议先做最小骨架验证（渲染层 + 1~2 command），再据实际手感决定是否全量推进。

## Sources

- Tauri 2 官方文档：https://v2.tauri.app/ （updater / shell sidecar / http-client / fs / system-tray / window-menu / global-shortcut / signing windows & macos）
- Updater 签名强制与两遍签名坑：https://v2.tauri.app/plugin/updater/
- HTTP 插件不支持流式：https://github.com/tauri-apps/plugins-workspace/issues/2129
- IPC commands + Channel（2.0 头号新特性）：https://v2.tauri.app/develop/calling-rust/ , https://v2.tauri.app/concept/inter-process-communication/
- Node.js as a sidecar（备选路线参考）：https://v2.tauri.app/learn/sidecar-nodejs/
- Fluxzy Electron→Tauri 五个月实战（包体积 70%↓、签名顺序坑、更新断层）：https://www.fluxzy.io/resources/blogs/electron-to-tauri-migration-fluxzy-desktop
- `ort` crate（Rust ONNX Runtime）：https://docs.rs/ort
- `reqwest_dav` crate（WebDAV）：https://lib.rs/crates/reqwest_dav
- `keyring` crate（OS 钥匙串，等价 safeStorage）：https://crates.io/crates/keyring
- Tauri 内嵌 axum HTTP 服务器实例：https://docs.rs/tauri-plugin-axum , https://www.reddit.com/r/tauri/comments/1s4ah2f/
