; Native pages shared by the production template and the no-install UI preview.
!include "nsDialogs.nsh"
!include "FileFunc.nsh"
!define MIANXU_BUTTONS "${__FILEDIR__}\branding"
Var MxPathInput
Var MxPrimary
Var MxShortcut
Var MxWantLaunch
Var MxChoiceLabel
Var MxChoiceOne
Var MxChoiceTwo
LangString MxLocation 2052 "安装位置"
LangString MxLocation 1033 "Installation folder"
LangString MxBrowse 2052 "更改"
LangString MxBrowse 1033 "Change"
LangString MxInstall 2052 "立即安装"
LangString MxInstall 1033 "Install now"
LangString MxContinue 2052 "继续"
LangString MxContinue 1033 "Continue"
LangString MxLaunch 2052 "立即体验"
LangString MxLaunch 1033 "Open Mianxu"
LangString MxFinish 2052 "完成"
LangString MxFinish 1033 "Finish"
LangString MxNote 2052 "安装到当前用户 · 保留已有设置与历史记录"
LangString MxNote 1033 "For this Windows user. Existing settings and history are kept."
LangString MxReady 2052 "安装完成，Mianxu 已准备就绪"
LangString MxReady 1033 "Mianxu is installed and ready"
LangString MxShortcut 2052 "创建桌面快捷方式"
LangString MxShortcut 1033 "Create a desktop shortcut"
LangString MxInvalidPath 2052 "请选择本机的专用安装文件夹，不能直接安装到磁盘根目录、Windows 或用户主目录。"
LangString MxInvalidPath 1033 "Choose a dedicated local application folder, not a drive root, Windows folder or user home folder."
LangString MxFailed 2052 "安装未完成"
LangString MxFailed 1033 "Installation did not complete"
LangString MxFailedHint 2052 "可关闭窗口，按错误提示检查权限或磁盘空间后重试。"
LangString MxFailedHint 1033 "Close this window, check the reported error and try again."
LangString MxReboot 2052 "安装完成。部分更改将在系统重启后生效。"
LangString MxReboot 1033 "Installation complete. Some changes require a system restart."

!macro MX_CONTROL CLASS STYLE EXSTYLE X Y WIDTH HEIGHT TEXT
  !insertmacro MX_CARD_SCALE $R4 ${X}
  !insertmacro MX_CARD_SCALE $R5 ${Y}
  !insertmacro MX_CARD_SCALE $R6 ${WIDTH}
  !insertmacro MX_CARD_SCALE $R7 ${HEIGHT}
  nsDialogs::CreateControl "${CLASS}" ${STYLE} ${EXSTYLE} $R4 $R5 $R6 $R7 "${TEXT}"
  Pop $R9
  SendMessage $R9 ${WM_SETFONT} $R8 1
!macroend

!macro MX_PRIMARY KIND CAPTION Y CALLBACK
  InitPluginsDir
  ${If} $LANGUAGE = 2052
    File "/oname=$PLUGINSDIR\mianxu-button.bmp" "${MIANXU_BUTTONS}\button-${KIND}-zh.bmp"
  ${Else}
    File "/oname=$PLUGINSDIR\mianxu-button.bmp" "${MIANXU_BUTTONS}\button-${KIND}-en.bmp"
  ${EndIf}
  !insertmacro MX_CONTROL "BUTTON" 0x50018080 0 176 ${Y} 208 44 "${CAPTION}"
  StrCpy $MxPrimary $R9
  !insertmacro MX_CARD_SCALE $R6 208
  !insertmacro MX_CARD_SCALE $R7 44
  System::Call 'user32::LoadImageW(p 0, w "$PLUGINSDIR\mianxu-button.bmp", i 0, i $R6, i $R7, i 0x2010) p .r1'
  SendMessage $MxPrimary ${BM_SETIMAGE} 0 $1
  ${NSD_OnClick} $MxPrimary ${CALLBACK}
!macroend

