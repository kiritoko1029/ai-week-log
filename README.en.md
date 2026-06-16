# WeekLog — Git Weekly/Daily Report Desktop Client

[![GitHub release](https://img.shields.io/github/v/release/kiritoko1029/ai-week-log?label=release)](https://github.com/kiritoko1029/ai-week-log/releases)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

English | [简体中文](./README.md)

Reads commit logs from local Git repositories, combines them with **manual notes** (meetings, communication, design, research, and other non-code work), and uses AI to fuse and summarize everything into structured *weekly* / *daily work reports*.

- **Dual-source fusion**: commits (code work) + notes (non-code work) are both fed to the AI, organized by *date → project*, 3–5 sentences per section.
- **Dual LLM backends**: OpenAI Responses API / Anthropic Messages API — switch with one config line, with a built-in connection test.
- **AI memory system**: local vector embeddings (Transformers.js + ONNX) + semantic retrieval accumulates context across reports and auto-infers the relevant project while you write notes.
- **WebDAV cloud sync**: notes / config / history synced across devices, with dedup + conflict alerts.
- **Cross-platform desktop app**: macOS (Apple Silicon / arm64) + Windows (x64).
- **Local-first**: network requests only happen when calling the LLM; notes, config, and memory all stay local.

---

## Tech Stack

- **Electron** main process (Node) + renderer (Web)
- **Renderer**: React 19 + TypeScript + Vite + Tailwind CSS v4 + shadcn/ui (Radix Primitives)
- **Git collection**: `child_process` invokes `git log` directly, parsed with `0x1e/0x1f` delimiters (encoding-safe, zero-dependency)
- **LLM calls**: Node built-in `fetch`, directly hitting OpenAI `/responses` and Anthropic `/v1/messages`, with exponential-backoff retries
- **Vector embeddings**: `@huggingface/transformers` (ONNX Runtime); model source auto-detected (ModelScope / HuggingFace)
- **Secure storage**: API keys go through the OS keychain (Windows DPAPI / macOS Keychain), never written in plaintext

---

## Features

| Module | Description |
|---|---|
| Dashboard | Weekly stats (commits / notes / token estimate), quick note, one-click generate |
| Generate weekly / daily | Custom date range, author filter, merge strategy, output format (text / md / json); reports support manual editing |
| Today's daily | Quick generation based on today's notes (works even on pure non-code days) |
| Notes | Browse by date timeline, searchable project dropdown, AI-memory-assisted categorization, raw Markdown editing |
| Repos | Manual add + **folder scan** (auto-discovers Git repos up to 3 levels deep, batch import with checkboxes) |
| History | Browse past reports, **edit & save** (marked "edited"), copy / export |
| AI & output settings | Switch provider, model / baseUrl / temperature, **connection test**, notes dir, output format, concurrency & fault tolerance |
| WebDAV sync | Bidirectional sync (pull / push / both), status panel, encrypted password storage |
| AI memory | Local vector store, accumulates across reports, semantic retrieval injection, view / rebuild / delete |
| Quick note | Global shortcut summons a floating window (default `Cmd/Ctrl+Shift+L`), auto-categorizes by project |

---

## Project Structure

```
ai-week-log/
├── package.json                # entry + electron-builder dual-platform config
├── src/
│   ├── main/                   # main process (Node)
│   │   ├── index.js            # window creation, lifecycle, tray, global shortcut
│   │   ├── ipc.js             # IPC handlers (config/repos/notes/collect/generate/history/sync/memory/AI test)
│   │   ├── config.js           # config load/save (JSON in userData)
│   │   ├── git.js              # git log collection + 0x1e/0x1f parsing + repo scanning
│   │   ├── notes.js            # notes Markdown read/write (## project sections)
│   │   ├── aggregator.js       # (date,project) bucketing + note fusion allocation
│   │   ├── pipeline.js         # orchestration: collect / generate / memory enqueue
│   │   ├── render.js           # text / md / json rendering
│   │   ├── tasks.js            # background task system (persists across pages)
│   │   ├── webdav.js           # WebDAV sync (bidirectional, dedup, conflict alerts)
│   │   ├── memory.js           # AI memory (embeddings, semantic retrieval, rebuild)
│   │   ├── secrets.js          # API key encrypted storage (safeStorage)
│   │   ├── utils.js            # dates, tokens, range parsing
│   │   └── llm/                # LLM adapter layer
│   │       ├── base.js         # abstraction + exceptions + exponential backoff
│   │       ├── openai.js       # OpenAI Responses API
│   │       ├── anthropic.js    # Anthropic Messages API
│   │       └── index.js        # factory + prompt engineering + connection test
│   ├── preload/index.js        # contextBridge secure bridge (window.weeklog)
│   └── renderer/               # renderer (React + Vite)
│       ├── index.html          # main window entry
│       ├── quicknote.html      # quick-note floating window entry
│       └── src/
│           ├── App.tsx         # root layout
│           ├── pages/          # dashboard / generate / daily / notes / repos / history / settings
│           ├── components/     # AppShell / Statusbar / ProjectSelect / ui (shadcn)
│           ├── hooks/          # useConfig / useGenerate / useTasks / useNav ...
│           └── styles/         # Tailwind + CSS variables (light / dark themes)
├── build/                      # app icons (icns / ico / png) + NSIS installer script
```

---

## Development

### 1. Install dependencies

```bash
pnpm install
```

> The project uses pnpm (`packageManager: pnpm@11.6.0`). On first install pnpm will ask whether to approve build scripts for some dependencies (e.g. `onnxruntime-node`, `sharp`); the AI memory feature depends on `onnxruntime-node`, so approval is recommended.

### 2. Configure API key

Two options (either works; the in-app value takes precedence):

**Option A — In-app (recommended):** Launch the app → "AI & output settings" → enter the key and save; click "Test connection" to verify instantly. The key is encrypted via the OS keychain, never written in plaintext.

**Option B — Environment variable:**

**Windows (PowerShell, permanent, reopen the app after):**
```powershell
setx ANTHROPIC_API_KEY "sk-ant-..."
# or OpenAI
setx OPENAI_API_KEY "sk-..."
```

**macOS (zsh, permanent):**
```bash
echo 'export ANTHROPIC_API_KEY="sk-ant-..."' >> ~/.zshrc
source ~/.zshrc
```

### 3. Launch

```bash
pnpm start            # normal launch
pnpm dev              # with DevTools (WEEKLOG_DEV=1)
```

On first launch: **Repos → Add repo / Scan folder** (register local Git repos and name the project) → in "AI & output settings" pick a provider/model (you can test the connection) → generate from "Generate weekly/daily".

---

## Build & Release

```bash
pnpm dist:win     # Windows x64 installer (NSIS) → release/
pnpm dist:mac     # macOS arm64 (dmg + zip) → release/
pnpm dist         # build both platforms (macOS build must run on macOS)
```

> ⚠️ The macOS arm64 build must be produced on macOS (Apple Silicon); the Windows x64 build on Windows. A CI matrix (GitHub Actions macos-latest + windows-latest) can produce both platforms automatically.

---

## Workflow

1. **Add repos**: Repos → Add repo / Scan folder → browse to a local Git dir → name the project (e.g. "Order System Frontend").
2. **Take notes** (optional but recommended): Dashboard / Notes → quick note, pick a project or leave blank (= general work). Notes are saved as `notes/YYYY-MM-DD.md` and can be sectioned with `## project name`.
3. **Generate**:
   - Dashboard "One-click generate" → this week's report
   - "Today's daily" → today's daily (works even on pure non-code days)
   - "Generate weekly/daily" → custom range / filters / format; **after generation you can edit directly in the preview**
4. **Fusion rules**: project-level notes go to the corresponding project section; general notes are injected into all of the day's project sections + form an independent "Daily Work" section.
5. **Review / revise**: History shows past reports and supports manual edit-and-save (marked "edited").

---

## Sample Output

```
2026/6/15
[Order System Frontend]: Updated the field layout of the order detail page per the product review, added a status filter component, and fixed a pagination param-loss bug.
[Order System Backend]: Added pagination and status filtering to the order list API, added a composite index for high-frequency queries, reducing P95 from 820ms to 210ms.
[Daily Work]: Attended an architecture review on microservice split boundaries in the morning; confirmed this week's schedule with product in the afternoon. (from manual notes)

2026/6/16
……
```

---

## Fault Tolerance

- LLM call failure (timeout / rate limit) → that unit **auto-degrades** to a concatenation of raw commits + notes; the full report is still produced.
- A single repo being inaccessible / corrupt → skipped with a warning; other repos are unaffected.
- Malformed note files / encoding errors → parsed leniently without interruption.
- GBK-encoded commit messages → tiered decoding (UTF-8 → GBK → GB18030).

---

## License

MIT
