// Build a no-op native UI preview, NEVER an application installer. The shared
// production card is exercised on the real NSIS InstFiles page. Only NSIS's
// disposable plugin directory receives the embedded bitmap; no registry keys,
// application files, shortcuts or uninstaller are written. Launch separately.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function previewSource(repo, executable, language = 'SimpChinese') {
  if (!['SimpChinese', 'English'].includes(language)) throw new Error('Unsupported preview language');
  return `Unicode true
ManifestDPIAware true
ManifestDPIAwareness PerMonitorV2
!include "MUI2.nsh"
!include "LogicLib.nsh"
Name "Mianxu — update UI preview"
OutFile "${executable}"
RequestExecutionLevel user
ShowInstDetails nevershow
BrandingText " "
!define MUI_ICON "${path.join(repo, 'src-tauri/icons/icon.ico')}"
!define MUI_INSTFILESPAGE_PROGRESSBAR "smooth"
!include "${path.join(repo, 'src-tauri/windows/update-card.nsh')}"
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_LANGUAGE "${language}"
!insertmacro MUI_LANGUAGE "${language === 'English' ? 'SimpChinese' : 'English'}"
AutoCloseWindow true
Function .onInit
  StrCpy $LANGUAGE ${language === 'English' ? '1033' : '2052'}
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
FunctionEnd
Section "UI preview only"
  !insertmacro MIANXU_UPDATE_CARD "UI PREVIEW" "${language === 'English' ? 'Preview only. No application will be installed.' : '界面预览 · 不会安装程序或修改现有应用'}" "Mianxu · ${language === 'English' ? 'Update UI preview' : '更新界面预览'}" "$(MianxuCardTitle)" 340
  ; NSIS advances its own instruction progress. This harness does no installation.
  Sleep 250
  Sleep 250
  Sleep 250
  Sleep 250
  Sleep 250
  Sleep 250
  Sleep 250
  Sleep 45000
SectionEnd
`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const repo = process.cwd();
  const language = process.argv.includes('--english') ? 'English' : 'SimpChinese';
  mkdirSync(path.join(repo, 'artifacts'), { recursive: true });
  // A running preview is locked on Windows. A fresh output folder lets designers
  // rebuild while the previous no-op window finishes its short preview lifetime.
  const root = mkdtempSync(path.join(repo, 'artifacts/native-update-preview-'));
  const executable = path.join(root, `Mianxu-UI-Preview-${language}.exe`);
  const source = path.join(root, `preview-${language}.nsi`);
  writeFileSync(source, previewSource(repo, executable, language), 'utf8');
  execFileSync(path.join(process.env.LOCALAPPDATA, 'tauri/NSIS/makensis.exe'), ['/INPUTCHARSET', 'UTF8', '/V2', source], { stdio: 'inherit', windowsHide: true });
  console.log(`Compiled no-op preview (not launched): ${executable}`);
}
