// Apply presentation-only changes to the pinned official Tauri CLI 2.12.4 NSIS
// template. Upgrade this baseline deliberately when upgrading the bundler.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
export const upstreamHash = 'd00089d3b1a2c4a30d7b6e098079100cb8f25e980f84d4515aca4597b95e967d';
const header = '; Based on tauri-cli-v2.12.4/crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi\n; Upstream: https://github.com/tauri-apps/tauri (Apache-2.0 OR MIT).\n; Regenerate with scripts/customize-installer-template.mjs. Engine sections remain upstream.\n';
const originalFinish = `; 8. Finish page
;
; Don't auto jump to finish page after installation page,
; because the installation page has useful info that can be used debug any issues with the installer.
!define MUI_FINISHPAGE_NOAUTOCLOSE
; Use show readme button in the finish page as a button create a desktop shortcut
!define MUI_FINISHPAGE_SHOWREADME
!define MUI_FINISHPAGE_SHOWREADME_TEXT "$(createDesktop)"
!define MUI_FINISHPAGE_SHOWREADME_FUNCTION CreateOrUpdateDesktopShortcut
; Show run app after installation.
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_FUNCTION RunMainBinary
!define MUI_PAGE_CUSTOMFUNCTION_PRE SkipIfPassive
!insertmacro MUI_PAGE_FINISH

`;
const edits = [
  ['; 1. Welcome Page\n!define MUI_PAGE_CUSTOMFUNCTION_PRE SkipIfPassive\n!insertmacro MUI_PAGE_WELCOME', '!include "${MIANXU_PAGES_INCLUDE}"\nAutoCloseWindow true'],
  ['; 5. Choose install directory page\n!define MUI_PAGE_CUSTOMFUNCTION_PRE SkipIfPassive\n!insertmacro MUI_PAGE_DIRECTORY', '; Branded installation location and explicit install action.\nPage custom MianxuInstallPage MianxuInstallLeave'],
  [originalFinish, '; Branded completion page; the maintained launch helper is retained.\nPage custom MianxuFinishPage MianxuFinishLeave\n\n'],
  ['    ${NSD_SetFocus} $R2\n    nsDialogs::Show', '    Call MianxuReinstallStyle\n    ${NSD_SetFocus} $R2\n    nsDialogs::Show'],
  ['!insertmacro MUI_PAGE_INSTFILES', '!define MUI_PAGE_CUSTOMFUNCTION_SHOW MianxuProgressShow\n!define MUI_PAGE_CUSTOMFUNCTION_LEAVE MianxuProgressLeave\n!insertmacro MUI_PAGE_INSTFILES'],
];
function apply(source, reverse) {
  let result = source;
  for (const edit of reverse ? [...edits].reverse() : edits) {
    const [from, to] = reverse ? [...edit].reverse() : edit;
    if (result.split(from).length !== 2) throw new Error(`Expected exactly one UI anchor: ${from.slice(0, 60)}`);
    result = result.replace(from, to);
  }
  return result;
}
export function customizeTemplate(source) {
  source = source.replaceAll('\r\n', '\n');
  if (createHash('sha256').update(source).digest('hex') !== upstreamHash) throw new Error('Review the upstream NSIS template before changing its pinned baseline.');
  return header + apply(source, false);
}
export function restoreTemplate(source) {
  source = source.replaceAll('\r\n', '\n');
  if (!source.startsWith(header)) throw new Error('The installer template provenance header is missing.');
  return apply(source.slice(header.length), true);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv[2] || !process.argv[3]) throw new Error('Usage: node scripts/customize-installer-template.mjs upstream.nsi output.nsi');
  writeFileSync(process.argv[3], customizeTemplate(readFileSync(process.argv[2], 'utf8')));
}
