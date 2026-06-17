; WeekLog 自定义 NSIS 脚本
; 功能：Windows 卸载时提供“清除用户数据”的复选项，默认保留数据。
;
; 关键点：
; 1. customUnWelcomePage 替换默认卸载欢迎页，在卸载执行前收集用户选择。
; 2. 默认不勾选，避免误删配置、历史、记忆库和模型缓存。
; 3. 只有用户勾选时，customUnInstall 才删除 Roaming userData 和 LocalAppData 缓存。

!ifdef BUILD_UNINSTALLER
!include nsDialogs.nsh
!include LogicLib.nsh

Var WeekLogDeleteUserData
Var WeekLogDeleteUserDataCheckbox

!macro customUnWelcomePage
  UninstPage custom un.weekLogUninstallOptionsShow un.weekLogUninstallOptionsLeave
!macroend

Function un.weekLogUninstallOptionsShow
  StrCpy $WeekLogDeleteUserData "0"

  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 24u "将从此电脑卸载 WeekLog。"
  Pop $0

  ${NSD_CreateLabel} 0 30u 100% 40u "默认只删除程序文件，保留配置、历史报告、AI 记忆库、WebDAV 状态、API Key 和 Embedding 模型缓存，方便以后重新安装继续使用。"
  Pop $0

  ${NSD_CreateCheckbox} 0 82u 100% 16u "同时清除 WeekLog 用户数据和缓存"
  Pop $WeekLogDeleteUserDataCheckbox
  ${NSD_SetState} $WeekLogDeleteUserDataCheckbox ${BST_UNCHECKED}

  nsDialogs::Show
FunctionEnd

Function un.weekLogUninstallOptionsLeave
  ${NSD_GetState} $WeekLogDeleteUserDataCheckbox $WeekLogDeleteUserData
FunctionEnd

!macro customUnInstall
  SetShellVarContext current

  StrCmp $WeekLogDeleteUserData ${BST_CHECKED} 0 skipUserDataCleanup

    ${if} ${FileExists} "$APPDATA\${APP_FILENAME}\*.*"
      RMDir /r "$APPDATA\${APP_FILENAME}"
    ${endif}

    ${if} ${FileExists} "$LOCALAPPDATA\${APP_FILENAME}\*.*"
      RMDir /r "$LOCALAPPDATA\${APP_FILENAME}"
    ${endif}

  skipUserDataCleanup:
!macroend
!endif
