# 骆耀升老公酱面试助手

本地优先的 AI 面试辅助桌面应用：面试实时听译与作答、笔试截屏解题、模拟面试动态对话与复盘报告。AI 能力全部对接你自己的 OpenAI 兼容接口，数据保存在本机。

## 功能总览

### 主窗口

| 模块 | 说明 |
|---|---|
| 面试工作台 | 面试方式、简历、岗位、资料选择、回答策略（静音门限三档、回答风格） |
| 笔试工作台 | 三档模式卡、岗位、答题偏好、复制/提示/双机位开关 |
| 模拟面试 | 独立面试间窗口：AI 面试官按简历与岗位动态出题、按回答追问/换题、TTS 播报、语音/文字作答；复盘报告落盘，支持跨重启续场与历史回看 |
| 面试题库 | 按简历与岗位生成定制题目，参考回答可存入面试资料 |
| 资料管理 | 简历 / 岗位 / 面试资料 + 预设问答 + AI 出题 |
| 历史记录 | 面试问答与笔试记录，支持重命名、删除、导出 markdown、复盘报告回看 |
| 设置 | 浮窗样式（预设/主题/字号/宽高）、通用（多语言/主题）、快捷键（恐慌键 + 18 动作双方案）、隐蔽（反捕获/演示模式/进程伪装）、AI 服务（多供应商按用途分配） |

### 浮窗（Overlay）

- 透明无边框置顶、不进任务栏、默认点击穿透；原生轮询「zones」驱动悬停驻留交互
- 面试模式：转写竖线气泡 + AI markdown 流式作答、语音提问、结束面试唤回工作台
- 笔试模式：解题 / 加页（多页）/ 直接答 / 复制代码 / 一键配色
- 18 个全局动作热键（滚动/答题/截屏/移动/尺寸/透明度）+ 恐慌键（默认 `Ctrl+Shift+X`）

### 隐蔽能力（设置 → 隐蔽）

- **反屏幕捕获**：`WDA_EXCLUDEFROMCAPTURE`，主窗口与浮窗默认排除在录屏/共享画面之外；演示可见模式一键放行；写入后回读校验、失败事务回滚
- **进程伪装**：改名副本启动（含 Windows 保留名校验）、版本资源重写、图标剥离、窗口标题/图标切换、`origin.json` 回跳原始程序
- **守护进程**：仅异常退出时拉起新实例

详细实现说明见 [`docs/window-protection-and-disguise.md`](docs/window-protection-and-disguise.md)、[`docs/capture-visibility-and-detection.md`](docs/capture-visibility-and-detection.md)。

## 审计与差距分析

- [`docs/audit/gap-analysis.md`](docs/audit/gap-analysis.md) — 与官方 0.3.16 的逐功能全量差距清单（6 章约 90 个对照点：壳页面/浮窗/面试管线/笔试/设置面板/原生命令与 mac）
- [`docs/audit/bug-findings.md`](docs/audit/bug-findings.md) — 已知缺陷清单（38 条，含 E2E 复现证据与静态扫描基线；仅记录不修复）

## 技术栈

| 层 | 选型 |
|---|---|
| 壳 | Tauri 2（Rust）+ WebView2 |
| 前端 | React + TypeScript + Tailwind |
| 状态 | `tauri-plugin-store` 持久化，跨窗口事件同步 |
| 系统能力 | 全局热键、单实例、剪贴板、对话框、日志、文件系统 |
| 系统音频 | WASAPI loopback（COM，直连默认播放设备） |
| 截屏 | GDI BitBlt 全虚拟屏 → PNG |
| AI | OpenAI 兼容接口（chat / vision / stt / tts，按用途分别配置供应商与模型） |

## 快速开始

```bash
pnpm install
pnpm tauri dev          # 开发（Vite 1430 端口，前端热更新）
pnpm tauri build        # 生产构建（NSIS 安装包 + exe）
```

首次使用：打开「设置 → AI 服务」添加 OpenAI 兼容连接（获取模型列表或手动添加），按用途（作答 / 识题 / 听译 / 语音）选择模型并保存。

## 目录结构

```
src/
  main/                主窗口（8 个页面 + 引导 + 弹层）
  overlay/             浮窗（穿透/zones/悬停驻留/热键/面试与笔试渲染）
  mock/                模拟面试独立窗口（动态对话 + 复盘）
  lib/                 数据层、AI 适配（BYOK）、面试/笔试引擎、热键
src-tauri/src/
  lib.rs               应用装配 + 命令注册
  overlay.rs           窗口 / 穿透 / zones 轮询 / 心跳
  hotkeys.rs           全局热键（动作 + 恐慌键）
  audio.rs             WASAPI loopback
  capture.rs           GDI 截屏
  protection.rs        窗口捕获亲和性 / 演示可见 / 状态查询
  disguise.rs          进程改名副本 / 重启交接 / 窗口身份
  identity_resources.rs 副本版本资源重写 / 图标剥离
  misc.rs              日志 / 守护进程
```

## 平台说明

- **Windows 10 2004+**：完整功能（反屏幕捕获依赖 `WDA_EXCLUDEFROMCAPTURE`）。
- **macOS 12+**：基础面试/笔试/模拟面试功能；无反捕获与进程伪装（依赖 Win32）。
