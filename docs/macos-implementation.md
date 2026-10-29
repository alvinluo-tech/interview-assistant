# macOS 端实现分析（基于 DMG 逆向）

> 分析对象：`mianling-exam-0.3.16-macos-universal(1).dmg`
> 方法：自写解析器解包 DMG（UDIF/koly → blkx → zlib → HFS+ catalog B 树遍历），
> 提取 `.app` 全部内容，对 universal 二进制的两个 slice（x86_64 / arm64）做符号与字符串取证。
> 所有结论都有二进制内符号 / 路径 / 常量佐证，证据索引见文末。

---

## 0. 交付物结构

```
DMG (UDIF, koly v4, UDZO/zlib 压缩, 17.8MB)
└─ GPT → Apple_HFS+ 分区（80.7MB, 4KB block, 7 files / 7 folders）
   ├─ .VolumeIcon.icns（卷图标）
   ├─ Applications（符号链接 → /Applications）
   └─ 面灵AI.app/
      ├─ Contents/Info.plist          (1.4KB)
      ├─ Contents/CodeResources       (1.6KB)
      ├─ Contents/_CodeSignature/CodeResources (2.4KB)
      ├─ Contents/MacOS/app           (52.7MB, universal)
      └─ Contents/Resources/icon.icns (221KB)
```

Info.plist 关键声明（决定 mac 权限弹窗与进程形态）：

| 键 | 值 | 作用 |
|---|---|---|
| `CFBundleIdentifier` | `com.mianlingai.exam` | 与 Windows 端一致 |
| `CFBundleExecutable` | `app` | |
| `LSUIElement` | **true** | 不显示 Dock 图标（配合 TransformProcessType 动态切换，见 §4） |
| `NSScreenCaptureUsageDescription` | 用于在笔试时截取题目页面并发送给 AI 解题 | 触发 macOS 屏幕录制授权弹窗 |
| `NSMicrophoneUsageDescription` | 用于「语音提问」…录音…识别成文字 | 触发麦克风授权弹窗 |
| `LSRequiresCarbon` | true | |
| `LSMinimumSystemVersion` | 10.13 | |

`MacOS/app` 是 **universal binary**（fat，两个 slice）：

| slice | cputype | 大小 | magic |
|---|---|---|---|
| 0 | `0x1000007` (x86_64) | 27.3MB | `cffaedfe` |
| 1 | `0x100000c` (arm64) | 25.5MB | `cffaedfe` |

两个 slice 内容基本一致（wry/WKWebView + objc2 + swift bridge），以下分析在两个 slice 上交叉验证过。

---

## 1. 系统音频采集（会议软件对方的声音）

**结论：mac 上不使用 WASAPI 等价物（macOS 没有 loopback），改用 ScreenCaptureKit 抓系统音频，
实现放在一个独立的 Swift dylib 里，主程序运行时动态加载。**

### 1.1 独立 Swift 桥接库

主二进制里内嵌了一个 Mach-O dylib（arm64 slice 内偏移 13797947 处有完整 `MH_DYLIB` 头，
`cputype=0x100000c, filetype=6`），构建路径字符串泄露了它的来历：

```
src-tauri/target/aarch64-apple-darwin/release/build/app-<hash>/out/libmianling_system_audio.dylib
```

运行时加载逻辑（主二进制内错误信息）：

```
load macOS audio bridge failed: libmianling_system_audio_<arch>.dylib
```

即：主进程把内嵌的 dylib 按架构（x86_64/arm64）写到磁盘，再用 `libloading` 式的
`dlopen` 加载，取两个 C 导出符号：

```
_mianling_system_audio_start   // 启动采集
_mianling_system_audio_stop    // 停止采集
```

跨语言回调约定（从 Swift 符号表还原）：

```
SystemAudioStart:  (UnsafeMutablePointer<UInt8>?, Int32) -> Void  → i32   // start(参数指针, 长度) -> 错误码
SystemAudioStop:   (UnsafeMutablePointer<UInt8>?, Int32) -> Void
SystemAudioCapture.callback: (UnsafeMutablePointer<UInt8>?, Int32) -> Void
// 即 Rust 侧注册一个 C 回调，Swift 侧把 PCM 字节指针 + 长度（或错误码）推过来
```

这与 Windows 侧 `system-audio-chunk {volume, pcmBase64}` 事件面的数据形态一致：
Rust 层拿到 PCM 后走同一条事件通道发给 webview，所以**前端管线零改动**。

