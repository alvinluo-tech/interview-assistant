# 官方 AI 实现对照分析

日期：2026-10-30。对照物：[ai-context-and-prompt-review.md](ai-context-and-prompt-review.md)（下称「审计文档」，对复刻版 AI 链路的 15 条发现 A01–A15 与架构建议）。对照对象：官方面灵AI 0.3.16（native）+ 0.3.16-h13（UI 热补丁）的 AI 相关实现。

本文回答一个问题：**审计文档指出的每个问题，官方是怎么处理（或规避）的；官方架构证明了什么、否定了什么；复刻在保留 BYOK 客户端架构的前提下应该采纳什么。**

证据来源：

- 官方前端契约：`_recon/frontend-h13/`（tauri-cmds.beauty.js 27.5k 行、bootstrap.beauty.js 54k 行），本文引用行号均指 h13 美化件；
- 官方行为规格：`_recon/spec/00-05.md`（基于 0.3.16 exe + h5 的逆向规格，h5→h13 diff 已确认无功能删除，仅新增）；
- 官方服务端内部实现不可见——凡涉及服务端的判断均标注「推断」，不作为事实陈述。

---

## 1. 总架构对照：智能在哪里

| 维度 | 官方 | 复刻（BYOK） | 审计文档对应议题 |
|---|---|---|---|
| 模型调用方 | 服务端（api.mianlingai.com + capture/stream WS） | 客户端直连用户自配的 OpenAI 兼容接口 | 全文前提 |
| 会话上下文持有者 | **服务端**：客户端每问只上行一条消息，服务端持有整场对话并自行组装历史/检索/提示词 | **客户端**：本地 chatHistory 组装最近 12 条 + 检索片段，每请求全量重发 | A01、A03 |
| 提示词 | 服务端私有，客户端不可见 | 客户端 `ai.ts` 硬编码模板，可见可改 | A09 |
| 偏好/自定义指令 | **服务端用户档案**：`getUserInfo` 直接返回 `interviewPreference`（含 `instructionsPrompt`、`customAnswerStyle`、`answerStyle`、`lang`、`altLangs[]`、`translateLang`、`dualLangAnswer`、`enableReplay`、`webSearch`，bootstrap 36109-36115），服务端处理请求时自行读取 | 客户端 store 键 `interviewPreference`，客户端拼进 prompt | A10、A13 |
| 检索/RAG | 服务端（客户端上传原文后不再参与） | 客户端本地词法检索 `knowledgeContext.ts` | A06 |
| 资料处理 | 服务端：`upload.getPostObjectSignature` 直传 OSS → `material.uploadMaterialFile` / `resume.uploadResume` 服务端解析 | 客户端：PDF.js 本地提取 + 视觉 OCR 确认 | A14、A15 |
| 模型选择 | 服务端按任务/题型内部路由（changelog 10-27「笔试图形推理题换上新一代看图模型」= 服务端静默换模型，客户端无感） | BYOK 四用途路由（chat/vision/stt/tts），用户显式选择 | A13 |
| 计费/时限 | 服务端额度 + `sessionStatus.expiresAt`，超时服务端断开（续时功能 10-29 上线） | 本地不限量 | — |

**核心结论 1**：官方把审计文档建议的 `ContextAssembler` / `KnowledgeService` / `PromptRegistry` 整体放在服务端。客户端契约因此极薄——这正是官方客户端能回避 A01/A03/A06 这类问题的原因：**不是问题不存在，而是问题被移出了客户端视野**。服务端是否把 AI 参考答案混入候选人事实、如何裁剪历史，客户端同样无法审计。换言之：官方架构把这些问题变成不可观测的，而不是已解决的。

---

## 2. 官方客户端 AI 契约实录（h13 还原）

以下是官方客户端在每个 AI 功能上**实际发送什么**。这是官方架构下「上下文工程」的全部客户端部分。

### 2.1 实时面试：一问一消息 + 服务端回执

