# Bug 审计清单（持续更新，不做修复）

> 目标：穷尽当前复刻项目的潜在缺陷——边界条件、资源竞态、生命周期泄漏、错误吞没、跨窗口一致性、原生/前端协议不一致。
> 每条含：位置（文件:行）、现象、复现/推理路径、严重级别（P0 崩溃或数据损坏 / P1 功能错误 / P2 体验或日志 / P3 加固建议）、证据。
> 修复交给后续 agent 二次确认后执行；本文只记录事实与推理，不改代码。

## 索引（38 条：B1–B38，其中 B37 为撤销记录）

**P0/P1（数据完整性/功能失效）**
- B1 面试会话跨场续写：第二场静默写入第一场已 COMPLETED 记录（同根：B13）
- B2 笔试浮窗品牌名硬编码「骆耀升老公酱面试助手」
- B3 穿透模式下「穿透/窗口切换」按钮完全失效（2200ms 常量定义未用）
- B4 样式热键快速连按丢失更新（闭包旧 style 竞态）
- B5 resize 把手拖完尺寸不持久化（无 onResized 监听）
- B13 closeStaleActiveSessions 不清 interview.sessionId（与 B1 同根）
- B16 window.__ml_getSetting 未定义，showHotkeyHints 开关死亡
- B17 panic 热键冲突时静默失效 + 永久重试风暴 + StrictMode 双线程
- B18 录键器修饰键守卫失效，可保存非法加速器（ControlLeft 等）
- B22 jobProgress 不在原生白名单，打卡数据永不持久化（E2E 已复现）
- B23 笔试僵尸 ACTIVE 会话（main/overlay 双 webview 双建会话）
- B27 笔试「回答语言」设置从不进入 prompt

**P1（UX 明显缺陷）**
- B7 followNewRound=false 仍强制滚动、无手动解除跟随
- B8 边缘滚动 pill 悬停无效、速度曲线/scrollSpeed 缺失
- B24 工作台「结束面试」不通知浮窗，留下僵尸收音

**P2**
- B6 浮窗位置恢复无工作区钳制（换分辨率后浮窗丢失）
- B9 completeSession 失败留僵尸引擎状态
- B10 复制答案无反馈、静默失败
- B11 answerNow 空壳
- B20 overlay 窗口无最小/最大尺寸约束（E2E：1×1 与 30000×30000 均接受）
- B26 updater-secrets 测试依赖 pwsh（本机无 → 假失败）
- B28 capturePage 无页数上限（solve 静默截断）
- B29 [[FOLLOWUP:]] 建议追问解析后零渲染（死数据）
- B30 一键配色缺两段确认
- B31 interviewer:utterance 无消费者（solver 自动接题缺失）
- B33 interview.solverExamMode 死键（面试/笔试档位互相污染）
- B36 「排除播放设备」只有读取没有写入（死功能）

**P3（加固/一致性/记录）**
- B12 elapsedSec 计时器常驻不回收
- B14 流式回答不落盘（崩溃丢回答）
- B15 showOnboarding 表达式优先级可疑
- B19 日志文件名与产品名分裂（cmd_read_recent_logs 硬编码）
- B21 cmd_os_version 返回 DisplayVersion 非 Build 号
- B25 StrictMode 启动副作用双执行（放大 B17）
- B32 模拟面试录音上限 120s（官方 300s）
- B34 capture.experimentalSharedSurface 死键
- B35 main.tsx errorSink 无上限（官方 400 条环形）
- B38 12 个登记但无消费者的 store 死键清单
- B37（撤销）cmd_hide_main 实际正常；附带发现 WebView2 visibilityState 不随 SW_HIDE 更新

**静态基线**：tsc 0 错；cargo check 通过、clippy 16 style；cargo test 48/48；node --test 169/170（唯一失败 = B26 环境问题）。

---

## A. 静态扫描结果

（tsc / cargo check / clippy 输出待补。）

## B. 引擎与浮窗代码审查发现

### B1【P0/P1·数据完整性】第二场面试静默续写第一场已完成会话

