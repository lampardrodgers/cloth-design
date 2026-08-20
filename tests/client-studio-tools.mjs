import assert from "node:assert/strict";
import fs from "node:fs/promises";
import ts from "typescript";

async function importTs(path, strip = /import type .*?;\n/gs) {
  let source = await fs.readFile(path, "utf8");
  source = source.replace(strip, "");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  });
  return import(`data:text/javascript;base64,${Buffer.from(transpiled.outputText).toString("base64")}`);
}

/* ── 输出像素回显 ────────────────────────────────────────────────────────── */

const { outputSizeForRatio, outputSizeMismatch } = await importTs("src/lib/outputSize.ts");
const { ratioOptions } = await importTs("src/data/catalog.ts");

const square = ratioOptions.find((ratio) => ratio.id === "1-1");
assert.equal(outputSizeForRatio(square).label, "1024 × 1024 px");
assert.equal(outputSizeForRatio(square).auto, false);

const auto = ratioOptions.find((ratio) => ratio.id === "auto");
assert.equal(outputSizeForRatio(auto).auto, true, "auto 尺寸算不出来，不能编一个数字出来");
assert.equal(outputSizeForRatio(undefined).auto, true);

const portrait = ratioOptions.find((ratio) => ratio.id === "2-3");
assert.equal(outputSizeForRatio(portrait).label, "1024 × 1536 px");
assert.equal(outputSizeMismatch(portrait), "", "2:3 和 1024x1536 是一致的，不该报不一致");

// 9:16 实际按 1024x1536（2:3）交付——这个落差必须说出来，不能让用户以为拿到的是 9:16。
const tall = ratioOptions.find((ratio) => ratio.id === "9-16");
assert.equal(ratioOptions.length, 16, "自由生成要有 auto + 15 种文档比例");
assert(ratioOptions.some((ratio) => ratio.label === "21:9"));
assert.equal(outputSizeForRatio(tall, "fourK", "apimart").label, "2160 × 3840 px");
// OpenAI 兼容线路（Packy）没有 resolution 这个参数：填 4K 也还是那一档，
// 不能拿 APIMart 的尺寸表去报一个它出不来的像素。
assert.equal(outputSizeForRatio(tall, "fourK").label, "1024 × 1536 px");
assert.equal(outputSizeForRatio(tall, "fourK", "openai").label, "1024 × 1536 px");
assert(outputSizeMismatch(tall).includes("1024×1536"), outputSizeMismatch(tall));

/* ── 提示词原子 chip ─────────────────────────────────────────────────────── */

const lib = await importTs("src/lib/promptLibrary.ts");

assert.equal(lib.chipPrefixes.gallery, "@");
assert.equal(lib.chipPrefixes.color, "#");
assert.equal(lib.chipPrefixes.snippet, "~");

// 触发符必须在词首，否则正常打字会被误判
assert.equal(lib.findChipTrigger("一件大衣，#", 6)?.kind, "color");
assert.equal(lib.findChipTrigger("~", 1)?.kind, "snippet");
assert.equal(lib.findChipTrigger("mail@example", 12), null, "词中间的 @ 不能触发");
assert.equal(lib.findChipTrigger("# 米白", 4), null, "触发符和光标之间有空格就不再是触发态");
assert.equal(lib.findChipTrigger("#这是一段特别长的过滤词内容", 14), null, "过滤词太长说明只是在正常打字");

const trigger = lib.findChipTrigger("一件大衣，#米", 7);
assert.equal(trigger.query, "米");
assert.equal(trigger.start, 5);

// 色卡必须带上十六进制，只写「米白」每次出来的颜色都不一样
const offwhite = lib.defaultPromptLibrary.colors[0];
assert.equal(lib.colorChipText(offwhite), "米白(#F3EFE7)");
assert.equal(lib.chipInsertText("color", offwhite), "米白(#F3EFE7)");
assert.equal(lib.chipInsertText("gallery", { id: "a", name: "参考A", insert: "参考A" }), "参考A");
assert.equal(lib.chipInsertText("snippet", { id: "s", name: "干净棚拍", text: "纯色背景" }), "纯色背景");

// 插入要替换掉触发段，并在两头补分隔符
const inserted = lib.applyChipInsert("一件大衣，#", { start: 5, end: 6 }, "米白(#F3EFE7)");
assert.equal(inserted.value, "一件大衣，米白(#F3EFE7)");
assert.equal(inserted.caret, inserted.value.length);

const midSentence = lib.applyChipInsert("一件大衣#一张主图", { start: 4, end: 5 }, "米白(#F3EFE7)");
assert.equal(midSentence.value, "一件大衣，米白(#F3EFE7)，一张主图", "插在句子中间时后半句也要断开");

assert.equal(lib.appendChipText("", "干净棚拍").value, "干净棚拍", "空描述前面不该多一个逗号");
assert.equal(lib.filterChips(lib.defaultPromptLibrary.colors, "米").length, 1);
assert.equal(lib.filterChips(lib.defaultPromptLibrary.colors, "").length, lib.defaultPromptLibrary.colors.length);

