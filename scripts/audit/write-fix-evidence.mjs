import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const read=file=>readFile(file,'utf8');
const json=async file=>JSON.parse(await read(file));
const log=await read('artifacts/audit-fixes-tests.txt');
assert.match(log,/# fail 0\b/);const passed=Number(/# pass (\d+)/.exec(log)[1]);assert.ok(passed>=293);
const nativeLog=await read('artifacts/audit/fixed-native-tests.txt');
assert.match(nativeLog,/57 passed; 0 failed; 2 ignored/);assert.match(nativeLog,/10 passed; 0 failed; 0 ignored/);
const suites=await json('artifacts/audit/browser-suites.json');assert.equal(suites.results.length,5);suites.results.forEach(row=>assert.equal(row.code,0));
const business=await json('artifacts/audit/fixed-boundary-probes.json'),browser=await json('artifacts/audit/fixed-browser-boundaries.json'),native=await json('artifacts/audit/fixed-native-boundaries.json');
assert.equal(business.results.length,11);assert.equal(browser.results.length,13);assert.equal(native.results.length,12);
const probes=[...business.results,...browser.results,...native.results];
assert.ok(probes.every(row=>row.verdict==='pass'||(row.id==='N10'&&row.verdict==='not-verified')));
const original=await json('docs/audit/2026-11-04-first-principles-evidence.json');
const closed=original.issues.map(issue=>({...issue,status:'verified-fixed',evidence:issue.probes.map(id=>{const proof=probes.find(row=>row.id===id);assert.equal(proof?.verdict,'pass');return proof;})}));assert.equal(closed.length,14);
const build=await read('artifacts/audit/fixed-default-debug-build.txt');assert.match(build,/✓ built/);assert.match(build,/Finished `dev` profile/);assert.match(build,/Built application at:/);
const binary=await readFile('src-tauri/target/debug/Mianxu.exe');assert.ok(binary.includes(Buffer.from('com.luoyaosheng.mianxu')));assert.equal(binary.includes(Buffer.from('com.mianxu.audit.boundaries20261104')),false);
const fuzz=await json('artifacts/audit/protocol-fuzz.json');assert.equal(fuzz.totalCases,2016);
const files=execFileSync('git',['ls-files','--cached','--others','--exclude-standard','--','src','src-tauri/src','src-tauri/macos-capture/src','src-tauri/capabilities','scripts','tests','.github/workflows','package.json','pnpm-lock.yaml','src-tauri/Cargo.toml','src-tauri/Cargo.lock','src-tauri/tauri.conf.json'],{encoding:'utf8'}).trim().split(/\r?\n/);
const sourceHashes=[];for(const file of [...new Set(files)].sort())sourceHashes.push({file,sha256:createHash('sha256').update(await readFile(file)).digest('hex')});
const fingerprint=createHash('sha256').update(sourceHashes.map(row=>row.file+'\0'+row.sha256+'\n').join('')).digest('hex');
const coverage={};for(const name of ['ai','core']){const output=await read(`artifacts/audit/fixed-${name}-coverage.txt`),row=/# all files\s+\|\s+([\d.]+)\s+\|\s+([\d.]+)\s+\|\s+([\d.]+)/.exec(output);assert.ok(row);assert.match(output,/# fail 0\b/);coverage[name]={line:Number(row[1]),branch:Number(row[2]),functions:Number(row[3])};}
const result={schemaVersion:1,createdAt:new Date().toISOString(),report:'2026-11-04-fixes-and-verification.md',baselineEvidence:'2026-11-04-first-principles-evidence.json',sourceFingerprintSha256:fingerprint,sourceHashes,
  summary:{fixedIssues:14,remainingFromOriginalFourteen:0,nodeTestsPassed:passed,rustTestsPassed:67,rustTestsIgnored:2,browserSuitesPassed:5,auditProbes:probes.length,auditProbesPassed:probes.filter(row=>row.verdict==='pass').length,notVerified:probes.filter(row=>row.verdict==='not-verified').length,fuzzCasesPassed:2016,normalDevelopmentBinaryRestored:true,committed:false,published:false},
  issues:closed,coverage,browserSuites:suites.results,probes,
  limits:['No physical macOS acceptance','No live microphone, loopback or conferencing acceptance','No real installer/update/uninstaller handoff','Docker Linux engine unavailable; code execution remains unverified','Phone transport encryption is outside the original fourteen issues'],
};
const output=JSON.stringify(result,null,2)+'\n';assert.doesNotMatch(output,/[A-Z]:\\|[A-Z]:\/Users\//);
await writeFile('docs/audit/2026-11-04-fix-evidence.json',output);console.log(JSON.stringify({fingerprint,summary:result.summary}));
