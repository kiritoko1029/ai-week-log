# 《本地 Git 周报生成工具》需求文档（PRD）

---

| 字段 | 内容 |
|---|---|
| 版本 | v1.1 |
| 日期 | 2026-06-13 |
| 状态 | 评审中 |
| 工具代号 | `weeklog` |

### 变更记录

| 版本 | 日期 | 变更内容 |
|---|---|---|
| v1.0 | 2026-06-13 | 初版：Git commit 采集 + AI 周报生成 + 双 LLM 后端 |
| v1.1 | 2026-06-13 | **新增**：① 手动笔记功能（补充非代码工作，如会议/沟通/设计/调研）；② 笔记与 commit 融合送 AI；③ 日报（单天）生成；④ 笔记管理子命令 |

---

## 1. 背景与目标

### 1.1 背景

开发者每周需要向上级提交《工作周报》，但"回忆一周工作 + 组织语言"的重复劳动耗时耗力。实际上，每位开发者的工作记录一部分高密度地保存在 Git commit 历史中，但**还有相当一部分工作（会议、沟通、方案设计、技术调研、文档评审、跨团队协调）并不会体现在 commit 里**。仅靠 commit 生成的周报会遗漏这些重要工作，导致汇报不完整。

### 1.2 目标

构建一个**本地命令行工具**，读取开发者本地一个或多个 Git 仓库的 commit 提交历史，**并结合用户手动添加的笔记**，通过可切换的大语言模型（LLM）自动聚合与归纳，产出结构化《工作周报》/《日报》，做到**零手写、一键生成、覆盖完整**。

### 1.3 核心约束

1. 完全本地运行，仅在调用 LLM 时产生外部网络请求；
2. 周报/日报按「日期 → 项目」两级组织，每个（日期, 项目）段落用 **3–5 句话**总结；
3. LLM 后端同时支持 **OpenAI Responses API** 和 **Anthropic Messages API**，通过配置无缝切换；
4. 支持用户**手动添加笔记**作为补充信息源，与 commit 一并送入 AI 融合总结；
5. 支持按周（周报）和按天（日报）两种粒度生成；
6. Windows 11 为一等公民运行环境，同时具备跨平台能力。

---

## 2. 名词术语表

| 术语 | 定义 |
|---|---|
| **周报单元 / 桶（Bucket）** | 同一天、同一项目的工作集合（commit + 笔记），是 AI 生成摘要的最小粒度 |
| **项目** | 周报中`【项目名】`对应的名称，由用户在配置中为仓库命名 |
| **笔记（Note）** | 用户手动记录的工作条目，用于补充 commit 无法体现的工作（会议、沟通、设计、调研等） |
| **信息源** | 送入 AI 的内容来源，包括「commit 摘要」和「人工笔记」两类 |
| **日报（Daily）** | 单天的总结输出，可视为周报的单天切片，适合每天结束时生成当日小结 |
| **Provider** | LLM 后端实现，当前支持 `openai` 和 `anthropic` 两种 |
| **采集** | 从本地 `.git` 读取指定时间范围内的 commit 的过程 |
| **聚合** | 将 commit 与笔记按（日期, 项目）分组为桶的过程 |
| **融合** | 将 commit 摘要与人工笔记合并到同一桶、一起送 AI 总结的过程 |
| **降级** | AI 调用失败时，自动回退为基于 commit subject / 笔记原文拼接摘要的策略 |
| **dry-run** | 只采集+聚合、预览将要发送的内容，不实际调用 AI |

---

## 3. 目标用户与使用场景

### 3.1 目标用户

| 用户画像 | 特征 | 核心诉求 |
|---|---|---|
| **主要：个人开发者（Windows）** | 同时维护多个仓库（前端/后端/脚本），每周向上级提交周报，每天都有非代码工作 | 一键生成、措辞专业、不想翻 commit；能补充会议/沟通类工作 |
| **次要：技术负责人 / 小组长** | 既写代码又写汇报，需跨仓库并行视图，会议多 | 多项目统一输出，按天回顾进展，把会议与协调工作纳入汇报 |
| **次要：自由职业 / 外包开发者** | 按项目结算，需向客户报告进展 | 按项目、按时间区间精准导出 |

共性约束：熟悉命令行与 Git；对 commit 与笔记内容的隐私敏感（含内部项目名、业务逻辑）。

### 3.2 典型使用场景

