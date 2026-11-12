# UI v2 — 设计方向（草案）

目标：把现有「shadcn 默认风」换成一版**克制但有质感**的界面：简约留白、克制的玻璃材质、有意义的动效。
面向桌面端（Tauri + WebView2，Windows/macOS），需要同时服务「主窗口」和「透明浮窗」两种表面。

---

## 1. 调研结论（2026）

- **材质是主角，不是装饰**：Apple 在 iOS 26 / macOS 26 引入 Liquid Glass 后，行业把它当「材质系统」用——只出现在导航、工具条、浮层这类 chrome 上，不铺进内容区。玻璃层负责表达层级，内容区保持不透明以保证可读性。[9to5Mac](https://9to5mac.com/2026/04/06/apple-showcases-apps-using-liquid-glass-in-new-developer-gallery/)、[uisdc](https://www.uisdc.com/2026-ui-ux-ai-trends)
- **真折射 ≠ 模糊**：真正的液态玻璃用 SDF + `feDisplacementMap` 做边缘折射，只有 Chromium 能跑；多数实现都退化成 `backdrop-filter: blur()` 兜底。渐进模糊 `linear-blur()` 仍是 CSS 草案。[W3C 讨论](https://lists.w3.org/Archives/Public/public-css-archive/2026Jan/0012.html)
- **玻璃的三个已知坑**：低对比度导致正文发糊、焦点环被玻璃吃掉、多层叠加后掉帧。业内做法是「一层玻璃 + 更硬的焦点环 + 严格的性能预算」。[glassmorphism accessibility](https://github.com/flokuersten/farvist/blob/492f446670ffb12ea07089b6c0d7c0e95b1f2881/blog/glassmorphism-accessibility/index.html)、[企业级玻璃 UI 实践](https://techreviewer.co/companies/innoraft-solutions-private-limited/engineering-an-immersive-glass-ui-at-enterprise-scale)
- **Tauri/WebView 环境有先例**：有桌面项目在 Tauri WebView 里做过多层玻璃，靠「材质档位 + 性能闸门」维持 60fps。[SoundCloud-Desktop 设计系统](https://deepwiki.com/zxcloli666/SoundCloud-Desktop/5.1-design-system-and-css-architecture)
- **动效的时间尺度**：微交互 120–260ms，缓动统一，弹层 300ms 进 / 220ms 出，列表 stagger ≤ 30ms，且必须尊重 `prefers-reduced-motion`。[micro-interactions 参考](https://github.com/nexu-io/open-design/blob/de6d2c072a18dfef80ecad4a455b31f0d5aca090/plugins/community/hallmark/references/microinteractions.md)

## 2. 一个必须先讲清的限制

**浮窗是透明窗口，`backdrop-filter` 模糊不了窗口后面的桌面。**

浏览器的 backdrop 只作用于「同一文档里画在这个元素下面的内容」。浮窗背后是真实屏幕，不属于文档，所以：

- 主窗口内：玻璃可以真的模糊背后的页面内容 —— 材质成立。
- 透明浮窗内：玻璃只能模糊**浮窗自己的底色/渐变**，看起来是「有厚度的暗色板」，而不是「磨砂屏幕」。

所以浮窗的质感要靠 **半透明底 + 内发光描边 + 细噪点 + 顶部高光** 来做，不承诺磨砂效果。这一点写进规范，避免实现时白费功夫。

## 3. 材质三级

| 档位 | 用途 | 配方 |
| --- | --- | --- |
| `canvas` | 应用底 | 深底 `#06080F` + 1–2 处低饱和光晕 + 极细噪点（不透明） |
| `panel` | 卡片、设置分组 | `rgba(255,255,255,.04)` + `blur(18px)` + 1px `rgba(255,255,255,.08)` + 顶部 1px 内高光 |
| `float` | 弹窗、命令面板、Toast、浮窗卡片 | `rgba(10,14,24,.72)` + `blur(28px) saturate(140%)` + 高光描边（渐变边框）+ 更深的投影 |

规矩：**同一屏最多两层玻璃**；玻璃不得作为文本唯一背景（正文所在卡片必须有 ≥ 88% 的不透明度）。

## 4. 令牌草案

```
--bg            #06080F      --surface-1  rgba(255,255,255,.04)
--surface-2     rgba(255,255,255,.06)
--border-soft   rgba(255,255,255,.08)
--border-strong rgba(255,255,255,.14)
--text          #E9EEF9      (对 #0B101C ≈ 14:1)
--text-muted    #8B94A7      (≈ 6.4:1)
--accent        #7C8CFF      --accent-2 #5CE1E6
--radius-panel  22px         --radius-control 12px   --radius-pill 999px
--shadow-float  0 24px 60px -30px rgba(0,0,0,.9)
--dur-fast 120ms --dur-base 180ms --dur-slow 300ms
--ease  cubic-bezier(.2,.8,.2,1)
```

亮色主题是同一套令牌的第二组值（不是另一套组件），先做暗色。

## 5. 动效清单（只有这些，不做装饰循环）

| 场景 | 行为 |
| --- | --- |
| 按钮 | hover 亮度 +6%，按下 `scale(.985)`，120ms |
| 卡片/行 | hover 只变背景与描边，不位移（避免抖动） |
| 分段控件 | 指示块 `transform` 滑移，180ms |
| 弹层 | opacity 0→1 + `translateY(6px)`→0，300ms 进 / 220ms 出 |
| 列表新增 | 单项 opacity + 8px 上移，120ms，stagger ≤ 30ms |
| 聆听中 | 三根 2px 竖条 1.2s 呼吸（唯一允许的循环动画，且只在录音态） |
| 全局 | `prefers-reduced-motion: reduce` → 全部退化为 opacity 交叉淡入 |

## 6. 落地顺序

1. **试点页**：面试助手（本页元素最全：分段控件、下拉、滑块、开关、chip、主按钮）
2. 令牌 + 5 个 primitives（Button / Surface(Card) / Input / Select / Dialog）
3. 逐页迁移：笔试助手 → 模拟面试 → 自由对话 → 历史记录 → 资料/题库 → 设置 → 浮窗
4. 每页一个提交，迁移期保留旧样式类，全部完成后再删