- 位置：`src/lib/interviewEngine.ts:628-643`（resumeInterviewSession）+ `src/overlay/InterviewOverlay.tsx:91-95`（bootstrap）+ `src/lib/interviewEngine.ts:823-836`（endInterview 不清 store 键）。
- 路径：`interview.sessionId` 这个 **store 键只在创建时写入**（InterviewOverlay.tsx:104），`endInterview` 只清引擎内存态不清该键。同一应用运行期内开第二场面试：浮窗重新挂载 → bootstrap 读到旧 id → `resumeInterviewSession(oldId)` 只判断 `sessions.find(...)` **存在即返回 true，不看 status** → 返回 true → `beginListening`，**新会话永远不创建**；第二场的问答全部 `updateSession(oldId)` 写进第一场已 COMPLETED 的记录。
- 复现：开面试 A → 答 1-2 句 → 结束面试 → 再开面试 B（同应用运行期）→ 答 1 句 → 历史记录里只有一条会话，包含 A+B 的全部消息，B 的 goalId 却覆盖了 A 的。
- 附带：`closeStaleActiveSessions`（backend.ts:276）只在 main 挂载时跑一次，且只清 records 不清该 store 键（见 B13）。
- 建议：endInterview/resumeInterviewSession 处清键或校验 `status !== 'COMPLETED'`（修复方案由后续 agent 定）。

### B2【P1·用户可见】笔试浮窗品牌名硬编码

- 位置：`src/overlay/ExamOverlay.tsx:169`。
- 现象：顶栏显示「骆耀升老公酱面试助手」，官方为品牌名「面灵AI」。每场笔试可见；与 disguise.windowTitle 等配置无关。
- 建议：改为品牌常量或读设置。

### B3【P1·功能失效】穿透模式下「穿透/窗口切换」按钮完全失效

- 位置：`src/overlay/InterviewOverlay.tsx:184-192`；`src/overlay/widgets.tsx:277`（`HOVER_MS.switchInteractive: 2200` 定义但全仓库无引用）。
- 现象：按钮只有 `onClick`。穿透模式下 webview 收不到点击（点击穿透），按钮也没有 `useDwell` 悬停绑定 → **用户在穿透模式下既点不到也悬停不了，无法从浮窗进入窗口模式**（也无法触发官方「悬停 2.2s 切窗口」交互）。窗口态点击切回穿透可用。
- 官方：yq 按钮穿透态悬停 2200ms 切窗口模式（tooltip「悬停或点击切到穿透模式（反监考）」，BS:50804-50846）。
- 建议：加 `useDwell('iv-mode', 2200, toggleInteractive, { disabled: interactive })` 并保留窗口态 onClick。

### B4【P1·竞态】样式热键快速连按丢失更新

- 位置：`src/overlay/OverlayApp.tsx:145-214`（useOverlayStyleHotkeys）。
- 路径：事件回调从 React 闭包捕获的 `style` 计算合并（`useEffect` deps `[style, mode]`）。两次快速按键（例如 opacity-up ×2）在 re-render 前后都用**同一份旧 style** 计算 `cur + step` → 两次都写 `cur+step`，实际只生效一步。
- 官方：XE 用串行队列 `YE`（读最新样式→合并→持久化→emit），不会丢步。
- 建议：从 store 同步读最新 style（getSetting）再合并，或函数式更新。

### B5【P1·功能缺失】右下角 resize 把手拖完不持久化

- 位置：`src/overlay/platform.tsx:193-197`（startResize 只调 `startResizeDragging('SouthEast')`）；全仓库无 `onResized` 监听。
- 官方：`onResized` 后 500ms 防抖，尺寸 ≥200×150 才写回 `interview/examWidth/Height`（BS:51872-51900、spec 02 §3.6）。
- 后果：拖完重启浮窗恢复旧尺寸；OverlayApp.tsx:88-97 的尺寸同步 effect 反而会在下次显示时把窗口**改回旧值**（用户调整丢失）。
- 建议：MainWindow/浮窗侧监听 `onResized` → 防抖 500ms → 下限校验 → 写 style。

### B6【P2】浮窗位置恢复不钳制工作区