| 场景 | 触发命令（草案） | 说明 |
|---|---|---|
| **S1 周五一键生成本周周报** | `weeklog` | 默认：本周一至今，使用配置的仓库和 provider，自动融合本周笔记 |
| **S2 补写历史某一周** | `weeklog --week last` / `--week 2026-W23` | 按 ISO 周编号或 `last` 指代上周 |
| **S3 按指定日期区间生成** | `weeklog --from 2026-06-01 --to 2026-06-13` | 任意日期区间，闭区间 |
| **S4 只看某几个项目** | `weeklog --project 某某系统前端,某某系统后端` | 仅渲染选定项目 |
| **S5 多人仓库只看本人提交** | `weeklog --me` | 自动读取 `git config user.email` 过滤 |
| **S6 离线采集+事后 AI 生成** | `weeklog collect --out raw.json` → `weeklog render --in raw.json` | 解耦采集与 AI，适合内网/隐私场景 |
| **S7 预演不调用 AI** | `weeklog --dry-run` | 预览将发送内容与预估 token，不产生费用 |
| **S8 导出为 Markdown 存档** | `weeklog --from ... --to ... --output md --out report.md` | 复盘/存档 |
| **S9 快速添加一条笔记** ⭐ | `weeklog note add "参加架构评审，确认了订单服务拆分方案"` | 一行命令追加当天笔记，默认归今天；`-p 项目名` 关联项目 |
| **S10 每天下班生成日报** ⭐ | `weeklog daily` | 生成今天的日报（当天 commit + 当天笔记），适合日终小结；`--date yesterday` 指定日期 |
| **S11 编辑当天笔记** ⭐ | `weeklog note edit` | 用系统编辑器（`$EDITOR`）打开当天笔记文件，自由书写/分项目 |
| **S12 纯笔记日报（今天没写代码）** ⭐ | `weeklog daily --no-commits-ok` | 当天无 commit 但有笔记时，仍基于笔记生成日报，归入"日常工作"段 |
| **S13 查看历史笔记** ⭐ | `weeklog note list --from 2026-06-08 --to 2026-06-14` / `note show 2026-06-15` | 回顾一段时间内的笔记 |

> ⭐ 为 v1.1 新增场景。

---

## 4. 功能需求（FR）

> 优先级：**P0** 首版必须上线；**P1** 首版应做、可降级发布；**P2** 迭代版本实现。

### 4.1 配置与仓库管理

| 编号 | 优先级 | 需求描述 |
|---|---|---|
| FR-01 | P0 | 支持配置文件中登记 N 个本地仓库，每个仓库可单独指定：`path`（本地路径）、`name`（周报项目名）、`branch`（默认分支）、`enabled`（启停）、作者过滤覆盖 |
| FR-02 | P0 | 配置文件优先级：命令行 `--config` > 当前目录 `weeklog.config.toml` > 用户目录 `%APPDATA%\weeklog\config.toml`（Windows）/ `~/.config/weeklog/config.toml` |
| FR-03 | P1 | `weeklog init` 生成带注释的配置模板；`weeklog repo add <path> --name <名>` 增量注册仓库 |
| FR-04 | P1 | 启动时校验：路径合法性、为有效 Git 仓库、项目名非空且不重复（重名时警告）、AI 配置字段完整；错误信息精确到字段 |
| FR-05 | P2 | `weeklog scan <根目录>` 递归发现 `.git` 目录并提示批量登记（带深度上限） |

### 4.2 时间范围

| 编号 | 优先级 | 需求描述 |
|---|---|---|
| FR-06 | P0 | 支持多种时间范围模式（互斥）：无参数=本周（周起始至今）；`--week current|last|<2026-Www>`；`--from <YYYY-MM-DD> [--to <YYYY-MM-DD>]`；`--days <N>`（最近 N 天） |
| FR-07 | P0 | 周起始日可配置：`weekStart: monday`（默认）或 `sunday` |
| FR-08 | P0 | 所有 commit 时间统一换算到用户配置的 `timezone`（默认 `Asia/Shanghai`）后判定归属日期 |
| FR-09 | P1 | 日期归属依据可配置：`dateBasis: author`（默认）或 `committer` |

### 4.3 Commit 采集

| 编号 | 优先级 | 需求描述 |
|---|---|---|
| FR-10 | P0 | 对每个仓库执行 `git log`，使用 0x1F/0x1E 控制字符分隔字段与记录，避免 commit message 中的换行/特殊字符污染解析 |
| FR-11 | P0 | 每条 commit 提取字段：`hash`（完整）、`shortHash`、`authorName`、`authorEmail`、`authorDate`（含时区）、`localDate`（本地日期）、`subject`（首行）、`body`（正文）、`isMerge`（按 parent 数判定） |
| FR-12 | P0 | 作者过滤：`--author <值>` 支持多值、name 或 email 匹配；`--me` 快捷取 `git config user.email`；默认不过滤（包含全部作者） |
| FR-13 | P0 | 分支选择：默认采集配置指定分支（或当前分支）；`--branch <name>` 指定；`--all-branches` 合并去重 |
| FR-14 | P0 | Merge commit 策略：可配 `mergeCommits: exclude`（默认）`| include | only`，默认排除 |
| FR-15 | P1 | `filesChanged`/`insertions`/`deletions` 字段（经 `--numstat`）；文件变更列表（经 `--name-only`）——用于给 AI 提供改动体量上下文 |
| FR-16 | P1 | 跨分支同一 hash 去重，避免同一 commit 重复计入 |
| FR-17 | P2 | `--grep` / `--exclude-grep` 按 commit message 关键词过滤（如排除 `^chore:` / `^Merge`） |

### 4.4 聚合（日期 → 项目 两级）

| 编号 | 优先级 | 需求描述 |
|---|---|---|
| FR-18 | P0 | 按 `(localDate, project)` 二维分桶；结构：`Map<日期, Map<项目, Commit[]>>`；v1.1 起桶内同时包含**关联的笔记**（见 4.8） |
| FR-19 | P0 | 排序：日期升序（早→晚）；同日内项目按配置文件中的仓库注册顺序 |
| FR-20 | P0 | 无 commit **且** 无笔记的日期/项目不输出空行 |
| FR-21 | P1 | 项目识别策略（按优先级）：① 配置中显式 `name` → ② 配置 `split_by_subdir=true` 时按变更文件一级目录 → ③ 仓库目录名兜底 |

