import assert from "node:assert/strict";
import fs from "node:fs/promises";
import ts from "typescript";

let source = await fs.readFile("src/lib/providerMode.ts", "utf8");
source = source.replace(/import type .*?;\n/s, "");
const transpiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
});
const providerMode = await import(`data:text/javascript;base64,${Buffer.from(transpiled.outputText).toString("base64")}`);

/* ── 演示占位图必须能被认出来 ───────────────────────────────────────────────── */

assert(providerMode.isPlaceholderImage("data:image/svg+xml;charset=UTF-8,%3Csvg"), "demo svg must be flagged");
assert(!providerMode.isPlaceholderImage("/generated-images/abc.png"), "managed files are real results");
assert(!providerMode.isPlaceholderImage("data:image/png;base64,iVBORw0K"), "real png data urls are not placeholders");
assert(!providerMode.isPlaceholderImage(undefined), "missing url must not be flagged");

/* ── 「现在会不会真的调用接口」要说清楚 ──────────────────────────────────── */

assert.equal(providerMode.providerNotice(null), null);
assert.equal(
  providerMode.providerNotice({ mode: "live", providerReady: true, imageModelConfigured: true, authEnabled: true, port: 8888 }),
  null,
  "a healthy live provider must not nag the user",
);

const noKey = providerMode.providerNotice({
  mode: "demo",
  providerReady: false,
  imageModelConfigured: true,
  authEnabled: true,
  port: 8888,
});
assert.equal(noKey.tone, "demo");
assert(noKey.title.includes("占位图"), noKey.title);
// 必须给出可以照做的下一步，而不是只说「演示模式」。
assert(noKey.hint.includes("OPENAI_API_KEY"), noKey.hint);
assert(noKey.hint.includes(".env"), noKey.hint);

const forcedDemo = providerMode.providerNotice({
  mode: "demo",
  providerReady: true,
  imageModelConfigured: true,
  authEnabled: true,
  port: 8888,
});
// 有 key 却仍是演示模式，原因不同，给的操作也必须不同。
assert(forcedDemo.detail.includes("OPENAI_DEMO_MODE"), forcedDemo.detail);
assert(forcedDemo.hint.includes("OPENAI_DEMO_MODE"), forcedDemo.hint);

const blocked = providerMode.providerNotice({
  mode: "live",
  providerReady: true,
  imageModelConfigured: true,
  authEnabled: true,
  port: 8888,
  providerHealth: { status: "usage_limited", label: "额度用尽", blocking: true, message: "本月额度已用完", resetAt: "2026-09-01" },
});
assert.equal(blocked.tone, "blocked");
assert(blocked.title.includes("额度用尽"), blocked.title);
assert(blocked.hint.includes("2026-09-01"), blocked.hint);

/* ── 每个生成入口都要有「已提交 / 进行中 / 完成」的可见反馈 ───────────────── */

const app = await fs.readFile("src/App.tsx", "utf8");
const studio = await fs.readFile("src/components/StudioWorkspace.tsx", "utf8");
const gallery = await fs.readFile("src/components/OutputGallery.tsx", "utf8");
const simple = await fs.readFile("src/components/SimpleComposer.tsx", "utf8");
const canvas = await fs.readFile("src/components/CanvasBoard.tsx", "utf8");
const workflows = await fs.readFile("src/components/WorkflowCenter.tsx", "utf8");
const banner = await fs.readFile("src/components/ProviderBanner.tsx", "utf8");
const styles = await fs.readFile("src/styles.css", "utf8");

// 演示模式横幅要出现在每个能点「生成」的地方
for (const [name, file] of [["StudioWorkspace", studio], ["FreeStudio", await fs.readFile("src/components/FreeStudio.tsx", "utf8")], ["WorkflowCenter", workflows]]) {
  assert(file.includes("<ProviderBanner"), `${name} must surface the provider/demo banner`);
}
assert(banner.includes("providerNotice"), "banner must derive its copy from providerNotice");

// 创作台：提交后画布和缩略图轨道都要显示进行中，完成后自动切到新成片
assert(gallery.includes("stage-working"), "studio stage must show a working indicator");
assert(gallery.includes("result-thumb-pending"), "studio filmstrip must show a pending slot");
assert(studio.includes("seenNewestRef"), "studio must jump to the newest result when it lands");

// 简易模式：结果区要先出现占位卡
assert(simple.includes("simple-stage-pending"), "simple mode must show the pending state in the preview stage");
assert(simple.includes("seenNewestRef"), "simple mode must jump to the newest result when it lands");

// 画布：画框和「按标注改图 / 按草图生成」都要在结果位置先显示生成中
assert(canvas.includes('status: "running"'), "canvas must mark frames as running");
assert(canvas.includes("ai-frame-spinner"), "running frames must read as working");
assert(canvas.includes("pendingId"), "selection-driven generation must show an in-place pending frame");
assert(canvas.includes("editor.deleteShape(pendingId)"), "the pending frame must be replaced by the result");
assert(canvas.includes("zoomToBounds"), "the pending frame must be brought into view");

// 功能中心：任务在服务端异步跑，结果栏要一直显示进行中且不能重复提交
assert(workflows.includes("WorkflowRunningNotice"), "workflow center must show a running notice");
assert(workflows.includes('currentJob?.status === "running"'), "workflow run button must stay disabled while running");

// 顶栏：有任务在跑时要一眼看出来
assert(app.includes("task-menu-button ${runningTasks > 0 ? \"running\" : \"\"}"), "topbar must flag running tasks");
// 生成响应不能把 providerHealth 冲掉，否则顶栏状态会退化成猜测值
assert(app.includes("providerHealth: response.providerHealth ?? current?.providerHealth"), "generation must not drop provider health");

for (const selector of [
  ".provider-banner",
  ".placeholder-tag",
  ".simple-stage-pending",
  ".stage-working",
  ".result-thumb-pending",
  ".ai-frame-spinner",
  ".task-menu-button.running",
  ".workflow-running-notice",
]) {
  assert(styles.includes(selector), `styles.css should define ${selector}`);
}

console.log(JSON.stringify({ checks: "passed" }, null, 2));
