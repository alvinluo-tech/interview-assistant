// Compile a no-op UI harness using the exact production pages. No registration,
// application payload, shortcut, launch or uninstaller exists in this harness.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const repo = process.cwd();
const progressOnly = process.argv.includes('--progress');
const finishOnly = process.argv.includes('--finish') || progressOnly;
const failure = process.argv.includes('--failure');
const english = process.argv.includes('--english');
const selfTest = process.argv.includes('--self-test');
const maintenance = process.argv.includes('--maintenance');
const comparison = process.argv.includes('--same-version') ? 0 : process.argv.includes('--newer-version') ? -1 : 1;
mkdirSync('artifacts', { recursive: true });
const root = mkdtempSync(path.join(repo, 'artifacts/installer-ui-preview-'));
const executable = path.join(root, 'Mianxu-Installer-UI-Preview.exe');
const source = String.raw`Unicode true
ManifestDPIAware true
ManifestDPIAwareness PerMonitorV2
!include "MUI2.nsh"
!include "LogicLib.nsh"
!define VERSION "UI PREVIEW"
!define MUI_ICON "${path.join(repo, 'src-tauri/icons/icon.ico')}"
Var PassiveMode
Var UpdateMode
Var NoShortcutMode
Name "Mianxu UI preview"
Caption "Mianxu UI preview"
OutFile "${executable}"
RequestExecutionLevel user
!include "${path.join(repo, 'src-tauri/windows/installer-hooks.nsh')}"
!include "${path.join(repo, 'src-tauri/windows/installer-pages.nsh')}"
AutoCloseWindow true
${maintenance ? 'Page custom PreviewMaintenance' : finishOnly ? '' : 'Page custom MianxuInstallPage MianxuInstallLeave'}
!define MUI_PAGE_CUSTOMFUNCTION_SHOW MianxuProgressShow
!define MUI_PAGE_CUSTOMFUNCTION_LEAVE MianxuProgressLeave
!insertmacro MUI_PAGE_INSTFILES
Page custom MianxuFinishPage MianxuFinishLeave
!insertmacro MUI_LANGUAGE "${english ? 'English' : 'SimpChinese'}"
!insertmacro MUI_LANGUAGE "${english ? 'SimpChinese' : 'English'}"
Function .onInit
  StrCpy $PassiveMode 0
  StrCpy $UpdateMode 0
  StrCpy $NoShortcutMode 0
  StrCpy $LANGUAGE ${english ? 1033 : 2052}
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  StrCpy $INSTDIR "$LOCALAPPDATA\Mianxu UI preview (not installed)"
${selfTest ? String.raw`
  StrCpy $0 "$LOCALAPPDATA\Mianxu-new-folder-validation"
  Call MianxuValidateDirectory
  StrCmp $0 "" selftest_failed
  StrCpy $0 "C:\Mianxu-new-folder-validation"
  Call MianxuValidateDirectory
  StrCmp $0 "" selftest_failed
  ${['', '.', 'C:\\', '$WINDIR', '$WINDIR\\System32', '$PROFILE', '$PROFILE\\', '$DESKTOP', '\\\\server\\share', '\\\\.\\C:\\folder'].map(value => `StrCpy $0 "${value}"\nCall MianxuValidateDirectory\nStrCmp $0 "" +2\nGoto selftest_failed`).join('\n')}
  SetErrorLevel 0
  Quit
  selftest_failed:
  SetErrorLevel 42
  Quit
` : ''}
FunctionEnd
${maintenance ? String.raw`
; Synthetic choices exercise only the production presentation function.
; No installed-version lookup, registry mutation or uninstaller is present.
Function PreviewMaintenance
  nsDialogs::Create 1018
  Pop $R4
  ${'${NSD_CreateLabel}'} 0 0 100% 24u "Preview"
  Pop $R1
  ${'${NSD_CreateRadioButton}'} 30u 50u -30u 8u "First choice"
  Pop $R2
  ${'${NSD_CreateRadioButton}'} 30u 70u -30u 8u "Second choice"
  Pop $R3
  SendMessage $R2 ${'${BM_SETCHECK}'} ${'${BST_CHECKED}'} 0
  ${comparison === -1 ? 'EnableWindow $R3 0' : ''}
  StrCpy $R0 ${comparison}
  Call MianxuReinstallStyle
  ${'${NSD_SetFocus}'} $R2
  nsDialogs::Show
FunctionEnd
` : ''}
Function RunMainBinary
  ; Deliberately no app launch.
FunctionEnd
Function CreateOrUpdateDesktopShortcut
  ; Deliberately no shortcut creation.
FunctionEnd
Section "UI preview only"
  ${failure ? 'Abort "UI preview: simulated failure, no files installed"' : progressOnly ? 'Sleep 15000' : 'Sleep 250'}
SectionEnd
`;
const filename = path.join(root, 'preview.nsi');
writeFileSync(filename, source);
execFileSync(path.join(process.env.LOCALAPPDATA, 'tauri/NSIS/makensis.exe'), ['/INPUTCHARSET', 'UTF8', '/V2', filename], { stdio: 'inherit', windowsHide: true });
console.log(`${selfTest ? 'Native validator harness' : 'No-op preview (not launched)'}: ${executable}`);
if (selfTest) {
  execFileSync(executable, ['/S'], { stdio: 'inherit', windowsHide: true });
  console.log('PASS: native directory validation allows new application folders and rejects roots, relative, OS, user home and device/network paths. No application was installed.');
}
