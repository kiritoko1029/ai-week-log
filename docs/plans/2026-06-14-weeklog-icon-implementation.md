# WeekLog Icon Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Generate and apply a minimal WeekLog desktop app icon with Windows `.ico`, macOS `.icns`, and renderer favicon coverage.

**Architecture:** Add a small dependency-free Node asset generator that renders the approved icon into PNG buffers and packages the PNG payloads into ICO/ICNS containers. Wire the generated assets into Electron runtime windows/tray and electron-builder packaging configuration.

**Tech Stack:** Electron, Vite, Node.js, PNG/ICO/ICNS binary generation with built-in `zlib` and `fs`.

---

### Task 1: Add Icon Asset Smoke Test

**Files:**
- Create: `tests/_icon_assets_test.js`

**Step 1: Write the failing test**

Add a Node smoke test that checks:
- `build/icon.png` exists and is 1024x1024 RGBA PNG.
- `build/icon.ico` exists and includes 16, 32, and 256 PNG entries.
- `build/icon.icns` exists and includes standard macOS icon chunk types.
- `src/renderer/public/icon.png` exists.
- `package.json` configures `directories.buildResources`, `mac.icon`, and `win.icon`.
- `src/main/index.js` uses an app icon path for BrowserWindow and tray.
- renderer HTML files link `./icon.png`.

**Step 2: Run test to verify it fails**

Run: `node tests/_icon_assets_test.js`

Expected: FAIL because icon assets and Electron integration are not present yet.

### Task 2: Generate Icon Assets

**Files:**
- Create: `scripts/generate-icons.js`
- Create: `build/icon.png`
- Create: `build/icon.ico`
- Create: `build/icon.icns`
- Create: `src/renderer/public/icon.png`

**Step 1: Implement the generator**

Use dependency-free Node code to:
- Draw a deep ink blue rounded-square background.
- Draw a white report page centered with a small cyan accent tab.
- Draw two or three short log lines.
- Encode PNG files with RGBA data.
- Write ICO and ICNS containers containing standard sizes.

**Step 2: Run the generator**

Run: `node scripts/generate-icons.js`

Expected: icon files are written to `build/` and `src/renderer/public/`.

### Task 3: Wire Electron and Renderer

**Files:**
- Modify: `package.json`
- Modify: `src/main/index.js`
- Modify: `src/renderer/index.html`
- Modify: `src/renderer/quicknote.html`

**Step 1: Configure packaging**

Set:
- `build.directories.buildResources` to `build`.
- `build.mac.icon` to `build/icon.icns`.
- `build.win.icon` to `build/icon.ico`.

**Step 2: Configure runtime icon usage**

Add an app icon path helper in `src/main/index.js`, pass `icon` to both BrowserWindow instances, set Dock icon on macOS when available, and use the PNG asset for tray icon loading.

**Step 3: Configure renderer favicon**

Add `<link rel="icon" href="./icon.png" />` to both renderer HTML entry points.

### Task 4: Verify

**Files:**
- Read: generated assets and changed source files.

**Step 1: Run icon smoke test**

Run: `node tests/_icon_assets_test.js`

Expected: PASS.

**Step 2: Run existing project checks**

Run:
- `npm run typecheck`
- `npm run build:renderer`
- `node tests/_smoke.js`

Expected: all commands exit 0.
