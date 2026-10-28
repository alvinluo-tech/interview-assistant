// Check the actual dev-server import graph without opening an ASR task or sending audio.
import ts from 'typescript';
const origin = new URL(process.argv[2] || 'http://localhost:1430').origin;
const seen = new Set(), failures = [];
async function check(url) {
  if (seen.has(url) || seen.size >= 200 || new URL(url).origin !== origin) return;
  seen.add(url);
  let response;
  try { response = await fetch(url, { signal: AbortSignal.timeout(10000) }); }
  catch { failures.push({ path: new URL(url).pathname, error: 'connection_failed' }); return; }
  if (!response.ok) { failures.push({ path: new URL(url).pathname, status: response.status, reason: response.statusText }); return; }
  const source = await response.text();
  const imports = [];
  function visit(node) {
    const specifier = (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) ? node.moduleSpecifier
      : ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword ? node.arguments[0] : undefined;
    if (specifier && ts.isStringLiteral(specifier) && /^(?:\/|\.\.?\/)/.test(specifier.text)) imports.push(new URL(specifier.text, url).href);
    ts.forEachChild(node, visit);
  }
  visit(ts.createSourceFile(url, source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS));
  await Promise.all(imports.map(check));
}
await check(`${origin}/src/lib/realtimeAsr.ts`);
console.log(JSON.stringify({ checked: seen.size, failures }, null, 2));
if (failures.length) process.exitCode = 1;