```text
上行（socket.io）：
  ai.onMsg { message: string }                              # 一个定稿问题
  ai.onMsg { message, correction: true }                    # 用户纠错重发（49805）
  ai.onMsg { message, voiceAsk: bool }                      # 语音追问标记（49828）
  interview.start / interview.setLang / setAutoAnswer / setTurnCards
  stt.*（转写事件族）
下行：
  ai.onMsg 回包（流式答案 + metadata.turnKind NEW/CONT/SKIP）
  ack：{ success, answerSlotId, message }                   # 服务端为每个问题分配答案槽位（49665）
  ai.mergePrev / ai.webSearch { queries, sources } / ai.interrupt / ai.prewarm
```

值得注意的三个设计：

1. **`answerSlotId`（答案槽位）**：服务端 ack 返回，客户端 `we.setAnswerSlot(n, e.data.answerSlotId)` 记录（49665）；复盘录音按槽位关联（`session.uploadUserAnswer` 带 answerSlotId）。**官方在协议层区分了「问题 → 该问题的答案 → 该问题的我方录音」三元组**——这正是审计文档 5.1 建议的 `questionId`/`origin` 字段机制的官方等价物，只是由服务端分配。
2. **纠错是协议级操作**：`correction: true` 单独标记（49805），服务端知道这条消息是对旧消息的更正——审计 5.2「Redis → Redisson 应取代而非并存」在官方由服务端按此标记处理；客户端不做合并决策。
3. **`mergePrev` 是服务端指令**：客户端消息存储暴露 `mergePrevTurn`（49569），服务端可指示把相邻两条面试官消息合并为一问——审计 5.2 的「连续几句组成一道题」由服务端裁决，客户端执行。

### 2.2 笔试：截图上行 + 服务端视觉

```text
solver.solve 上行载荷（50359）：
  { screenshot: base64,            # 单屏截图
    mode,                          # 面试内嵌答题上下文
    examMode,                      # 秒答/快速/编程
    customization,                 # exam.customization 对象整体上行
    canReadScreen: true,           # 客户端能力标志
    canCaptureWithCompatibility,   # 兼容截图能力协商
    canCaptureGpuChild }
下行：onStart/onReasoning/onProgress/onDelta/onSnapshot/onEnd/onQuota/onTerminalReject
追问：solver.followUp（追问意图 + `> label` 前缀由服务端协议约定）；[[FOLLOWUP: a|b|c]] 是服务端在答案里内嵌的追问建议
```

- **新题请求不含简历/资料**——与审计 6.1「新题默认不需要简历 RAG」一致，官方实践相同。
- `customization` 整体上行：说明官方服务端把用户偏好（语言/代码模式/补充要求）注入自己的提示词，等价于审计 4.2 的「类型化参数」层——参数由用户配置、由服务端渲染，不由自由文本拼装。
- `[[FOLLOWUP:]]` 追问建议由服务端生成（复刻已解析该协议但未渲染，见 gap 4.4）。
- **代码沙箱**：官方在编程模式答题前由服务端跑代码验证样例与边界（多语言），客户端零执行——机制分析见 [official-code-verification.md](official-code-verification.md)；这是 A05「复刻侧补执行证据」的官方参照
- **「降低通过率」官方确实存在**（spec 04 §4.1 追问 chips，服务端 prompt 实现）：审计 A05 指出的「按目标通过率制造错误不可信」在官方同样存在，只是实现藏在服务端、客户端无证据可查。这一条**两方同病**，不是复刻特有缺陷。

### 2.3 偏好与指令：服务端档案 + promptStudio

