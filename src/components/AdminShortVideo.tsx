import { useCallback, useEffect, useMemo, useState } from "react";
import { Clapperboard } from "lucide-react";
import {
  fetchShortVideoAdmin,
  restartShortVideoEngine,
  saveShortVideoEngineConfig,
  saveShortVideoSettings,
  testShortVideoLlm,
} from "../lib/api";
import type { ShortVideoAdminOverview, ShortVideoEngineConfigField } from "../types";
import { Section } from "./ui";

/**
 * 后台「短视频接口」：两层配置都收在这里，省得再去 ssh 改文件。
 *
 * - 本站这层（文案模型走哪条线路 / 模型名 / 自备 Key / 每人同时几条）存数据库，保存即生效。
 * - 引擎那层（素材库 Key、字幕方案、并发）改的是 MoneyPrinterTurbo 的 config.toml，
 *   它只在启动时读一次配置，所以保存完要重启引擎才算数——按钮就在旁边。
 */

const GROUP_TITLES: Record<string, { title: string; note: string }> = {
  material: {
    title: "素材库 Key",
    note: "在线素材（Pexels / Pixabay / Coverr）都要各自的免费 Key。一个都没配的话，短视频只能用「本地素材」。",
  },
  voice: {
    title: "配音增强",
    note: "不配也能用：默认的 Edge TTS 免费、无需 Key。配了下面这些才会多出 Azure / 硅基流动的音色。",
  },
  engine: {
    title: "引擎运行参数",
    note: "字幕方案、并发这些直接影响机器负载。2 核的小机器上 whisper 会很吃力，除非你有更好的机器。",
  },
};

function fieldValueText(field: ShortVideoEngineConfigField) {
  if (field.kind === "secretList") return field.count ? `已配 ${field.count} 个` : "未配置";
  if (field.kind === "secret") return field.configured ? `已配置 ${field.hint2 || ""}` : "未配置";
  return String(field.value ?? "");
}

