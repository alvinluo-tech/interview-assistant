# Windows 线上面试系统收音

「线上面试」识别电脑播放设备中的声音，例如会议软件里对方的讲话。「模拟练习」使用麦克风；对着麦克风讲话不会自动成为系统播放声音。

## 本次修复

字幕内容异常的主要原因发生在送入 ASR 之前：原生重采样的步长写反。复现测试中，一秒 44.1kHz 音频产生了 121,551 个采样点，而输出标称 16kHz，实际应约为 16,000 个。48kHz 输入同样会被拉长到原来的约九倍，声音变慢、音高下降，识别结果因此不可靠。

同时修复了相关问题：

- 按设备 ID 打开每个播放端点，避免枚举多个设备时反复采集默认设备。
- 每 100ms 输出固定 1,600 个采样点，在同一时间段叠加各设备音频并限幅，避免把并行声音串接为更长的音频。
- 根据 `WAVEFORMATEXTENSIBLE.SubFormat` 区分整数 PCM 和浮点 PCM，支持常见 16/24/32 位整数与 32/64 位浮点格式。
- 严格处理 `AUDCLNT_BUFFERFLAGS_SILENT`，静音数据包输出零，不读取未定义的缓冲区内容。
- 将音量按 PCM16 范围归一化，与麦克风的语音门限使用同一尺度。
- 设备初始化真正成功后才返回连接成功；采集运行错误会上报，前端停止收音并提供「重试收音」。
- 前端先等待音频和错误事件监听就绪，再启动原生采集；暂停会停止系统采集，旧采集回调不能向新会话注入音频。
- 浮窗显示实际采集的播放设备名称。

该实现仍采集系统播放声音，不按会议软件或说话人分离。测试时请暂停无关音乐、视频等音源。连接后新增播放设备时，点击「暂停 → 继续」重新枚举；设备断开报错时点击「重试收音」。macOS 系统声音采集尚未实现。

## 验证

```powershell
pnpm test:audio
cargo test --locked --manifest-path src-tauri/Cargo.toml --lib
```

原生回归验证不同输入采样率保持一秒时长、格式解码、静音处理、音量、并行混音。引擎回归覆盖系统 PCM 到 WAV、错误提示、暂停/重连、过期回调以及麦克风原有行为。

仅在有真实播放设备的 Windows 上手动执行硬件检查，会播放一秒较轻的测试音：

```powershell
cargo test --locked --manifest-path src-tauri/Cargo.toml --lib audio_windows::tests::hardware_loopback_preserves_test_tone_pitch -- --ignored --nocapture
```

`scripts/audio-smoke.mjs` 另包含真实桌面链路检查：WebAudio 播放 440Hz 测试音，经原生回采和面试引擎生成 WAV，发到本机测试服务后检查采样率、声道和频谱；转写返回固定测试文字，因此它不代表云端 ASR 的真实识别准确率。该检查使用 `com.mianlingai.clone.audiosmoke` 隔离数据及本机服务，不读取日常 AI Key。构建和执行示例：

```powershell
node node_modules/@tauri-apps/cli/tauri.js build --debug --no-bundle --target x86_64-pc-windows-msvc --config tests/fixtures/tauri.audio-smoke.conf.json -- --locked
Copy-Item -LiteralPath src-tauri/target/x86_64-pc-windows-msvc/debug/mianshi-copilot.exe -Destination artifacts/audio-smoke.exe -Force
node scripts/audio-smoke.mjs
```

参考：[Microsoft WASAPI loopback](https://learn.microsoft.com/en-us/windows/win32/coreaudio/loopback-recording)、[GetBuffer 静音与错误语义](https://learn.microsoft.com/en-us/windows/win32/api/audioclient/nf-audioclient-iaudiocaptureclient-getbuffer)、[WAVEFORMATEXTENSIBLE 格式说明](https://learn.microsoft.com/en-us/windows/win32/api/mmreg/ns-mmreg-waveformatextensible)。
