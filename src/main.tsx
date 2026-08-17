import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { installGlobalErrorReporting } from "./lib/clientErrors";
import "./styles.css";

installGlobalErrorReporting();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary scope="app" title="界面出错了" hint="已经把这次错误发回服务端；刷新一下通常就能继续。">
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
