# 《本地 Git 周报生成工具》实施计划文档

---

| 字段 | 内容 |
|---|---|
| 版本 | v1.1 |
| 日期 | 2026-06-13 |
| 工具代号 | `weeklog` |
| 对应需求 | PRD v1.1 |

### 变更记录

| 版本 | 日期 | 变更内容 |
|---|---|---|
| v1.0 | 2026-06-13 | 初版：采集/聚合/AI 适配/渲染 6 个里程碑 |
| v1.1 | 2026-06-13 | **新增**：笔记模块（`notes/`）、`Note` 数据模型、笔记融合到 pipeline、日报（`daily`）子命令、新增里程碑 M5「笔记与日报」及对应 WBS |

---

## 1. 概述与目标

构建一个 Python 命令行工具 `weeklog`，从本地 Git 仓库读取 commit 历史，**并结合用户手动笔记**，通过 AI 生成按「日期 → 项目」两级组织的《工作周报》/《日报》。

**首版（M1–M7）交付标准**：

- `weeklog` 单命令输出格式合规的本周周报；
- `weeklog daily` 输出今日日报；
- `weeklog note add/edit/list/show` 完整笔记管理；
- 笔记与 commit 融合后送 AI，覆盖非代码工作；
- 支持 OpenAI Responses API 与 Anthropic Messages API 双后端切换；
- Windows 11 中文环境下全流程无乱码、无崩溃；
- AI 失败时降级产出，整体周报/日报不中断；
- 通过全部 AC-01 ~ AC-18 验收标准。

---

## 2. 技术选型结论

### 2.1 语言与运行时

**Python 3.10+**（最低 3.10，推荐 3.11+）。

选择理由：
1. 文本/数据处理是主战场，Python 标准库（`subprocess`、`datetime`、`re`、`dataclasses`）直接够用；
2. `openai` / `anthropic` 官方 SDK 均有 Python 一等公民支持；
3. Python 3.11+ 内置 `tomllib`，无需额外 TOML 解析器；
4. `zoneinfo`（3.9+）提供 IANA 时区支持，Windows 上需额外安装 `tzdata` 包；
5. 笔记以 Markdown 文件存储 + 正则/轻量解析，标准库即可，无需重型 Markdown 依赖。

### 2.2 关键依赖清单

```toml
# pyproject.toml [project.dependencies]
[project]
name = "weeklog"
requires-python = ">=3.10"
dependencies = [
    "openai>=1.40",                         # OpenAI Responses API
    "anthropic>=0.40",                      # Anthropic Messages API
    "tomli>=2.0 ; python_version < '3.11'", # 3.10 的 TOML 后备
    "httpx>=0.27",                          # HTTP 客户端（重试/超时封装）
    "tzdata>=2024",                         # Windows IANA 时区数据库
    # Markdown 轻量解析用标准库 re 实现，无需第三方
]

[project.optional-dependencies]
dev = ["pytest>=8", "mypy>=1.10", "ruff>=0.4"]

[project.scripts]
weeklog = "weeklog.cli:main"
```

### 2.3 安装方式

```powershell
# 推荐（pipx 全局安装，隔离环境）
pipx install .

# 开发调试（可编辑安装）
pip install -e ".[dev]"
```

---

## 3. 系统架构与模块说明

### 3.1 分层架构

```
┌──────────────────────────────────────────────────────────────────┐
│              CLI 入口层  weeklog/cli.py                            │  argparse 解析、子命令路由、退出码
├──────────────────────────────────────────────────────────────────┤
│              编排层  weeklog/pipeline.py                           │  串联各领域模块的端到端流程
├──────────┬────────────┬──────────┬──────────┬──────────┬─────────┤
│  config  │ collector  │aggregator│  notes   │    ai    │renderer │
│  配置加载 │  Git 采集   │  分桶聚合 │ 笔记管理  │ AI 总结  │ 渲染输出 │
├──────────┴────────────┴──────────┴──────────┴──────────┴─────────┤
│          基础设施  weeklog/models.py  weeklog/utils/                │  数据模型、编码、时区、日志、异常
└──────────────────────────────────────────────────────────────────┘
```

### 3.2 模块职责与依赖关系

| 模块 | 职责 | 依赖 |
|---|---|---|
| `config` | 读取 TOML、合并默认值、环境变量注入 API Key、校验 | `models`, `utils` |
| `collector` | 对每个仓库执行 `git log`，处理编码，解析为 `Commit` 列表 | `models`, `utils.encoding` |
| `notes` ⭐ | 笔记文件读写、解析（`## 项目` 分段）、追加、编辑器调用 | `models`, `utils.dates` |
| `aggregator` | 项目识别策略；按 `(date, project)` 分桶；**将笔记分配到桶** | `models`, `config`, `notes` |
| `ai` | 统一适配层 + 总结逻辑：构造 prompt（含笔记），调 LLM，降级 | `models`, `config` |
| `renderer` | 将 `WeeklyReport` 渲染为 text/md/json | `models` |
| `pipeline` | 编排以上模块，传递数据（含笔记加载与融合） | 全部 |
| `cli` | 解析参数，调用 pipeline，处理退出码；`note`/`daily` 子命令 | `pipeline`, `config`, `notes` |

**依赖方向**（单向，无环）：
`cli → pipeline → {config, collector, notes, aggregator, ai, renderer} → {models, utils, errors}`

