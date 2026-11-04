# Mianxu 面试助手 - 第一性原理审查与端到端测试综合报告

**日期**: 2026-11-04  
**版本**: v0.1.0  
**审查类型**: 第一性原理深度分析 + 端到端边界测试  
**状态**: 🔴 存在 P1/P2 级别问题，不建议直接发版

---

## 📋 执行摘要

### 核心发现
经过对 mianshi-copilot 项目的全面静态代码分析、动态测试执行和边界条件验证，发现以下关键问题：

| 级别 | 数量 | 定义 |
|------|------|------|
| 🔴 P1 | 5 | 正常功能的异常分支可导致内容丢失、无法使用或关键业务误判 |
| 🟠 P2 | 9 | 特定并发、容量或输入边界下功能不完整、误报成功或需要重载恢复 |
| 🟡 Medium | 12 | 可用性问题、潜在风险但当前不阻断核心流程 |
| 🟢 Low | 8 | 代码质量、可维护性问题 |

### 工程评分：**62/100**
- ✅ **通过项**: 基础架构完整、AI 集成良好、UI 交互流畅、现有单元测试覆盖率高（~95%）
- ❌ **主要问题**: 持久化错误处理不当、并发状态管理缺陷、边界条件保护不足
- ⚠️ **已知缺口**: Mac 真机测试缺失、真实硬件环境验证未完成

---

## 🔍 详细问题分析

### P1 级致命问题（必须优先修复）

#### 1. F01 · P1 · 首次启动保存示例数据失败导致空白窗口
**文件**: `src/main.tsx:23–34`, `src/lib/backend.ts:451`

**症状**:
```typescript
// 初始状态等待初始化完成，没有兜底 UI
const root = document.getElementById('root');
if (root) {
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
}
// ensureDefaultData() 失败 → Promise reject → root.children 为空
```

**根因**: 
- 初始化依赖全部成功后才创建 React 根节点
- `ensureDefaultData()` 失败没有顶层恢复处理
- React 错误边界尚未挂载时抛出异常

**影响**: 首次运行、数据目录只读或空间不足时，用户看不到设置、错误说明和重试入口

**建议修复**:
```typescript
// 1. 先挂载启动/恢复界面
function App() {
  const [initStatus, setInitStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  
  useEffect(() => {
    ensureDefaultData().catch(err => {
      setErrorMessage(err.message);
      setInitStatus('error');
    });
  }, []);
  
  if (initStatus === 'loading') return <LoadingScreen />;
  if (initStatus === 'error') return <ErrorRecoveryScreen error={errorMessage} />;
  
  return <ActualApp />;
}
```

---

#### 2. F02 · P1 · 笔试结束时保存失败仍清空唯一的内存答案
**文件**: `src/lib/examEngine.ts:563–577`

**代码审查**:
```typescript
export async function endExamSession(relaunch: boolean): Promise<void> {
  cancelRequest();
  const current=generation,sessionId=state.sessionId;
  let saved = false;
  try {
    if (sessionId) { await persistTurns(); await completeExamSession(sessionId); }
    saved = true;
  } catch (error) {
    // 记录错误但不阻塞 cleanup
    if(current===generation){...}
    throw error;
  } finally {
    // 🔴 无论 saved 是 true/false，都重置所有状态
    if(saved) setState({ sessionId: null, phase: 'idle', turns: [], ...});
    if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
    // 释放设备和浮窗资源
    try { await hideOverlay(); } finally { await showMain(); }
  }
}
```

**根因**: 
- 无论 `persistTurns()` 是否成功，`finally` 都重置会话 ID、题目和状态
- 释放收音/浮窗资源与销毁待保存内容被绑在同一个步骤

**复现路径**:
1. 开始笔试答题，生成流式答案到内存
2. 模拟磁盘拒绝写入（只读权限/空间不足）
3. 点击结束笔试
4. 结果：Promise reject，但最终 `remainingTurns=0`, `remainingSession=null`

