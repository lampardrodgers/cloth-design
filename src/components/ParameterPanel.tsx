import { Check, Settings2, SlidersHorizontal } from "lucide-react";
import { ratioOptions, resolutionOptions } from "../data/catalog";
import type { BackgroundMode, ModerationMode, OutputFormat, QualityKey, StudioSettings } from "../types";
import { NumberStepper } from "./ui";

interface ParameterPanelProps {
  settings: StudioSettings;
  onChange: (patch: Partial<StudioSettings>) => void;
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
  opaque: "保留实色背景",
  transparent: "透明背景",
};

const moderationLabels: Record<ModerationMode, string> = {
  auto: "标准审核",
  low: "宽松审核",
};

const resolutionLabels: Record<StudioSettings["resolution"], string> = {
  native: "标准",
  hd: "高清",
  fourK: "4K",
};

const resolutionDescriptions: Record<StudioSettings["resolution"], string> = {
  native: "适合快速预览和日常使用",
  hd: "适合电商详情页与社媒发布",
  fourK: "适合海报和大尺寸交付",
};

export function ParameterPanel({ settings, onChange }: ParameterPanelProps) {
  const currentRatio = ratioOptions.find((item) => item.id === settings.ratioId) ?? ratioOptions[0];

  return (
    <section className="section flow-section parameter-section" aria-labelledby="parameter-heading">
      <header className="flow-section-head">
        <span className="flow-step-index" aria-hidden="true">4</span>
        <div className="flow-section-copy">
          <span className="flow-kicker">成片设置</span>
          <h2 id="parameter-heading" aria-label="参数">确认尺寸与数量</h2>
          <p>已经为你选好常用配置；只有交付要求不同的时候才需要调整。</p>
        </div>
        <span className="parameter-summary">
          {resolutionLabels[settings.resolution]} · {currentRatio.label} · {settings.quantity} 张
        </span>
      </header>

      <div className="parameter-grid">
        <label className="field setting-card">
          <span>清晰度</span>
          <select
            aria-label="分辨率"
            value={settings.resolution}
            onChange={(event) => onChange({ resolution: event.target.value as StudioSettings["resolution"] })}
          >
            {resolutionOptions.map((option) => (
              <option value={option.id} key={option.id}>
                {option.id === "native"
                  ? "标准 · 快速预览"
                  : option.id === "hd"
                    ? "高清 · 电商与社媒"
                    : "4K · 大图交付"}
              </option>
            ))}
          </select>
          <small>{resolutionDescriptions[settings.resolution]}</small>
        </label>

        <div className="field setting-card quantity-field">
          <span>生成张数</span>
          <NumberStepper
            ariaLabel="数量"
            min={1}
            max={10}
            value={settings.quantity}
            onChange={(quantity) => onChange({ quantity })}
          />
          <small>一次最多生成 10 张</small>
        </div>

        <div className="field setting-card ratio-field">
          <span>画面比例</span>
          <div className="ratio-list" role="radiogroup" aria-label="长宽比">
            {ratioOptions.map((ratio) => {
              const disabled = !ratio.allowedResolutions.includes(settings.resolution);
              return (
                <button
                  type="button"
                  role="radio"
                  aria-checked={settings.ratioId === ratio.id}
                  key={ratio.id}
                  className={`ratio-option ${settings.ratioId === ratio.id ? "active" : ""}`}
                  disabled={disabled}
                  onClick={() => onChange({ ratioId: ratio.id })}
                  title={disabled ? "当前清晰度不支持这个比例" : undefined}
                >
                  <span className="ratio-box" style={{ aspectRatio: `${ratio.width} / ${ratio.height}` }} />
                  <span>{ratio.label}</span>
                  {settings.ratioId === ratio.id ? <Check size={13} aria-hidden="true" /> : null}
                </button>
              );
            })}
          </div>
        </div>

        <label className="field setting-card">
          <span>成片质量</span>
          <select value={settings.quality} onChange={(event) => onChange({ quality: event.target.value as QualityKey })}>
            {(Object.keys(qualityLabels) as QualityKey[]).map((quality) => (
              <option key={quality} value={quality}>{qualityLabels[quality]}</option>
            ))}
          </select>
          <small>质量越高，细节越丰富</small>
        </label>

        <label className="field setting-card">
          <span>背景处理</span>
          <select
            value={settings.background}
            onChange={(event) => onChange({ background: event.target.value as BackgroundMode })}
          >
            {(Object.keys(backgroundLabels) as BackgroundMode[]).map((background) => (
              <option key={background} value={background}>{backgroundLabels[background]}</option>
            ))}
          </select>
          <small>商品主图可选择透明背景</small>
        </label>

        <label className="field setting-card">
          <span>文件格式</span>
          <select
            value={settings.outputFormat}
            onChange={(event) => onChange({ outputFormat: event.target.value as OutputFormat })}
          >
            {(Object.keys(formatLabels) as OutputFormat[]).map((format) => (
              <option key={format} value={format}>{formatLabels[format]}</option>
            ))}
          </select>
          <small>不确定时保留 PNG 即可</small>
        </label>
      </div>

      <details className="advanced-settings">
        <summary><Settings2 size={15} aria-hidden="true" /> 更多专业设置</summary>
        <div className="advanced-settings-body">
          {settings.outputFormat !== "png" ? (
            <label className="field">
              <span>文件压缩程度：{settings.compression}%</span>
              <input
                type="range"
                min={0}
                max={100}
                value={settings.compression}
                onChange={(event) => onChange({ compression: Number(event.target.value) })}
              />
            </label>
          ) : null}

          <div className="two-col">
            <label className="field">
              <span>内容审核</span>
              <select
                value={settings.moderation}
                onChange={(event) => onChange({ moderation: event.target.value as ModerationMode })}
              >
                {(Object.keys(moderationLabels) as ModerationMode[]).map((moderation) => (
                  <option key={moderation} value={moderation}>{moderationLabels[moderation]}</option>
                ))}
              </select>
              <small>建议保持标准审核。</small>
            </label>
            <label className="field">
              <span>跟随参考图的程度</span>
              <select
                value={settings.inputFidelity}
                onChange={(event) => onChange({ inputFidelity: event.target.value as "standard" | "high" })}
              >
                <option value="standard">自然参考</option>
                <option value="high">严格跟随</option>
              </select>
              <small>换衣、主图和融合任务可选择严格跟随。</small>
            </label>
          </div>

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
              <span>保持人物长相与身形</span>
            </label>
          </div>

          <div className="api-note">
            <SlidersHorizontal size={15} aria-hidden="true" />
            <span>系统会根据这些选择自动匹配合适的图像引擎与输出尺寸。</span>
          </div>
        </div>
      </details>
    </section>
  );
}
