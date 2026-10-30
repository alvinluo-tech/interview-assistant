# 全量差距分析：复刻版 vs 官方 0.3.16（持续更新）

> 方法：以 `_recon/spec/00-05.md`（约 235KB 逆向规格）为权威清单，逐项对照本仓库 `src/`、`src-tauri/src/` 实现。
> 每一项给出：官方行为（spec 出处）→ 复刻现状（文件:行）→ 判定（✅ 对齐 / ⚠️ 部分 / ❌ 缺失 / 🔵 有意不做）→ 借鉴建议与优先级。
> 与 `docs/original-app-gap-analysis.md`（能力质量视角）、`docs/gap-2026-10-28.md`（16 项总表）互补；本文是**逐功能全量清单**，粒度到控件/交互/文案级。
> 比对基线：官方 `original-app/app.exe` 0.3.16（**UI 热补丁已更新至 0.3.16-h13**，2026-10-30 下发；h5→h13 全量语义 diff 见第 0 章，提取件 `_recon/frontend-h13/`）；复刻仓库当前工作区（2026-10-30）。
> 规模：6 章约 90 个对照点，覆盖 spec 00-05 全部功能面 + 42 个原生命令 + emit 事件 + store 键 + mac 端能力；配套 bug 清单见 [bug-findings.md](bug-findings.md)（38 条）。


## 第 0 章 热补丁基线更新：h5 → h13（2026-10-30 重新逆向）

原生 exe 未变（0.3.16，2026-10-27 10:46，22,418,376 字节）；UI 热补丁从 h5 连续更新到 h13（本机 hotpatch/versions 保留 h7/h8/h9/h10/h11/h13，current.json → 0.3.16-h13）。
方法：git diff --no-index -U3 对 h5/h13 两个美化 bundle（tauri-cmds 27k 行、bootstrap 54k 行）做 unified diff，再按「混淆重命名归一化」过滤（semantic diff：tauri-cmds 269 对、bootstrap 1125 对，纯新增 178+523 行，中文纯删除 0 行——**无功能被移除，全部为新增/重构**）。

### 0.1 h6→h13 官方 changelog 全录（tauri-cmds h13 行 19041-19174）

| 日期 | 类型 | 内容 | 对复刻的意义 |
|---|---|---|---|
| 10-26 | fixed | 一题一卡模式下，同一题里面试官接着追问，浮窗会翻到新的这一句 | turnCards 行为规则（若补 2.3.2 必须实现） |
| 10-26 | fixed | 一题一卡模式下往回翻看时，答完一题不会再把浮窗拽走 | turnCards 行为规则：用户回看中不自动跳最新卡 |
| 10-27 | improved | 笔试图形推理题换新一代看图模型 | 🔵 服务端模型升级 |
| 10-27 | fixed | 鼠标停在浮窗按钮上不动时不会再自己触发，语音提问不会被提前结束 | **已含在 0.3.16 exe 基线**（exe mtime 10/27 10:46）；KT hook h5/h13 逐行一致，复刻已实现同款「一次性触发+冷却+离开重进」语义 |
| 10-27 | fixed | 原生笔试窗口部分网络连不上自动换线路（requires: native-exam-window-fallback，win） | 原生 OSD（4.6）新增要求：多线路重试 |
| 10-27 | fixed | 原生笔试窗口跟随界面语言（requires: native-exam-window-i18n，win） | 原生 OSD（4.6）新增要求：i18n |
| 10-28 | improved/fixed | 副屏光标大小可调 / 防双指缩放（exam-dual-screen，china） | 手机副屏网页端（4.7） |
| 10-28 | improved | 面试中截屏解过的题，追问时语音回答能接上 | ✅ 复刻已有（solverMemoryBlock，interviewEngine.ts:572） |
| 10-28 | fixed | 声纹注册没收到足够声音时不再保存不可靠声纹 | 🔵 云端声纹；getUserMedia 约束可借鉴（0.2.4） |
| 10-29 | **new** | **面试剩 5 分钟时浮窗出现「续时」，微信扫码付完接着面**（china） | 新功能，见 0.2.1 |
| 10-29 | fixed | 面试中途买了时长，这一场不再按原时间断开 | 续时配套：付款后重拉 expiresAt 续倒计时 |
| 10-30 | improved | 被问到资料没写的工具和项目数据，回答直接给出答案不再绕开 | **可借鉴**：system prompt 行为约定，见 0.2.6 |
| 10-30 | improved | 资料没写的工具/项目数据/薪资/家庭情况，按经历补成具体答案不再回避 | **可借鉴**：同上 |

### 0.2 代码级新功能清单（bootstrap/tauri-cmds h13 证据）

| # | 功能 | 官方实现（h13 行号） | 对复刻的建议 | 优先级 |
|---|---|---|---|---|
| 0.2.1 | **面试续时（renew）** | 门控 `active && !session.isTrial && 0 < remainingSec <= 300 && !hasQuota`（bootstrap 52870，At=`VU(asset)` Pro 判定）；头部「续时」按钮（51151-51157，悬停 1400ms，zoneId `iv-renew`）；RenewCard 状态机 `pick→creating→pay→paid/error`（52275-52437）：`pay.createOrder.mutate({id, channel:wxpay, from:desktop-interview-renew})` → `{checkoutUrl, orderNumber}` → 104px 白底二维码 → **每 2s 轮询 `pay.checkOrderStatus`** 至 `PAID` → 「已到账，这一场续上了」3s 自动收起 → onPaid 重拉 sessionStatus 续 expiresAt；错误态「去浏览器付款」（hint「会打开浏览器，共享屏幕时对方看得到」，开 `desktop-interview-renew` 外链）；套餐文案「¥{price/100} · {n} 分钟 / {n} 天不限时」，固定三档 | 🔵 支付是云端能力，本地版不实现；**可借鉴 UI 模式**：会话临近结束的浮窗内引导（本地版可做无支付提示条） | P3 |
| 0.2.2 | **音频探针（audio probe）** | `session.reportAudioProbe`（h13 新增，h5=0）：每秒统计 sys/mic 两组 {sec, loudSec(≥15), quietSec(3-14), peak(0-1000)}，mic 状态机 `off/starting/on/unavailable`+error，`micLoudSysSilentSec`（麦响系统静自检），第 10s 首报、之后每 60s（bootstrap 49174-49249） | 借鉴为本地诊断：复刻 AudioInputFeedback 可加自动判定——micLoudSysSilent → 「听到你的麦克风但没听到系统声音，请检查会议软件扬声器」 | P2 |
| 0.2.3 | 麦克风检测空文案 | 「没收到足够的声音。请确认系统默认麦克风是你正对着说话的那支，靠近一些再重试」（49143 empty case） | MicrophoneCheck 文案对齐 | P3 |
| 0.2.4 | 声纹注册 noVoice | 45s 内有效发声不足（enroll 6s/verify 2.5s，阈值 15/800）→ 不提交，`voiceprint.noVoice` + error 态；getUserMedia 显式约束（16k/mono/echoCancellation:false/noiseSuppression:true/autoGainControl:true）；错误全 i18n（uploadFailed/submitFailed/micDenied/recordFailed/noVoice）（35498-35601） | 🔵 无声纹体系；getUserMedia 约束借鉴到 microphone.ts（当前未显式关回声消除） | P3 |
| 0.2.5 | 面试引擎错误文案 i18n | `interview.connectFailed` / `interview.startFailed` / `interview.noAudioPermission`（49568 区） | interviewEngine 的 errorMessage 对齐这三条 | P3 |
| 0.2.6 | **回答风格：不回避未知** | changelog 10-30 两条 improved：资料未覆盖的工具/项目数据/薪资/家庭 → 按经历补成具体答案、直接回答不绕开 | **直接可借鉴**：加进 buildInterviewSystemPrompt（ai.ts）——「资料未提及的工具、项目数据、薪资、家庭情况，按用户经历合理补全具体内容直接回答，不要回避或说资料里没有」 | **P2** |
| 0.2.7 | turnCards 行为规则 | 10-26 两条 fixed：同一题内追问→翻到新卡；回看历史卡时答完不跳最新卡 | 补 2.3.2 时的两条必做规则；复刻的自动跳最新卡要加「用户回看中」抑制 | P2（挂 2.3.2） |
| 0.2.8 | 副端 aria | 「副端」标记加 aria-label（51136-51142） | 复刻无副端概念 | 🔵 |
| 0.2.9 | 新能力门控名 | native-exam-window-fallback / native-exam-window-i18n | 记入 4.6 原生 OSD 验收要求 | 记录 |
| 0.2.10 | 商业套餐表扩充 | 网申月卡/季卡、求职早报、畅享周卡、求职季无限卡等（52097 区） | 🔵 商业能力 | 🔵 |
| 0.2.11 | i18n 全语种补齐 | 续时/支付/声纹等 9 语种新翻译（tauri-cmds diff 大头） | 复刻 i18n 扩展时注意新 key | 记录 |
| 0.2.12 | 内部重构（无用户可见变化） | 面试引擎 hook 化（beginInterview/syncExpiry/endSentence/forceSend/prewarmManualAnswer/correctAndResend/feedInterviewerUtterance/canForceSend API 面 + interview.started/serviceStatus 事件）、turn 槽位重组器（claimTurn/drain）、录音分片 16ms 批 flush、answerSlot 与复盘录音（enableReplay metadata 门控 LK） | 架构参考；复刻 interviewEngine 已覆盖同等功能面 | 记录 |

