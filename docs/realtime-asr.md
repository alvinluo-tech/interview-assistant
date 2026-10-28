# 持续实时语音识别

应用保留两条独立链路：MiMo 的短片段音频请求，以及百炼 Fun-ASR-Realtime / Paraformer v2 的持续 WebSocket 音频输入。两者的临时字幕都会更新；面试助手只在句子定稿后触发流式回答。

## 配置百炼

1. 在「设置 → AI 服务」选择「阿里云百炼（北京）」并添加连接。
2. 填入**北京地域**业务空间可用的百炼 API Key。密钥只在应用中填写，应用沿用本机加密存储。
3. 在「按用途选择模型」把**语音转写**分配给该连接的 `fun-asr-realtime`（稳定版）、`fun-asr-realtime-2026-02-28`（快照版）或 `paraformer-realtime-v2`。新增百炼连接预置这些模型；已有连接可手动添加对应模型 ID。对话和视觉用途可以继续使用原有 MiMo 或其他服务。
4. 展开「请求与语音选项」，选择「持续实时音频（百炼 Fun-ASR / Paraformer）」。确认 WSS 地址后保存。语音模型不适用「测试对话」，请保存后在工作台测试麦克风。
5. 返回面试助手，测试麦克风音量，再启动模拟练习或线上面试。线上面试的 Windows 系统收音也使用同一实时通道。

默认地址为 `wss://dashscope.aliyuncs.com/api-ws/v1/inference`，官方仍兼容该地址。优先使用控制台提供的业务空间专属地址 `wss://业务空间ID.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference`。当前应用适配只支持北京地域的上述三个模型，不支持新加坡地址、8k 模型、任意代理域名或把密钥放进 URL。

官方协议：[地址与鉴权](https://help.aliyun.com/zh/model-studio/websocket-for-paraformer-real-time-service)、[客户端消息](https://help.aliyun.com/zh/model-studio/paraformer-client-events)、[服务端消息](https://help.aliyun.com/zh/model-studio/paraformer-server-events)。实际可用性和费用以服务商为准。

Fun-ASR 协议：[接入指南](https://help.aliyun.com/zh/model-studio/fun-asr-realtime-websocket-api)、[客户端事件](https://help.aliyun.com/zh/model-studio/fun-asr-client-events)、[服务端事件](https://help.aliyun.com/zh/model-studio/fun-asr-server-events)。沿用原生 WebSocket 的 Bearer 请求头认证，无需额外 Python/Java 服务或 SDK。

Fun-ASR 的 `run-task` 使用 `format=pcm`、`sample_rate=16000`、`heartbeat=true` 和工作台静音阈值 `max_sentence_silence`（限制在 200–6000ms）；按需附加 `language_hints`、`vocabulary_id`。Paraformer 的 `semantic_punctuation_enabled`、`disfluency_removal_enabled` 仅发送给 Paraformer。结果按服务端 `sentence_id` 标识同一句子，兼容仅有 `begin_time` 的响应；只有 `sentence_end=true` 才定稿。

官方提供的上下文增强暂未接入；应用不会自动向 ASR 上传简历、JD 或对话历史。

## 字幕与连接状态

- 桌面原生 WebSocket 携带认证头；服务端确认 `task-started` 后，持续发送 16kHz、单声道、PCM16 小端音频。
- 临时结果替换当前句子；句子定稿去重后进入问答。断句间隔使用工作台静音设置，不把每个临时片段都作为问题。
- 暂停或结束会关闭连接。重连时清除临时字幕，提示中断期间的语音需要重说；不补发积压的旧音频。
- 连续不稳定连接最多重试三次；稳定一分钟后重置重试预算。发送积压超过两秒会报错，单次发送、连接和定稿也有超时。
- 模拟面试窗口会边录音边显示字幕，结束后放入可编辑回答框；点击提交才作为回答发送。单次录音最多两分钟。
- 服务商可能按持续连接/音频时长计费。暂停可停止持续连接；不使用时切回自动模式。

热词支持已有百炼 `vocabulary_id`：在控制台或官方热词接口创建热词表后，把 ID 填入「热词表 ID」。应用当前不创建、编辑云端热词表，也不自动上传简历来创建热词。

## 验证范围

协议单元测试涵盖两个 Fun-ASR 模型的启动参数、PCM 字节、句子标识与定稿去重，以及通用握手、临时字幕、错误脱敏、重连、积压、超时和长会话回放。已有隔离桌面测试通过真实 Rust WebSocket 连接本机合成服务，另验证实际模拟面试窗口的录音/字幕/可编辑文字链路；Fun-ASR 云端效果仍需真实账户实测。

这不代表真实百炼账户已经验证：尚未提供该服务 Key，不能据此判断中文准确率、专业词汇效果或真实网络延迟。MiMo 分段模式不需要迁移现有配置。

仅开发联调：构建隔离测试包时可设置 `MIANSHI_REALTIME_SMOKE=1`，Vite 将使用 `tests/fixtures/realtimeTransport.ts`。此适配只允许隔离应用 ID 和本机模拟地址，普通构建不包含它。复制隔离 EXE 到 `artifacts/audio-smoke.exe` 后，顺序执行 `scripts/realtime-smoke.mjs`、`scripts/context-smoke.mjs` 和 `scripts/reliability-smoke.mjs`。这些脚本共享隔离数据目录，不要并行。正式发布不要设置该变量。