> ⭐ `notes` 模块为 v1.1 新增。

---

## 4. 目录结构

```
F:\code\open-design\week-log\
├── pyproject.toml
├── config.example.toml          # 配置模板（随仓库分发，用户复制为 weeklog.config.toml）
├── PRD.md
├── PLAN.md
├── notes/                       # ⭐ 笔记目录（默认；可在配置中改）
│   └── 2026-06-15.md            #    按天的 Markdown 笔记文件（用户手写或 note add 生成）
├── src/
│   └── weeklog/
│       ├── __init__.py          # 版本号
│       ├── __main__.py          # 支持 python -m weeklog
│       ├── cli.py               # argparse 入口、子命令路由（含 note/daily）、退出码
│       ├── pipeline.py          # 端到端编排：config→collect→load_notes→aggregate→summarize→render
│       ├── config.py            # TOML 加载、合并默认值、环境变量注入、Schema 校验
│       ├── models.py            # 全部 dataclass 数据模型（含 Note）
│       ├── errors.py            # 异常层次体系
│       ├── collector/
│       │   ├── __init__.py
│       │   ├── git_runner.py    # subprocess 封装调用 git，bytes 采集
│       │   └── log_parser.py    # 解析 git log 原始输出为 List[Commit]
│       ├── notes/               # ⭐ 笔记模块
│       │   ├── __init__.py
│       │   ├── store.py         # 笔记文件路径、加载区间笔记、追加写入
│       │   ├── parser.py        # 解析 notes/YYYY-MM-DD.md 的 ## 项目 分段
│       │   └── editor.py        # 调用 $EDITOR 打开笔记文件（Windows 回退 notepad）
│       ├── aggregator.py        # 项目识别策略 + (date,project) 分桶 + 笔记分配到桶
│       ├── ai/
│       │   ├── __init__.py
│       │   ├── base.py          # LLMProvider 抽象 + LLMResult + 异常 + 重试逻辑
│       │   ├── openai_client.py # OpenAI Responses API 实现
│       │   ├── anthropic_client.py  # Anthropic Messages API 实现
│       │   ├── factory.py       # create_provider(cfg) 工厂
│       │   ├── prompt.py        # system/user prompt 模板（含笔记融合分段）
│       │   ├── tokens.py        # token 估算、截断、fit_commits（commit+笔记合计）
│       │   └── summarizer.py    # 遍历桶调 LLM、并发控制、降级
│       ├── renderer.py          # WeeklyReport → text/md/json 字符串
│       └── utils/
│           ├── encoding.py      # bytes 分级解码（utf-8 → gbk → gb18030 → replace）
│           ├── dates.py         # 时区转换、本地日期、ISO 周、日期范围、today/yesterday 解析
│           └── logging.py       # 统一日志配置（过滤 API Key）
└── tests/
    ├── conftest.py              # pytest fixtures（含临时 notes 目录）
    ├── test_log_parser.py
    ├── test_aggregator.py
    ├── test_note_parser.py      # ⭐ 笔记解析与分配
    ├── test_note_store.py       # ⭐ 笔记追加/编辑
    ├── test_renderer.py
    ├── test_ai_providers.py     # mock server 测试两种 provider（含笔记 prompt）
    ├── test_pipeline_e2e.py     # 端到端集成测试（含笔记融合、日报）
    └── fixtures/
        ├── sample_git_log.txt   # 样例 git log 原始输出
        ├── sample_config.toml
        ├── sample_notes/        # ⭐ 样例笔记文件
        └── golden_report.txt    # 黄金输出快照
```

---

## 5. 核心数据结构与关键接口定义

### 5.1 数据模型（`weeklog/models.py`）

```python
from dataclasses import dataclass, field
from datetime import datetime, date

@dataclass
class FileChange:
    status: str   # 'A' | 'M' | 'D' | 'R' | 'C'
    path: str     # 变更文件路径（重命名取目标路径）

@dataclass
class Commit:
    hash: str
    author_name: str
    author_email: str
    date: datetime        # 本地时区的提交时间
    subject: str          # commit 标题（首行）
    body: str             # commit 正文（可空）
    files: list[FileChange] = field(default_factory=list)
    insertions: int = 0
    deletions: int = 0
    repo: str = ""        # 来源仓库路径
    project: str = ""     # 经识别策略归属的项目名（聚合阶段填充）
    is_merge: bool = False

    @property
    def day(self) -> date:
        return self.date.date()

@dataclass
class Note:                # ⭐ v1.1 新增
    date: date
    project: str | None    # None 或 miscProject（如"日常工作"）= 通用笔记
    content: str
    source: str = ""       # 来源文件路径

@dataclass
class ProjectDayBucket:
    """同一天、同一项目的工作集合（commit + 笔记），最小 AI 总结单元"""
    day: date
    project: str
    commits: list[Commit] = field(default_factory=list)
    notes: list[Note] = field(default_factory=list)   # ⭐ 项目级笔记
    shared_notes: list[Note] = field(default_factory=list)  # ⭐ 当天通用笔记（共享上下文）
    is_notes_only: bool = False   # ⭐ True=该桶无 commit，纯笔记（如【日常工作】段）

@dataclass
class ParagraphSummary:
    project: str
    text: str                 # 3-5 句中文总结
    source_commit_count: int
    source_note_count: int = 0   # ⭐
    degraded: bool = False    # AI 失败时走降级为 True

@dataclass
class DaySummary:
    day: date
    paragraphs: list[ParagraphSummary] = field(default_factory=list)

@dataclass
class WeeklyReport:
    range_start: date
    range_end: date
    days: list[DaySummary] = field(default_factory=list)   # 日期升序
    failed_units: list[str] = field(default_factory=list)  # 失败单元描述
    meta: dict = field(default_factory=dict)               # provider/model/生成时间/笔记数
```

