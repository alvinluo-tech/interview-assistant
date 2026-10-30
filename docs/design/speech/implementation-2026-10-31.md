# 多语言与电话角色实现记录

日期：2026-10-31。承接 2026-10-30 的研究方案。此前未提交的工作已作为 `0bc87b0` 留存；本文件记录随后实现的范围、选择与验收边界。

## 用户能使用的变化

- 面试工作台分别设置识别语言、参考答案语言和辅助翻译。中文、英文、粤语正文互相独立于应用界面语言；自动识别不强塞多个语言提示。浮窗提供中英文答案切换，不丢弃已有对话。
- 模拟面试配置和房间内均可选择语言、面试官口音、语速与复盘语言。问题、提示、录音识别、播报、重播和复盘都使用本场策略。每次生成的消息保存当时的语言策略，方便回看。
- 原文始终保留；辅助译文独立展示，不写回原文，不作为候选人的实际回答，也不延迟参考答案生成。关闭翻译不产生翻译请求；开启时使用所配置的对话模型，会有相应调用费用。
- 语音模型未配置时使用本机系统语音。Windows 按 SAPI Language 属性选择实际安装的中/英文或香港中文语音；macOS 解析系统 `say -v ?` 的已安装声音。缺少语音包时明确说明，文字面试仍可继续。
- 电话外放可选择本地声音识别：先独自试音，首次听到对方后标记一次面试官，之后自动匹配。本人声音进入实际回答记录；未确认声音不自动触发解答。手动身份模式无需下载模型，可直接标记转写文字作答。

## 适配器与请求合同

`speechProfile.ts` 表达用户意图；`speechCatalog.ts` 集中维护模型/音色/语言/地域/指令能力；`speechProtocol.ts`、`realtimeAsrProtocol.ts`、`ttsProtocol.ts`、`ttsSocket.ts` 负责各自的协议映射。业务组件只消费能力解析结果，不构造厂商私有请求体。

| 通路 | 实际映射 |
| --- | --- |
| MiMo ASR | `asr_options.language = auto / zh / en`；音频片段提交后接收 SSE 文字，保留与持续 PCM WebSocket 的区别 |
| Fun-ASR-Realtime | `language_hints` 至多一项；自动时省略；保留句子起止毫秒和连接时钟，用于关联本地音频 |
| MiMo TTS | 英文选择英文声音；待播正文放 assistant、朗读风格放 user；四川/东北/河南/粤语按官方样例映射；重庆风格标为实验性 |
| Qwen3 TTS | 中文/英文映射官方 `language_type`，粤语选 Rocky/Kiki，四川话选 Eric；不发送未经支持的语速或方言参数 |
| Qwen Audio 3.1 TTS | 系统多方言声音 `longanhuan_v3.1` 等，`input.instruction` 控制重庆/东北/粤语等，支持北京与新加坡 |
| CosyVoice v3 Flash | 根据 voice/region 匹配；北京走已支持 HTTP，**新加坡走 WebSocket**；WS 的 instruction/语言提示放 parameters，不能照抄 HTTP input |
| 其他兼容服务 | 保留原有自定义模型与音色；未知能力显示待试播，不承诺未验证的方言控制 |

声音缓存身份包含所选服务配置、语言、口音和语速，修改声音后不会复用旧语言音频。沿用可取消的流式 PCM 播放、分段、重播缓存、播放中断与资源回收。云服务错误不会偷偷切换到另一地域或用系统声音冒充配置的方言。

Qwen Audio 3.1 英文场景单独选择官方精品英文声音 `Abby_v3.1 / Emily_v3.1 / David_v3.1`，不从多方言标签推断其英文保证。音色 ID 保留大小写，不与实时语音模型里长得相似的 ID 混用。国内口音还接入该系列明确列出的云南话、宁波话、甘肃话。

新增厂商时：先补官方能力与地域证据，再添加中央能力条目及独立协议适配器，沿用已有认证、超时、取消、音频消费者和设置入口。必须补参数合同、失败/取消/迟到事件测试；不要在各个页面复制厂商判断。

## 电话双方声音如何区分

采用 Rust `sherpa-onnx = 2.0.1` 和 CAM++ 192 维 speaker embedding，CPU 单线程，在阻塞工作线程运行。没有用音调、性别或“没有匹配本人”推断面试官，也没有虚构 Fun-ASR 的声纹开关。

