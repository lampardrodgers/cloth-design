import { sqlite } from "./db.mjs";

function parseResetAt(message) {
  const match = String(message || "").match(/["']?resets_at["']?\s*[:=]\s*(\d{10})/);
  if (!match) return null;
  const timestamp = Number(match[1]);
  if (!Number.isFinite(timestamp)) return null;
  return new Date(timestamp * 1000).toISOString();
}

export function summarizeProviderErrorText(text, maxLength = 360) {
  const fallback = String(text || "").slice(0, maxLength);
  let data = null;
  try {
    data = JSON.parse(String(text || ""));
  } catch {
    return fallback;
  }

  const rawError = data?.error;
  const error = rawError && typeof rawError === "object" ? rawError : {};
  const rawMessage = typeof rawError === "string" ? rawError : error.message || data?.message || fallback;
  const message = String(rawMessage || fallback).slice(0, maxLength);
  const details = [];
  const pushDetail = (label, value) => {
    if (value === undefined || value === null || value === "") return;
    const normalized = String(value);
    if (message.includes(normalized)) return;
    details.push(label ? `${label}=${normalized}` : normalized);
  };

  pushDetail("", error.type || data?.type);
  pushDetail("code", error.code || data?.code);
  pushDetail("param", error.param || data?.param);
  pushDetail("resets_at", error.resets_at || data?.resets_at);
  pushDetail("resets_in_seconds", error.resets_in_seconds || data?.resets_in_seconds);

  return details.length ? `${message}（${details.join("，")}）` : message;
}

export function classifyImageProviderHealth({ mode, providerReady, latest } = {}) {
  if (mode === "demo" || !providerReady) {
    return {
      status: "demo",
      label: "演示模式",
      blocking: false,
      message: providerReady ? "演示模式已开启，不会调用真实图像接口。" : "未配置图像接口 Key，不会调用真实图像接口。",
      resetAt: null,
      checkedAt: null,
    };
  }

  if (!latest) {
    return {
      status: "unknown",
      label: "未实测",
      blocking: false,
      message: "尚无最近真实图像请求记录。",
      resetAt: null,
      checkedAt: null,
    };
  }

  const message = String(latest.message || "");
  const checkedAt = latest.updatedAt || latest.createdAt || null;
  if (latest.status === "running") {
    return {
      status: "running",
      label: "请求中",
      blocking: false,
      message: "最近一次真实图像请求仍在运行。",
      resetAt: null,
      checkedAt,
    };
  }
  if (latest.status === "success") {
    return {
      status: "ok",
      label: "最近真实出图成功",
      blocking: false,
      message: message || "图像接口最近一次请求成功。",
      resetAt: null,
      checkedAt,
    };
  }

  const lowerMessage = message.toLowerCase();
  const resetAt = parseResetAt(message);
  if (lowerMessage.includes("usage_limit_reached")) {
    return {
      status: "usage_limited",
      label: "额度受限",
      blocking: true,
      message,
      resetAt,
      checkedAt,
    };
  }
  if (message.includes("没有可用token") || lowerMessage.includes("no available token")) {
    return {
      status: "no_token",
      label: "无可用 token",
      blocking: true,
      message,
      resetAt,
      checkedAt,
    };
  }
  if (message.includes("超时") || lowerMessage.includes("timeout")) {
    return {
      status: "timeout",
      label: "图像接口超时",
      blocking: true,
      message,
      resetAt,
      checkedAt,
    };
  }
  return {
    status: "error",
    label: "图像接口异常",
    blocking: true,
    message,
    resetAt,
    checkedAt,
  };
}

export function latestImageProviderEvent() {
  try {
    const generationTask = sqlite
      .prepare(
        `SELECT 'generation' AS source, status, message, created_at AS createdAt, updated_at AS updatedAt
         FROM generation_task
         WHERE status IN ('running', 'success', 'failed')
         ORDER BY updated_at DESC
         LIMIT 1`,
      )
      .get();
    const workflowJob = sqlite
      .prepare(
        `SELECT 'workflow' AS source, status, message, created_at AS createdAt, updated_at AS updatedAt
         FROM workflow_job
         WHERE status IN ('running', 'success', 'failed')
         ORDER BY updated_at DESC
         LIMIT 1`,
      )
      .get();
    return [generationTask, workflowJob]
      .filter(Boolean)
      .sort((a, b) => String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || "")))[0] || null;
  } catch {
    return null;
  }
}

export function imageProviderHealth({ mode, providerReady } = {}) {
  return classifyImageProviderHealth({
    mode,
    providerReady,
    latest: latestImageProviderEvent(),
  });
}