### 5.2 笔记模块接口（`weeklog/notes/`）⭐

```python
# notes/store.py
def note_file_path(notes_dir: str, d: date) -> str:
    """notes_dir/YYYY-MM-DD.md"""

def load_notes(notes_dir: str, start: date, end: date) -> list[Note]:
    """读取区间内所有笔记文件，解析为 Note 列表；缺失文件跳过"""

def append_note(notes_dir: str, d: date, project: str | None, content: str) -> str:
    """向当天笔记文件追加一条；段/文件不存在则创建；返回写入的文件路径"""

# notes/parser.py
def parse_note_file(path: str, misc_project: str) -> list[Note]:
    """解析单个笔记文件：
       - 按 '## <项目名>' 切分段；标题段名 == misc_project 或文件顶部无标题内容 -> project=None
       - 返回该文件内所有 Note"""

# notes/editor.py
def open_editor(path: str) -> None:
    """调用 os.environ['EDITOR']（Windows 回退 notepad，其它回退 vi）打开文件"""
```

### 5.3 LLMProvider 抽象接口（`weeklog/ai/base.py`）

```python
from abc import ABC, abstractmethod
from dataclasses import dataclass

@dataclass(frozen=True)
class LLMResult:
    text: str
    input_tokens: int = 0
    output_tokens: int = 0
    model: str = ""

class LLMError(Exception): pass
class LLMTimeout(LLMError): pass
class LLMRateLimited(LLMError): pass   # 429，可重试
class LLMServerError(LLMError): pass   # 5xx，可重试
class LLMAuthError(LLMError): pass     # 401/403，不可重试
class LLMBadRequest(LLMError): pass    # 400，不可重试

class LLMProvider(ABC):
    def __init__(self, *, model: str, api_key: str, base_url: str,
                 temperature: float, max_tokens: int,
                 timeout: float, max_retries: int): ...

    @abstractmethod
    def summarize(self, system_prompt: str, user_prompt: str) -> LLMResult: ...

    def _request_with_retry(self, *, url: str, headers: dict, json_body: dict) -> dict:
        # 指数退避 + 抖动：min(2^(n-1), 30) + random(0,1)
        # 429 优先尊重 Retry-After 响应头
        # LLMAuthError / LLMBadRequest 立即失败，不重试
        ...
```

### 5.4 Prompt 组装接口（`weeklog/ai/prompt.py`）⭐ 含笔记融合

```python
SYSTEM_PROMPT = """你是一名资深研发周报/日报助手……（3-5 句、中文、客观、不杜撰、不输出【】前缀）。
输入包含两类信息源：【代码提交】与【人工笔记】，二者均为真实工作，请统一归纳为 3-5 句总结，
不得因来源不同而割裂或忽略笔记中的非代码工作（如会议、沟通、设计、调研）。"""

def build_user_prompt(bucket: ProjectDayBucket) -> str:
    """输出结构：
       项目名称：{project}    日期：{date}
       【代码提交】
         1. {subject}（说明：{body}）改动文件：...
       【人工笔记】
         {项目级笔记内容}
         {当天通用笔记内容（标注为"当日通用补充"）}
       请按系统指令输出 3-5 句中文总结。"""
```

### 5.5 工厂与 Pipeline 接口

```python
# ai/factory.py
def create_provider(cfg: dict) -> LLMProvider: ...

# pipeline.py
def run(cfg: Config, cli_overrides: dict, *, mode: str = "weekly") -> tuple[WeeklyReport, int]:
    """
    mode: "weekly"（区间）| "daily"（单天）
    返回 (report, exit_code)
    exit_code: 0=成功, 1=致命错误, 2=部分降级, 3=git不可用, 4=空结果+fail_on_empty
    流程：config → collect(commits) → load_notes → aggregate(分桶+分配笔记) → summarize → render
    """
```

---

## 6. 配置文件设计（完整示例）