### 0.3 复刻行动项汇总（h13 增量）

1. **P2**：buildInterviewSystemPrompt 增加「不回避未知」行为约定（0.2.6）——成本一行，回答风格与官方 10-30 后一致。
2. **P2**：AudioInputFeedback 增加 micLoudSysSilent 自动判定（0.2.2 简化版：本地已有双路音量，直接比对）。
3. **P2（挂靠）**：turnCards UI（gap 2.3.2）实现时带上 10-26 两条行为规则（0.2.7）。
4. **P3**：microphone.ts 的 getUserMedia 显式约束（关回声消除）；interviewEngine 三条错误文案对齐（0.2.4/0.2.5）。
5. **记录**：续时/声纹/副屏网页细节为云端或平台能力，本地版不实现；原生 OSD 若做，验收含 fallback + i18n。

---

## 状态图例

- ✅ 已对齐（行为等价）
- ⚠️ 部分（有实现但缺分支/文案/边界）
- ❌ 缺失（官方有、复刻没有，值得借鉴）
- 🔵 有意不做（依赖官方云服务/商业能力，BYOK 本地版不适用——仍列出保持完整）

优先级：P0=核心体验断点；P1=明显功能差距；P2=打磨；P3=记录在案。

---

## 第 1 章 应用外壳与页面（spec 01）

### 1.1 启动与崩溃自愈

| # | 项 | 官方行为 | 复刻现状 | 判定 | 建议/优先级 |
|---|---|---|---|---|---|
| 1.1.1 | 启动失败兜底 UI | main 场景动态 import 失败 → `#root` 渲染「出了点问题」+「重新加载」按钮；overlay 保持透明（IDX §1） | main.tsx 有 ErrorBoundary，但**模块级 import 失败（白屏）无兜底 UI**；overlay 无「保持透明」专项处理 | ⚠️ | main 入口加 `<script>` 级失败兜底（bootstrap 动态加载 + 超时/错误渲染重试按钮）；P2 |
| 1.1.2 | 控制台环形缓冲 | 拦截 console.error/warn/info 存 400 条（单条 1000 字），随错误上报带 logTail | 无 console 缓冲；错误只进 ErrorBoundary/引擎 errorMessage | ❌ | 本地诊断有价值：环形缓冲写入本地日志文件，错误报告附带；P2 |
| 1.1.3 | 全局错误捕获上报 | window.error/unhandledrejection → telemetry（每会话 10 条上限、去重、脱敏） | main.tsx:44-48 已注册两者 → `window.__errors`；❌ 无上限裁剪（官方 400 条环形）、无脱敏/去重、不落盘 | ⚠️ | 加 400 条上限+落盘；P3 |
| 1.1.4 | 崩溃恢复握手 | `cmd_is_crash_recovery` → 等 `overlay-session-ready` 15s → 成功 show / 失败 `release_session_if_not_ready` + `minimize_main`（IDX §1.8） | overlay.rs 有 heartbeat 监视 + webview-dead 事件；**main 启动时无 is_crash_recovery 查询与 15s 握手**（misc.rs 恢复状态为存根） | ⚠️ | 补握手闭环：main 查询恢复态 → show_overlay → 等 ready → 失败 minimize；P1 |
| 1.1.5 | webview 崩溃补报 | 启动时 `cmd_take_webview_crashes` 批量读上次崩溃记录 | 无持久化崩溃记录；webview-dead 只隐藏浮窗 | ⚠️ | overlay.rs 心跳超时写崩溃标记文件，main 启动读取并展示「浮窗异常已自动收起」横幅（见 1.2.4）；P1 |
| 1.1.6 | overlay 渲染崩溃自愈 | ErrorBoundary：上报 → 自动 reload 一次（sessionStorage 防循环）→ 再失败渲染一行兜底文案「界面出了点问题。关掉助手再打开即可继续这场面试。」 | ErrorBoundary.tsx 有兜底 UI，但**未见自动 reload 一次的防循环逻辑** | ⚠️ | 加 sessionStorage 标记自动 reload；P2 |
| 1.1.7 | 热补丁 hotpatch 体系 | current.json→versions/<ver>/ui 优先加载；双源 webstate 迁移；坏补丁隔离+上报；版本握手 nudge | ❌ 无（gap-2026-10-28 #9，P1 计划中） | ❌ | 同目录结构实现；P1（可后置） |

### 1.2 主窗口布局与弹层

