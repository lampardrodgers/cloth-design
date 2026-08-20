import { useCallback, useEffect, useState } from "react";
import { Sparkles } from "lucide-react";
import { fetchSeedanceAdmin, saveSeedanceSettings, testSeedanceAdmin } from "../lib/api";
import type { SeedanceAdminOverview, SeedanceArkModel, SeedanceModelAccess } from "../types";
import { Section } from "./ui";

/**
 * 后台「Seedance 接口」：火山方舟的 Key、接口地址、默认模型、每人并发、参考素材的公网地址、哪些模型开放给用户。
 * 存数据库，保存即生效；Key 加密落库、只回脱敏提示。
 * 「测一下」只列任务 + 拉模型列表，不会生成视频、不产生费用。
 */

function modelStatusLabel(status: string) {
  if (status === "Retiring") return "退役中";
  if (status === "Shutdown") return "已下线";
  return "可用";
}

export function AdminSeedance() {
  const [data, setData] = useState<SeedanceAdminOverview | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");
  const [draft, setDraft] = useState({ apiKey: "", baseUrl: "", defaultModel: "", maxActivePerUser: "", publicBaseUrl: "" });
  const [enabled, setEnabled] = useState<string[]>([]);
  const [arkModels, setArkModels] = useState<SeedanceArkModel[] | null>(null);
  const [modelAccess, setModelAccess] = useState<SeedanceModelAccess[] | null>(null);

  const load = useCallback(async () => {
    try {
      const next = await fetchSeedanceAdmin();
      setData(next);
      setDraft({
        apiKey: "",
        baseUrl: next.settings.baseUrl,
        defaultModel: next.settings.defaultModel,
        maxActivePerUser: String(next.settings.maxActivePerUser),
        publicBaseUrl: next.settings.publicBaseUrl,
      });
      setEnabled(next.settings.enabledModels.length ? next.settings.enabledModels : next.models.map((model) => model.id));
      setError("");
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Seedance 配置加载失败。");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (!data && !error) return null;

  const run = async (key: string, task: () => Promise<string>) => {
    setBusy(key);
    setNotice("");
    try {
      setNotice(await task());
    } catch (taskError) {
      setNotice(taskError instanceof Error ? taskError.message : "操作失败。");
    } finally {
      setBusy("");
    }
  };

  const save = () =>
    run("save", async () => {
      const allIds = data?.models.map((model) => model.id) ?? [];
      const payload: Parameters<typeof saveSeedanceSettings>[0] = {
        baseUrl: draft.baseUrl,
        defaultModel: draft.defaultModel,
        maxActivePerUser: draft.maxActivePerUser,
        publicBaseUrl: draft.publicBaseUrl,
        // 全勾 = 不限制（清掉后台覆盖），否则存勾选的那几个。
        enabledModels: enabled.length === allIds.length ? "" : enabled,
      };
      // Key 只在填了的时候才提交：不填 = 不动原来那把。
      if (draft.apiKey.trim()) payload.apiKey = draft.apiKey.trim();
      const result = await saveSeedanceSettings(payload);
      await load();
      return result.status.online ? "已保存，方舟连通。" : `已保存。${result.status.configured ? `但方舟没连上：${result.status.error}` : "还没有 Key。"}`;
    });

  const clearKey = () =>
    run("save", async () => {
      await saveSeedanceSettings({ apiKey: "" });
      await load();
      return "已清除后台配的 Key，退回 .env 的 SEEDANCE_API_KEY（如果有）。";
    });

  const test = () =>
    run("test", async () => {
      const result = await testSeedanceAdmin();
      setArkModels(result.models);
      setModelAccess(result.modelAccess ?? []);
      const seedance = result.models.filter((model) => /seedance/i.test(model.id));
      const usable = seedance.filter((model) => model.status !== "Shutdown");
      const okCount = (result.modelAccess ?? []).filter((item) => item.access === "ok").length;
      const denied = (result.modelAccess ?? []).filter((item) => item.access === "unauthorized").length;
      const accessNote = result.modelAccess?.length
        ? denied === result.modelAccess.length
          ? `但这把 Key 对目录里 ${denied} 个模型都没有调用权限——提交任务会被方舟拒绝，去「API Key 管理」把权限范围改成「全部资源」或把 Seedance 模型加进去。`
          : `模型调用权限：${okCount}/${result.modelAccess.length} 个可用${denied ? `，${denied} 个没权限` : ""}。`
        : "";
      return `连通，${result.latencyMs} ms；账号下共 ${result.total} 条视频任务。平台可见 Seedance 模型 ${seedance.length} 个，未下线 ${usable.length} 个。${accessNote}${result.modelsError ? `（模型列表拉取失败：${result.modelsError}）` : ""}`;
    });

  const toggleModel = (id: string) => setEnabled((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]));

  return (
    <Section title="Seedance 接口" action={<Sparkles size={17} />}>
      <p className="admin-note">
        「短视频 → AI 直出」走火山方舟的 Seedance 视频模型。Key 在火山方舟控制台「API Key 管理」里生成：填<strong>「API Key Secret」</strong>那一串（ID 不用填）。
        新建 Key 时权限范围选<strong>「全部资源」</strong>（或把 Seedance 模型加进自定义资源），别开 IP 白名单，且要建在开通了 Seedance 的那个资源项目下——否则 Key 能连通、一提交就被方舟拒绝。
        模型要先在方舟「开通管理」里开通（2.x 系列要求账户余额 &gt; 200 元或买了节省计划）。按方舟实际用量计费，本站暂不扣积分。「测一下」会顺带自检每个模型的调用权限（只发注定被参数校验拦下的请求，不会建任务、不花钱）。
      </p>

      {error ? <p className="admin-create-notice">{error}</p> : null}

      {data ? (
        <div className="admin-provider-list">
          <form
            className="admin-provider"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <header className="admin-provider-head">
              <strong>火山方舟</strong>
              <span>
                {data.status.configured ? (data.status.online ? `在线 · ${data.status.latencyMs ?? "?"} ms` : `离线：${data.status.error}`) : "未配置 Key"}
                {" · "}
                每人同时最多 {data.settings.maxActivePerUser} 条
                {data.activeTasks ? ` · ${data.activeTasks} 条在跑` : ""}
              </span>
            </header>
            <label className="field">
              <span>
                API Key{" "}
                <em className={`admin-tag ${data.settings.apiKeySource === "admin" ? "admin-tag-ok" : ""}`}>
                  {data.settings.apiKeySource === "admin" ? `后台已配 ${data.settings.apiKeyHint}` : data.settings.apiKeySource === "env" ? "来自 .env" : "未配置"}
                </em>
              </span>
              <input
                type="password"
                value={draft.apiKey}
                onChange={(event) => setDraft((current) => ({ ...current, apiKey: event.target.value }))}
                placeholder={data.settings.apiKeyConfigured ? "不填就不动原来那把" : "粘贴 API Key Secret"}
                spellCheck={false}
                autoComplete="off"
              />
            </label>
            <label className="field admin-provider-url">
              <span>
                接口地址{" "}
                <em className={`admin-tag ${data.settings.sources.baseUrl === "admin" ? "admin-tag-ok" : ""}`}>{data.settings.sources.baseUrl === "admin" ? "后台已改" : "默认 / .env"}</em>
              </span>
              <input value={draft.baseUrl} onChange={(event) => setDraft((current) => ({ ...current, baseUrl: event.target.value }))} placeholder="https://ark.cn-beijing.volces.com/api/v3" spellCheck={false} autoComplete="off" />
            </label>
            <label className="field">
              <span>默认模型</span>
              <select className="admin-input" value={draft.defaultModel} onChange={(event) => setDraft((current) => ({ ...current, defaultModel: event.target.value }))}>
                {data.models.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.name}
                    {model.status === "retiring" ? "（退役中）" : ""} · {model.id}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>每个账号同时能跑几条</span>
              <input className="admin-input" type="number" min={1} max={10} value={draft.maxActivePerUser} onChange={(event) => setDraft((current) => ({ ...current, maxActivePerUser: event.target.value }))} />
            </label>
            <label className="field admin-provider-url">
              <span>
                公网地址（方舟取参考视频 / 音频用）{" "}
                <em className={`admin-tag ${data.status.publicMediaReady ? "admin-tag-ok" : ""}`}>{data.status.publicMediaReady ? "可用" : "未配置或是内网地址"}</em>
              </span>
              <input value={draft.publicBaseUrl} onChange={(event) => setDraft((current) => ({ ...current, publicBaseUrl: event.target.value }))} placeholder="https://你的域名" spellCheck={false} autoComplete="off" />
            </label>
            <div className="field">
              <span>开放给用户的模型（全勾 = 不限制）</span>
              <div className="admin-seedance-models">
                {data.models.map((model) => (
                  <label key={model.id} className="shortvideo-check">
                    <input type="checkbox" checked={enabled.includes(model.id)} onChange={() => toggleModel(model.id)} />
                    <span>
                      <strong>
                        {model.name}
                        {model.status === "retiring" ? "（退役中）" : ""}
                      </strong>
                      <small>{model.blurb}</small>
                    </span>
                  </label>
                ))}
              </div>
            </div>
            <div className="admin-provider-actions">
              <button type="submit" className="btn btn-primary" disabled={Boolean(busy)}>
                {busy === "save" ? "保存中…" : "保存"}
              </button>
              <button type="button" className="btn btn-secondary" disabled={Boolean(busy) || !data.settings.apiKeyConfigured} onClick={() => void test()}>
                {busy === "test" ? "测试中…" : "测一下"}
              </button>
              {data.settings.apiKeySource === "admin" ? (
                <button type="button" className="btn btn-secondary" disabled={Boolean(busy)} onClick={() => void clearKey()}>
                  清除 Key
                </button>
              ) : null}
            </div>
            <p className="admin-provider-current">
              当前生效：<code>{data.settings.baseUrl}</code> · 默认 <code>{data.settings.defaultModel}</code>
              {data.settings.updatedAt ? ` · 后台改于 ${new Date(data.settings.updatedAt).toLocaleString()}` : ""}
            </p>
            {notice ? <p className="admin-create-notice">{notice}</p> : null}
            {modelAccess && modelAccess.length ? (
              <ul className="admin-seedance-access">
                {modelAccess.map((item) => (
                  <li key={item.model} className={`access-${item.access}`}>
                    <code>{item.model}</code>
                    <strong>{item.access === "ok" ? "可调用" : item.access === "unauthorized" ? "Key 无权限" : item.access === "not_open" ? "未开通" : item.access === "unknown" ? "方舟不认识" : "没探到"}</strong>
                    {item.detail ? <small>{item.detail}</small> : null}
                  </li>
                ))}
              </ul>
            ) : null}
            {arkModels ? (
              <details className="admin-seedance-arkmodels" open>
                <summary>方舟平台可见的视频模型（{arkModels.length}）</summary>
                <ul>
                  {arkModels.map((model) => (
                    <li key={model.id}>
                      <code>{model.id}</code> · {modelStatusLabel(model.status)}
                      {model.inCatalog ? "" : " · 本站目录里没有"}
                      {model.taskTypes.length ? ` · ${model.taskTypes.join(" / ")}` : ""}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
          </form>
        </div>
      ) : null}
    </Section>
  );
}
