# macOS 后续实现建议与逆向结论复核

日期：2026-10-29。依据 `docs/macos-implementation.md`、当前工作区实现、原版 DMG 提取物和 Apple/Tauri 官方资料。本文件是实现分析，未将以下计划标记为已开发或已通过 Mac 实测。

## 1. 结论与平台范围

继续使用一个项目：React 界面、会话、BYOK、实时 ASR、作答和资料管理共用；Rust 命令保持统一，在原生层增加 macOS 实现。必要的 Swift 源码也放在本仓库，由 Mac 构建流程编译，不另开一个 Mac 应用项目。

建议将完整采集能力的最低版本定为 macOS 13：ScreenCaptureKit 的系统音频从 13.0 提供；14.0 及以上使用 SCScreenshotManager 按需截图，13.x 使用短时 SCStream 取首个有效帧。当前 `tauri.macos.conf.json` 声明 12.0，实施时要统一部署目标、Swift 编译目标、Rust 构建及发布说明。不能以原版 Info.plist 的 10.13 声明推断其全部功能支持 10.13。

若明确需要继续支持 macOS 12，应保留可用的基础功能并通过能力检测禁用系统收音；旧版本截图兼容作为单独需求评估，不让旧接口成为新实现的主路径。

## 2. 原文哪些可以采用，哪些需要修正

本次直接检查了 `_recon/dmg/slice-x64`、`slice-arm64` 和 `system_audio-x64.dylib`：两个主程序 slice 均含音频桥导出名、SCStreamOutput、排除本进程音频、截图函数、CGDisplayStream、sharingType 和窗口事件等相关符号；提取的 x64 音频 dylib 也包含 start/stop 和音频接口符号。这支持原文提出的技术方向，但不等于完成反汇编或真实调用链验证。

| 原文判断 | 复核意见及实现影响 |
| --- | --- |
| Swift 桥 + ScreenCaptureKit + Rust 音频事件 | 有较强符号证据，可作为实现方向。桥接源码、C 头文件和生命周期契约需要自行定义。 |
| 已还原完整 C ABI | 仅凭导出名、Swift 类型字符串不足以确认 C 参数顺序、回调类型、所有权和错误语义。不要直接拿文档签名调用原版 dylib。 |
| 音频与截图共用同一个 SCStream 实例 | 符号只能说明涉及相同框架，不能证明实例共用。新实现建议分开管理，截图失败不得关闭持续音频。 |
| `excludingWindows` 是防第三方捕获的第二重保护 | 它只控制本应用创建的采集流，不会修改第三方会议软件的过滤器。用于避免自己的截图包含自己的窗口。 |
| `sharingType = .none` 能让所有录屏看不到窗口 | 不成立。Apple 当前文档将它描述为旧常量，并明确不应将其用于隐藏采集内容。设置成功不能显示为“已验证防捕获”。 |
| 普通截图以 CGDisplayStream 为主 | 可作为对原版的观察，不能直接作为新项目的技术选型；Apple 已将相关创建接口标为弃用。新实现优先 ScreenCaptureKit。 |
| Tauri 自动提供可直接使用的 NSPanel | Tauri 提供原生窗口句柄和部分通用窗口方法；不能仅因依赖里存在 TaoPanel 就认为本应用窗口已是正确配置的 NSPanel。 |
| 有 `sendEvent:` 就能证明穿透时收到全部鼠标事件 | 仍需真机验证，尤其是 ignoresMouseEvents、焦点和跨 Space 组合。第一版可以使用明确坐标规则的受控光标采样。 |
| 热键零额外工作、捕获保护一行代码 | 插件可以复用，但键盘布局、冲突、按住/松开、主线程和状态回报均需验证；不能按代码行数估算完整工作量。 |
| `native_osd`/UiEvent 字符串证明 Mac 原生 OSD 已完整可用 | 证据不足，通用模块和字符串可能仍被编入。既有原版前端能力表还把 native-exam-window 列为 Windows 专属，应独立验证，不作为 Mac 首版依赖。 |