| # | 项 | 官方行为 | 复刻现状 | 判定 | 建议/优先级 |
|---|---|---|---|---|---|
| 1.2.1 | 自定义标题栏 | h-8 drag-region + min/max/close；**关闭=退出进程**（`plugin:process\|exit`），mac 无此栏 | MainWindow 有标题栏；关闭行为需核对（是否 exit 进程 vs 隐藏） | ⚠️ | 核对关闭按钮：官方语义是直接退出；P1 核对 |
| 1.2.2 | Win 低版本截屏警告 | 内部版本 <19041 → 红框「你的系统版本较低，屏幕共享时浮窗可能藏不住」+ 当前 build 号 | ❌ 无此警告（protection.rs 的能力检测有 build 概念但前端未提示） | ❌ | capabilities.rs 已有检测，前端补横幅；P2 |
| 1.2.3 | Mac 共享屏幕提示 | 琥珀框 + 文档链接 + 不再提示 | 🔵 Windows-only 复刻 | 🔵 | — |
| 1.2.4 | 浮窗异常横幅 | 监听 `overlay-webview-dead` → 「悬浮窗出现异常已自动收起…」+「知道了」 | MainWindow.tsx:99-103 toast 已实现（文案一致）；样式为 toast 非横幅 | ✅ | — |
| 1.2.5 | 启动页 | spinner + 品牌名 + 「启动中…」+ v{version} | 未见启动 loading 页 | ⚠️ | P3 |
| 1.2.6 | 公告条 | announcement.getActive 每 5 分钟轮询 → 琥珀横幅 | 🔵 无云端公告（本地版可留空） | 🔵 | — |
| 1.2.7 | 会话评分弹层 | sessionRating.pending 轮询 → 打分+评语 | 🔵 云端评分不适用；本地可在面试结束后弹「本场满意度」进历史记录 | 🔵/⚠️ | 可选本地化；P3 |
| 1.2.8 | 反馈系统 | 侧边栏反馈入口+未读徽章+三态对话框 | FeedbackDialog 有（本地存储） | ✅（本地版） | — |
| 1.2.9 | 账号菜单/登录页 | 网页一键登录、token 双存储、刷新策略、退出登录 | 🔵 本地身份（LocalProfileDialog）；BYOK 无需登录 | 🔵 | — |
| 1.2.10 | 侧边栏额度卡 | Pro 无限/{n} 分钟+去充值 | 🔵 无计费 | 🔵 | — |
| 1.2.11 | 托盘 | 托盘单击唤回浮窗/主窗口；会话中点击打开反馈（changelog 能力 tray-click-*） | ❌ **无托盘**（tauri.conf 无 tray 配置；Rust 侧无 tray 实现） | ❌ | tauri tray：单击唤回浮窗、菜单（显示主窗/退出）；P1——面试中主窗隐藏+浮窗异常时是唯一入口 |
| 1.2.12 | 更新 UI 六层 | mustUpdate 阻断/已装待重启/热补丁就绪/stale 功能提示/崩溃修复横幅/普通 toast（各自 localStorage 记忆键） | UpdateNotice.tsx 有检查+下载入口；六层互斥与记忆键需核对 | ⚠️ | 核对每层与 localStorage 记忆键；P2 |
| 1.2.13 | 求职回访卡 | followUp 卡 + checkin 卡 + 未过推广卡 | JobProgressCards.tsx 已补（回访/打卡/推广，本地数据驱动） | ✅ | 推广卡跳转官网链接保留 |

### 1.3 会话启动流

| # | 项 | 官方行为 | 复刻现状 | 判定 | 建议/优先级 |
|---|---|---|---|---|---|
| 1.3.1 | 启动序列 | set_session_active → 存样式/mode → show_overlay → 400ms 后 hide_main；失败 toast「启动失败 @{step}」+ hide_overlay 回滚 | InterviewWorkbench/ExamWorkbench 启动流；失败回滚与分步错误文案待核 | ⚠️ | 核对失败分支；P2 |
| 1.3.2 | 自动打开演示壳 | `interview.autoOpenMockShell`（默认 true）→ 打开 `www.mianlingai.com/desktop/mock-exam\|mock-interview` 演示页（首次 ?guide=1） | store 有键（onboarding 引导用了 mock 场景）；**开始真实面试后是否自动打开演示页**未见 | ⚠️ | 本地版可打开内置 mock 窗口（#mock 场景）而非外链；P2 |
| 1.3.3 | panic 闲置自动重启 | panic-hotkey-idle → UI 提示并可快速重开 | MainWindow.tsx:104-111 idle toast 已实现（提示文案，无一键重开）；panic 二按恢复浮窗为本地扩展 | ⚠️ | 补一键重开；P3 |

### 1.4 引导与须知

| # | 项 | 官方行为 | 复刻现状 | 判定 | 建议/优先级 |
|---|---|---|---|---|---|
| 1.4.1 | 使用须知弹窗 | 首次强制弹（5 秒倒计时按钮）+ 禁考列表 + 协议链接 | UsageNotice.tsx 有（usageAcknowledged.v2） | ✅ | 文案细节需对照（禁考列表是否齐全）；P3 |
| 1.4.2 | 首次引导向导 | 3 步（简历→岗位→体验），suggestFromResume 自动填岗位，cleanupDefaultData 清示例数据 | Onboarding.tsx 有 3 步；**体验步骤选「笔试」直接拉起浮窗** 的闭环待核 | ⚠️ | 核对 step3 双卡片启动闭环；P2 |

### 1.5 设置页结构

| # | 项 | 官方行为 | 复刻现状 | 判定 | 建议/优先级 |
|---|---|---|---|---|---|
| 1.5.1 | 子导航六页 | 浮窗样式/通用/快捷键/隐蔽/更新日志/关于 | SettingsPage 有（含 AiServices/Stealth 等）；**更新日志页**（changelog 全量列表）待核 | ⚠️ | ChangelogDialog 有弹窗，设置页内嵌列表待核；P3 |
| 1.5.2 | 界面语言 | 9 语种、切换→整窗 reload 广播、跟随系统、展开收起 | i18n.ts 有 zh/en/zh-tw 等；切换 reload 流待核 | ⚠️ | spec 01 §7；P2 |
| 1.5.3 | 界面缩放 | Ctrl/⌘ +/-/0 调 `desktop.uiScale`（html zoom），30%-400%，恢复默认 100%；重新聚焦窗口 | ✅ slider+zoom 已实现（SettingsPage GeneralTab:100-107,187）；❌ 缺 Ctrl/⌘ +/-/0 键盘快捷键 | ⚠️ | 补键盘快捷键；P3 |
| 1.5.4 | 外观主题 | 主窗口 跟随系统/浅色/深色（localStorage desktop.theme），与浮窗主题独立 | 待核（主窗口暗色） | ⚠️ | P3 |

### 1.6 隐蔽页（spec 01 §3.3）

| # | 项 | 官方行为 | 复刻现状 | 判定 | 建议/优先级 |
|---|---|---|---|---|---|
| 1.6.1 | 进程伪装预设 | 4 预设（UpdateService/软件更新服务、AudioService/音频服务、CloudSync/云同步助手、DocViewer/文档查看器）+自定义（NFKD 清洗 ≤40）；改进程名需重启 | StealthTab + 用户加的 disguise.rs；预设清单与重启提示需核对 | ⚠️ | 核对文案与四预设；P2 |
| 1.6.2 | 收起浮窗不回任务栏 | `stealth.hideFromTaskbar`：hide_main 时同时 skipTaskbar | store 有键；misc.rs hide 时是否 skipTaskbar 待核 | ⚠️ | P2 |
| 1.6.3 | 演示可见模式 | 临时可见、不持久化、重启恢复隐身；读态失败琥珀警告 | ❌ 无 demo-visible 能力 | ❌ | protection.rs 可加「临时取消捕获排除」开关（重启还原）；P2 |

