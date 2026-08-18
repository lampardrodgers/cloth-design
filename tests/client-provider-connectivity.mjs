import assert from "node:assert/strict";
import fs from "node:fs/promises";

const app = await fs.readFile("src/App.tsx", "utf8");
const api = await fs.readFile("src/lib/api.ts", "utf8");
const styles = await fs.readFile("src/styles.css", "utf8");

assert(api.includes('fetch("/api/me/image-provider/test"'), "client must call the account-level connectivity endpoint");
assert(app.includes("testMyImageProvider"), "top status must use the account-level connectivity test");
assert(app.includes('type="button"'), "connectivity control must be a button");
assert(app.includes("不会生成图片"), "the UI must explain that the test does not generate an image");
assert(app.includes("providerTestNotice"), "test result must be visible to the user");
assert(styles.includes("button.engine-status:hover"), "the status button needs click feedback");

/* ── 打开就自动测一次 ────────────────────────────────────────────────────── */
// 顶栏原来靠「最近一次真实出图」推断，自备 Key 的账号一条都不算进去，
// 于是跑了一天图，顶栏还写着「未实测」。
assert(app.includes("handleTestImageProvider({ silent: true })"), "登录后要自动实测一次");
assert(app.includes("autoTestedForRef"), "同一套账号 / 线路只自动测一次，不能每次渲染都打接口");
assert(app.includes('apiConfig.mode !== "live"'), "演示模式不用去测真实接口");
assert(app.includes("if (!silent || !result.ok)"), "自动测通了不弹提示，测不通照样要弹");

/* ── 提示条自己会退场 ────────────────────────────────────────────────────── */
assert(
  app.includes("setProviderTestNotice(null), providerTestNotice.ok ? 6000 : 15000"),
  "提示条要自动消失：成功看一眼够了，失败多留一会儿",
);
assert(app.includes('aria-label="关闭接口测试提示"'), "自动消失之外仍然要能手动关掉");

console.log(JSON.stringify({ checks: "passed" }, null, 2));