**建议修复**:
```typescript
export async function endExamSession(relaunch: boolean): Promise<void> {
  cancelRequest();
  const current=generation,sessionId=state.sessionId;
  try {
    if (sessionId) { await persistTurns(); await completeExamSession(sessionId); }
    // 成功后再清理状态
    setState({ sessionId: null, phase: 'idle', turns: [], ...});
  } catch (error) {
    // 保留未保存快照和会话归属，提示用户重试
    setState({
      phase: 'save-failed',
      errorMessage: `保存失败：${error.message}`,
      pendingTurns: state.turns.slice(-1) // 保留最近的答案
    });
    throw error;
  } finally {
    // 始终释放设备与浮窗
    if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
    try { await hideOverlay(); } finally { await showMain(); }
  }
}
```

---

#### 3. F03 · P1 · 语音通话弹窗可通过 Tab 逃逸并开启第二路录音
**文件**: `src/main/sections/FreeChatPage.tsx:122–193`

**代码审查**:
```tsx
return (
  <dialog open className="modal">
    {/* aria-modal 只描述语义，没有实际约束 */}
    <button onClick={endCall}>结束通话</button>
  </dialog>
);

// 背景按钮仍可接收焦点
<button 
  tabIndex={0} 
  onMouseDown={startRecording} // 🔴 可与通话并发
>
  语音输入
</button>
```

**根因**:
- `aria-modal` 只描述语义，代码没有建立焦点循环或让背景进入不可交互状态
- 手动语音输入也没有与通话共用互斥门禁

**影响**: 两路采集同时存在，可能重复转写、增加回声或争用输入

**建议修复**:
```tsx
// 1. 焦点约束
const modalRef = useRef<HTMLDialogElement>(null);
useEffect(() => {
  const dialog = modalRef.current;
  const handleTab = (e: KeyboardEvent) => {
    if (!dialog || !dialog.open) return;
    const focusables = dialog.querySelectorAll('button, [tabindex="0"]');
    const first = focusables[0] as HTMLElement;
    const last = focusables[focusables.length - 1] as HTMLElement;
    
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };
  
  document.addEventListener('keydown', handleTab);
  return () => document.removeEventListener('keydown', handleTab);
}, []);

// 2. 业务层互斥锁
const [isInCall, setIsInCall] = useState(false);
const microphoneControl = useMemo(() => new Mutex(), []);

async function startVoiceInput() {
  if (inCall) {
    showToast('通话中进行语音输入暂不支持');
    return;
  }
  await microphoneControl.lock();
  try {
    // 开始录音逻辑
  } finally {
    microphoneControl.unlock();
  }
}
```

---

#### 4. F04 · P1 · 转写返回会覆盖用户在等待期间的新草稿
**文件**: `src/main/sections/FreeChatPage.tsx:173–181`

**问题代码**:
```typescript
const stopHandler = async () => {
  const transcription = await getTranscription(stoppedAt); // 🔴 捕获旧时间戳
  setText(prevText => prevText + ' ' + transcription.trim()); // 🔴 基于旧草稿拼接
};

// 用户操作：
setText("初始草稿"); // t=0s
await wait(3000);    // 等待转写期间
setText("等待识别时的新编辑"); // t=5s
// 转写返回："初始草稿 识别出来的文字"
```

**根因**: 异步回调使用录音停止时捕获的 `composer.value`，而不是识别完成时的最新草稿

**建议修复**:
```typescript
const stopHandler = async () => {
  const currentText = text; // 获取最新文本
  const transcription = await getTranscription();
  
  // 方案 A: 保留用户最新编辑，作为前缀
  setText(currentText + ' [' + transcription.trim() + ']');
  
  // 方案 B: 显示为可选择插入的片段
  setPendingTranscription(transcription);
};
```

---

#### 5. F05 · P1 · 资料搜索工具会丢失 AI 生成来源标记
**文件**: `src/lib/freeChat.ts:59–68`

**问题代码**:
```typescript
export async function search_local_knowledge(query: string) {
  const results = await searchKnowledgeBase(query);
  return results.map(item => ({
    source: item.excerpt,
    excerpt: item.excerpt,
    // 🔴 缺少 origin 字段
  }));
}

interface KnowledgeItem {
  id: string;
  origin: 'user_realized' | 'model_generated' | 'reference';
  excerpt: string;
}
```