```toml
# config.example.toml
# 复制为 weeklog.config.toml 并修改以下字段后即可使用。

# ── 时间与地区 ──────────────────────────────────────────────────────────
weekStart  = "monday"          # "monday" | "sunday"
timezone   = "Asia/Shanghai"   # IANA 时区（Windows 需安装 tzdata 包）
dateBasis  = "author"          # "author" | "committer"

# ── 仓库列表（可添加多个 [[repos]] 节） ──────────────────────────────────
[[repos]]
path    = "F:/code/my-frontend"    # 支持正/反斜杠
name    = "某某系统前端"            # 周报中的【项目名】
branch  = "main"                   # 缺省=采集当前分支
enabled = true
# author = "me@corp.com"           # 仓库级作者覆盖（缺省继承全局 filters.author）

[[repos]]
path = "F:/code/my-backend"
name = "某某系统后端"

# ── 过滤规则 ─────────────────────────────────────────────────────────────
[filters]
author       = []                  # 空=不过滤；填邮箱/用户名只看本人提交
mergeCommits = "exclude"           # "exclude" | "include" | "only"
excludeGrep  = ["^chore:", "^Merge branch", "^Merge remote"]
# mergeSameProject = true          # 跨仓库同名项目是否合并（默认 true）

# ── 笔记配置（v1.1 新增） ────────────────────────────────────────────────
[notes]
enabled     = true                 # false=全局关闭笔记融合（等价 --no-notes）
dir         = "notes"              # 笔记目录，相对配置文件所在目录；也可填绝对路径
miscProject = "日常工作"            # 无项目标签笔记归属的虚拟项目名（纯非代码工作日报段）

# ── AI 后端 ──────────────────────────────────────────────────────────────
[ai]
provider        = "anthropic"      # "openai" | "anthropic"  ← 切换这一行即可换后端
model           = "claude-sonnet-4-6"
temperature     = 0.3
maxOutputTokens = 800
maxInputTokens  = 6000             # 超过此阈值则截断/分批（commit + 笔记合计计算）
concurrency     = 3                # 并发调用桶数
retries         = 3
timeoutSeconds  = 60
baseUrl         = ""               # 留空用官方默认；私有网关时填 https://your-gw/v1
# promptTemplatePath = ""          # 外置 prompt 模板路径（留空用内置）
# maxCalls = 100                   # 单次运行 AI 调用硬上限（成本闸）

# OpenAI 对应配置（切换 provider = "openai" 时生效）：
# model    = "gpt-4o"
# baseUrl  = ""   # 或 https://your-openai-compatible-gateway/v1

# API Key 从环境变量读取（推荐，不写入此文件）：
# Anthropic：ANTHROPIC_API_KEY
# OpenAI   ：OPENAI_API_KEY
# 若变量名不同，可用 apiKeyEnv = "MY_CUSTOM_KEY_VAR" 覆盖

# ── 输出格式 ─────────────────────────────────────────────────────────────
[output]
format      = "text"               # "text" | "md" | "json"
dateFormat  = "YYYY/M/D"           # 月日无前导零
newline     = "CRLF"               # Windows 默认；Linux/macOS 用 "LF"
encoding    = "utf-8"
withCommits = false                # true=摘要后附 commit shortHash 列表
showNotes   = false                # true=摘要后附原始笔记（溯源）
failOnEmpty = false                # true=无 commit 且无笔记时返回退出码 4

# ── 可选：脱敏规则（作用于 commit 与笔记） ───────────────────────────────
# [[redaction]]
# pattern = "ProjectX"
# replace = "项目A"
```

---

## 7. 里程碑划分

| 里程碑 | 目标 | 关键交付物 |
|---|---|---|
| **M1 骨架（基础采集）** | 单仓库 commit 采集 + 配置系统骨架 + CLI 基本框架 | `models`, `config`, `collector`, `cli init/repo`, `pipeline` 骨架 |
| **M2 多仓库聚合** | 多仓库 commit 按（日期,项目）正确分桶，排序、过滤、去重 | `aggregator`, 完整 `config` 校验 |
| **M3 AI 适配层** | OpenAI + Anthropic 双后端均可正常调用，摘要格式符合规范 | `ai/` 全模块（base、两个 client、factory、prompt、tokens、summarizer） |
| **M4 渲染输出** | 完整周报输出（text/md/json），格式精确匹配规范 | `renderer`, `pipeline` 完整串联 |
| **M5 笔记与日报** ⭐ | 笔记存储/管理/解析/融合 + 日报生成 | `notes/` 模块、`cli note/daily`、pipeline 笔记加载与融合 |
| **M6 可靠性** | 容错/降级/重试/退出码/编码处理均通过验收（含笔记边界） | 集成测试套件（AC-01~AC-18） |
| **M7 体验打磨** | `--dry-run`、帮助文档、Windows 编码、性能基线、配置模板完善 | `--dry-run` 实现、文档、性能基准测试 |

> ⭐ M5 为 v1.1 新增里程碑。

---

## 8. 详细任务分解（WBS）

### M1：骨架（基础采集）

- [ ] 初始化 pyproject.toml，配置 `weeklog` entry point
- [ ] 创建 `src/weeklog/` 包结构（所有目录和 `__init__.py`）
- [ ] `errors.py`：定义 `WeeklogError` / `ConfigError` / `GitError` / `CollectError` / `NoteError` 异常层次
- [ ] `models.py`：实现 `FileChange` / `Commit` / `Note` / `ProjectDayBucket` / `ParagraphSummary` / `DaySummary` / `WeeklyReport` dataclass
- [ ] `utils/encoding.py`：`decode_bytes(b: bytes) -> str`（分级解码：utf-8 → gbk → gb18030 → replace）
- [ ] `utils/dates.py`：
  - [ ] `resolve_range(args, cfg, mode) -> (date, date)`（处理 `--week`、`--from/--to`、`--days`、daily 的单天）
  - [ ] `parse_date_keyword(s) -> date`（`today`/`yesterday`/`YYYY-MM-DD`）
  - [ ] `local_date(dt_str, timezone) -> date`（时区转换）
  - [ ] `iso_week_range(year, week, weekStart) -> (date, date)`（ISO 周边界）
