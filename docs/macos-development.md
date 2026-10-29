# macOS 适配实现与验收

更新日期：2026-10-29。开发主机为 Windows；下面区分已写入的实现、本机验证和仍待完成的 Mac 验收。

## 语言与项目边界

业务共用 React / TypeScript 和 Rust。我们维护的原生源码使用 Rust；允许依赖内部编译 Swift，不自行维护 Swift 桥或另建 Mac 应用。应用标识、用户设置及 Keychain 密钥存储保持原有方案。

`src-tauri/macos-capture` 是同一 Cargo workspace 中的内部 crate。媒体校验和选择逻辑可在 Windows 测试，Apple 依赖只在 macOS 目标启用。锁定 `screencapturekit = 11.1.1`，锁文件还包含 `apple-cf 0.11.7` 和 `apple-metal 0.10.4`，这些依赖在 Mac 构建时编译各自的 Swift 桥。Windows 依赖树不包含它们，不要求 Windows 安装 Swift 或 Apple SDK。

最低版本统一为 **macOS 13.0**。Mac 配置启用 Tauri 透明窗口所需的 `macOSPrivateApi`，仅在 Mac 目标启用对应 Cargo feature。签名仍为原有 ad-hoc 配置，尚未配置 Developer ID 或公证。

## 已写入的功能

| 功能 | 实现与行为 |
| --- | --- |
| 系统播放收音 | ScreenCaptureKit 独立音频流，请求 16kHz / 单声道，排除本进程产生的声音；不需要虚拟声卡 |
| 音频格式处理 | 读取实际采样率、声道、位深、大小端和交错布局；支持 float32/64、signed PCM16/24/32；输出 PCM16 / 16kHz / 单声道，每包 1600 点 |
| 静音和错误 | 静音送零采样心跳，不重放旧声音；队列有上限，溢出、异常中断和无效格式会报错；语音尾包在空闲后补零送出 |
| 启动、取消和恢复 | 后台启动；启动中可取消；停止使旧令牌失效；音频和错误事件携带 captureId，旧事件即使到达新监听器也会被过滤 |
| 屏幕截图 | 截取鼠标所在显示器，按当前进程过滤本应用窗口；输出 PNG data URL；校验尺寸、行跨度、像素和空白画面 |
| 窗口截图 | 按系统前后顺序选择最靠前、可见、普通层级的其他应用窗口；失败不会扩大成整屏截图 |
| 截图会话 | 单独的短时 SCStream 获取首个完整 BGRA 帧，兼容 macOS 13；不停止持续音频流；同时只处理一张截图 |
| 录屏权限 | 真实查询、主动申请、申请后重新确认、打开系统设置；启动采集前检查；拒绝授权不会报告就绪 |
| 权限界面 | 申请、打开设置、重新检查；窗口重新获得焦点时更新状态；用途文案不被当成授权依据 |
| 浮窗 | 透明、置顶、穿透、交互和聚焦切换；主线程配置跨 Space 和全屏辅助行为；隐藏或无需光标时降低轮询开销 |
| 悬停和拖动 | 复用 zones / cursor-zone / cursor-point；修正全局光标与窗口在混合缩放下的坐标差异；拖动代次隔离，应急隐藏取消拖动 |
| 窗口标题 | Mac 即时保存和恢复标题；不显示 Windows 进程副本改名及重启入口 |
| 共享限制 | 设置并读取 AppKit 旧窗口共享限制；界面标为尽力保护，不声称防止所有第三方录屏 |
| 构建 | 两架构分别编译打包；检查工作流准备 DMG 验收附件；正式发布仍由标签驱动 |

Mac 收音范围是系统播放声音，`devices` 返回空数组，由既有界面显示“系统播放声音”。播放设备排除列表属于 Windows 功能，不把显示器或应用采集范围伪装成声卡。麦克风继续使用既有 WebAudio 流程。

## 已验证与未验证

