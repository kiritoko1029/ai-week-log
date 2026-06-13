# WeekLog — Git 周报/日报生成桌面客户端

读取本地 Git 仓库的 commit 提交日志，结合**人工笔记**（会议、沟通、设计、调研等非代码工作），通过 AI 自动融合总结，生成结构化《工作周报》/《日报》。

- **双信息源融合**：commit（代码工作）+ 笔记（非代码工作）一并送 AI，按「日期 → 项目」两级组织，每段 3–5 句。
- **双 LLM 后端**：OpenAI Responses API / Anthropic Messages API，配置一行切换。
- **跨平台桌面应用**：macOS（Apple Silicon / arm64）+ Windows（x64）。
- **本地优先**：仅在调用 LLM 时产生网络请求；笔记与配置存本地。

> 设计文档：[PRD.md](./PRD.md) · [PLAN.md](./PLAN.md) ｜ UI 原型：`weeklog-desktop-app.html`

---

## 技术栈

- **Electron**（主进程 Node + 渲染进程 Web）+ 原生 HTML/CSS/JS（无前端框架）
- **Git 采集**：`child_process` 直调 `git log`，按 `0x1e/0x1f` 分隔解析（编码可控、零依赖）
- **LLM 调用**：Node 内置 `fetch`，直连 OpenAI `/responses` 与 Anthropic `/v1/messages`
- **零运行时依赖**：只需 `electron` / `electron-builder`（开发依赖）

---

## 目录结构

```
week-log/
├── package.json                # 入口 + electron-builder 双平台配置
├── src/
│   ├── main/                   # 主进程（Node 环境）
│   │   ├── index.js            # 窗口创建、生命周期
│   │   ├── ipc.js              # IPC 处理器（配置/仓库/笔记/采集/生成/历史/对话框）
│   │   ├── config.js           # 配置加载/保存（JSON，存 userData）
│   │   ├── git.js              # git log 采集 + 0x1e/0x1f 解析
│   │   ├── notes.js            # 笔记 Markdown 读写（## 项目分段）
│   │   ├── aggregator.js       # (日期,项目) 分桶 + 笔记融合分配
│   │   ├── pipeline.js         # 编排：collect / generate
│   │   ├── render.js           # text / md / json 渲染
│   │   ├── utils.js            # 日期、token、范围解析
│   │   └── llm/                # LLM 适配层
│   │       ├── base.js         # 抽象 + 异常 + 指数退避重试
│   │       ├── openai.js       # OpenAI Responses API
│   │       ├── anthropic.js    # Anthropic Messages API
│   │       └── index.js        # 工厂 + Prompt（融合 commit 与笔记）
│   ├── preload/index.js        # contextBridge 安全桥（window.weeklog）
│   └── renderer/
│       ├── index.html          # 应用 UI（基于原型）
│       └── app.js              # 渲染层逻辑（调 window.weeklog）
├── PRD.md / PLAN.md
└── weeklog-desktop-app.html    # UI 设计原型
```

---

## 开发与运行

### 1. 安装依赖

```bash
npm install
```

### 2. 配置 API Key

两种方式（任选其一；软件内填写优先级更高）：

**方式 A — 软件内填写（推荐）：** 启动应用 →「AI 与输出设置」→ API Key 输入框直接填写并保存。密钥用系统钥匙串加密存储（Windows DPAPI / macOS Keychain），不明文落盘，支持显示/隐藏与清除。

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

> 也支持自定义变量名 `WEEKLOG_ANTHROPIC_KEY` / `WEEKLOG_OPENAI_KEY`（优先级更高）。

### 3. 启动应用

```bash
npm start            # 普通启动
npm run dev          # 带 DevTools（WEEKLOG_DEV=1）
```

首次启动后：**仓库管理 → 添加仓库**（注册本地 Git 仓库并命名项目）→ 在「AI 与输出设置」选择 provider/模型 → 即可在「生成周报/日报」一键生成。

---

## 打包发布

```bash
npm run dist:win     # Windows x64 安装包（NSIS）→ release/
npm run dist:mac     # macOS arm64（dmg + zip）→ release/
npm run dist         # 同时构建两个平台（macOS 包需在 macOS 上构建）
```

> ⚠️ macOS arm64 包必须在 macOS（Apple Silicon 或带交叉能力的环境）上构建；Windows x64 包在 Windows 上构建。CI 矩阵（GitHub Actions macos-latest + windows-latest）可自动产出双平台产物。

---

## 使用流程

1. **添加仓库**：仓库管理 → 添加仓库 → 浏览选择本地 Git 目录 → 命名项目（如「某某系统前端」）。
2. **记笔记**（可选但推荐）：仪表盘/笔记管理 → 快速记一笔，选关联项目或留空（=日常工作）。笔记存为 `notes/YYYY-MM-DD.md`，可用 `## 项目名` 分段。
3. **生成**：
   - 仪表盘「一键生成」→ 本周周报
   - 「今日日报」→ 当天日报（纯非代码工作日也能基于笔记生成）
   - 「生成周报/日报」→ 自定义范围/过滤/格式
4. **融合规则**：项目级笔记归对应项目段；通用笔记注入当天所有项目段 + 形成【日常工作】独立段。

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

- AI 调用失败（超时/限流）→ 该单元**自动降级**为 commit+笔记原文拼接，整份报告仍产出。
- 单仓库不可访问/损坏 → 跳过并告警，不影响其余仓库。
- 笔记文件格式异常/编码错误 → 容错解析，不中断。
- GBK 编码的 commit message → 分级解码（UTF-8 → GBK → GB18030）。

---

## 许可证

MIT
