import type { GeneratedResult, StoragePolicy, StorageStatus } from "../types";

interface StoragePanelProps {
  policy: StoragePolicy;
  onChange: (policy: StoragePolicy) => void;
  results: GeneratedResult[];
}

const storageStatusLabels: Record<StorageStatus, string> = {
  "local-cache": "本地暂存",
  "cloud-temp": "云端暂存",
  webdav: "已归档云盘",
  expired: "已过期",
};

const lifecycle = [
  { title: "任务完成", detail: "原图进入云端临时区，缩略图保留在服务器。" },
  { title: "自动归档", detail: "开启后推送到用户或平台 WebDAV 目录。" },
  { title: "容量回收", detail: "超过阈值优先清理本地原图、失败任务和过期临时文件。" },
] as const;

export function StoragePanel({ policy, onChange, results }: StoragePanelProps) {
  const webdavCount = results.filter((result) => result.storageStatus === "webdav").length;
  const localCount = results.filter((result) => result.storageStatus === "local-cache").length;

  const policyFields = [
    { label: "本地缓存上限 GB", value: policy.localCacheLimitGb, key: "localCacheLimitGb" as const },
    { label: "本地保留小时", value: policy.localCacheTtlHours, key: "localCacheTtlHours" as const },
    { label: "云端保留天数", value: policy.cloudTempTtlDays, key: "cloudTempTtlDays" as const },
    { label: "失败清理小时", value: policy.purgeFailedAfterHours, key: "purgeFailedAfterHours" as const },
  ];

  return (
    <div className="storage-layout editorial-page">
      <section className="metric-row">
        <div className="metric metric-default"><span>本地上限</span><strong>{policy.localCacheLimitGb}GB</strong></div>
        <div className="metric metric-default"><span>云端保留</span><strong>{policy.cloudTempTtlDays}天</strong></div>
        <div className="metric metric-default"><span>本地暂存</span><strong>{localCount}张</strong></div>
        <div className="metric metric-good"><span>已归档</span><strong>{webdavCount}张</strong></div>
      </section>

      <section className="editorial-split">
        <div className="editorial-section">
          <span className="rail-kicker">容量策略</span>
          <div className="settings-grid two-col">
            {policyFields.map((field) => (
              <label className="field" key={field.key}>
                <span>{field.label}</span>
                <input
                  type="number"
                  min={1}
                  value={field.value}
                  onChange={(event) => onChange({ ...policy, [field.key]: Number(event.target.value) })}
                />
              </label>
            ))}
          </div>
        </div>

        <div className="editorial-section">
          <span className="rail-kicker">WebDAV</span>
          <div className="webdav-box">
            <label className="field">
              <span>远程地址</span>
              <input
                value={policy.webdavEndpoint}
                onChange={(event) => onChange({ ...policy, webdavEndpoint: event.target.value })}
              />
            </label>
          </div>
          <div className="switch-row">
            <label>
              <input
                type="checkbox"
                checked={policy.webdavEnabled}
                onChange={(event) => onChange({ ...policy, webdavEnabled: event.target.checked })}
              />
              <span>启用 WebDAV</span>
            </label>
            <label>
              <input
                type="checkbox"
                checked={policy.autoSyncOriginals}
                onChange={(event) => onChange({ ...policy, autoSyncOriginals: event.target.checked })}
              />
              <span>自动同步原图</span>
            </label>
            <label>
              <input
                type="checkbox"
                checked={policy.keepThumbnailsLocally}
                onChange={(event) => onChange({ ...policy, keepThumbnailsLocally: event.target.checked })}
              />
              <span>缩略图留本地</span>
            </label>
          </div>
        </div>
      </section>

      <section className="editorial-section">
        <div className="editorial-section-head">
          <span className="rail-kicker">成片文件</span>
          <small>{results.length} 个文件</small>
        </div>
        {results.length === 0 ? (
          <p className="muted-text">还没有文件。生成成片后在这里归档、同步或清理。</p>
        ) : (
          <table className="editorial-table">
            <thead>
              <tr>
                <th>文件</th>
                <th>比例</th>
                <th>状态</th>
              </tr>
            </thead>
            <tbody>
              {results.map((result) => (
                <tr key={result.id}>
                  <td>{result.title}</td>
                  <td className="muted tabular">{result.ratioLabel}</td>
                  <td className={result.storageStatus === "webdav" ? "positive" : "muted"}>
                    {storageStatusLabels[result.storageStatus]}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="editorial-section">
        <span className="rail-kicker">生命周期</span>
        <ol className="timeline">
          {lifecycle.map((step) => (
            <li key={step.title}>
              <strong>{step.title}</strong>
              <span>{step.detail}</span>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