- [ ] `utils/logging.py`：统一日志格式，过滤 API Key（正则掩码 `sk-...xxxx`）
- [ ] `config.py`：
  - [ ] `load(path: str | None) -> Config`（TOML 加载 + 优先级合并 + 环境变量展开 `${ENV_VAR}`）
  - [ ] `validate(cfg)` 校验：路径存在性、provider 合法性、project name 非空去重、`notes.dir` 可写
- [ ] `collector/git_runner.py`：
  - [ ] `check_git()` — `shutil.which("git")` 检测，缺失报 `GitError` 退出码 3
  - [ ] `is_git_repo(path) -> bool`
  - [ ] `run_git_log(repo_path, since, until, author, branch, no_merges) -> bytes`
  - [ ] git log 命令：`%x1e%H%x1f%an%x1f%ae%x1f%ad%x1f%s%x1f%b%x1f` + `--date=format-local:%Y-%m-%d %H:%M:%S` + `--name-only` + `-c i18n.logOutputEncoding=UTF-8`
- [ ] `collector/log_parser.py`：
  - [ ] `parse(raw: str, repo: str, project: str) -> list[Commit]`
  - [ ] 容错：字段数量不足用空字符串填充
- [ ] `cli.py`：实现 `init` / `repo add` 子命令
- [ ] `pipeline.py`：骨架框架

**M1 验收**：`weeklog init` 生成配置模板；`weeklog --dry-run` 可采集单仓库 commit 并打印结果。

---

### M2：多仓库聚合

- [ ] `aggregator.py`：
  - [ ] `identify_project(commit, repo_cfg) -> str` — 三种策略（配置名 → 子目录映射 → 仓库目录名）
  - [ ] `bucket(commits, notes) -> list[ProjectDayBucket]`（v1.1：接收 notes 参数，占位先忽略）
  - [ ] 按 hash 去重（跨仓库/跨分支）
  - [ ] 同名项目跨仓库合并（`mergeSameProject` 可配）
  - [ ] 桶内 commit 按时间升序排序
- [ ] `pipeline.py`：串联 config → collect → aggregate
- [ ] `cli.py`：实现 `collect` 子命令（输出中间 JSON，暂不含 notes）
- [ ] 时区边界测试：`tests/test_aggregator.py`（UTC+8 跨午夜、跨夏令时、ISO 周年末边界）
- [ ] 过滤测试：验证 `--author` / `--branch` / `--merge exclude` 与手工 `git log` 一致（AC-07）

**M2 验收**：多仓库 commit 归属日期 100% 准确（AC-01）；输出日期升序且无空分组（AC-02）。

---

### M3：AI 适配层

- [ ] `ai/base.py`：`LLMProvider` 抽象类 + `LLMResult` + 异常体系 + `_request_with_retry`（指数退避）
- [ ] `ai/prompt.py`：
  - [ ] `SYSTEM_PROMPT` 常量（3-5 句、中文、客观、不输出【】前缀、不杜撰、**声明两类信息源需统一归纳**）
  - [ ] `build_user_prompt(project, date, commits, notes, shared_notes) -> str`（M3 阶段 notes 先传空，M5 接入）
  - [ ] `build_commits_block(commits) -> str`
- [ ] `ai/tokens.py`：
  - [ ] `estimate_tokens(text: str) -> int`
  - [ ] `fit_commits(commits, budget) -> (kept, omitted_count)`
- [ ] `ai/openai_client.py`：
  - [ ] 端点：`POST {base_url}/responses`；header：`Authorization: Bearer <key>`
  - [ ] body：`model`, `instructions`, `input`, `max_output_tokens`, `temperature`
  - [ ] 响应解析：优先 `output_text` 聚合字段，否则 `output[] → message → content[] → output_text`
- [ ] `ai/anthropic_client.py`：
  - [ ] 端点：`POST {base_url}/messages`；header：`x-api-key`, `anthropic-version: 2023-06-01`, `Content-Type`
  - [ ] body：`model`, `max_tokens`（必填）, `system`（顶层）, `messages`, `temperature`
  - [ ] 响应解析：`content[]` 中 `type==text` 的 `text` 拼接
- [ ] `ai/factory.py`：注册表 + `create_provider(cfg) -> LLMProvider`
- [ ] `ai/summarizer.py`：
  - [ ] `summarize_bucket(bucket, provider, prompt_cfg) -> ParagraphSummary`
  - [ ] `summarize_with_fallback(...)` — 捕获 `LLMError`，调用 `fallback_summary`（v1.1：降级拼接 commit + 笔记原文）
  - [ ] `run_all(buckets, provider, concurrency) -> list[ParagraphSummary]` — 线程池并发
- [ ] `tests/test_ai_providers.py`：mock 分别测试两种 provider 的请求构造和响应解析（AC-05）

**M3 验收**：切换 `provider` 配置可分别走两种后端，摘要句数 [3,5]（AC-03/05）；AI 失败降级成功（AC-09）。

---

### M4：渲染输出

