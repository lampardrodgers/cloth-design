import assert from "node:assert/strict";
import fs from "node:fs/promises";
import ts from "typescript";

let source = await fs.readFile("src/lib/prompt.ts", "utf8");
source = source.replace('import { roleLabels } from "../data/catalog";', 'const roleLabels = { model: "模特", garment: "衣服", pose: "动作", scene: "场景", fabric: "面料", style: "风格" };');
source = source.replace(/import type .*?;\n/s, "");
const transpiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
  },
});
const prompt = await import(`data:text/javascript;base64,${Buffer.from(transpiled.outputText).toString("base64")}`);

const mode = {
  id: "text",
  title: "文生图",
  promptStarter: "默认提示词",
  systemTemplate: "只输出图片生成提示词。",
  description: "服装图片",
};
const settings = {
  quality: "high",
  outputFormat: "png",
  background: "auto",
  inputFidelity: "high",
  resolution: "native",
  preserveIdentity: true,
};
const optimized = prompt.buildOptimizedPrompt(
  "参考A继续生成同款细节。",
  mode,
  [
    {
      id: "ref-managed-result",
      label: "A",
      role: "style",
      note: "上一张生成结果",
      fileName: "生成结果.png",
      previewUrl: "/generated-images/11111111-1111-4111-8111-111111111111.png",
    },
  ],
  settings,
);

assert(optimized.includes("上传图片1 = 参考A"), optimized);
assert(optimized.includes("参考A: 风格，上一张生成结果，上传图片1，文件 生成结果.png"), optimized);
assert(!optimized.includes("未上传"), optimized);

console.log(JSON.stringify({ checks: "passed" }, null, 2));