export function AdminShortVideo() {
  const [data, setData] = useState<ShortVideoAdminOverview | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");
  const [settingsDraft, setSettingsDraft] = useState({ llmProviderId: "", llmBaseUrl: "", llmModel: "", llmApiKey: "", maxActivePerUser: "" });
  const [engineDraft, setEngineDraft] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    try {
      const next = await fetchShortVideoAdmin();
      setData(next);
      setSettingsDraft({
        llmProviderId: next.settings.llmProviderId,
        llmBaseUrl: next.settings.llmBaseUrl,
        llmModel: next.settings.llmModel,
        llmApiKey: "",
        maxActivePerUser: String(next.settings.maxActivePerUser),
      });
      setEngineDraft({});
      setError("");
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "短视频配置加载失败。");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const groups = useMemo(() => {
    const map = new Map<string, ShortVideoEngineConfigField[]>();
    for (const field of data?.engineConfig.fields ?? []) {
      const list = map.get(field.group) ?? [];
      list.push(field);
      map.set(field.group, list);
    }
    return [...map.entries()];
  }, [data]);

  if (!data && !error) return null;

  const engineConfig = data?.engineConfig;
  const engineEditable = Boolean(engineConfig?.editable);

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

  const saveSettings = () =>
    run("settings", async () => {
      const payload: Record<string, string> = {
        llmProviderId: settingsDraft.llmProviderId,
        llmBaseUrl: settingsDraft.llmBaseUrl,
        llmModel: settingsDraft.llmModel,
        maxActivePerUser: settingsDraft.maxActivePerUser,
      };
      // Key 只在填了的时候才提交：不填 = 不动原来那把。
      if (settingsDraft.llmApiKey.trim()) payload.llmApiKey = settingsDraft.llmApiKey.trim();
      await saveShortVideoSettings(payload);
      await load();
      return "已保存，立刻生效。";
    });

  const clearKey = () =>
    run("settings", async () => {
      await saveShortVideoSettings({ llmApiKey: "" });
      await load();
      return "已清除后台配的 Key，退回 .env / 线路共享 Key。";
    });

  const testLlm = () =>
    run("llm", async () => {
      const { result } = await testShortVideoLlm();
      return result.message;
    });

  const saveEngine = () =>
    run("engine", async () => {
      const patch: Record<string, string> = {};
      for (const [id, value] of Object.entries(engineDraft)) {
        if (value === undefined) continue;
        patch[id] = value;
      }
      if (!Object.keys(patch).length) return "没有改动。";
      const result = await saveShortVideoEngineConfig(patch);
      await load();
      if (!result.changed.length) return "没有改动。";
      return result.restartAvailable
        ? `已写入引擎配置（${result.changed.length} 项），点「重启引擎」后生效。`
        : `已写入引擎配置（${result.changed.length} 项）。这台机器没配重启命令，请手动重启引擎服务。`;
    });

  const restart = (force: boolean) =>
    run("restart", async () => {
      const result = await restartShortVideoEngine(force);
      await load();
      return result.engine.online ? "引擎已重启，现在在线。" : `引擎重启了，但还没探到：${result.engine.error || "离线"}`;
    });

  return (
    <Section title="短视频接口" action={<Clapperboard size={17} />}>
      <p className="admin-note">
        短视频模块分两层：<strong>本站</strong>负责写文案、收参数、存成片；<strong>引擎</strong>（MoneyPrinterTurbo，装在同一台机器上、只监听本机）负责配音、字幕、找素材、合成。
        下面上半段改本站，下半段改引擎。谁能看到这个模块在「用户与用量」里按账号开关。
      </p>

      {error ? <p className="admin-create-notice">{error}</p> : null}

      {data ? (
        <div className="admin-provider-list">
          <form
            className="admin-provider"
            onSubmit={(event) => {
              event.preventDefault();
              void saveSettings();
            }}
          >
            <header className="admin-provider-head">
              <strong>本站 · 写文案的模型</strong>
              <span>
                {data.llm.demo ? "演示模式（会用示例文案）" : `${data.llm.model} · ${data.llm.configured ? "Key 已配置" : "缺 Key"}`}
                {" · "}
                每人同时最多 {data.settings.maxActivePerUser} 条
              </span>
            </header>
            <label className="field">
              <span>
                复用哪条线路的地址和共享 Key{" "}
                <em className={`admin-tag ${data.settings.sources.llmProviderId === "admin" ? "admin-tag-ok" : ""}`}>
                  {data.settings.sources.llmProviderId === "admin" ? "后台已改" : "来自 .env"}
                </em>
              </span>
              <select
                className="admin-input"
                value={settingsDraft.llmProviderId}
                onChange={(event) => setSettingsDraft((current) => ({ ...current, llmProviderId: event.target.value }))}
              >
                {data.settings.providers.map((provider) => (
                  <option key={provider.id} value={provider.id}>
                    {provider.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>模型名</span>
              <input
                value={settingsDraft.llmModel}
                onChange={(event) => setSettingsDraft((current) => ({ ...current, llmModel: event.target.value }))}
                placeholder="gpt-4o-mini"
                spellCheck={false}
                autoComplete="off"
              />
            </label>
            <label className="field admin-provider-url">
              <span>另指定接口地址（可留空，留空就用上面那条线路的地址）</span>
              <input
                value={settingsDraft.llmBaseUrl}
                onChange={(event) => setSettingsDraft((current) => ({ ...current, llmBaseUrl: event.target.value }))}
                placeholder="https://api.example.com/v1"
                spellCheck={false}
                autoComplete="off"
              />
            </label>
            <label className="field">
              <span>
                另指定 Key（可留空）{" "}
                <em className={`admin-tag ${data.settings.llmApiKeySource === "admin" ? "admin-tag-ok" : ""}`}>
                  {data.settings.llmApiKeySource === "admin"
                    ? `后台已配 ${data.settings.llmApiKeyHint}`
                    : data.settings.llmApiKeySource === "env"
                      ? "来自 .env"
                      : "用线路共享 Key"}
                </em>
              </span>
              <input
                type="password"
                value={settingsDraft.llmApiKey}
                onChange={(event) => setSettingsDraft((current) => ({ ...current, llmApiKey: event.target.value }))}
                placeholder={data.settings.llmApiKeyConfigured ? "不填就不动原来那把" : "sk-…"}
                spellCheck={false}
                autoComplete="off"
              />
            </label>
            <label className="field">
              <span>每个账号同时能跑几条</span>
              <input
                className="admin-input"
                type="number"
                min={1}
                max={10}
                value={settingsDraft.maxActivePerUser}
                onChange={(event) => setSettingsDraft((current) => ({ ...current, maxActivePerUser: event.target.value }))}
              />
            </label>
            <div className="admin-provider-actions">
              <button type="submit" className="btn btn-primary" disabled={Boolean(busy)}>
                {busy === "settings" ? "保存中…" : "保存"}
              </button>
              <button type="button" className="btn btn-secondary" disabled={Boolean(busy)} onClick={() => void testLlm()}>
                {busy === "llm" ? "测试中…" : "测一下"}
              </button>
              {data.settings.llmApiKeySource === "admin" ? (
                <button type="button" className="btn btn-secondary" disabled={Boolean(busy)} onClick={() => void clearKey()}>
                  清除 Key
                </button>
              ) : null}
            </div>
            <p className="admin-provider-current">
              当前生效：<code>{data.llm.model}</code> · 线路 <code>{data.settings.llmProviderId}</code>
              {data.settings.updatedAt ? ` · 最后修改 ${new Date(data.settings.updatedAt).toLocaleString("zh-CN")}` : ""}
            </p>
          </form>

          <form
            className="admin-provider"
            onSubmit={(event) => {
              event.preventDefault();
              void saveEngine();
            }}
          >
            <header className="admin-provider-head">
              <strong>引擎 · MoneyPrinterTurbo</strong>
              <span>
                {data.engine.configured ? (data.engine.online ? `在线 · ${data.engine.url}` : `离线 · ${data.engine.error || ""}`) : "未接入"}
                {data.activeTasks ? ` · ${data.activeTasks} 条任务在跑` : ""}
              </span>
            </header>

            {!engineEditable ? (
              <p className="admin-note">
                这台机器上改不了引擎配置{engineConfig?.error ? `（${engineConfig.error}）` : ""}。
                在跑引擎的那台机器上把 <code>SHORTVIDEO_ENGINE_CONFIG</code> 指到引擎的 <code>config.toml</code>，
                再配 <code>SHORTVIDEO_ENGINE_RESTART_CMD=systemctl restart mpt-api</code>，这里就能直接改了。
              </p>
            ) : (
              <>
                <p className="admin-provider-current">
                  改的是 <code>{engineConfig?.path}</code>；引擎只在启动时读一次配置，所以保存后要重启才生效。
                </p>
                {groups.map(([group, fields]) => (
                  <div className="admin-shortvideo-group" key={group}>
                    <span className="rail-kicker">{GROUP_TITLES[group]?.title ?? group}</span>
                    <p className="field-hint">{GROUP_TITLES[group]?.note}</p>
                    {fields.map((field) => {
                      const draft = engineDraft[field.id];
                      const current = fieldValueText(field);
                      return (
                        <label className="field" key={field.id}>
                          <span>
                            {field.label}{" "}
                            <em className={`admin-tag ${field.configured ? "admin-tag-ok" : ""}`}>{current}</em>
                          </span>
                          {field.kind === "enum" ? (
                            <select
                              className="admin-input"
                              value={draft ?? String(field.value ?? "")}
                              onChange={(event) => setEngineDraft((cur) => ({ ...cur, [field.id]: event.target.value }))}
                            >
                              {(field.options ?? []).map((option) => (
                                <option key={option} value={option}>
                                  {option}
                                </option>
                              ))}
                            </select>
                          ) : field.kind === "int" ? (
                            <input
                              className="admin-input"
                              type="number"
                              value={draft ?? String(field.value ?? "")}
                              onChange={(event) => setEngineDraft((cur) => ({ ...cur, [field.id]: event.target.value }))}
                            />
                          ) : (
                            <input
                              type={field.kind === "text" ? "text" : "password"}
                              value={draft ?? ""}
                              placeholder={
                                field.kind === "secretList"
                                  ? field.count
                                    ? "填新的会整组替换；多个用逗号分隔"
                                    : "多个用逗号分隔"
                                  : field.configured
                                    ? "不填就不动"
                                    : ""
                              }
                              onChange={(event) => setEngineDraft((cur) => ({ ...cur, [field.id]: event.target.value }))}
                              spellCheck={false}
                              autoComplete="off"
                            />
                          )}
                          <small className="field-hint">
                            {field.hint}
                            {field.docs ? (
                              <>
                                {" "}
                                <a href={field.docs} target="_blank" rel="noreferrer">
                                  去申请
                                </a>
                              </>
                            ) : null}
                          </small>
                        </label>
                      );
                    })}
                  </div>
                ))}
                <div className="admin-provider-actions">
                  <button type="submit" className="btn btn-primary" disabled={Boolean(busy)}>
                    {busy === "engine" ? "写入中…" : "保存到引擎"}
                  </button>
                  {engineConfig?.restartAvailable ? (
                    <button
                      type="button"
                      className="btn btn-secondary"
                      disabled={Boolean(busy)}
                      onClick={() => void restart(false)}
                      title={data.activeTasks ? "有任务在跑时会先拦一下" : "重启引擎让配置生效"}
                    >
                      {busy === "restart" ? "重启中…" : "重启引擎"}
                    </button>
                  ) : null}
                </div>
              </>
            )}
          </form>
        </div>
      ) : null}

      {notice ? <p className="admin-create-notice">{notice}</p> : null}
    </Section>
  );
}
