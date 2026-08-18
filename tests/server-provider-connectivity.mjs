import assert from "node:assert/strict";
import http from "node:http";

const requests = [];
let responseMode = "ok";
const server = http.createServer((req, res) => {
  requests.push({ method: req.method, url: req.url, authorization: req.headers.authorization });
  if (responseMode === "error") {
    res.writeHead(502, { "Content-Type": "text/html" });
    res.end("<!doctype html><html><title>Bad gateway</title></html>");
    return;
  }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ data: [{ id: "gpt-image-2" }] }));
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
const baseUrl = `http://127.0.0.1:${address.port}/v1`;
const { testProviderConnectivity } = await import("../server/provider-connectivity.mjs");

const success = await testProviderConnectivity({ baseUrl, model: "gpt-image-2", apiKey: "sk-test-connectivity" });
assert.equal(success.ok, true);
assert.equal(success.label, "连接成功");
assert.match(success.message, /未生成图片/);
assert.deepEqual(requests[0], {
  method: "GET",
  url: "/v1/models",
  authorization: "Bearer sk-test-connectivity",
});
assert(!requests.some((request) => request.url?.includes("/images/generations")), "connectivity test must not generate images");

responseMode = "error";
const failure = await testProviderConnectivity({ baseUrl, model: "gpt-image-2", apiKey: "sk-test-connectivity" });
assert.equal(failure.ok, false);
assert.equal(failure.label, "连接失败");
assert.match(failure.message, /502/);
assert.match(failure.message, /HTML 错误页/);

const missingKey = await testProviderConnectivity({ baseUrl, model: "gpt-image-2", apiKey: "" });
assert.equal(missingKey.ok, false);
assert.equal(missingKey.label, "未配置 Key");
assert.equal(requests.length, 2, "missing key must not call the provider");

await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
console.log(JSON.stringify({ checks: "passed" }, null, 2));