### 1.7 更新与关于

| # | 项 | 官方行为 | 复刻现状 | 判定 | 建议/优先级 |
|---|---|---|---|---|---|
| 1.7.1 | 自更新状态机 | idle→downloading(progress)→ready→installing→failed；sha256+平台后缀校验；会话中不启动；ready 自动重试 3 次 | updater.rs 17KB + update_install.rs；状态机与校验细节待核 | ⚠️ | 对照 §6.2 全量核对；P2 |
| 1.7.2 | 更新检查频率 | 启动即查 + 每 1h + focus（≥10min） | updateCheck.ts 频率待核 | ⚠️ | P3 |
| 1.7.3 | About 版本三行 | 客户端版本/界面版本（热补丁）/系统版本 | 待核 | ⚠️ | P3 |
| 1.7.4 | Changelog 弹窗 | 内置 100+ 条 entries；水位 seenDate、能力/地区/平台过滤、auto 弹、snooze 当天；设置页手动入口无 snooze | ChangelogDialog.tsx 有；entries 数量/过滤/snooze 待核 | ⚠️ | P3 |

---

## 第 2 章 悬浮窗（spec 02）

### 2.1 会话根与生命周期（mJ）

| # | 项 | 官方行为 | 复刻现状 | 判定 | 建议/优先级 |
|---|---|---|---|---|---|
| 2.1.1 | 心跳 5s + showSeq 幂等 + 启动查询 | mJ：heartbeat 5s；overlay-shown(seq) 幂等（`seq.current>=i return`）；启动查 `overlay_show_seq` 恢复 | OverlayApp.tsx:33-71 全对齐 | ✅ | — |
| 2.1.2 | overlay-hidden 语义 | 仅 `active:false`（卸载 UI），**不结束会话**——panic 隐藏后可再显示恢复 | OverlayApp.tsx:49-52 收到 hidden 即 `endInterview(false)`——**panic/临时隐藏也会终止面试会话** | ⚠️ | 改为仅卸载：hidden 不 end；恢复显示时走 resumeInterviewSession（已有）；P1（panic 语义） |
| 2.1.3 | 模式路由四视图 | exam/interview/preview/interview-preview，key=`${mode}-${seq}` | OverlayApp.tsx:117-129 对齐（preview 恒 interactive） | ✅ | — |
| 2.1.4 | 尺寸同步 | 挂载即 set_overlay_size（差 <3px 跳过）；**resize 把手拖完 500ms 防抖、≥200×150 才持久化回 style** | OverlayApp.tsx:88-97 前半✅；**onResized 监听+防抖持久化缺失**（platform startResize 有，拖完不保存） | ❌ | MainWindow/platform 加 onResized → 防抖 500ms → ≥200×150 → 写 interview/examWidth/Height；P1 |
| 2.1.5 | 位置恢复 | `overlay.position` → `dK` **钳制在 workArea 内** → position_overlay | OverlayApp.tsx:133-142 **无钳制**——换分辨率/拔显示器后浮窗可能在屏幕外 | ⚠️ | restorePosition 加 monitor workArea 钳制；P1 |
| 2.1.6 | 键盘移动 | 按住持续移动：30ms 步进 30px、首步 48px、**多键矢量和**、松开 400ms 防抖持久化 | OverlayApp.tsx:220-250：按一次走 12 步（≈0.36s）即停；无按住持续、无矢量合成 | ⚠️ | native 侧已有 key state（action-hotkeys pressed）可做持续移动循环；P2 |
| 2.1.7 | 样式热键串行队列 | XE：串行队列读最新→合并→存→emit `overlay-style-hotkey-patch`（设置页实时刷新） | OverlayApp.tsx:145-214：**闭包捕获 style，快速连按丢失更新**（两次按键都基于旧 style 合并）；emit 有 | ⚠️ | 用 setSetting 函数式更新或 ref 读最新 style；P1 竞态 |
| 2.1.8 | 尺寸快捷键 | ×1.1 且夹在 min/max 内 | clampDim(120..2560) ✅ | ✅ | — |

### 2.2 Provider/zones/驻留（TD/ED/DD/KT）

| # | 项 | 官方行为 | 复刻现状 | 判定 | 建议/优先级 |
|---|---|---|---|---|---|
| 2.2.1 | interview.interactive 双模式 | 读键默认 false=穿透；toggle→原生+持久化 | platform.tsx:56-72 对齐 | ✅ | — |
| 2.2.2 | 笔试恒穿透 | DD：interactive 恒 false、无 toggle | platform.tsx:58 isExam→false ✅ | ✅ | — |
| 2.2.3 | zones 扫描 | 350ms、外扩 4px、JSON 去重、**非穿透清空**、dpr 换算 | platform.tsx:74-117 对齐（含副屏接管抑制） | ✅ | — |
| 2.2.4 | dwell 触发/冷却 | 触发后 cooldown 800ms，同一次悬停只触发一次 | platform.tsx:223-274 语义等价（触发后 triggeredRef 挡住，离开复位） | ✅ | — |
| 2.2.5 | tooltip 皮肤化 | QL：inOverlay 时 pillBg/textColor/outerBorderColor/shadow + `--foreground` | 浮窗内全部用原生 title（系统灰），**无皮肤化 tooltip** | ❌ | 自绘 tooltip 组件（皮肤色）；P2（观感） |
| 2.2.6 | 面试头部「穿透切换」yq | 穿透态：**悬停 2200ms**（或窗口态点击）切换；tooltip「悬停或点击切到穿透模式（反监考）」 | InterviewOverlay.tsx:184-192 **只有 onClick，无 useDwell**——**穿透模式下该按钮悬停无反应、点击收不到 → 无法从浮窗切回窗口模式**（HOVER_MS.switchInteractive 定义了但从未使用） | ❌ | 加 `useDwell('iv-mode', 2200, toggleInteractive, {disabled: interactive})`；**P0**（用户点名的穿透交互缺口） |
| 2.2.7 | 穿透提示 Tq | 首次进穿透态且未读 `interview.passthroughGuideDone` → 提示条「鼠标点不到浮窗是正常的：光标停在按钮上不动，进度条走满即触发」+「窗口模式」+「知道了」 | ❌ 无此提示（store 有 passthroughGuideDone 键但浮窗未消费） | ❌ | 面试浮窗首次穿透态显示引导条；**P0**（新手在穿透态会完全不知道怎么操作） |
| 2.2.8 | 首跑引导 XW/ZW | 每模式首次：步骤列表「第一次用，跟着做两步」+「把光标停在下方「解题」上 1.2 秒…」+ footnote「浮窗点不到是正常的…」 | ❌ 浮窗内无首跑引导 | ❌ | P1（配合 2.2.7） |
| 2.2.9 | 配色失败 toast fG | 顶部 toast：「截不到浮窗后面的画面，这次没换配色」/「配色没生成出来…」/「还没用过一键配色，没有可以恢复的配色」 | applyPalette/applyIvPalette 失败**静默 catch**，无任何提示 | ❌ | 补三个失败文案 toast；P1 |
| 2.2.10 | 一键配色算法 | 临时 bgOpacity→0 → 2 帧+60ms → 整窗隐藏截屏 → **按浮窗周边区域裁剪**（外扩 10%、≤512px、JPEG .8）→ 服务端建议 → 应用时「底色/文字只比原来更淡」（min 合并）→ undo 写入 `overlay.autoPaletteUndo`（相同则合并 before） | ExamOverlay/InterviewOverlay `applyPalette`：整屏缩到 64px **平均成一个颜色**（浮窗自身与全桌面都参与，易被任务栏/深色窗口污染）；无裁剪、无 min 合并、无 undo | ⚠️ | 至少：按窗口矩形周边裁剪+主色调提取（非全屏平均）+undo 键；P1 |
| 2.2.11 | 恢复配色 | 快捷键 `restore-palette` + 设置页按钮「恢复一键配色之前的样子」 | ❌ 无 undo 恢复 | ❌ | P2 |

