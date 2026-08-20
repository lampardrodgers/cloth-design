/**
 * 短视频模块（客户端）：入口只给开了权限的账号（默认 admin），视图有守卫，样式沿用整站 token。
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";

const app = await fs.readFile("src/App.tsx", "utf8");
const studio = await fs.readFile("src/components/ShortVideoStudio.tsx", "utf8");
const hub = await fs.readFile("src/components/ShortVideoHub.tsx", "utf8");
const admin = await fs.readFile("src/components/AdminPanel.tsx", "utf8");
const adminShortVideo = await fs.readFile("src/components/AdminShortVideo.tsx", "utf8");
const api = await fs.readFile("src/lib/api.ts", "utf8");
const types = await fs.readFile("src/types.ts", "utf8");
const styles = await fs.readFile("src/styles.css", "utf8");

/* ── 入口与守卫 ─────────────────────────────────────────────────────────── */
assert(types.includes('| "shortvideo"'), "ViewKey 要有 shortvideo");
assert(types.includes("features?: AccountFeatures"), "账号信息里要有按账号下发的功能开关");
assert(app.includes('const canUseShortVideo = currentUser.features?.shortVideo === true;'), "入口开关来自服务端下发，不是前端猜 role");
assert(!app.includes('{ id: "shortvideo", label:'), "短视频不进公共导航表——别的账号连入口都不该渲染");
const railEntry = app.indexOf('aria-label="短视频"');
assert(railEntry > 0, "侧栏要有短视频入口");
const guardBefore = app.lastIndexOf("{canUseShortVideo ? (", railEntry);
assert(guardBefore > 0 && railEntry - guardBefore < 400, "短视频入口必须包在 canUseShortVideo 分支里");
assert(app.includes('if (view === "shortvideo") {') && app.includes("if (!currentUser.features?.shortVideo) return null;"), "视图本身也要守一次：权限收回时不能靠旧 state 继续显示");
assert(app.includes("<ShortVideoHub />"), "视图渲染 ShortVideoHub（里面再分 AI 直出 / 文案成片两个子模块）");
assert(hub.includes("<ShortVideoStudio />") && hub.includes("<SeedanceStudio />"), "Hub 挂两个子模块");
assert(hub.includes('className="mode-strip shortvideo-mode-strip"') && hub.includes("mode-pill"), "子模块切换沿用「开始创作」的 mode-strip 样式");
assert(app.includes('view === "shortvideo"\n      ? { id: "shortvideo" as const'), "顶栏当前位置要有短视频的文案");

/* ── 组件：自取数据、轮询、引擎状态、成片播放 ─────────────────────────────── */
assert(studio.includes("fetchShortVideoOverview()"), "组件自己拉总览");
assert(studio.includes("fetchShortVideoTasks({ page })") && studio.includes("TASK_POLL_MS"), "有任务在跑时轮询（刷当前停留的那一页）");
assert(studio.includes("if (!hasActive) return;"), "没任务在跑就别轮询");
assert(studio.includes("shortvideo-engine-pill") && studio.includes("testShortVideoEngine()"), "引擎状态可见、可重新探测");
assert(studio.includes('<video controls preload="metadata"'), "成片直接在页面里播放");
assert(studio.includes("?download"), "要有下载入口");
assert(studio.includes("useStoredState<ShortVideoRequest>(FORM_STORAGE_KEY"), "表单记在本地，切页面回来还在");
assert(studio.includes('source === "local"') && studio.includes("uploadShortVideoMaterial(file)"), "本地素材要能上传");
assert(studio.includes("generateShortVideoScript(") && studio.includes("generateShortVideoTerms("), "AI 写文案 / 抽关键词");
assert(hub.includes('className="single-view panel-scroll shortvideo-view"'), "沿用 single-view 布局壳（在 Hub 上）");
assert(studio.includes('className="shortvideo-module" data-module="compose"'), "文案成片模块不再自带页面壳");
assert(studio.includes('className="simple-card shortvideo-form"'), "表单卡片沿用 simple-card");
assert(studio.includes("<ChipGroup") && studio.includes("<NumberStepper"), "控件沿用 ui.tsx 的药丸和步进器");
assert(!studio.includes("isAdminRole("), "组件不自己判 admin：谁能用由服务端下发的开关和接口决定");