- [ ] `renderer.py`：
  - [ ] `render_text(report) -> str` — 严格匹配格式规范（`YYYY/M/D`、全角冒号、日期块间空行；纯笔记段排末尾）
  - [ ] `render_markdown(report) -> str` — 日期用 `## 2026/6/15`，项目用 `- **【…】**：…`
  - [ ] `render_json(report) -> str` — `dataclasses.asdict(report)` 序列化（`date` → ISO 字符串，含笔记字段）
  - [ ] `format_date(d: date) -> str` — 手动拼接 `f"{d.year}/{d.month}/{d.day}"`（避免 strftime 跨平台差异）
  - [ ] `--show-notes` 渲染：每段后附原始笔记（可选）
- [ ] `pipeline.py`：完整串联 config→collect→aggregate→summarize→render→output（M5 注入 notes）
- [ ] `cli.py`：
  - [ ] `render` 子命令
  - [ ] `--out <file>` 写文件（添加时间戳后缀）
  - [ ] stdout 输出前 `sys.stdout.reconfigure(encoding="utf-8")`
- [ ] `tests/test_renderer.py`：黄金快照测试（AC-04）
- [ ] `tests/test_pipeline_e2e.py`：全流程集成测试（AC-01~AC-04）

**M4 验收**：`weeklog --from ... --to ...` 全流程输出格式精确匹配规范（AC-04）。

---

### M5：笔记与日报 ⭐ v1.1 新增

#### 5.1 笔记存储与解析

- [ ] `notes/store.py`：
  - [ ] `note_file_path(notes_dir, d) -> str` — `{notes_dir}/YYYY-MM-DD.md`
  - [ ] `load_notes(notes_dir, start, end) -> list[Note]` — 遍历区间日期，读取存在文件
  - [ ] `append_note(notes_dir, d, project, content) -> str` — 定位/创建文件与 `## 段`，追加内容行；返回路径
- [ ] `notes/parser.py`：
  - [ ] `parse_note_file(path, misc_project) -> list[Note]` — 按 `^## (.+)$` 切段；段名==misc_project 或顶部无标题 → `project=None`（通用）；解码用 `utils.encoding`
  - [ ] 容错：无 `##` 段时整文件作当天通用笔记（EC-19）；损坏文件跳过并警告
- [ ] `notes/editor.py`：
  - [ ] `open_editor(path)` — `$EDITOR`；Windows 回退 `notepad`，其它回退 `vi`；失败提示手动路径（EC-22）
- [ ] `tests/test_note_parser.py`：多项目段、通用段、空文件、GBK、损坏文件（AC-10）
- [ ] `tests/test_note_store.py`：`append_note` 创建/追加、跨天隔离

#### 5.2 笔记融合到聚合

- [ ] `aggregator.py` 升级：
  - [ ] `assign_notes(buckets, notes, misc_project)` — 项目级笔记归对应桶 `notes`；通用笔记写入当天所有桶的 `shared_notes`（AC-21 去重由 prompt 处理）
  - [ ] 纯笔记桶：当天有笔记但无 commit 的项目（含 miscProject）→ 创建 `is_notes_only=True` 的桶（S12/AC-16）
  - [ ] `--no-notes` / `notes.enabled=false` 时跳过笔记加载
- [ ] `ai/prompt.py` 升级 `build_user_prompt`：注入 `【代码提交】` 与 `【人工笔记】`（项目级 + 当日通用）分段（AC-15）
- [ ] `ai/tokens.py`：token 预算计入笔记；超限时笔记与 commit 一并参与 `fit` 截断

#### 5.3 笔记管理 CLI

- [ ] `cli.py` 实现 `note` 子命令组：
  - [ ] `note add <text> [-d] [-p]` — 调 `append_note`（AC-15）；`-p` 项目名校验（EC-23）
  - [ ] `note edit [-d]` — 调 `open_editor`（AC-18）
  - [ ] `note list [--from --to]` — 列出每天笔记条目数
  - [ ] `note show <date>` — 打印某天笔记内容
- [ ] `collect` 子命令输出中间 JSON 含 `notes` 字段（schemaVersion 升 2）

#### 5.4 日报生成

- [ ] `cli.py` 实现 `daily` 子命令：
  - [ ] `--date today|yesterday|YYYY-MM-DD`（默认 today），调 `parse_date_keyword`
  - [ ] `--no-commits-ok`：当天无 commit 有笔记时仍生成（AC-16）
  - [ ] 复用 `pipeline.run(cfg, overrides, mode="daily")`，range 收窄为 `[date, date]`
- [ ] `pipeline.py` 支持 `mode="daily"`：与 weekly 共用流程，仅 range 不同

**M5 验收**：`note add → weeklog` 笔记被融合进摘要（AC-15）；纯笔记日报产出（AC-16）；`--no-notes` 生效（AC-17）；`note edit` 编辑器回退（AC-18）。

---

### M6：可靠性

- [ ] 容错场景测试：
  - [ ] EC-11：仓库不存在/非 git 仓库，其余仓库正常产出（AC-09）
  - [ ] EC-07/EC-19：GBK commit 与笔记文件不崩溃不乱码（AC-10）
  - [ ] EC-01：无 commit 且无笔记不报错，友好提示
  - [ ] EC-06：超长 commit body/笔记截断，超多 commit 走 fit_commits
  - [ ] EC-20：笔记引用未配置项目仍生成段落并提示
- [ ] AI 失败容错：
  - [ ] 单元 AI 失败降级（拼接 commit + 笔记原文），整体退出码 2（NFR-15, AC-09）
  - [ ] 全部 AI 失败配置 `failOnAI=true` 时退出码 1
  - [ ] 401/403 快速失败不重试（NFR-19）
