export function safeTimeoutMs(value, fallback) {
  const timeoutMs = Number(value);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return fallback;
  return Math.min(Math.max(Math.round(timeoutMs), 100), 10 * 60 * 1000);
}

export function timeoutMsFromEnv(names, fallback) {
  const candidates = Array.isArray(names) ? names : [names];
  for (const name of candidates) {
    const value = process.env[name];
    if (value && String(value).trim().length > 0) return safeTimeoutMs(value, fallback);
  }
  return fallback;
}

function isAbortTimeout(error) {
  return error?.name === "AbortError" || error?.name === "TimeoutError" || error?.code === "ABORT_ERR";
}

export async function fetchWithTimeout(url, init = {}, { timeoutMs = 120000, timeoutMessage = "外部请求超时。" } = {}) {
  const normalizedTimeoutMs = safeTimeoutMs(timeoutMs, 120000);
  const controller = init.signal ? null : new AbortController();
  let timedOut = false;
  let timer;
  const request = fetch(url, {
    ...init,
    signal: init.signal || controller.signal,
  }).catch((error) => {
    if (isAbortTimeout(error)) {
      throw new Error(timeoutMessage);
    }
    throw error;
  });
  try {
    if (init.signal) return await request;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new Error(timeoutMessage));
      }, normalizedTimeoutMs);
    });
    return await Promise.race([request, timeout]);
  } catch (error) {
    if (timedOut || isAbortTimeout(error)) {
      throw new Error(timeoutMessage);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    request.catch(() => {});
  }
}

export async function promiseWithTimeout(promise, { timeoutMs = 120000, timeoutMessage = "外部请求超时。" } = {}) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(timeoutMessage)), safeTimeoutMs(timeoutMs, 120000));
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