### 2.3 面试浮窗（Yq）

| # | 项 | 官方行为 | 复刻现状 | 判定 | 建议/优先级 |
|---|---|---|---|---|---|
| 2.3.1 | 头部结构 | 拖拽(0.9s)/状态点+文案/副端标记/页码 n/N/剩余时长 mm:ss/语言切换/一键配色(两段)/穿透切换/结束(2600ms) | InterviewOverlay.tsx:179-205：拖拽/状态/穿透切换/配色/结束✅；**副端标记、页码、剩余时长、语言切换缺** | ⚠️ | 剩余时长可用本地会话时长上限；语言切换见 2.3.8；P2 |
| 2.3.2 | turnCards 卡片轮换 | turnKind NEW/CONT/SKIP 分卡 + 上一题/下一题 edges + 头部 n/N + 新卡自动跳 | ❌ store 有 `interview.turnCards` 键，浮窗**无分卡 UI**（audit 确认 InterviewOverlay 无 turnKind 消费） | ❌ | 引擎消息加 turnKind 元数据 + ChatView 分卡；P1 |
| 2.3.3 | 回合分组/排序 | newestFirst 组倒序 + answerFirst 组内倒序（仅 newestFirst 时生效） | ChatView:380-388 语义一致 | ✅ | — |
| 2.3.4 | 不确定句 dq | 说话人无法确认的句子：虚线左边框 + 「没能确认这句是谁说的，所以没有自动回答。是面试官问的就点「立即回答」」 | ❌ 引擎无 uncertainSentence 概念（复刻的 partial/liveTranscripts 是「未定稿」语义） | ❌ | 引擎对低置信段给 uncertain 标记 + 专属文案；P2 |
| 2.3.5 | 「识别有误」修正 | 转写气泡右侧 icon 按钮 → correctAndResend（tooltip「识别有误？一键让 AI 按正确题意重答」） | 引擎支持（answerQuestion correction 参数，interviewEngine.ts:415,458），**ChatView 未渲染按钮** | ❌ | INTERVIEWER 气泡加修正按钮；P1 |
| 2.3.6 | 滚动跟随 | followNewRound=false 时不跟随；手动上滚解除跟随；followStreaming 锚点底部超界才追加滚动 | ChatView:358-377：**followNewRound=false 时仍然每次滚到底**（else 分支 scrollTop=scrollHeight）；无手动上滚解除 | ⚠️ | else 分支应不滚动；加 scroll 监听解除跟随；P1 |
| 2.3.7 | 边缘悬停滚动 | 光标停在边缘 pill → 1s 内 3→9px/帧加速 ×scrollSpeed 连续滚动；停住且到头 700ms → 触发 edge 动作 | ScrollEdgePill（widgets.tsx:186-235）：**热键按住才滚动**；pill 无 useDwell/无悬停滚动；速度恒 9px/帧、**忽略 scrollSpeed 设置**、无 700ms 到头触发 | ⚠️ | pill 加 hover 驱动连续滚动 + 速度曲线 + scrollSpeed；P1 |
| 2.3.8 | 语言切换 | 会话中切换作答语言：`interview.setLang {lang}` 8s 超时；错误文案 langSwitchOffline/Timeout/Failed | ❌ 无 | ❌ | 本地版：切换后写入 system prompt 参数即可；P2 |
| 2.3.9 | 结束流程 | completeSession 重试 3×400ms → 停音频/断 socket/清 sessionId → hide → 恢复主窗（workbench-recall） | EndButton→endInterview(true)→setSessionActive(false)→hideOverlay→showMain；重试细节在 engine | ⚠️ | 核对 endInterview 重试；P3 |
| 2.3.10 | solver 底栏 | 返回对话（badge=离屏新答数）/重新截屏/加页/停止\|接住追问/档位/详解\|换解法\|优化/自动接·开关/语音追问 | SolverActions: 返回对话(无 badge)/重新截屏/发送\|加页/接住追问/档位/详解/换解法/优化✅；**无「停止」、无「自动接」开关、无语音追问** | ⚠️ | 补停止（中断流）、自动接开关（本地语义：solver 答完自动把结论接进对话）、solver 页 VoiceAskRow；P1 |
| 2.3.11 | solver 视图 | reasoning 折叠块（思考中 max-h-12 滚动/已思考 {n}s）+ 状态行 + 代码块追加「继续简化/检查我抄的代码」 | SolverView: 无 reasoning 块、无代码块追加按钮 | ⚠️ | P2 |
| 2.3.12 | 「优化」语义 | 官方内置三项=详解/换解法/**优化**（prompt「请优化上面的代码…」）；继续简化是笔试浮窗的独立 intent | sv-fu3「优化」→ intent 'simplify'（=官方「继续简化」），与笔试浮窗 fu-simplify 重复 | ⚠️ | 优化应用独立 prompt「请优化上面的代码，提升效率，同时保持可读性」；P2 |
| 2.3.13 | 接住追问 | 把 AI 刚答的作为回应接进对话（hotkey answer） | ✅ followUp 拼接（InterviewOverlay.tsx:561-572） | ✅ | — |
| 2.3.14 | 告警条 | Oq AI 不可用/Eq 采集失败（带 msg）/Dq 无声（「没有听到电脑里的声音，请确认会议软件的扬声器与系统默认输出设备是同一个」） | AudioInputFeedback 自定义面板（含「尚未收到音频数据」）+errorMessage 条 | ⚠️ | Dq 无声判定（长时间 0 音量）专属文案；P2 |
| 2.3.15 | 空态文案 | fq：正在聆听面试官/点下方「开始」进入聆听/正在连接面试会话…+ 描述「面试官的问题和 AI 答案会出现在这里」 | ChatView:394-408 大体对齐 | ✅ | — |

### 2.4 笔试浮窗（gJ/tG）

| # | 项 | 官方行为 | 复刻现状 | 判定 | 建议/优先级 |
|---|---|---|---|---|---|
| 2.4.1 | 顶栏 | AW(1s)/**品牌名「面灵AI」**/题号 ‹n/N›/状态+计时/模式徽标/额度徽标/一键配色 | ExamOverlay.tsx:168-179 有除题号外全部；**品牌名硬编码「骆耀升老公酱面试助手」**（169 行） | ❌ | 换回「面灵AI」或读配置；**P0**（每场笔试可见的错误文案） |
| 2.4.2 | 直接答 answerNow | solving 时出现「直接答 悬停0.8s」让 AI 提前收尾 | ❌ UI 无此按钮（examEngine 是否有能力待核） | ❌ | P1 |
| 2.4.3 | 语音追问 | chips 行「语音追问/结束并追问」1800ms + 底部 voiceAskMessage 行 | ❌ 笔试浮窗完全无语音追问 | ❌ | 复用 VoiceAskRow；P1 |
| 2.4.4 | 复制反馈 | 「已复制代码（{n} 行）」/「已复制答案文字（{n} 字）」/「复制失败，请再按一次」/「答案还没写完，写完再复制」 | copy() 静默成功/失败，无提示 | ⚠️ | 加状态行；P2 |
| 2.4.5 | 降低通过率 | 追问 chip「降低通过率」等级 1..4（80/60/40/20% ≈{n}%） | examEngine 支持 partial-pass intent，**UI 无 chip** | ⚠️ | 补 chip；P2 |
| 2.4.6 | 题号导航 | 多题时 ‹ n/N ›（600ms/步） | ❌ 无（多回合全部平铺） | ⚠️ | P3 |
| 2.4.7 | 超时 | 截屏 12s（「截屏超时…」）/solve 30s；解题期间每 2s 检查断线重连 | capture/solve 无超时（本地 AI 无 WS，但截屏可能挂起） | ⚠️ | capture 加 12s 超时；P2 |
| 2.4.8 | 首跑引导 | 每模式首跑步骤引导 | ❌ 同 2.2.8 | ❌ | P1 |
| 2.4.9 | 追问前缀 | `> {label}\n\n` 拼进文本流 | ExamOverlay.tsx:209-216 解析 `> ` 前缀显示 | ✅ | — |
| 2.4.10 | 重置世代号 | abort 用世代号作废旧流（防旧流覆盖新流） | examEngine abortSolve（世代号机制待核，audit 有 generation 匹配） | ⚠️ | 核对；P2 |
| 2.4.11 | 退出流 | bye→abort→completeSession→disconnect→hide→（relaunch ? show_main : recall） | endExamSession(false)（engine 待核 showMain） | ⚠️ | 核对；P2 |