Function MianxuInstallPage
  ${If} $PassiveMode = 1
    Abort
  ${EndIf}
  nsDialogs::Create 1018
  Pop $R0
  ${If} $R0 == error
    Abort
  ${EndIf}
  !insertmacro MX_BRAND_FRAME 400 "Mianxu"
  CreateFont $R8 "Microsoft YaHei UI" 9
  !insertmacro MX_CARD_LABEL "$(MxLocation)" 32 230 320 22 "26324F" 0
  !insertmacro MX_CONTROL "EDIT" 0x50010080 0x200 32 257 416 28 "$INSTDIR"
  StrCpy $MxPathInput $R9
  !insertmacro MX_CONTROL "BUTTON" 0x50010000 0 456 257 72 28 "$(MxBrowse)"
  ${NSD_OnClick} $R9 MianxuBrowse
  !insertmacro MX_CARD_LABEL "v${VERSION}" 376 230 152 22 "626B80" 2
  !insertmacro MX_PRIMARY install "$(MxInstall)" 314 MianxuNext
  !insertmacro MX_CARD_LABEL "$(MxNote)" 16 373 528 22 "626B80" 1
  ${NSD_SetFocus} $MxPrimary
  nsDialogs::Show
FunctionEnd

Function MianxuBrowse
  Pop $0
  ${NSD_GetText} $MxPathInput $1
  nsDialogs::SelectFolderDialog "$(MxLocation)" "$1"
  Pop $0
  ${If} $0 != error
  ${AndIf} $0 != ""
    ${NSD_SetText} $MxPathInput "$0"
  ${EndIf}
FunctionEnd

Function MianxuNext
  Pop $0
  GetDlgItem $0 $HWNDPARENT 1
  SendMessage $0 ${BM_CLICK} 0 0
FunctionEnd

; Validate at the point of installation consent. Never turn a relative or root
; directory into an installation destination by silently normalizing it.
Function MianxuInstallLeave
  ${NSD_GetText} $MxPathInput $0
  Call MianxuValidateDirectory
  ${If} $0 == ""
    MessageBox MB_OK|MB_ICONEXCLAMATION "$(MxInvalidPath)"
    Abort
  ${EndIf}
  StrCpy $INSTDIR $0
FunctionEnd

; Also called by the native no-install contract tests. Input/output is $0;
; an empty output rejects the path without performing any filesystem writes.
Function MianxuValidateDirectory
  StrCpy $1 $0 2
  ${If} $1 == "\\"
    Goto mianxu_bad_path
  ${EndIf}
  StrCpy $1 $0 4
  ${If} $1 == "\\?\"
  ${OrIf} $1 == "\\.\"
    Goto mianxu_bad_path
  ${EndIf}
  System::Call 'shlwapi::PathIsRelativeW(w r0) i .r1'
  ${If} $1 <> 0
    Goto mianxu_bad_path
  ${EndIf}
  ; The NSIS instruction requires the folder to exist. The Windows API also
  ; supports a new dedicated application folder, which is the common case.
  System::Call 'kernel32::GetFullPathNameW(w r0, i ${NSIS_MAX_STRLEN}, w .r0, p 0) i .r1'
  ${If} $1 = 0
  ${OrIf} $1 >= ${NSIS_MAX_STRLEN}
    Goto mianxu_bad_path
  ${EndIf}
  System::Call 'shlwapi::PathIsPrefixW(w "$WINDIR", w r0) i .r1'
  ${If} $1 <> 0
    Goto mianxu_bad_path
  ${EndIf}
  System::Call 'shlwapi::PathIsRootW(w r0) i .r1'
  ${If} $1 <> 0
  ${OrIf} $0 == ""
  ${OrIf} $0 == "$WINDIR"
  ${OrIf} $0 == "$SYSDIR"
  ${OrIf} $0 == "$PROFILE"
  ${OrIf} $0 == "$PROFILE\"
  ${OrIf} $0 == "$DESKTOP"
  ${OrIf} $0 == "$DESKTOP\"
  ${OrIf} $0 == "$DOCUMENTS"
  ${OrIf} $0 == "$DOCUMENTS\"
    Goto mianxu_bad_path
  ${EndIf}
  StrCpy $1 $0 1 -1
  ${If} $1 == "."
  ${OrIf} $1 == " "
    Goto mianxu_bad_path
  ${EndIf}
  Return
  mianxu_bad_path:
    StrCpy $0 ""
FunctionEnd

