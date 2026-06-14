# WeekLog Icon Design

## Goal

Design and apply a simple, legible desktop app icon for WeekLog, including macOS icon adaptation.

## Approved Direction

- Shape: rounded square app icon.
- Subject: one simplified report page with two or three short log lines.
- Style: minimal, vector-friendly raster icon.
- Palette: deep ink blue background, white document body, restrained cyan accent.
- Avoid: Git branch diagrams, sparkles, dense decorations, text, shadows that obscure small sizes, and busy gradients.

## ImageGen Prompt

```text
Use case: logo-brand
Asset type: desktop application icon for Windows and macOS
Primary request: a simple, clear icon for WeekLog, a local Git worklog and weekly report desktop app
Subject: a single simplified report page with two or three short log lines, centered inside a rounded square
Style/medium: minimal vector-friendly raster app icon, flat shapes, crisp edges
Composition/framing: centered symbol, generous padding, strong silhouette, recognizable at 16px and 32px
Color palette: deep ink blue rounded-square background, white report page, small restrained cyan accent
Constraints: no text, no letters, no Git branch lines, no stars, no complex decoration, no watermark, no mockup scene
Avoid: excessive detail, photorealism, 3D render, tiny labels, busy gradients
```

## Application Targets

- `build/icon.png`: source PNG, 1024x1024.
- `build/icon.ico`: Windows installer and app icon.
- `build/icon.icns`: macOS app icon.
- `src/renderer/public/icon.png`: renderer favicon and Vite public asset.
- Electron main process: use the app icon for windows and tray where available.
- `package.json`: configure electron-builder `mac.icon` and `win.icon`.

## Notes

The approved design is intentionally simpler than the previous runtime tray icon. It should read as "work report / log" before "analytics" and stay clear at small Dock, taskbar, and tray sizes.
