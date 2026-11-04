// Export a compact, source-addressable audit receipt without user data or local absolute paths.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
const read=file=>readFile(file,'utf8');
const json=async file=>JSON.parse(await read(file));
const baseline=await read('artifacts/audit-baseline-tests.txt'),nativeTests=await read('artifacts/audit-native-tests.txt');
assert.match(baseline,/# pass 284\b/);assert.match(baseline,/# fail 0\b/);
assert.match(nativeTests,/54 passed; 0 failed; 2 ignored/);assert.match(nativeTests,/10 passed; 0 failed; 0 ignored/);
const boundary=await json('artifacts/audit/boundary-probes.json'),browser=await json('artifacts/audit/browser-boundaries.json'),native=await json('artifacts/audit/native-boundaries.json');
const probes=[...boundary.results,...browser.results,...native.results];
assert.equal(probes.length,33);assert.equal(probes.filter(item=>item.verdict==='probe-error').length,0);
const suites=await json('artifacts/audit/browser-suites.json');assert.equal(suites.results.length,5);suites.results.forEach(suite=>assert.equal(suite.code,0));
const fuzz=await json('artifacts/audit/protocol-fuzz.json');assert.equal(fuzz.totalCases,2016);assert.ok(fuzz.results.every(item=>item.passed));
const coverage={};
for(const [name,file] of Object.entries({ai:'ai',core:'core',tts:'tts',speech:'speech',updater:'updater',lifecycle:'lifecycle'})){
  const log=await read(`artifacts/audit/${file}-coverage.txt`),match=/# all files\s+\|\s+([\d.]+)\s+\|\s+([\d.]+)\s+\|\s+([\d.]+)/.exec(log);
  assert.ok(match);assert.match(log,/# fail 0\b/);coverage[name]={testsPassed:Number(/# pass (\d+)/.exec(log)[1]),linePercent:Number(match[1]),branchPercent:Number(match[2]),functionPercent:Number(match[3])};
}
const defaultBuild=await read('artifacts/audit/default-debug-build.txt');assert.match(defaultBuild,/✓ built/);assert.match(defaultBuild,/Finished `dev` profile/);assert.match(defaultBuild,/Built application at:/);
const installer=await read('artifacts/audit/installer-build.txt');assert.match(installer,/PASS: production branding/);assert.match(installer,/No application was installed/);
// Tauri embeds its identifier in the native binary. Verify that the audit build was replaced.
const executable=await readFile('src-tauri/target/debug/Mianxu.exe');assert.ok(executable.includes(Buffer.from('com.luoyaosheng.mianxu')));assert.equal(executable.includes(Buffer.from('com.mianxu.audit.boundaries20261104')),false);
const paths=execFileSync('git',['ls-files','--cached','--others','--exclude-standard','--','src','src-tauri/src','src-tauri/macos-capture/src','src-tauri/capabilities','scripts','tests','.github/workflows','package.json','pnpm-lock.yaml','src-tauri/Cargo.toml','src-tauri/Cargo.lock','src-tauri/tauri.conf.json'],{encoding:'utf8'}).trim().split(/\r?\n/);
const sourceHashes=[];for(const file of [...new Set(paths)].sort())sourceHashes.push({file,sha256:createHash('sha256').update(await readFile(file)).digest('hex')});
const fingerprint=createHash('sha256').update(sourceHashes.map(row=>row.file+'\0'+row.sha256+'\n').join('')).digest('hex');
const issues=[
  {id:'F01',priority:'P1',probes:['B09']},{id:'F02',priority:'P1',probes:['A01']},
  {id:'F03',priority:'P1',probes:['B03','B04']},{id:'F04',priority:'P1',probes:['B05']},
  {id:'F05',priority:'P1',probes:['A04']},{id:'F06',priority:'P2',probes:['A11']},
  {id:'F07',priority:'P2',probes:['A02']},{id:'F08',priority:'P2',probes:['A03']},
  {id:'F09',priority:'P2',probes:['A07']},{id:'F10',priority:'P2',probes:['A05']},
  {id:'F11',priority:'P2',probes:['A06']},{id:'F12',priority:'P2',probes:['B08']},
  {id:'F13',priority:'P2',probes:['N06']},
  {id:'F14',priority:'P2',probes:['B11']},
];
for(const issue of issues)for(const id of issue.probes)assert.equal(probes.find(probe=>probe.id===id)?.verdict,'finding');
const evidence={schemaVersion:1,createdAt:new Date().toISOString(),report:'2026-11-04-first-principles-review.md',
  baseline:{commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),includesUncommittedChanges:true,sourceFingerprintSha256:fingerprint,sourceFileCount:sourceHashes.length,sourceHashes},
  environment:{platform:process.platform,arch:process.arch,node:process.version,pnpm:'10.33.4',rust:'1.90.0',nativeProfile:'com.mianxu.audit.boundaries20261104'},
  summary:{existingNodeTests:{passed:284,failed:0},rustTests:{passed:64,failed:0,ignored:2},browserSuitesPassed:5,fuzzCasesPassed:2016,auditProbes:33,probePasses:probes.filter(item=>item.verdict==='pass').length,anomalyObservations:probes.filter(item=>item.verdict==='finding').length,notVerified:probes.filter(item=>item.verdict==='not-verified').length,probeErrors:0,uniqueConfirmedIssues:14,p1:5,p2:9,productionFixesAppliedThisAudit:false,defaultDevelopmentBinaryRestored:true,installerCompiledButNotInstalled:true},
  coverage,issues,browserSuites:suites.results,fuzz,probes,
  verificationLimits:['No macOS device/runtime','No real microphone/loopback/conferencing software capture','No real AI provider requests or latency measurement','No real installer/uninstaller/update handoff','Docker Linux engine unavailable','No external vulnerability-database scan or complete Git-history audit'],
};
const output=JSON.stringify(evidence,null,2)+'\n';assert.doesNotMatch(output,/[A-Z]:\\|[A-Z]:\/Users\//);
await writeFile('docs/audit/2026-11-04-first-principles-evidence.json',output);
console.log(JSON.stringify({report:evidence.report,fingerprint,summary:evidence.summary}));
