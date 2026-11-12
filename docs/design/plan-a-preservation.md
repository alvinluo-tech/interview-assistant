# Plan A 功能保留台账

依据：`artifacts/ui-verify/PLAN-A-UI-REFACTOR.md` §5–§15。原则：**先记录、再替换**；原型里的简化、示例、假数据不能作为删除功能的依据。

状态说明：`已完成` = 已落地并看过截图；`待验证` = 代码保留、样式统一后需逐条点过；`未开始` = 尚未处理。

| ID | 功能 | 原有内容 | 源文件 | 新入口/交互 | 状态 |
| --- | --- | --- | --- | --- | --- |
| P0-01 | 侧栏导航｜展开/收起 | 8 个 section 入口、题库/资料/历史、GitHub/设置/反馈 | MainWindow.tsx Sidebar | 宽度 216/64、选中 bg-selection、hover 统一 | 已完成（截图 plana-shell.png） |
| P0-02 | 标题栏｜最小化/还原/最大化/关闭 | 窗口控制 | MainWindow.tsx TitleBar | h-36px、border-line、hover 120ms | 已完成 |
| P0-03 | 页面标题/副标题 | 每个 section 的 h1/desc | MainWindow.tsx PAGE_TITLES | 26/32 600 + 14/22 | 进行中（chat 等页面内各自标题仍需统一） |
| P0-04 | 全局令牌 | 冷灰白/白面/深侧栏、语义色、圆角、阴影、状态色 | index.css :root/.dark/@theme inline | --mx-* + shadcn 变量 | 已完成 |
| P0-05 | 基础组件 | Button/Input/Textarea/Select/Switch/Slider/Dialog/Toast/Badge/Card/SectionHeader | ui/primitives.tsx | 42 高、10 圆角、2px 焦点环、status token | 已完成，构建通过 |
| P1-01 | 面试语言三下拉（识别/参考答案/翻译） | 各语言与方言选择 | InterviewWorkbench.tsx SpeechProfilePanel | 保留，仅样式统一 | 待验证 |
| P1-02 | 面试工作台两卡片（线上/电话） | 模式选择与说明 | InterviewWorkbench.tsx | 保留 | 待验证 |
| P1-03 | 系统收音设备排除 | OutputExclusions.tsx | 多选设备、刷新 | 保留 | 待验证 |
| P1-04 | 麦克风检测 | MicrophoneCheck.tsx | 电平、设备、开始/停止 | 保留 | 待验证 |
| P1-05 | 开始/结束面试、进行中状态 | 启动浮窗、结束回工作台 | InterviewWorkbench.tsx + bridge | 保留 | 待验证 |
| P1-06 | 简历/岗位选择、资料多选、管理资料跳转 | 来源资料 | InterviewWorkbench.tsx | 保留 | 待验证 |
| P1-07 | 回答策略：自动回答、断句等待三档、语言、补充要求 | 题目回答行为 | InterviewWorkbench.tsx | 保留（文案与真实毫秒值对齐） | 待验证 |
| P1-08 | 双机位面试入口 | DualScreenCard.tsx | 二维码、复制、停止 | 保留 | 待验证 |
| P2-01 | 笔试模式三选（翻译/截图/编程） | ExamWorkbench.tsx | 保留 | 待验证 |
| P2-02 | 恢复上次笔试、开始笔试、目标岗位 | ExamWorkbench.tsx | 保留 | 待验证 |
| P2-03 | 答题偏好：编程语言、代码模式、取向、回答语言、补充要求 | ExamWorkbench.tsx | 保留 | 待验证 |
| P2-04 | 浮窗选项：复制按钮、快捷键提示、双机位、截图范围 | ExamWorkbench.tsx | 保留 | 待验证 |
| P3-01 | 模拟面试准备：简历/岗位/难度/八股占比/提示开关 | MockPage.tsx | 保留 | 待验证 |
| P3-02 | 声音设置三下拉 + 音量滑杆 | MockPage.tsx PhoneSpeakerSetup/SpeechProfilePanel | 保留 | 待验证 |
| P3-03 | 未结束场次继续/放弃、上一场复盘 | MockPage.tsx + backend | 保留 | 待验证 |
| P3-04 | 独立模拟间（MockApp）：提问、语音、字幕、提示、结束、复盘、薄弱点 | src/mock/MockApp.tsx | 保留 | 待验证 |
| P4-01 | 自由对话：会话列表、重命名、删除、搜索、宽度拖拽 | FreeChatPage.tsx | 保留 | 待验证 |
| P4-02 | 对话：语音回复、实时通话、打断、静音、计时 | FreeChatPage.tsx voiceCall | 保留 | 待验证 |
| P4-03 | 上下文读数、整理上下文、记住要点、记忆弹窗 | FreeChatPage.tsx | 保留 | 待验证 |
| P4-04 | 资料检索（本地资料/应用功能） | FreeChatPage.tsx ResourcePanel | 保留 | 待验证 |
| P5-01 | 资料管理：简历上传/预览/删除 | ResourcePage.tsx | 保留 | 待验证 |
| P5-02 | 岗位新建/编辑/删除、JD | ResourcePage.tsx | 保留 | 待验证 |
| P5-03 | 面试资料新建/导入/删除/官方与 AI 生成来源 | ResourcePage.tsx | 保留 | 待验证 |
| P6-01 | 题库：筛选简历/岗位、生成准备题、收藏、存进资料 | QuestionBankPage.tsx | 保留 | 待验证 |
| P7-01 | 历史：三 tab、分组、批量删除、导出 markdown、重命名、删除、截图缩放 | RecordsPage.tsx | 保留 | 待验证 |
| P8-01 | 设置·通用：语言、主题、界面大小、对话字号、语音通话 | SettingsPage.tsx | 保留 | 待验证 |
| P8-02 | 设置·浮窗样式：主题、预设、描边、加粗、预览 | SettingsPage.tsx + overlay | 保留（预设值与用户值全保留） | 待验证 |
| P8-03 | 设置·快捷键：录制、冲突提示、应急隐藏 | SettingsPage.tsx | 保留 | 待验证 |
| P8-04 | 设置·AI 服务：连接、模型库、用途选择、语音、向量模型、超时 | AiServicesTab.tsx | 保留 | 待验证 |
| P8-05 | 设置·AI 指令：任务偏好编辑、保存、恢复默认 | PromptWorkbench.tsx | 保留 | 待验证 |
| P8-06 | 设置·长期记忆：增删改 | MemoryTab.tsx | 保留 | 待验证 |
| P8-07 | 设置·隐身/进程伪装/共享限制/权限 | StealthTab.tsx | 保留 | 待验证 |
| P8-08 | 设置·存储、关于、更新 | StorageSettings.tsx + 关于 tab | 保留 | 待验证 |
| P9-01 | 面试浮窗：状态、收音控制、字幕、回答、热键驻留区、窗口/穿透切换 | InterviewOverlay.tsx | 保留 | 待验证 |
| P9-02 | 笔试浮窗：截图解题、追问、优化复杂度、代码复制/验证、翻页、滚动到底 | ExamOverlay.tsx | 保留 | 待验证 |
| P9-03 | 浮窗主题/描边/预设与驻留热区 | overlay/platform.tsx + widgets.tsx | 保留 | 待验证 |
| P10-01 | 手机副屏：二维码、复制地址、停止/继续 | src-tauri/src/dual_page.html + DualScreenCard | 保留 | 待验证 |

## 验证记录

- 2026-11-12：Phase 1（令牌 + primitives + 外壳）落地，`npx tsc --noEmit` 干净、`pnpm build` 通过，主窗口截图 `artifacts/ui-verify/plana-shell.png`。
