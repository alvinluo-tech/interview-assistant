# 窗口捕获排除与进程伪装

功能入口在「设置 → 隐蔽」。

## 屏幕捕获

- 默认对 `main`、`overlay` 的顶层 HWND 设置 `WDA_EXCLUDEFROMCAPTURE = 0x11`；关闭后设为 `WDA_NONE = 0`。
- `capture.excluded` 保存总开关。演示可见模式只保存在内存中，临时清除两个窗口的亲和性；关闭后恢复之前的设置。
- 启动时先应用策略再显示主窗口；页面加载、重新显示浮窗、刷新浮窗样式及二次启动唤回时重新应用。
- 批量切换会先读取各 HWND 的实际亲和性；某个窗口设置或持久化失败时，尝试恢复所有已经触及的 HWND，并返回具体错误。
- 状态页用 `GetWindowDisplayAffinity` 读取实际值，不能把开关勾选等同于操作成功。
- 开发旁路：存在 `MIANSHI_NO_WDA` 或兼容变量 `MIANLING_NO_WDA`，或存在 `C:\dev\skip-wda.flag` 时强制允许捕获。取消旁路后刷新策略或重启。
- `cmd_set_capture_excluded({ enable, label? })` 不传 label 时更新两个窗口并保存总开关；指定 `main` / `overlay` 时仅更新该窗口的本次运行策略。

Windows 10 2004 起支持排除语义；旧版系统可能按 `WDA_MONITOR` 显示黑块。不同采集软件的效果需要分别测试，亲和性不能防止外部摄像机拍摄。参见 [Microsoft SetWindowDisplayAffinity](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setwindowdisplayaffinity)。

## 进程伪装

1. 设置进程名和窗口标题，开启开关，点击「保存设置」。标题和通用程序图标立即应用于两个窗口。
2. 点击「重启应用使进程名生效」。原始 exe 被复制到 `%LOCALAPPDATA%\com.mianlingai.clone\disguise\<name>.exe`。
3. 只改写新建副本：文件描述、产品名、内部名、原文件名改为指定名称，版本设为 `1.0.0.0`；枚举并移除全部 `RT_ICON` / `RT_GROUP_ICON` 资源，保留应用清单等其他资源。
4. 子进程通过 `MIANSHI_DISGUISED=1`、`MIANSHI_REAL_EXE` 记录副本和原始路径；`origin.json` 支持之后直接打开副本时寻找原程序。
5. 重启子进程等待旧进程结束后再初始化 Tauri 单实例锁。副本或重启失败会保留当前程序，启动错误显示在设置页。
6. 关闭伪装并保存会立即恢复原窗口标题和图标；再重启回到原始 exe。进程名修改后也需要再次重启。

进程名只接受 1–40 个 ASCII 字母、数字、空格和 `- . _`，可带 `.exe`；拒绝路径分隔符、Windows 保留设备名、不合法的末尾字符。窗口标题限制为 1–128 字符且不接受控制字符。原始 exe 不被修改。改写副本的资源会改变副本哈希，并使原有数字签名失效。

正常退出和主动重启使用退出码 0，守护进程不再重拉；异常退出才恢复。项目尚未实现独立原生 OSD，所以没有报告中的 `ApplicationFrameHost.exe` 子进程。

## 验证

```powershell
pnpm build
cargo test --locked --manifest-path src-tauri/Cargo.toml --lib
pnpm tauri build --no-bundle
```

桌面验收：检查两窗口亲和性为 `0x11` → 开启演示后为 `0` → 关闭恢复；保存伪装配置并重启，检查文件名、版本信息、标题、图标；关闭并重启确认回到原始路径。使用实际录屏软件分别验证窗口捕获和显示器捕获。

`scripts/privacy-smoke.mjs` 是桌面集成验证脚本，通过 WebView2 本地调试端口读取真实原生状态。需先使用 `TAURI_CONFIG={"identifier":"com.mianlingai.clone.smoke"}` 构建独立测试程序至 `artifacts/privacy-smoke.exe`，并开启 `tauri/custom-protocol` feature；然后运行 `node scripts/privacy-smoke.mjs`。脚本校验隔离标识，使用独立数据目录，结果写入 `artifacts/privacy-smoke-result.json`。测试程序退出后调试端口也随之关闭。
