import assert from "node:assert/strict";
import fs from "node:fs/promises";

/**
 * 后台分区导航：以前十几个版块摞成一条长页面，要改个套餐得滚过一屏用户表。
 * 现在左边一列导航，一次只渲染一个分区，分区写进地址栏 hash。
 */

const admin = await fs.readFile("src/components/AdminPanel.tsx", "utf8");
const styles = await fs.readFile("src/styles.css", "utf8");

/* ── 六个分区都在，且各自真的渲染了内容 ───────────────────────────────────── */

const tabs = ["overview", "users", "images", "video", "billing", "storage"];
for (const key of tabs) {
  assert(admin.includes(`{ key: "${key}",`), `adminTabs 要有 ${key} 这一项`);
  assert(admin.includes(`{tab === "${key}" ? (`), `${key} 分区要有对应的渲染分支`);
}
assert(admin.includes("{adminTabs.map("), "导航按钮从 adminTabs 生成，别手写六遍");
assert(admin.includes('aria-current={key === tab ? "page" : undefined}'), "当前分区要对读屏可见");
assert(admin.includes('className={key === tab ? "admin-nav-item active" : "admin-nav-item"}'), "当前分区要有选中态");

/* ── 分区跟地址栏 hash 绑定：刷新、前进后退、收藏都能回到原处 ───────────── */

assert(admin.includes("function tabFromHash()"), "分区要能从 hash 解析出来");
assert(admin.includes('window.addEventListener("hashchange", sync)'), "前进/后退改了 hash，界面要跟着换分区");
assert(admin.includes('window.removeEventListener("hashchange", sync)'), "卸载时要摘掉 hashchange 监听");
assert(admin.includes("window.history.replaceState(null, \"\", `#${next}`)"), "点导航要把分区写回地址栏");
assert(admin.includes('rootRef.current?.closest(".panel-scroll")?.scrollTo({ top: 0 })'), "换分区要回到顶部");

/* ── 版块一个都不能在重排里丢掉 ───────────────────────────────────────────── */

for (const title of [
  "运行概览",
  "商业化底座",
  "用户与用量",
  "图像接口",
  "模型路由（仅本机备忘）",
  "系统提示词模板",
  "积分规则",
  "充值套餐",
  "支付配置",
  "支付订单",
  "支付事件",
  "积分流水",
  "存储策略",
  "生成审计",
]) {
  assert(admin.includes(`<Section title="${title}"`), `「${title}」版块不能在分区重排里丢掉`);
}
assert(admin.includes("<AdminSeedance />") && admin.includes("<AdminShortVideo />"), "两个视频模块要挂在「视频模块」分区里");

// 每个版块只能属于一个分区：同一个标题出现两次说明重排时复制岔了。
for (const title of ["用户与用量", "存储策略", "商业化底座", "积分流水"]) {
  assert.equal(admin.split(`<Section title="${title}"`).length - 1, 1, `「${title}」只应该出现一次`);
}

// 待开通账号数直接标在导航上，不用点进去才发现有人在等。
assert(admin.includes('<em className="admin-nav-badge">{pendingUsers}</em>'), "待开通数量要标在「用户」分区上");

/* ── 样式 ─────────────────────────────────────────────────────────────────── */

for (const selector of [".admin-console", ".admin-nav", ".admin-nav-item", ".admin-nav-item.active", ".admin-nav-badge"]) {
  assert(styles.includes(selector), `styles.css should define ${selector}`);
}
assert(/\.admin-nav\s*\{[^}]*position:\s*sticky/.test(styles), "导航要粘在顶上，滚到底也能换分区");
assert(
  /@media \(max-width: 1180px\)[\s\S]*?\.admin-console\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/.test(styles),
  "窄屏要把侧栏导航改成顶部一条",
);

console.log(JSON.stringify({ checks: "passed" }, null, 2));
