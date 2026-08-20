import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function privateOutboundAllowed() {
  return process.env.NODE_ENV !== "production" && String(process.env.ALLOW_PRIVATE_OUTBOUND_URLS || "").toLowerCase() === "true";
}

function privateIpv4(address) {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return true;
  const [a, b] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 0 && octets[2] === 2) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && octets[2] === 100) ||
    (a === 203 && b === 0 && octets[2] === 113) ||
    a >= 224
  );
}

function ipv6Words(address) {
  let value = address;
  if (value.includes(".")) {
    const lastColon = value.lastIndexOf(":");
    const ipv4 = value.slice(lastColon + 1);
    if (!net.isIPv4(ipv4)) return null;
    const octets = ipv4.split(".").map(Number);
    value = `${value.slice(0, lastColon)}:${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }
  const halves = value.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
  const words = [...left, ...Array(missing).fill("0"), ...right].map((part) => Number.parseInt(part || "0", 16));
  return words.length === 8 && words.every((word) => Number.isInteger(word) && word >= 0 && word <= 0xffff) ? words : null;
}

function privateIpAddress(address) {
  const normalized = String(address || "").trim().toLowerCase().split("%", 1)[0];
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (mapped) return privateIpv4(mapped);
  const family = net.isIP(normalized);
  if (family === 4) return privateIpv4(normalized);
  if (family !== 6) return true;
  const words = ipv6Words(normalized);
  if (!words) return true;
  const [a, b, c, d, e, f, g, h] = words;
  const mappedIpv4 = a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && f === 0xffff;
  if (mappedIpv4) return privateIpv4(`${g >> 8}.${g & 0xff}.${h >> 8}.${h & 0xff}`);
  return (
    words.every((word) => word === 0) ||
    (words.slice(0, 7).every((word) => word === 0) && h === 1) ||
    // Obsolete IPv4-compatible addresses can otherwise conceal loopback/private IPv4.
    (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && f === 0) ||
    (a & 0xfe00) === 0xfc00 ||
    (a & 0xffc0) === 0xfe80 ||
    (a & 0xff00) === 0xff00 ||
    (a === 0x64 && b === 0xff9b && c === 1) ||
    (a === 0x100 && b === 0 && c === 0 && d === 0) ||
    (a === 0x2001 && (b === 0 || b === 0x0002 || b === 0x0db8)) ||
    a === 0x2002
  );
}

async function resolveOutboundTarget(value, { label = "外部地址" } = {}) {
  let url;
  try {
    url = new URL(String(value || ""));
  } catch {
    throw new Error(`${label}不是合法的 URL。`);
  }
  if (!["http:", "https:"].includes(url.protocol)) throw new Error(`${label}只支持 http 或 https。`);
  if (url.username || url.password) throw new Error(`${label}不能在 URL 中包含账号或密码。`);
  if (!url.hostname) throw new Error(`${label}缺少域名。`);

  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!privateOutboundAllowed() && (hostname === "localhost" || hostname.endsWith(".localhost"))) {
    throw new Error(`${label}不能指向本机或内网地址。`);
  }
  const literalFamily = net.isIP(hostname);
  const addresses = literalFamily
    ? [{ address: hostname, family: literalFamily }]
    : await dns.lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length || (!privateOutboundAllowed() && addresses.some(({ address }) => privateIpAddress(address)))) {
    throw new Error(`${label}不能指向本机或内网地址。`);
  }
  return { url, addresses };
}

/** Resolve and reject destinations that can reach this host, the LAN, or cloud metadata services. */
export async function assertSafeOutboundUrl(value, { label = "外部地址" } = {}) {
  return (await resolveOutboundTarget(value, { label })).url;
}

function pinnedRequest(target, init, { timeoutMs, timeoutMessage }) {
  const { url, addresses } = target;
  const address = addresses[0];
  return new Promise((resolve, reject) => {
    const transport = url.protocol === "https:" ? https : http;
    const request = transport.request(url, {
      method: init.method || "GET",
      headers: init.headers,
      lookup: (_hostname, options, callback) => {
        if (options?.all) callback(null, addresses.map((item) => ({ address: item.address, family: item.family })));
        else callback(null, address.address, address.family);
      },
    });
    let settled = false;
    const finishError = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const timer = setTimeout(() => request.destroy(new Error(timeoutMessage)), timeoutMs);
    request.on("response", (incoming) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const headers = new Headers();
      for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
        headers.append(incoming.rawHeaders[index], incoming.rawHeaders[index + 1]);
      }
      const bodyForbidden = [101, 204, 205, 304].includes(incoming.statusCode || 0);
      if (bodyForbidden) incoming.resume();
      resolve(new Response(bodyForbidden ? null : incoming, {
        status: incoming.statusCode,
        statusText: incoming.statusMessage,
        headers,
      }));
    });
    request.on("error", (error) => {
      clearTimeout(timer);
      finishError(error);
    });
    if (init.signal) {
      if (init.signal.aborted) request.destroy(init.signal.reason);
      else init.signal.addEventListener("abort", () => request.destroy(init.signal.reason), { once: true });
    }
    const body = init.body;
    if (body === undefined || body === null) request.end();
    else if (typeof body === "string" || Buffer.isBuffer(body) || body instanceof Uint8Array) request.end(body);
    else request.destroy(new TypeError("Unsupported outbound request body"));
  });
}

function withoutSensitiveHeaders(init) {
  const headers = new Headers(init.headers || {});
  for (const name of ["authorization", "cookie", "proxy-authorization"]) headers.delete(name);
  return { ...init, headers: Object.fromEntries(headers.entries()) };
}

function redirectedRequestInit(init, status) {
  const method = String(init.method || "GET").toUpperCase();
  if (status !== 303 && !([301, 302].includes(status) && method === "POST")) return init;
  const headers = new Headers(init.headers || {});
  for (const name of ["content-length", "content-type", "transfer-encoding"]) headers.delete(name);
  const { body: _body, ...rest } = init;
  return { ...rest, method: "GET", headers: Object.fromEntries(headers.entries()) };
}

/** Fetch an operator/user supplied URL, validating every redirect target before following it. */
export async function safeOutboundFetch(
  value,
  init = {},
  { timeoutMs = 120000, timeoutMessage = "外部请求超时。", label = "外部地址", followRedirects = true, maxRedirects = 3 } = {},
) {
  let current = await resolveOutboundTarget(value, { label });
  let requestInit = init;
  for (let redirects = 0; ; redirects += 1) {
    const response = await pinnedRequest(current, requestInit, { timeoutMs, timeoutMessage });
    if (!followRedirects || !REDIRECT_STATUSES.has(response.status)) return response;
    const location = response.headers.get("location");
    if (!location) return response;
    if (redirects >= maxRedirects) throw new Error(`${label}重定向次数过多。`);
    await response.body?.cancel().catch(() => {});
    const redirected = await resolveOutboundTarget(new URL(location, current.url).href, { label });
    if (current.url.protocol === "https:" && redirected.url.protocol !== "https:") {
      throw new Error(`${label}不能从 https 重定向到不安全的 http 地址。`);
    }
    requestInit = redirectedRequestInit(requestInit, response.status);
    if (redirected.url.origin !== current.url.origin) requestInit = withoutSensitiveHeaders(requestInit);
    current = redirected;
  }
}

/** Read a response body with an independent deadline and a hard decoded byte ceiling. */
export async function readResponseBufferLimited(
  response,
  { maxBytes, timeoutMs = 120000, timeoutMessage = "下载响应超时。", label = "下载内容" } = {},
) {
  const limit = Number(maxBytes);
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new TypeError("maxBytes must be a positive integer");
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) throw new Error(`${label}超过 ${Math.ceil(limit / 1024 / 1024)}MB 上限。`);
  if (!response.body) return Buffer.alloc(0);

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  let timer;
  try {
    return await new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        void reader.cancel(timeoutMessage).catch(() => {});
        reject(new Error(timeoutMessage));
      }, timeoutMs);
      const pump = async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > limit) {
              await reader.cancel("response too large").catch(() => {});
              throw new Error(`${label}超过 ${Math.ceil(limit / 1024 / 1024)}MB 上限。`);
            }
            chunks.push(Buffer.from(value));
          }
          resolve(Buffer.concat(chunks, total));
        } catch (error) {
          reject(error);
        }
      };
      void pump();
    });
  } finally {
    clearTimeout(timer);
  }
}
