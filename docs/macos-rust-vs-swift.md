# mac 功能必须用 Swift 吗？—— 调研结论

> 这是实现前的方案调研，工作量估算不代表当前发布状态。当前项目自编写层使用 Rust；Rust 接口依赖库内部仍可能编译 Swift，打包仍需要 macOS 的 Apple 工具链。实际实现及验收边界以 `docs/macos-implementation.md` 为准。

> 结论先行：**不是必须。** 原版选 Swift 只是实现偏好；四个 mac 功能点全部可以用纯 Rust
> （objc2 系 crate + CoreFoundation/CoreGraphics C 绑定）实现，且本仓库在 mac target 下的
> 依赖树里 objc2 全套已经存在（由 tauri/wry/tao 传递引入），不需要新增构建链。

---

## 1. 原版为什么用 Swift：只覆盖一个功能点

逐个功能拆开看原版的实现语言（证据来自 dylib 切出物与 slice 符号，见
`docs/macos-implementation.md`）：

| 功能 | 原版实现 | 是否 Swift |
|---|---|---|
| 系统音频采集 | 独立 dylib `libmianling_system_audio.dylib`（Swift 类 `SystemAudioCapture`） | **是（唯一一处）** |
| 截屏（题图） | `app_lib::capture::macos::capture_screen_jpeg` —— **Rust 函数**，调 CoreGraphics C API | 否 |
| 截屏授权 | `CGPreflight/RequestScreenCaptureAccess` —— 纯 C 函数 | 否 |
| 防捕获（WDA 等价） | `NSWindow.setSharingType:` —— objc2-app-kit 有此 selector | 否 |
| 浮窗窗口层 | tao 0.35.3（Rust）+ NSPanel selector —— objc2-app-kit | 否 |
| 全局热键 | Carbon `RegisterEventHotKey` —— 纯 C（global-hotkey crate 的 mac 后端） | 否 |
| 原生笔试窗口 | `src/native_osd/` Rust 模块跨平台 | 否 |

也就是说：**原版 7 个 mac 功能点里只有 1 个用了 Swift**，其余 6 个本来就是纯 Rust /
纯 C。而那唯一的 Swift dylib，其 Swift 部分的实际工作量也很小（见 §2）。

---

## 2. 唯一的 Swift 点（SCStream 音频桥）拆解

### 2.1 原 dylib 的 Swift 逻辑面有多小

切出的 `system_audio-x64.dylib`（57KB）符号统计：
- Swift mangled 符号 50 个，其中**真正的逻辑函数只有 6 个**（start/stop/回调转换/PCM 转换），
  其余 44 个全是运行时元数据（类型描述、协议 witness、反射表）——objc2 方案不需要这些。
- 关键点：`startCaptureWithCompletionHandler:` 的回调是 **ObjC block**，
  符号里虽有 Swift async/await 重写体（`yyYacfU_`），但对外契约就是普通 block——
  **objc2 的 `block2` crate 可以直接接，不需要 Swift 运行时**。

### 2.2 dylib 实际调用的 API 全清单（可被 Rust 直接替代）

**ObjC selector（objc2-screen-capture-kit 全部提供）：**

| selector | objc2-screen-capture-kit |
|---|---|
| `initWithFilter:configuration:delegate:` | `SCStream::initWithFilter_configuration_delegate` ✓ |
| `initWithDisplay:excludingWindows:` | `SCContentFilter::initWithDisplay_excludingWindows` ✓ |
| `addStreamOutput:type:sampleHandlerQueue:error:` | `SCStream::addStreamOutput_type_sampleHandlerQueue_error` ✓ |
| `startCaptureWithCompletionHandler:` | `SCStream::startCaptureWithCompletionHandler` ✓ |
| `stopCaptureWithCompletionHandler:` | `SCStream::stopCaptureWithCompletionHandler` ✓ |
| `setCapturesAudio:` / `setSampleRate:` 等 5 个配置 | `SCStreamConfiguration` 属性 setter ✓ |
| `setExcludesCurrentProcessAudio:` | 同上 ✓ |
| `stream:didOutputSampleBuffer:ofType:` | `SCStreamOutput` 协议（objc2 定义 protocol） ✓ |
| `getShareableContentExcludingDesktopWindows:...` | `SCShareableContent` 类方法 ✓ |

**纯 C API（core-media-sys / 直接 FFI，与 Swift 无关）：**

| API | 用途 |
|---|---|
| `CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer` | 从 CMSampleBuffer 取 PCM |
| `CMAudioFormatDescriptionGetStreamBasicDescription` | 读采样率/声道/位深 |
| `CMAudioFormatDescriptionGetFormatList` | 辅助格式信息 |

**Swift 独有依赖的真实占比**：dylib 链接的 Swift 运行时是
`libswiftCore/CoreAudio/AVFoundation/Metal/CoreMedia/Dispatch/ObjectiveC` 7 个——
这些是「Swift 语言写的代码需要 Swift 运行时」，不等于「这个功能必须 Swift」。
API 面本身（SCStream + CMSampleBuffer）对 Rust 完全开放。

