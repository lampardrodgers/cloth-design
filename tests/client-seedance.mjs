/**
 * Seedance 模块（客户端）：入口在「短视频」下排第一，参数按模型能力显示，高级参数默认收起，后台有配置区。
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";

const hub = await fs.readFile("src/components/ShortVideoHub.tsx", "utf8");
const studio = await fs.readFile("src/components/SeedanceStudio.tsx", "utf8");
const admin = await fs.readFile("src/components/AdminPanel.tsx", "utf8");
const adminSeedance = await fs.readFile("src/components/AdminSeedance.tsx", "utf8");
const api = await fs.readFile("src/lib/api.ts", "utf8");
const types = await fs.readFile("src/types.ts", "utf8");
const styles = await fs.readFile("src/styles.css", "utf8");

/* ── 入口：AI 直出排第一、文案成片第二，默认停在 AI 直出 ───────────────────── */
const seedanceIndex = hub.indexOf('id: "seedance"');
const composeIndex = hub.indexOf('id: "compose"');
assert(seedanceIndex > 0 && composeIndex > seedanceIndex, "Seedance 模块放第一个，原来的文案成片放第二个");
assert(hub.includes('"clothdesign:shortvideo:module", "seedance"'), "默认停在 AI 直出，选择记在本地");
assert(!hub.includes("isAdminRole("), "Hub 不自己判 admin，权限由 App 的守卫和服务端决定");

/* ── 参数：按能力矩阵增减；常用直接摆、高级收起 ─────────────────────────── */
assert(studio.includes("fetchSeedanceOverview()"), "组件自己拉总览");
assert(studio.includes("coerceForm("), "表单要按当前模型能力收口，换模型不会带着不合法的值提交");
for (const token of ["model.textAdaptive", "model.imageAdaptiveOnly", "model.duration.smart", "model.frames", "model.audio", "model.seed", "model.cameraFixed", "model.draft", "model.omniTaskType", "model.webSearch", "model.lastFrame", "model.omni"]) {
  assert(studio.includes(token), `界面要看模型能力 ${token}`);
}
assert(studio.includes("showAdvanced") && studio.includes('"clothdesign:seedance:advanced", false'), "高级参数默认收起，展开状态记住");
assert(studio.includes("seedance-advanced-toggle"), "高级参数有个开关");
for (const label of ["随机种子", "固定镜头", "水印", "返回尾帧图", "样片模式", "允许联网搜索", "任务超时", "一次提交几条", "输出格式", "服务等级", "优先级", "任务类型"]) {
  assert(studio.includes(label), `高级参数里要有「${label}」`);
}
for (const label of ["文生视频", "首帧", "尾帧", "多模态参考", "画幅", "分辨率", "时长", "智能时长", "生成有声视频"]) {
  assert(studio.includes(label), `常用参数里要有「${label}」`);
}
assert(studio.includes("@图像1") && studio.includes("@视频1"), "多模态参考的引用写法要提示");
assert(studio.includes("uploadSeedanceRef(") && studio.includes("deleteSeedanceRef("), "素材上传 / 删除");
assert(studio.includes("asset://"), "支持方舟素材库的 asset:// 编号");
assert(studio.includes("publicMediaReady"), "参考视频 / 音频要公网地址，没配要提示");
assert(studio.includes("createSeedanceLastFrameRef(") && studio.includes("用尾帧接着拍"), "尾帧接力");
assert(studio.includes("基于样片出正式版") && studio.includes("draftTaskId"), "样片 → 正式版");
assert(studio.includes("同参数再来一条"), "参数回填");
assert(studio.includes("不支持中途取消"), "生成中不能取消要照实说");
assert(studio.includes('<video controls preload="metadata"'), "成片直接播放");
assert(studio.includes("remoteVideoUrl"), "回传失败时给方舟远端地址兜底");
assert(studio.includes("seedance-progress"), "排队 / 生成中有进度提示");
assert(studio.includes("priceHint"), "模型旁边给价格提示");
assert(studio.includes('className="shortvideo-module seedance-module"'), "沿用短视频的模块壳和样式");
assert(!studio.includes("isAdminRole("), "组件不自己判 admin");

