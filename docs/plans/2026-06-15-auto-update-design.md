# WeekLog Auto Update Design

## Goal

Add automatic version checks and a one-click update flow for packaged WeekLog desktop builds.

## Approved Direction

- Use `electron-updater` with GitHub Releases as the update provider.
- Check for updates once after app startup in packaged builds.
- Add manual controls in Settings: current version, update status, check button, download button, install/restart button, and download progress.
- Keep update operations in the main process. Renderer talks through preload IPC only.
- Degrade cleanly in development or unpackaged runs: show the current version and return a friendly "updates are only available in packaged builds" status.

## Architecture

- `src/main/updater.js` owns `autoUpdater`, state snapshots, event wiring, and update commands.
- `src/main/ipc.js` registers update IPC handlers and pushes `updates:update` events to the main window.
- `src/preload/index.js` exposes a narrow `weeklog.updates` API.
- `src/renderer/src/pages/SettingsPage.tsx` renders the update controls inside the settings workflow.
- `package.json` declares `electron-updater` and `build.publish` for GitHub Releases.

## Data Flow

1. Main process initializes the updater after IPC registration.
2. Startup schedules a quiet `checkForUpdates()` in packaged builds.
3. Renderer opens Settings and calls `updates.status()` for the latest snapshot.
4. Manual "检查更新" calls `updates.check()`.
5. If an update is available, "下载更新" calls `updates.download()`.
6. Progress and status changes are sent over `updates:update`.
7. Once downloaded, "重启安装" calls `updates.install()`.

## Error Handling

- Development mode returns `disabled` without throwing.
- Network/provider failures are captured in state as `error`.
- Download/install commands validate the current state and return user-facing errors.
- The renderer never receives internal updater objects.

## Testing

- Add a Node smoke test that checks package dependency/config, updater module API, preload contract, IPC handlers, renderer type contract, and Settings UI strings.
- Keep existing smoke/type/build checks green.
