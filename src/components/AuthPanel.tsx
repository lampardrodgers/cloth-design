import { useState, type FormEvent, type KeyboardEvent } from "react";
import { Download, ImagePlus, KeyRound, LogIn, SlidersHorizontal, Sparkles } from "lucide-react";
import { signInEmail, signUpEmail } from "../lib/api";
import { Button, Section } from "./ui";

interface AuthPanelProps {
  onAuthenticated: () => Promise<void> | void;
}

type AuthMode = "signin" | "signup";

const onboardingSteps = [
  {
    title: "选择创作目标",
    description: "从商品主图、模特换衣、面料款式或批量后期开始。",
    icon: Sparkles,
  },
  {
    title: "放入你的素材",
    description: "按照页面提示上传服装、模特、面料或参考图片。",
    icon: ImagePlus,
  },
  {
    title: "生成并继续完善",
    description: "查看结果与质量提示，继续编辑、下载或归档。",
    icon: Download,
  },
] as const;

export function AuthPanel({ onAuthenticated }: AuthPanelProps) {
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

  const submit = async () => {
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

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void submit();
  };

  return (
    <main className="auth-shell auth-page">
      <div className="auth-layout">
        <aside className="auth-intro" aria-labelledby="auth-product-title">
          <div className="auth-brand">
            <span className="auth-brand-icon" aria-hidden="true">
              <SlidersHorizontal size={22} />
            </span>
            <div>
              <span className="auth-eyebrow">服装 AI 创作工作台</span>
              <h1 id="auth-product-title">ClothDesign AI</h1>
            </div>
          </div>

          <p className="auth-intro-copy">
            不需要理解模型或复杂参数。选择想完成的服装任务，按照提示准备素材，就能生成可继续编辑和交付的图片。
          </p>

          <ul className="auth-capability-list" aria-label="核心能力">
            <li>商品图与广告图</li>
            <li>模特换衣与多图融合</li>
            <li>面料款式与批量后期</li>
          </ul>

          <section className="auth-onboarding" aria-labelledby="auth-onboarding-title">
            <div className="auth-onboarding-heading">
              <span>快速上手</span>
              <h2 id="auth-onboarding-title">3 步开始创作</h2>
            </div>
            <ol className="auth-onboarding-steps">
              {onboardingSteps.map((step, index) => {
                const Icon = step.icon;
                return (
                  <li className="auth-onboarding-step" key={step.title}>
                    <span className="auth-step-index">{index + 1}</span>
                    <span className="auth-step-icon" aria-hidden="true">
                      <Icon size={17} />
                    </span>
                    <div className="auth-step-copy">
                      <strong>{step.title}</strong>
                      <span>{step.description}</span>
                    </div>
                  </li>
                );
              })}
            </ol>
          </section>
        </aside>

        <div className="auth-form-column">
          <Section title="账号登录" action={<KeyRound size={17} aria-hidden="true" />}>
            <form className="auth-panel auth-form" onSubmit={handleSubmit} aria-busy={submitting}>
              <div className="auth-form-intro">
                <span className="auth-form-kicker">开始使用</span>
                <strong>{mode === "signup" ? "创建账号，保存你的创作记录" : "欢迎回来，继续上次的工作"}</strong>
                <p className="auth-form-description">
                  {mode === "signup" ? "首次使用请选择注册，完成后会直接进入工作台。" : "使用注册时的邮箱和密码登录。"}
                </p>
              </div>

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

              <div
                id="auth-panel-signin"
                className="auth-tab-panel auth-tab-panel-message"
                role="tabpanel"
                aria-labelledby="auth-tab-signin"
                hidden={mode !== "signin"}
              >
                <p>输入账号信息即可继续，无需重新配置创作参数。</p>
              </div>

              <div className="auth-fields">
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
              </div>

              {error ? (
                <div className="inline-warning auth-form-error" id="auth-form-error" role="alert">
                  {error}
                </div>
              ) : null}

              <Button className="auth-submit" type="submit" icon={<LogIn size={14} />} disabled={submitting}>
                {submitting ? "处理中" : mode === "signup" ? "创建账号" : "登录"}
              </Button>
            </form>
          </Section>
        </div>
      </div>
    </main>
  );
}