/* ── 素材输入：拖进来 / ⌘V 粘贴 / 从最近上传拖到槽位；中间帧两种落地法 ─────── */
assert(studio.includes("clipboardImageFiles(") && studio.includes('addEventListener("paste"'), "⌘V 粘贴图片直接收进槽位（和作图一样）");
assert(studio.includes("onDrop") && studio.includes("dataTransfer.files") && studio.includes("REF_DRAG_TYPE"), "文件和素材库卡片都能拖到槽位");
assert(studio.includes("draggable") && studio.includes("onDragStart"), "最近上传的卡片可以拖");
assert(studio.includes('type="file" hidden multiple'), "一次能选多张");
assert(studio.includes("middleFrames") && studio.includes("加中间帧") && studio.includes("中间帧怎么落地"), "首尾帧之外能加中间帧，并选落地方式");
assert(studio.includes("keyframeStrategies") && studio.includes('"reference" | "segments"'), "一镜到底 / 分段接力两种方式");
assert(studio.includes("分段接力") && studio.includes("一镜到底"), "两种方式都有说明");
assert(studio.includes("pendingSubmit") && studio.includes("本站排队"), "超出并发的段在本站排队要显示出来");
assert(studio.includes("group.merged") && studio.includes("retrySeedanceGroupMerge("), "接力组的合并成片与重试");
assert(studio.includes("首帧 / 中间帧 / 尾帧只能用图片"), "非图片拖到关键帧要拦");

/* ── 保留期：上传 24 小时、成片 3 天（和生成图一致），可推云盘 ───────────── */
assert(studio.includes("retention?.uploadHours") && studio.includes("retention?.outputDays"), "保留期从服务端下发的数字显示，别写死");
assert(studio.includes("archiveSeedanceTask(") && studio.includes("推到云盘"), "成片能手动推 WebDAV");
assert(studio.includes("storage?.expiredAt") || studio.includes("storage.expiredAt"), "过期的成片要说明已清理");
assert(!studio.includes("长期保存"), "别再说成片长期保存");
assert(types.includes("export interface MediaStorageInfo") && types.includes("export interface SeedanceGroup"), "类型：保留期 / 接力组");
assert(api.includes("/archive") && api.includes("/api/seedance/groups/"), "api.ts 有归档和接力组接口");

/* ── 后台：模型权限自检 ─────────────────────────────────────────────────── */
assert(adminSeedance.includes("modelAccess") && adminSeedance.includes("Key 无权限"), "「测一下」要把每个模型的调用权限列出来");
assert(adminSeedance.includes("全部资源"), "提示 Key 的权限范围要选「全部资源」");

/* ── 后台 ───────────────────────────────────────────────────────────────── */
assert(admin.includes("<AdminSeedance />"), "后台挂 Seedance 配置区");
assert(adminSeedance.includes("fetchSeedanceAdmin()") && adminSeedance.includes("saveSeedanceSettings") && adminSeedance.includes("testSeedanceAdmin"), "后台能读 / 存 / 测");
assert(adminSeedance.includes('type="password"'), "Key 输入框不明文");
assert(adminSeedance.includes("API Key Secret"), "说明填哪一串");
assert(adminSeedance.includes("enabledModels"), "后台能限制开放哪些模型");
assert(adminSeedance.includes("publicBaseUrl"), "后台能配公网地址");

/* ── API / 类型 ─────────────────────────────────────────────────────────── */
for (const route of ["/api/seedance/overview", "/api/seedance/test", "/api/seedance/tasks", "/api/seedance/refs", "/api/admin/seedance", "/api/admin/seedance/settings", "/api/admin/seedance/test"]) {
  assert(api.includes(`"${route}"`) || api.includes(`\`${route}`), `api.ts 要有 ${route}`);
}
assert(types.includes("export interface SeedanceModel") && types.includes("export interface SeedanceRequest") && types.includes("export interface SeedanceTask"), "类型齐全");

/* ── 样式：只用现有 token ────────────────────────────────────────────────── */
const block = styles.slice(styles.indexOf("/* ── Seedance（火山方舟直出）"));
assert(block.length > 500, "Seedance 样式块存在");
const hexColors = block.match(/#[0-9a-fA-F]{6}\b/g) || [];
assert.equal(hexColors.length, 0, `Seedance 样式只用 var(--*) token，别再发明新颜色（现在有 ${hexColors.length} 处硬编码）`);
for (const selector of [".seedance-slot", ".seedance-ref-grid", ".seedance-advanced-toggle", ".seedance-progress", ".admin-seedance-models", ".seedance-slot.drop-active", ".seedance-slot-add", ".seedance-group", ".admin-seedance-access"]) {
  assert(block.includes(selector), `styles.css 要定义 ${selector}`);
}

console.log(JSON.stringify({ checks: "passed" }, null, 2));