### 4.5 AI 生成摘要

| 编号 | 优先级 | 需求描述 |
|---|---|---|
| FR-22 | P0 | 对每个（日期, 项目）桶，将该桶内所有 commit subject/body + 改动文件摘要 **以及关联的人工笔记** 作为输入，调用 LLM 生成**一段 3–5 句**中文总结（笔记融合细节见 4.8.4） |
| FR-23 | P0 | 统一 `LLMProvider` 抽象接口：`summarize(system_prompt, user_prompt) -> str`；上层逻辑不感知具体后端 |
| FR-24 | P0 | 支持两种 LLM 后端，通过配置 `provider: openai | anthropic` 切换：(a) OpenAI Responses API；(b) Anthropic Messages API |
| FR-25 | P0 | Prompt 内置默认模板（3-5 句、中文、客观陈述、不编造、不输出【】前缀、明确告知"笔记是用户补充的工作，需一并纳入总结"）；支持通过 `promptTemplatePath` 外置覆盖 |
| FR-26 | P1 | 多桶并发调用，受 `ai.concurrency`（默认 3）约束 |
| FR-27 | P1 | 对 429/5xx/超时自动重试，指数退避 + 随机抖动，次数可配（默认 3） |
| FR-28 | P1 | `--dry-run` 模式：仅采集+聚合+加载笔记，打印将发送的桶数和预估 token，不调 AI |
| FR-29 | P2 | 可选结果缓存：以（桶内容哈希 + 笔记哈希 + prompt 版本）为 key 缓存摘要，省 token |

### 4.6 渲染与输出

| 编号 | 优先级 | 需求描述 |
|---|---|---|
| FR-30 | P0 | 默认 text 格式严格匹配示例格式（见第 9 节），日期格式 `YYYY/M/D`（无前导零），项目行 `【{name}】：{summary}` |
| FR-31 | P0 | 输出去向：默认 stdout；`--out <file>` 写文件（UTF-8，Windows 下 CRLF 换行，可配）；文件已存在时自动添加时间戳后缀避免覆盖 |
| FR-32 | P1 | 多格式：`--output text`（默认）/ `md`（带 Markdown 标题层级）/ `json`（结构化，含 commit 明细与笔记摘要） |
| FR-33 | P1 | `--with-commits`：在每段摘要后附该桶的 commit shortHash 列表，便于溯源核对 |
| FR-34 | P2 | `--clipboard`：直接复制结果到系统剪贴板（Windows 友好） |
| FR-35 | P1 | `--show-notes`：在每段摘要后附该桶关联的原始笔记（溯源，默认关闭以保持简洁） |

### 4.7 辅助功能

| 编号 | 优先级 | 需求描述 |
|---|---|---|
| FR-36 | P0 | `collect` 子命令：仅采集+聚合+加载笔记，输出中间 JSON（含版本号），供 `render` 子命令消费 |
| FR-37 | P1 | `--verbose`/`--quiet`；`--log-file`；记录采集 commit 数、笔记数、各阶段耗时、AI 调用次数；日志中不打印 API Key 和完整正文 |
| FR-38 | P2 | 脱敏规则配置：正则替换 commit **与笔记** 内容中的敏感词/项目代号，在发送 AI 前执行 |

### 4.8 笔记管理（Notes）⭐ v1.1 新增

> 笔记用于补充 commit 无法体现的工作（会议、沟通、方案设计、技术调研、文档评审、跨团队协调等），是周报/日报完整性的关键信息源。

| 编号 | 优先级 | 需求描述 |
|---|---|---|
| FR-39 | P0 | **笔记存储**：笔记以本地 Markdown 文件按日期组织，路径为 `{notes.dir}/YYYY-MM-DD.md`（默认 `./notes/`）；纯文本、可被 Git 纳入版本管理、可人工编辑 |
| FR-40 | P0 | **笔记结构**：单个笔记文件内用 Markdown 二级标题 `## <项目名>` 划分项目段；标题之上或 `## 日常工作`（可配）下的内容视为**当天通用笔记**（不绑定特定项目）。示例见 9.3 |
| FR-41 | P0 | **`note add`**：`weeklog note add <文本> [-d/--date <日期>] [-p/--project <项目名>]`；默认日期=今天；`-p` 省略时追加到当天通用段。追加写入对应文件（文件/段不存在则创建），不覆盖既有内容 |
| FR-42 | P0 | **`note edit`**：`weeklog note edit [-d/--date <日期>]`；调用系统编辑器（`$EDITOR`，Windows 默认 `notepad`）打开当天（或指定日期）的笔记文件，支持自由书写多段 |
| FR-43 | P1 | **`note list` / `note show`**：`note list [--from --to]` 列出区间内每天的笔记条目数；`note show <date>` 打印某天完整笔记内容 |
| FR-44 | P0 | **笔记融合（关键）**：生成周报/日报时，按日期加载笔记并分配到桶——① 带项目标签的笔记 → 对应项目桶；② 通用笔记 → 注入当天**所有**项目桶的 prompt 作为补充上下文；③ 若当天有笔记但无任何 commit（纯非代码工作），按 `notes.miscProject`（默认"日常工作"）生成独立段落（S12） |
| FR-45 | P1 | **笔记隐私对齐**：笔记与 commit 一并受脱敏规则（FR-38）与隐私提示（NFR-01）约束；笔记可能含更敏感的业务信息，首次含笔记的运行额外提示 |
| FR-46 | P1 | **笔记开关**：`--no-notes` 临时忽略笔记，仅基于 commit 生成；配置 `notes.enabled = false` 全局关闭 |
| FR-47 | P2 | **笔记导入/导出**：支持从其它来源（如剪贴板、指定文件）批量导入笔记；`note export` 导出区间笔记为单文件 |

