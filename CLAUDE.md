# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

WeekLog 是一个 Electron 桌面应用：读取本地 Git 仓库 commit + 人工笔记，经 AI 融合生成结构化周报/日报。本地优先，仅调用 LLM 时联网。

> 另见 `AGENTS.md`（贡献者指南，含代码风格与提交规范）。本文件聚焦命令与跨文件架构。

## 常用命令

包管理器是 **pnpm**（`packageManager: pnpm@11.6.0`）。应用外壳已从 Electron 迁移到 **Tauri 2**（Rust 后端在 `src-tauri/`，渲染层仍是 React + Vite）。

```bash
pnpm tauri:dev              # 启动 Tauri 应用（拉起 Vite dev server + Rust 后端，HMR）
pnpm dev:renderer           # 仅 Vite dev server（Electron 口味，端口 5173）
pnpm dev:renderer:tauri     # 仅 Vite dev server（Tauri 口味，端口 1430）
pnpm build:renderer         # 仅打包渲染层 → src/renderer/dist/
pnpm build:renderer:tauri   # 同上，但走 Tauri 桥接（WEEKLOG_TAURI=1）
pnpm typecheck              # tsc --noEmit（仅检查 src/renderer/src 下的 TS）
pnpm tauri:build            # 编译 Rust 后端 + 打包安装器 → src-tauri/target/release/bundle/
                            #   Windows: nsis/*.exe + msi/*.msi；macOS: dmg/*.dmg + macos/*.app
pnpm tauri:dist:mac         # macOS 签名打包（scripts/tauri-build-signed.sh；默认自签名 WeekLog Dev）
```

> 注：`src/main/` 下仍保留旧的 Electron 主进程源码（CommonJS），仅供 `tests/` 里的 Node 冒烟测试引用，**不参与 Tauri 构建**。Tauri 后端逻辑在 `src-tauri/src/`（对齐 `src/main/` 的模块拆分）。

### 测试

没有聚合 `test` 脚本，也没有测试框架。测试是**独立可执行的 Node 脚本**，直连 `src/main/` 核心逻辑、不依赖 Electron。逐个运行：

```bash
node tests/_smoke.js                  # 核心逻辑冒烟（git 解析/笔记/聚合/Prompt/渲染）
node tests/_security_regression_test.js
node tests/_secrets_test.js
node tests/_auto_update_test.js
node tests/_icon_assets_test.js
node tests/_gitreal.js                # 对真实 git 仓库跑采集
```

新测试命名为 `tests/_<area>_test.js` 或 `tests/_<area>.js`，自带 `pass/fail` 计数并打印结果。

## 架构总览

### 三进程边界（Electron）

- **主进程** `src/main/`：Node 环境，**CommonJS**（`require`），文件头带 `// @ts-check`，2 空格缩进、无分号。
- **preload** `src/preload/index.js`：通过 `contextBridge` 暴露 `window.weeklog.*`。渲染层**不直接碰 Node/IPC**，只调这个桥。
- **渲染层** `src/renderer/src/`：React 19 + TypeScript + **ESM**，Vite 构建，`@/*` 别名指向 `src/renderer/src`。安全模型为 `contextIsolation + sandbox + nodeIntegration:false`。

**跨边界加功能必须三处同改**：`src/main/ipc.js`（`ipcMain.handle` 处理器）↔ `src/preload/index.js`（`window.weeklog` 方法）↔ `src/renderer/src/types/weeklog.d.ts`（前端类型）。`ipc.js` 是所有主进程能力的唯一汇聚点。

### 核心领域流水线（生成报告）

`src/main/pipeline.js` 编排，跨多个模块：

```
collectRepo (git.js)  →  loadNotes (notes.js)  →  aggregate (aggregator.js)  →  并发 AI 总结 (llm/)  →  render (render.js)
   git log 采集            Markdown 笔记            按(日期,项目)分桶+笔记融合      失败降级为原文拼接      text/md/json
```

- **`git.js`**：`child_process` 直调 `git log`，用 `0x1e`(记录) / `0x1f`(字段) 分隔解析（零依赖、编码可控）。commit message 分级解码 UTF-8 → GBK → GB18030。还提供 `scanGitRepos`（深度≤3 扫描）。
- **`aggregator.js`**：核心融合规则——项目级笔记进对应项目桶；通用笔记（`project=null`）注入当天**所有**桶的 `sharedNotes` + 兜底形成独立的【日常工作】段。仓库可设 `alias` 显示名。
- **`pipeline.js`**：`collect()` 是不调 AI 的 dry-run（仪表盘统计/token 预估用）；`generate()` 是完整链路。AI 调用用**有限并发 worker 池**（`cfg.ai.concurrency`），单桶失败时 `fallbackSummary` 降级为 commit subject + 笔记原文，整份报告仍产出。
- **`llm/`**：`createProvider(cfg, apiKey)` 工厂返回厂商无关的 provider（`summarize(system, user)`）。`base.js` 含异常体系 + 指数退避重试；`openai.js`（Responses API）、`anthropic.js`（Messages API）。Prompt 工程集中在 `llm/index.js`（`SYSTEM_PROMPT` + `buildUserPrompt`）。