### 2.5 样式系统（overlay.style/skin/CSS）

| # | 项 | 官方行为 | 复刻现状 | 判定 | 建议/优先级 |
|---|---|---|---|---|---|
| 2.5.1 | 字段与限制 | 16 字段默认/范围/归一化（Q/kb） | overlayStyle.ts normalizeStyle | ⚠️ | 抽查边界（fontScale 0.3..4、scrollSpeed 0.05..5、hotkeyOpacityStep 0.01..1）；P3 |
| 2.5.2 | 皮肤公式 | light/dark 系数表 + ey(t)=min(1,t/0.2) 透明衰减 + halo 强度 ty(t) | computeSkin（overlayStyle.ts） | ⚠️ | 抽查系数与 ey/ty；P3 |
| 2.5.3 | overlay-dark 覆盖 | 40+ 条 slate 翻转 | index.css 有（audit 242 行） | ⚠️ | 对照条数；P3 |
| 2.5.4 | 配色动画 | ov-palette-capturing（整窗 opacity 0）/ov-palette-fade（1.35s 过渡） | index.css:71-78 + 两处 class ✅ | ✅ | — |
| 2.5.5 | 代码块折行 | white-space:normal 逐行渲染（防截图识别） | index.css:234 | ✅ | — |
| 2.5.6 | `==高亮==`/md-answer-label | renderRule + strong.md-answer-label | index.css:214 + Md.tsx | ✅ | — |
| 2.5.7 | 预设 | 内置 2（默认/双机位 0.03/1/0.12）+ 用户 30 个（同名更新、超限提示） | SettingsPage:267-284 同名=更新✅、超限提示✅、id 生成同款 | ✅ | — |
| 2.5.8 | parkedLooks | 服务端推送写入；原生消费 | dualCamera.tsx 本地等价（停放/还原） | ✅（本地版） | — |
| 2.5.9 | 预览按钮 | 官方：复用真实浮窗窗口（会话中禁用+提示）；复刻：主窗口内 SimulatedPlatform 对话框预览（InterviewOverlay/ExamOverlay preview 模式） | ⚠️ 实现路径不同但体验等价；官方的「预览已停用」提示不适用 | ✅（本地化） | — |
| 2.5.10 | 样式热键→设置页刷新 | 官方走自定义 patch 事件；复刻走 setSetting→ml-store-changed→useSetting 重渲染（main.tsx:23 initStoreSync 已接） | ✅（机制不同、效果等价） | ✅ | — |

---

（第 3-6 章按 spec 03/04/05 与原生/跨端清单继续，见下文追加。）

### 1.8 工作台（补充，2026-10-30 第二轮）

| # | 项 | 官方行为 | 复刻现状 | 判定 | 建议/优先级 |
|---|---|---|---|---|---|
| 1.8.1 | 电话面试模式入口 | 面试方式三选：线上面试(SPEAKER)/电话面试(PHONE)/模拟练习(MICROPHONE)；PHONE 走声纹区分自己与面试官 | InterviewWorkbench 只有 SPEAKER/MICROPHONE 两卡；引擎支持 'PHONE' 类型但 UI 无入口 | ⚠️ | 本地版 PHONE≈麦克风，可补入口+说明；P2 |
| 1.8.2 | 会话过期 | sessionStatus.expiresAt → 浮窗剩余时长 mm:ss，到点自动结束 | 🔵 无云端配额；本地可显示已进行时长 | 🔵 | P3 |
| 1.8.3 | 启动失败分步回滚 | 任一步失败 toast「启动失败 @{step}: {detail}」并 hide_overlay 回滚 | startOverlayFlow 无分步错误与回滚 | ⚠️ | P2 |
| 1.8.4 | 笔试工作台 customization | exam.customization 全字段：answerLanguage/programmingLanguage/codeMode/codeQuality/customRequirements + instructionsPrompt/instructionsBase/quickPrompts（spec 05） | ExamWorkbench 编辑前五项；instructionsPrompt/instructionsBase/quickPrompts 无 UI（examEngine.customization 读 DEFAULT 但设置无处编辑后三项） | ⚠️ | 等子代理 spec05 核对；P2 |

### 1.9 设置页第二轮核对（2026-10-30）

| # | 项 | 结论 |
|---|---|---|
| 1.9.1 | 语言切换 | GeneralTab 有跟随系统+语言网格+展开收起；switchLocale 广播 reload（i18n.ts）——与官方一致 ✅ |
| 1.9.2 | 外观主题 | system/light/dark 三卡；**system 档未接 prefers-color-scheme 监听**（选「跟随系统」不随系统变，重启也不查） ⚠️ P2 |
| 1.9.3 | UI 缩放 | slider+zoom ✅；缺 Ctrl 快捷键 ⚠️ |
| 1.9.4 | 快捷键页 | panic 录键/默认按钮/占用警告✅；方案切换（简洁/防冲突）+示例键✅；18 动作录键/停用/恢复默认✅；**与官方差异：无「退役键迁移」UI 触发（migrateRetired 函数存在但无人调用）** ⚠️ P3 |
| 1.9.5 | 更新日志 tab | 复刻硬编码 1 条（官方 100+ 条内置+水位过滤+auto 弹窗）；ChangelogDialog 存在但内容为占位 ⚠️ P3 |
| 1.9.6 | 预设冲突检测 | 官方录键冲突时报错；复刻 cmd_set_action_hotkeys 部分失败仅返回 Err 字符串，**前端 void 丢弃不提示哪个键失败** ❌ P2 |
| 1.9.7 | 隐蔽页 | StealthTab 存在（disguise/演示模式/任务栏开关——细节由子代理核对） |