- 位置：`src/overlay/OverlayApp.tsx:133-142`（restorePosition 直接用存储值）。
- 现象：换分辨率/断开副屏后，保存的 overlay.position 可能在可见区域外，浮窗出现「消失」。官方 pK 有 dK 钳制（BS:48966）。
- 建议：恢复前用 `currentMonitor().workArea` 钳制。

### B7【P1·UX】followNewRound=false 仍强制滚动；无手动解除跟随

- 位置：`src/overlay/InterviewOverlay.tsx:358-368`。
- 现象：`followNewRound` 为 false 时走 else 分支 `el.scrollTop = el.scrollHeight`——**每条新消息仍然把列表拽到底**，与官方「false → 不跟随」（BS:51301-51320）相反。且没有 scroll 监听：用户上滚回看时，下一条新消息照样拽走。
- 建议：false 时不滚动；监听 scroll，离底即解除跟随，新回合恢复跟随条件化。

### B8【P1·UX】边缘滚动 pill：悬停不滚动、速度曲线错误、忽略 scrollSpeed

- 位置：`src/overlay/widgets.tsx:186-235`。
- 官方：光标停在边缘 pill → 连续滚动（1s 内 3→9px/帧加速 ×`overlay.style.scrollSpeed`，BS:47812）；到头再停 700ms → 触发该边动作（翻页/回底）。
- 复刻：pill 只有热键按住滚动；速度 `(3+6)*min(frameDelta/16.7,3)*1`——恒 9px/帧、**无加速段、硬编码 ×1 忽略 scrollSpeed 设置**；无 700ms 到头触发；pill `pointer-events-none` 且无 useDwell，穿透模式下纯装饰（zone 注册了但无行为）。
- 建议：补 hover 驱动 + 速度曲线 + scrollSpeed + 到头触发。

### B9【P2】endInterview 中 completeSession 失败留僵尸状态

- 位置：`src/lib/interviewEngine.ts:823-836`。
- 路径：`complete=true` 时 `await completeSession(sessionId)` 抛错（存储占用/磁盘故障）→ `setState({sessionId:null})` 不执行 → 引擎停留 `status:'ended'` 且 sessionId 非空 → 浮窗 bootstrap（`state.sessionId || status==='connecting'` 拦截）无法开新场，直到 webview 重载。官方 completeSession 有 3 次×400ms 重试（BS:52324）。
- 建议：重试 + 失败兜底清 sessionId（报错但不阻塞）。

### B10【P2】复制答案无反馈、静默失败

- 位置：`src/overlay/ExamOverlay.tsx:126-139`（copy）、79-90（copyAnswerToClipboard）。
- 官方：成功「已复制代码（{n} 行）/已复制答案文字（{n} 字）」、失败「复制失败，请再按一次」、空「答案还没写完，写完再复制」（BS:53390）。
- 复刻：两处 `catch { // ignore }`，成功也无提示——用户无法确认是否复制成功。

### B11【P2】answerNow 是空壳

- 位置：`src/lib/examEngine.ts:342-345`（注释「此处理保留命令面」，函数体为空）。
- 官方：solving 时「直接答」让 AI 提前收尾输出当前答案（BS 4.1 St）。本地可映射为 abort 流式并保留已生成部分 + 标记完成。浮窗也无该按钮（配套差距见 gap-analysis 2.4.2）。

### B12【P3】solver 计时器常驻

- 位置：`src/lib/examEngine.ts:121-128`（ensureTicker）。首个 solve 后 `tickTimer` 永不清（endExamSession 清一次；abortSolve 不清）。每秒一次 phase 判断的空转开销，长驻浮窗中轻微。

### B13【P1】closeStaleActiveSessions 与 interview.sessionId 不同步

- 位置：`src/lib/backend.ts:276-295`、`src/main/MainWindow.tsx:126-135`。
- 现象：main 启动清陈旧 ACTIVE 记录，但 `interview.sessionId` store 键不清 → 与 B1 同根：应用重启后浮窗 bootstrap 读到旧键恢复已 COMPLETED 的会话并开始收音写入。
- （合并 B1 修复。）

### B14【P3】流式回答不落盘

