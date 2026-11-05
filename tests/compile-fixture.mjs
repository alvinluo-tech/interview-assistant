import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
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
/**
 * Compile a fixture together with its relative imports (e.g. lib modules that
 * import `./i18n`). Every module gets its own sandbox whose `require` resolves
 * relative specifiers against the importing file's directory, recursively.
 */
export function evaluateModuleFixture(source,sandbox={}) {
  const cache=new Map();
  const load=(src)=>{
    if(cache.has(src))return cache.get(src);
    const moduleSandbox={...sandbox,exports:{},require:(name)=>{
      if(!name.startsWith('.'))throw new Error(`Unsupported import: ${name}`);
      const target=path.resolve(path.dirname(src),name.replace(/\.js$/,'')+'.ts');
      if(!existsSync(target))throw new Error(`Cannot resolve ${name} from ${src}`);
      return load(target);
    }};
    const result=evaluateFixture(src,moduleSandbox);
    cache.set(src,result);
    return result;
  };
  return load(path.resolve(source));
}