- `interviewPreference` 存于用户档案（36109-36115 一次性拉取并填充编辑器），字段含审计 4.3 建议的大部分「类型化参数」：`answerStyle`（枚举）、`lang`、`altLangs[]`（多语言回答）、`translateLang`、`dualLangAnswer`、`customAnswerStyle`（自由文本）、**`instructionsPrompt`（整段答题指令接管）**、`enableReplay`、`webSearch`。
- **`promptStudio` 是官方的提示词工作台**（31730-31746）：`promptStudio.presets.useQuery({lang})`（服务端预设模板库，5 分钟缓存）、`promptStudio.run`、`promptStudio.assist`（AI 辅助改写指令），状态按 `interview` / `exam` 双通道管理。它编辑的就是 `instructionsPrompt`/`instructionsBase`，配合设置页「答题指令已整段接管（{n} 字）」文案（spec 05 §SI）。
- 审计 4.3 建议「promptId/promptVersion/预设库/AI 辅助」——**官方已实现同构物**（服务端版本化预设 + assist），复刻的 `exam.customization.instructionsPrompt/instructionsBase/quickPrompts` 字段存在但无 UI 无消费（gap 5.7），是「官方有、复刻只有占位」的典型。
- 官方的用户自由文本只有 `customAnswerStyle` 和 `instructionsPrompt` 两处，且都是「附加约束」语义；审计 A10 担心的「用户风格覆盖事实约束」官方用服务端措辞规避（不可见），复刻则应按审计建议把「优先级最高」降级为风格层。

### 2.4 声纹 / 热词 / 说话人：服务端服务

- 声纹：`voiceprint.enroll/status/verify` + 上传 wav（enroll 6s / verify 2.5s / 45s 超时 noVoice，h13 35498-35601）；`stt.end` 载荷带 `speakerId`（Guest-1 = 面试官 / uncertain），客户端按说话人过滤——**审计 5.3「没有证据不得认定面试官」官方用声纹证据解决**；复刻把系统回采一律当面试官，无 `uncertain` 通道。
- 热词：`hotWords.ensureGoalHotWords/getHotWords/updateGoalHotWords`——按岗位的服务端热词表，供 ASR 使用；复刻仅百炼热词表 ID 手动配置（审计 5.3 建议的「从简历生成候选术语表」官方是服务端自动 + 用户确认编辑的混合）。
- 电话面试（PHONE）：麦克风 + 声纹区分本人/面试官（注册文案明说「之后的电话面试里，系统会用这段声音认出我」，tauri-cmds h13:548）。

### 2.5 题库与押题：真实统计源

- `questionBank.listCompanies / listHot / getOverview / getQuestion / toggleMet`——真实公司/真题/频次统计（「你面过」标记，tauri-cmds h13:554）；`questionPrediction.get/list/startCustom/subscribe`——押题订阅。
- 审计 A14「官方常考概率」在官方确实有数据来源（服务端面经库）；复刻的 LLM 生成「常考题 + 概率」没有统计依据——**这条差距是数据性的，不是提示词能弥补的**。复刻可行的诚实做法（审计 11.2 已建议）：界面标为「AI 推测的高频方向」，不展示具体百分比概率。

### 2.6 联网搜索

- `webSearch` 是服务端能力：偏好开关在档案，回答流带 `ai.webSearch { queries, sources[] }` 事件，浮窗渲染「正在联网搜索 / 引用 {n} 个来源：{sites}」（spec 03）。复刻无此能力（审计 gap 3.3）；BYOK 下可做审计建议的「提示词透传 + 来源渲染」等价物，但搜索工具本身需要接入某家搜索 API，是独立子系统。

### 2.7 模型路由（服务端内部）

- changelog 10-27 证明官方按题型换模型（图形推理 → 新看图模型），10-27 另有「原生笔试窗口自动换线路」。官方把「模型评测 → 路由」闭环放在服务端持续运营——审计 10.1/11.3 要求的「能力绑定 + 评测选择」在官方是服务端职责。复刻 BYOK 把这个职责交还给用户，因此审计建议的「能力描述字段 + 本地评测 runner」对复刻更有必要（官方用户不需要，复刻用户就是运营者）。

---

## 3. 审计发现 A01–A15 逐条对照

判定含义：**架构性消除**=官方架构下客户端不存在此问题（服务端职责，是否真解决不可知）；**协议已解**=官方在协议层有对应机制；**两方同病**=官方可见证据表明同样存在；**复刻特有**=官方架构下不存在或不可见。