- 位置：`src/lib/interviewEngine.ts:442-493`（只在完成时 persistMessages）。
- 现象：回答生成中 webview 崩溃/浮窗异常 → 该条回答全部丢失（转写文本已在上一条持久化）。官方云端逐条上云。可在 done 前周期性持久化。

### B15【P3】showOnboarding 条件可读性

- 位置：`src/main/MainWindow.tsx:153`：`!onboardingSkipped && !usageAcked === false`——实际语义 `!skipped && !!usageAcked`（须先同意使用须知）。与官方门控（数据为空即弹，使用须知先弹）基本一致但写法易误读；确认是否有意为之。

（以下章节待续：原生层审查、E2E 结果、spec 03/04/05 面上的更多条目。）

## C. E2E 运行时探测发现（CDP 9444，2026-10-30）

探测环境：dev 调试实例 + WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9444；结果文件 `_recon/e2e-out2.json`。其余探测结论（正常项）：store 读写往返正常；双窗口各 50 次并发 `cmd_data_commit` 无异常；截屏 1.4MB dataURL 正常；zones 设置/查询正常；`cmd_platform_capabilities` 能力集完整。

### B16【P1·功能失效】`window.__ml_getSetting` 从未定义，热键提示开关死亡
- 位置：`src/overlay/widgets.tsx:247-257`（showHotkeyHints 惰性读 `__ml_getSetting`）。
- 全仓库 grep：该全局只在 widgets.tsx:251 被读，**无任何定义点** → 永远走 fallback `return true` → `interview.showHotkeyHints` 设置关闭后浮窗热键徽标依然显示。
- 建议：store.ts 挂 `__ml_getSetting = getSetting`，或改为订阅式 context。

### B17【P1】panic 热键与其它应用冲突时：静默失效 + 无意义重试风暴 + 重复线程
- 证据（logs/骆耀升老公酱面试助手.log）：
  - `panic hotkey register failed: HotKey already registered {CONTROL|SHIFT, KeyX}` 每 10 秒一条，**成对出现**（14:43:39→14:48:57 持续 5 分钟+，远超 30 次×10s=300s 预期）；
  - E2E 实测 `cmd_panic_hotkey_status` → `{"registered":false}`——当前实例 panic 热键确实不可用；
  - 另有 `panic hotkey parse failed: Couldn't recognize "ControlLeft"`（见 B18）。
- 根因链：
  1. 官方面灵AI（同时在运行）持有全局 Ctrl+Shift+X → 复刻版注册报 already registered；
  2. `hotkeys.rs:147-168` 重试循环**不区分错误类型**——对「被其他程序占用」这种永久失败也重试 30 次；且每次调用 cmd_set_panic_hotkey 失败都会**再起一个 30×10s 线程**（无去重 flag）；StrictMode 双调 effect → 日志成对；
  3. 启动时注册死亡无任何 toast/横幅（设置页有 panicRegistered 显示，但主窗口不提示）。
- 建议：already-registered 类错误不重试并提示冲突；重试线程全局去重；启动失败 toast。

### B18【P1】录键器修饰键守卫失效，可保存非法加速器
- 位置：`src/lib/hotkeys.ts:180-210`（keyEventToAccelerator）。
- 路径：守卫 `['Control','Alt','Shift','Super'].includes(key)`，但 key 初始为 `e.code`——单独按 Ctrl 时 e.code='ControlLeft'，map 无此项 → 'ControlLeft' 原样通过 → **不在守卫名单** → 返回 accelerator 'ControlLeft'（组合则 'Control+ControlLeft'）→ 存盘+注册 → muda parse failed（日志已出现）。Alt/Shift/Meta 同理（AltLeft/ShiftRight/MetaLeft 全部漏过）。
- 次要：`Escape→'Esc'`、`NumpadAdd→'numadd'` 等映射名需对照 muda 合法键名（muda 为 `Escape`，'Esc' 疑似非法）；`Space`、`num0..` 同样待验证。
- 建议：守卫用 /\\^(Control|Alt|Shift|Meta|OS)(Left|Right)?$\\/；映射表对齐 muda Code 枚举；注册失败时把 parse 错误回显到设置页。