- [ ] 退出码验证：按规范实现 0/1/2/3/4 各场景
- [ ] 隐私断言：
  - [ ] 外发载荷不含 API Key（AC-13）
  - [ ] 外发载荷不含 diff 内容（AC-08）；笔记受脱敏规则约束
- [ ] Windows 编码全流程：
  - [ ] `git -c i18n.logOutputEncoding=UTF-8` 默认传入
  - [ ] `decode_bytes` 单元测试覆盖 GBK/GB18030/replace 三条路径
  - [ ] 笔记文件同样走分级解码

**M6 验收**：AC-07/08/09/10/13/14 全部通过；笔记边界 EC-19/20/21/22/23 覆盖。

---

### M7：体验打磨

- [ ] `--dry-run` 完整实现：打印桶数、每桶 commit 数与笔记数、预估总 token，不调用 AI（含笔记）
- [ ] `cli.py` 帮助文档：`--help` 含全部参数与示例（含 note/daily）（NFR-14）
- [ ] `config.example.toml`：完整注释配置模板（含 `[notes]`）（AC-12）
- [ ] Windows 控制台：文档补充 `chcp 65001` 提示
- [ ] 性能基准测试：构造 10 仓库×1000 commit + 区间笔记数据集，断言采集阶段 < 5s、笔记加载 < 200ms（NFR-08/09）
- [ ] `weeklog scan <dir>` 子命令（P1）
- [ ] `--with-commits` / `--show-notes` 输出（P1）
- [ ] `tests/test_pipeline_e2e.py` 补全 AC-11（Windows 全流程冒烟，含 note/daily）
- [ ] 发布 `README.md`（安装、快速开始、配置说明、笔记用法、FAQ）

---

## 9. 开发顺序与依赖关系

```
utils/（encoding, dates, logging）
    │
    ▼
models.py（含 Note）──→ errors.py
    │
    ▼
config.py
    │
    ├──────────────────────────────────────┐
    ▼                                      ▼
collector/（M1）                   ai/base.py（M3 前置）
    │                                      │
    ▼                                      ▼
aggregator.py 骨架（M2）           ai/{prompt,tokens}（M3）
    │                                      │
    ├──────────────┐                       │
    ▼              ▼                       ▼
notes/（M5）  ai/{openai,anthropic,factory,summarizer}（M3）
    │                                      │
    └──────┬───────────────────────────────┘
           ▼
   aggregator 升级（分配笔记，M5）
           │
           ▼
       renderer.py（M4）
           │
           ▼
    pipeline.py（M4 串联，M5 注入 notes、daily 模式）
           │
           ▼
       cli.py（贯穿各里程碑：init/repo→collect→note/daily→render）
```

关键规则：
1. `models.py`（含 `Note`）必须在所有业务模块之前完成；
2. `notes/` 模块在 M5 开发，但 `models.Note` 在 M1 即定义，避免后续返工；
3. `aggregator.py` 在 M2 先支持纯 commit，M5 升级为接收并分配 notes；
4. `pipeline.py` 骨架在 M1 建立，逐步填充，M5 加入 notes 加载与 daily 模式。

---

## 10. 测试计划

### 10.1 单元测试

| 测试文件 | 覆盖目标 |
|---|---|
| `test_log_parser.py` | 各 commit 格式（含多行 body、GBK、空 body、rename 文件） |
| `test_note_parser.py` ⭐ | 多项目段、通用段、空文件、GBK 笔记、损坏文件 |
| `test_note_store.py` ⭐ | `append_note` 创建/追加、跨天隔离、项目名校验 |
| `test_aggregator.py` | 分桶正确性、时区边界、去重、项目识别、**笔记分配到桶、纯笔记桶** |
| `test_renderer.py` | text/md/json 格式精确匹配黄金快照；纯笔记段排末尾 |
| `test_ai_providers.py` | mock HTTP 测试 OpenAI/Anthropic 请求构造/响应解析/重试/降级；**断言 prompt 含笔记分段** |

### 10.2 集成测试

| 测试文件 | 覆盖目标 |
|---|---|
| `test_pipeline_e2e.py` | 完整流程；多仓库归属；笔记融合进摘要；纯笔记日报；降级输出；`--no-notes` |

### 10.3 手工验收要点

| 场景 | 验证步骤 |
|---|---|
| 首次安装体验 | `weeklog init` → 配置 → `weeklog note add "测试笔记"` → `weeklog --dry-run` 预览桶与笔记 |
| 笔记融合 | `note add -p 某项目 "会议纪要"` → `weeklog daily` → 确认【某项目】段含会议内容 |
| 纯笔记日报 | 当天无 commit → `note add "全天开会"` → `weeklog daily --no-commits-ok` → 产出【日常工作】段 |
| OpenAI 切换 | 改 `provider = "openai"` → `weeklog` → 周报格式与 Anthropic 一致 |
| 私有网关 | 改 `baseUrl = "http://localhost:8080/v1"` → 确认流量走本地 mock（笔记亦走本地） |
| AI 失败降级 | 设无效 Key → 退出码 2、降级摘要含 commit + 笔记原文 |
| 笔记编辑器 | `$EDITOR` 未设置 → Windows 回退 `notepad` 打开当天笔记 |

---