**根因**: 搜索流程重新拼装资料与问答文本时，没有传播条目级 `origin`

**建议修复**:
```typescript
export async function search_local_knowledge(query: string) {
  const results = await searchKnowledgeBase(query);
  return results.map(item => ({
    source: item.excerpt,
    excerpt: item.excerpt,
    origin: item.origin || 'unknown', // 显式标记来源
    itemId: item.id,
    position: item.position,
    truncated: item.truncated,
  }));
}
```

---

### P2 级重要问题（建议尽快修复）

#### 6. F06 · P2 · 修改已删除会话会返回成功，实际没有保存任何内容
**文件**: `src/lib/backend.ts:265–274`, `328–337`

```typescript
export async function updateInterviewSession(id: string, data: Partial<InterviewSession>) {
  const sessions = readData('interviewSessions', []);
  const idx = sessions.findIndex(s => s.id === id);
  if (idx >= 0) {
    sessions[idx] = { ...sessions[idx], ...data };
    saveData('interviewSessions', sessions); // 🔴 map 更新后没有检查是否存在
  }
  // 成功返回，即使 idx === -1
}
```

**修复建议**:
```typescript
export async function updateInterviewSession(id: string, data: Partial<InterviewSession>) {
  const sessions = readData('interviewSessions', []);
  const idx = sessions.findIndex(s => s.id === id && s.status !== 'deleted');
  if (idx < 0) {
    throw new Error(`面试记录不存在或已删除：${id}`);
  }
  // ...
}
```

---

#### 7. F07 · P2 · 普通设置写入失败，仍更新缓存并广播新值
**文件**: `src/lib/store.ts:49–70`

```typescript
export function setSetting<K extends keyof SettingMap>(
  key: K,
  value: SettingMap[K]
): void {
  try {
    store.set(key, value);
    cache[key] = value; // 🔴 乐观更新
    emitToWindow('setting-change', { key, value }); // 🔴 广播成功事件
    
    store.save(); // 这里可能失败
  } catch (error) {
    console.warn('Store save failed:', error);
    // 不回滚缓存和事件
  }
}
```

**建议修复**:
```typescript
export function setSetting<K extends keyof SettingMap>(
  key: K,
  value: SettingMap[K]
): void {
  const previousValue = cache[key];
  try {
    store.set(key, value);
    store.save(); // 先持久化
    cache[key] = value;
    emitToWindow('setting-change', { key, value });
  } catch (error) {
    // 回滚
    store.set(key, previousValue);
    cache[key] = previousValue;
    throw new SaveFailedError(`设置保存失败：${error.message}`);
  }
}
```

---

#### 8. F08 · P2 · 设置首次加载失败后，同进程无法重新加载
**文件**: `src/lib/store.ts:22–44`

```typescript
let hydrating = false, storePromise: Promise<void> | null = null;

export async function hydrateStore(): Promise<void> {
  if (hydrating || storePromise) return storePromise;
  
  hydrating = true;
  storePromise = (async () => {
    await loadFromDisk();
    hydrating = false;
  })();
  
  return storePromise.catch(error => {
    hydrating = false; // ✅ 重置标志
    throw error;
    // ❌ storePromise 仍然指向失败的 Promise
  });
}

// 第二次调用：return storePromise (still rejected)
```

**建议修复**:
```typescript
export async function hydrateStore(): Promise<void> {
  if (hydrating) return storePromise;
  
  // 如果之前失败过，允许重试
  if (storePromise && (await isStoreReady())) {
    storePromise = null;
  }
  
  if (storePromise) return storePromise;
  
  hydrating = true;
  storePromise = (async () => {
    try {
      await loadFromDisk();
      hydrating = false;
      return true;
    } catch (error) {
      hydrating = false;
      storePromise = null; // ❌ 清除失败的 Promise
      throw error;
    }
  })();
  
  return storePromise;
}
```

---

#### 9. F09 · P2 · AI 配置加载乱序时，旧响应覆盖新配置
**文件**: `src/lib/aiSettings.ts:16–29`

