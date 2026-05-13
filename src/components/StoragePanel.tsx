import { Cloud, HardDrive, RefreshCcw, ServerCog } from "lucide-react";
import type { GeneratedResult, StoragePolicy } from "../types";
import { Metric, Section } from "./ui";

interface StoragePanelProps {
  policy: StoragePolicy;
  onChange: (policy: StoragePolicy) => void;
  results: GeneratedResult[];
}

export function StoragePanel({ policy, onChange, results }: StoragePanelProps) {
  const webdavCount = results.filter((result) => result.storageStatus === "webdav").length;
  const localCount = results.filter((result) => result.storageStatus === "local-cache").length;

  return (
    <div className="storage-layout">
      <Section title="容量策略" action={<ServerCog size={17} />}>
        <div className="metric-row">
          <Metric label="本地上限" value={`${policy.localCacheLimitGb}GB`} />
          <Metric label="临时云端" value={`${policy.cloudTempTtlDays}天`} />
          <Metric label="本地缓存" value={`${localCount}张`} />
          <Metric label="WebDAV" value={`${webdavCount}张`} tone="good" />
        </div>
        <div className="settings-grid">
          <label className="field">
            <span>本地缓存上限 GB</span>
            <input
              type="number"
              min={1}
              value={policy.localCacheLimitGb}
              onChange={(event) => onChange({ ...policy, localCacheLimitGb: Number(event.target.value) })}
            />
          </label>
          <label className="field">
            <span>本地保留小时</span>
            <input
              type="number"
              min={1}
              value={policy.localCacheTtlHours}
              onChange={(event) => onChange({ ...policy, localCacheTtlHours: Number(event.target.value) })}
            />
          </label>
          <label className="field">
            <span>云端保留天数</span>
            <input
              type="number"
              min={1}
              value={policy.cloudTempTtlDays}
              onChange={(event) => onChange({ ...policy, cloudTempTtlDays: Number(event.target.value) })}
            />
          </label>
          <label className="field">
            <span>失败任务清理小时</span>
            <input
              type="number"
              min={1}
              value={policy.purgeFailedAfterHours}
              onChange={(event) => onChange({ ...policy, purgeFailedAfterHours: Number(event.target.value) })}
            />
          </label>
        </div>
      </Section>

      <Section title="WebDAV">
        <div className="webdav-box">
          <Cloud size={20} />
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
            <input type="checkbox" checked={policy.webdavEnabled} onChange={(event) => onChange({ ...policy, webdavEnabled: event.target.checked })} />
            <span>启用 WebDAV</span>
          </label>
          <label>
            <input type="checkbox" checked={policy.autoSyncOriginals} onChange={(event) => onChange({ ...policy, autoSyncOriginals: event.target.checked })} />
            <span>自动同步原图</span>
          </label>
          <label>
            <input type="checkbox" checked={policy.keepThumbnailsLocally} onChange={(event) => onChange({ ...policy, keepThumbnailsLocally: event.target.checked })} />
            <span>缩略图留本地</span>
          </label>
        </div>
      </Section>

      <Section title="生命周期">
        <div className="timeline">
          <article>
            <RefreshCcw size={16} />
            <strong>任务完成</strong>
            <span>原图进入云端临时区，缩略图保留在服务器。</span>
          </article>
          <article>
            <Cloud size={16} />
            <strong>自动归档</strong>
            <span>开启后推送到用户或平台 WebDAV 目录。</span>
          </article>
          <article>
            <HardDrive size={16} />
            <strong>容量回收</strong>
            <span>超过阈值优先清理本地原图、失败任务和过期临时文件。</span>
          </article>
        </div>
      </Section>
    </div>
  );
}
