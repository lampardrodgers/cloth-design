import assert from "node:assert/strict";
import fs from "node:fs/promises";
import ts from "typescript";

const source = await fs.readFile("src/lib/api.ts", "utf8");
const transpiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
  },
});
const api = await import(`data:text/javascript;base64,${Buffer.from(transpiled.outputText).toString("base64")}`);

assert.equal(api.reusableReferenceUrl("https://example.test/look.png"), "https://example.test/look.png");
assert.equal(api.reusableReferenceUrl("data:image/png;base64,AAAA"), "data:image/png;base64,AAAA");
assert.equal(api.reusableReferenceUrl("/generated-images/11111111-1111-4111-8111-111111111111.png"), "/generated-images/11111111-1111-4111-8111-111111111111.png");
assert.equal(api.reusableReferenceUrl("/not-managed/look.png"), undefined);
assert.equal(api.reusableReferenceUrl("file:///tmp/look.png"), undefined);

const reusableWorkflowAssets = api.generatedResultsToWorkflowAssets(
  [
    {
      id: "result-good",
      title: "真实生成主图",
      mode: "text",
      imageUrl: "/generated-images/11111111-1111-4111-8111-111111111111.png",
      qualityGate: { status: "passed" },
    },
    {
      id: "result-rework",
      title: "尺寸异常图",
      mode: "text",
      imageUrl: "/generated-images/22222222-2222-4222-8222-222222222222.png",
      qualityGate: { status: "rework" },
    },
    {
      id: "result-external",
      title: "外部商品图",
      mode: "product",
      imageUrl: "https://example.test/look.png",
    },
    {
      id: "result-local-bad",
      title: "非法本地路径",
      mode: "text",
      imageUrl: "/not-managed/look.png",
    },
  ],
  { max: 2, notePrefix: "真实生成结果" },
);
assert.deepEqual(
  reusableWorkflowAssets.map((asset) => [asset.kind, asset.name, asset.sourceUrl, asset.note]),
  [
    ["result", "真实生成主图.png", "/generated-images/11111111-1111-4111-8111-111111111111.png", "真实生成结果 · text"],
    ["result", "外部商品图.png", "https://example.test/look.png", "真实生成结果 · product"],
  ],
);

const reusableDashboardAssets = api.workflowResultsToWorkflowAssets(
  [
    {
      id: "wf-post",
      type: "postprocess-suite",
      results: [
        {
          title: "旧后期结果",
          mediaType: "image",
          imageUrl: "/generated-images/33333333-3333-4333-8333-333333333333.png",
          metadata: { qualityGate: { status: "passed" } },
        },
      ],
    },
    {
      id: "wf-fabric",
      type: "fabric-to-style",
      results: [
        {
          title: "款式变体 1",
          mediaType: "image",
          imageUrl: "/generated-images/44444444-4444-4444-8444-444444444444.png",
          metadata: { qualityGate: { status: "passed" }, generationMode: "image_edit" },
        },
        {
          title: "坏图",
          mediaType: "image",
          imageUrl: "/generated-images/55555555-5555-4555-8555-555555555555.png",
          metadata: { qualityGate: { status: "rework" }, generationMode: "image_edit" },
        },
      ],
    },
    {
      id: "wf-virtual",
      type: "virtual-model-showcase",
      results: [
        {
          title: "虚拟模特上身图",
          mediaType: "image",
          imageUrl: "https://example.test/try-on.webp",
          metadata: { qualityGate: { status: "passed" }, generationMode: "image_edit" },
        },
      ],
    },
  ],
  { max: 2, notePrefix: "功能中心前序结果" },
);
assert.deepEqual(
  reusableDashboardAssets.map((asset) => [asset.kind, asset.name, asset.sourceUrl, asset.note]),
  [
    ["result", "款式变体-1.png", "/generated-images/44444444-4444-4444-8444-444444444444.png", "功能中心前序结果 · fabric-to-style · image_edit"],
    ["result", "虚拟模特上身图.webp", "https://example.test/try-on.webp", "功能中心前序结果 · virtual-model-showcase · image_edit"],
  ],
);

const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  assert.equal(String(url), "/api/workflows/jobs");
  assert.equal(init.method, "POST");
  return new Response(
    JSON.stringify({
      error: "分割服务请求超时。",
      job: { id: "wf-failed", status: "failed", message: "真实图像生成失败：分割服务请求超时。" },
      dashboard: { jobs: [{ id: "wf-failed", status: "failed" }], summary: {} },
    }),
    { status: 400, headers: { "content-type": "application/json" } },
  );
};
const failedWorkflowResponse = await api.createWorkflowJob({
  type: "postprocess-suite",
  title: "失败工作流",
  prompt: "测试失败任务返回",
  assets: [],
  options: {},
});
assert.equal(failedWorkflowResponse.error, "分割服务请求超时。");
assert.equal(failedWorkflowResponse.job.status, "failed");
assert.equal(failedWorkflowResponse.dashboard.jobs[0].status, "failed");
globalThis.fetch = originalFetch;

globalThis.fetch = async (url, init = {}) => {
  assert.equal(String(url), "/api/generate");
  assert.equal(init.method, "POST");
  return new Response(
    JSON.stringify({
      mode: "live",
	      providerReady: true,
	      imageModelConfigured: true,
	      providerHealth: { status: "ok", label: "最近真实出图成功", blocking: false, message: "ok" },
	      authEnabled: true,
	      port: 8891,
      message: "图像引擎已返回结果。",
      results: [
        {
          imageUrl: "/generated-images/quality.png",
          index: 0,
          imageInspection: { dimensions: { width: 1, height: 1 }, bytes: 68 },
          qualityGate: { status: "rework", warnings: ["image_too_small"], issues: ["生成图片尺寸过小，疑似上游坏图或占位图。"] },
        },
      ],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
};
const generationResponse = await api.requestGeneration({
  mode: { id: "text", action: "generate" },
  settings: { quantity: 1 },
  references: [],
  prompt: "quality evidence test",
  apiSize: "1024x1024",
  ratioLabel: "1:1",
});
assert.equal(generationResponse.results[0].qualityGate.status, "rework");
assert.equal(generationResponse.results[0].imageInspection.dimensions.width, 1);
assert.equal(generationResponse.providerHealth.status, "ok");
globalThis.fetch = originalFetch;

console.log(JSON.stringify({ checks: "passed" }, null, 2));