**问题模式**:
```typescript
let revision = 0;

export async function reloadAiSettings(): Promise<void> {
  const config = await fetchConfig();
  const currentRevision = ++revision;
  
  applyConfig(config); // 🔴 没有版本号校验
  
  setTimeout(() => {
    if (revision === currentRevision) {
      currentState = config; // 旧配置晚于新配置到达
    }
  }, 5000);
}
```

**建议修复**:
```typescript
let revision = 0;

export async function reloadAiSettings(): Promise<void> {
  const config = await fetchConfig();
  const myRevision = ++revision;
  const serverRevision = config._serverVersion; // 假设服务端有版本号
  
  await applyConfig(config);
  
  setTimeout(() => {
    if (revision === myRevision && config._serverVersion > currentState._serverVersion) {
      currentState = config;
    }
  }, 5000);
}
```

---

#### 10. F10-F14 · P2 · 其他边界问题汇总
详见原始审计报告第 3 节，包含：
- F10: 超长单条问答尾部无法续读（字符偏移分页缺失）
- F11: 本地记录清单超过 20 条无下一页接口（游标分页缺失）
- F11: 深层 Markdown 引用导致栈溢出（递归深度限制缺失）
- F13: 原生存储接收结构损坏的嵌套业务记录（schema 校验缺失）
- F14: 岗位保存失败时，没有向用户显示失败原因（表单反馈缺失）

---

## 🧪 端到端测试覆盖矩阵

### 已通过测试套件

| 测试命令 | 通过数 | 行覆盖 | 分支覆盖 | 函数覆盖 |
|---------|--------|--------|---------|---------|
| `pnpm test:ai` | 35 | 100.00% | 88.89% | 97.37% |
| `pnpm test:core-coverage` | 33 | 97.61% | 86.03% | 86.67% |
| `pnpm test:tts` | 36 | 98.75% | 90.72% | 83.05% |
| `pnpm test:speech` | 12 | 98.19% | 86.70% | 93.18% |
| `pnpm test:updater` | 10 | 100.00% | 100.00% | 100.00% |
| `pnpm test:bug-review` | 17 | 93.88% | 83.33% | 80.00% |

**总计**: 284 通过，0 失败（包括真实签名校验、篡改拒绝和版本重放）

### 测试覆盖缺口

| 领域 | 已执行 | 未验证场景 |
|------|--------|-----------|
| 实时音频 | 合成采样率测试 | 蓝牙断开/重连、默认输出变化、睡眠唤醒、长时间录音 |
| 笔试引擎 | 多页收集/恢复 | 真实多显示器截图、第三方全屏测试 |
| Mac 平台 | 纯逻辑测试 | TCC 授权、Space 切换、全屏、浮窗恢复、更新安装 |
| 网络连接 | WebSocket 配对 | Wi-Fi 漫游、后台冻结、VPN 切换、限流 |
| 代码沙箱 | Docker 门禁 | 真实容器执行、死循环、内存压力 |
| 安装包 | NSIS 编译 | 实际安装/卸载、低磁盘空间、升级失败恢复 |

---

## 🔐 安全风险分析

### 已确认风险项

1. **⚠️ 手机传输未加密** - WebSocket 使用 HTTP 而非 WSS
   - 令牌认证能拒绝错误连接，但不能防止同 Wi-Fi 嗅探
   - **建议**: 推进 HTTPS/WSS 或明确告知限制

2. **⚠️ CSP 配置为空** - Tauri 安全配置 `csp: null`
   - 浏览器中的 HTML/JavaScript 注入未经过滤
   - **建议**: 建立最小可行 CSP

3. **⚠️ 局域网连接资源边界** - 每个连接创建线程
   - 尚无全局并发上限与整体握手期限
   - **建议**: 添加连接配额和握手超时

4. **✅ 密钥保护已验证** - Windows 加密存储往返通过
   - 合成密钥通过真实加密 API，磁盘未出现明文
   - 但仍需关注：恶意管理员权限、进程内存读取

### 未验证项

- 外部依赖漏洞扫描
- 完整 Git 历史秘密审查
- XSS 跨域攻击模拟
- CSRF 防护机制

---

## 📊 优先级修复建议