### 1.2 Swift 类 `SystemAudioCapture`（模块 `mianling_system_audio`）

从 ObjC 元数据与 Swift mangled symbols 还原的完整接口：

```swift
class SystemAudioCapture: NSObject, SCStreamDelegate, SCStreamOutput {
    var stream: SCStream?
    var queue: DispatchQueue          // sampleHandlerQueue
    var started: Bool
    var callback: (UnsafeMutablePointer<UInt8>?, Int32) -> Void

    func start()   // → SCStartCaptureWithCompletionHandler 流程
    func stop()
    // SCStreamDelegate
    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
                ofType type: CMSampleBufferType)
    // PCM 转换
    func sampleBufferToPcm16(_ buffer: CMSampleBuffer) -> [UInt8]?
}
```

用到的 ScreenCaptureKit / CoreMedia API（二进制内实引符号）：

| API | 用途 |
|---|---|
| `getShareableContentExcludingDesktopWindows:onScreenWindowsOnly:` | 枚举可采集内容 |
| `initWithFilter:configuration:delegate:` | 建 SCStream（SCContentFilter + SCStreamConfiguration） |
| `initWithDisplay:excludingWindows:` | **按显示器建 filter 并排除指定窗口**（见 §3） |
| `setCapturesAudio:` / `setChannelCount:` / `setSampleRate:` / `setQueueDepth:` / `setMinimumFrameInterval:` | 流配置（音频+视频可同流） |
| `setExcludesCurrentProcessAudio:` | **排除本进程自己的声音**（防 AI 回声进转写，对应 Windows 侧的回声处理需求） |
| `addStreamOutput:type:sampleHandlerQueue:error:` | 注册 SCStreamOutput 回调 |
| `startCaptureWithCompletionHandler:` / `stopCaptureWithCompletionHandler:` | 启停 |
| `CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer` | 从 CMSampleBuffer 取 PCM |
| `CMAudioFormatDescriptionGetStreamBasicDescription` | 读采样率/声道/位深 |

与 Windows 实现的对照：

| | Windows | macOS |
|---|---|---|
| 机制 | WASAPI loopback（默认播放设备 + 可选多端点混音） | **ScreenCaptureKit** `SCStream` 音频轨 |
| 采样率 | 16kHz/16bit/mono（自行重采样） | `setSampleRate:` 直接配（SCStream 原生降采） |
| 自声排除 | 前端/服务端处理 | `setExcludesCurrentProcessAudio` 系统级排除 |
| 授权 | 无需 | 需要**屏幕录制**权限（TCC），见 §2.3 |
| 交付形态 | Rust 直接 WASAPI COM | Swift dylib → C ABI 回调 → Rust |

选择 dylib 而不是直接在 Rust 里调 objc2 的原因：Swift 对 SCStream 的
delegate/async completion 封装远比 objc2 手写 bind 简单，且 `swiftCoreAudio.dylib`
等 Swift 运行时符号出现在依赖列表里（`/usr/lib/swift/libswiftCoreAudio.dylib`）。

---

## 2. 截屏（题图识别用）

**结论：两条路径，按能力开关降级——普通路径用 CoreGraphics `CGDisplayStream`，
兼容路径用 ScreenCaptureKit `SCStream`；输出统一 JPEG。**

### 2.1 普通路径：CGDisplayStream

实引符号：

```
CGDisplayStreamCreateWithDispatchQueue / CGDisplayStreamStart / CGDisplayStreamStop
CGPreflightScreenCaptureAccess / CGRequestScreenCaptureAccess
CGImageDestinationCreateWithData / CGImageDestinationAddImage / CGImageDestinationFinalize
CGGetActiveDisplayList / CGMainDisplayID / CGDisplayPixelsWide
```

Rust 侧函数（mangled symbol 完整可读）：

```
app_lib::capture::macos::capture_screen_jpeg
___mianling_capture_display_stream_block_invoke      // display stream 回调 block
_mianling_capture_display_stream                     // 流对象/上下文符号
```

流程还原：`CGDisplayStreamCreateWithDispatchQueue`（1fps 足够，按需起停）
→ block 回调里拿 `IOSurface` → `CGImageDestinationCreateWithData(public.jpeg)` 编码
→ base64 → 返回给 webview（与 Windows 的 `cmd_capture_screen` PNG dataURL 同一命令面，
mac 上格式为 JPEG）。`CGPreflightScreenCaptureAccess` / `CGRequestScreenCaptureAccess`
直接对应前端已有的 `cmd_check_screen_capture_permission` / `cmd_request_screen_capture_permission`
—— 这两条命令在 Windows 上是 no-op，在 mac 上是真实的 TCC 权限检查/申请；
被拒后前端已有的 `cmd_open_screen_recording_settings` 打开系统设置。