1. 首次由用户点击准备模型，下载官方文件并校验固定 SHA-256，大小限制 40 MiB。模型约 28 MB，落系统应用缓存目录 `speech/`，不跟项目源码或用户文档混放。
2. 独自录制约 12 秒自己的声音，至少 6 秒，最长 30 秒。拒绝过轻、严重削波或前后明显不一致的试音。原始 PCM 只在内存处理。
3. 自己的模板默认只保留当前应用运行期间；明确勾选后才用 Windows DPAPI / macOS Keychain 支持的加密层保存到应用本地数据目录 `speech/self-voice.enc`。支持清除。不会存下手机对方的永久声纹。
4. 新一场或重新连接采集时生成新的 owner，重置对方模板。对方首次较长的单人片段由用户标记身份；后续匹配双方模板。相似度阈值 0.65，双方分差至少 0.10；这是保守初值，不是声纹准确率承诺。
5. 很短、低质量、低置信度声音为 unknown。较长句子的头尾身份不一致时保留 unknown/overlap，避免拿跨说话人的整句做单人证据。该检查**不是完整的重叠语音分离模型**，双方同时说话仍需人工纠正。
6. 音频时间轴最多保留约 90 秒，供实时 ASR 的时间戳取精确片段；原生侧仅保留最近 32 段 embedding 供人工绑定，不保存原始音频。片段过期时仍能更正文字身份，只是不再学习该段声纹。
7. 停止、暂停、切换采集、网络重连及结束场次均有代际隔离。迟到识别结果不能新增旧会话文字。身份改成“这是我”时，取消该问题的待答队列和正在生成的答案，将旧建议标为已失效，原始历史仍保留。

本实现是单路混合音频上的身份验证与会话角色绑定，不是手机双音轨采集。不会保证零串音；遇到第三人、远场噪声、抢话或口音变化可保留待确认并一键更正。

## 模型来源与复现

- Rust/C API：[sherpa-onnx 官方 Rust 示例](https://github.com/k2-fsa/sherpa-onnx/tree/master/rust-api-examples)，Apache-2.0。
- 原始模型：[3D-Speaker CAM++](https://github.com/modelscope/3D-Speaker)、[ModelScope 模型页](https://modelscope.cn/models/iic/speech_campplus_sv_zh-cn_16k-common)。模型卡与代码仓库许可应分别保留记录，不把代码许可直接当作所有数据集的许可。
- ONNX 文件：[官方转换模型](https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx)。固定字节数 `28281138`，SHA-256 `f682b514c05d947ee3fa91cd6ec6c5c7543479a128373fa29b1faedccd21fd11`。更换模型须同步版本和评测，不接受任意远端 URL。
- 公开试验音频来自同一官方 release 的 `fangjun-sr-1.wav`、`fangjun-sr-2.wav`、`leijun-sr-1.wav`，16 kHz/单声道/PCM16；只作本地验收，不放入用户历史。
- Windows native 预构建静态库 archive `sherpa-onnx-v2.0.1-win-x64-static-MT-Release-lib.tar.bz2`，SHA-256 `23e7b986b197eda0bbc47ff3d7d5c87afd6ef2b9077214ba26b0f1ec52ef0e66`。首次构建需要下载对应平台原生库，后续复用 Cargo target 缓存；发行包不需要 Rust、Python 或 Swift 开发环境。

显式运行真实推理测试：设置 `SPEAKER_TEST_ASSETS` 为包含上述模型和三个公开 WAV 的目录，然后运行 `cargo test --manifest-path src-tauri/Cargo.toml --lib speaker::tests::actual_model_embedding -- --ignored --nocapture`。普通 CI 不依赖隐式下载测试音频。

## 已验证与仍需验收

已验证：Windows 编译与原生单测、公开音频真实推理、前端构建、全量前端协议测试，新增电话身份/晚到结果/纠正取消/语言独立性测试。`pnpm test:speech` 对新增纯策略与 WebSocket 核心设 80% 覆盖门槛，已接入 CI。

本轮验收：全量前端 **243 项通过**；Windows 原生 **54 项通过、2 项显式忽略**，其中真实声纹推理测试另行显式执行通过。新增语音核心覆盖率为行 **98.80%**、分支 **85.39%**、函数 **93.18%**；`pnpm build` 与依赖安全检查通过。另有 Vite 动态导入未单独分包的提示，不影响构建成功。Windows 开发版已启动并在实际窗口确认语言控件和重庆音色映射。

公开音频一次实测：192 维，方军两段相似度 **0.8115**，方军与雷军 **0.2344**；三个片段提取约 **166–181 ms**，不含模型初次加载。它仅证明真实模型已运行、公开样本可区分，不能推导手机外放误触发率、跨语言效果或其他设备延迟。

尚需用户设备验收：实际电话外放、不同距离/噪声/音量、本人跨语言、双方打断；MiMo/百炼付费账户的实际方言试听；macOS 真机的系统语音包、麦克风权限与原生库构建。此次未动用用户密钥调用付费模型，未录制用户声音，未伪造这些验收结果。

测试命令：`node --test tests/*.test.mjs`、`pnpm test:speech`、`pnpm test:ai`、`pnpm test:core-coverage`、`pnpm build`、`cargo test --manifest-path src-tauri/Cargo.toml --lib`。本轮因 E 盘空间紧张，最终原生构建使用本机 C 盘临时 target；没有修改项目的默认 Cargo 路径或用户全局配置。
