# 官方能力与接入核实

日期：2026-10-30。以下是官方文档证据，未调用用户密钥、未录音、未注册声纹、未测试付费接口。能力确认不等于当前账户有访问权，也不等于本应用已接通相应功能。

## 1. 识别：语言覆盖与参数分开

| 服务 / 模型 | 官方确认的本次相关范围 | 请求映射 | 说话人输出 |
| --- | --- | --- | --- |
| MiMo `mimo-v2.5-asr` | 中文、英文及若干中文方言；模型页明确举例粤语、吴语、闽南语、四川话。未找到将重庆、东北分别列为该 ASR 保证项的依据 | `POST /v1/chat/completions`，音频 Base64；`asr_options.language` 为 `auto / zh / en` | 当前公开 API 返回文本；未找到 speaker ID / 声纹注册合同，不能把多人场景转录宣传当作角色分离 API |
| 百炼 `fun-asr-realtime` | 中文、英文；中文文档另列多语种及粤语、重庆/西南、东北等地域口音覆盖 | WebSocket `run-task`，`payload.parameters.language_hints` 至多一个值；省略时自动识别 | 官方模型表标为不支持说话人分离 |
| 百炼 `fun-asr-realtime-2026-02-28` | 中文、英文、日语及相应中文方言口音 | 同一协议，版本能力单列 | 不支持说话人分离 |
| 百炼离线 `fun-asr` | 录音文件转写，可选说话人分离 | 异步文件任务，`diarization_enabled` 等参数，返回匿名 `speaker_id` | 不能据此推断同名 realtime 模型也支持；匿名 ID 还须映射业务角色 |