### 4.9 日报生成（Daily）⭐ v1.1 新增

| 编号 | 优先级 | 需求描述 |
|---|---|---|
| FR-48 | P0 | **`weeklog daily`** 子命令：生成**单天**日报，默认日期=今天；等价于把时间范围收窄为 `[今天, 今天]` 的周报切片，复用同一套采集→聚合→笔记融合→AI 总结→渲染流程 |
| FR-49 | P0 | `daily --date <YYYY-MM-DD\|today\|yesterday>`：支持自然快捷词（`today`/`yesterday`）与具体日期 |
| FR-50 | P1 | `daily --no-commits-ok`：当天无 commit 时，只要有笔记即基于笔记生成日报（归入"日常工作"段）；无 commit 且无笔记则按 EC-01 处理 |
| FR-51 | P1 | 日报输出格式与周报单天块一致（见 9.2），可选 `--output md` 等，与周报共用渲染器 |
| FR-52 | P2 | `daily --push`：生成后自动追加到当周周报草稿文件，便于周末一键汇总（依赖草稿机制，可延后） |

---

## 5. 非功能需求（NFR）

### 5.1 隐私与数据安全

| 编号 | 优先级 | 需求描述 |
|---|---|---|
| NFR-01 | P0 | 首次使用云端 provider 时，明确告知用户：commit subject/body、改动文件路径 **以及人工笔记** 将发送给第三方 LLM；笔记往往含更敏感业务信息，需单独强调 |
| NFR-02 | P0 | 默认外发载荷仅含 commit subject/body、文件路径摘要 **与笔记正文**；**不发送代码 diff 内容、不发送完整文件路径**（文件名可配置是否包含） |
| NFR-03 | P0 | `base_url` 可指向私有/本地 OpenAI 兼容网关，实现数据不出内网（笔记亦不出内网） |
| NFR-04 | P0 | API Key 从环境变量读取（`OPENAI_API_KEY` / `ANTHROPIC_API_KEY`）；日志/报错不打印完整 Key（最多掩码显示 `sk-...xxxx`） |
| NFR-05 | P1 | `--dry-run` 可预览完整外发载荷（含笔记）；支持将实际外发载荷落本地审计文件 |
| NFR-06 | P1 | 默认只允许 HTTPS base_url；HTTP 需显式 `--allow-insecure` |
| NFR-07 | P1 | 笔记文件**不随周报明文回显**（除非 `--show-notes`）；默认仅以 AI 摘要形式呈现 |

### 5.2 性能

| 编号 | 优先级 | 需求描述 |
|---|---|---|
| NFR-08 | P1 | 10 个仓库、单仓 1 万 commit 历史、查询一周区间，**采集阶段 < 5 秒** |
| NFR-09 | P1 | 笔记加载：单次读取 `notes/` 目录下区间内文件，**< 200ms** |
| NFR-10 | P1 | 典型一周 ≤ 20 个周报单元时，**端到端（不含网络抖动）< 30 秒**（并发调用，受 `ai.concurrency` 控制） |
| NFR-11 | P1 | 流式/分批处理 commit，常驻内存 < 200MB |

### 5.3 易用性

| 编号 | 优先级 | 需求描述 |
|---|---|---|
| NFR-12 | P0 | 已配置环境下 `weeklog` 无参数即出本周周报、`weeklog daily` 即出今天日报；未配置时给出清晰初始化引导 |
| NFR-13 | P0 | 所有面向用户的提示、报错、默认 prompt 均为**简体中文**；错误信息可执行（告知如何修复） |
| NFR-14 | P1 | `--help` 列全部命令/参数与示例；`note add` 支持短别名 `-d`/`-p`，降低日常使用成本 |

### 5.4 容错

| 编号 | 优先级 | 需求描述 |
|---|---|---|
| NFR-15 | P0 | 某个周报单元 AI 调用失败，不使整份周报失败；该单元**降级输出**（原始 commit subject + 笔记原文拼接），结尾汇总失败项 |
| NFR-16 | P0 | 单个仓库不可访问/损坏，不阻断其余仓库，记录警告继续 |
| NFR-17 | P0 | 笔记文件读取/解析失败（格式异常、编码错误），不阻断整体，跳过该文件并警告 |
| NFR-18 | P0 | 存在失败单元返回退出码 `2`；致命错误（无可用仓库/配置非法/全部 AI 失败且无降级）返回退出码 `1` |
| NFR-19 | P1 | 配置错误、Key 无效等不可重试错误**快速失败**，不进行无意义重试 |