## 11. 命令行使用示例

```powershell
# ── 周报 ─────────────────────────────────────────────────────────────
weeklog                                          # 本周周报（自动融合笔记）
weeklog --from 2026-06-08 --to 2026-06-14 --output md --out 周报_W24.md
weeklog --week last                              # 上周周报
weeklog --project "某某系统前端,某某系统后端" --me
weeklog --no-notes                               # 仅基于 commit，忽略笔记

# ── 日报（v1.1 新增）─────────────────────────────────────────────────
weeklog daily                                    # 今天日报（commit + 笔记）
weeklog daily --date yesterday                   # 昨天日报
weeklog daily --no-commits-ok                    # 纯非代码工作日报

# ── 笔记（v1.1 新增）─────────────────────────────────────────────────
weeklog note add "参加架构评审，确认订单服务拆分方案"           # 今天通用笔记
weeklog note add -p "某某系统前端" "与产品确认列表页 v2 排期"     # 关联项目
weeklog note add -d 2026-06-12 "技术调研：向量数据库选型"        # 补写历史笔记
weeklog note edit                                # 用编辑器打开今天笔记
weeklog note list --from 2026-06-08 --to 2026-06-14
weeklog note show 2026-06-15

# ── 预演与离线 ────────────────────────────────────────────────────────
weeklog --from 2026-06-08 --to 2026-06-14 --dry-run        # 预览桶/笔记/token，不调 AI
weeklog collect --from 2026-06-08 --to 2026-06-14 --out raw.json
weeklog render --in raw.json --output md

# ── 后端切换 ──────────────────────────────────────────────────────────
weeklog --provider openai --model gpt-4o-mini

# ── 仓库管理 ──────────────────────────────────────────────────────────
weeklog init
weeklog repo add F:\code\new-service --name "新服务后端"
```

**周报示例输出**（含笔记融合的【日常工作】段）：

```
2026/6/9
【某某系统前端】：根据产品评审意见更新了订单详情页字段布局，新增状态筛选组件，修复分页跳转参数丢失缺陷。
【某某系统后端】：新增订单列表接口的分页与状态过滤，对高频查询加入复合索引，P95 从 820ms 降至 210ms，补充单元测试。
【日常工作】：上午参加架构评审会议讨论微服务拆分边界，下午与产品确认本周排期。
```

**纯笔记日报示例输出**（`daily --no-commits-ok`）：

```
2026/6/12
【日常工作】：全天参加架构评审与技术方案讨论，完成了订单服务拆分方案的设计文档，并与各端负责人对齐了接口契约。
```

---

## 12. 风险与对策

| 风险 | 概率 | 影响 | 对策 |
|---|---|---|---|
| Windows `strftime` 不支持 `%-m`（去前导零） | 高 | 日期格式错误 | 手动拼接 `f"{d.year}/{d.month}/{d.day}"` |
| Windows 无 IANA 时区数据（`zoneinfo.ZoneInfo` 失败） | 高 | 时区转换崩溃 | `tzdata` 列为强制依赖；捕获异常提示安装 |
| git 输出非 UTF-8 编码 | 高（Windows 旧仓库） | 乱码/崩溃 | 分级解码 + `git -c i18n.logOutputEncoding=UTF-8` |
| 笔记文件手动编辑后格式异常 | 中 | 解析错误/笔记丢失 | 容错解析（无段→通用笔记）、损坏文件跳过告警（EC-19） |
| 通用笔记注入所有桶导致 token 膨胀 | 中 | 成本上升/超限 | token 预算计入笔记；`fit` 截断；可配关闭通用笔记注入 |
| 笔记含高度敏感业务信息外发 | 中 | 隐私泄露 | 脱敏规则作用于笔记；私有网关；`--no-notes`；首次含笔记额外提示（NFR-01） |
| AI 限流 / 网络抖动 | 中 | 部分周报空缺 | 指数退避重试 + 降级保障产出 |
| commit + 笔记量极大 | 低 | 超 token 上限/高成本 | `fit_commits` 裁剪 + `maxInputTokens` 闸门 |
| OpenAI Responses API 结构与预期不符 | 中 | 解析失败 | 双保险解析 + 测试覆盖 |
| API Key 意外泄露到日志 | 低 | 安全事故 | 日志过滤正则 + AC-13 自动断言 |
| `note edit` 无可用编辑器 | 低 | 命令不可用 | Windows 回退 `notepad`，其它回退 `vi`，提示手动路径（EC-22） |

---

## 13. 后续迭代规划

| 迭代 | 功能 |
|---|---|
| v1.2 | 笔记时间戳（一天多条同项目笔记排序，OQ-12）；`daily --push` 追加到周报草稿（OQ-11） |
| v1.3 | 结果缓存（按桶内容+笔记哈希，省 token）；`--clipboard` 直接复制到剪贴板 |
| v1.4 | Batch 模式（一次请求总结多桶，降低调用次数）；`--format csv`；笔记导入/导出（FR-47） |
| v1.5 | monorepo 按子目录拆分项目（`split_by_subdir`）P2 功能完整化 |
| v2.0 | 插件化 provider 注册（Azure OpenAI、Gemini、本地 Ollama）；英文/双语输出 |
| v2.1 | 多语言输出；飞书/钉钉富文本推送；笔记富格式（清单、标签、关联工单） |
