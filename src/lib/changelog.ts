export interface ChangelogEntry {
  date: string;
  items: {tag: 'new' | 'improved' | 'fixed'; text: string}[];
}

export const CHANGELOG: ChangelogEntry[] = [
  {
    date: '2026-10-31',
    items: [
      {tag: 'new', text: '主窗口支持深色、浅色和跟随系统外观，重启后保留设置。'},
      {tag: 'improved', text: '更新应用图标及安装、卸载和更新界面的品牌形象。'},
      {tag: 'improved', text: '改善 Mac 浮窗在全屏应用和不同桌面空间中的显示。'},
    ],
  },
  {
    date: '2026-10-30',
    items: [
      {tag: 'improved', text: '优化 Windows 安装界面，并完善语音播放与音频设备设置。'},
      {tag: 'improved', text: '改进面试和笔试中的问答、截图、快捷键及浮窗交互。'},
      {tag: 'fixed', text: '修复会话结束、记录保存和部分异常情况下的恢复问题。'},
    ],
  },
  {
    date: '2026-10-29',
    items: [
      {tag: 'new', text: '支持手机副屏控制、笔试题目和截图存档。'},
      {tag: 'improved', text: '完善模拟面试、历史记录和本地数据管理。'},
      {tag: 'improved', text: '支持在应用内检查更新并验证更新文件。'},
    ],
  },
  {
    date: '2026-10-28',
    items: [
      {tag: 'new', text: '提供面试助手、笔试助手、模拟面试、题库和资料管理。'},
      {tag: 'new', text: '支持配置自己的 AI 服务，用于对话、截图识别和语音转写。'},
      {tag: 'improved', text: '支持调整浮窗主题、透明度、文字描边、字号、滚动速度和快捷键。'},
    ],
  },
];
