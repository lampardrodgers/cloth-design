import { useState } from "react";
import { KeyRound, LogIn } from "lucide-react";
import { signInEmail, signUpEmail } from "../lib/api";
import { Button, Section } from "./ui";

interface AuthPanelProps {
  onAuthenticated: () => Promise<void> | void;
}

export function AuthPanel({ onAuthenticated }: AuthPanelProps) {
  const [mode, setMode] = useState<"signin" | "signup">("signup");
  const [name, setName] = useState("主账号");
  const [email, setEmail] = useState("admin@clothdesign.local");
  const [password, setPassword] = useState("clothdesign123");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

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

  return (
    <main className="auth-shell">
      <Section title="账号登录" action={<KeyRound size={17} />}>
        <div className="auth-panel">
          <div className="auth-tabs" role="tablist">
            <button className={mode === "signup" ? "active" : ""} onClick={() => setMode("signup")} type="button">
              注册
            </button>
            <button className={mode === "signin" ? "active" : ""} onClick={() => setMode("signin")} type="button">
              登录
            </button>
          </div>
          {mode === "signup" ? (
            <label className="field">
              <span>名称</span>
              <input value={name} onChange={(event) => setName(event.target.value)} autoComplete="name" />
            </label>
          ) : null}
          <label className="field">
            <span>邮箱</span>
            <input value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" />
          </label>
          <label className="field">
            <span>密码</span>
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete={mode === "signin" ? "current-password" : "new-password"}
            />
          </label>
          {error ? <div className="inline-warning">{error}</div> : null}
          <Button icon={<LogIn size={14} />} onClick={submit} disabled={submitting}>
            {submitting ? "处理中" : mode === "signup" ? "创建账号" : "登录"}
          </Button>
        </div>
      </Section>
    </main>
  );
}