### B19【P3·一致性】日志文件名与产品名分裂
- logs/ 下同时存在 面灵AI.log（旧 productName）与 骆耀升老公酱面试助手.log（现 productName）；`cmd_read_recent_logs`（misc.rs:12）**硬编码**现名，改名后旧日志不可读；与 B2（ExamOverlay 品牌硬编码）同源——产品名/品牌缺单一常量来源。

### B20【P2】overlay 窗口无最小/最大尺寸约束
- E2E 实测：`cmd_set_overlay_size(1,1)` 后 innerWidth/innerHeight=[1,1]；(30000,30000) 亦被接受。
- 配合 B5（resize 把手无持久化/无下限）用户可把浮窗弄到不可用尺寸。官方在样式归一化层钳 120..2560，resize 持久化要求 ≥200×150。
- 建议：cmd_set_overlay_size 内钳制或 tauri.conf 加 minWidth/minHeight。

### B21【P3】cmd_os_version 返回 DisplayVersion（25H2）而非 Build 号
- misc.rs:64-98 先取 DisplayVersion 再 CurrentBuildNumber。官方 Win 低版本警告（tI）需要数值比较 CurrentBuildNumber ≥19041；营销版本名无法比较。前端若补 1.2.2 警告需改取 Build 号。

## D. 主窗口组件审查（2026-10-30）

### B22【P1·运行时已复现】jobProgress 不在原生数据白名单，打卡/进度数据永不持久化
- 位置：`src-tauri/src/data_store.rs:5-15`（KEYS 白名单无 `jobProgress`）vs `src/lib/backend.ts:63-74`（DATA_KEYS 含 `jobProgress`）。
- E2E 实测：`cmd_data_commit {key:'jobProgress'}` → `REJECTED: 未知数据集合`。
- 影响：`JobProgressCards.tsx` 的 useData('jobProgress') 写入（打卡 offer/OC 计数、lastCheckin*）每次都失败并弹「数据保存失败」toast；重启后打卡计数归零。会话结果标记（outcome 走 interviewSessions/examSessions）不受影响。
- 建议：把 jobProgress 加入原生 KEYS（对象型，注意 cmd_data_commit 的数组校验分支已豁免 localUser/interviewPreference，需同样豁免 jobProgress）。

### B23【P1·数据完整性】笔试启动产生僵尸 ACTIVE 会话（跨 webview 双建会话）
- 位置：`src/main/sections/ExamWorkbench.tsx:71`（main 窗口调 `startExamSession(goalId)` 创建会话 A）+ `src/lib/examEngine.ts`（overlay webview 有独立模块状态，sessionId=null）。
- 路径：main 的 examEngine 与 overlay 的 examEngine 是**两个 JS 上下文**，state 不共享。main 建的会话 A 永远不会被 overlay 的 `endExamSession` 完成（它完成的是自己首题时建的会话 B）。会话 A 以 ACTIVE 状态留在记录里、无任何题目，直到下次启动笔试被 `closeStaleActiveSessions` 兜底关闭。
- 复现：开始笔试 → 不解题直接退出 → 历史记录出现一条空 ACTIVE（下次启动后变 COMPLETED）笔试记录；解了题则出现一空一实两条。
- 建议：去掉 main 侧 startExamSession（会话延迟到浮窗首题创建，接受"不解题无记录"），或通过 store 把 main 建的 sessionId 传给浮窗采纳。

### B24【P2·行为误导】工作台「结束面试」不通知浮窗，留下僵尸收音
- 位置：`src/main/sections/InterviewWorkbench.tsx:90-96`（stop() 只 completeSession + 清 store 键 + showMain）。
- 路径：面试中用户从任务栏重新打开主窗口点「结束面试」→ 记录被标记 COMPLETED，但**浮窗引擎仍在聆听/作答**，后续回答继续写入这条已 COMPLETED 的记录；浮窗要靠自己的 2.6s「结束面试」或 panic 才真正停。
- 建议：stop() 应 emit 事件让浮窗走 endInterview，或直接调用与浮窗结束等价的命令序列（stop 采集+hideOverlay）。