| # | 发现 | 官方对照 | 结论 |
|---|---|---|---|
| A01 | AI 参考答案作为 assistant 历史延续成个人事实 | 服务端持有历史并知道每条消息来源（AI 答案是服务端自己生成的，天然区分）；客户端只上行面试官原话 | **架构性消除**（服务端视角）。复刻在客户端可等价实现：给消息加 `origin`（interviewer-transcript / ai-suggestion / user-confirmed），组装历史时 AI 建议降权或显式标注 |
| A02 | AI 生成问答收藏后升级为事实 | 官方 `questionBank.saveToMaterial` 同样把题库内容收进资料；但官方题库条目源于真实面经库，可信度起点不同 | **部分缓解**：官方有数据质量优势；「收藏条目无来源标记」的结构问题官方未见处理痕迹（推断）。复刻按审计建议加 `origin: ai-draft` + 确认状态即可超越 |
| A03 | 历史裁剪可能丢当前问题/题干/签名 | 服务端持有全量对话，自行组装（策略不可见） | **架构性消除**（客户端视角）。复刻的等价修法：按 `questionId`/turn 组装而非条数截断（审计 6.3 的 Question→SolutionRevision 结构） |
| A04 | 忽略 `finish_reason`，截断当成功 | 官方流式回包由服务端产生，onSnapshot 整段校正兜底；客户端无 finish_reason 判断需求 | **复刻特有**（BYOK 直连才有此问题）。审计建议的 `completionStatus` 必须做——这是复刻独有的责任 |
| A05 | 「降低通过率」无执行证据 | **官方同款功能**（服务端 prompt 实现追问 chips：降低通过率≈80/60/40/20%） | **两方同病**。复刻还多了 UI chip 未实现（gap 4.5）；诚实性标注审计建议对两边都成立 |
| A06 | 检索无阈值、无命中仍填 | 服务端检索，客户端不参与 | **架构性消除**。复刻按审计 9.2 第一步改本地检索（阈值/去重/允许空返回） |
| A07 | 模拟面试快照固定、提示/复盘事实源不一致 | 官方模拟面试走服务端会话（`agentSession`），一致性由服务端保证（内部策略不可见） | **架构性消除**。复刻采纳审计 7.1 `SessionKnowledgeSnapshot`（固定版本、动态取段）即可 |
| A08 | 八股比例二分、追问上限靠提示词 | 官方模拟面试的题量/追问控制不可见（服务端） | **不可判定**。审计 7.2「程序维护训练状态」的建议在官方无法验证，但客户端程序化控制对复刻本身成立，保留 |
| A09 | 提示词硬编码未版本化 | **官方 promptStudio**：服务端版本化预设 + AI assist（31730），用户可整段接管（instructionsPrompt） | **官方有对应物**。复刻应对：promptRegistry 化（版本/出处）+ 落实 instructionsPrompt/quickPrompts 消费（gap 5.7）——这一条官方走得比复刻远 |
| A10 | 资料拼 system、无数据/指令分层 | 官方分层策略不可见；但 `customAnswerStyle`/`instructionsPrompt` 均为「附加约束」语义，未见「优先级最高」类措辞 | **不可判定 + 措辞问题复刻特有**。审计建议（数据块低信任、风格不得覆盖事实）在复刻客户端完全可落地 |
| A11 | 自动回答把多数定稿当待答、队列无合并/取代 | 官方协议层有 correction 标记 + mergePrev 指令 + answerSlot（见 2.1），问题调度在服务端 | **协议已解**（官方）。复刻客户端等价物：correction/取代/合并至少做成 UI 可达操作（现有「立即回答」没有 correction 通道进入排队题） |
| A12 | 模拟面试 1.5s 定时重试无上限分类 | 官方网络层有分类遥测（`exam.ws.connect {durationMs, reconnect, attempts, lastError}` 48805）——重试有遥测相伴；错误分类策略不可见 | **部分官方实践可见**：复刻至少补「重试计数 + 上限 + 错误分类」（审计 10.2），官方的连接遥测字段可直接抄形状 |
| A13 | 模型能力/预算/结构化输出/用量记录不足 | 官方服务端内部处理；客户端上行仅带能力标志（canReadScreen 等）——**客户端按能力协商上行**这个模式值得抄 | **复刻特有责任**。BYOK 适配层按审计 10.1/10.2 建 |
| A14 | 题库与资料内 AI 出题上下文不一致 | 官方两边都走服务端统一数据 | **架构性消除**。复刻按审计 A14 建议统一上下文源 |
| A15 | 「能调用」测试 ≠ 质量证据 | 官方有服务端评测闭环（10-27 静默换模型即证据），客户端不带质量逻辑 | **复刻特有责任**：审计 11.3 的评测 runner 对复刻是必需品——BYOK 架构里用户/开发者就是模型运营方 |

