import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateFixture} from './compile-fixture.mjs';
function load() {
  return evaluateFixture('src/lib/updateCheck.ts',{exports:{},URL,AbortSignal,console});
}
test('release versions compare numerically and stable users skip prereleases',()=>{
  const {compareVersions}=load();
  assert.ok(compareVersions('v0.10.0','0.9.9')>0);
  assert.ok(compareVersions('1.0.0','1.0.0-beta.2')>0);
  assert.ok(compareVersions('1.0.0-beta.10','1.0.0-beta.2')>0);
  assert.equal(compareVersions('v1.2.3','1.2.3'),0);
  assert.throws(()=>compareVersions('latest','1.2.3'));
});
test('update check uses a real GitHub request, selects the installer, and rejects forged URLs',async()=>{
  const {checkForUpdate}=load(); let called;
  const release={tag_name:'v0.4.0',draft:false,prerelease:false,html_url:'https://github.com/owner/project/releases/tag/v0.4.0',assets:[{name:'Mianxu_0.4.0_x64-setup.exe',browser_download_url:'https://github.com/owner/project/releases/download/v0.4.0/setup.exe'}]};
  const fetcher=async(url,options)=>{called={url,options};return {ok:true,json:async()=>[release]};};
  const result=await checkForUpdate('owner/project','0.1.0','windows-x64',fetcher);
  assert.equal(result.version,'v0.4.0'); assert.match(result.downloadUrl,/setup\.exe$/);
  assert.equal(called.url,'https://api.github.com/repos/owner/project/releases?per_page=30');
  assert.ok(!called.options.headers.Authorization);
  release.assets[0].browser_download_url='https://evil.test/setup.exe';
  assert.equal((await checkForUpdate('owner/project','0.1.0','windows-x64',fetcher)).downloadUrl,undefined);
  release.prerelease=true;
  assert.equal(await checkForUpdate('owner/project','0.1.0','windows-x64',fetcher),null);
  await assert.rejects(checkForUpdate('../private','0.1.0','windows-x64',fetcher));
});
test('network failures and no releases never masquerade as already up-to-date',async()=>{
  const {checkForUpdate}=load();
  await assert.rejects(checkForUpdate('owner/project','0.1.0','windows-x64',async()=>({ok:false,status:403})),/403/);
  await assert.rejects(checkForUpdate('owner/project','0.1.0','windows-x64',async()=>({ok:true,json:async()=>[]})),/发布/);
});

test('the mock window hash accepts its session query instead of mounting the main workbench',()=>{
  const location={hash:'#mock?sid=mock-123'};
  const i18n=evaluateFixture('src/lib/i18n.ts',{exports:{},window:{location}});
  assert.equal(i18n.windowScene(),'mock');
  location.hash='#overlay';assert.equal(i18n.windowScene(),'overlay');
  location.hash='#mocked';assert.equal(i18n.windowScene(),'main');
});