### B25【P3】StrictMode 下启动副作用双执行
- 证据：panic 注册日志成对（B17）；`main.tsx` 用 StrictMode 包裹 + 各 useEffect 无去重 flag 的命令调用（setPanicHotkey/setActionHotkeys 等）都会双发。当前命令多为幂等，但 B17 的重试线程会被放大成两倍。

## E. 测试套件运行结果（2026-10-30）

### 静态与单测基线
- `npx tsc --noEmit`：**0 错误**。
- `cargo check`：通过；`cargo clippy`：16 条 style 级 warning（collapsible_if ×13、useless conversion ×1、manual_dangling_ptr ×1【identity_resources.rs:226 的 `PCWSTR(1usize as *const u16)` 哨兵常量，属用户模块仅记录】、其余 1）。
- `cargo test`：**48 passed / 0 failed / 1 ignored**（含并发发布、重采样精度、迁移、更新器契约测试）。
- `node --test tests/*.test.mjs`：**169 passed / 1 failed**（共 170）。

### B26【P3·CI 可移植性】updater-secrets 测试依赖 pwsh，Windows 默认没有
- 失败项：`tests/updater-secrets.test.mjs:38`（"Windows secret uploader reads newline-terminated DPAPI files..."）。
- 现象：`spawnSync('pwsh', ...)` 的 `result.status === null`（进程未启动）——本机未安装 PowerShell 7（pwsh），Windows 自带的是 powershell 5.1。
- 断言失败信息本身（expected 0, actual null）掩盖了真实原因，排障成本高。
- 建议：测试里探测 pwsh 缺失时 skip 并注明，或回退 powershell.exe；脚本本身确认兼容 5.1（ConvertFrom-SecureString 行为一致）。

### E.2 前端测试覆盖盲区（建议补充的用例）
- `interview.sessionId` 生命周期（B1 场景）：同运行期第二场面试的 resume/新建分支无测试。
- `keyEventToAccelerator`（B18）：修饰键单按/组合用例缺失——现有表没有覆盖 ControlLeft/AltRight 等 e.code。
- 样式热键合并（B4）：快速连按 opacity 丢失步进无测试。
- exam 会话跨窗口（B23）：main/overlay 双 webview 场景单测无法覆盖，需要 E2E。
- ScrollEdgePill 悬停滚动（B8）：现有 dual-screen/exam-lifecycle 测试不触及 widgets 层。
- data_store KEYS 白名单（B22）：native 层无 jobProgress 用例。

## F. spec 逐项核对衍生的确认缺陷（子代理 + 复核，2026-10-30）

### B27【P2】笔试「回答语言」设置从不进入 prompt
- 位置：`src/lib/ai.ts:95-112`（buildExamUserPrompt 参数只有 programmingLanguage/codeMode/codeQuality/customRequirements）vs `src/main/sections/ExamWorkbench.tsx:221-235`（UI 有「回答语言」四选项）+ `src/lib/examEngine.ts:138`（customizationSummary 把它显示出来）。
- 影响：用户选了回答语言，摘要里显示「答案用 en-US」，实际 prompt 里没有任何语言约束。
- 建议：customization().answerLanguage 非 auto 时注入 `用 {lang} 作答` 到 buildExamUserPrompt。

### B28【P2】capturePage 无页数上限
- 位置：`src/lib/examEngine.ts:200-220`（capturePage 直接追加 pendingScreenshots，无 maxScreenshotPages 检查）；仅 solve() 里 `shots.slice(0, maxPages)` 静默截断。
- 官方：达到上限显示「最多 {n} 页，请发送」并阻止加页（BS §4.1 Ze）。
- 影响：多截的页被静默丢弃，用户以为都发过去了。

### B29【P2】[[FOLLOWUP:]] 建议追问解析后成死数据
- 位置：`src/lib/examEngine.ts:334-340`（suggestFollowUps 写入 turn.followUpOptions）、:493（stripMarkdown 还把它剥掉）；全 UI **零渲染**（ExamOverlay/InterviewOverlay 无 followUpOptions 消费）。
- 官方：浮窗 KW 区渲染成可点击追问 chips（BS:38380）。本地模型若按协议输出建议，用户永远看不到。
- 建议：渲染 followUpOptions 为 DwellChip（与内置三项并存，去重）。

