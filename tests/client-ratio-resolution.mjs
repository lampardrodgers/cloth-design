/**
 * 比例选择器 + 分辨率上限的前端行为。
 *
 * 比例原来是原生 <select>：系统菜单只有一列「3:2 / 2:3 / 3:4」，横竖分不清，
 * 聚焦时的描边也和整站对不上。分辨率则是三档写死的 1K/2K/4K，
 * 线路根本出不来的档位照样能点，点了还多扣积分。
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import ts from "typescript";

async function importTs(file) {
  const source = await fs.readFile(file, "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  });
  return import(`data:text/javascript;base64,${Buffer.from(transpiled.outputText).toString("base64")}`);
}

const resolution = await importTs("src/lib/resolution.ts");
const outputSize = await importTs("src/lib/outputSize.ts");

/* ── 档位比较与裁剪 ──────────────────────────────────────────────────────── */
assert.deepEqual(resolution.resolutionOrder, ["native", "hd", "fourK"]);
assert.equal(resolution.clampResolution("fourK", "native"), "native", "线路只出 1K 时 4K 要落回 1K");
assert.equal(resolution.clampResolution("native", "fourK"), "native", "上限高不代表要把用户选的顶上去");
assert.equal(resolution.clampResolution("hd", "hd"), "hd");
assert.equal(resolution.clampResolution(undefined, "fourK"), "native", "读不到就按最低那档，别先亮 4K 再收回");
assert.equal(resolution.isResolutionAllowed("hd", "native"), false);
assert.equal(resolution.isResolutionAllowed("native", "native"), true);

/* ── 为什么点不了，要说清是线路的事还是后台压的 ──────────────────────────── */
const packy = { providerName: "Packy / OpenAI 兼容接口", protocol: "openai", maxResolution: "native", maxResolutionSource: "provider" };
const capped = { providerName: "APIMart", protocol: "apimart", maxResolution: "hd", maxResolutionSource: "account" };
const apimart = { providerName: "APIMart", protocol: "apimart", maxResolution: "fourK", maxResolutionSource: "provider" };
assert(resolution.resolutionLimitNote(packy).includes("Packy"), resolution.resolutionLimitNote(packy));
assert(resolution.resolutionLimitNote(packy).includes("1K"));
assert(resolution.resolutionLimitNote(capped).includes("管理员"), "后台压的上限要说是管理员设的，别让人以为是接口坏了");
assert.equal(resolution.resolutionLimitNote(apimart), "", "开到顶就不用解释");
assert(resolution.resolutionOptionTitle("fourK", packy).includes("不可用"));
assert(resolution.resolutionOptionTitle("native", packy).includes("1K"));

/* ── 账号信息还没回来时按最保守的来 ──────────────────────────────────────── */
assert.equal(resolution.capabilityFromAccount(null).maxResolution, "native");
assert.equal(
  resolution.capabilityFromAccount({ apiProviderName: "APIMart", apiProviderProtocol: "apimart", maxResolution: "fourK" }).protocol,
  "apimart",
);

/* ── 输出像素分两条线算 ──────────────────────────────────────────────────── */
const ratio34 = { id: "3-4", label: "3:4", apiSize: "1024x1536", width: 3, height: 4, allowedResolutions: [], native: true };
assert.equal(outputSize.outputSizeForRatio(ratio34, "native", "apimart").label, "768 × 1024 px");
assert.equal(outputSize.outputSizeForRatio(ratio34, "native", "openai").label, "1024 × 1536 px", "OpenAI 兼容线路按 apiSize 交付");
assert.equal(outputSize.outputSizeForRatio(ratio34, "fourK", "openai").label, "1024 × 1536 px", "这条线路没有 4K 这回事");
assert.equal(outputSize.outputSizeForRatio(ratio34, "fourK", "apimart").label, "2480 × 3312 px");

