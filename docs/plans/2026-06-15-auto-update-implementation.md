# Auto Update Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add automatic version checks and a one-click update workflow backed by `electron-updater`.

**Architecture:** Keep update state and commands in `src/main/updater.js`, expose a narrow IPC/preload API, and render update controls in Settings. Package metadata declares GitHub Releases as the provider so packaged builds can discover update artifacts.

**Tech Stack:** Electron, electron-updater, React + TypeScript, electron-builder GitHub publish configuration, Node smoke tests.

---

### Task 1: Add Auto Update Smoke Test

**Files:**
- Create: `tests/_auto_update_test.js`

**Step 1: Write the failing test**

Check that:
- `package.json` depends on `electron-updater`.
- `package.json.build.publish` targets GitHub `kiritoko1029/ai-week-log`.
- `src/main/updater.js` exists and exports `createUpdaterController`.
- `src/main/ipc.js` registers `updates:status`, `updates:check`, `updates:download`, and `updates:install`.
- `src/preload/index.js` exposes `weeklog.updates`.
- `src/renderer/src/types/weeklog.d.ts` defines update status types.
- `SettingsPage.tsx` contains update controls.

**Step 2: Run test to verify it fails**

Run: `node tests/_auto_update_test.js`

Expected: FAIL because the module, dependency, IPC, and UI are not implemented.

### Task 2: Install Dependency and Configure Publish

**Files:**
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`

**Step 1: Install dependency**

Run: `pnpm add electron-updater`

**Step 2: Configure GitHub publish**

Add:

```json
"publish": [
  {
    "provider": "github",
    "owner": "kiritoko1029",
    "repo": "ai-week-log"
  }
]
```

Expected: package metadata supports updater discovery in packaged builds.

### Task 3: Implement Main Updater Controller

**Files:**
- Create: `src/main/updater.js`
- Modify: `src/main/ipc.js`
- Modify: `src/main/index.js`

**Step 1: Implement controller**

Expose `createUpdaterController({ app, getMainWindow })` with:
- `status()`
- `check({ manual })`
- `download()`
- `install()`
- `scheduleStartupCheck(delayMs)`

Maintain a serializable state object with phase, current version, latest version, progress, error, and `isPackaged`.

**Step 2: Register IPC**

Register update handlers in `ipc.js`, and push `updates:update` events to the main window.

**Step 3: Startup check**

Create the controller in `index.js` and call `scheduleStartupCheck()`.

### Task 4: Expose Renderer Contract

**Files:**
- Modify: `src/preload/index.js`
- Modify: `src/renderer/src/types/weeklog.d.ts`

**Step 1: Preload API**

Expose:
- `updates.status()`
- `updates.check()`
- `updates.download()`
- `updates.install()`
- `updates.onUpdate(cb)`

**Step 2: TypeScript types**

Add update state/result interfaces to `WeeklogAPI`.

### Task 5: Add Settings UI

**Files:**
- Modify: `src/renderer/src/pages/SettingsPage.tsx`

**Step 1: State and subscription**

Load update status on mount and subscribe to `updates.onUpdate`.

**Step 2: Controls**

Add an "应用更新" card showing version/status/progress and buttons:
- 检查更新
- 下载更新
- 重启安装

**Step 3: Error handling**

Use existing `toast` for failures and keep buttons disabled when the current phase does not allow the action.

### Task 6: Verify

Run:

```bash
node tests/_auto_update_test.js
pnpm typecheck
pnpm build:renderer
node tests/_smoke.js
node tests/_security_regression_test.js
node tests/_icon_assets_test.js
```

Expected: all pass.