### 2.2 兼容路径：SCStream（sharedSurface）

对应前端能力开关 `macos-display-stream-capture`（0.3.10）与设置页文案
"普通截图无法读取题目时开启。截图时本应用窗口短暂隐藏后恢复…"。
SCStream 路径同样支持视频帧输出（`outputVideoEffectDidStartForStream:` 等回调存在），
即**音频与截屏共用同一条 SCStream 管线**，按需启用视频轨。

### 2.3 授权交互

Info.plist 的 `NSScreenCaptureUsageDescription` 提供授权弹窗文案；
首次 `CGRequestScreenCaptureAccess` 触发系统弹窗；`CMIO/ScreenCaptureKit` 的授权状态
由 TCC 管理。这解释了 Windows 版里那些"看似 no-op"的权限命令在 mac 上的真实作用。

---

## 3. 防屏幕捕获（录屏/共享中隐藏浮窗）

**结论：mac 上用 `NSWindow.sharingType` 实现，Windows 的 `SetWindowDisplayAffinity`
（代码里内部就叫 WDA）在 mac 上没有对应 API，两条平台分支在 `window_ops` 里分开实现。**

证据链：

1. `app_lib::window_ops::macos` 模块存在（mangled symbol 可读）。
2. mac 窗口样式日志（与 Windows 的 `overlay ex-styles applied (TRANSPARENT|LAYERED|…)` 对应）：

   ```
   macOS overlay native styles: level= , styleMask=0x , collectionBehavior=0x , sharingType=
   ```

3. ObjC selector 列表里成串出现 `setSharingType:`、`collectionBehavior`、`setLevel:`、
   `setStyleMask:`（objc2_app_kit generated bindings）。
4. Windows 语义的日志串在 mac 二进制里**保留**（`main capture excluded`、
   `overlay set_capture_excluded failed`、`clear WDA failed`、
   `WDA cleared (dev bypass)`）—— 说明 `set_capture_excluded` 是**跨平台命令**，
   mac 分支内部把它翻译成 `setSharingType:`。`NSWindowSharingNone`
   （`sharingType = .none`）即让窗口对屏幕采集（ScreenCaptureKit、CGWindowList、
   各种会议软件的屏幕共享）不可见。
5. 开发旁路：环境变量 `MIANLING_NO_WDA` + 旗标文件 `C:\dev\skip-wda.flag`
   （串在 mac 二进制里，跨平台代码复用同一开关名），旁路时打
   `WDA cleared (dev bypass / demo-visible mode)` —— 对应设置页的「演示可见模式」。

SCStream 路径还有第二重排除：`initWithDisplay:excludingWindows:` 在构造
SCContentFilter 时直接把本 app 窗口从采集内容里去掉（对走 SCK 的采集器生效）。
两条机制叠加：`sharingType=.none` 挡住"别人来采我"，`excludingWindows` 保证
"自己采屏幕时不带自己"。

---

## 4. 浮窗窗口行为（透明/置顶/穿透/跨空间）

mac 浮窗由 tao（`vendor/tao-0.35.3/src/platform_impl/macos/window.rs`，类名 `TaoPanel`/`TaoWindow`）
创建，再用 `window_ops::macos` 做后处理。全部通过 objc2 发送 selector：

| selector | 目的（对应 Windows 侧） |
|---|---|
| `setLevel:` | 置顶层级（Windows 的 TOPMOST；日志里打印 level 值） |
| `setStyleMask:` | 无边框/非激活样式（对应 WS_EX_LAYERED|NOACTIVATE|TOOLWINDOW） |
| `setFloatingPanel:` + `setBecomesKeyOnlyIfNeeded:` | **NSPanel 浮动面板**：不抢焦点（Windows 的 `set_focusable(false)` 等价） |
| `setIgnoresMouseEvents:` | 点击穿透开关（zones/interactive 切换，与 Windows `set_ignore_cursor_events` 同面） |
| `setAcceptsMouseMovedEvents:` | 穿透模式下仍收 mouse-move（原生光标命中检测需要） |
| `setCollectionBehavior:` | `canJoinAllSpaces` 等位掩码：浮窗跨全部 Space（Windows 的 TOPMOST 天然跨虚拟桌面，mac 必须 collectionBehavior 显式声明） |
| `setSharingType:` | §3 的捕获排除 |
| `setHidesOnDeactivate:` / `setCanHide:` / `setOpaque:` / `setHasShadow:` / `setAlphaValue:` / `clearColor` + `setBackgroundColor:` | 透明底、失焦不隐藏、无边框阴影控制 |
| `addChildWindow:ordered:` | 子窗口跟随（如原生 OSD/配色确认浮层） |
| `isMovableByWindowBackground:` | 整窗可拖 |
| `sendEvent:`（TaoWindow 覆写） | 原生级事件拦截（对应 Windows 的光标轮询命中，mac 上可走事件而非轮询） |
| `CGShieldingWindowLevel` / `CGWarpMouseCursorPosition` | 层级参照/光标定位（cursor feed 用） |
| `NSVisualEffectView`（`ns_visual_effect_view_tagged.rs`） | 半透明材质（Windows 用 SetLayeredWindowAttributes alpha） |

