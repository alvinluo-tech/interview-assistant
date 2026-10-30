import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
export function evaluateFixture(source,sandbox) {
  const directory=path.resolve('artifacts/test-compiled');mkdirSync(directory,{recursive:true});
  const filename=path.join(directory,path.basename(source,'.ts')+'.cjs');
  const compiled=ts.transpileModule(readFileSync(source,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
  writeFileSync(filename,compiled);vm.createContext(sandbox);vm.runInContext(compiled,sandbox,{filename});
  return sandbox.exports;
}