/* ── 界面接线 ────────────────────────────────────────────────────────────── */
const picker = await fs.readFile("src/components/RatioPicker.tsx", "utf8");
const styles = await fs.readFile("src/styles.css", "utf8");
assert(picker.includes("RatioGlyph"), "每一项都要有按真实比例画的示意图");
assert(picker.includes('role="listbox"') && picker.includes('role="option"'), "自画的下拉要有可读的语义");
assert(picker.includes('"Escape"'), "Esc 要能关掉");
assert(picker.includes('event.key === "ArrowDown"'), "键盘上下要能选");
assert(picker.includes("outputSizeForRatio(option, resolution, protocol)"), "每个比例要写清这一档实际交付多少像素");
assert(picker.includes("outputSizeMismatch"), "选 16:9 实际按 3:2 出图这种落差要在选之前说");

const simple = await fs.readFile("src/components/SimpleComposer.tsx", "utf8");
assert(simple.includes("<RatioPicker"), "简易模式的比例要用新的选择器");
assert(!simple.includes('className="simple-select"'), "原生 select 的样式不该再留着");
assert(simple.includes("isResolutionAllowed(option.id, capability.maxResolution)"), "超出上限的档位不能点");
assert(simple.includes("disabled={!allowed}"), "超限档位要留在原地但禁用，藏起来会让人以为功能没了");
assert(!simple.includes("resolutionLimitNote"), "分辨率说明不再在参数区单独占一行");
assert(simple.includes("protocol={capability.protocol}"), "输出像素要按当前线路算");
// 自由创作不预设题材：示例不能是衣服，否则一打开就像只能画服装。
const placeholder = simple.match(/placeholder="([^"]+)"/)?.[1] ?? "";
assert(placeholder, "描述框要有示例");
for (const word of ["大衣", "衣架", "服装", "模特"]) {
  assert(!placeholder.includes(word), `自由创作的示例不该预设成服装：${placeholder}`);
}

/* ── 下拉不能被那张定高滚动卡裁掉 ────────────────────────────────────────── */
assert(picker.includes("createPortal"), "菜单要挂到 body 上，留在卡里会被裁掉半截");
assert(picker.includes("position: fixed") || styles.includes("position: fixed"), "菜单用 fixed 定位");
assert(picker.includes("roomBelow") && picker.includes("roomAbove"), "按上下剩余空间决定往哪边弹");
assert(picker.includes('direction: "up"'), "下面塞不下就往上弹");
assert(picker.includes('window.addEventListener("scroll", update, true)'), "卡片内部滚动时菜单要跟着走");
assert(!styles.includes(".ratio-picker-menu {\n  position: absolute;"), "菜单不能再用绝对定位挂在卡里");

const parameters = await fs.readFile("src/components/ParameterPanel.tsx", "utf8");
assert(parameters.includes("isResolutionAllowed(option.id, capability.maxResolution)"), "创作台的清晰度也要受同一个上限约束");

const free = await fs.readFile("src/components/FreeStudio.tsx", "utf8");
assert(free.includes("clampResolution(current, capability.maxResolution)"), "换线路后本地存的 4K 要落回能出的档位");

const studio = await fs.readFile("src/components/StudioWorkspace.tsx", "utf8");
assert(studio.includes("clampResolution(settings.resolution, capability.maxResolution)"), "创作台的旧设置也要跟着落");

const admin = await fs.readFile("src/components/AdminPanel.tsx", "utf8");
assert(admin.includes("maxResolutionSetting"), "后台要能按账号设上限");
assert(admin.includes("跟随线路"), "留空就是跟随线路能力");
assert(admin.includes("providerCapOf"), "后台里超出线路能力的档位不给选");

assert(styles.includes(".ratio-glyph-box"), "示意图要有样式");
assert(styles.includes(".ratio-picker-menu"), "自画的下拉要有样式");
assert(styles.includes(".chip:disabled"), "禁用的分辨率档位要看得出来是禁用");

console.log(JSON.stringify({ ratioAndResolution: "passed" }, null, 2));