### 5.5 跨平台

| 编号 | 优先级 | 需求描述 |
|---|---|---|
| NFR-20 | P0 | Windows 10/11（PowerShell/CMD）正常运行；中文不乱码（stdout 显式 UTF-8） |
| NFR-21 | P1 | 相同代码可在 macOS/Linux 运行（路径、换行、时区、`$EDITOR` 差异已抽象） |

---

## 6. 输入规格

### 6.1 配置文件（TOML，草案）

```toml
# weeklog.config.toml

weekStart  = "monday"          # monday | sunday
timezone   = "Asia/Shanghai"
dateBasis  = "author"          # author | committer

[[repos]]
path    = "F:/code/web"
name    = "某某系统前端"
branch  = "main"
enabled = true

[[repos]]
path = "F:/code/api"
name = "某某系统后端"

[filters]
author       = []              # 空=不过滤；填邮箱只看本人
mergeCommits = "exclude"       # exclude | include | only
excludeGrep  = ["^chore:", "^Merge branch"]

# ── 笔记配置（v1.1 新增） ──────────────────────────────────────────────
[notes]
enabled    = true              # false=全局关闭笔记融合
dir        = "notes"           # 笔记目录，相对配置文件所在目录；也可填绝对路径
miscProject = "日常工作"        # 无项目标签笔记归属的虚拟项目名（纯非代码工作日报用）
            # 笔记文件内 "## <此名>" 下的内容即通用段；缺省标题也归入通用

# ── AI 后端 ────────────────────────────────────────────────────────────
[ai]
provider          = "anthropic"        # openai | anthropic
model             = "claude-sonnet-4-6"
temperature       = 0.3
maxOutputTokens   = 800
maxInputTokens    = 6000               # 超限则截断/分批（commit + 笔记合计计算）
concurrency       = 3
retries           = 3
timeoutSeconds    = 60
# api_key 不写文件，从环境变量读取：ANTHROPIC_API_KEY / OPENAI_API_KEY
baseUrl           = ""                 # 留空用官方默认；私有网关时覆盖

# ── 输出 ────────────────────────────────────────────────────────────────
[output]
format   = "text"             # text | md | json
dateFormat = "YYYY/M/D"       # 月日无前导零，与示例一致
newline  = "CRLF"             # Windows 默认
encoding = "utf-8"
```

### 6.2 命令行参数（草案）

```
weeklog [全局选项] [子命令]

全局选项（周报/日报/collect 通用）：
  --config <path>
  --from <YYYY-MM-DD>  --to <YYYY-MM-DD>
  --week current|last|<2026-Www>
  --days <N>
  --repo <path,...>    --project <name,...>
  --author <a,...>     --me
  --branch <name,...>  --all-branches
  --merge exclude|include|only
  --provider openai|anthropic  --model <id>
  --output text|md|json        --out <file>
  --with-commits   --show-notes
  --no-notes                   # 临时忽略笔记（v1.1）
  --dry-run
  --verbose | --quiet
  --allow-insecure

子命令：
  （无）               生成本周周报（默认）
  daily [选项]         生成日报（默认今天）            # v1.1 新增
    --date <today|yesterday|YYYY-MM-DD>
    --no-commits-ok
  note add <text>      添加一条笔记                   # v1.1 新增
    -d/--date <日期>   （默认今天）
    -p/--project <名>  （可选，关联项目）
  note edit            用编辑器打开笔记文件            # v1.1 新增
    -d/--date <日期>   （默认今天）
  note list            列出区间内笔记                  # v1.1 新增
    --from --to
  note show <date>     查看某天笔记                    # v1.1 新增
  init                 生成配置模板
  repo add <path>      注册仓库
  scan <dir>           发现并提示注册 .git 仓库
  collect              仅采集(+加载笔记)，输出中间 JSON
  render               消费中间 JSON，输出周报/日报
```

---

## 7. 输出规格

### 7.1 中间数据格式（collect 产出，含笔记）

```jsonc
{
  "schemaVersion": 2,
  "range": { "from": "2026-06-08", "to": "2026-06-13", "timezone": "Asia/Shanghai" },
  "commits": [
    {
      "repo": "F:/code/web", "project": "某某系统前端",
      "hash": "ab12cd3e...", "shortHash": "ab12cd",
      "authorName": "张三", "authorEmail": "zhangsan@corp.com",
      "authorDate": "2026-06-09T10:22:00+08:00", "localDate": "2026-06-09",
      "subject": "优化列表加载性能", "body": "...",
      "branch": "main", "isMerge": false,
      "filesChanged": 4, "insertions": 120, "deletions": 30,
      "files": ["src/views/List.vue", "src/api/order.js"]
    }
  ],
  "notes": [                                   // v1.1 新增
    {
      "date": "2026-06-09",
      "project": "某某系统前端",               // null 或 "日常工作" 表示通用笔记
      "content": "与产品确认了列表页 v2 排期，梳理出三个核心需求。",
      "source": "notes/2026-06-09.md"
    },
    {
      "date": "2026-06-09",
      "project": null,                         // 通用笔记，注入当天所有桶
      "content": "参加架构评审会议，讨论了微服务拆分边界。",
      "source": "notes/2026-06-09.md"
    }
  ]
}
```