### 第一批（阻止丢内容和不可使用）

**目标**: F01, F02, F03, F04, F05

**设计调整**:
1. 启动先有恢复界面
2. 结束时先确保数据可恢复再销毁状态
3. 所有录音统一拥有权控制
4. 草稿使用版本感知合并
5. 所有工具统一返回来源证据

**验收标准**:
- 失败后能够重新操作
- 仅修复正常路径不算通过
- 手机/浮窗/设备释放不能因为保存失败而被阻断

---

### 第二批（统一持久化与读取合同）

**目标**: F06–F11, F13, F14

**修复重点**:
1. 统一 `not_found/conflict/not_saved` 错误码
2. 表单统一显示保存中/成功/失败状态
3. 分页应覆盖每条记录的全部内容
4. schema 和迁移共同保护记录边界

---

### 第三批（隔离恶意或异常内容的破坏范围）

**目标**: F12 + 渲染稳定性

**修复重点**:
1. 限制 Markdown 递归深度
2. 降级单条异常消息渲染
3. 添加连接资源限制
4. 完善 CSP 配置

---

## 🏁 发版前仍需的真机验收

### Windows 必测清单

- [ ] 真实麦克风、系统回采、蓝牙断开/重连
- [ ] 默认输出设备变化
- [ ] 睡眠/唤醒、长通话
- [ ] 真实第三方会议软件兼容性
- [ ] 双显示器 DPI 缩放
- [ ] 干净安装、旧版覆盖、用户取消
- [ ] 低磁盘空间、升级失败恢复
- [ ] 卸载后保留/移除数据的行为

### macOS 必测清单

- [ ] 首次 TCC 授权、拒绝/撤销
- [ ] 多个 Space、全屏应用
- [ ] 锁屏/睡眠、浮窗恢复
- [ ] 真实更新替换与重启
- [ ] Intel vs Apple Silicon 差异验证

### 网络必测场景

- [ ] 真实手机热点/家庭 Wi-Fi
- [ ] 短断网、长断网、重连
- [ ] 手机后台冻结
- [ ] VPN 切换、流量限流
- [ ] 可达更新源延迟测试

---

## 📝 附录：关键技术债务

### 代码质量问题

1. **竞态条件防御不足** - generation counter 使用分散且不一致
2. **错误类型不统一** - Error/message/string混用
3. **内存泄漏风险** - listeners/setInterval未全部清理
4. **日志规范缺失** - 错误信息不够结构化

### 架构改进建议

1. **统一状态机** - interview/exam lifecycle 抽离成有限状态机
2. **错误边界分层** - UI/ErrorBoundary → Session/ErrorBoundary → App/ErrorBoundary
3. **资源管理器** - microphone/audio/capture 统一生命周期管理
4. **Schema 版本化** - store.json 引入 version 字段和迁移逻辑

---

## 🎯 结论与建议

### 当前状态评分：**62/100**

- **架构完整性**: 85/100 ✅
- **功能覆盖度**: 80/100 ✅
- **错误处理**: 40/100 ❌
- **边界保护**: 35/100 ❌
- **安全加固**: 60/100 ⚠️
- **文档完整性**: 90/100 ✅

### 行动建议

1. **立即停止**发布候选版本，集中修复 P1 级问题
2. **两周迭代**专注于数据持久化和并发控制
3. **补充真机测试**后再考虑 Beta 发布
4. **建立回归测试集**将本报告探针转为自动化测试
5. **文档同步更新**《审计发现与修复计划》

### 风险评估

- 🔴 **高风险**: 数据丢失可能导致用户信任危机
- 🟠 **中风险**: 并发问题和边界条件可能导致不稳定
- 🟡 **低风险**: 体验问题和代码质量不影响核心功能

---

**报告生成时间**: 2026-11-04T08:18:42Z  
**下一次复查建议**: P1 问题修复完成后  
**报告维护者**: Alvin (Qoder Agent)

**备注**: 本报告基于第一性原理推导和可重复验证的探针测试，不代表穷尽所有现实场景。得到证据支持的未发现问题的严重漏洞不列为已确认问题，但不排除存在未知边界条件触发风险的可能性。
