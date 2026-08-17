import assert from "node:assert/strict";
import fs from "node:fs/promises";

const app = await fs.readFile("src/App.tsx", "utf8");
const styles = await fs.readFile("src/styles.css", "utf8");

/* ── 左栏收起/展开 ────────────────────────────────────────────────────────── */

// 收起状态要跨刷新保留，否则每次进来都要重新收一遍。
assert(
  app.includes('useStoredState("clothdesign:railCollapsed", false)'),
  "rail collapse state must persist to localStorage",
);
assert(app.includes('className={`rail ${railCollapsed ? "collapsed" : ""}`}'), "rail must carry a collapsed class");
assert(app.includes('className="rail-toggle"'), "the rail needs a visible collapse/expand button");
assert(app.includes("aria-expanded={!railCollapsed}"), "the toggle must expose its state to assistive tech");
assert(
  app.includes('aria-label={railCollapsed ? "展开侧边栏" : "收起侧边栏"}'),
  "the toggle label must say what the click will do",
);

// 收起后 5px 的圆点分不出五个入口，必须留下两字短名。
assert(app.includes('<span className="rail-short"'), "collapsed rail must keep a short text label per entry");
assert(
  app.includes('title={railCollapsed ? item.displayLabel : item.label}'),
  "collapsed entries should reveal their full name on hover",
);

// 收起时素材面板/会话摘要要真正卸载，留着会撑宽或画出悬空的参考连线。
assert(
  app.includes('{railCollapsed ? null : view === "studio" ? ('),
  "collapsed rail must not render the side panels",
);
assert(app.includes('setHoveredReferenceId("")'), "collapsing must clear the reference link hover state");

for (const selector of [".rail-head", ".rail-toggle", ".rail-short", ".rail.collapsed", ".rail.collapsed .rail-copy"]) {
  assert(styles.includes(selector), `styles.css should define ${selector}`);
}
assert(/\.rail\.collapsed\s*\{[^}]*width:\s*64px/.test(styles), "collapsed rail should shrink to an icon-width strip");

console.log(JSON.stringify({ checks: "passed" }, null, 2));
