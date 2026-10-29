# 在 Windows 上开发 macOS 适配

## 实现边界（2026-10-29）

我们维护的应用代码使用 Rust 和现有 TypeScript。允许选用内部编译 Swift 的 Rust 依赖，不要求整个依赖树都没有 Swift。应用继续共用一个仓库和业务层，平台实现由 Cargo 目标条件隔离。

系统音频优先评估 `screencapturekit` 的 Rust 接口，由依赖管理 ScreenCaptureKit 桥接；窗口操作和权限按需要直接调用系统接口。选依赖时仍需检查版本、最低系统版本、回调所有权、启动/停止超时以及两个架构的构建，不能因为提供 Rust 接口就假定可靠性已验证。

该库已下载检查的版本为 11.1.1，尚未加入应用依赖。其 `build.rs` 会调用 Apple 的构建工具，并依据 Cargo 目标架构选择 Swift triple。在线主分支文档与该版本的最低部署目标描述存在差异，实施采集时必须以锁定版本的源码和两架构构建结果为准。不能只根据在线 README 推断打包要求。

## 当前已经接入

- Mac 的录屏权限查询调用 `CGPreflightScreenCaptureAccess`。
- 用户主动申请时才调用 `CGRequestScreenCaptureAccess`，随后重新检查实际权限；拒绝、仍待授权或需重启时不返回成功。
- 打开录屏设置使用固定的系统设置地址，只表示设置入口是否成功打开，不代表授权完成。
- Windows 保留原有无需逐应用录屏授权的行为。其他尚未适配的平台不再默认报告已授权。
- Info.plist 增加屏幕与系统音频采集用途说明。用途说明本身不授予权限。

这里只完成权限命令和验证底座。Mac 系统收音、截图、浮窗交互尚不能据此视为已实现；前端也尚未接入这三条权限命令。下一步在接入采集时完成权限提示和失败恢复流程。

## 验证分工

| 环境 | 验证内容 | 结果的边界 |
| --- | --- | --- |
| 当前 Windows 工作区 | 公共逻辑、权限流程单测、前端构建、Windows 原生回归 | 不执行 Apple API，不证明 Mac 采集可用 |
| Windows 上的 Mac Rust 目标检查 | 不依赖 Apple SDK 的独立模块可生成两架构 metadata | 只检查 Rust 类型，不完成 Apple 框架/Swift 链接 |
| macOS 构建环境 | Apple Silicon / Intel 的原生编译与链接、plist 检查、DMG 打包 | 无图形会话的构建不代替录屏授权和真实会议测试 |
| 真实 Mac | 首次允许/拒绝授权、系统收音、截图、多屏、浮窗、休眠与恢复 | 按实际设备和系统版本记录结果 |

只安装 `aarch64-apple-darwin` / `x86_64-apple-darwin` Rust 标准库，不会让 Windows 自动拥有 Xcode、Apple SDK 或 Swift 的 macOS 构建环境。日常 Windows 开发不要求安装 Swift；将来采集依赖只放入 macOS 的 target dependencies，相关模块也用 `#[cfg(target_os = "macos")]` 隔离。

新增 `.github/workflows/macos-check.yml`，在拉取请求或手动触发时检查两个 Mac 目标的编译和链接，不发布版本；现有 release 工作流继续负责 DMG 打包。本地准备工作流不代表已经在远端执行，不在未获授权时推送或触发远端任务。

## 后续采集接入

1. 锁定采集库版本和 feature，统一应用与依赖的最低系统版本。
2. 独立管理音频与截图会话；回调仅复制数据并进入有界队列。
3. 校验实际 PCM 格式，转换成现有 PCM16 / 16kHz / 单声道事件；测试启动取消、停止后迟到回调、溢出与流中断。
4. 在 Mac 构建环境验证两个架构的 Swift 桥和 Rust 主程序能够链接，再在真实 Mac 验收权限和采集。

参考：[采集库源码与构建说明](https://github.com/doom-fish/screencapturekit-rs)、[Apple 录屏权限检查](https://developer.apple.com/documentation/coregraphics/cgpreflightscreencaptureaccess())、[后续功能分析](macos-next-steps.md)。此前分析中的自行维护 Swift 桥属于备选方案，以本文的实现边界为准。