Function MianxuFinishPage
  ${If} $PassiveMode = 1
    Abort
  ${EndIf}
  IfAbort 0 +2
    Abort
  nsDialogs::Create 1018
  Pop $R0
  !insertmacro MX_BRAND_FRAME 400 "Mianxu"
  CreateFont $R8 "Microsoft YaHei UI" 12 600
  !insertmacro MX_CARD_LABEL "$(MxReady)" 16 231 528 30 "26324F" 1
  CreateFont $R8 "Microsoft YaHei UI" 9
  !insertmacro MX_CARD_LABEL "v${VERSION}" 16 267 528 20 "626B80" 1
  StrCpy $MxShortcut 0
  ${If} $NoShortcutMode <> 1
    !insertmacro MX_CONTROL "BUTTON" 0x50010003 0 176 290 260 22 "$(MxShortcut)"
    StrCpy $MxShortcut $R9
    SetCtlColors $MxShortcut "626B80" "FFFFFF"
    ${NSD_SetState} $MxShortcut ${BST_CHECKED}
  ${EndIf}
  StrCpy $MxWantLaunch 0
  IfRebootFlag mianxu_finish_reboot
    !insertmacro MX_PRIMARY launch "$(MxLaunch)" 323 MianxuLaunch
    Goto mianxu_finish_buttons
  mianxu_finish_reboot:
    !insertmacro MX_CARD_LABEL "$(MxReboot)" 16 267 528 22 "626B80" 1
    !insertmacro MX_PRIMARY close "$(MxFinish)" 323 MianxuNext
  mianxu_finish_buttons:
  !insertmacro MX_CONTROL "BUTTON" 0x50018000 0 244 373 72 22 "$(MxFinish)"
  ${NSD_OnClick} $R9 MianxuNext
  ${NSD_SetFocus} $MxPrimary
  nsDialogs::Show
FunctionEnd

Function MianxuLaunch
  Pop $0
  StrCpy $MxWantLaunch 1
  GetDlgItem $0 $HWNDPARENT 1
  SendMessage $0 ${BM_CLICK} 0 0
FunctionEnd

Function MianxuFinishLeave
  ${If} $MxShortcut <> 0
    ${NSD_GetState} $MxShortcut $0
    ${If} $0 = ${BST_CHECKED}
      Call CreateOrUpdateDesktopShortcut
    ${EndIf}
  ${EndIf}
  ${If} $MxWantLaunch = 1
    Call RunMainBinary
  ${EndIf}
FunctionEnd

; Preserve the upstream maintenance radio handles and version-comparison state.
Function MianxuReinstallStyle
  !insertmacro MX_PUSH_REGS
  StrCpy $MxChoiceLabel $R1
  StrCpy $MxChoiceOne $R2
  StrCpy $MxChoiceTwo $R3
  StrCpy $R0 $R4
  !insertmacro MX_BRAND_FRAME 400 "Mianxu"
  !insertmacro MX_CARD_SCALE $R4 32
  !insertmacro MX_CARD_SCALE $R5 230
  !insertmacro MX_CARD_SCALE $R6 496
  !insertmacro MX_CARD_SCALE $R7 48
  System::Call 'user32::SetWindowPos(p $MxChoiceLabel, p 0, i $R4, i $R5, i $R6, i $R7, i 4)'
  SetCtlColors $MxChoiceLabel "26324F" "FFFFFF"
  !insertmacro MX_CARD_SCALE $R5 285
  !insertmacro MX_CARD_SCALE $R7 24
  System::Call 'user32::SetWindowPos(p $MxChoiceOne, p 0, i $R4, i $R5, i $R6, i $R7, i 4)'
  SetCtlColors $MxChoiceOne "26324F" "FFFFFF"
  !insertmacro MX_CARD_SCALE $R5 316
  System::Call 'user32::SetWindowPos(p $MxChoiceTwo, p 0, i $R4, i $R5, i $R6, i $R7, i 4)'
  SetCtlColors $MxChoiceTwo "26324F" "FFFFFF"
  CreateFont $R8 "Microsoft YaHei UI" 9
  !insertmacro MX_PRIMARY continue "$(MxContinue)" 350 MianxuNext
  !insertmacro MX_POP_REGS
FunctionEnd

; NSIS calls the leave callback when sections finish, including aborts. Report
; failure without advancing to the success page. The native caption close action
; is re-enabled by NSIS on failure and remains available to exit.
Function MianxuProgressLeave
  IfAbort 0 mianxu_progress_ok
    !insertmacro MX_FIND_PROGRESS
    !insertmacro MX_BRAND_FRAME 400 "$(MxFailed)"
    SendMessage $MxProgressHeading ${WM_SETTEXT} 0 "STR:$(MxFailed)"
    SendMessage $MxProgressHint ${WM_SETTEXT} 0 "STR:$(MxFailedHint)"
  mianxu_progress_ok:
FunctionEnd

Function MianxuProgressShow
  !insertmacro NSIS_HOOK_PREINSTALL
FunctionEnd