### 7.2 退出码

| 退出码 | 含义 |
|---|---|
| `0` | 完全成功 |
| `1` | 致命错误（无可用仓库/配置非法/全部 AI 失败且无降级） |
| `2` | 部分单元 AI 失败（已降级，周报/日报仍产出） |
| `3` | git 不可用 |
| `4` | 空结果（无 commit 且无笔记）且开启 `--fail-on-empty` |

---

## 8. AI 接入需求

### 8.1 双后端支持

系统必须实现统一的 `LLMProvider` 抽象接口，对外只暴露 `summarize(system_prompt, user_prompt) -> str`，上层周报/日报逻辑对具体后端完全无感知。

**OpenAI Responses API 要求**：
- 端点：`POST {base_url}/responses`
- 认证：`Authorization: Bearer <OPENAI_API_KEY>`
- 请求字段：`model`、`instructions`（系统指令）、`input`（用户内容）、`max_output_tokens`、`temperature`
- 响应解析：优先取聚合字段 `output_text`，否则遍历 `output[] → type==message → content[] → type==output_text → text`
- 支持自定义 `base_url` 以对接 OpenAI 兼容网关

**Anthropic Messages API 要求**：
- 端点：`POST {base_url}/messages`
- 认证：`x-api-key: <ANTHROPIC_API_KEY>` + `anthropic-version: 2023-06-01`
- 请求字段：`model`、`max_tokens`（**必填**）、`system`（**顶层字段，不放入 messages**）、`messages`（user 轮次）、`temperature`
- 响应解析：遍历 `content[]` 中 `type==text` 的项，拼接 `text` 字段
- 支持自定义 `base_url`

### 8.2 配置驱动切换

仅修改配置文件中的 `ai.provider` 字段即可切换后端，无需改代码。切换时采集、聚合、笔记融合、渲染结果结构完全一致。

### 8.3 鲁棒性要求

| 场景 | 处理方式 |
|---|---|
| 429 / 5xx / 超时 | 指数退避重试（base 1s，最多 3 次），尊重 `Retry-After` 响应头 |
| 401 / 403 / 400 | 快速失败，不重试，明确提示错误原因 |
| 重试耗尽 | 该单元降级（fallback），整体周报/日报仍产出 |
| 超长输入 | 先截断 commit body 与笔记正文，仍超限则按变更量/笔记重要性降序保留，再超则 map-reduce 分批总结 |

### 8.4 笔记融合 Prompt 要求 ⭐ v1.1

- System prompt 须明确：输入包含「代码提交」与「人工补充笔记」两类信息源，两者均为真实工作，需**统一归纳**为 3-5 句总结，不得因信息源不同而割裂或忽略笔记；
- User prompt 须用结构化分段呈现：`【代码提交】...` 与 `【人工笔记】...`，便于模型区分；
- 笔记内容前可加轻量提示（如"以下为开发者补充的非代码工作"），避免模型将其误判为 commit。

---

## 9. 输出格式规范

### 9.1 周报输出示例（默认 text 格式）

```
2026/6/15
【某某系统前端】：根据用户需求整理了交互文档，梳理了三个核心页面的字段定义，并与后端确认了接口契约。
【某某系统后端】：优化了订单查询的索引策略，将平均响应时间从 800ms 降至 200ms，并补充了相关单元测试。
【日常工作】：参加架构评审会议，与产品确认了本周排期并完成了订单服务拆分方案的技术调研。
2026/6/16
【某某系统前端】：……
```

> 上例的【日常工作】段来自当天通用笔记（无 commit 关联），体现笔记融合价值。

### 9.2 日报输出示例

```
2026/6/15
【某某系统前端】：完成订单详情页的字段布局调整，修复分页跳转参数丢失缺陷。
【某某系统后端】：新增订单列表分页与状态过滤，对高频查询加入复合索引，P95 由 820ms 降至 210ms。
【日常工作】：上午参加架构评审，下午与产品确认 v2 排期。
```

### 9.3 笔记文件格式（`notes/2026-06-15.md`）

```markdown
## 某某系统前端
与产品确认了列表页 v2 排期，梳理出三个核心需求；评审了交互稿。

## 日常工作
参加架构评审会议，讨论了微服务拆分边界；完成技术调研报告。
```

> 规则：`## <项目名>` 下的内容归该项目的桶；标题之上（或 `## 日常工作`/配置的 `miscProject`）下的内容归当天通用笔记，注入当天所有桶并可作为独立段落。

### 9.4 通用格式规则

| 规则 | 说明 |
|---|---|
| **日期行** | `{year}/{month}/{day}`，月、日**不补前导零**（`2026/6/15` 而非 `2026/06/15`） |
| **项目行** | `【{projectName}】：{summary}`，每个项目占一行，冒号使用全角 `：` |
| **摘要** | 3–5 句中文，句末有标点（`。！？`），不换行，不含 commit hash，不含【】前缀 |
| **日期块间距** | 日期块之间空一行（周报场景）；日报为单块无需空行 |
| **排序** | 日期升序；同日内项目按配置仓库注册顺序，**【日常工作】等纯笔记段排在最后** |
| **缺失处理** | 无 commit 且无笔记的日期/项目不输出 |

