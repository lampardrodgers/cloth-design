import { Component, type ErrorInfo, type ReactNode } from "react";
import { reportClientError } from "../lib/clientErrors";

interface ErrorBoundaryProps {
  /** 上报时用来区分是哪一块崩了 */
  scope: string;
  title: string;
  hint?: string;
  children: ReactNode;
  /** 除「刷新页面」外，这一块自己的自救按钮 */
  actions?: (reset: () => void) => ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * React 里没有错误边界的话，任何一次渲染报错都会把整棵树卸载 —— 用户看到的就是纯白页，
 * 连「出了什么事」都没有。这里兜住，显示一张说人话的卡片，并把错误发回服务端。
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    reportClientError({
      scope: this.props.scope,
      message: error.message || "渲染出错",
      stack: `${error.stack ?? ""}\n--- component stack ---${info.componentStack ?? ""}`,
    });
  }

  private reset = () => this.setState({ error: null });

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <section className="crash-card" role="alert">
        <span className="crash-mark" aria-hidden="true">
          ！
        </span>
        <strong>{this.props.title}</strong>
        <p className="crash-message">{error.message || "页面出了点问题。"}</p>
        {this.props.hint ? <small>{this.props.hint}</small> : null}
        <div className="crash-actions">
          <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>
            刷新页面
          </button>
          {this.props.actions?.(this.reset)}
        </div>
      </section>
    );
  }
}
