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
Var MxComparison
LangString MxLocation 2052 "安装位置"
LangString MxLocation 1033 "Installation folder"
LangString MxBrowse 2052 "更改"
LangString MxBrowse 1033 "Change"
LangString MxInstall 2052 "立即安装"
LangString MxInstall 1033 "Install now"
LangString MxContinue 2052 "继续"
LangString MxContinue 1033 "Continue"
LangString MxLaunch 2052 "打开 Mianxu"
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
LangString MxExisting 2052 "发现已安装的 Mianxu"
LangString MxExisting 1033 "Mianxu is already installed"
LangString MxExistingHint 2052 "选择安装方式，然后继续。"
LangString MxExistingHint 1033 "Choose how to install, then continue."
LangString MxSameHint 2052 "可以重新安装程序，或移除当前版本。"
LangString MxSameHint 1033 "Reinstall the application or remove this version."
LangString MxNewerHint 2052 "当前版本较新。安装旧版需要先卸载。"
LangString MxNewerHint 1033 "A newer version is installed. Uninstall it before downgrading."
LangString MxReinstall 2052 "重新安装"
LangString MxReinstall 1033 "Reinstall Mianxu"
LangString MxRemove 2052 "卸载 Mianxu"
LangString MxRemove 1033 "Uninstall Mianxu"
LangString MxRemoveFirst 2052 "卸载旧版后安装"
LangString MxRemoveFirst 1033 "Uninstall first, then install"
LangString MxOverwrite 2052 "直接覆盖安装"
LangString MxOverwrite 1033 "Install over the existing version"

!macro MX_CONTROL CLASS STYLE EXSTYLE X Y WIDTH HEIGHT TEXT
  !insertmacro MX_CARD_SCALE $R4 ${X}
  !insertmacro MX_CARD_SCALE $R5 ${Y}
  !insertmacro MX_CARD_SCALE $R6 ${WIDTH}
  !insertmacro MX_CARD_SCALE $R7 ${HEIGHT}
  nsDialogs::CreateControl "${CLASS}" ${STYLE} ${EXSTYLE} $R4 $R5 $R6 $R7 "${TEXT}"
  Pop $R9
  SendMessage $R9 ${WM_SETFONT} $R8 1
!macroend

; SetWindowRgn transfers region ownership to Windows only on success.
!macro MX_ROUND_CONTROL HANDLE WIDTH HEIGHT DIAMETER
  !insertmacro MX_CARD_SCALE $R6 ${WIDTH}
  !insertmacro MX_CARD_SCALE $R7 ${HEIGHT}
  !insertmacro MX_CARD_SCALE $R4 ${DIAMETER}
  IntOp $1 $R6 + 1
  IntOp $2 $R7 + 1
  System::Call 'gdi32::CreateRoundRectRgn(i 0, i 0, i r1, i r2, i $R4, i $R4) p .r1'
  ${If} $1 <> 0
    System::Call 'user32::SetWindowRgn(p ${HANDLE}, p r1, i 1) i .r2'
    ${If} $2 = 0
      System::Call 'gdi32::DeleteObject(p r1)'
    ${EndIf}
  ${EndIf}
!macroend

!macro MX_BUTTON KIND CAPTION X Y WIDTH HEIGHT DIAMETER CALLBACK
  InitPluginsDir
  ${If} $LANGUAGE = 2052
    File "/oname=$PLUGINSDIR\mianxu-button.bmp" "${MIANXU_BUTTONS}\button-${KIND}-zh.bmp"
  ${Else}
    File "/oname=$PLUGINSDIR\mianxu-button.bmp" "${MIANXU_BUTTONS}\button-${KIND}-en.bmp"
  ${EndIf}
  !insertmacro MX_CONTROL "BUTTON" 0x50018080 0 ${X} ${Y} ${WIDTH} ${HEIGHT} "${CAPTION}"
  !insertmacro MX_ROUND_CONTROL $R9 ${WIDTH} ${HEIGHT} ${DIAMETER}
  System::Call 'user32::LoadImageW(p 0, w "$PLUGINSDIR\mianxu-button.bmp", i 0, i $R6, i $R7, i 0x2010) p .r1'
  SendMessage $R9 ${BM_SETIMAGE} 0 $1
  ${NSD_OnClick} $R9 ${CALLBACK}
!macroend

