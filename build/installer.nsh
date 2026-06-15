; WeekLog 自定义 NSIS 脚本
; 功能：卸载时弹窗询问是否删除所有用户数据（笔记/配置/记忆/模型/缓存），实现纯净卸载
;
; 关键点：
; 1. !ifdef __UNINSTALL__ 确保只在真正卸载时执行，不误伤升级/覆盖安装
; 2. ${APP_FILENAME} 是 electron-builder 注入的变量（= productName 规范化）
; 3. SetShellVarContext current 指向当前用户；NSIS 内置 $APPDATA / $LOCALAPPDATA

!macro customUnInstall
  !ifdef __UNINSTALL__
    SetShellVarContext current

    ; 弹窗询问是否清除用户数据
    MessageBox MB_YESNO|MB_ICONQUESTION "是否同时删除 WeekLog 的所有用户数据？$\r$\n$\r$\n将清除：$\r$\n  • 笔记 (notes/)$\r$\n  • 配置 (config.json)$\r$\n  • AI 记忆库 (memory/)$\r$\n  • 历史报告 (history.json)$\r$\n  • 加密的 API Key (secrets.json)$\r$\n  • WebDAV 同步状态$\r$\n  • Embedding 模型缓存$\r$\n$\r$\n选择「否」则只卸载程序，保留数据（可重装后继续使用）。" IDNO skipUserData

      ; 用户选「是」→ 删除 %APPDATA%\WeekLog（主数据）
      ${if} ${FileExists} "$APPDATA\${APP_FILENAME}\*.*"
        RMDir /r "$APPDATA\${APP_FILENAME}"
      ${endif}

      ; 同时清理 %LOCALAPPDATA%\WeekLog（Electron 缓存/GPUCache 等）
      ${if} ${FileExists} "$LOCALAPPDATA\${APP_FILENAME}\*.*"
        RMDir /r "$LOCALAPPDATA\${APP_FILENAME}"
      ${endif}

    skipUserData:
  !endif
!macroend