/* ── 后台开关 ───────────────────────────────────────────────────────────── */
assert(admin.includes("<span>短视频</span>"), "后台用户表要有短视频列");
assert(admin.includes("updateUser(user.id, { shortVideoEnabled: !user.shortVideoEnabled })"), "后台能按账号开关");
assert(app.includes("setUserShortVideoAccess(id, patch.shortVideoEnabled)"), "开关走单独端点");
assert(api.includes('fetch(`/api/admin/users/${encodeURIComponent(userId)}/shortvideo`'), "api.ts 有对应方法");
assert(/grid-template-columns: 1\.6fr 0\.62fr 0\.52fr 0\.5fr 0\.5fr 0\.38fr/.test(styles), "用户表多一列，网格要跟着加");

/* ── 上游有、我们以前漏掉的那批参数 ───────────────────────────────────────── */
// 上游 VideoParams 里这些字段以前要么写死、要么没接，界面上根本调不到。
assert(studio.includes("clipSpeed") && studio.includes("片段倍速"), "片段倍速要能调");
assert(studio.includes("matchScript") && studio.includes("素材跟着文案走"), "素材按文案顺序匹配要有开关");
assert(studio.includes("paragraphs") && studio.includes("写几段"), "文案段落数以前写死 1");
assert(studio.includes("scriptPrompt"), "写文案的额外要求要能填");
assert(studio.includes('position === "custom"') && studio.includes("距顶部"), "字幕要能自定义高度（竖屏躲开平台按钮）");
assert(studio.includes("background") && studio.includes("加底色"), "字幕底色要能开");
assert(studio.includes("uploadShortVideoMusic"), "背景音乐要能自己传");
assert(studio.includes("generateShortVideoMetadata") && studio.includes("发布文案"), "成片要能顺手出标题 / 话题标签");
assert(studio.includes("引擎会强制随机拼接"), "一次出多条时顺序拼接不生效，要照实说");

/* ── 后台配置页 ─────────────────────────────────────────────────────────── */
// 之前配置只在 .env 和引擎的 config.toml 里，界面上找不到，等于没有。
assert(adminShortVideo.includes("fetchShortVideoAdmin()"), "后台配置页自己拉数据");
assert(adminShortVideo.includes("saveShortVideoSettings") && adminShortVideo.includes("saveShortVideoEngineConfig"), "本站设置和引擎配置都要能存");
assert(adminShortVideo.includes("restartShortVideoEngine"), "引擎只在启动时读配置，要能一键重启");
assert(adminShortVideo.includes("testShortVideoLlm"), "文案模型要能当场测一下");
assert(adminShortVideo.includes('type="password"'), "Key 输入框不要明文显示");
assert(admin.includes("<AdminShortVideo />"), "后台页面要挂上短视频配置区");
assert(api.includes('"/api/admin/shortvideo"'), "api.ts 要有后台配置接口");

/* ── API 层 ─────────────────────────────────────────────────────────────── */
for (const route of ["/api/shortvideo/overview", "/api/shortvideo/engine/test", "/api/shortvideo/script", "/api/shortvideo/terms", "/api/shortvideo/tasks", "/api/shortvideo/materials", "/api/shortvideo/musics", "/api/shortvideo/metadata"]) {
  assert(api.includes(`"${route}"`) || api.includes(`\`${route}`), `api.ts 要有 ${route}`);
}
assert(api.includes('credentials: "include"'), "带 cookie");

/* ── 样式：只用现有 token ────────────────────────────────────────────────── */
for (const selector of [".shortvideo-page", ".shortvideo-layout", ".shortvideo-engine-pill", ".shortvideo-task", ".shortvideo-status.completed", ".shortvideo-video video", ".shortvideo-notice.bad"]) {
  assert(styles.includes(selector), `styles.css 要定义 ${selector}`);
}
const block = styles.slice(styles.indexOf("/* ── 短视频（MoneyPrinterTurbo 引擎）"));
assert(block.length > 1000, "短视频样式块存在");
const hexColors = block.match(/#[0-9a-fA-F]{6}\b/g) || [];
assert(hexColors.length <= 3, `短视频样式尽量用 var(--*) token，别再发明新颜色（现在有 ${hexColors.length} 处硬编码）`);
assert(/@media \(max-width: 1080px\)/.test(block), "窄屏要收成一列");

/* ── 保留期：上传的素材 / 音乐 24 小时，成片 3 天，可推云盘 ────────────────── */
assert(studio.includes("retention?.uploadHours") && studio.includes("retention?.outputDays"), "保留期从服务端下发的数字显示");
assert(studio.includes("archiveShortVideoTask(") && studio.includes("推到云盘"), "成片能手动推 WebDAV");
assert(studio.includes("file.expiresAt") || studio.includes("expiresAt"), "上传的素材标出几点清理");

console.log(JSON.stringify({ checks: "passed" }, null, 2));
