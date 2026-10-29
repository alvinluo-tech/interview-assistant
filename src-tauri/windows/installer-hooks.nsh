; Extend the maintained Tauri template rather than duplicating its install/update logic.
; MUI declarations are loaded before the template declares its pages.
!include "${__FILEDIR__}\update-card.nsh"
SetFont "Microsoft YaHei UI" 9
ShowInstDetails nevershow
ShowUninstDetails nevershow
!define MUI_INSTFILESPAGE_PROGRESSBAR "smooth"
!define MUI_WELCOMEPAGE_TITLE "$(MianxuWelcomeTitle)"
!define MUI_WELCOMEPAGE_TEXT "$(MianxuWelcomeText)"
!define MUI_FINISHPAGE_TITLE "$(MianxuFinishTitle)"
!define MUI_FINISHPAGE_TEXT "$(MianxuFinishText)"
!define MUI_UNCONFIRMPAGE_TEXT_TOP "$(MianxuUninstallText)"

LangString MianxuWelcomeTitle 2052 "安装 Mianxu"
LangString MianxuWelcomeTitle 1033 "Install Mianxu"
LangString MianxuWelcomeText 2052 "面试、笔试与模拟练习的桌面助手。$\r$\n$\r$\n安装向导将帮助你完成安装。已有版本时，可在下一步选择升级或重新安装。$\r$\n$\r$\n请先保存正在编辑的内容，并退出应用。$\r$\n$\r$\n点击「下一步」继续。"
LangString MianxuWelcomeText 1033 "Your desktop companion for interviews, exams and practice.$\r$\n$\r$\nThis wizard will guide you through installation. If an existing version is detected, you can choose how to update it.$\r$\n$\r$\nSave your work and close the app before continuing."
LangString MianxuFinishTitle 2052 "Mianxu 已准备就绪"
LangString MianxuFinishTitle 1033 "Mianxu is ready"
LangString MianxuFinishText 2052 "安装已完成。$\r$\n$\r$\n打开应用后，可以在「设置 → 关于」中检查后续更新。$\r$\n$\r$\n点击「完成」关闭安装向导。"
LangString MianxuFinishText 1033 "Installation is complete.$\r$\n$\r$\nYou can check for future updates in Settings > About.$\r$\n$\r$\nClick Finish to close the wizard."
LangString MianxuUninstallText 2052 "将卸载 Mianxu 的程序文件与快捷方式。$\r$\n$\r$\n默认保留本机应用数据。若同时勾选下方的删除选项，应用数据目录中的设置与记录也会被删除，请先做好备份。"
LangString MianxuUninstallText 1033 "This removes Mianxu and its shortcuts.$\r$\n$\r$\nLocal application data is kept by default. Selecting the delete-data option also removes settings and records stored in the application's data directory. Back them up first."

LangString MianxuInstallingTitle 2052 "正在安装 Mianxu"
LangString MianxuInstallingTitle 1033 "Installing Mianxu"
LangString MianxuUpdatingTitle 2052 "正在更新 Mianxu"
LangString MianxuUpdatingTitle 1033 "Updating Mianxu"
LangString MianxuRemovingTitle 2052 "正在卸载 Mianxu"
LangString MianxuRemovingTitle 1033 "Removing Mianxu"
LangString MianxuInstallingStatus 2052 "正在准备程序文件，请稍候。"
LangString MianxuInstallingStatus 1033 "Preparing application files. Please wait."
LangString MianxuUpdatingStatus 2052 "正在替换程序文件，请稍候。"
LangString MianxuUpdatingStatus 1033 "Replacing application files. Please wait."
LangString MianxuRemovingStatus 2052 "正在清理程序文件，请稍候。"
LangString MianxuRemovingStatus 1033 "Removing application files. Please wait."
LangString MianxuProgressHint 2052 "安装期间请保持窗口打开。$\r$\n你的设置与历史记录会保留。"
LangString MianxuProgressHint 1033 "Keep this window open until installation finishes.$\r$\nYour settings and history will be kept."
LangString MianxuRemovingHint 2052 "正在按你选择的方式卸载。$\r$\n完成后将自动关闭此窗口。"
LangString MianxuRemovingHint 1033 "Removing the app using your selected options.$\r$\nThis window will close when finished."

