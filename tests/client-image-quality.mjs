import assert from "node:assert/strict";
import fs from "node:fs/promises";
import ts from "typescript";

const source = await fs.readFile("src/lib/imageQuality.ts", "utf8");
const transpiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
  },
});
const imageQuality = await import(`data:text/javascript;base64,${Buffer.from(transpiled.outputText).toString("base64")}`);

const passed = imageQuality.imageQualityGate({
  dimensions: { width: 1024, height: 1024 },
  bytes: 1024 * 1024,
  content: { inspected: true, lowInformation: false, subjectTooSparse: false },
});
assert.equal(passed.status, "passed");
assert(passed.checks.includes("image_dimensions"));
assert.equal(imageQuality.imageQualityLabel(passed), "质量通过");

const normalized = imageQuality.imageQualityGate({
  dimensions: { width: 1024, height: 1024 },
  bytes: 500000,
  normalization: {
    method: "center_crop_resize",
    sourceDimensions: { width: 1536, height: 1024 },
    requestedSize: "1024x1024",
  },
  content: { inspected: true, lowInformation: false, subjectTooSparse: false },
});
assert.equal(normalized.status, "passed");
assert(normalized.checks.includes("normalized_to_request"));
assert.match(imageQuality.imageQualitySummary({ qualityGate: normalized, imageInspection: { normalization: normalized.normalization } }), /已按 1024x1024 归一化/);

const rework = imageQuality.imageQualityGate({
  dimensions: { width: 1, height: 1 },
  bytes: 68,
  content: { inspected: true, lowInformation: true, subjectTooSparse: true },
});
assert.equal(rework.status, "rework");
assert(rework.warnings.includes("image_too_small"));
assert(rework.warnings.includes("image_low_information"));
assert(rework.warnings.includes("subject_too_sparse"));
assert.equal(imageQuality.imageQualityLabel(rework), "需返工");
assert.match(imageQuality.imageQualitySummary({ qualityGate: rework }), /尺寸过小/);

console.log(JSON.stringify({ checks: "passed" }, null, 2));
