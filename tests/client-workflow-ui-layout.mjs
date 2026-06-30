import assert from "node:assert/strict";
import fs from "node:fs/promises";

const workflowSource = await fs.readFile("src/components/WorkflowCenter.tsx", "utf8");
const styles = await fs.readFile("src/styles.css", "utf8");

const requiredMarkup = [
  "workflow-module-shell",
  "workflow-step-tabs",
  "workflow-panel-heading",
  "workflow-input-status",
  "source-readiness-card",
  "fabric-design-grid",
  "model-portrait-rail",
  "postprocess-upload-grid",
  "before-after-card",
  "workflow-output-actions",
  "workflow-preview-grid",
];

for (const token of requiredMarkup) {
  assert(
    workflowSource.includes(token),
    `WorkflowCenter should include the ${token} structure required by the accepted module mockups`,
  );
}

const requiredCopy = [
  "款式轮廓编辑",
  "来源保留度",
  "动态预览",
  "批量输出",
  "下载全部",
  "同步 WebDAV",
  "作为参考",
];

for (const copy of requiredCopy) {
  assert(workflowSource.includes(copy), `WorkflowCenter should expose ${copy} in the redesigned workflow UI`);
}

const requiredStyles = [
  ".workflow-module-shell",
  ".workflow-step-tabs",
  ".workflow-panel-heading",
  ".source-readiness-card",
  ".fabric-design-grid",
  ".model-portrait-rail",
  ".postprocess-upload-grid",
  ".before-after-card",
  ".workflow-output-actions",
  ".workflow-preview-grid",
];

for (const selector of requiredStyles) {
  assert(styles.includes(selector), `styles.css should define ${selector}`);
}

assert(
  workflowSource.includes("compact?: boolean"),
  "Workflow result cards should support a compact product-card mode",
);
assert(
  workflowSource.includes("<ResultCard result={result} key={result.id} compact />"),
  "WorkflowResultArea should render live workflow results with compact product-card cards",
);
assert(
  workflowSource.includes("workflow-result-card compact"),
  "Compact result cards should use a distinct class for production-style result layout",
);
assert(
  styles.includes(".workflow-result-card.compact .workflow-result-body small"),
  "Compact result cards should hide long evidence text below images",
);

console.log(JSON.stringify({ checks: "passed" }, null, 2));
