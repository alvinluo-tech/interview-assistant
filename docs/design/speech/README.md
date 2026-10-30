# 多语言、方言与电话说话人设计

研究日期：2026-10-30。状态：**方案与官方协议核实，尚未实施本包所述新功能**。

用户确认的电话场景：手机外放，电脑麦克风收音。本文方案不假设能从手机直接获取两路独立音轨。

| 文档 | 内容 |
| --- | --- |
| [官方能力核实](provider-capabilities.md) | 小米 MiMo、阿里百炼的语言、方言、说话人和地域差异，含原始链接 |
| [产品与适配架构](language-and-speaker-architecture.md) | 语言 UI、播放、电话角色判断、接口和扩展规则 |
| [实施与验收](implementation-plan.md) | 当前代码缺口、分步交付、测试样本与发布条件 |
| [ADR 0005](../../adr/0005-speech-capabilities-and-speaker-routing.md) | 为什么把 ASR、TTS、语言策略和说话人判断分开 |

本设计承接 [AI 架构](../ai/architecture.md) 和 [默认连续回答原则](../../adr/0004-answer-continuity-default.md)。来源区分用于减少错误触发和事实污染，不要求候选人逐轮确认是否采用 AI 答案。

不因模型名称含 multilingual、支持多人对话或支持语音克隆，就认定其提供实时说话人标签。能力、接口、地域、音色及实际质量需要分别验证。
