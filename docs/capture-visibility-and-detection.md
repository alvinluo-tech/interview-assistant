# 桌面助手类应用的「隐蔽」能力：从检测方看

> 本文从**监考 / 反作弊 / 企业合规审计**的视角整理这类应用可能的隐藏手段，
> 以及对应的检测思路与实现要点。目的是帮你写出能识别这些行为的检查工具，
> 或在自己的产品里做正确的可见性设计。
>
> 当前实现与验证方法见 [窗口捕获排除与进程伪装](window-protection-and-disguise.md)。
> 本文保留检测方视角的讨论；它不代表当前版本的功能清单。

---

## 1. 这类应用想隐藏什么

| 想隐藏的 | 威胁模型 |
|---|---|
| 浮窗出现在录屏 / 屏幕共享 / 截图中 | 远程面试录屏、考试客户端定屏截图 |
| 进程名、窗口标题、图标暴露身份 | 考试客户端枚举进程、按名单结束进程 |
| 应用在任务栏 / Alt+Tab 中出现 | 人工巡视、录屏回放 |
| 从截图中消失的窗口本身 | 双机位反拍、屏幕录制取证 |

对应到 Windows 上大致三类手段：**窗口捕获可见性**、**窗口外观元数据**、**进程身份**。

---

## 2. 捕获可见性：怎么被「隐藏」的

### 2.1 机制（概念层）

Windows 提供窗口级「捕获亲和性」标记，让 DWM 在把桌面合成为可捕获画面时跳过某些窗口。
不同标记的语义差别很大：

- 一种会让窗口**变黑**（录制里是黑块，人工一眼可见）；
- 另一种让窗口**完全不出现在合成结果里**（录制里那块是桌面背景）。

现代屏幕共享（Teams / 飞书 / 腾讯会议 / OBS 的显示器采集）走的都是 DWM 合成路径，
所以第二种标记对它们同样生效。这也解释了为什么考试客户端「截全屏」拿不到这类窗口。

相关 API 家族：`SetWindowDisplayAffinity` 及其扩展语义、部分场景下的
`DwmSetWindowAttribute` 属性、以及基于 `Windows.Graphics.Capture` 的采集路径差异。

### 2.2 检测思路（防守方）

1. **枚举 + 查询亲和性**：遍历顶层窗口，读取每个窗口的捕获亲和性值；非默认值即可疑。
   这是最直接的一跳，参考实现在第 4 节。
2. **合成一致性校验**：同时用「DWM 合成截图」和「通过 `PrintWindow`/窗口自绘」两条路径取像素，
   比对同一区域。窗口在 A 有内容、B 为空/背景 → 该窗口对捕获做了手脚。
3. **多路采集交叉验证**：显示器采集 vs. 单个窗口采集 vs. 显卡读回（如 DXGI Desktop Duplication
   与 `Windows.Graphics.Capture` 各走一遍）。同一时刻某区域结果不一致即告警。
4. **黑块检测**：对采集画面做区域方差/直方图分析，检测「突然出现的高对比黑矩形」。
5. **置顶窗口清单**：枚举 `WS_EX_TOPMOST` + 无边框 + 非任务栏窗口，与前台应用做关联。
   纯置顶不等于作弊（很多工具都这样），但值得进入审计日志。
6. **副屏/双机位**：外部摄像头画面里出现阅读姿态与视线异常，是绕过一切软件手段的最终兜底。

### 2.3 设计上的正确做法

如果自己做的是「用户自己的辅助工具」，正确选择是**保持可见**：在共享/录制中如实出现，
把可见性交给用户和平台策略决定。任何「对录制隐身」的开关都在把你和监考环境对立起来。

---

## 3. 进程身份与窗口元数据

### 3.1 常见做法（不展开具体操作）

- 改窗口标题（普通 API，任何应用都能做，隐蔽性最弱）；
- 改可执行文件名 / 产品名 / 公司名 / 图标等**版本资源**；
- 运行期改自身进程名（需要特定权限与技巧）；
- 复制一份二进制到临时目录用别的名字启动；
- 用与系统服务相似的名字（`UpdateService`、`AudioService`、`CloudSync` 这类），
  利用「白名单靠名字匹配」的弱点；
- 提权或借助计划任务/服务宿主，让父进程看起来像一个系统组件。

### 3.2 检测思路（防守方）

反作弊与终端安全产品实际用的组合拳，比「查进程名」强得多：

1. **签名与发布者校验**：读取 Authenticode 签名，校验签名链与发布者；未签名 / 自签名 /
   发布者与名字不匹配（例如名叫 `UpdateService.exe` 却由个人证书签出）直接高危。
2. **路径与哈希**：可执行文件是否位于 `%TEMP%`、`%APPDATA%`、用户目录、回收站等非常规路径；
   文件哈希是否命中已知样本库。
3. **进程树与父进程**：孤立的、父进程已退出的、被服务宿主拉起的未知进程；
   以及「父进程是 explorer 但自称系统服务」这类矛盾。
