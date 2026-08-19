import assert from "node:assert/strict";
import fs from "node:fs/promises";

const app = await fs.readFile("src/App.tsx", "utf8");
const auth = await fs.readFile("src/components/AuthPanel.tsx", "utf8");
const index = await fs.readFile("index.html", "utf8");
const favicon = await fs.readFile("public/favicon.svg", "utf8");
const styles = await fs.readFile("src/styles.css", "utf8");

assert(app.includes('<img className="brand-mark" src="/favicon.svg"'), "app brand must use the web favicon asset");
assert(app.includes("<strong>ImageDesign AI</strong>"), "main app brand should be ImageDesign AI");
assert(app.includes("<small>图片视觉工作台</small>"), "main app subtitle should describe image design");
assert(app.includes("<strong>ImageDesign Admin</strong>"), "admin brand should follow the new product name");
assert(auth.includes('<img className="auth-brand-icon" src="/favicon.svg"'), "login brand must use the same favicon asset");
assert(auth.includes("<h1 id=\"auth-product-title\">ImageDesign AI</h1>"), "login title should be ImageDesign AI");
assert(index.includes("<title>ImageDesign AI</title>"), "document title should be ImageDesign AI");
assert(favicon.includes("<title id=\"title\">ImageDesign AI</title>"), "favicon metadata should use the new product name");
assert(styles.includes(".brand-mark") && styles.includes("object-fit: contain"), "brand icon should render as an image");

console.log(JSON.stringify({ checks: "passed" }, null, 2));
