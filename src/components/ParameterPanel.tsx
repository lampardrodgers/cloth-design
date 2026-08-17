import { ratioOptions, resolutionOptions } from "../data/catalog";
import { outputSizeForRatio, outputSizeMismatch } from "../lib/outputSize";
import type { BackgroundMode, ModerationMode, OutputFormat, QualityKey, StudioSettings } from "../types";

interface ParameterPanelProps {
  settings: StudioSettings;
  onChange: (patch: Partial<StudioSettings>) => void;
  /** 专家模式下展开压缩、审核与身份保持等专业项。 */
  showAdvanced: boolean;
  onExpandAdvanced: () => void;
  /** 锁定后整块参数折叠成只读摘要，避免连续出图时被误改。 */
  locked?: boolean;
}

const qualityLabels: Record<QualityKey, string> = {
  auto: "智能选择",
  low: "快速预览",
  medium: "标准成片",
  high: "精细成片",
};

const formatLabels: Record<OutputFormat, string> = {
  png: "PNG · 细节完整",
  jpeg: "JPEG · 文件较小",
  webp: "WebP · 适合网页",
};

const backgroundLabels: Record<BackgroundMode, string> = {
  auto: "自动匹配",
  opaque: "保留实色",
  transparent: "透明背景",
};

const moderationLabels: Record<ModerationMode, string> = {
  auto: "标准审核",
  low: "宽松审核",
};

const resolutionCopy: Record<StudioSettings["resolution"], string> = {
  native: "标准 · 快速预览",
  hd: "高清 · 电商与社媒",
  fourK: "4K · 大图交付",
};

const fidelityLabels: Record<StudioSettings["inputFidelity"], string> = {
  standard: "自然参考",
  high: "严格跟随",
};

