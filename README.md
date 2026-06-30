# WeekLog — Git 周报/日报生成桌面客户端

[![GitHub release](https://img.shields.io/github/v/release/kiritoko1029/ai-week-log?label=release)](https://github.com/kiritoko1029/ai-week-log/releases)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

[English](./README.en.md) | 简体中文

读取本地 Git 仓库的 commit 提交日志，结合**人工笔记**（会议、沟通、设计、调研等非代码工作），通过 AI 自动融合总结，生成结构化《工作周报》/《日报》。

- **双信息源融合**：commit（代码工作）+ 笔记（非代码工作）一并送 AI，按「日期 → 项目」两级组织，每段 3–5 句。
- **双 LLM 后端**：OpenAI Responses API / Anthropic Messages API，配置一行切换，内置连接测试。
- **AI 记忆系统**：本地向量嵌入（Transformers.js + ONNX）+ 语义检索，跨周报累积上下文，写笔记时自动推断相关项目。
- **AI 小记（Skill + MCP）**：为 Codex / Claude Code / ZCode 一键安装 skill 并注册本地 MCP 服务；对话收尾时把「用户提问 + AI 回复」回传 WeekLog，由可配置的「小记总结模型」总结成中文小记，进入待处理池，人工确认后写入笔记。
- **WebDAV 云同步**：笔记 / 配置 / 历史记录多端同步，自动去重 + 冲突告警。
- **跨平台桌面应用**：macOS（Apple Silicon / arm64）+ Windows（x64）。
- **本地优先**：仅在调用 LLM 时产生网络请求；笔记、配置、记忆均存本地。

---

## 技术栈

- **Electron** 主进程（Node）+ 渲染进程（Web）
- **渲染层**：React 19 + TypeScript + Vite + Tailwind CSS v4 + shadcn/ui（Radix Primitives）
- **Git 采集**：`child_process` 直调 `git log`，按 `0x1e/0x1f` 分隔解析（编码可控、零依赖）
- **LLM 调用**：Node 内置 `fetch`，直连 OpenAI `/responses` 与 Anthropic `/v1/messages`，带指数退避重试
- **向量嵌入**：`@huggingface/transformers`（ONNX Runtime），模型源可自动探测（魔搭 ModelScope / HuggingFace）
- **安全存储**：API Key 走系统钥匙串（Windows DPAPI / macOS Keychain），明文不落盘

---

## 功能一览

| 模块 | 说明 |
|---|---|
| 仪表盘 | 本周统计（commits / 笔记 / token 预估）、快速记一笔、一键生成 |
| 生成周报 / 日报 | 自定义时间范围、作者过滤、merge 策略、输出格式（text / md / json），报告支持手动编辑更正 |
| 今日日报 | 基于当天笔记快速生成（纯非代码工作日也能产出） |
| 笔记管理 | 按日期时间线浏览、搜索式项目下拉、AI 记忆推断辅助归类、原始 Markdown 编辑 |
| 仓库管理 | 手动添加 + **文件夹扫描**（自动发现 3 层内的 Git 仓库，批量勾选导入） |
| 历史记录 | 查看历史报告、**手动编辑保存**（标记「已编辑」）、复制 / 导出 |
| AI 与输出设置 | provider 切换、模型 / baseUrl / temperature、**连接测试**、笔记目录、输出格式、并发与容错 |
| WebDAV 同步 | 双向同步（pull / push / both）、状态面板、密码加密存储 |
| AI 记忆 | 本地向量库、跨报告累积、语义检索注入、可查看 / 重建 / 删除 |
| AI 小记 | 一键为 Codex / Claude Code / ZCode 安装 skill + 注册本地 MCP 服务；对话收尾自动总结成小记进待处理池，人工确认后写入笔记 |
| 快速记笔记 | 全局快捷键唤出浮窗（默认 `Cmd/Ctrl+Shift+L`），随时记，自动归类项目 |

---

## 目录结构

```
ai-week-log/
├── package.json                # 入口 + 脚本
├── src/
│   ├── main/                   # 主进程（Node 环境）
│   │   ├── index.js            # 窗口创建、生命周期、托盘、全局快捷键
│   │   ├── ipc.js             # IPC 处理器（配置/仓库/笔记/采集/生成/历史/同步/记忆/AI 测试）
│   │   ├── config.js           # 配置加载/保存（JSON，存 userData）
│   │   ├── git.js              # git log 采集 + 0x1e/0x1f 解析 + 仓库扫描
│   │   ├── notes.js            # 笔记 Markdown 读写（## 项目分段）
│   │   ├── aggregator.js       # (日期,项目) 分桶 + 笔记融合分配
│   │   ├── pipeline.js         # 编排：collect / generate / 记忆入队
│   │   ├── render.js           # text / md / json 渲染
│   │   ├── tasks.js            # 后台任务系统（跨页面持久）
│   │   ├── webdav.js           # WebDAV 同步（双向、去重、冲突告警）
│   │   ├── memory.js           # AI 记忆（向量嵌入、语义检索、重建）
│   │   ├── secrets.js          # API Key 加密存储（safeStorage）
│   │   ├── utils.js            # 日期、token、范围解析
│   │   └── llm/                # LLM 适配层
│   │       ├── base.js         # 抽象 + 异常体系 + 指数退避重试
│   │       ├── openai.js       # OpenAI Responses API
│   │       ├── anthropic.js    # Anthropic Messages API
│   │       └── index.js        # 工厂 + Prompt 工程 + 连接测试
│   ├── preload/index.js        # contextBridge 安全桥（window.weeklog）
│   └── renderer/               # 渲染层（React + Vite）
│       ├── index.html          # 主窗口入口
│       ├── quicknote.html      # 快速记笔记浮窗入口
│       └── src/
│           ├── App.tsx         # 根布局
│           ├── pages/          # 仪表盘 / 生成 / 日报 / 笔记 / 仓库 / 历史 / 设置
│           ├── components/     # AppShell / Statusbar / ProjectSelect / ui（shadcn）
│           ├── hooks/          # useConfig / useGenerate / useTasks / useNav ...
│           └── styles/         # Tailwind + CSS 变量（亮 / 暗主题）
├── build/                      # 应用图标（icns / ico / png）+ NSIS 安装脚本
├── PRD.md / PLAN.md
└── weeklog-desktop-app.html    # UI 设计原型
```

---

## 开发与运行

### 1. 安装依赖

```bash
pnpm install
```

> 项目用 pnpm 管理依赖（`packageManager: pnpm@11.6.0`）。首次安装时 pnpm 会提示是否批准部分依赖的构建脚本（如 `onnxruntime-node`、`sharp`），AI 记忆功能依赖 `onnxruntime-node`，建议批准。

### 2. 配置 API Key

两种方式（任选其一；软件内填写优先级更高）：

**方式 A — 软件内填写（推荐）：** 启动应用 →「AI 与输出设置」→ API Key 输入框直接填写并保存，可点「测试连接」即时验证。密钥用系统钥匙串加密存储，不明文落盘。

**方式 B — 环境变量：**

**Windows（PowerShell，永久，需重开应用）：**
```powershell
setx ANTHROPIC_API_KEY "sk-ant-..."
# 或 OpenAI
setx OPENAI_API_KEY "sk-..."
```

**macOS（zsh，永久）：**
```bash
echo 'export ANTHROPIC_API_KEY="sk-ant-..."' >> ~/.zshrc
source ~/.zshrc
```

### 3. 启动应用

```bash
pnpm tauri:dev        # 启动 Tauri 应用（Vite dev server + Rust 后端，HMR）
```

首次启动后：**仓库管理 → 添加仓库 / 扫描文件夹**（注册本地 Git 仓库并命名项目）→ 在「AI 与输出设置」选择 provider/模型（可测试连接）→ 即可在「生成周报/日报」一键生成。

---

## 打包发布

```bash
pnpm tauri:build        # 编译 Rust + 打包安装器 → src-tauri/target/release/bundle/
                        #   Windows: nsis/*.exe + msi/*.msi
                        #   macOS:   dmg/*.dmg（+ macos/*.app）
pnpm tauri:dist:mac     # macOS 签名打包（默认自签名 WeekLog Dev；详见 docs/signing-macos.md）
```

> ⚠️ macOS 包须在 macOS（Apple Silicon）上构建；Windows 包在 Windows 上构建。推送 `v*` tag 会触发 GitHub Actions（`.github/workflows/release.yml`，macos-14 + windows-latest 矩阵）自动产出双平台安装包并附到 Release。macOS 签名凭据通过 `APPLE_CERTIFICATE` / `APPLE_CERTIFICATE_PASSWORD` Secrets 注入（见 docs/signing-macos.md「CI」）。

---

## 使用流程

1. **添加仓库**：仓库管理 → 添加仓库 / 扫描文件夹 → 浏览选择本地 Git 目录 → 命名项目（如「某某系统前端」）。
2. **记笔记**（可选但推荐）：仪表盘 / 笔记管理 → 快速记一笔，选关联项目或留空（=日常工作）。笔记存为 `notes/YYYY-MM-DD.md`，可用 `## 项目名` 分段。
3. **生成**：
   - 仪表盘「一键生成」→ 本周周报
   - 「今日日报」→ 当天日报（纯非代码工作日也能基于笔记生成）
   - 「生成周报/日报」→ 自定义范围 / 过滤 / 格式；**生成后可直接在预览区编辑更正**
4. **融合规则**：项目级笔记归对应项目段；通用笔记注入当天所有项目段 + 形成【日常工作】独立段。
5. **回顾 / 修订**：历史记录查看往期报告，支持手动编辑并保存（标记「已编辑」）。

---

## 输出示例

```
2026/6/15
【某某系统前端】：根据产品评审意见更新了订单详情页字段布局，新增状态筛选组件，修复分页跳转参数丢失缺陷。
【某某系统后端】：新增订单列表接口的分页与状态过滤，对高频查询加入复合索引，P95 由 820ms 降至 210ms。
【日常工作】：上午参加架构评审讨论微服务拆分边界，下午与产品确认本周排期。（来自人工笔记）

2026/6/16
……
```

---

## 容错

- AI 调用失败（超时 / 限流）→ 该单元**自动降级**为 commit + 笔记原文拼接，整份报告仍产出。
- 单仓库不可访问 / 损坏 → 跳过并告警，不影响其余仓库。
- 笔记文件格式异常 / 编码错误 → 容错解析，不中断。
- GBK 编码的 commit message → 分级解码（UTF-8 → GBK → GB18030）。

---

## 许可证

MIT
