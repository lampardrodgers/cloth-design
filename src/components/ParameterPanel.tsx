import { Check, Layers, SlidersHorizontal } from "lucide-react";
import { ratioOptions, resolutionOptions } from "../data/catalog";
import type { BackgroundMode, ModerationMode, OutputFormat, QualityKey, StudioSettings } from "../types";
import { Section } from "./ui";

interface ParameterPanelProps {
  settings: StudioSettings;
  onChange: (patch: Partial<StudioSettings>) => void;
}

const qualities: QualityKey[] = ["auto", "low", "medium", "high"];
const formats: OutputFormat[] = ["png", "jpeg", "webp"];
const backgrounds: BackgroundMode[] = ["auto", "opaque", "transparent"];
const moderations: ModerationMode[] = ["auto", "low"];

export function ParameterPanel({ settings, onChange }: ParameterPanelProps) {
  const currentRatio = ratioOptions.find((item) => item.id === settings.ratioId) ?? ratioOptions[0];

  return (
    <Section title="参数" action={<SlidersHorizontal size={17} />}>
      <div className="param-stack">
        <label className="field">
          <span>分辨率</span>
          <select value={settings.resolution} onChange={(event) => onChange({ resolution: event.target.value as StudioSettings["resolution"] })}>
            {resolutionOptions.map((option) => (
              <option value={option.id} key={option.id}>
                {option.label} - {option.detail}
              </option>
            ))}
          </select>
          <small>这是交付档位：原生直接调用模型尺寸；高清/4K 会后处理放大，并自动限制可选长宽比。</small>
        </label>

        <div className="field">
          <span>长宽比</span>
          <div className="ratio-list" role="listbox" aria-label="长宽比">
            {ratioOptions.map((ratio) => {
              const disabled = !ratio.allowedResolutions.includes(settings.resolution);
              return (
                <button
                  key={ratio.id}
                  className={`ratio-option ${settings.ratioId === ratio.id ? "active" : ""}`}
                  disabled={disabled}
                  onClick={() => onChange({ ratioId: ratio.id })}
                  title={disabled ? "当前分辨率不可用" : ratio.native ? "API 原生比例" : "后处理比例"}
                >
                  <span className="ratio-box" style={{ aspectRatio: `${ratio.width} / ${ratio.height}` }} />
                  <span>{ratio.label}</span>
                  {settings.ratioId === ratio.id ? <Check size={13} /> : null}
                </button>
              );
            })}
          </div>
        </div>

        <div className="api-note">
          <Layers size={15} />
          <span>前台隐藏模型；后台映射到图像引擎。API size: {currentRatio.apiSize}</span>
        </div>

        <div className="two-col">
          <label className="field">
            <span>质量</span>
            <select value={settings.quality} onChange={(event) => onChange({ quality: event.target.value as QualityKey })}>
              {qualities.map((quality) => (
                <option key={quality} value={quality}>
                  {quality}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>数量</span>
            <input
              type="number"
              min={1}
              max={10}
              value={settings.quantity}
              onChange={(event) => onChange({ quantity: Number(event.target.value) })}
            />
          </label>
        </div>

        <div className="two-col">
          <label className="field">
            <span>格式</span>
            <select value={settings.outputFormat} onChange={(event) => onChange({ outputFormat: event.target.value as OutputFormat })}>
              {formats.map((format) => (
                <option key={format} value={format}>
                  {format}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>背景</span>
            <select value={settings.background} onChange={(event) => onChange({ background: event.target.value as BackgroundMode })}>
              {backgrounds.map((background) => (
                <option key={background} value={background}>
                  {background}
                </option>
              ))}
            </select>
          </label>
        </div>

        {settings.outputFormat !== "png" ? (
          <label className="field">
            <span>压缩</span>
            <input
              type="range"
              min={0}
              max={100}
              value={settings.compression}
              onChange={(event) => onChange({ compression: Number(event.target.value) })}
            />
          </label>
        ) : null}

        <details className="advanced-settings">
          <summary>高级参数</summary>
          <div className="two-col">
            <label className="field">
              <span>安全审核</span>
              <select value={settings.moderation} onChange={(event) => onChange({ moderation: event.target.value as ModerationMode })}>
                {moderations.map((moderation) => (
                  <option key={moderation} value={moderation}>
                    {moderation}
                  </option>
                ))}
              </select>
              <small>auto 使用默认安全策略；low 更少拦截但仍保留基础安全检查。</small>
            </label>
            <label className="field">
              <span>参考图保真</span>
              <select value={settings.inputFidelity} onChange={(event) => onChange({ inputFidelity: event.target.value as "standard" | "high" })}>
                <option value="standard">standard</option>
                <option value="high">high</option>
              </select>
              <small>high 会更严格跟随参考图，适合换衣、主图、融合。</small>
            </label>
          </div>

          <div className="switch-row">
            <label>
              <input type="checkbox" checked={settings.streamPreview} onChange={(event) => onChange({ streamPreview: event.target.checked })} />
              <span>流式预览</span>
            </label>
            <label>
              <input type="checkbox" checked={settings.preserveIdentity} onChange={(event) => onChange({ preserveIdentity: event.target.checked })} />
              <span>锁定人物一致</span>
            </label>
          </div>
          <p className="field-help">锁定人物一致会把脸、发型、身形写入内部提示词，主要服务于模特换衣和多图融合。</p>
        </details>
      </div>
    </Section>
  );
}