相关官方依据：[窗口共享标记](https://developer.apple.com/documentation/appkit/nswindow/sharingtype-swift.enum/none)、[过滤指定窗口](https://developer.apple.com/documentation/screencapturekit/sccontentfilter/init(display:excludingwindows:))、[已弃用的 CGDisplayStream 创建接口](https://developer.apple.com/documentation/coregraphics/cgdisplaystreamcreatewithdispatchqueue)。

## 3. 当前代码的实际缺口

| 模块 | 当前状态 | 下一步 |
| --- | --- | --- |
| `src-tauri/src/audio.rs` | 非 Windows 启动返回未实现；设备枚举返回空数组；公共音频事件已存在 | 加 Mac 会话实现，复用 emit_chunk 和既有事件 |
| `src-tauri/src/capture.rs` | 非 Windows 截图报错；三条录屏权限命令固定返回 true；返回 MIME 固定为 PNG | 接真实权限流程与 Mac 截图，保留 PNG 或按实际格式返回 MIME |
| `src-tauri/src/overlay.rs` | 交互切换有通用调用；光标获取、悬停轮询和跟随拖动仍是 Windows 分支 | 增加 Mac 坐标与交互实现，主线程操作窗口 |
| `src-tauri/src/protection.rs` | 非 Windows 重挂载直接跳过，设置操作报不支持；状态使用 Windows affinity | 分离“已请求设置”和“是否有可靠保护保证”，保留 Windows 原有语义 |
| `src-tauri/src/disguise.rs` | 通用 set_title 已存在，但 supported 和设置入口限制 Windows | Mac 开放标题设置；进程改名/图标资源改写继续按能力关闭 |
| `src/overlay/platform.tsx` | 热区按 outerPosition + DOM 坐标 × scaleFactor 计算 | 与 Mac 光标、窗口坐标统一，验证混合缩放和负坐标显示器 |
| `src-tauri/build.rs` | 只有 tauri_build，无 Swift 编译 | 增加仅 Mac 执行的桥接构建，按 Cargo TARGET 选择架构 |
| macOS 配置与发布 | 已有麦克风声明、钥匙串、两种架构 DMG 流程；当前为 ad-hoc 签名 | 增加屏幕采集用途声明、桥接产物/架构/签名校验和真机验收 |

代码现状与逆向文档必须分开记录：原版二进制存在某项能力，不代表本仓库已经实现。

## 4. 推荐的模块组织

以下为建议新增模块，不是当前已存在的实现：

```text
src-tauri/
  native/macos/
    CaptureBridge.swift       # SCStream、截图、异步回调
    CaptureBridge.h           # 自有 C ABI 与缓冲区/回调约定
  src/
    audio.rs                  # 原有命令、事件和跨平台会话管理
    audio_windows.rs          # 保留 WASAPI
    audio_macos.rs            # Swift 桥接会话、回调队列、停止/错误处理
    capture.rs                # 原有截图命令、结果格式与公共校验
    capture_macos.rs           # 显示器/窗口选择、截图请求
    macos_permissions.rs      # TCC 检查、申请、设置入口
    window_macos.rs           # 窗口样式、坐标转换、工作空间行为
    capabilities.rs           # 平台/系统版本/已实现能力
```

窗口样式优先使用 Tauri 已有接口；确需 AppKit 时通过原生句柄和主线程调用。只有验证普通窗口无法满足全屏、焦点与交互要求后，再评估 NSPanel 插件或受控的原生窗口实现。不要直接替换 Tauri 管理的窗口对象或照搬原版 vendor tao 修改。

## 5. 分阶段实施及验收

### 阶段 A：能力检测、权限与构建底座

- 新增一个平台能力查询命令，至少区分：系统音频、截图、窗口截图、跨空间浮窗、光标热区、标题设置、进程改名、捕获保护模式。
- 能力状态来自真实实现和系统版本，不只看“当前是 Mac”；权限单独查询，不等同于能力。
- 将当前三个权限存根替换为真实检查/申请/打开设置。申请由用户操作触发，不在启动时反复弹窗；拒绝后提供清楚的恢复路径。
- 补充 `NSScreenCaptureUsageDescription`，保留麦克风声明。Info.plist 文案不是授权成功的证明。
- 桥接优先在构建时链接；若使用 dylib，则按应用包内受控位置分发和签名，处理 rpath、架构与运行时依赖。不要优先复制“写临时目录后 dlopen”的方式。
- build.rs 只在 Mac 构建桥接。Intel 交叉构建必须使用 TARGET 对应的 Swift target，不得误用 runner 的 host 架构。

验收：Windows 构建不依赖 Swift；Mac 两架构能编译；权限拒绝与未授权不会被显示为就绪；应用身份和密钥存储不变。

### 阶段 B：系统音频 → 既有 Fun-ASR 流程

- Swift 创建独立的音频 SCStream，启用 capturesAudio、排除本进程音频，请求 16kHz/单声道。
- 仍读取每个 CMSampleBuffer 的实际格式，不能把配置成功等同于最终字节为 PCM16；处理浮点/整数、交错/非交错、多 buffer 和空包。
- 向 Rust 交付有明确时效与所有权的缓冲区；回调内只做必要复制和有界排队，不直接操作窗口或等待网络。
- Rust 输出既有格式：16kHz、单声道、有符号 PCM16 小端；每块 1600 采样点（100ms、3200 字节），音量复用 input_volume。
- 保留 system-audio-chunk / level / error 及现有返回契约；设备 UI 按真实 Mac 采集范围调整，不能把按应用/显示器采集伪装成 Windows 播放设备排除列表。
- 建立异步启动、运行、停止、失败状态；停止需等待回调退出或确保旧回调失效。取消启动后到达的迟到成功不能重启会话。
- 有界队列溢出应明确报错；设备/权限/流中断需可重试，旧音频不得注入新面试。持续静音仍按约定送零采样，保持实时识别心跳。

首版只做系统音频，不同时重写已有 WebAudio 麦克风，不做复杂应用音源选择。

验收：标准音频的时长与音高不变；真实会议播放能到达字幕；暂停/结束释放采集；自身 TTS 不反复进入识别；耳机切换、休眠恢复、拒绝授权和长时采集均有明确结果。

官方依据：[音频开关](https://developer.apple.com/documentation/screencapturekit/scstreamconfiguration/capturesaudio)、[采样率](https://developer.apple.com/documentation/screencapturekit/scstreamconfiguration/samplerate)、[排除自身音频](https://developer.apple.com/documentation/screencapturekit/scstreamconfiguration/excludescurrentprocessaudio)。注意：排除应用产生的音频不等于消除了麦克风拾取的扬声器回声。

### 阶段 C：按需截图

- macOS 14+ 优先 SCScreenshotManager；13.x 短时 SCStream 获取首个有效帧后停止。与音频会话分开，不因截图关闭音频。
- 接口保留屏幕/前台窗口，但原生层区分 scope 与 backend；不要把现有 Windows 的“兼容模式优先前台窗口”直接当成 Mac 采集后端选择。
- 在隐藏本应用窗口前先确定目标前台应用/窗口，防止隐藏动作改变目标。窗口模式失败不得静默扩大为整个屏幕采集。
- 自己的截图过滤 main、overlay、mock 等实际应用窗口；过滤只影响自己的采集。
- 截图完成等待使用异步结果与超时；窗口隐藏/恢复交给主线程，不能在主线程阻塞等待需要主线程回调的工作。
- 只有确实需要临时隐藏时才隐藏；使用请求代次与可见性状态，避免超时、应急隐藏或手机副屏接管后又误把窗口显示出来。
- 首版可继续输出 PNG，与当前 data:image/png 契约一致；若改 JPEG，必须一并返回正确 MIME。不得将 JPEG 字节套进 PNG data URL。
- 统一多屏范围、Retina 分辨率、图像尺寸限制和空白检测；未授权、黑屏、超时均不得继续提交 AI。

验收：多显示器和不同缩放下选区正确；截图不含应用自己的浮窗；能连续截图且不打断字幕；失败时窗口状态正确恢复。

官方依据：[SCScreenshotManager](https://developer.apple.com/documentation/screencapturekit/scscreenshotmanager)、[单帧截图](https://developer.apple.com/documentation/screencapturekit/scscreenshotmanager/captureimage(contentfilter:configuration:completionhandler:))。

### 阶段 D：浮窗、热区与标题

- 在统一窗口操作后增加 Mac 实现：置顶、透明、点击穿透、失焦显示、跨 Space/全屏行为，AppKit 操作均在主线程完成。
- 第一版沿用现有 zones/cursor-zone 契约，以受控频率采样光标；窗口隐藏或无交互需求时停止高频采样。确认基线后再考虑事件驱动优化。
- 定义唯一坐标契约。处理 AppKit 点坐标、Tauri 窗口/物理坐标、DOM CSS 像素及显示器方向转换；不能只乘一次 scaleFactor。
- 补当前 Mac 缺失的光标位置与跟随拖动；验证拖动停止、屏幕边缘、混合缩放显示器和手机副屏光标。
- Mac 标题设置复用现有 set_title；设置页称“窗口标题”，不声称更改系统进程身份。
- 不默认设置 LSUIElement=true：先保证托盘/菜单/快捷键/二次启动能可靠找回应用，再决定 Dock 显隐行为。
- 全局快捷键继续复用当前插件，验证 Command/Control 区分、布局、按住/松开、冲突与重启恢复；不因发现 CGEventTap 符号就新增事件拦截与额外权限需求。

验收：正文编辑时不被抢焦点；穿透/交互切换可恢复；全屏与多桌面下不会丢失窗口；应急隐藏与找回可靠；快捷键和坐标经过真实 Mac 测试。

官方依据：[Tauri 原生窗口与主线程方法](https://docs.rs/tauri/latest/tauri/window/struct.Window.html)。

### 阶段 E：保护状态与发布

- 将“自己的截图排除自身窗口”与“第三方捕获保护”作为不同状态。Mac 的窗口属性只能按已知限制提供尽力行为，不显示通用“防捕获已验证”。
- 保护状态不沿用 Windows affinity 数值。界面显示平台、所请求模式和限制；Windows 已有策略与回滚验证继续保留。
- 独立的 Apple Silicon / Intel DMG 足以完成首版，不要求立即合并 universal；当前发布脚本正是按两种架构检查和收集。
- 若未来制作 universal，需要将应用与桥接的所有架构一并合并，再重新签名；不能只合并主程序。签名资源存在也不等于已经公证。
- 正式分发时安排 Developer ID、Hardened Runtime 和公证流程，验证动态桥接依赖；不通过修改源码中一个 plist 字段宣称已经完成签名。
- 保留现有钥匙串；Windows DPAPI 密文不作为 Mac 密钥导入来源。品牌/应用标识迁移属于另一个独立变更。

## 6. 推荐执行顺序与首版范围

执行顺序：A（能力/权限/桥接编译）→ B（收音）→ C（截图）→ D（窗口与交互）→ E（保护状态与发布验收）。窗口初始化和最小置顶可以提前做，但优先证明音频与截图的数据链路，不以“保护标记设置成功”作为第一阶段成果。

首个可交付 Mac 版本：系统音频 + 麦克风原有功能 + Fun-ASR 持续字幕 + 屏幕/窗口截图 + 可找回的浮窗 + 标题设置 + 两架构 DMG。

暂不放进首版：独立原生笔试 OSD、运行时进程改名、复杂音频应用过滤、无条件跨所有软件的防捕获保证。

有稳定 Mac 测试条件、熟悉 Rust/Swift/异步生命周期的前提下，基础适配与回归可先按 10–15 个工作日评估；签名凭据、不同设备兼容和系统权限问题可能延长。应以各阶段验收结果更新估计，不将它当成固定交付承诺。

## 7. 验证分层和当前可完成的工作

| 环境 | 可验证内容 | 不能据此宣称的结果 |
| --- | --- | --- |
| 当前 Windows 工作区 | 公共状态机、PCM 格式/分包、取消与去重、前端能力门控、现有 Windows 回归 | Swift 编译通过、Mac 已授权、真实系统音频/截图正常 |
| macOS CI | Swift/Rust 两架构编译，ABI 链接，plist/架构/依赖/签名检查，DMG 校验 | 无 GUI runner 上已验证了 TCC 弹窗和真实会议收音 |
| 真实 Mac 图形会话 | 首次允许/拒绝授权、真实收音、耳机切换、截图、多屏、全屏、快捷键、休眠与长时稳定性 | 对未测试会议软件/版本的捕获保护保证 |

优先增补：音频启动后立刻停止、启动中取消、停止后迟到回调、音频与截图并发、截图期间应急隐藏、权限撤销和源显示器移除。平台适配必须同时回归 Windows，不能把非 Windows 分支统一改成 macOS 后破坏其他平台的明确降级。

当前仓库已经有较多其他功能的工作区改动。本次只新增这份分析，后续实施时应逐模块推进，保留现有修改，并让每阶段的测试与 Mac 真机证据可独立审阅。