证据：[MiMo ASR API](https://mimo.mi.com/docs/zh-CN/api/audio/Speech-Recognition)、[MiMo ASR 模型](https://mimo.mi.com/models/zh-CN/mimo-v2.5-asr)、[百炼 ASR 模型表](https://help.aliyun.com/zh/model-studio/asr-model/)、[Fun-ASR 客户端事件](https://help.aliyun.com/zh/model-studio/fun-asr-client-events)、[离线 Fun-ASR API](https://docs.bailian.console.aliyun.com/zh/model-studio/fun-asr-recorded-speech-recognition-http-api)。

重要差异：本次读到的百炼中英文模型页对稳定别名 `fun-asr-realtime` 的语种范围并不完全一致。中文客户端事件将稳定别名和固定快照分列。产品能力按实际模型 ID、地域、接口和复核日期记录，不把稳定别名未来更新的能力倒灌给所有快照。此次首先覆盖中文/英文和用户明确要求的中文口音；更广语种单独验收。

### 参数规则

- UI 可固定主语言，并保存常用切换项。它不等于供应商能同时接收多个语言提示。
- Fun-ASR 混合中英文优先省略 `language_hints`，而非发送 `['zh','en']` 并误以为二者都生效。
- MiMo 中英混用走 `auto`；单语分别映射 `zh / en`。
- 粤语、重庆口音、东北口音是产品侧的语言/口音标签。当前这两条 ASR API 不据此生成虚构的 `zh-CQ`、`zh-DB` 或声纹参数。
- MiMo 的 SSE 是已提交音频的文本增量输出；不能据此认定支持像百炼 WebSocket 一样持续推送 PCM。现有分段输入方式应保留明确能力名称。

## 2. 朗读：必须定位到模型＋音色＋地域＋控制方式

| 通路 | 中文 / 英文 | 本次可确认的方言控制 | 重庆话的处理 |
| --- | --- | --- | --- |
| MiMo `mimo-v2.5-tts` | 有中英文预置音色，英文场景应选英文音色 | 官方风格例子列出粤语、四川话、东北话、河南话；通过 user 风格指令或合成文本的风格标签控制 | 未见独立重庆预设保证；可做明确标注的川渝风格实验，不把四川话直接改名成重庆话 |
| Qwen3-TTS-Flash | 多语种，具体以所选音色为准 | 粤语可选 `Rocky / Kiki`，四川话可选 `Eric`；其他方言看完整音色表 | 当前这些预置项不能证明精确重庆话能力 |
| Qwen Audio 3.1 TTS Flash（实施时补核） | 多语言系统音色，北京/新加坡 | `longanhuan_v3.1` 等官方多方言声音支持粤语、东北、重庆、上海、陕西等；通过 instruction 控制 | **有直接重庆话依据，不需要冒充四川话或强制复刻声音** |
| CosyVoice-v3-Flash | 多种系统音色，模型与音色绑定 | 例如 `longanhuan_v3` 提供指令控制；`longlaotie_v3` 为东北话音色，`longanyue_v3` 为粤语音色 | 本次核实的上述系统音色不能冒充独立重庆话预设 |
| 系统 TTS | 取决于本机已安装语音包 | 枚举到什么才展示什么 | 不能默认承诺具备所有中文方言 |

证据：[MiMo TTS 使用指南](https://mimo.mi.com/docs/zh-CN/quick-start/usage-guide/audio/speech-synthesis-v2.5)、[Qwen 音色表](https://help.aliyun.com/zh/model-studio/qwen-tts-voice-list)、[CosyVoice 音色表](https://help.aliyun.com/zh/model-studio/cosyvoice-voice-list)。

### 需要独立处理的接入细节

1. MiMo：待朗读文本放 assistant 消息；风格说明放 user 消息。保持正式面试官的专业语气，方言不等于搞笑人设。应用内显示原问题正文，不显示或朗读控制标签。
2. Qwen：`input.language_type` 使用官方枚举（如 `Chinese / English / Auto`），同时选匹配的 voice；该字段不是任意方言代码。见 [Qwen TTS API](https://help.aliyun.com/en/model-studio/qwen-tts-api)。
3. CosyVoice HTTP：官方字段是 `input.instruction`、`input.language_hints`。WebSocket 对应任务参数通过其独立适配器构建，不能把 HTTP 的 input 原样复制为 WS 参数。见 [HTTP API](https://www.alibabacloud.com/help/en/model-studio/cosyvoice-tts-http-api)、[WS 客户端事件](https://help.aliyun.com/zh/model-studio/cosyvoice-client-events)。
4. CosyVoice-v3-flash 的指令随音色而异；多方言音色可用固定中文句式控制，不能给每个音色任意发送同一套自然语言标签。见 [官方错误码与指令要求](https://help.aliyun.com/zh/model-studio/error-code)。
5. 地域必须参与筛选：本次音色表中 `longanhuan_v3`、`longlaotie_v3` 列出北京，`longanyue_v3` 列出北京和新加坡。已有新加坡 Key 不自动拥有北京能力。
6. 本次 CosyVoice HTTP API 页面只列出北京端点，而 [WS 接入页](https://help.aliyun.com/zh/model-studio/cosyvoice-websocket-api/)列出北京和新加坡。新加坡需优先采用有文档依据的协议；不能只替换 HTTP 域名就宣称接通。账户可用性和目标 voice 仍需测试。
7. 实施时进一步核实 [Qwen Audio 音色表](https://www.alibabacloud.com/help/en/model-studio/qwen-audio-tts-voice-list)、[HTTP API](https://help.aliyun.com/en/model-studio/qwen-audio-tts-http-api)和[3.1 模型说明](https://help.aliyun.com/en/model-studio/qwen-audio-3-1-tts-flash)：存在无需复刻的官方重庆话系统音色通路，已单列接入。不能把这些能力倒灌到 Qwen3-TTS、旧 Qwen Audio 3.0 或所有 CosyVoice voice。

## 3. 声纹服务与普通 ASR 的边界

阿里确有 [AnalyticDB 实时 ASR 与声纹检索](https://www.alibabacloud.com/help/zh/analyticdb/analyticdb-for-mysql/realtime-asr-and-voiceprint)文档，但它是单独的邀测服务：需服务地址和相应凭据，并先通过 `/voice/enroll` 录入。通过句子 ID 接收异步身份匹配结果，可能先产生早期结果，再产生完整句子的修订结果。

因此不能在用户现有百炼 WebSocket 上随意加 `enable_voiceprint` 就宣称可用。也不把该专用服务示例里的语言参数形态复制进普通 Fun-ASR 请求。产品可为它提供未来独立 Adapter，默认 BYOK 方案不依赖开通该服务。

本地候选方案：[sherpa-onnx 官方 Rust 示例](https://github.com/k2-fsa/sherpa-onnx/blob/master/rust-api-examples/README.md)包含 embedding 提取与管理，[SpeakerEmbeddingManager](https://k2-fsa.github.io/sherpa/onnx/rust-api/examples/speaker_embedding_manager.html)支持登记、匹配和移除。可以通过 Rust 接口集成本地推理；底层原生库和模型文件的版本、许可、平台依赖仍须实际核实。

以上只证明存在接口和示例，尚未证明我们设备上实时速度、跨语言误识率或打包体积达标。官方离线 diarization 示例也不能直接当作已验证的在线角色分配器。
