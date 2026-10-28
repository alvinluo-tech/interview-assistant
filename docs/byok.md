# AI 服务 / BYOK

入口：「设置 → AI 服务」。支持 OpenAI 兼容的模型列表、Chat Completions、语音转写和语音合成接口。

## 使用

1. 添加服务商连接，填写名称、API 地址和认证方式。可保存多个云端或本地连接；Ollama 和自托管预设支持免密，不会发送 Authorization。
2. 点击「连接并获取模型」，自动调用 `GET <API 地址>/models`。支持去重、搜索、分页响应及列表刷新。
3. 接口没有 `/models`，或列表没有某个模型时，填写精确模型 ID 和可选显示名称，点击「添加模型」。自定义模型不会被列表刷新删除；接口不再列出的已选模型会转为自定义条目保留。
4. 在「按用途选择模型」中分别配置对话、截图识别、转写和语音合成。不同用途可使用不同服务商；视觉留空时跟随对话模型，语音用途留空时禁用。
5. 保存后立即作用于新请求，不需要重启客户端。切换设置页签时，未保存修改会提示放弃或继续编辑。

API 地址可填写版本前缀或完整的 `/models`、`/chat/completions` 地址，客户端会保留网关前缀并去掉末尾端点。不会自动给任意地址补 `/v1`；请以服务商提供的兼容地址为准。原生 Anthropic、Gemini、Azure 专有协议未在此适配，需使用相应 OpenAI 兼容网关。

## 连接与模型验证

成功获取模型列表只说明该接口列出了这些 ID，不保证模型可用于视觉或语音。模型库中的「测试对话」会实际发送一条短消息并消费回答，展示返回内容和测得的耗时；此请求可能由服务商计费。它不会声称已验证视觉或语音能力。

实际对话和截图使用 `/chat/completions`；转写使用 `/audio/transcriptions`，合成使用 `/audio/speech`。语音音色 ID 和请求超时可在选项中设置。遇到认证失败、无权访问、路径不存在、限流或额度不足时，会显示对应错误。获取列表失败不会清空已配置模型。

MiMo-ASR 例外：选择 `mimo-*-asr` 后自动改用带 `input_audio` 的 `/chat/completions` 和 SSE，不会发到 Whisper 文件接口。「请求与语音选项」可选择自动适配、分段实时字幕或停顿后识别；MiMo 默认每约 2.5 秒提交一段音频预览，停顿后校正整句，再触发流式作答。预览会增加转写用量。这是文件接口的分段更新，不是原生 WebSocket 音频流。修改输入模式后请暂停并继续，或重新开始会话。[使用说明](microphone.md)

## 语音模型点击「测试对话」出现 HTTP 400

「测试对话」发送纯文字 Chat Completions 请求，不能用它验证语音识别。`fun-asr` 与 `fun-asr-flash-*` 是文件识别模型，`fun-asr-realtime` 使用实时音频接口。已识别的 Fun-ASR、Paraformer、SenseVoice、Whisper、Qwen-ASR 和 MiMo-ASR 模型会显示为「语音专用」，请求层也会在发送前拦截误用。MiMo-ASR 的实际音频请求仍按原有音频协议执行。

验证百炼实时语音：将 `fun-asr-realtime` 分配到「语音转写」，启用持续实时模式并保存，返回「面试助手 → 模拟练习」开始收音，说话查看字幕。新加坡连接使用同地域 Key，实时 WSS 地址留空可按连接地域自动匹配。「测试麦克风」只检查本地设备和音量，不验证云端服务。目录中有模型也不等于当前账户已开通调用权限。

如果停顿转写时报 HTTP 404，先检查保存的语音模型：百炼 `fun-asr`/`fun-asr-flash` 文件任务接口与 OpenAI `/audio/transcriptions` 不兼容，本应用当前未接入这些文件任务。现在会在保存、开始收音和发送音频前阻止误用并提示修复。已有错误配置仍可读取，设置页可点击「改用当前连接的实时识别」后保存，保留连接地址与密钥。选择已适配实时模型会自动使用持续实时模式。保存后请结束旧会话并重新开始。

参考：[百炼语音模型与接口类型](https://help.aliyun.com/en/model-studio/asr-model/)、[Fun-ASR-Realtime 连接指南](https://help.aliyun.com/en/model-studio/fun-asr-realtime-websocket-api)。

## 数据与密钥

- Windows 下通过 DPAPI 为当前用户加密密钥后保存到 `store.json` 的 `ai.settings.v2`，不会把新密钥以明文写入配置，也不会在跨窗口事件中广播密钥。
- 密钥只在本机运行内存及发往所选接口的认证请求中使用。请求走 Tauri 原生 HTTP，支持本地端口且不受 WebView CORS 限制；保持证书验证，禁止自动重定向，避免凭据被转发到其他地址。
- 原来的 `ai.provider` 会自动迁移，保留接口、模型和各用途选择；加密配置保存成功后才移除旧明文键。
- 复制配置到其他 Windows 账户后，DPAPI 密钥不能解密，需重新填写。读取失败时会阻止覆盖已有配置。当前非 Windows 构建仅支持免密配置，尚未接入其他系统的凭据库。
- 不提供自动扣费验证或后台模型轮询；获取模型和对话测试由用户在页面中触发。未连接接口时不编造可用模型。

## 验证

```powershell
pnpm test:byok
cargo test --locked --manifest-path src-tauri/Cargo.toml --lib
pnpm build
```

`scripts/byok-smoke.mjs` 使用本机模拟服务和独立应用标识 `com.mianlingai.clone.byoksmoke`，测试原生 HTTP（模拟服务不配置 CORS）、旧配置迁移、加密落盘、模型发现、自定义模型、用途选择和保存恢复。测试程序构建为 `artifacts/byok-smoke.exe`，结果为 `artifacts/byok-smoke-result.json`，页面截图为 `artifacts/byok-settings.png`。

协议参考：[OpenAI 模型列表](https://developers.openai.com/api/reference/resources/models/methods/list)、[Ollama OpenAI 兼容接口](https://docs.ollama.com/api/openai-compatibility)、[Tauri HTTP 插件](https://v2.tauri.app/plugin/http/)。
