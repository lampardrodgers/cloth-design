import { useEffect, useState, type FormEvent } from "react";
import type { WebdavSettingsInput } from "../lib/api";
import { formatResultTime } from "../lib/resultFiles";
import type { GeneratedResult, StorageOverview, StorageStatus } from "../types";

/** 这台电脑上的本地文件夹状态（浏览器端，服务端不知情）。 */
export interface LocalFolderState {
  supported: boolean;
  /** 已选文件夹的名字；没选是 null。 */
  name: string | null;
  permission: "granted" | "prompt" | "denied" | null;
  autoSave: boolean;
  savedCount: number;
  lastSavedPath: string | null;
  lastError: string | null;
}

interface StoragePanelProps {
  overview: StorageOverview | null;
  results: GeneratedResult[];
  loading: boolean;
  onRefresh: () => void;
  onSaveWebdav: (input: WebdavSettingsInput) => Promise<string | void>;
  onTestWebdav: (input: WebdavSettingsInput) => Promise<{ ok: boolean; message: string }>;
  onArchive: (id: string) => Promise<string | void>;
  onArchiveAll: () => Promise<string | void>;
  onDelete: (id: string) => Promise<string | void> | void;
  localFolder: LocalFolderState;
  onPickFolder: () => Promise<string | void>;
  onForgetFolder: () => Promise<void>;
  onToggleAutoSave: (value: boolean) => void;
  onSaveToFolder: (result: GeneratedResult) => Promise<string | void>;
  onSaveAllToFolder: () => Promise<string | void>;
}

const RETENTION_FALLBACK_DAYS = 3;

const serverStatusLabels: Record<StorageStatus, string> = {
  "local-cache": "服务器暂存",
  "cloud-temp": "服务器暂存",
  webdav: "服务器暂存",
  expired: "已清理",
};

/** 「剩 2 天 5 小时」这类倒计时；过期返回 null。 */
export function formatRemaining(expiresAt?: string | null, now = Date.now()) {
  if (!expiresAt) return null;
  const diff = Date.parse(expiresAt) - now;
  if (!Number.isFinite(diff) || diff <= 0) return null;
  const hours = Math.floor(diff / (60 * 60 * 1000));
  const days = Math.floor(hours / 24);
  if (days >= 1) return `剩 ${days} 天 ${hours - days * 24} 小时`;
  if (hours >= 1) return `剩 ${hours} 小时`;
  return "1 小时内到期";
}

function formatDateTime(iso?: string | null) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(date);
}