### B30【P2】一键配色缺两段确认
- 位置：`src/overlay/ExamOverlay.tsx:416-441`、`src/overlay/InterviewOverlay.tsx:720-744`（单段 dwell 1400ms 直接触发）。
- 官方：笔试 RW 悬停 1.4s → 弹「换配色」确认钮再悬停 1.2s；面试 Cq 两段 1400/1400（widgets.tsx:272 paletteConfirm=1200 定义了未用）。
- 影响：误触发配色（截屏+整窗闪烁）无法撤销（叠加 2.2.10/2.2.11 无 undo）。

### B31【P2】interviewer:utterance 事件无消费者（solver 自动接题缺失）
- 位置：`src/lib/interviewEngine.ts:373`（bus.emit）——全仓库无 `bus.on('interviewer:utterance')`。
- 官方：面试官说完触发 solver 自动追问（BS:50407-50415，<6 字忽略）；复刻的「自动接」开关也因此无意义（gap 2.3.10）。
- 建议：solver 活动会话 + 自动接开 → interviewer:utterance 自动 followUp。

### B32【P3】模拟面试录音上限 120s（官方 300s）
- 位置：`src/mock/MockApp.tsx:214`（16000*120）+ 文案「单次最多两分钟」(221)；官方 jT=300000（BS:25055）。本地转写按量计费下应可放宽到 300s。

### B33【P2】interview.solverExamMode 死键：面试内档位与笔试档位互相污染
- 位置：`src/lib/examEngine.ts:446`（setSolverMode 写 `exam.mode`）——面试浮窗 solver 换档会改掉笔试工作台的档位；官方两处独立（TC:25602 interview.solverExamMode）。store.ts:195 有键无消费。

### B34【P3】capture.experimentalSharedSurface 死键
- store.ts:215 存在，无读写方；实际生效的是 `capture.compatibilityMode`（ExamWorkbench）。官方通用页是三态文案（B:35922-35966）。清死键或补消费。

### B35【P3】main.tsx errorSink 无上限
- `src/main.tsx:38` `__errors` 数组只 push 不裁剪；长会话反复报错会无限增长。官方 400 条环形。裁剪为 400。

### B36【P2】「排除指定播放设备」功能只有读取没有写入（死功能）
- 位置：`src/lib/interviewEngine.ts:755` 读 `audio.excludedOutputs` 传给原生；全仓库**无任何 setSetting 写入该键**（原生 audio.rs:287-294 也只存内存不落盘）。
- 官方：设置里有排除设备 UI（system-audio-exclude-outputs 流程，TC PC()/ES()）。
- 影响：用户永远无法排除某个播放器（比如自己开的音乐）的声音；设置里的设备排除 UI 缺失。
- 建议：设置/工作台补设备多选 UI + setSetting + 原生持久化。

### B37（已撤销）
- 曾怀疑 cmd_hide_main 不生效；OS 级窗口枚举证明主窗（1580666）确已隐藏、可见的 48308440 是浮窗——**hide 正常**。
- 附带 P3 发现：WebView2 的 `document.visibilityState` 在 Tauri `hide()`（SW_HIDE）后仍报 'visible'（wry 未同步 controller IsVisible），隐藏的主窗继续全速跑 rAF/定时器。官方同为 Tauri 应有同样行为；如需省电可在 hide 时手动通知页面。

### B38【P3】12 个登记但无任何消费者的 store 死键
- settings.owner、exam.nativeOsd、overlay.actionHotkeysRetiredMigrated、interview.solverExamMode（→B33）、interview.turnCards（→2.3.2）、interview.voiceAskGuideDone、interview.passthroughGuideDone（→2.2.7）、onboarding.firstRunGuide、capture.experimentalSharedSurface（→B34）、exam.customizationOwner、updates.repository（端点硬编码在 tauri.conf）、mac.screenShareNoticeDismissed。
- 建议：要么接线（见对应差距项），要么删除登记避免「看起来支持」。