### 9.5 语气与措辞规范

- 客观陈述，描述已完成的工作（使用"完成了""优化了""修复了""参加了""确认了"等动词）；
- 无人称（不用"我""我们"）；
- 合并同类项，不逐条复述 commit 或笔记；
- 不杜撰未在 commit/笔记中体现的工作内容；
- 代码工作与非代码工作（笔记）自然融合，不刻意区分来源。

---

## 10. 边界条件与异常处理

| 编号 | 场景 | 期望处理 |
|---|---|---|
| EC-01 | 区间内无任何 commit **且无笔记** | 输出友好提示"指定范围内无工作记录"，退出码 0，不报错 |
| EC-02 | 某仓库无 commit，其余有 | 正常输出有内容的仓库；若该天有笔记则笔记仍生效 |
| EC-03 | 跨仓库同名项目 | 默认合并为同一【项目】块；配置 `mergeSameProject: false` 时以 `名称(仓库名)` 消歧 |
| EC-04 | Merge commit | 按 `mergeCommits` 策略处理；include 时提示 AI 弱化合并类提交 |
| EC-05 | 多作者仓库未设过滤 | 检测到多作者时给出提示，建议用户配置 author 过滤 |
| EC-06 | 超长 commit message / 笔记 / 极多 commit | 截断 body 与笔记 → 按重要性降序保留 → map-reduce 分批总结 |
| EC-07 | 非 UTF-8（GBK）commit message 或笔记文件 | 分级解码：UTF-8 → GBK → GB18030 → replace 兜底；不抛异常 |
| EC-08 | 跨天时区错位（仅 commit） | 使用 `git log --date=format-local:...` 按本地时区输出日期；笔记按文件名日期归属，不涉及时区 |
| EC-09 | ISO 周边界（跨年周） | 严格按 ISO-8601 + `weekStart` 配置解析，覆盖年初年末边界 |
| EC-10 | `--from` 晚于 `--to` / 非法日期 | 校验报错，给出正确示例 |
| EC-11 | 路径不存在 / 非 Git 仓库 / 空仓库 | 单仓库失败不阻断整体，记录到失败列表，结尾汇总 |
| EC-12 | AI 返回非预期内容（空/非中文/句数越界） | 后处理：句数裁剪、剥离 hash；批处理解析失败回退逐单元调用；仍失败则降级 |
| EC-13 | 网络中断 / 限流 / Key 无效 | 重试+退避；Key/URL 类错误快速失败并明确提示 |
| EC-14 | Cherry-pick / rebase 重复 commit | 按 hash 去重（跨分支、跨仓库均去重） |
| EC-15 | Bot/自动化提交 | 通过 author 过滤或 `excludeGrep` 剔除 |
| EC-16 | 调用次数超过成本闸门 | `maxCalls` / `maxInputTokens` 触发时中止（计入笔记后总 token） |
| EC-17 | 输出文件已存在 | 自动添加时间戳后缀，不覆盖 |
| EC-18 | Windows 控制台编码 GBK 导致乱码 | `sys.stdout.reconfigure(encoding="utf-8")`；文档提示 `chcp 65001` |
| EC-19 ⭐ | 笔记文件格式异常（无 `##` 段、乱码、损坏） | 整文件作为当天通用笔记处理；解析失败则跳过该文件并警告，不阻断 |
| EC-20 ⭐ | 笔记 `## 项目名` 与任何仓库项目都不匹配 | 仍按该名称生成段落（视为独立工作项），并在 `--verbose` 下提示"笔记引用了未配置的项目：<名>" |
| EC-21 ⭐ | 同一项目笔记既在通用段又在项目段 | 项目段笔记归项目桶；通用段笔记同时注入该桶，prompt 中分别标注，由 AI 去重归纳 |
| EC-22 ⭐ | `note edit` 时 `$EDITOR` 未设置 | Windows 回退 `notepad`；其它平台回退 `vi`；仍失败则提示手动编辑文件路径 |
| EC-23 ⭐ | `note add` 时 `-p` 项目名含特殊字符 | 校验项目名（仅允许常规字符），拒绝或转义 `##` 前缀注入，防止破坏文件结构 |

> ⭐ 为 v1.1 新增边界。

---

## 11. 验收标准（AC）

