import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const json=async file=>JSON.parse(await readFile(file,'utf8'));
const node=await readFile('artifacts/audit/remaining-tests.txt','utf8');assert.match(node,/# pass 310\b/);assert.match(node,/# fail 0\b/);
const rust=await readFile('artifacts/audit/remaining-native-tests.txt','utf8');assert.match(rust,/63 passed; 0 failed; 2 ignored/);assert.match(rust,/10 passed; 0 failed; 0 ignored/);
const deep=await json('artifacts/audit/deep-review-revalidation.json'),modal=await json('artifacts/audit/second-review-revalidation.json');
for(const id of ['R03','R04'])assert.equal(deep.results.find(row=>row.finding===id)?.status,'fixed');for(const id of ['R01','R02'])assert.equal(modal.results.find(row=>row.id===id)?.status,'fixed');
const dialogs=await json('artifacts/audit/modal-boundaries.json');assert.equal(dialogs.passed,12);
const browser=await json('artifacts/audit/fixed-browser-boundaries.json');assert.equal(browser.results.length,13);browser.results.forEach(row=>assert.equal(row.verdict,'pass'));
const suites=await json('artifacts/audit/browser-suites.json');assert.equal(suites.results.length,5);suites.results.forEach(row=>assert.equal(row.code,0));
const native=await json('artifacts/audit/fixed-native-boundaries.json');assert.equal(native.results.length,13);assert.equal(native.results.filter(row=>row.verdict==='pass').length,12);assert.equal(native.results.find(row=>row.id==='N10').verdict,'not-verified');
const csp=await json('artifacts/audit/csp-boundaries.json');for(const key of ['pdfWorker','wasm','imageDecoded','blobMediaLoaded','evalBlocked','inlineBlocked','networkBlocked'])assert.equal(csp.result[key],true);
const audit=await json('artifacts/audit/dependency-audit.json');assert.ok(audit.metadata);assert.ok(Object.values(audit.metadata.vulnerabilities).every(count=>count===0));
const fuzz=await json('artifacts/audit/protocol-fuzz.json');assert.equal(fuzz.totalCases,2016);assert.ok(fuzz.results.every(row=>row.passed));
const build=await readFile('artifacts/audit/remaining-normal-build.txt','utf8');assert.match(build,/✓ built/);assert.match(build,/Finished `dev` profile/);assert.match(build,/Built application at:/);
const executable=await readFile('src-tauri/target/debug/Mianxu.exe');assert.ok(executable.includes(Buffer.from('com.luoyaosheng.mianxu')));assert.equal(executable.includes(Buffer.from('com.mianxu.audit.boundaries20261104')),false);
const files=execFileSync('git',['ls-files','--cached','--others','--exclude-standard','--','src','src-tauri/src','src-tauri/macos-capture/src','scripts','tests','src-tauri/tauri.conf.json','package.json','pnpm-lock.yaml'],{encoding:'utf8'}).trim().split(/\r?\n/);
const sourceHashes=[];for(const file of [...new Set(files)].sort())sourceHashes.push({file,sha256:createHash('sha256').update(await readFile(file)).digest('hex')});
const sourceFingerprintSha256=createHash('sha256').update(sourceHashes.map(row=>row.file+'\0'+row.sha256+'\n').join('')).digest('hex');
const evidence={schemaVersion:1,createdAt:new Date().toISOString(),report:'2026-11-05-followup-fixes.md',sourceFingerprintSha256,sourceHashes,
  summary:{fixedFindings:['R01','R02','R03','R04'],securityHardening:['global connection quota and absolute header/handshake deadline','production CSP and native IPC compatibility'],nodeTestsPassed:310,rustTestsPassed:73,rustTestsIgnored:2,browserBoundaryChecks:13,modalChecks:12,browserSuitesPassed:5,nativeChecksPassed:12,nativeChecksNotVerified:1,fuzzCasesPassed:2016,normalDevelopmentBinaryRestored:true},
  modalCoverage:await json('artifacts/audit/modal-coverage.json'),csp:csp.result,findings:[...modal.results,...deep.results.filter(row=>row.finding)],nativeChecks:native.results,
  limits:['Phone HTTP/WS transport encryption explicitly deferred by the user','No macOS hardware acceptance','No real audio/conferencing or installer/update/uninstaller handoff','Docker Linux execution not verified'],
};
const output=JSON.stringify(evidence,null,2)+'\n';assert.doesNotMatch(output,/[A-Z]:\\|[A-Z]:\/Users\//);
await writeFile('docs/audit/2026-11-05-followup-evidence.json',output);console.log(JSON.stringify({sourceFingerprintSha256,summary:evidence.summary}));
