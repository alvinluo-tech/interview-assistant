!ifndef MIANXU_UPDATE_CARD_INCLUDED
!define MIANXU_UPDATE_CARD_INCLUDED
Var MxProgressHeading
Var MxProgressHint
Var MxProgressStyled
!define MIANXU_CARD_HERO "${__FILEDIR__}\branding\update-hero.bmp"
!define MIANXU_CARD_HERO_EN "${__FILEDIR__}\branding\update-hero-en.bmp"

LangString MianxuCardTitle 2052 "正在安装更新"
LangString MianxuCardTitle 1033 "Installing update"
LangString MianxuCardHint 2052 "请稍候，你的设置与历史记录会保留。"
LangString MianxuCardHint 1033 "Please wait. Your settings and history will be kept."

!macro MX_CARD_SCALE OUT VALUE
  IntOp ${OUT} ${VALUE} * $R1
  IntOp ${OUT} ${OUT} / 96
!macroend

; Called once, after the real InstFiles page exists. Keep the progress control in
; its original dialog: NSIS owns
; its range, position, error handling and all actual installation instructions.
!macro MIANXU_UPDATE_CARD VERSION_TEXT HINT_TEXT CAPTION TITLE_TEXT HEIGHT
  !insertmacro MX_PUSH_REGS
  !insertmacro MX_FIND_PROGRESS
  ${If} $R0 <> 0
  ${AndIf} $0 <> 0
    !insertmacro MX_BRAND_FRAME ${HEIGHT} "${CAPTION}"
    GetDlgItem $1 $R0 1006
    ShowWindow $1 ${SW_HIDE}
    GetDlgItem $1 $R0 1027
    ShowWindow $1 ${SW_HIDE}
    GetDlgItem $1 $R0 1016
    ShowWindow $1 ${SW_HIDE}
    CreateFont $R8 "Microsoft YaHei UI" 11 600
    !insertmacro MX_CARD_LABEL "${TITLE_TEXT}" 36 183 320 26 "192C3A" 0
    StrCpy $MxProgressHeading $R9
    CreateFont $R8 "Microsoft YaHei UI" 9
    !insertmacro MX_CARD_LABEL "${VERSION_TEXT}" 368 186 156 22 "647887" 2
    !insertmacro MX_CARD_SCALE $R4 36
    !insertmacro MX_CARD_SCALE $R5 237
    !insertmacro MX_CARD_SCALE $R6 488
    !insertmacro MX_CARD_SCALE $R7 6
    System::Call 'user32::SetWindowPos(p r0, p 0, i $R4, i $R5, i $R6, i $R7, i 0)'
    System::Call 'uxtheme::SetWindowTheme(p r0, w "", w "")'
    SendMessage $0 0x409 0 0xBA7908 ; PBM_SETBARCOLOR; never set range or position.
    SendMessage $0 0x2001 0 0xF3EDE5 ; PBM_SETBKCOLOR
    !insertmacro MX_CARD_LABEL "${HINT_TEXT}" 36 266 488 32 "647887" 0
    StrCpy $MxProgressHint $R9
    StrCpy $MxProgressStyled 1
    System::Call 'user32::RedrawWindow(p $HWNDPARENT, p 0, p 0, i 0x185)'
  ${EndIf}
  !insertmacro MX_POP_REGS
!macroend

; During page transitions both the outgoing custom dialog and the new InstFiles
; dialog may exist. Select by its real progress control, not the first dialog.
!macro MX_FIND_PROGRESS
  StrCpy $R0 0
  ${Do}
    FindWindow $R0 "#32770" "" $HWNDPARENT $R0
    ${If} $R0 = 0
      ${ExitDo}
    ${EndIf}
    GetDlgItem $0 $R0 1004
    ${If} $0 <> 0
      ${ExitDo}
    ${EndIf}
  ${Loop}
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
!macro MX_PUSH_REGS
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
!macroend
!macro MX_POP_REGS
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
!macro MX_BRAND_FRAME HEIGHT CAPTION
    SendMessage $HWNDPARENT ${WM_SETTEXT} 0 "STR:${CAPTION}"
    InitPluginsDir
    ; Absolute extraction leaves $OUTDIR untouched and never creates $INSTDIR
    ; before the user clicks the installation action.
    ${If} $LANGUAGE = 2052
      File "/oname=$PLUGINSDIR\mianxu-update-hero.bmp" "${MIANXU_CARD_HERO}"
    ${Else}
      File "/oname=$PLUGINSDIR\mianxu-update-hero.bmp" "${MIANXU_CARD_HERO_EN}"
    ${EndIf}
    System::Call 'user32::GetDpiForWindow(p $HWNDPARENT) i .R1'
    ${IfThen} $R1 = 0 ${|} StrCpy $R1 96 ${|}
    !insertmacro MX_CARD_SCALE $R2 560
    !insertmacro MX_CARD_SCALE $R3 ${HEIGHT}
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
    SetCtlColors $HWNDPARENT "192C3A" "FFFFFF"
    SetCtlColors $R0 "192C3A" "FFFFFF"
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
    !insertmacro MX_CARD_HIDE_ROOT 1039
    !insertmacro MX_CARD_HIDE_ROOT 1256
    !insertmacro MX_CARD_HIDE_ROOT 1028
    !insertmacro MX_CARD_HIDE_ROOT 1046
    System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 33, *i 2, i 4)'
    System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 35, *i 0xFCF9F5, i 4)'
    System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 36, *i 0x3A2C19, i 4)'
    System::Call 'user32::SetWindowPos(p $R0, p 0, i 0, i 0, i $R2, i $R3, i 4)'
    !insertmacro MX_CARD_SCALE $R5 140
    System::Call 'user32::CreateWindowExW(i 0, w "STATIC", w "Mianxu", i 0x5000000E, i 0, i 0, i $R2, i $R5, p $R0, p 0, p 0, p 0) p .R9'
    System::Call 'user32::LoadImageW(p 0, w "$PLUGINSDIR\mianxu-update-hero.bmp", i 0, i $R2, i $R5, i 0x2010) p .r1'
    SendMessage $R9 0x172 0 $1 ; STM_SETIMAGE; process owns bitmap until exit.
!macroend
!endif