## 第 3 章 面试管线（spec 03，子代理核对 2026-10-30）

| # | 项 | 官方行为 | 复刻现状 | 判定 | 建议/优先级 |
|---|---|---|---|---|---|
| 3.1 | ai.prewarm 预热 | 不确定句（≥6 字）提前送服务端预热，手动触发时出答案更快 | ❌ 无 prewarm；立即回答=重发最后转写 | ❌ | 本地可预热 STT 结果的 prompt 缓存；P3 |
| 3.2 | ai.mergePrev | 服务端合并相邻 INTERVIEWER 消息 | ❌ 每句独立成条 | ❌ | 引擎可在续句（前句仍在宽限窗）时并条；P2 |
| 3.3 | 联网搜索 | webSearch 偏好 + 回答带 {queries, sources} 标注 uq | ❌ 仅类型字段，无 UI/prompt/渲染 | ❌ | P2（BYOK 需自选搜索后端，可先做提示词透传+来源渲染） |
| 3.4 | 声纹/说话人 | voiceprint enroll/verify；stt.end 带 speakerId（Guest-1=面试官） | ❌ 全无；所有句子当面试官 | 🔵/❌ | 云端能力不可本地复刻；本地可做简单 VAD 双通道（回采+麦）区分；P3 记录 |
| 3.5 | PHONE 电话面试入口 | 三选卡（线上/电话/模拟）；PHONE 限 4 语种 | ❌ UI 只有 SPEAKER/MICROPHONE（engine 支持 PHONE） | ❌ | 补入口；P2 |
| 3.6 | 面试复盘录音 | enableReplay：答时录自己麦（90s 封顶、回声切除 1200ms）→ uploadUserAnswer 转写回放 | ❌ 无录音回放链路 | ❌ | 本地可存音频到 attachments + 记录页回放；P1（官方核心卖点之一） |
| 3.7 | 学习回答风格 | 选一场自己答过的面试 → learnAnswerStyle 覆盖 customAnswerStyle | ❌ 无 | ❌ | 本地版：从历史记录挑一场 → AI 总结风格 → 写 interviewPreference.customAnswerStyle；P2 |
| 3.8 | 会话倒计时 | sessionStatus.expiresAt → mm:ss、到 0 自动结束 | ❌（gap 2.3.1/1.8.2） | 🔵 | 本地可设会话时长上限；P3 |
| 3.9 | 双语回答/翻译 | translateLang / dualLangAnswer | ❌ 零命中 | ❌ | P3 |
| 3.10 | solver 自动接题 | interviewer:utterance → solver 自动 followUp（<6 字忽略） | ⚠️ 事件已发但无消费者（→ bug B31） | ❌ | P2 |
| 3.11 | 模拟面试开场语预填 | 按语言预填「我准备好了」等 12 语种 | ❌ draft 初始为空 | ⚠️ | P3 |
| 3.12 | 模拟面试录音上限 | 300s 自动停 | ⚠️ 120s（→ bug B32） | ⚠️ | 放宽；P3 |
| 3.13 | 语气词清洗/分句常量 | Yp/$p 清洗、半句+800ms、短句 3s 宽限 | ✅ interviewEngine.ts:873-896/266-272/357-365 全对齐 | ✅ | — |

## 第 4 章 笔试（spec 04，子代理核对 2026-10-30）

| # | 项 | 官方行为 | 复刻现状 | 判定 | 建议/优先级 |
|---|---|---|---|---|---|
| 4.1 | 黑屏降级链 | ordinary→sharedSurface→gpuChild 自动降级 + 会话记忆 + 服务端 confirm | ⚠️ 有 is_blank 报错 + compatibilityMode 窗口回退；无逐级自动降级/gpuChild/会话记忆 | ⚠️ | 补自动降级链；P2 |
| 4.2 | 截屏超时 | 12s 超时 + 专属文案 | ❌（→ bug 待补，同 gap 2.4.7） | ❌ | P2 |
| 4.3 | 多页封顶 | 达上限显示「最多 {n} 页，请发送」并阻止 | ⚠️ solve 静默截断（→ bug B28） | ⚠️ | P2 |
| 4.4 | [[FOLLOWUP:]] chips | 答案内嵌追问建议 → 浮窗 chips | ⚠️ 解析了但零渲染（→ bug B29） | ⚠️ | P2 |
| 4.5 | partial-pass 四档 | chips「降低通过率 ≈80/60/40/20%」level 递增 | ⚠️ prompt 有、UI 无 chip、level 无 UI 传入（gap 2.4.5） | ⚠️ | P2 |
| 4.6 | 原生笔试窗口 | nativeOsd 独立进程 + config 全量 + 退出回写 | ❌（已记录，P1 计划） | ❌ | 大项；P1 |
| 4.7 | 副屏 WebRTC 直连 | rtc-offer/ice/answer DataChannel ordered:false maxRetransmits:0，回退中继 | ⚠️ 本地只有 WS 中继；无 rtc-*、无 exam.perf RTT；bye/release 命名不同 | ⚠️ | 局域网直连可后续补；P3 |
| 4.8 | 副屏时序/尺寸 | 60ms tick、30s RTT、恢复 3min/4h、按屏幕面积 80% 调窗 | ⚠️ 100ms tick/15s 宽限/innerHeight 调窗 | ⚠️ | 对齐常量；P3 |
| 4.9 | 配色两段确认 | 1.4s → 确认 1.2s | ❌ 单段（→ bug B30） | ❌ | P2 |
| 4.10 | 免责声明 | 禁考列表 | ✅ UsageNotice 逐条一致 | ✅ | — |
| 4.11 | dwell 时长表 | 全表 | ✅（配色确认除外） | ✅ | — |
| 4.12 | **代码沙箱验证** | 编程模式答题前服务端跑代码验证样例+边界（多语言）；快速模式仅计算题触发；客户端零执行 | ❌ 复刻解题链路未接自动验证（本地 Docker 沙箱已有但仅手动入口，examEngine「样例可手动验证」） | ❌ | 机制分析与接入路径见 [official-code-verification.md](official-code-verification.md)；P1 |

## 第 5 章 设置面板（spec 05，子代理核对 2026-10-30）