另有两个相关符号：`OVERLAY_SHOW_SEQ`、`OVERLAY_LOGICAL_VISIBLE`（窗口状态跨进程/跨模块常量，
与 Windows 版 `overlay_show_seq` 同面）。

`sendEvent:` 覆写值得注意：Windows 上 zones 命中是主进程 **16ms 轮询 GetCursorPos**；
mac 版在 NSPanel 子类里覆写 `sendEvent:`，可以事件驱动地拿到鼠标移动，
配合 `setAcceptsMouseMovedEvents:` 在穿透态依旧收到 move —— 这是 mac 上
悬停驻留交互更可能的实现路径（二进制里两者符号都有，最终取舍在 `window_ops` 运行时逻辑）。

---

## 5. 全局热键

| | Windows | macOS |
|---|---|---|
| API | `RegisterHotKey`（tauri-plugin-global-shortcut / global-hotkey crate） | **Carbon `RegisterEventHotKey` / `UnregisterEventHotKey`**（同 crate 的 mac 后端） |
| 键位解析 | VK 码 | `TISGetInputSourceProperty` / `UCKeyTranslate` / `LMGetKbdType`（按当前键盘布局把 virtual key 转码） |
| 辅助 | — | `TransformProcessType`（LSUIElement 应用动态显隐 Dock 图标） |
| 事件监听 | — | `CGEventTapCreate` / `CGEventTapEnable` 存在于二进制（用于需要拦截而非仅注册的场景，如恐慌键的全局性保证） |

前端 18 动作 + panic 键的命令面（`cmd_set_action_hotkeys` 等）不变。

---

## 6. 其余平台组件确认

- **native_osd（原生笔试窗口）在 mac 上同样存在**：arm64 slice 里有
  `src/native_osd/mod.rs`、`app_lib::native_osd::socket::UiEvent` —— 即 §1.3 所述的
  「独立进程 + socket 协议」架构是跨平台的，mac 版窗口层换成 NSPanel/DirectWrite 的
  等价物（CoreText/CoreGraphics）。
- **网络中继**：`src/network_relay.rs` 存在（Windows 的 `cmd_network_connect/send/close`
  同源），配合能力门控 `native-network-relay`。
- **webview 层**：WKWebView（`src/wkwebview/{mod,navigation,drag_drop,download}.rs`），
  tauri 的 `tauri_runtime_wry`。Windows 的 WebView2 特有逻辑（`webview_health` 盯 pid、
  `BrowserProcessExited`）在 mac 上不存在对应物——WKWebView 崩溃处理走
  `webview_crash.rs` 的跨平台部分。
- **图形栈**：`metal`/`MTKView` 符号各 1 处（WKWebView 合成层内部依赖，非应用自绘）；
  应用侧绘制走 WebKit。

---

## 7. Windows ↔ macOS 实现对照总表