**汇总**：15 条发现中，6 条（A01/A03/A06/A07/A08/A14）被官方架构移出客户端视野（问题转移而非消失）；2 条官方有协议/产品级对应物复刻应学（A09 promptStudio、A11 correction+answerSlot）；2 条两方同病或不可判定（A05/A02 部分）；5 条（A04/A13/A15 + A10 措辞 + A12 部分）是 **BYOK 客户端架构的独有责任**，官方不存在此问题是因为官方不需要直连任意模型。

---

## 4. 官方实践对审计建议的印证与修正

审计文档的建议并非凭空——其中相当一部分与官方做法殊途同归，个别建议需要按官方实践修正：

### 4.1 被官方印证的建议

1. **新题不带简历**（审计 6.1 ↔ 官方 solver.solve 载荷）：官方实践中截图+模式+customization 就是全部，个人资料只进面试链路。
2. **四种内容必须区分**（审计 5.1 ↔ 官方 answerSlotId/speakerId/turnKind/correction 协议字段）：官方的解法是在协议里携带来源与槽位，而不是靠 role 字段猜。复刻的消息模型（backend.ts `ChatMessage`）已有 `metadata.turnKind` 字段位，补 `origin`/`answerSlotId` 即可对齐。
3. **参数类型化**（审计 4.2 ↔ 官方 interviewPreference/exam.customization 结构化字段上行）：官方从不让用户自由文本直接决定行为参数。
4. **提示词可配置 + 预设 + 版本**（审计 4.3 ↔ promptStudio）：官方证明这应该做成产品功能而不是开发期常量。复刻的字段占位（instructionsPrompt/instructionsBase/quickPrompts）应激活。
5. **连接质量遥测**（审计 10.2 ↔ exam.ws.connect/exam.perf 字段形状）：官方遥测字段可直接作为复刻 diagnostics 的形状参考。
6. **纠错为一等操作**（审计 5.2/5.3 ↔ correction:true 协议位）：复刻的 `answerQuestion(correction)` 已有雏形，但未进自动回答队列、无消息关联。

### 4.2 被官方实践修正的建议

1. **「RAG 不必向量库」的边界**：审计 9.1 表格正确，但官方实践补充了一点——**短简历场景官方根本不做客户端检索**，全文进服务端由其内部策略处理。复刻对 ≤1 简历 + 1 JD 的常见档位，审计的「方案 D：完整注入对照」应当优先实测，词法检索管线不必急着优化。
2. **「说话人不确定」标注**：审计 5.3 建议「无证据时允许标注身份不确定」；官方是拿声纹证据把问题消灭（PHONE 模式强制声纹）。复刻短期做不了声纹，但 SPEAKER 模式可以引入官方的 `uncertain` 语义：转写定稿默认 `speaker: unknown`，SPEAKER 模式标 `interviewer-presumed`，麦克风路径（模拟练习）标 `user`——比审计建议更接近官方可用性。
3. **「收藏 AI 条目升级事实」**：官方题库内容本身也是「准备建议」性质（押题/预测），官方没有做确认升级流。审计对复刻的要求（AI 草稿标记 + 用户确认）应保留，这是复刻可以做得比官方更严谨的点，而不是向官方看齐的点。