!macro MX_PRIMARY KIND CAPTION Y CALLBACK
  !insertmacro MX_BUTTON ${KIND} "${CAPTION}" 176 ${Y} 208 44 44 ${CALLBACK}
  StrCpy $MxPrimary $R9
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
  !insertmacro MX_BRAND_FRAME 380 "Mianxu"
  CreateFont $R8 "Microsoft YaHei UI" 9
  File "/oname=$PLUGINSDIR\mianxu-folder.bmp" "${MIANXU_BUTTONS}\folder-surface.bmp"
  !insertmacro MX_CONTROL "STATIC" 0x5000000E 0 36 204 408 42 ""
  System::Call 'user32::LoadImageW(p 0, w "$PLUGINSDIR\mianxu-folder.bmp", i 0, i $R6, i $R7, i 0x2010) p .r1'
  SendMessage $R9 0x172 0 $1
  !insertmacro MX_CARD_LABEL "$(MxLocation)" 36 176 320 22 "192C3A" 0
  !insertmacro MX_CONTROL "EDIT" 0x50010080 0 48 215 384 22 "$INSTDIR"
  StrCpy $MxPathInput $R9
  SetCtlColors $MxPathInput "192C3A" "EFF4F8"
  !insertmacro MX_BUTTON browse "$(MxBrowse)" 452 204 72 42 20 MianxuBrowse
  !insertmacro MX_CARD_LABEL "v${VERSION}" 372 176 152 22 "647887" 2
  !insertmacro MX_PRIMARY install "$(MxInstall)" 286 MianxuNext
  !insertmacro MX_CARD_LABEL "$(MxNote)" 16 350 528 22 "647887" 1
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
  !insertmacro MX_BRAND_FRAME 380 "Mianxu"
  CreateFont $R8 "Microsoft YaHei UI" 12 600
  !insertmacro MX_CARD_LABEL "$(MxReady)" 16 182 528 30 "192C3A" 1
  CreateFont $R8 "Microsoft YaHei UI" 9
  !insertmacro MX_CARD_LABEL "v${VERSION}" 16 219 528 20 "647887" 1
  StrCpy $MxShortcut 0
  ${If} $NoShortcutMode <> 1
    !insertmacro MX_CONTROL "BUTTON" 0x50010003 0 176 249 260 22 "$(MxShortcut)"
    StrCpy $MxShortcut $R9
    SetCtlColors $MxShortcut "647887" "FFFFFF"
    ${NSD_SetState} $MxShortcut ${BST_CHECKED}
  ${EndIf}
  StrCpy $MxWantLaunch 0
  IfRebootFlag mianxu_finish_reboot
    !insertmacro MX_PRIMARY launch "$(MxLaunch)" 286 MianxuLaunch
    Goto mianxu_finish_buttons
  mianxu_finish_reboot:
    !insertmacro MX_CARD_LABEL "$(MxReboot)" 16 219 528 22 "647887" 1
    !insertmacro MX_PRIMARY close "$(MxFinish)" 286 MianxuNext
  mianxu_finish_buttons:
  !insertmacro MX_BUTTON dismiss "$(MxFinish)" 232 342 96 28 20 MianxuNext
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
  StrCpy $MxComparison $R0
  StrCpy $R0 $R4
  !insertmacro MX_BRAND_FRAME 380 "Mianxu"
  SendMessage $MxChoiceLabel ${WM_SETTEXT} 0 "STR:$(MxExisting)"
  SendMessage $MxChoiceOne ${WM_SETTEXT} 0 "STR:$(MxRemoveFirst)"
  SendMessage $MxChoiceTwo ${WM_SETTEXT} 0 "STR:$(MxOverwrite)"
  CreateFont $R8 "Microsoft YaHei UI" 9
  ${If} $MxComparison = 0
    !insertmacro MX_CARD_LABEL "$(MxSameHint)" 36 210 488 26 "647887" 0
    SendMessage $MxChoiceOne ${WM_SETTEXT} 0 "STR:$(MxReinstall)"
    SendMessage $MxChoiceTwo ${WM_SETTEXT} 0 "STR:$(MxRemove)"
  ${ElseIf} $MxComparison = -1
    !insertmacro MX_CARD_LABEL "$(MxNewerHint)" 36 210 488 26 "647887" 0
  ${Else}
    !insertmacro MX_CARD_LABEL "$(MxExistingHint)" 36 210 488 26 "647887" 0
  ${EndIf}
  CreateFont $R8 "Microsoft YaHei UI" 12 600
  SendMessage $MxChoiceLabel ${WM_SETFONT} $R8 1
  !insertmacro MX_CARD_SCALE $R4 36
  !insertmacro MX_CARD_SCALE $R5 174
  !insertmacro MX_CARD_SCALE $R6 488
  !insertmacro MX_CARD_SCALE $R7 30
  System::Call 'user32::SetWindowPos(p $MxChoiceLabel, p 0, i $R4, i $R5, i $R6, i $R7, i 4)'
  SetCtlColors $MxChoiceLabel "192C3A" "FFFFFF"
  CreateFont $R8 "Microsoft YaHei UI" 10
  SendMessage $MxChoiceOne ${WM_SETFONT} $R8 1
  SendMessage $MxChoiceTwo ${WM_SETFONT} $R8 1
  !insertmacro MX_CARD_SCALE $R5 245
  !insertmacro MX_CARD_SCALE $R7 28
  System::Call 'user32::SetWindowPos(p $MxChoiceOne, p 0, i $R4, i $R5, i $R6, i $R7, i 4)'
  SetCtlColors $MxChoiceOne "192C3A" "FFFFFF"
  !insertmacro MX_CARD_SCALE $R5 280
  System::Call 'user32::SetWindowPos(p $MxChoiceTwo, p 0, i $R4, i $R5, i $R6, i $R7, i 4)'
  SetCtlColors $MxChoiceTwo "192C3A" "FFFFFF"
  CreateFont $R8 "Microsoft YaHei UI" 9
  !insertmacro MX_PRIMARY continue "$(MxContinue)" 326 MianxuNext
  !insertmacro MX_POP_REGS
FunctionEnd

; NSIS calls the leave callback when sections finish, including aborts. Report
; failure without advancing to the success page. The native caption close action
; is re-enabled by NSIS on failure and remains available to exit.
Function MianxuProgressLeave
  IfAbort 0 mianxu_progress_ok
    !insertmacro MX_FIND_PROGRESS
    !insertmacro MX_BRAND_FRAME 380 "$(MxFailed)"
    SendMessage $MxProgressHeading ${WM_SETTEXT} 0 "STR:$(MxFailed)"
    SendMessage $MxProgressHint ${WM_SETTEXT} 0 "STR:$(MxFailedHint)"
  mianxu_progress_ok:
FunctionEnd

Function MianxuProgressShow
  !insertmacro NSIS_HOOK_PREINSTALL
FunctionEnd