| 功能 | Windows | macOS | 前端影响 |
|---|---|---|---|
| 系统音频采集 | WASAPI loopback（Rust 内联 COM） | **SCStream 音频轨**（Swift dylib `mianling_system_audio`，C ABI start/stop/callback） | 无（同一 `system-audio-chunk` 事件） |
| 自声排除 | 无系统级（靠回声处理） | `setExcludesCurrentProcessAudio` | 无 |
| 截屏 | GDI BitBlt → PNG dataURL | **CGDisplayStream** → JPEG；兼容路径 SCStream | 命令同名；mac 返回 JPEG |
| 截屏授权 | no-op | `CGPreflight/RequestScreenCaptureAccess` + TCC + Info.plist 文案 | 前端已有命令真实生效 |
| 防捕获 | `SetWindowDisplayAffinity`（WDA_*） | `NSWindow.setSharingType:(.none)` + SCContentFilter `excludingWindows:` | `cmd_set_capture_excluded` 跨平台 |
| 浮窗窗口 | WS_EX_LAYERED\|NOACTIVATE\|TOOLWINDOW\|TOPMOST | NSPanel + `setLevel/setStyleMask/setFloatingPanel/setBecomesKeyOnlyIfNeeded/setCollectionBehavior` | `cmd_apply_overlay_styles` 跨平台 |
| 点击穿透 | `set_ignore_cursor_events` + 光标轮询 | `setIgnoresMouseEvents:` + `setAcceptsMouseMovedEvents:` + `sendEvent:` 覆写 | zones 机制相同 |
| 全局热键 | `RegisterHotKey` | Carbon `RegisterEventHotKey`（+ `UCKeyTranslate` 布局转换） | 键位面相同，徽标显示 `⌘⇧↑` |
| Dock 图标 | — | `LSUIElement=true` + `TransformProcessType` 动态切换 | — |
| 原生笔试窗口 | 独立进程 + launch-config 文件 | 同架构（`native_osd::socket::UiEvent` 在 mac slice 内） | 同一命令面 |
| 网络中继 | `cmd_network_connect/send/close` | 同（`src/network_relay.rs`） | 同 |
| WebView | WebView2（wry） | WKWebView（wry/wkwebview 模块） | — |

---

## 8. 对本复刻项目的参考价值

如果要在本复刻里补 mac 端，按依赖顺序：

1. **窗口层**（最薄）：tao/tauri 已提供 NSPanel 与 `set_ignore_cursor_events`，
   `window_ops::macos` 的 selector 列表可直接照抄语义（level/styleMask/collectionBehavior/sharingType）。
2. **全局热键**：`tauri-plugin-global-shortcut` 的 mac 后端就是 Carbon EventHotKey，零额外工作。
3. **截屏**：`CGDisplayStream` 路径用 objc2-core-graphics 即可（无需 Swift），
   权限走 `CGPreflightScreenCaptureAccess`，把现有 no-op 的三条权限命令填实。
4. **系统音频**（最厚）：两条路——
   a. 照抄原版：Swift dylib + SCStream（需要 Xcode 工具链构建 Swift 产物，双架构）；
   b. 纯 Rust：objc2-screen-capture-kit 绑定（SCStream + CMSampleBuffer → PCM），
      省掉 dylib 加载层，但 delegate/async 处理代码量大。
   回调 ABI（指针+长度）与本复刻现有 `system-audio-chunk` 事件面完全兼容。
5. **防捕获**：`setSharingType:` 一行（objc2-app-kit）；Windows 侧已按同面命令实现。

---

## 9. 证据索引（全部来自两个 slice 的可打印符号/字符串）

| 证据 | 含义 |
|---|---|
| `koly` @ 文件尾、`mish` blkx 头、`0x80000005` chunk 类型（大端） | DMG = UDIF v4，UDZO/zlib |
| `H+`、`blockSize=4096`、catalog extents `194+64` | HFS+ 卷解析依据 |
| Info.plist 全文（`NSScreenCaptureUsageDescription` 等） | 权限文案与 LSUIElement |
| fat header：`0x1000007`/`0x100000c` 两 slice | universal |
| `_TtC21mianling_system_audio18SystemAudioCapture`、`SCStreamDelegate`/`SCStreamOutput` 协议 | Swift 音频采集类 |
| `setExcludesCurrentProcessAudio:`、`setCapturesAudio:`、`setSampleRate:`、`initWithDisplay:excludingWindows:` | SCK 配置面 |
| `CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer`、`CMAudioFormatDescriptionGetStreamBasicDescription`、`sampleBufferToPcm16` | PCM 提取 |
| `_mianling_system_audio_start` / `_stop`、`load macOS audio bridge failed: libmianling_system_audio_<arch>.dylib` | dylib 桥与加载 |
| `src-tauri/target/aarch64-apple-darwin/release/build/app-<hash>/out/libmianling_system_audio.dylib` | dylib 构建来源 |
| `app_lib::capture::macos::capture_screen_jpeg`、`___mianling_capture_display_stream_block_invoke`、`CGDisplayStreamCreateWithDispatchQueue/Start/Stop` | CGDisplayStream 截屏 |
| `CGPreflightScreenCaptureAccess` / `CGRequestScreenCaptureAccess`、`CGImageDestination*`、`public.jpeg` | 截屏授权与 JPEG 编码 |
| `macOS overlay native styles: level= , styleMask=0x , collectionBehavior=0x , sharingType=` | 浮窗样式日志 |
| `setSharingType:`、`setFloatingPanel:`、`setBecomesKeyOnlyIfNeeded:`、`setIgnoresMouseEvents:`、`setAcceptsMouseMovedEvents:`、`setCollectionBehavior:` | NSPanel 行为 |
| `main capture excluded`、`clear WDA failed`、`MIANLING_NO_WDA`、`C:\dev\skip-wda.flag` | 跨平台 set_capture_excluded 保留 Windows 内部叫法 |
| `RegisterEventHotKey` / `UnregisterEventHotKey`、`TISGetInputSourceProperty`、`UCKeyTranslate`、`LMGetKbdType`、`TransformProcessType` | Carbon 热键 |
| `CGEventTapCreate` / `CGEventTapEnable` | 事件拦截 |
| `TaoPanel`、`vendor/tao-0.35.3/src/platform_impl/macos/window.rs`、`NSVisualEffectView` | tao 窗口层 |
| `src/native_osd/mod.rs`、`app_lib::native_osd::socket::UiEvent` | 原生笔试窗口跨平台 |
| `/usr/lib/swift/libswiftCoreAudio.dylib` 等 Swift 运行时依赖 | Swift 桥运行时 |

