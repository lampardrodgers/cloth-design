import assert from "node:assert/strict";
import fs from "node:fs/promises";
import ts from "typescript";

const source = await fs.readFile("src/lib/resultFiles.ts", "utf8");
const transpiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
  },
});
const resultFiles = await import(`data:text/javascript;base64,${Buffer.from(transpiled.outputText).toString("base64")}`);

assert.equal(
  resultFiles.resultFileName({ title: "文生图-001", imageUrl: "/generated-images/11111111-1111-4111-8111-111111111111.png" }),
  "文生图-001.png",
);
assert.equal(
  resultFiles.resultFileName({ title: "look/result:01", imageUrl: "/generated-images/22222222-2222-4222-8222-222222222222.jpg?download=1" }),
  "look-result-01.jpg",
);
assert.equal(
  resultFiles.resultFileName({ title: "webp-output", imageUrl: "https://cdn.example.test/33333333-3333-4333-8333-333333333333.webp" }),
  "webp-output.webp",
);
assert.equal(resultFiles.resultFileName({ title: "transparent", imageUrl: "data:image/png;base64,AAAA" }), "transparent.png");
assert.equal(resultFiles.resultFileName({ title: "unknown", imageUrl: "/generated-images/no-extension" }), "unknown.png");
assert.notEqual(
  resultFiles.resultFileName({ title: "real-image", imageUrl: "/generated-images/44444444-4444-4444-8444-444444444444.png" }),
  "real-image.svg",
);

console.log(JSON.stringify({ checks: "passed" }, null, 2));
