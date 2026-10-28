/*
 * 根错误边界（对齐原版 bJ）：渲染崩溃时上报并展示兜底文案；
 * 浮窗崩溃保持透明、主窗口给出重载按钮。
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  scene: 'overlay' | 'mock' | 'main';
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[desktop] render error', error, info.componentStack);
    const sink = (window as unknown as { __errors?: string[] }).__errors;
    sink?.push(`render: ${error.stack ?? error.message}\n${info.componentStack ?? ''}`);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.scene === 'overlay') {
      // 浮窗崩溃：保持透明，只留一行提示（不抢面试画面）
      return (
        <div className="ov-text flex h-screen w-full items-center justify-center px-4 text-center text-[12px] leading-6">
          界面出了点问题。关掉助手再打开即可继续这场面试。
        </div>
      );
    }
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background p-6 text-center text-foreground">
        <p className="text-base font-medium">出了点问题</p>
        <p className="max-w-sm text-sm text-muted-foreground">
          点击下方按钮重新加载即可继续使用，你的登录状态会保留。
        </p>
        <button
          type="button"
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
          onClick={() => window.location.reload()}
        >
          重新加载
        </button>
        <pre className="max-w-full overflow-auto rounded bg-muted p-2 text-left text-[11px] text-muted-foreground">
          {error.message}
        </pre>
      </main>
    );
  }
}