## 10. 解包正确性校对记录

初版提取脚本对 blkx chunk 表用了混合端序（type 读 LE、offset 读 BE），碰巧能解压
成功——因为 type=0x80000005（zlib）以 LE 读成 0x05000080 后被 try-zlib 兜底路径掩盖。
校对时用纯大端重读并全量重建了 8 个分区，确认：

| 校对项 | 结果 |
|---|---|
| koly dataChecksumType | 0（无校验和，无法用 CRC 验证 dataFork） |
| mish chunk 表端序 | 全大端：type=u32BE（0x80000005 zlib / 0x00000002 zero-fill / 0x00000001 raw） |
| chunk 解压长度 vs sectorCount×512 | 57/57 全部匹配（HFS+ 分区） |
| sector 覆盖 | 157696/157696 完整 |
| GPT Header CRC32 | 0x10a4a8a5 ✓ |
| GPT 数组 CRC32（128 条 × 128B） | 0x317ed4ae ✓，主备两份表逐字节一致 |
| HFS+ 五个特殊文件 extents 覆盖 | 全部 ✓（catalog 64 blocks 无 overflow） |
| 7 个文件「声明大小 vs extents 容量 vs 提取大小」 | 三方一致 ✓ |
| Mach-O 双 slice | magic/__TEXT/LC_SYMTAB/17 个 LC_LOAD_DYLIB 均有效 |
| arm64 slice 交叉验证 | 14/14 关键符号与 x86_64 一致 |

## 11. 签名与分发形态

- 主二进制带 LC_CODE_SIGNATURE（x86_64: 222KB / arm64: 60KB blob），解析 CodeDirectory：
  flags = 0x10000（CS_ADHOC）、teamOffset = 0（无开发者 TeamID）、
  identifier = com.mianlingai.exam。即 ad-hoc 签名——无 Gatekeeper 公证，
  首次打开需右键菜单选「打开」绕过。
- _CodeSignature/CodeResources 仅含 Resources/icon.icns 一条（SHA-1/SHA-256
  与提取文件实际计算值逐一匹配 ✓）；MacOS/ 目录由主二进制的内嵌签名覆盖。
- 内嵌 Swift dylib 已从两个 slice 中切出（x86_64 版 57KB），确认：
  安装名 .../build/app-91370d057bcd2794/out/libmianling_system_audio.dylib、
  导出 _mianling_system_audio_start/stop、
  ObjC 类 SystemAudioCapture（bundle 标识 com.mianlingai.system-audio）
  的 16 个 selector 全部在列（§1.2 接口表逐项核实）。

## 12. 构建链路版本（符号串提取）

| 组件 | 版本 |
|---|---|
| tauri | 2.11.2 |
| wry | 0.55.1（wkwebview 模块：mod/navigation/drag_drop/download） |
| tao | 0.35.3（TaoPanel/TaoWindow，platform_impl/macos/window.rs） |
| objc2 系 | objc2_app_kit / objc2_web_kit / objc2_foundation |
| Swift 运行时 | libswiftCoreAudio / libswiftAVFoundation / libswiftFoundation 等 |
