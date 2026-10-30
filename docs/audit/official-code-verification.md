# 官方编程题的代码校验机制分析

日期：2026-10-30。问题：官方面灵AI 在笔试编程题上输出代码后，如何校验代码能通过/能运行？

结论先行：**官方的代码校验完全发生在服务端，客户端零执行、零判题 UI**。编程模式在「给出最终答案之前」由服务端沙箱跑代码验证样例和边界（多语言，含 Java/C++），验证结果随答案流一起下发；客户端只负责展示。依据是客户端 bundle 的完备性反证 + 官方 changelog 的明确陈述 + 计费结构的旁证。

证据基线：`_recon/frontend-h13/`（tauri-cmds.beauty.js 27.5k 行、bootstrap.beauty.js 54k 行）、`_recon/spec/04-exam.md`、`docs/audit/ai-vs-official-comparison.md`。

---

## 1. 客户端证据：完备性反证（做了穷举扫描）

对 h13 两个 bundle 扫描了全部执行/判题相关词族（`codeSandbox / sandbox / judge / compile / runCode / executeCode / stdin / stdout / wasm / 判题 / 沙箱 / 编译 / 样例通过 / 验证中` 等），结果：

| 期望痕迹（若客户端参与执行） | 实际 |
|---|---|
| 沙箱/运行器代码或 wasm、iframe 执行器 | ❌ 无 |
| 判题结果事件（onVerdict / caseResult / 样例 x/y） | ❌ 无 |
| 「正在验证样例 / 编译中」等进度文案 | ❌ 无（浮窗进度文案全部来自服务端 `onProgress` 推送，spec 04 §4.1） |
| 通过/未通过的 UI 状态渲染 | ❌ 无 |
| `codeSandbox` 字段消费点 | ❌ bootstrap 0 处引用；仅存在于模式描述符（见下） |

模式描述符里的 `codeSandbox` 标志（tauri-cmds h13:24914-24942）：

```text
instant:     { codeSandbox: false, billingUnit: 'screenshot', costMinutes: 2, maxPages: 4 }
quick:       { codeSandbox: true,  billingUnit: 'screenshot', costMinutes: 2, maxPages: 4 }
programming: { codeSandbox: true,  billingUnit: 'question',   costMinutes: 5, maxPages: 6,
               description: '更慢但更强，支持多页编程题，算法题自动验证样例' }
```

客户端对它的全部「消费」只有一处：模式描述文案渲染（`算法题自动验证样例`，9 语种 i18n）。标志本身不下发任何客户端行为——它描述的是**该模式下服务端管线的行为**。

## 2. 产品证据：changelog 直接说明了机制

官方 changelog（tauri-cmds h13）三条条目把机制和时间线说得很清楚：

| 日期 | 条目 | 原文 |
|---|---|---|
| 2026-09-17 | `exam-code-sandbox`（Qi，行 16917-16929） | 「**笔试编程模式答题前会自己跑代码验一遍样例和边界**，答 Java、C++ 时同样会验。」+「笔试快速模式不再跑代码验算，出答案更快。」 |
| 2026-10-13 | `exam-quick-sandbox`（ql，行 18341-18350） | 「快速模式遇到要算数、推演的题，**会先跑一段代码把结果算准再作答**。」 |
| 2026-09-17 | `coding-answer-hand-copy`（Ki，行 16887-16896） | 「编程题答案只给必须手敲的那部分：题面已给的类和签名直接用，不再重抄一遍样板代码。」 |

从中可确定的机制要点：

1. **答题前验证（pre-answer verification）**：不是「生成答案后追加一个校验步骤」给人看，而是把执行结果作为生成过程的一部分——先跑、按结果修正、再给最终答案。这解释了为什么客户端没有任何「验证结果面板」：验证产出直接融进了答案文本与生成决策。
2. **验证对象是样例 + 边界**：样例来自题面（编程题题面几乎必带输入输出样例），边界是服务端自行推演的补充用例。「答 Java、C++ 时同样会验」说明服务端沙箱是**多语言编译执行**（不只是 Python/JS 这类解释型），Java/C++ 意味着真实编译工具链。
3. **模式策略是产品迭代的结果**：09-17 曾把快速模式的验证拿掉换速度；10-13 又给快速模式加回「算数/推演题先跑代码算准」。这个往返说明官方在**延迟 vs 准确率之间按题型做了分档**——编程模式全量验证（5min/题 的计费覆盖了沙箱重试成本），快速模式只在检测到计算密集题时触发。
4. **验证的产物与「手敲部分」对齐**（Ki 条目）：验证的对象是「必须手敲的那部分代码」（题面给定类/签名之外用户真正要写的逻辑）——即核心代码模式（`codeMode: acm | core`，2026-10-15 上线）下，服务端会为 core 代码补一个 harness 再执行。

## 3. 机制还原：官方管线的推断模型

把客户端可见的部分（WS 上行/下行、计费、changelog）拼起来，服务端管线的工作形态可以高置信推断为：

```text
客户端                                    服务端
screenshot ──solver.solve──▶  ① 视觉提取题干/样例/约束
  { examMode, customization,   ② 生成代码（按 codeMode：ACM 完整程序 / core+补 harness）
    canReadScreen,             ③ 从题面提取样例 + 自推边界用例
    canCaptureWithCompatibility│
    canCaptureGpuChild }       ④ 沙箱编译执行（多语言：至少 Java/C++/Python…）
                               │  失败 → 依据 stderr/输出修正代码 → 重跑（循环）
                               ▼
               ◀──onProgress──「正在验证样例」等服务端进度文案
               ◀──onDelta/onSnapshot──最终答案（含验证后修正的代码与说明）
```

