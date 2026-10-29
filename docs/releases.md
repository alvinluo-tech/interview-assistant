# 自动打包与发布

`.github/workflows/release.yml` 在推送 `v*` tag 时运行，同时构建 Windows x64、macOS Apple Silicon 和 macOS Intel。Actions 页面也可手动运行 **Release Desktop**，输入仓库中已经存在的 tag。

## 首次启用

将本次工作流、发布脚本与测试、macOS 配置/权限文件、原生代码和锁文件一起提交到 GitHub 仓库。仓库须允许 GitHub Actions 运行；发布 job 已声明 `contents: write`，使用内置 `GITHUB_TOKEN`，不需要额外的 PAT 或 AI 密钥。

日常检查由 **Check Desktop** 执行，覆盖拉取请求和 main 推送；正式发布只由版本 tag 或指定已有 tag 的手动发布触发。缓存策略及耗时基线见 [CI 与缓存](ci.md)。

## 发版本

先提交本次版本的代码并推送，再创建并推送 tag，例如：

```bash
git tag -a v0.1.1 -m "Release v0.1.1"
git push origin v0.1.1
```

测试版本可以用 `v0.4.0-beta.1`、`v0.4.0-rc.1`，会自动标记为 Pre-release。tag 必须采用 `v主版本.次版本.补丁版本[-预发布后缀]`，不接受 build metadata；版本数值不能超过 Windows 打包允许的 65535。

CI 会在临时检出目录里同步 `package.json`、`tauri.conf.json`、`Cargo.toml`、`Cargo.lock` 的版本，再锁定依赖执行测试和构建。它不向源分支写回版本号，因此只打 tag 也能让程序和安装包显示正确版本。

## 下载产物

发布成功后，同名 GitHub Release 包含：

- `Mianxu_0.1.1_x64-setup.exe`：NSIS 安装包。
- `Mianxu_0.1.1_x64-portable.exe`：免安装 EXE；配置仍保存在系统用户目录，需要已安装 WebView2 Runtime。
- `Mianxu_0.1.1_arm64.dmg`：Apple Silicon（M 系列芯片）安装镜像。
- `Mianxu_0.1.1_x64.dmg`：Intel 芯片安装镜像。
- `SHA256SUMS.txt`：上述四个文件的 SHA-256 校验值。

三个构建任务分别完成版本检查、协议/音频测试、前端编译、原生测试和安装包构建后，才会进入发布 job。macOS 使用 GitHub 的 `macos-latest` runner，安装对应 Rust target，分别构建两种架构；采集产物时检查应用 Mach-O 架构，CI 同时运行 `hdiutil verify` 检查 DMG。先创建草稿、上传全部文件，最后公开，避免构建失败时发布空版本。每个构建任务保存独立校验文件，发布前重新验证，再合并为总 `SHA256SUMS.txt`，防止跨平台文件互相覆盖。

构建或上传失败时，可以在 Actions 中重新运行失败的 job；已经存在的 Release 会复用，上传时替换同名附件。若仓库开启了不可变 Release，已公开版本不能替换附件，应创建新版本 tag。构建产物还会在当前 Actions 运行里保留 14 天，便于发布失败后排查。

未配置 Windows 代码签名或应用自动更新。公开安装包只采集构建产物，不会包含本机的 AI 密钥、会话数据或 `_recon` 测试文件。

## macOS 安装与功能范围

最低 macOS 13。打开对应架构的 DMG，将「骆耀升老公酱面试助手.app」拖到 Applications 后运行。首次使用麦克风时允许访问；系统收音和截图还需允许屏幕录制权限，可在应用设置中检查并进入系统设置授权。

`src-tauri/Info.plist` 声明麦克风用途，`Entitlements.plist` 声明音频输入权限；`tauri.macos.conf.json` 自动覆盖 macOS 的打包格式、最低系统版本与签名选项。本地 Mac 也可用 `pnpm tauri build --target aarch64-apple-darwin --bundles dmg` 构建（Intel 改用 `x86_64-apple-darwin`）。Windows 无法直接生成本流程的 DMG，需由 macOS runner 构建。

当前使用 **ad-hoc 签名**，无需 Apple 开发者证书，但没有 Developer ID 签名及 Apple 公证，下载后可能被 Gatekeeper 阻止。信任来源后可按系统提示在「隐私与安全性」中选择「仍要打开」。面向普通用户正式分发前，应按 [Tauri macOS 签名文档](https://v2.tauri.app/distribute/sign/macos/) 配置 Developer ID 证书和公证，并替换 `signingIdentity: "-"`；当前工作流尚未接入这些凭据。

| 功能 | macOS 当前状态 |
| --- | --- |
| AI 服务、模型发现、自定义模型、流式回答 | 共用现有前端链路；API Key 通过钥匙串中的随机主密钥做 AES-256-GCM 加密，配置文件只存密文 |
| 模拟练习的麦克风与分段语音识别 | 已补权限声明，仍需在真实 Mac 授权并实测 |
| 系统声音采集 | 已接入 ScreenCaptureKit，排除自身进程音频；需真机验证权限与会议采集 |
| 截图识别 | 已接入屏幕与前台窗口截图，排除自身窗口；需真机验收 |
| 屏幕捕获排除 | 使用共享属性尽力处理，不能保证对所有第三方录屏软件隐藏 |
| 进程伪装 | 支持窗口标题设置；不支持修改 Mac 进程身份 |
| 浮窗光标悬停/跟随拖动 | 已实现，需真机多屏、缩放与全屏 Space 验收 |

钥匙串首次访问或应用更新后可能提示授权；拒绝授权时保存会报错，不会退回明文。Windows 的 DPAPI 配置不能直接复制到 Mac，需要重新填写 Key。当前本地验证环境为 Windows，macOS 原生编译、钥匙串集成测试与 DMG 验证由 CI 执行；首次 tag 发布后还需在真实 Mac 检查启动、录音、模型调用与安装体验。

## 本地验证

```bash
pnpm test:release
```

这会在独立临时目录验证 tag、版本同步、产物筛选和校验和，不修改当前工作区版本。`node scripts/release.mjs prepare vX.Y.Z` 是实际写入命令，只应在准备版本或 CI 检出目录使用。

参考：[Tauri GitHub Actions](https://v2.tauri.app/distribute/pipelines/github/)、[GitHub Release CLI](https://cli.github.com/manual/gh_release_create)。