export function StoragePanel({
  overview,
  results,
  loading,
  onRefresh,
  onSaveWebdav,
  onTestWebdav,
  onArchive,
  onArchiveAll,
  onDelete,
  localFolder,
  onPickFolder,
  onForgetFolder,
  onToggleAutoSave,
  onSaveToFolder,
  onSaveAllToFolder,
}: StoragePanelProps) {
  const retentionDays = overview?.retentionDays ?? RETENTION_FALLBACK_DAYS;
  const settings = overview?.settings;

  // WebDAV 表单：以服务端返回的为准，用户在改的时候不被覆盖
  const [webdavUrl, setWebdavUrl] = useState("");
  const [webdavUsername, setWebdavUsername] = useState("");
  const [webdavPassword, setWebdavPassword] = useState("");
  const [webdavDirectory, setWebdavDirectory] = useState("ClothDesign");
  const [webdavEnabled, setWebdavEnabled] = useState(false);
  const [autoArchive, setAutoArchive] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [webdavNotice, setWebdavNotice] = useState<{ tone: "ok" | "error" | "info"; text: string } | null>(null);
  const [webdavBusy, setWebdavBusy] = useState<"" | "save" | "test" | "archive-all">("");
  const [rowBusy, setRowBusy] = useState<Record<string, string>>({});
  const [rowNotice, setRowNotice] = useState<Record<string, string>>({});
  const [folderNotice, setFolderNotice] = useState("");
  const [folderBusy, setFolderBusy] = useState(false);

  useEffect(() => {
    if (!settings || dirty) return;
    setWebdavUrl(settings.webdavUrl);
    setWebdavUsername(settings.webdavUsername);
    setWebdavDirectory(settings.webdavDirectory);
    setWebdavEnabled(settings.webdavEnabled);
    setAutoArchive(settings.autoArchive);
  }, [settings?.updatedAt, settings?.webdavUrl, settings?.webdavUsername, settings?.webdavDirectory, settings?.webdavEnabled, settings?.autoArchive, dirty]);

  const markDirty = () => setDirty(true);

  const currentInput = (): WebdavSettingsInput => ({
    webdavUrl,
    webdavUsername,
    webdavDirectory,
    webdavEnabled,
    autoArchive,
    ...(webdavPassword ? { webdavPassword } : {}),
  });

  const submitWebdav = async (event: FormEvent) => {
    event.preventDefault();
    setWebdavBusy("save");
    setWebdavNotice(null);
    const error = await onSaveWebdav(currentInput());
    setWebdavBusy("");
    if (error) {
      setWebdavNotice({ tone: "error", text: error });
      return;
    }
    setWebdavPassword("");
    setDirty(false);
    setWebdavNotice({ tone: "ok", text: webdavEnabled ? "已保存。以后可以在成片列表里把文件推到云盘。" : "已保存（WebDAV 未启用）。" });
  };

  const testWebdav = async () => {
    setWebdavBusy("test");
    setWebdavNotice({ tone: "info", text: "正在连接…" });
    const outcome = await onTestWebdav(currentInput());
    setWebdavBusy("");
    setWebdavNotice({ tone: outcome.ok ? "ok" : "error", text: outcome.message });
  };

  const archiveAll = async () => {
    setWebdavBusy("archive-all");
    setWebdavNotice({ tone: "info", text: "正在逐张推送…" });
    const error = await onArchiveAll();
    setWebdavBusy("");
    setWebdavNotice(error ? { tone: "error", text: error } : { tone: "ok", text: "已把服务器上还没推过的成片全部推到云盘。" });
  };

  const runRow = async (id: string, action: string, task: () => Promise<string | void>) => {
    setRowBusy((current) => ({ ...current, [id]: action }));
    setRowNotice((current) => ({ ...current, [id]: "" }));
    const error = await task();
    setRowBusy((current) => ({ ...current, [id]: "" }));
    if (error) setRowNotice((current) => ({ ...current, [id]: error }));
  };

  const pickFolder = async () => {
    setFolderBusy(true);
    setFolderNotice("");
    const error = await onPickFolder();
    setFolderBusy(false);
    if (error) setFolderNotice(error);
  };

  const saveAllLocal = async () => {
    setFolderBusy(true);
    setFolderNotice("正在写入本地文件夹…");
    const error = await onSaveAllToFolder();
    setFolderBusy(false);
    setFolderNotice(error || "已把服务器上还在的成片全部存到本地文件夹。");
  };

  const activeCount = overview?.active ?? results.filter((item) => item.storageStatus === "cloud-temp" || item.storageStatus === "local-cache").length;
  const archivedCount = overview?.archived ?? results.filter((item) => item.storageStatus === "webdav").length;
  const expiredCount = overview?.expired ?? results.filter((item) => item.storageStatus === "expired").length;
  const expiredBackedUp = overview?.expiredBackedUp ?? 0;
  const pendingArchiveCount = results.filter((item) => item.storageStatus === "cloud-temp" || item.storageStatus === "local-cache").length;
  const savableCount = results.filter((item) => item.storageStatus !== "expired").length;

  const folderReady = localFolder.supported && Boolean(localFolder.name) && localFolder.permission === "granted";

  return (
    <div className="storage-layout editorial-page">
      <section className="metric-row storage-metrics">
        <div className="metric metric-default">
          <span>服务器暂存</span>
          <strong>{activeCount}张</strong>
          <small className="metric-hint">固定保留 {retentionDays} 天，到期自动清理</small>
        </div>
        <div className="metric metric-default">
          <span>本地文件夹</span>
          <strong className={localFolder.name ? "" : "storage-metric-muted"}>{localFolder.name ? (localFolder.autoSave ? "自动" : "手动") : "未选"}</strong>
          <small className="metric-hint">
            {localFolder.name ? `${localFolder.name} · 本次已存 ${localFolder.savedCount} 张` : "选一个文件夹，成片直接落到这台电脑"}
          </small>
        </div>
        <div className="metric metric-good">
          <span>已推云盘</span>
          <strong>{archivedCount}张</strong>
          <small className="metric-hint">{settings?.webdavEnabled ? (settings.autoArchive ? "WebDAV 自动归档已开" : "WebDAV 已启用 · 手动推送") : "WebDAV 未启用"}</small>
        </div>
        <div className="metric metric-default">
          <span>已清理</span>
          <strong className={expiredCount ? "" : "storage-metric-muted"}>{expiredCount}张</strong>
          <small className="metric-hint">{expiredCount ? `其中 ${expiredBackedUp} 张有云盘备份` : "过期的成片会记在这里"}</small>
        </div>
      </section>

      <section className="editorial-split storage-split">
        <div className="editorial-section storage-card">
          <div className="editorial-section-head">
            <span className="rail-kicker">服务器暂存</span>
            <small>写死 {retentionDays} 天</small>
          </div>
          <p className="storage-lead">
            出图后原图先落在服务器上，<strong>只保留 {retentionDays} 天</strong>。到期由服务器每小时的巡检自动删掉文件，
            记录会标成「已清理」——标题、时间和云盘备份路径还在，图看不了了。
          </p>
          <p className="muted-text">
            这 {retentionDays} 天里，把想留的成片存到<strong>本地文件夹</strong>或推到<strong>WebDAV 云盘</strong>，两条路任选、可以都开。
            服务器不是网盘，别指望它长期存东西。
          </p>
        </div>

        <div className="editorial-section storage-card">
          <div className="editorial-section-head">
            <span className="rail-kicker">本地文件夹</span>
            <small>{localFolder.supported ? "这台电脑 · 跟着浏览器" : "当前浏览器不支持"}</small>
          </div>
          {!localFolder.supported ? (
            <p className="muted-text">
              直接写入本地文件夹需要 Chrome 或 Edge（桌面版，HTTPS）。当前浏览器不支持，可以在成片列表里逐张「下载」。
            </p>
          ) : (
            <>
              <div className="storage-folder-row">
                <span className={`storage-folder-name ${localFolder.name ? "" : "storage-folder-empty"}`}>
                  {localFolder.name ? (
                    <>
                      <i aria-hidden="true">▣</i> {localFolder.name}
                      {localFolder.permission && localFolder.permission !== "granted" ? <em>（需要重新授权）</em> : null}
                    </>
                  ) : (
                    "还没有选择文件夹"
                  )}
                </span>
                <span className="storage-folder-actions">
                  <button type="button" className="btn btn-primary" onClick={pickFolder} disabled={folderBusy}>
                    {localFolder.name ? (localFolder.permission === "granted" ? "更换文件夹" : "重新授权") : "选择文件夹"}
                  </button>
                  {localFolder.name ? (
                    <button type="button" className="text-button" onClick={() => void onForgetFolder()} disabled={folderBusy}>
                      断开
                    </button>
                  ) : null}
                </span>
              </div>
              <div className="switch-row">
                <label>
                  <input type="checkbox" checked={localFolder.autoSave} onChange={(event) => onToggleAutoSave(event.target.checked)} disabled={!localFolder.name} />
                  <span>每次出图后自动存到这个文件夹</span>
                </label>
              </div>
              <div className="storage-inline-actions">
                <button type="button" className="btn btn-secondary" onClick={saveAllLocal} disabled={!folderReady || folderBusy || savableCount === 0}>
                  把当前 {savableCount} 张全部存到本地
                </button>
                <small className="muted-text">按日期分子目录，文件名带标题；同名覆盖。</small>
              </div>
              {folderNotice ? <p className="storage-notice">{folderNotice}</p> : null}
              {localFolder.lastError ? <p className="storage-notice storage-notice-error">{localFolder.lastError}</p> : null}
              {localFolder.lastSavedPath ? <p className="muted-text storage-last">最近写入：{localFolder.lastSavedPath}</p> : null}
            </>
          )}
        </div>
      </section>

      <section className="editorial-section storage-card">
        <div className="editorial-section-head">
          <span className="rail-kicker">WebDAV 云盘</span>
          <small>{settings?.lastArchivedAt ? `最近推送 ${formatDateTime(settings.lastArchivedAt)}` : "坚果云 / Nextcloud / 群晖等都可以"}</small>
        </div>
        <form className="storage-webdav" onSubmit={submitWebdav}>
          <label className="field storage-webdav-url">
            <span>远程地址</span>
            <input
              value={webdavUrl}
              placeholder="https://dav.jianguoyun.com/dav/"
              autoComplete="off"
              onChange={(event) => {
                setWebdavUrl(event.target.value);
                markDirty();
              }}
            />
          </label>
          <label className="field">
            <span>账号</span>
            <input
              value={webdavUsername}
              autoComplete="off"
              onChange={(event) => {
                setWebdavUsername(event.target.value);
                markDirty();
              }}
            />
          </label>
          <label className="field">
            <span>{settings?.hasPassword ? "密码（已保存，留空不改）" : "密码 / 应用密码"}</span>
            <input
              type="password"
              value={webdavPassword}
              autoComplete="new-password"
              placeholder={settings?.hasPassword ? "••••••••" : "坚果云等网盘用「应用密码」"}
              onChange={(event) => {
                setWebdavPassword(event.target.value);
                markDirty();
              }}
            />
          </label>
          <label className="field">
            <span>目录</span>
            <input
              value={webdavDirectory}
              placeholder="ClothDesign"
              onChange={(event) => {
                setWebdavDirectory(event.target.value);
                markDirty();
              }}
            />
          </label>
          <div className="switch-row storage-webdav-switches">
            <label>
              <input
                type="checkbox"
                checked={webdavEnabled}
                onChange={(event) => {
                  setWebdavEnabled(event.target.checked);
                  if (!event.target.checked) setAutoArchive(false);
                  markDirty();
                }}
              />
              <span>启用 WebDAV</span>
            </label>
            <label>
              <input
                type="checkbox"
                checked={autoArchive}
                disabled={!webdavEnabled}
                onChange={(event) => {
                  setAutoArchive(event.target.checked);
                  markDirty();
                }}
              />
              <span>每次出图后自动推到云盘</span>
            </label>
          </div>
          <div className="storage-webdav-actions">
            <button type="submit" className="btn btn-primary" disabled={webdavBusy !== ""}>
              {webdavBusy === "save" ? "保存中…" : "保存"}
            </button>
            <button type="button" className="btn btn-secondary" onClick={testWebdav} disabled={webdavBusy !== ""}>
              {webdavBusy === "test" ? "连接中…" : "测试连接"}
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={archiveAll}
              disabled={webdavBusy !== "" || !settings?.webdavEnabled || pendingArchiveCount === 0}
              title={settings?.webdavEnabled ? "" : "先保存并启用 WebDAV"}
            >
              {webdavBusy === "archive-all" ? "推送中…" : `把未推的 ${pendingArchiveCount} 张全部推到云盘`}
            </button>
          </div>
          {webdavNotice ? <p className={`storage-notice storage-notice-${webdavNotice.tone}`}>{webdavNotice.text}</p> : null}
          {settings?.lastError && !webdavNotice ? (
            <p className="storage-notice storage-notice-error">
              上次推送失败（{formatDateTime(settings.lastErrorAt)}）：{settings.lastError}
            </p>
          ) : null}
          <p className="muted-text storage-webdav-help">
            文件会放到 <code>{webdavDirectory || "ClothDesign"}/日期/标题.png</code>。坚果云地址是 <code>https://dav.jianguoyun.com/dav/</code>，密码要在坚果云「账户信息 → 安全选项」里生成应用密码。
          </p>
        </form>
      </section>

      <section className="editorial-section storage-card">
        <div className="editorial-section-head">
          <span className="rail-kicker">成片文件</span>
          <small>
            {results.length} 个 ·{" "}
            <button type="button" className="text-button" onClick={onRefresh} disabled={loading}>
              {loading ? "刷新中…" : "刷新"}
            </button>
          </small>
        </div>
        {results.length === 0 ? (
          <p className="muted-text">还没有文件。出图之后在这里存本地、推云盘或删除。</p>
        ) : (
          <div className="storage-table-wrap">
            <table className="editorial-table storage-table">
              <thead>
                <tr>
                  <th>文件</th>
                  <th>生成时间</th>
                  <th>服务器</th>
                  <th>云盘</th>
                  <th className="storage-col-actions">操作</th>
                </tr>
              </thead>
              <tbody>
                {results.map((result) => {
                  const expired = result.storageStatus === "expired";
                  const archived = Boolean(result.archivePath);
                  const remaining = formatRemaining(result.expiresAt);
                  const busy = rowBusy[result.id] || "";
                  return (
                    <tr key={result.id} className={expired ? "storage-row-expired" : ""}>
                      <td>
                        <span className="storage-file-cell">
                          {expired ? (
                            <i className="storage-thumb storage-thumb-expired" aria-hidden="true">✕</i>
                          ) : (
                            <img className="storage-thumb" src={result.imageUrl} alt="" loading="lazy" />
                          )}
                          <span className="storage-file-lines">
                            <strong>{result.title}</strong>
                            <small className="muted">{result.ratioLabel} · {result.mode}</small>
                          </span>
                        </span>
                      </td>
                      <td className="muted tabular">{formatResultTime(result.createdAt)}</td>
                      <td className={expired ? "muted" : ""}>
                        {expired ? "已清理" : serverStatusLabels[result.storageStatus]}
                        {!expired && remaining ? <small className="storage-remaining"> · {remaining}</small> : null}
                        {!expired && !remaining && result.expiresAt ? <small className="storage-remaining"> · 即将清理</small> : null}
                      </td>
                      <td className={archived ? "positive" : "muted"} title={result.archivePath || ""}>
                        {archived ? `已推 · ${result.archivePath?.split("/").slice(-2).join("/")}` : "未推"}
                      </td>
                      <td className="storage-col-actions">
                        <span className="storage-row-actions">
                          {!expired && localFolder.supported ? (
                            <button
                              type="button"
                              className="text-button"
                              disabled={!folderReady || busy !== ""}
                              title={folderReady ? "写入本地文件夹" : "先在上面选择本地文件夹"}
                              onClick={() => void runRow(result.id, "local", () => onSaveToFolder(result))}
                            >
                              {busy === "local" ? "写入中…" : "存本地"}
                            </button>
                          ) : null}
                          {!expired ? (
                            <button
                              type="button"
                              className="text-button"
                              disabled={busy !== "" || !settings?.webdavEnabled}
                              title={settings?.webdavEnabled ? (archived ? "再推一次（覆盖）" : "推到云盘") : "先启用 WebDAV"}
                              onClick={() => void runRow(result.id, "archive", () => onArchive(result.id))}
                            >
                              {busy === "archive" ? "推送中…" : archived ? "重推" : "推云盘"}
                            </button>
                          ) : null}
                          {!expired ? (
                            <a className="text-button" href={result.imageUrl} download aria-label="下载">
                              下载
                            </a>
                          ) : null}
                          <button
                            type="button"
                            className="text-button danger"
                            disabled={busy !== ""}
                            onClick={() => void runRow(result.id, "delete", async () => onDelete(result.id))}
                          >
                            删除
                          </button>
                        </span>
                        {rowNotice[result.id] ? <small className="storage-row-error">{rowNotice[result.id]}</small> : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="editorial-section">
        <span className="rail-kicker">生命周期</span>
        <ol className="timeline">
          <li>
            <strong>出图</strong>
            <span>原图落在服务器，开始 {retentionDays} 天倒计时；开了「自动存本地」「自动推云盘」的会立刻各存一份。</span>
          </li>
          <li>
            <strong>{retentionDays} 天内</strong>
            <span>随时可以在这里存本地、推云盘、下载或删除；删除会连服务器上的文件一起删。</span>
          </li>
          <li>
            <strong>到期</strong>
            <span>服务器每小时巡检一次，把过期文件删掉，记录标「已清理」；已推云盘的还能看到备份路径。</span>
          </li>
        </ol>
      </section>
    </div>
  );
}
