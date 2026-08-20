import { useStoredState } from "../lib/storedState";
import { SeedanceStudio } from "./SeedanceStudio";
import { ShortVideoStudio } from "./ShortVideoStudio";

/**
 * 「短视频」入口下的两个子模块，和「开始创作」里的用途选择一个样式：
 * - AI 直出（Seedance）：直接调火山方舟的视频模型出片，文生 / 图生 / 多模态参考。
 * - 文案成片（素材拼接）：MoneyPrinterTurbo 引擎，写文案 → 配音字幕 → 找素材 → 合成。
 * 两个模块共用一把权限开关（account.features.shortVideo），谁能看到在后台按账号控制。
 */

type ShortVideoModule = "seedance" | "compose";

const MODULES: Array<{ id: ShortVideoModule; title: string; outcome: string; description: string }> = [
  { id: "seedance", title: "AI 直出", outcome: "Seedance 生成", description: "提示词 / 首帧图 / 参考素材 → 火山方舟 Seedance 直接出片" },
  { id: "compose", title: "文案成片", outcome: "素材拼接", description: "一句主题 → 文案 → 配音字幕 → 实拍素材合成" },
];

export function ShortVideoHub() {
  const [module, setModule] = useStoredState<ShortVideoModule>("clothdesign:shortvideo:module", "seedance");
  const active = MODULES.some((item) => item.id === module) ? module : "seedance";

  return (
    <main className="single-view panel-scroll shortvideo-view">
      <div className="shortvideo-page">
        <div className="mode-strip shortvideo-mode-strip" role="radiogroup" aria-label="短视频模块">
          <span className="mode-strip-label">方式</span>
          {MODULES.map((item) => {
            const selected = active === item.id;
            return (
              <button
                type="button"
                role="radio"
                aria-checked={selected}
                key={item.id}
                title={item.description}
                className={`mode-pill ${selected ? "active" : ""}`}
                onClick={() => setModule(item.id)}
              >
                <strong>{item.title}</strong>
                <small>{item.outcome}</small>
              </button>
            );
          })}
        </div>
        {active === "seedance" ? <SeedanceStudio /> : <ShortVideoStudio />}
      </div>
    </main>
  );
}
