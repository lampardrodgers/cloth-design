import assert from "node:assert/strict";
import fs from "node:fs/promises";
import ts from "typescript";

let source = await fs.readFile("src/lib/fabricPreview.ts", "utf8");
const transpiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
  },
});
const fabricPreview = await import(`data:text/javascript;base64,${Buffer.from(transpiled.outputText).toString("base64")}`);

const layout = fabricPreview.fabricPreviewLayout({
  hemLengthPercent: 68,
  sleeveLengthPercent: 35,
  necklineDepthPercent: 24,
});

assert.deepEqual(layout.handles.hem, { x: 50, y: 67 });
assert.deepEqual(layout.handles.sleeve, { x: 24, y: 41 });
assert.deepEqual(layout.handles.neckline, { x: 50, y: 26 });
assert.equal(layout.path.includes("67"), true);
assert.equal(layout.summary, "衣长68% · 袖长35% · 领口开度24%");

assert.deepEqual(
  fabricPreview.fabricControlsFromPreviewPoint("hemLengthPercent", { x: 50, y: 16 }),
  { hemLengthPercent: 0 },
);
assert.deepEqual(
  fabricPreview.fabricControlsFromPreviewPoint("hemLengthPercent", { x: 50, y: 91 }),
  { hemLengthPercent: 100 },
);
assert.deepEqual(
  fabricPreview.fabricControlsFromPreviewPoint("sleeveLengthPercent", { x: 4, y: 45 }),
  { sleeveLengthPercent: 100 },
);
assert.deepEqual(
  fabricPreview.fabricControlsFromPreviewPoint("sleeveLengthPercent", { x: 34, y: 45 }),
  { sleeveLengthPercent: 0 },
);
assert.deepEqual(
  fabricPreview.fabricControlsFromPreviewPoint("necklineDepthPercent", { x: 50, y: 43 }),
  { necklineDepthPercent: 58 },
);

const clamped = fabricPreview.fabricPreviewLayout({
  hemLengthPercent: 140,
  sleeveLengthPercent: -20,
  necklineDepthPercent: 47.6,
});
assert.deepEqual(clamped.normalized, {
  hemLengthPercent: 100,
  sleeveLengthPercent: 0,
  necklineDepthPercent: 48,
});
assert.equal(clamped.summary, "衣长100% · 袖长0% · 领口开度48%");

console.log(JSON.stringify({ checks: "passed" }, null, 2));