/** 锁定态的只读摘要：一眼看完这次会用什么参数出图。 */
export function SettingsSummary({ settings }: { settings: StudioSettings }) {
  const ratio = ratioOptions.find((item) => item.id === settings.ratioId) ?? ratioOptions[0];
  const size = outputSizeForRatio(ratio);
  const rows: Array<[string, string]> = [
    ["比例", ratio.label],
    ["输出像素", size.label],
    ["张数", `${settings.quantity} 张`],
    ["清晰度", resolutionCopy[settings.resolution]],
    ["质量", qualityLabels[settings.quality]],
    ["背景", backgroundLabels[settings.background]],
    ["格式", formatLabels[settings.outputFormat]],
    ["跟随参考", fidelityLabels[settings.inputFidelity]],
  ];
  return (
    <div className="settings-block settings-summary">
      <dl>
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** 生成前就把真实交付尺寸摆出来，别让人花了 4K 的钱才发现拿到 1024。 */
function OutputSizeReadout({ settings }: { settings: StudioSettings }) {
  const ratio = ratioOptions.find((item) => item.id === settings.ratioId) ?? ratioOptions[0];
  const size = outputSizeForRatio(ratio);
  const mismatch = outputSizeMismatch(ratio);
  return (
    <div className={`output-size ${size.auto ? "auto" : ""}`}>
      <span>输出像素</span>
      <strong>{size.label}</strong>
      {mismatch ? <small>{mismatch}</small> : null}
    </div>
  );
}

export function ParameterPanel({
  settings,
  onChange,
  showAdvanced,
  onExpandAdvanced,
  locked = false,
}: ParameterPanelProps) {
  if (locked) return <SettingsSummary settings={settings} />;

  return (
    <div className="parameter-section">
      <div className="settings-block">
        <span className="rail-kicker">画面比例</span>
        <div className="ratio-list" role="radiogroup" aria-label="长宽比">
          {ratioOptions.map((ratio) => {
            const disabled = !ratio.allowedResolutions.includes(settings.resolution);
            const active = settings.ratioId === ratio.id;
            const scale = 18 / Math.max(ratio.width, ratio.height);
            return (
              <button
                type="button"
                role="radio"
                aria-checked={active}
                key={ratio.id}
                className={`ratio-option ${active ? "active" : ""}`}
                disabled={disabled}
                title={disabled ? "当前清晰度不支持这个比例" : ratio.apiSize}
                onClick={() => onChange({ ratioId: ratio.id })}
              >
                <span
                  className="ratio-box"
                  style={{ width: Math.round(ratio.width * scale), height: Math.round(ratio.height * scale) }}
                />
                <small>{ratio.label}</small>
              </button>
            );
          })}
        </div>
      </div>

      <div className="settings-grid two-col">
        <div className="field quantity-field">
          <span>张数</span>
          <div className="number-stepper">
            <button type="button" aria-label="减少" disabled={settings.quantity <= 1} onClick={() => onChange({ quantity: Math.max(1, settings.quantity - 1) })}>
              −
            </button>
            <strong aria-label="数量">{settings.quantity}</strong>
            <button type="button" aria-label="增加" disabled={settings.quantity >= 10} onClick={() => onChange({ quantity: Math.min(10, settings.quantity + 1) })}>
              +
            </button>
          </div>
        </div>

        <label className="field">
          <span>清晰度</span>
          <select
            aria-label="分辨率"
            value={settings.resolution}
            onChange={(event) => onChange({ resolution: event.target.value as StudioSettings["resolution"] })}
          >
            {resolutionOptions.map((option) => (
              <option value={option.id} key={option.id}>{resolutionCopy[option.id]}</option>
            ))}
          </select>
        </label>

        <label className="field">
          <span>质量</span>
          <select value={settings.quality} onChange={(event) => onChange({ quality: event.target.value as QualityKey })}>
            {(Object.keys(qualityLabels) as QualityKey[]).map((quality) => (
              <option key={quality} value={quality}>{qualityLabels[quality]}</option>
            ))}
          </select>
        </label>

        <label className="field">
          <span>背景</span>
          <select value={settings.background} onChange={(event) => onChange({ background: event.target.value as BackgroundMode })}>
            {(Object.keys(backgroundLabels) as BackgroundMode[]).map((background) => (
              <option key={background} value={background}>{backgroundLabels[background]}</option>
            ))}
          </select>
        </label>

        <label className="field">
          <span>格式</span>
          <select value={settings.outputFormat} onChange={(event) => onChange({ outputFormat: event.target.value as OutputFormat })}>
            {(Object.keys(formatLabels) as OutputFormat[]).map((format) => (
              <option key={format} value={format}>{formatLabels[format]}</option>
            ))}
          </select>
        </label>

        <label className="field">
          <span>跟随参考</span>
          <select
            value={settings.inputFidelity}
            onChange={(event) => onChange({ inputFidelity: event.target.value as "standard" | "high" })}
          >
            {(Object.keys(fidelityLabels) as Array<StudioSettings["inputFidelity"]>).map((fidelity) => (
              <option key={fidelity} value={fidelity}>{fidelityLabels[fidelity]}</option>
            ))}
          </select>
        </label>
      </div>

      <OutputSizeReadout settings={settings} />

      {showAdvanced ? (
        <div className="settings-block advanced-settings">
          <span className="rail-kicker">专业设置</span>
          <div className="advanced-settings-body">
            {settings.outputFormat !== "png" ? (
              <label className="field">
                <span>压缩 {settings.compression}%</span>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={settings.compression}
                  onChange={(event) => onChange({ compression: Number(event.target.value) })}
                />
              </label>
            ) : null}

            <label className="field">
              <span>内容审核</span>
              <select value={settings.moderation} onChange={(event) => onChange({ moderation: event.target.value as ModerationMode })}>
                {(Object.keys(moderationLabels) as ModerationMode[]).map((moderation) => (
                  <option key={moderation} value={moderation}>{moderationLabels[moderation]}</option>
                ))}
              </select>
            </label>

            <div className="switch-row">
              <label>
                <input
                  type="checkbox"
                  checked={settings.streamPreview}
                  onChange={(event) => onChange({ streamPreview: event.target.checked })}
                />
                <span>生成时显示预览</span>
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={settings.preserveIdentity}
                  onChange={(event) => onChange({ preserveIdentity: event.target.checked })}
                />
                <span>保持长相与身形</span>
              </label>
            </div>
          </div>
        </div>
      ) : (
        <button type="button" className="ghost-expand" onClick={onExpandAdvanced}>
          展开专业设置
        </button>
      )}
    </div>
  );
}
