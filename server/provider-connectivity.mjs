import { summarizeProviderErrorText } from "./provider-health.mjs";
import { fetchWithTimeout } from "./timeouts.mjs";

function responseBodySummary(text) {
  const value = String(text || "").trim();
  if (!value) return "上游没有返回错误说明。";
  // 网关出故障时经常回一整页 HTML；不要把整页源码塞进顶部提示。
  if (/<(?:!doctype|html)\b/i.test(value)) return "上游返回了 HTML 错误页，通常是网关或代理异常。";
  return summarizeProviderErrorText(value, 240);
}

/**
 * 只检查兼容接口的 /models，不调用 /images/generations，因此不会生成图片。
 * 成功代表地址可达且 Key 被接口接受；不要求模型一定出现在列表里，因为部分中转
 * 会返回精简模型列表，真正的模型可用性仍由出图请求确认。
 */
export async function testProviderConnectivity({ baseUrl, model, apiKey } = {}) {
  const normalizedBaseUrl = String(baseUrl || "").replace(/\/+$/, "");
  if (!String(apiKey || "").trim()) {
    return {
      ok: false,
      label: "未配置 Key",
      message: "当前图像接口没有可用的 API Key，无法测试。",
    };
  }
  if (!normalizedBaseUrl) {
    return {
      ok: false,
      label: "地址缺失",
      message: "当前图像接口没有配置地址，无法测试。",
    };
  }

  try {
    const response = await fetchWithTimeout(
      `${normalizedBaseUrl}/models`,
      {
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
      },
      { timeoutMs: 15000, timeoutMessage: "接口 15 秒没有响应。" },
    );
    const text = await response.text();
    if (!response.ok) {
      return {
        ok: false,
        label: "连接失败",
        message: `${normalizedBaseUrl} 返回 ${response.status}：${responseBodySummary(text)}`,
      };
    }

    let count = null;
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed?.data)) count = parsed.data.length;
    } catch {
      // 只要接口返回 2xx 就算连通；有的中转不会返回标准 /models JSON。
    }
    return {
      ok: true,
      label: "连接成功",
      message: `连通正常（未生成图片）${count === null ? "" : `，可见 ${count} 个模型`}。当前模型名 ${model || "未填写"}。`,
    };
  } catch (error) {
    return {
      ok: false,
      label: "连接失败",
      message: error instanceof Error ? error.message : "连接失败。",
    };
  }
}