/* ── 成片时间戳 ──────────────────────────────────────────────────────────── */

const { formatResultTime } = await importTs("src/lib/resultFiles.ts");
assert.equal(formatResultTime("14:32"), "14:32", "本次会话生成的已经是短时间，原样显示");
assert(!formatResultTime("2026-08-14T16:17:47.652Z").includes("T"), "服务端回来的 ISO 串不能直接摆出来");
assert.equal(formatResultTime(""), "");

/* ── 各界面接线 ──────────────────────────────────────────────────────────── */

const studio = await fs.readFile("src/components/StudioWorkspace.tsx", "utf8");
const gallery = await fs.readFile("src/components/OutputGallery.tsx", "utf8");
const parameters = await fs.readFile("src/components/ParameterPanel.tsx", "utf8");
const simple = await fs.readFile("src/components/SimpleComposer.tsx", "utf8");
const composer = await fs.readFile("src/components/PromptComposer.tsx", "utf8");
const chips = await fs.readFile("src/components/PromptChips.tsx", "utf8");
const app = await fs.readFile("src/App.tsx", "utf8");
const api = await fs.readFile("src/lib/api.ts", "utf8");
const server = await fs.readFile("server/index.mjs", "utf8");
const serverApi = await fs.readFile("server/api.mjs", "utf8");
const styles = await fs.readFile("src/styles.css", "utf8");

// 1. 成片直接加入参考图
assert(gallery.includes("加入参考"), "成片工具条要有「加入参考」");
assert(gallery.includes("onUseAsReference(selected)"), "工具条按钮要作用在当前这张成片上");
assert(simple.includes("加入参考"), "自由创作的成片也要能直接加入参考");
// 优先填空槽位，否则「换衣」这类必填模式会一直卡在「还需上传」
assert(studio.includes("references.find((reference) => !reference.previewUrl)"), "加入参考要先填空着的槽位");

// 2. 输出像素回显
assert(parameters.includes("OutputSizeReadout"), "成片设置里要有输出像素回显");
// 输出像素现在写在比例选择器上（按钮副标题 + 每一项），不再单独占一条高亮带。
const ratioPicker = await fs.readFile("src/components/RatioPicker.tsx", "utf8");
assert(ratioPicker.includes("outputSizeForRatio"), "自由创作也要显示输出像素");
assert(simple.includes("protocol={capability.protocol}"), "输出像素要按当前线路算");
// 比例改成自画的选择器：原生 select 的系统菜单只有一列数字，看不出横竖。
assert(simple.includes("<RatioPicker"), "自由生成比例要用带示意图的选择器");
assert(simple.includes("freeResolutionOptions") && simple.includes("onResolutionChange"), "自由生成要能选 1K / 2K / 4K");

// 3. 参数锁定 + 只读摘要
assert(studio.includes('useStoredState("clothdesign:settingsLocked", false)'), "锁定状态要留在本地");
assert(studio.includes("settings-lock"), "成片设置头部要有锁定按钮");
assert(parameters.includes("if (locked) return <SettingsSummary"), "锁定后整块参数折叠成只读摘要");
assert(studio.includes("disabled={settingsLocked}"), "锁定时交付预设不能绕过锁改参数");

// 4. 提示词原子 chip
assert(chips.includes("usePromptChips") && chips.includes("PromptChipBar"), "chip 能力要能被两个创作界面共用");
assert(composer.includes("usePromptChips") && composer.includes("<PromptChipBar"), "创作台要接上 chip");
assert(simple.includes("usePromptChips") && simple.includes("<PromptChipBar"), "自由创作要接上 chip");
// 选择器开着时回车必须先给选择器，否则会越过选项直接触发生成
assert(composer.includes("if (chips.handleKeyDown(event)) return;"), "创作台回车要先让给 chip 选择器");
assert(simple.includes("if (chips.handleKeyDown(event)) return;"), "自由创作回车要先让给 chip 选择器");
assert(chips.includes("chip-picker-new"), "色卡和片段要能自己新增");

// 5. 成片提示词回看 / 一键重做
assert(gallery.includes("stage-prompt"), "要能看到这张图当时的描述");
assert(gallery.includes("用这段重做"), "看完描述要能一键复用");
assert(api.includes("userPrompt"), "请求里要单独带上用户原话");
assert(app.includes("userPrompt: taskPrompt"), "创作台要把用户原话一起送上去");
assert(app.includes("userPrompt: taskLabel"), "自由创作要把用户原话一起送上去");
assert(app.includes("prompt: taskPrompt"), "新成片要记住生成它的描述");
assert(server.includes("payload.userPrompt || payload.prompt"), "服务端要落库用户原话");
assert(serverApi.includes("prompt: metadata.prompt"), "历史成片取回时要带上描述");