### 4.3 官方验证了但审计未展开的：产品级的临近结束引导

h13 续时功能（见 gap-analysis 第 0 章 0.2.1）展示了一个审计未覆盖的模式：会话资源临近耗尽时，浮窗内出现引导（非阻断、可收起、完成自动续）。本地版无计费，但「面试进行到后半程给出质量提示/健康提示」（如音频探针发现无声、检索无命中）可以复用同一 UI 模式——审计 0.2.2 的探针建议可挂接在此。

---

## 5. 复刻的行动建议（BYOK 前提下吸收双方）

按性价比排序；「学官方」指在客户端实现官方协议层等价物。

1. **P1 · 消息来源模型**（学官方 answerSlot/审计 5.1）：`ChatMessage.metadata` 增加 `origin: 'interviewer' | 'ai-suggestion' | 'user-confirmed'` 与 `questionId`；历史组装时 ai-suggestion 显式标注（「以下是此前给出的参考建议，非本人回答」）——A01 的最小修法，一次数据迁移可完成。
2. **P1 · 完成状态**（审计 A04，官方无此负担）：aiProtocol 消费 `finish_reason`，响应带 `completionStatus`；截断不可作为成功入库。**这是官方帮不上的部分，必须自己做。**
3. **P1 · correction 进队列**（学官方）：排队中的待答题支持「用户更正/撤回取代」，UI 上至少让「立即回答」的 correction 语义可达。
4. **P2 · 指令工作台**（学官方 promptStudio，落审计 4.3）：激活 `instructionsPrompt/instructionsBase/quickPrompts` 的编辑 UI 与 prompt 构建消费；预设先用审计 4.2 的候选模板，加 `promptId/version` 常量。
5. **P2 · 检索诚实化**（审计 A06，官方架构性规避所以无参照）：阈值、允许空返回、来源与回答绑定——保持审计路线；短资料档位先做「完整注入 vs 检索」对照。
6. **P2 · 能力协商上行**（学官方 solver 能力标志）：BYOK 请求层带模型能力描述（vision/json/上下文窗/输出上限），路由时校验——审计 10.1。
7. **P3 · 声纹/热词等价物**：短期做 speaker=unknown/interviewer-presumed/user 三态标注；简历→候选术语表→百炼热词 ID 的半自动流（官方是全自动服务端版）。
8. **P3 · 题库诚实化**：去掉无依据的「常考概率」数字，标「AI 推测高频方向」；收藏条目带 ai-draft 标记与确认状态（做比官方更严谨）。
9. **不做**：服务端化、账号/计费/真题库统计——BYOK 本地版的产品边界，官方在这些维度不可复制也不必复制。

---

## 6. 证据与限制

- 官方客户端契约证据：h13 美化件 bootstrap 36109-36115（偏好档案）、49662-49668（ai.onMsg + ack + answerSlot）、49805-49810（correction）、49828-49833（voiceAsk）、50359-50367（solver.solve 载荷）、48691-48698（exam.toSecondary / exam.perf）、48805-48812（exam.ws.connect 遥测）、31730-31746（promptStudio）、49516-49521（enableReplay 门控 LK / RK 音源校验）、35498-35601（声纹常量与 noVoice）；tauri-cmds h13:548（声纹注册文案）、19041-19174（h6→h13 changelog）。
- `_recon/spec/00-05.md` 提供路由/事件/键名全表；h5→h13 语义 diff 确认契约无删改（见 gap-analysis 第 0 章）。
- **限制**：官方服务端的提示词、检索、历史策略、题库统计实现均不可见；本文凡称「官方如何处理」仅指客户端可观测行为与协议形状，服务端内部质量不构成对照结论。审计文档本身的建议（评测方法、RAG 路线）未经真实流量验证，与官方实践是否更优需按审计 11.3 的对照法实测。
