# 持续实时语音识别

应用保留两条独立链路：MiMo 的短片段音频请求，以及百炼 Fun-ASR-Realtime / Paraformer v2 的持续 WebSocket 音频输入。两者的临时字幕都会更新；面试助手只在句子定稿后触发流式回答。

## 配置百炼

1. 在「设置 → AI 服务」选择「阿里云百炼（北京）」或「阿里云百炼（新加坡）」并添加连接。已有自定义连接可直接保留，无需重新创建。
2. 填入与连接地址**相同地域**的百炼 API Key。新加坡可填写公共地址 `https://dashscope-intl.aliyuncs.com/compatible-mode/v1`，或控制台提供的 `https://业务空间ID.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1`。密钥只在应用中填写，应用沿用本机加密存储。
3. 点击「连接并获取模型」，然后在「按用途选择模型」把**语音转写**分配给该连接的 `fun-asr-realtime`（稳定版）。北京另支持 `fun-asr-realtime-2026-02-28`（快照版）和 `paraformer-realtime-v2`。新增百炼连接预置对应地域支持的模型；已有连接也可手动添加对应模型 ID。对话和视觉用途可以继续使用原有 MiMo 或其他服务。
4. 选择已适配的实时模型后会自动使用持续实时模式，可在「请求与语音选项」检查。实时 WSS 地址**留空自动匹配**语音转写连接的地域和业务空间；也可填写同地域的官方 WSS 地址。若已有北京地址而现在改用新加坡，请清空旧地址后保存。语音模型不适用「测试对话」；测试麦克风仅检查本地音量，实际服务需要开始收音并说话查看字幕。
5. 返回面试助手，测试麦克风音量，再启动模拟练习或线上面试。线上面试的 Windows 系统收音也使用同一实时通道。

应用支持以下官方实时地址（统一路径 `/api-ws/v1/inference`）：

| 地域 | 公共域名 | 业务空间专属域名 | 已适配模型 |
| --- | --- | --- | --- |
| 北京 | `dashscope.aliyuncs.com` | `业务空间ID.cn-beijing.maas.aliyuncs.com` | `fun-asr-realtime`、`fun-asr-realtime-2026-02-28`、`paraformer-realtime-v2` |
| 新加坡 | `dashscope-intl.aliyuncs.com` | `业务空间ID.ap-southeast-1.maas.aliyuncs.com` | `fun-asr-realtime` |

优先使用控制台提供的业务空间专属地址。未识别到官方百炼连接且未手动填写 WSS 地址时，仍保留原有北京默认地址。应用会拦截连接与实时地址的地域冲突，以及新加坡下选择北京专属模型的配置；不支持 8k 模型、任意代理 WSS 域名或把密钥放进 URL。

## 模型发现

对于北京和新加坡的官方百炼 HTTPS 兼容地址，「连接并获取模型」优先查询原生 `/api/v1/models` 模型目录，解析 `output.models[].model` 并按 `output.total` 分页，最多 2000 个模型。查询按部署范围筛选：北京为 `asia-pacific-china`，新加坡为 `international`。新加坡使用官方目录地址 `https://dashscope-intl.aliyuncs.com/api/v1/models`；业务空间专属连接会附带 `X-DashScope-WorkSpace` 请求头。

目录接口返回 404/405 时才回退到原有 `/compatible-mode/v1/models`。鉴权失败、取消、网络错误或目录格式错误会明确报错，保留界面原列表；不会伪装成功。刷新会保留自定义模型和已分配用途的模型。目录展示不代表当前账户已开通模型，真实可用性仍以请求结果为准。其他服务商和代理地址继续查询自己配置的 `/models`，不会自动把其密钥发往百炼。

目录协议：[模型列表 API](https://help.aliyun.com/zh/model-studio/list-models)。

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

新加坡相关回归覆盖：完整模型目录的地域与业务空间、音频模型分页、兼容接口回退、鉴权错误与取消、重复/异常分页、WSS 自动推导、地域冲突和北京专属模型拦截。前端配置和 Rust 保存层都验证地域。

界面隔离测试：先在当前终端设置 `MIANSHI_UI_SMOKE=1`（PowerShell：`$env:MIANSHI_UI_SMOKE='1'`），再启动 `node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 1432 --strictPort`，然后运行 `node scripts/bailian-ui-smoke.mjs`（默认使用本机 Chrome，可用 `BAILIAN_TEST_BROWSER` 指定浏览器路径）。该变量让测试服务使用独立的依赖缓存，避免影响正在运行的桌面开发服务。测试只使用合成目录和测试密钥，不发送外部请求，也不读写桌面应用的个人配置。结果保存在 `artifacts/bailian-ui-results.json`，截图为 `artifacts/bailian-ui.png`。

开发模式若出现 `Failed to fetch dynamically imported module`，可运行 `node scripts/check-realtime-module.mjs` 检查实时语音模块的完整依赖图。`504 Outdated Optimize Dep` 表示本地开发依赖缓存失效，尚未向百炼发送识别任务；开发服务重新加载后刷新助手窗口再试。桌面、音频测试和界面测试服务使用不同缓存目录，语音 WebSocket 依赖在启动时预构建。

协议单元测试涵盖两个 Fun-ASR 模型的启动参数、PCM 字节、句子标识与定稿去重，以及通用握手、临时字幕、错误脱敏、重连、积压、超时和长会话回放。已有隔离桌面测试通过真实 Rust WebSocket 连接本机合成服务，另验证实际模拟面试窗口的录音/字幕/可编辑文字链路；Fun-ASR 云端效果仍需真实账户实测。

这不代表真实百炼账户已经验证：尚未提供该服务 Key，不能据此判断中文准确率、专业词汇效果或真实网络延迟。MiMo 分段模式不需要迁移现有配置。

仅开发联调：构建隔离测试包时可设置 `MIANSHI_REALTIME_SMOKE=1`，Vite 将使用 `tests/fixtures/realtimeTransport.ts`。此适配只允许隔离应用 ID 和本机模拟地址，普通构建不包含它。复制隔离 EXE 到 `artifacts/audio-smoke.exe` 后，顺序执行 `scripts/realtime-smoke.mjs`、`scripts/context-smoke.mjs` 和 `scripts/reliability-smoke.mjs`。这些脚本共享隔离数据目录，不要并行。正式发布不要设置该变量。
