import {useState} from 'react';
import {invoke} from '@tauri-apps/api/core';
import {Button,Card,Select,Textarea} from '@/ui/primitives';
import {readData,type ExamSessionRecord} from '@/lib/backend';
import {extractLastCodeBlock} from '@/lib/examEngine';
interface Result {stdout:string;stderr:string;exitCode:number|null;timedOut:boolean;truncated:boolean;passed:boolean}
export function CodeVerificationPanel() {
  const [language,setLanguage]=useState('python');const [code,setCode]=useState('');
  const [stdin,setStdin]=useState('');const [expected,setExpected]=useState('');
  const [busy,setBusy]=useState(false);const [status,setStatus]=useState('');const [result,setResult]=useState<Result|null>(null);
  async function act(run:boolean) {
    setBusy(true);setStatus('');setResult(null);
    try {
      if(run)setResult(await invoke<Result>('cmd_code_run',{language,code,stdin,expected}));
      else setStatus(await invoke<string>('cmd_code_check'));
    }catch(error){setStatus(String(error));}finally{setBusy(false);}
  }
  return <Card className="p-5"><details><summary className="cursor-pointer text-sm font-semibold">代码样例验证</summary>
    <p className="my-3 text-xs leading-relaxed text-muted-foreground">粘贴可独立运行的 Python 或 JavaScript 程序及样例。点击运行后在本地 Docker Linux 容器中验证；无网络、无主机目录挂载，限时 10 秒、内存 256MB。需要先安装并启动 Docker，引擎和镜像不会自动下载。</p>
    <div className="mb-3 flex gap-2"><Select aria-label="样例验证语言" disabled={busy} value={language} onChange={e=>setLanguage(e.target.value)}><option value="python">Python 3</option><option value="javascript">JavaScript（Node.js 22）</option></Select><Button size="sm" variant="outline" disabled={busy} onClick={()=>void act(false)}>检查运行环境</Button><Button size="sm" variant="ghost" disabled={busy} onClick={()=>{
      const last=readData<ExamSessionRecord[]>('examSessions',[]).flatMap(record=>record.questions).filter(question=>question.answer).sort((a,b)=>b.createdAt-a.createdAt)[0];
      const extracted=last&&extractLastCodeBlock(last.answer);if(extracted)setCode(extracted);else setStatus('最近的笔试记录没有代码，请粘贴完整程序。');
    }}>载入最近代码</Button></div>
    <Textarea aria-label="待验证代码" value={code} onChange={e=>setCode(e.target.value)} maxLength={16000} rows={8} disabled={busy} placeholder="完整程序（需自行读取标准输入并输出答案）" className="font-mono text-xs" />
    <div className="my-3 grid grid-cols-2 gap-3"><label className="text-xs">样例输入<Textarea aria-label="样例输入" value={stdin} onChange={e=>setStdin(e.target.value)} maxLength={64000} rows={4} disabled={busy} className="mt-1 font-mono" /></label><label className="text-xs">预期输出<Textarea aria-label="预期输出" value={expected} onChange={e=>setExpected(e.target.value)} maxLength={64000} rows={4} disabled={busy} className="mt-1 font-mono" /></label></div>
    <Button size="sm" disabled={busy||!code.trim()} onClick={()=>void act(true)}>{busy?'处理中…':'在隔离容器中验证'}</Button>
    {status&&<p role="status" className="mt-3 whitespace-pre-wrap text-xs text-muted-foreground">{status}</p>}
    {result&&<div role="status" className="mt-3 rounded border p-3 text-xs"><p>{result.timedOut?'执行超时':result.truncated?'输出超过限制':result.passed?'样例通过':'样例未通过'} · 退出码 {result.exitCode??'无'}</p><p className="mt-2 text-muted-foreground">实际输出（比较时忽略末尾空白和 Windows 换行）</p><pre className="max-h-48 overflow-auto whitespace-pre-wrap">{result.stdout||'（空）'}</pre>{result.stderr&&<pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap text-destructive">{result.stderr}</pre>}</div>}
  </details></Card>;
}