4. **命令行与自启动点**：Run 键、启动目录、计划任务、服务注册表项交叉比对。
5. **窗口与进程的关联**：前台窗口属于哪个进程、该进程是否有可见主窗口、
   是否同时存在「无窗口但注册全局热键」的进程（静默驻留的典型特征）。
6. **全局热键注册表**：`RegisterHotKey` 的键位可被枚举；与本机常用软件冲突异常、
   或注册了与「一键隐藏」语义相符的组合，可做审计线索。
7. **行为特征**：短时高频截屏（`BitBlt`/Desktop Duplication 调用速率）、
   持续音频环回采集、异常的网络长连接（到未知域名的流式接口）。
8. **屏幕内容与进程清单的互证**：录屏里出现「浮窗样式的文本」，但进程清单里找不到对应应用
   → 高度可疑（正是「捕获隐身 + 改名」的组合特征）。
9. **内核层**：主流反作弊用驱动做进程创建回调、镜像加载回调、句柄与内存扫描，
   名字与图标层面的伪装在内核视角下基本无效。
10. **规则与政策**：把「考试期间运行未知的置顶/热键/音频环回进程」直接判为违规，
    而不是只依赖技术识别。

---

## 4. 一个最小检测器（可直接跑）

思路：枚举所有顶层窗口 → 查询捕获亲和性 → 输出「对录屏不可见」的窗口清单。
在合法授权的环境里可以用来做自查（例如确认自己的产品没有被误标、或确认某个考试客户端
是否在偷偷排除自己的窗口）。

```powershell
# audit-capture.ps1 —— 列出「对屏幕捕获不可见」的窗口
$env:LIB = ''; $env:INCLUDE = ''
Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public class CaptureAudit {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lp);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lp);
  [DllImport("user32.dll")] public static extern bool GetWindowDisplayAffinity(IntPtr hWnd, out uint affinity);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder sb, int max);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr hWnd, StringBuilder sb, int max);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  public static List<string> Hits = new List<string>();
  public static bool Cb(IntPtr h, IntPtr lp) {
    if (!IsWindowVisible(h)) return true;
    uint aff;
    if (!GetWindowDisplayAffinity(h, out aff)) return true;
    if (aff == 0) return true; // 默认：可捕获
    var t = new StringBuilder(512); GetWindowText(h, t, 512);
    var c = new StringBuilder(256); GetClassName(h, c, 256);
    uint pid; GetWindowThreadProcessId(h, out pid);
    Hits.Add(String.Format("affinity={0} pid={1} class={2} title={3}", aff, pid, c, t));
    return true;
  }
}
"@
[void][CaptureAudit]::EnumWindows({ param($h,$l) [CaptureAudit]::Cb($h,$l) }, [IntPtr]::Zero)
if ($CaptureAudit::Hits.Count -eq 0) { Write-Output "没有发现对捕获不可见的窗口。" }
else { $CaptureAudit::Hits | ForEach-Object { Write-Output $_ } }
```

亲和性取值含义（查询 API 的语义）：

| 值 | 含义 | 对监考的意义 |
|---|---|---|
| 0 | 默认可捕获 | 正常 |
| 0x01 | 仅显示器显示内容（捕获结果无内容） | 需要结合上下文判断 |
| 0x11 | 被排除在支持此功能的捕获之外 | 需要结合上下文判断 |

配套的两步验证：

- **合成 vs 自绘比对**：对每个可疑窗口，`PrintWindow(hwnd, PW_RENDERFULLCONTENT)` 取一份，
  再用桌面合成截图取同一矩形，逐像素比差异。前者有内容、后者是背景 → 确认。
- **多源交叉**：`Windows.Graphics.Capture` 与 DXGI Desktop Duplication 各采一次，
  不一致即记录。

---

## 5. 给产品方的检查清单

如果你在做的是合法的辅助类桌面应用（笔记、转写、会议助手），这些是应该做的：

- [ ] 浮窗在共享屏幕、录屏、截图中**可见**，不做捕获排除；
- [ ] 进程名与图标如实反映产品身份，不冒充系统组件或其他软件；
- [ ] 在被监控场景下主动提示用户「本窗口会被录制」；
- [ ] 提供明确的「暂停/隐藏」按钮，但隐藏是「用户主动下线」，不是「对录制隐身」；
- [ ] 采集（音频/屏幕）前给出告知与授权确认，并写清数据流向；
- [ ] 文档里写清「禁止用于监考类考试」的边界（本仓库的 `使用须知` 即此用意）。

---

## 6. 参考与延伸

- Windows 窗口亲和性与 DWM 合成路径的公开文档；
- `Windows.Graphics.Capture`（WinRT）与 DXGI Desktop Duplication 的差异；
- Authenticode 签名校验与发布者信息读取；
- 反作弊产品的公开威胁模型文章（进程回调、镜像加载回调、句柄扫描）；
- 本仓库 `_recon/spec/02-overlay.md`：浮窗「可见部分」的完整行为规格（穿透、zones、
  悬停驻留、样式公式），这些都不涉及规避监控。