2026-10-29 首轮真实 Mac CI 在原生测试编译阶段失败：[运行记录](https://github.com/alvinluo-tech/interview-assistant/actions/runs/40809364863)。Tauri 构建校验只读取通用 `tauri` dependency，未合并目标条件中的 `macos-private-api` feature，因而报告 feature 与 Mac 配置不匹配。此失败发生在应用测试和 DMG 打包之前，不能视作 Mac 编译通过。

Windows 已执行前端构建、现有协议与音频回归、原生 workspace 单测、媒体/坐标/队列/取消测试、权限命令桥测试和依赖审计。额外使用浏览器模拟 Mac 原生命令，验证设置页的拒绝/允许授权、打开设置、标题保存、共享限制开关和说明，未出现页面运行错误。

本轮结果：前端及协议测试 105 项通过；Rust 测试 41 项通过，1 项需要真实 Windows 播放设备的测试跳过；媒体 crate 的 Windows Clippy 检查通过；生产前端依赖审计未发现已知漏洞。原有核心前端覆盖率门槛也通过，此结果不代表 Mac 原生代码的真机覆盖率。

采集 crate 已在 Windows 对两个 Mac 目标做 Rust 类型检查，使用文档构建开关 `DOCS_RS=1` 跳过本机不可执行的 Swift 编译。**这只验证 Rust 类型，未验证 Apple 框架、Swift 桥或完整应用的 Mac 链接；不能用该模式打包或发布。**

尚未在 Mac 执行完整构建、DMG 安装或真实采集。不能把 Windows 通过的结果表述为 Mac 已可用，也不能给出真机稳定性结论。

## 可复现检查

在 Windows 或 Mac 运行公共回归：

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm test:byok
pnpm test:audio
pnpm test:platform
cargo test --locked --manifest-path src-tauri/Cargo.toml --workspace --lib
```

在安装了 Xcode 工具链的 Mac 上真实构建（不设置 DOCS_RS）：

```sh
rustup target add aarch64-apple-darwin x86_64-apple-darwin
export MACOSX_DEPLOYMENT_TARGET=13.0
pnpm tauri build --target aarch64-apple-darwin --bundles dmg
pnpm tauri build --target x86_64-apple-darwin --bundles dmg
```

`.github/workflows/macos-check.yml` 在相关拉取请求或手动运行时执行原生测试、编译链接、DMG 打包和校验，上传两个架构的验收包，不创建 GitHub Release。本次只准备工作流，没有推送或触发远端任务。现有 release 工作流仍负责标签驱动的正式发布。

## Mac 真机验收清单

| 场景 | 通过标准 |
| --- | --- |
| 首次拒绝权限 | 不进入采集、不提交空图；显示尚未允许，并能进入系统设置 |
| 允许权限、重启后重试 | 依据实际权限更新状态；收音和截图可重新启动 |
| 会议播放和字幕 | 对方讲话到达原有 ASR，时长与音高正常；静音不生成字幕 |
| 本应用播放声音 | 本进程 TTS 不重复回灌；扬声器经麦克风拾取的回声另行测试 |
| 暂停、结束、快速重开 | 无旧音频或旧错误进入新会话；取消启动不会迟到恢复 |
| 截图与收音并发 | 不打断字幕，截图失败不关闭音频；自身浮窗不进入自己的截图 |
| 窗口截图失败 | 明确报错，不回退采集整个显示器 |
| 多屏和 Retina | 显示器选取正确；负坐标、混合缩放下热区与手机光标准确 |
| 穿透、编辑和拖动 | 可切换和恢复；旧拖动不干扰新拖动；隐藏后不继续移动 |
| 全屏与多个 Space | 不抢会议焦点，浮窗能显示、隐藏和找回 |
| 撤销权限、换耳机、休眠 | 不崩溃、不重放旧音频；错误明确，可暂停后重试 |
| Apple Silicon / Intel | 分别安装对应 DMG，验证架构、权限、采集、快捷键及长时运行 |
| 第三方共享 | 记录实际软件效果，不以共享属性设置成功推断通用防捕获 |

本实现不包含运行时修改 Mac 进程身份、Mac 原生笔试 OSD、复杂按应用音源选择、Developer ID/公证，以及对所有录屏软件的隐藏保证。

参考：[采集库源码](https://github.com/doom-fish/screencapturekit-rs)、[Apple 录屏权限](https://developer.apple.com/documentation/coregraphics/cgpreflightscreencaptureaccess())、[共享标记限制](https://developer.apple.com/documentation/appkit/nswindow/sharingtype-swift.enum/none)、[Tauri DMG 打包](https://v2.tauri.app/distribute/dmg/)。此前自行维护 Swift 桥的分析属于备选方案，以本文实现状态为准。