// 6. 自由创作：左参数 / 右大图 / 历史在下
assert(simple.includes('<div className="simple-top">'), "简易模式要分成左右两栏");
assert(simple.includes('className="simple-stage"'), "当前成片要有独立的右侧展示区");
assert(/simple-top[\s\S]{0,200}grid-template-columns:\s*minmax\(0, 420px\) minmax\(0, 1fr\)/.test(styles), "右侧大图要占据剩余宽度");
assert(simple.indexOf('className="simple-top"') < simple.indexOf('className="simple-results"'), "历史成片排在下方");
assert(simple.includes("onClick={() => handleSelectResult(result.id)}") && simple.includes("setSelectedId(id)"), "点历史成片要切换右侧大图");

// 7. 工作区里那条标题栏只是把顶栏的话重说一遍，去掉；简易/画布切换搬到顶栏
const freeStudio = await fs.readFile("src/components/FreeStudio.tsx", "utf8");
assert(!freeStudio.includes("free-head"), "自由创作不该再占一条标题栏");
assert(!styles.includes(".free-head"), "标题栏的样式也要一并清掉");
assert(freeStudio.includes("layout: FreeLayout;"), "简易/画布状态由顶栏托管");
assert(app.includes('view === "free" ? (') && app.includes('aria-label="创作方式"'), "顶栏要渲染简易/画布切换");
assert(app.includes('useStoredState<FreeLayout>("clothdesign:free:layout"'), "切换状态仍要留在本地");

// 顶部区块必须是确定高度，否则右边的图会按自己的原始宽度把整行撑开
assert(/\.simple-top\s*\{[^}]*height:\s*clamp\(/.test(styles), "顶部区块要定高，撑成一屏");
assert(/\.simple-top \.simple-card\s*\{[^}]*overflow:\s*auto/.test(styles), "左栏内容超出时自己滚，不要把整行顶高");
// 这一条最容易回退：不压缩行/列的话 img 的 max-height: 100% 会失效，图会溢出到页脚下面被裁掉
assert(
  /\.simple-stage-plate\s*\{[^}]*grid-template-rows:\s*minmax\(0, 1fr\)/.test(styles),
  "成片格子要压缩行高，否则图片会溢出被裁",
);
assert(/\.simple-stage-plate img\s*\{[^}]*max-height:\s*100%/.test(styles), "成片按容器封顶，不要再用固定 vh");

// 8. 一键清空：创作台 / 简易模式 / 画布各有一个，只清当前输入，不动成片和设置
assert(app.includes("const handleClearStudio"), "创作台要有一键清空");
assert(app.includes("normalizeModeReferences([], mode.requiredRefs)"), "清空后必填参考图槽位要留着，只是变空");
assert(composer.includes('className="text-button prompt-clear"'), "创作台描述框旁要有清空按钮");
assert(simple.includes("onClear") && simple.includes("清空"), "简易模式要有清空按钮");
const freeStudioSource = await fs.readFile("src/components/FreeStudio.tsx", "utf8");
assert(freeStudioSource.includes("setAttachments([]);"), "简易模式清空要连附件一起清");
const canvasSource = await fs.readFile("src/components/CanvasBoard.tsx", "utf8");
assert(canvasSource.includes("editor.deleteShapes(ids)") && canvasSource.includes("可撤销"), "画布清空走 tldraw 历史，可以撤销");

// 9. 导航：自由创作排第一，登录后直接落在这里
assert(app.indexOf('id: "free"') < app.indexOf('id: "studio"'), "自由创作要排在导航第一位");
assert(app.includes('useState<ViewKey>("free")'), "默认视图跟着导航第一项走");

// 10. 多人使用：账户页能填自备 Key，后台能开通账号、看用量
const account = await fs.readFile("src/components/AccountPanel.tsx", "utf8");
assert(account.includes("onSaveApiKey") && account.includes('type="password"'), "账户页要有 Key 填写框，且不明文显示");
assert(account.includes("apiKeyHint"), "账户页只显示脱敏提示");
const admin = await fs.readFile("src/components/AdminPanel.tsx", "utf8");
assert(admin.includes("approved: !approved") && admin.includes("开通"), "后台要能开通 / 收回账号");
assert(admin.includes("usage?.taskCount") && admin.includes("ownKeyTaskCount"), "后台要能看到每个账号的用量");
assert(admin.includes("共享 API Key") && admin.includes('type="password"'), "后台每条供应商线路都要能安全填写共享 Key");
assert(admin.includes("clearProviderApiKey") && admin.includes("清除后台 Key"), "后台设置的共享 Key 要能单独清除并回退 .env");
const authPanel = await fs.readFile("src/components/AuthPanel.tsx", "utf8");
assert(authPanel.includes("需要管理员在后台开通"), "注册页要说明需要开通");

for (const selector of [
  ".output-size",
  ".settings-summary",
  ".settings-lock",
  ".chip-bar",
  ".chip-picker",
  ".chip-swatch",
  ".stage-prompt",
  ".simple-top",
  ".simple-stage",
  ".simple-stage-actions",
]) {
  assert(styles.includes(selector), `styles.css should define ${selector}`);
}

console.log(JSON.stringify({ checks: "passed" }, null, 2));