### 配置与密钥

- **`config.js`**：单个 `config.json` 存于 Electron `userData`。`defaultConfig()` 是 schema 的**唯一真相源**；加载时深合并（对象逐层合并、数组整体替换）。
- **API Key 绝不落盘**。`resolveApiKey` 优先读 `secrets.js`（系统钥匙串 `safeStorage`，provider ∈ `openai/anthropic/webdav`），回退环境变量（`WEEKLOG_OPENAI_KEY`/`OPENAI_API_KEY`，Anthropic 同理）。WebDAV 密码同样走 secrets。

### 横切子系统

- **后台任务** `tasks.js`：跨页面持久的任务列表，经 `task:update` 推送到渲染层。生成报告、WebDAV 同步、记忆重建、模型下载都建任务。
- **AI 记忆** `memory.js`：本地向量嵌入（`@huggingface/transformers` + ONNX），模型源 `auto` 探测魔搭/HuggingFace。报告生成后 fire-and-forget 入嵌入队列；提供语义检索 + 写笔记时推断项目。
- **WebDAV** `webdav.js`：双向同步（pull/push/both）、去重、冲突告警。**启动自动拉取、退出自动推送**（见 `index.js` 的 `triggerAutoSync`，退出推送有 8s 超时保护）。
- **自动更新** `updater.js`：基于 `electron-updater`（GitHub provider，仓库 `kiritoko1029/ai-week-log`）。

- **AI 小记（Skill + MCP，仅 Tauri 后端）** `src-tauri/src/`：取代旧的 Codex/ZCode hook 子系统。
  - `mcp.rs`：内置 MCP HTTP 服务（`rmcp` `StreamableHttpService` 挂 `axum`，仅绑 `127.0.0.1:{mcp.port}`，Bearer token 校验，token 存钥匙串 provider `weeklogMcp`）。暴露 `submit_conversation` 工具：收到 agent 经 skill 发来的「已清洗对话」（仅 user+assistant）→ 用「小记总结模型」（`cfg.noteSummary`）总结成一条中文小记 → 入统一待处理池。按 `cfg.mcp.enabled/port` 启停。
  - `notes_pool.rs`：统一待处理池 `ai-notes-pending.json`（item 带 `source`），含 `list/delete/write/summarize` 与 `match_project` 归类、`sanitize_summary` 清洗。人工在前端确认后才写入 `notes/YYYY-MM-DD.md`。
  - `integration.rs`：一键 `install/uninstall/status`，对 codex/claude/zcode 依次「清旧 hook 工件 → 写 skill（注入 `weeklog.json` 的 endpoint+token）→ 注册 MCP 到各 agent 配置（codex `config.toml` / claude `~/.claude.json` / zcode `config.json`，写前备份）」。
  - 内置 skill 打包在 `src-tauri/resources/skill/`（`SKILL.md` + 零依赖的 `record-note.mjs`：定位/解析 transcript、抽取 user+assistant 文本去思考/工具、手写最小 MCP 客户端调 `submit_conversation`）。

> ⚠️ 以上「架构总览」描述的是**旧 Electron 主进程**（`src/main/`）。当前生效的外壳是 **Tauri 2**，后端在 `src-tauri/src/`，模块拆分与 `src/main/` 一一对应（如 `updates.rs` 对 `updater.js`——Tauri 版改为**手动 GitHub 流程**，不再用 `electron-updater`；AI 小记改为上面的 `mcp.rs`/`notes_pool.rs`/`integration.rs`，不再用 hook）。新功能请改 `src-tauri/src/`。

### 主进程窗口/生命周期（`index.js`）

- 两个渲染入口：`index.html`（主窗口）+ `quicknote.html`（全局快捷键 `Cmd/Ctrl+Shift+L` 唤起的无边框浮窗）。
- **关闭窗口=最小化到托盘**（非退出）；真正退出走托盘菜单。
- 窗口加固：`will-navigate` 用 `isAllowedRendererUrl` 白名单拦截、`setWindowOpenHandler` 拒绝新窗口。外链经 `shell:openExternal` 仅放行 http/https。

## 关键约束（易踩坑）

- **Vite `base: './'` + `stripCrossorigin` 插件**：Electron 用 `file://` 加载产物，绝对路径与 `crossorigin` 属性都会导致黑屏。改 `vite.config.ts` 时勿破坏相对路径。
- 渲染层版本号用编译期常量 `__APP_VERSION__`（构建时从 `package.json` 注入），不要硬编码。
- 主进程是 CommonJS，渲染层是 ESM——别在 `src/main/` 用 `import`，别在渲染层用 `require`。
- 发布：推送 `v*` tag 触发 GitHub Actions（macos-14 + windows-latest 矩阵）产出双平台产物并附到 Release。