---

## 3. 纯 Rust 方案的依赖与工作量

### 3.1 依赖现状（已核实）

对本仓库执行 `cargo tree --target aarch64-apple-darwin`，mac target 下**已经传递引入**：

```
objc2 0.6.5 / objc2-encode 4.1.0 / objc2-foundation 0.3.2
objc2-app-kit 0.3.2 / objc2-web-kit 0.3.2 / objc2-quartz-core 0.3.2
objc2-core-graphics 0.3.2 / objc2-io-surface 0.3.2
block2 0.6.2（ObjC block 支持）/ dispatch2 0.3.1（GCD）
core-foundation 0.10.1 / core-graphics 0.25.0
```

即 **objc2 全家桶已经在依赖树里**（wry 0.57 / tao 0.37 带进来的），mac 构建时
不需要新增任何 Apple 侧依赖基础设施；补 `objc2-screen-capture-kit` 与
`core-media` 两个 crate 即可覆盖 SCStream 音频。

### 3.2 各功能点的纯 Rust 写法与预估工作量

| 功能 | 纯 Rust 做法 | 预估工作量 |
|---|---|---|
| **SCStream 音频** | objc2-screen-capture-kit：建 `SCStreamConfiguration`（`setCapturesAudio(true)`、`setExcludesCurrentProcessAudio(true)`、`setSampleRate(16000)`）→ `SCContentFilter::initWithDisplay_excludingWindows` → `SCStream` + 实现 `SCStreamOutput` trait → 回调里 `CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer` 取 PCM → 走现有 `system-audio-chunk` 事件 | **2-3 天**（难点：`SCStreamOutput` 协议的 objc2 trait 实现与 CMSampleBuffer 内存管理；objc2 官方有 `screencapture-kit` 示例可参考） |
| **截屏（CGDisplayStream）** | objc2-core-graphics / core-graphics crate：`CGDisplayStreamCreateWithDispatchQueue` → 帧回调拿 IOSurface → `CGImageDestinationCreateWithData` 编 JPEG。授权用 `CGPreflightScreenCaptureAccess` | **1 天**（纯 C API，无 ObjC 对象生命周期问题） |
| **截屏授权** | 同上两个 C 函数，填实现有三条 no-op 命令 | **小时级** |
| **防捕获** | objc2-app-kit：`window.setSharingType(NSSharingTypeNone)` | **小时级**（selector 已在 objc2-app-kit） |
| **浮窗窗口** | tao/tauri 已提供 NSPanel + `set_ignore_cursor_events`；剩余 selector（setLevel/collectionBehavior 等）objc2-app-kit 直接有 | **半天**（按 `window_ops::macos` 的 selector 清单对抄） |
| **全局热键** | `tauri-plugin-global-shortcut` 的 mac 后端（Carbon）已工作，`UCKeyTranslate` 细节在 global-hotkey crate 里 | **0** |

总计约 **4-5 个工作日**，全部在 Rust 内完成；对比照抄 Swift 方案还需要
维护 Xcode 工具链、双架构 dylib 构建、C ABI 桥接与加载失败兜底——
纯 Rust 方案反而是**总成本更低**的那条路。

### 3.3 唯一需要 Swift/objc2 注意的事

- **SCStreamOutput 协议**：objc2 需要手写 `unsafe impl ProtocolType` +
  decl 注册。objc2 0.6 的 `define_class!` 宏支持协议实现，社区有
  `screencapturekit-rs` 类似实现可参考，非不可逾越。
- **CMSampleBuffer 生命周期**：回调里 `CMSampleBufferGetAudioBufferList...`
  在 buffer 有效期内完成拷贝即可（原版 Swift 也是这么做的：`sampleBufferToPcm16`
  同步转换后立即返回）。
- **最低系统版本**：SCStream 音频采集（`setCapturesAudio:`）需要 **macOS 13+**；
  原版 `LSMinimumSystemVersion` 写 10.13，但音频功能在 13 以下不可用
  （原版同样受此限制，CoreAudio Process Tap 则要 14.4+，原版没用它）。

---

## 4. 结论

1. **不是必须用 Swift。** 原版 7 个 mac 功能点里 6 个已是纯 Rust/纯 C；
   唯一的 Swift dylib 只包了 SCStream 一层皮，API 面对 Rust 完全开放。
2. 本仓库 mac target 的依赖树里 **objc2 全套已存在**（tauri/wry/tao 传递引入），
   纯 Rust 方案不引入新构建链；反倒是 Swift 方案需要 Xcode + 双架构 dylib 构建。
3. 纯 Rust 迁移总工作量约 4-5 天，低于维护 Swift 桥的成本。
4. 具体到复刻范围：浮窗窗口层和热键已由 tao/tauri 插件覆盖（零工作）；
   截屏 + 授权是小时级；SCStream 音频是唯一的大头（2-3 天），
   且产出直接对接现有 `system-audio-chunk` 事件面，前端零改动。
