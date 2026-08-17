import { useState, type FormEvent, type KeyboardEvent } from "react";
import { signInEmail, signUpEmail } from "../lib/api";

interface AuthPanelProps {
  onAuthenticated: () => Promise<void> | void;
  debugUnlimitedAvailable?: boolean;
  onDebugAuthenticated?: () => Promise<void> | void;
}

type AuthMode = "signin" | "signup";

const onboardingSteps = [
  { title: "选择用途", detail: "商品主图、模特换衣、面料款式或批量后期" },
  { title: "放入素材", detail: "拖到画布任意位置，自动排成 A/B/C" },
  { title: "生成并交付", detail: "对比、放大、下载或归档到云盘" },
] as const;

const capabilities = ["商品图与广告图", "模特换衣与多图融合", "面料款式与批量后期"] as const;

export function AuthPanel({ debugUnlimitedAvailable = false, onAuthenticated, onDebugAuthenticated }: AuthPanelProps) {
  const [mode, setMode] = useState<AuthMode>("signup");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const selectMode = (nextMode: AuthMode) => {
    setMode(nextMode);
    setError("");
  };

  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const nextMode: AuthMode = event.key === "ArrowLeft" || event.key === "Home" ? "signup" : "signin";
    selectMode(nextMode);
    window.requestAnimationFrame(() => document.getElementById(`auth-tab-${nextMode}`)?.focus());
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      if (mode === "signup") {
        await signUpEmail(name, email, password);
      } else {
        await signInEmail(email, password);
      }
      await onAuthenticated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "登录失败");
    } finally {
      setSubmitting(false);
    }
  };

  const handleDebugStart = async () => {
    if (!onDebugAuthenticated) return;
    setSubmitting(true);
    setError("");
    try {
      await onDebugAuthenticated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "开发调试模式启动失败");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="auth-shell auth-page">
      <div className="auth-layout">
        <section className="auth-intro" aria-labelledby="auth-product-title">
          <div className="auth-brand">
            <span className="auth-brand-icon" aria-hidden="true" />
            <div>
              <span className="auth-eyebrow">服装视觉工作台</span>
              <h1 id="auth-product-title">ClothDesign AI</h1>
            </div>
          </div>

          <div className="auth-rule" aria-hidden="true" />

          <p className="auth-intro-copy">
            选择要完成的服装任务，放入素材，生成可直接交付的成片。参数已备好默认值。
          </p>

          <ul className="auth-capability-list" aria-label="核心能力">
            {capabilities.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>

          <ol className="auth-onboarding-steps" aria-label="快速上手">
            {onboardingSteps.map((step, index) => (
              <li className="auth-onboarding-step" key={step.title}>
                <span className="auth-step-index">{index + 1}</span>
                <span className="auth-step-copy">
                  <strong>{step.title}</strong>
                  <span>{step.detail}</span>
                </span>
              </li>
            ))}
          </ol>
        </section>

        <section className="auth-form-column">
          <form className="auth-panel auth-form" onSubmit={handleSubmit} aria-busy={submitting}>
            <span className="auth-form-kicker">开始使用</span>
            <h2 className="auth-form-title">
              {mode === "signup" ? "创建账号，保存创作记录" : "欢迎回来"}
            </h2>

            <div className="auth-tabs" role="tablist" aria-label="账号操作">
              <button
                id="auth-tab-signup"
                type="button"
                role="tab"
                aria-selected={mode === "signup"}
                aria-controls="auth-panel-signup"
                tabIndex={mode === "signup" ? 0 : -1}
                className={`auth-tab ${mode === "signup" ? "active" : ""}`}
                onClick={() => selectMode("signup")}
                onKeyDown={handleTabKeyDown}
              >
                注册
              </button>
              <button
                id="auth-tab-signin"
                type="button"
                role="tab"
                aria-selected={mode === "signin"}
                aria-controls="auth-panel-signin"
                tabIndex={mode === "signin" ? 0 : -1}
                className={`auth-tab ${mode === "signin" ? "active" : ""}`}
                onClick={() => selectMode("signin")}
                onKeyDown={handleTabKeyDown}
              >
                登录
              </button>
            </div>

            <div className="auth-fields">
              <div
                id="auth-panel-signup"
                className="auth-tab-panel"
                role="tabpanel"
                aria-labelledby="auth-tab-signup"
                hidden={mode !== "signup"}
              >
                <label className="field auth-field" htmlFor="auth-name">
                  <span>名称</span>
                  <input
                    id="auth-name"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    autoComplete="name"
                    disabled={mode !== "signup"}
                    required={mode === "signup"}
                  />
                </label>
              </div>

              <label className="field auth-field" htmlFor="auth-email">
                <span>邮箱</span>
                <input
                  id="auth-email"
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  autoComplete="email"
                  autoCapitalize="none"
                  spellCheck={false}
                  required
                />
              </label>

              <label className="field auth-field" htmlFor="auth-password">
                <span>密码</span>
                <input
                  id="auth-password"
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  autoComplete={mode === "signin" ? "current-password" : "new-password"}
                  required
                />
              </label>

              <div
                id="auth-panel-signin"
                className="auth-tab-panel auth-tab-panel-message"
                role="tabpanel"
                aria-labelledby="auth-tab-signin"
                hidden={mode !== "signin"}
              >
                <p>输入账号信息即可继续，创作参数会保持上次的选择。</p>
              </div>

              {error ? (
                <div className="inline-warning auth-form-error" role="alert">{error}</div>
              ) : null}

              <button className="btn btn-primary auth-submit" type="submit" disabled={submitting}>
                {submitting ? "处理中" : mode === "signup" ? "创建账号" : "登录"}
              </button>

              {debugUnlimitedAvailable && onDebugAuthenticated ? (
                <div className="auth-debug-entry">
                  <div>
                    <strong>只做本地调试？</strong>
                    <span>跳过账号和积分扣除，直接进入无限额度工作台。</span>
                  </div>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={handleDebugStart}
                    disabled={submitting}
                  >
                    ∞ 开发调试
                  </button>
                </div>
              ) : null}
            </div>

            <p className="auth-form-description">
              {mode === "signup"
                ? "注册后需要管理员在后台开通才能使用；开通后可在「账户」页填入自己的图像接口 Key。"
                : "首个注册账号成为 owner；也可由 ADMIN_EMAILS 指定管理员。"}
            </p>
          </form>
        </section>
      </div>
    </main>
  );
}