| 编号 | 可度量验收条件 |
|---|---|
| AC-01 | 给定 2 个仓库各含已知 commit，输出周报中两项目均出现，每条 commit 归属日期与 `git log` 输出一致，**归属准确率 100%** |
| AC-02 | 输出严格为「日期块（升序）→【项目】行」；无 commit 且无笔记的日期/项目**不出现** |
| AC-03 | 每个单元摘要句数 ∈ [3,5]（以中文句末标点计数），**100% 落区间或降级标注** |
| AC-04 | 默认 text 输出与格式规范（日期行、项目行）**逐字符匹配**（除摘要文本），有黄金快照测试 |
| AC-05 | 仅改 `ai.provider` 可分别走两种后端，采集/聚合/笔记融合/渲染结果结构一致；两后端各有 mock 端到端测试通过 |
| AC-06 | `--from/--to`、`--week last`、`--days N` 三类时间范围均返回与预期一致的 commit 集合（含闭区间边界） |
| AC-07 | `--author`、`--branch`、`--merge exclude` 过滤结果与手工 `git log` 等价命令一致 |
| AC-08 | 默认外发载荷**不含 diff、不含完整文件路径、不含 API Key**；`--dry-run` 可完整预览（含笔记） |
| AC-09 | 注入 AI 超时/429/网络错误：单元降级，整份周报**仍成功产出**，退出码 2，失败项在结尾列出 |
| AC-10 | 含 GBK 编码、超长（>10KB）、含特殊字符/换行的 commit message 与笔记文件不导致崩溃、不乱码 |
| AC-11 | Windows 11（PowerShell）下 `init → repo add → note add → weeklog → daily` 全流程通过 |
| AC-12 | 未配置时给出可执行初始化指引；已配置环境下 `weeklog` / `weeklog daily` 无报错产出本周/今日报告 |
| AC-13 | 日志/报错全程不出现完整 API Key（自动断言） |
| AC-14 | 超过 `maxCalls` / `maxInputTokens` 时中止并提示，不发生超额调用 |
| AC-15 ⭐ | `note add -p 某项目 "..."` 写入后，`note show` 能读到；对应日期生成周报时，该笔记内容被 AI 融合进【某项目】段（断言 prompt 含笔记文本） |
| AC-16 ⭐ | 当天无 commit 但有通用笔记时，`weeklog daily --no-commits-ok` 仍产出含【日常工作】段的日报 |
| AC-17 ⭐ | `--no-notes` 生成的周报与有笔记时不同，且 prompt 中不含任何笔记文本 |
| AC-18 ⭐ | `note edit` 在 `$EDITOR` 未设置时，Windows 回退 `notepad` 打开正确日期文件，不报错 |

> ⭐ 为 v1.1 新增验收。

---

## 12. 里程碑概览

| 里程碑 | 目标 | 预计交付物 |
|---|---|---|
| **M1 骨架** | 可采集单仓库 commit，解析为结构化数据 | `collector` + `models` + `cli init/repo` |
| **M2 聚合** | 多仓库 commit 按（日期,项目）正确分桶 | `aggregator` + 配置系统 |
| **M3 AI 适配** | 两种 provider 均可调用，摘要格式正确 | `ai/` 全模块 + `prompts` |
| **M4 渲染输出** | 产出符合格式规范的完整周报（text/md/json） | `renderer` + 完整 `pipeline` |
| **M5 笔记与日报** ⭐ | 笔记存储/管理/融合 + 日报生成 | `notes/` 模块 + `cli note/daily` + pipeline 融合 |
| **M6 可靠性** | 容错/降级/重试/退出码均通过验收 | 集成测试套件 + 边界处理（含笔记） |
| **M7 体验打磨** | `--dry-run`、帮助文档、Windows 编码、性能基线达标 | 文档 + 性能测试 |

详细任务分解见《实施计划文档》。

---

## 13. 开放问题

| 编号 | 问题 | 影响范围 | 状态 |
|---|---|---|---|
| OQ-01 | 分发形态：`pip install` / `pipx install` / PyInstaller exe？ | 安装体验、NFR-20 | **已定：Python + pipx** |
| OQ-02 | OpenAI Responses API 特指 `/v1/responses` 还是兼容 `/v1/chat/completions`？ | AI 适配层设计 | **已定：特指 `/v1/responses`，兼容网关通过 base_url 配置** |
| OQ-03 | 批处理（一次请求总结多个桶）的默认值？ | 成本与模型稳定性 | **已定：默认逐桶调用，批处理为 P2** |
| OQ-04 | 同名项目跨仓库默认合并还是消歧？ | 多仓库 monorepo 用户体验 | **已定：默认合并** |
| OQ-05 | 输出文件已存在时默认策略？ | 幂等性 | **已定：自动添加时间戳后缀** |
| OQ-06 | 首版是否支持 monorepo 按子目录拆分项目（FR-21 策略 C）？ | 聚合复杂度 | 待排优先级（建议 P2） |
| OQ-07 | 是否支持英文/双语输出？ | prompt 设计 | 待排（建议 P2，预留 `output_language` 配置项） |
| OQ-08 | 是否纳入结果缓存（FR-29）到首版？ | 成本控制 | 建议 P2 |
| OQ-09 ⭐ | 笔记存储格式：单文件按天 `YYYY-MM-DD.md`（Markdown）vs 统一 `notes.jsonl` vs 单库 SQLite？ | 笔记模块、可手编辑性、版本管理 | **已定：Markdown 单文件按天**（最易人工编辑 + Git 管理；见 4.8/9.3） |
| OQ-10 ⭐ | 通用笔记（无项目标签）默认行为：注入所有桶 vs 仅作为独立【日常工作】段 vs 两者兼有？ | 融合语义、token 成本 | **已定：两者兼有**——既注入当天所有桶作上下文，又作为独立段落兜底（见 FR-44） |
| OQ-11 ⭐ | `daily --push` 追加到周报草稿是否进首版？ | 日报与周报联动 | 建议 P2（依赖草稿机制） |
| OQ-12 ⭐ | 笔记是否支持时间戳（一天内多条同项目笔记的先后）？ | 笔记排序 | 建议 P2（`note add` 可追加 `HH:MM` 前缀） |

> ⭐ 为 v1.1 新增开放问题。