| # | 项 | 官方行为 | 复刻现状 | 判定 | 建议/优先级 |
|---|---|---|---|---|---|
| 5.1 | 文字透明度/外框线分浮窗记 | exam/interview 各自独立键 | ⚠️ 复刻一根滑杆同时写两份（底色浓度是分开的） | ⚠️ | 拆双滑杆或确认官方也是联动；P3 |
| 5.2 | UI 缩放快捷键 | Ctrl/⌘ +/-/0 全局 | ❌ 只有滑杆（→ 1.5.3） | ❌ | P3 |
| 5.3 | 截图兼容模式 | 通用页三态（键 capture.experimentalSharedSurface） | ⚠️ 放在笔试工作台、键不同、experimentalSharedSurface 死键（→ B34） | ⚠️ | P3 |
| 5.4 | 快捷键冲突标红 | 冲突组合 kbd 标红「不可用」 | ❌ 无冲突检测；setActionHotkeys 失败被 void 丢弃（→ 1.9.6） | ❌ | P2 |
| 5.5 | 退役键迁移 | 旧默认键自动迁移 | ⚠️ migrateRetired/defaultSchemeForUser 已实现但无人调用 | ⚠️ | 接线；P3 |
| 5.6 | 隐蔽页伪装预设 | 4 预设卡（UpdateService/AudioService/CloudSync/DocViewer）+ 自定义 NFKD 清洗 ≤40 | ❌ StealthTab 只有自由输入，无预设卡、无 NFKD 清洗 | ❌ | 补预设+清洗；P2 |
| 5.7 | exam.customization 三兄弟 | instructionsPrompt/instructionsBase（提示词接管）/quickPrompts（浮窗常驻 chips ≤8×60 字） | ❌ 仅 store 类型定义，无编辑 UI、无 prompt 消费、无浮窗 chips | ❌ | P2（quickPrompts 依赖 B29 的 chips 渲染） |
| 5.8 | answerLanguage 进 prompt | 随 customization 提交 | ⚠️ 不进 prompt（→ bug B27） | ❌ | P2 |
| 5.9 | customRequirements 长度 | 20000 全文 | ⚠️ prompt 截 500 字（ai.ts:110） | ⚠️ | 放宽到 2000+；P3 |
| 5.10 | 面试偏好云同步 | updateInterviewPreference 27 键 + pendingPush | 🔵 本地 interviewPreference 键替代 | 🔵 | — |

## 第 6 章 原生命令 / 事件 / store 键 / mac（子代理核对 2026-10-30）

### 6.1 官方 42 命令对照结论
- ✅ 36 个语义等价（多数同名）；🔵 6 个已知存根（崩溃族 + pending_newer_version，updater.rs 已有数据面可接）；⚠️ 弱化 4 个：apply_overlay_styles 丢 styles 入参、list_system_audio_outputs mac 返回空表（与能力门控一致）、set_system_audio_excluded_outputs 不持久化、read_recent_logs 单文件硬编码。
- ❌ 官方有、复刻无：仅 `cmd_start_auth_listener`（浏览器登录回跳监听）——本地账号架构性替代 🔵。
- 复刻另有 30+ 官方没有的命令（updater/ai_settings/data_store/code_sandbox/dual_screen/speech/disguise/capabilities），均为本地化所需。

### 6.2 官方 emit 事件对照结论
- ❌ 缺失 5：ai.prewarm（预热）、exam.perf（双机位性能上报）、exam.ws.connect（云端笔试 WS，架构性）、interview.setTurnCards（死键）、perf.client/perf.ping（遥测，本地版可不补）。
- 🔵 其余全部有本地等价机制（本地总线/直连调用/局域网中继），无需补同名事件。
- ⚠️ uncaughtException：有 `__errors` 兜底但无上限无上报（→ B35）。

### 6.3 store 键对照结论
- 官方 46 键中仅 settings.pendingPush、token 无等价物（架构性 🔵）；其余 44 键全部在 ALL_KEYS。
- ⚠️ 12 个键登记但无消费者（清单见 bug 文档 B38）——多为对应功能未实现的占位。
- ❌→⚠️ audio.excludedOutputs 半消费（读无写，→ bug B36）。

### 6.4 mac 端对照结论（重要更新：完成度高于 docs/macos-implementation.md 当时的估计）

| 项 | 官方 | 复刻 | 判定 |
|---|---|---|---|
| SCStream 系统音频（含自声排除/16k 直采） | Swift dylib | `src-tauri/macos-capture` 纯 Rust SCStream（captures_audio+excludes_current_process_audio+16000/1ch 直配） | ✅ |
| 截屏 | CGDisplayStream→JPEG | SCStream 单帧流→PNG（光标选显示器、前台窗口模式、按 pid 排除自身） | ⚠️（能力等价，API 路线不同） |
| 捕获排除 | setSharingType=.none | tao set_content_protected（→sharingType）+ best-effort 限制已在状态明示 | ⚠️ |
| NSPanel 悬浮窗 | sendEvent 事件驱动命中 | tao + CanJoinAllSpaces/置顶/不抢焦点达成；命中仍走 16ms 轮询（非事件）；非 NSPanel 形态 | ⚠️ |
| Carbon 热键 | RegisterEventHotKey | tauri-plugin-global-shortcut（mac 后端即 Carbon） | ✅ |
| CGEventTap panic 兜底 | 有 | ❌ 无 event-tap 级拦截 | ❌ P3 |
| LSUIElement/Dock 显隐切换 | Info.plist + TransformProcessType | ❌ 无 | ❌ P2（隐蔽页 mac 形态） |
| 权限声明/打包 | 两个 UsageDescription + dmg | Info.plist/Entitlements/tauri.macos.conf 全齐 | ✅ |
| network_relay | 受限网络代理 WS | ❌（本地直连架构，非必需） | 🔵 |

### 6.5 综合：官方有而复刻完全缺失、且值得借鉴的 Top 清单（按优先级）

1. **P0**：浮窗穿透态引导（穿透提示 Tq + 首跑引导 XW/ZW，gap 2.2.7/2.2.8）——不做新手完全无法上手穿透模式。
2. **P0**：穿透/窗口切换把手在穿透态失效（gap 2.2.6，B3）。
3. **P1**：面试复盘录音回放链路（gap 3.6）——官方核心卖点。
4. **P1**：turnCards 卡片轮换 + turnKind 元数据（gap 2.3.2）；浮窗品牌名与产品名统一（B2/B19）。
5. **P1**：托盘（gap 1.2.11）；崩溃恢复握手闭环（gap 1.1.4/1.1.5）；更新器安装流对齐（gap 1.7.1）。
6. **P1**：原生笔试 OSD 独立进程（gap 4.6，官方明确为考试客户端兼容性方案）。
7. **P2**：联网搜索透传+来源渲染（3.3）、学习回答风格本地版（3.7）、热词（记录）、黑屏自动降级链（4.1）、[[FOLLOWUP:]]/quickPrompts chips（4.4/5.7）、answerNow 实义化（B11）、截屏 12s 超时（2.4.7）、快捷键冲突标红（5.4）、伪装四预设+NFKD（5.6）、配色两段确认+undo（B30/2.2.10-11）、面试语言切换（2.3.8）、solver 自动接（B31）、settings 同步推送等价物（云端→本地导出/导入）。
8. **P3**：UI 缩放快捷键、翻译/双语、开场语预填、模拟录音 300s、退役键迁移接线、dead keys 清理、phone 模式入口、副屏 WebRTC 直连/时序常量。