支持该模型的旁证：

- **计费结构**：编程模式按「题」计费（5min/题）而非按「图」，且更慢——按题计费才能覆盖沙箱多轮执行的开销；秒答/快速按图计费（2min/图）对应无/轻验证。
- **`onProgress` 是服务端文案通道**：浮窗里的「正在看你的屏幕… / 正在分析截图… / 思考中…」全部由服务端推送（spec 04 §4.1），验证阶段的进度天然走同一通道，客户端无需任何新事件类型。
- **`onSnapshot` 整段校正**：允许服务端在验证修正后整段重写已流出的文本——与「先跑后答、按结果修正」的工作方式吻合。
- **追问 chips 的「降低通过率」**（`partial-pass` 80/60/40/20%）同样由服务端 prompt 实现——服务端对自己的沙箱验证结果有完全权限去“放水”，这是客户端做不到的（见 audit A05 的对照结论）。

## 4. 官方没有做的事（同样重要）

- **客户端不展示“已验证”徽章**：没有任何「样例 x/y 通过」的 UI 状态。验证信息（如果有）只能以服务端写进答案正文的方式呈现。这避免了客户端显示与服务端事实不一致的状态——但代价是用户在 UI 层面无法区分「验证过」和「模型自称通过」。
- **不把沙箱暴露为用户可控开关**：`codeSandbox` 不是设置项，跟着模式走。用户不能强制开启/关闭验证。
- **秒答模式不做验证**（`codeSandbox: false`）：官方明确接受秒答档「可能答不准」换速度（模式描述：「答案出得最快，难题可能答不准」）。

## 5. 对复刻的对照与可行路径

本仓库现状（对照用）：

- 已有**本地 Docker 沙箱**：`src-tauri/src/code_sandbox.rs`（Python 3.13 / Node 22，`--network=none --read-only --cap-drop=ALL --pids-limit=64 --memory=256m --cpus=0.5` 非 root + 超时 + 64KB I/O 上限），暴露 `cmd_code_check` / `cmd_code_run`，由资料页的 `CodeVerificationPanel` **手动**触发。
- 笔试解题链路（`examEngine.solve`）**没有接入自动验证**：生成答案直接展示；编程模式描述文案写的是「样例**可手动**验证」（examEngine.ts:31）。
- 审计文档 A05/6.5 的判定仍然成立：答案正确性依赖模型自述，无执行证据；「降低通过率」无真实执行支撑。

官方机制给出的可行路径（按投入排序）：

1. **把已有的 Docker 沙箱接进解题链路（核心一步）**：编程模式（及快速模式检测到计算题时）在 `chatWithImages` 返回后自动执行——从 `<exam-question>` 提取的样例逐条 `cmd_code_run`，失败把 stdout/stderr/期望输出回喂模型做**一轮**修正，然后才落最终答案。这正是官方 0.2.6「先跑后答」的本地等价物，且最难的基础设施（硬化的本地沙箱）复刻已经写好了。
2. **诚实的验证状态**：答案头部标注执行事实——「已运行题面样例 3/3 通过」或「未执行验证（无可用样例/沙箱不可用）」。官方把验证事实写进答案正文的处理方式与此一致；绝不能像模型自述那样宣称「全部样例通过」。
3. **按模式分档**：照抄官方的时间线结论——编程模式默认开；快速模式只在题面含数值计算特征时触发（官方 10-13 的策略）；秒答不开。
4. **语言边界诚实化**：本地沙箱目前只有 Python/JS。官方支持 Java/C++（服务端编译工具链）。在补齐语言前，UI 应说明「当前仅自动验证 Python/JavaScript」，不要隐含全语言验证。
5. **进度文案**：验证期间浮窗状态行走「正在运行样例验证…」（复刻的 `statusText` 通道已具备），与官方 onProgress 的用户体验对齐。

## 6. 证据清单

- 模式描述符与 `codeSandbox` 标志：tauri-cmds h13:24914-24942；billingUnit/costMinutes 同段。
- changelog 正文：`exam-code-sandbox`（16917-16929）、`exam-quick-sandbox`（18341-18350）、`coding-answer-hand-copy`（16887-16896）、`exam-code-mode`（18420-18429）。
- 客户端零执行的反证扫描：bootstrap/tauri-cmds 全文 `codeSandbox` 消费点为 0（bootstrap）、3（tauri-cmds 定义区）；`judge/sandbox/verdict/stdout` 等词族无执行语义命中。
- 服务端进度文案通道：spec 04 §4.1（onProgress/onSnapshot 协议）。
- 计费结构：spec 04 §1 表 + tauri-cmds h13:24958-24961（`Av` 计费函数）。
- 复刻现状：`src-tauri/src/code_sandbox.rs`（本地 Docker 沙箱）、`src/lib/examEngine.ts:31`（「样例可手动验证」）、`docs/audit/ai-context-and-prompt-review.md` A05。
- 限制：官方服务端沙箱的实现（语言矩阵、用例数量、重试上限、超时）不可见；本文第 3 节为高置信推断，客户端可证部分（第 1、2 节）均为直接证据。