; Apply only to the already visible progress page. Keep Tauri's real progress range
; and install/uninstall operations; never simulate a completion percentage.
!macro MIANXU_PROGRESS_PAGE TITLE STATUS HINT
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  Push $5
  Push $6
  Push $7
  Push $8
  Push $9
  SetDetailsPrint none
  FindWindow $0 "#32770" "" $HWNDPARENT
  SetCtlColors $HWNDPARENT "16364A" "FFFFFF"
  SetCtlColors $0 "16364A" "FFFFFF"
  GetDlgItem $1 $0 1004
  System::Call 'uxtheme::SetWindowTheme(p r1, w "", w "")'
  SendMessage $1 0x409 0 0xD68F0B ; PBM_SETBARCOLOR (BGR)
  SendMessage $1 0x2001 0 0xF8F3ED ; PBM_SETBKCOLOR
  GetDlgItem $2 $0 1006
  SetCtlColors $2 "5B7384" "FFFFFF"
  SendMessage $2 ${WM_SETTEXT} 0 "STR:${STATUS}"
  ShowWindow $2 ${SW_HIDE} ; NSIS/plugin extraction counters are not user-facing progress.
  GetDlgItem $2 $HWNDPARENT 1037
  SendMessage $2 ${WM_SETTEXT} 0 "STR:${TITLE}"
  GetDlgItem $2 $HWNDPARENT 1038
  SendMessage $2 ${WM_SETTEXT} 0 "STR:${STATUS}"

  ; Compact passive updates after the app has already obtained installation consent.
  ; Interactive installs keep the normal wizard dimensions and navigation.
  ${If} $PassiveMode = 1
    GetDlgItem $2 $HWNDPARENT 1
    ShowWindow $2 ${SW_HIDE}
    GetDlgItem $2 $HWNDPARENT 2
    ShowWindow $2 ${SW_HIDE}
    GetDlgItem $2 $HWNDPARENT 3
    ShowWindow $2 ${SW_HIDE}
    GetDlgItem $2 $HWNDPARENT 1034
    ShowWindow $2 ${SW_HIDE}
    System::Call 'user32::GetDpiForWindow(p $HWNDPARENT) i .r3'
    ${IfThen} $3 = 0 ${|} StrCpy $3 96 ${|}
    IntOp $4 250 * $3
    IntOp $4 $4 / 96
    System::Call '*(i, i, i, i) p .r5'
    System::Call 'user32::GetWindowRect(p $HWNDPARENT, p r5)'
    System::Call '*$5(i .r6, i .r7, i .r8, i .r9)'
    System::Free $5
    IntOp $8 $8 - $6
    IntOp $9 $9 - $7
    IntOp $9 $9 - $4
    IntOp $9 $9 / 2
    IntOp $7 $7 + $9
    System::Call 'user32::SetWindowPos(p $HWNDPARENT, p 0, i r6, i r7, i r8, i r4, i 4)'
    IntOp $5 22 * $3
    IntOp $5 $5 / 96
    IntOp $6 82 * $3
    IntOp $6 $6 / 96
    IntOp $7 72 * $3
    IntOp $7 $7 / 96
    IntOp $8 $8 - $5
    IntOp $8 $8 - $5
    System::Call 'user32::CreateWindowExW(i 0, w "STATIC", w "${HINT}", i 0x50000000, i r5, i r6, i r8, i r7, p r0, p 0, p 0, p 0) p .r2'
    GetDlgItem $1 $0 1006
    SendMessage $1 ${WM_GETFONT} 0 0 $1
    SendMessage $2 ${WM_SETFONT} $1 1
    SetCtlColors $2 "5B7384" "FFFFFF"
  ${EndIf}
  Pop $9
  Pop $8
  Pop $7
  Pop $6
  Pop $5
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
!macroend

!macro NSIS_HOOK_PREINSTALL
  ${If} $UpdateMode = 1
  ${AndIf} $PassiveMode = 1
    !insertmacro MIANXU_UPDATE_CARD "v${VERSION}" "$(MianxuCardHint)" "$(MianxuUpdatingTitle)"
  ${ElseIf} $UpdateMode = 1
    !insertmacro MIANXU_PROGRESS_PAGE "$(MianxuUpdatingTitle)" "$(MianxuUpdatingStatus)" "$(MianxuProgressHint)"
  ${Else}
    !insertmacro MIANXU_PROGRESS_PAGE "$(MianxuInstallingTitle)" "$(MianxuInstallingStatus)" "$(MianxuProgressHint)"
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro MIANXU_PROGRESS_PAGE "$(MianxuRemovingTitle)" "$(MianxuRemovingStatus)" "$(MianxuRemovingHint)"
!macroend
