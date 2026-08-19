import assert from "node:assert/strict";
import fs from "node:fs/promises";
import ts from "typescript";

const source = await fs.readFile("src/lib/duration.ts", "utf8");
const transpiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
  },
});
const duration = await import(`data:text/javascript;base64,${Buffer.from(transpiled.outputText).toString("base64")}`);

// 任务卡上的时长读到秒就够了，一分钟以上换成分秒，一小时以上换成时分。
assert.equal(duration.formatDuration(0), "0s");
assert.equal(duration.formatDuration(420), "<1s");
assert.equal(duration.formatDuration(12_400), "12s");
assert.equal(duration.formatDuration(59_400), "59s");
assert.equal(duration.formatDuration(59_600), "1m00s");
assert.equal(duration.formatDuration(125_000), "2m05s");
assert.equal(duration.formatDuration(3_725_000), "1h02m");
// 客户端和服务端时钟对不齐时会算出负数，别在卡片上摆「-3s」。
assert.equal(duration.formatDuration(-5_000), "0s");

const start = Date.parse("2026-08-19T10:00:00.000Z");

// 还在跑：一直数到现在。
assert.equal(duration.taskDurationLabel({ startedAt: start, running: true, now: start + 12_000 }), "已跑 12s");
// 跑完了：定格成总用时，不再跟着当前时间走。
assert.equal(
  duration.taskDurationLabel({ startedAt: start, finishedAt: start + 34_000, running: false, now: start + 900_000 }),
  "用时 34s",
);
// 服务端回来的 ISO 串和本地毫秒戳走同一条路。
assert.equal(
  duration.taskDurationLabel({
    startedAt: "2026-08-19T10:00:00.000Z",
    finishedAt: "2026-08-19T10:02:05.000Z",
    running: false,
    now: start,
  }),
  "用时 2m05s",
);
// 缺开始或结束时间的旧任务不画这一格，别拿两个时钟凑一个假数字。
assert.equal(duration.taskDurationLabel({ startedAt: undefined, running: true, now: start }), "");
assert.equal(duration.taskDurationLabel({ startedAt: start, finishedAt: null, running: false, now: start + 60_000 }), "");
assert.equal(duration.taskDurationLabel({ startedAt: "not-a-time", running: true, now: start }), "");

assert.equal(duration.toEpochMs("2026-08-19T10:00:00.000Z"), start);
assert.equal(duration.toEpochMs(start), start);
assert.equal(duration.toEpochMs(""), null);
assert.equal(duration.toEpochMs(Number.NaN), null);

console.log(JSON.stringify({ checks: "passed" }, null, 2));
