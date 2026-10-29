!ifndef MIANXU_UPDATE_CARD_INCLUDED
!define MIANXU_UPDATE_CARD_INCLUDED
!define MIANXU_CARD_HERO "${__FILEDIR__}\branding\update-hero.bmp"

LangString MianxuCardTitle 2052 "正在安装更新"
LangString MianxuCardTitle 1033 "Installing update"
LangString MianxuCardHint 2052 "请稍候，你的设置与历史记录会保留。"
LangString MianxuCardHint 1033 "Please wait. Your settings and history will be kept."

!macro MX_CARD_SCALE OUT VALUE
  IntOp ${OUT} ${VALUE} * $R1
  IntOp ${OUT} ${OUT} / 96
!macroend

; Called once, after the real InstFiles page exists. Only the passive updater uses
; this composition. Keep the progress control in its original dialog: NSIS owns
; its range, position, error handling and all actual installation instructions.
!macro MIANXU_UPDATE_CARD VERSION_TEXT HINT_TEXT CAPTION
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
  Push $R0
  Push $R1
  Push $R2
  Push $R3
  Push $R4
  Push $R5
  Push $R6
  Push $R7
  Push $R8
  Push $R9
  FindWindow $R0 "#32770" "" $HWNDPARENT
  GetDlgItem $0 $R0 1004
  ${If} $R0 <> 0
  ${AndIf} $0 <> 0
    SendMessage $HWNDPARENT ${WM_SETTEXT} 0 "STR:${CAPTION}"
    InitPluginsDir
    StrCpy $9 $OUTDIR
    SetOutPath "$PLUGINSDIR"
    File /oname=mianxu-update-hero.bmp "${MIANXU_CARD_HERO}"
    ; Restore the output directory expected by the maintained Tauri template.
    SetOutPath "$9"
    System::Call 'user32::GetDpiForWindow(p $HWNDPARENT) i .R1'
    ${IfThen} $R1 = 0 ${|} StrCpy $R1 96 ${|}
    !insertmacro MX_CARD_SCALE $R2 560
    !insertmacro MX_CARD_SCALE $R3 340
    System::Call '*(i, i, i, i) p .r1'
    System::Call 'user32::GetWindowRect(p $HWNDPARENT, p r1)'
    System::Call '*$1(i .r2, i .r3, i .r4, i .r5)'
    System::Call 'user32::GetClientRect(p $HWNDPARENT, p r1)'
    System::Call '*$1(i, i, i .r6, i .r7)'
    System::Free $1
    IntOp $4 $4 - $2
    IntOp $5 $5 - $3
    IntOp $8 $4 - $6
    IntOp $8 $8 + $R2
    IntOp $9 $5 - $7
    IntOp $9 $9 + $R3
    IntOp $4 $4 - $8
    IntOp $4 $4 / 2
    IntOp $2 $2 + $4
    IntOp $5 $5 - $9
    IntOp $5 $5 / 2
    IntOp $3 $3 + $5
    System::Call 'user32::SetWindowPos(p $HWNDPARENT, p 0, i r2, i r3, i r8, i r9, i 4)'
    SetCtlColors $HWNDPARENT "26324F" "FFFFFF"
    SetCtlColors $R0 "26324F" "FFFFFF"
    ; Hide wizard chrome. Keep the native caption for dragging, system menu and
    ; accessibility. Unsupported DWM attributes simply leave the OS caption intact.
    !insertmacro MX_CARD_HIDE_ROOT 1
    !insertmacro MX_CARD_HIDE_ROOT 2
    !insertmacro MX_CARD_HIDE_ROOT 3
    !insertmacro MX_CARD_HIDE_ROOT 1034
    !insertmacro MX_CARD_HIDE_ROOT 1035
    !insertmacro MX_CARD_HIDE_ROOT 1036
    !insertmacro MX_CARD_HIDE_ROOT 1037
    !insertmacro MX_CARD_HIDE_ROOT 1038
    !insertmacro MX_CARD_HIDE_ROOT 1046
    System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 35, *i 0xF57D64, i 4)'
    System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 36, *i 0xFFFFFF, i 4)'
    System::Call 'user32::SetWindowPos(p $R0, p 0, i 0, i 0, i $R2, i $R3, i 4)'
    GetDlgItem $1 $R0 1006
    ShowWindow $1 ${SW_HIDE}
    GetDlgItem $1 $R0 1027
    ShowWindow $1 ${SW_HIDE}
    GetDlgItem $1 $R0 1016
    ShowWindow $1 ${SW_HIDE}
    !insertmacro MX_CARD_SCALE $R5 210
    System::Call 'user32::CreateWindowExW(i 0, w "STATIC", w "Mianxu", i 0x5000000E, i 0, i 0, i $R2, i $R5, p $R0, p 0, p 0, p 0) p .R9'
    System::Call 'user32::LoadImageW(p 0, w "$PLUGINSDIR\mianxu-update-hero.bmp", i 0, i $R2, i $R5, i 0x2010) p .r1'
    SendMessage $R9 0x172 0 $1 ; STM_SETIMAGE; process owns bitmap until exit.
    CreateFont $R8 "Microsoft YaHei UI" 11 600
    !insertmacro MX_CARD_LABEL "$(MianxuCardTitle)" 32 231 320 26 "26324F" 0
    CreateFont $R8 "Microsoft YaHei UI" 9
    !insertmacro MX_CARD_LABEL "${VERSION_TEXT}" 372 234 156 22 "626B80" 2
    !insertmacro MX_CARD_SCALE $R4 32
    !insertmacro MX_CARD_SCALE $R5 275
    !insertmacro MX_CARD_SCALE $R6 496
    !insertmacro MX_CARD_SCALE $R7 6
    System::Call 'user32::SetWindowPos(p r0, p 0, i $R4, i $R5, i $R6, i $R7, i 0)'
    System::Call 'uxtheme::SetWindowTheme(p r0, w "", w "")'
    SendMessage $0 0x409 0 0xF57D64 ; PBM_SETBARCOLOR; never set range or position.
    SendMessage $0 0x2001 0 0xF4EEEB ; PBM_SETBKCOLOR
    !insertmacro MX_CARD_LABEL "${HINT_TEXT}" 32 300 496 24 "626B80" 0
    System::Call 'user32::RedrawWindow(p $HWNDPARENT, p 0, p 0, i 0x185)'
  ${EndIf}
  Pop $R9
  Pop $R8
  Pop $R7
  Pop $R6
  Pop $R5
  Pop $R4
  Pop $R3
  Pop $R2
  Pop $R1
  Pop $R0
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

!macro MX_CARD_HIDE_ROOT ID
  GetDlgItem $1 $HWNDPARENT ${ID}
  ShowWindow $1 ${SW_HIDE}
!macroend

!macro MX_CARD_LABEL TEXT X Y WIDTH HEIGHT COLOR ALIGN
  !insertmacro MX_CARD_SCALE $R4 ${X}
  !insertmacro MX_CARD_SCALE $R5 ${Y}
  !insertmacro MX_CARD_SCALE $R6 ${WIDTH}
  !insertmacro MX_CARD_SCALE $R7 ${HEIGHT}
  IntOp $1 0x50000080 | ${ALIGN}
  System::Call 'user32::CreateWindowExW(i 0, w "STATIC", w "${TEXT}", i r1, i $R4, i $R5, i $R6, i $R7, p $R0, p 0, p 0, p 0) p .R9'
  SendMessage $R9 ${WM_SETFONT} $R8 1
  SetCtlColors $R9 "${COLOR}" "FFFFFF"
!macroend
!endif
