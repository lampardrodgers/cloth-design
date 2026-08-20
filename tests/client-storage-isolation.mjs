import assert from "node:assert/strict";
import fs from "node:fs/promises";
import ts from "typescript";

const source = await fs.readFile("src/lib/storageNamespace.ts", "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const namespace = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);

class MemoryStorage {
  values = new Map();
  get length() {
    return this.values.size;
  }
  getItem(key) {
    return this.values.get(key) ?? null;
  }
  setItem(key, value) {
    this.values.set(key, String(value));
  }
  removeItem(key) {
    this.values.delete(key);
  }
  key(index) {
    return [...this.values.keys()][index] ?? null;
  }
}

const storage = new MemoryStorage();
const accountAKey = namespace.storedStateKeyForAccount("clothdesign:results", "user-a");
const accountBKey = namespace.storedStateKeyForAccount("clothdesign:results", "user-b");
assert.equal(accountAKey, "clothdesign:user-a:results");
assert.equal(accountBKey, "clothdesign:user-b:results");
assert.notEqual(accountAKey, accountBKey, "两个账号不能共享同一个 localStorage key");

storage.setItem(accountAKey, JSON.stringify([{ id: "a-result" }]));
storage.setItem(accountBKey, JSON.stringify([{ id: "b-result" }]));
storage.setItem(namespace.ACTIVE_STORAGE_ACCOUNT_KEY, "user-a");
namespace.clearAccountStoredState(storage, "user-a");
assert.equal(storage.getItem(accountAKey), null, "退出时清掉当前账号的本地数据");
assert.deepEqual(JSON.parse(storage.getItem(accountBKey)), [{ id: "b-result" }], "不能误删其他账号的数据");
assert.equal(storage.getItem(namespace.ACTIVE_STORAGE_ACCOUNT_KEY), "user-a", "清理账号数据不应隐式切换当前账号标记");

const app = await fs.readFile("src/App.tsx", "utf8");
assert(app.indexOf("setStoredStateAccount(data.account.id)") < app.indexOf("setCurrentUser(data.account)"), "账号数据必须在页面渲染前切换命名空间");
assert(app.includes("clearStoredStateAccount(signedOutAccountId)"), "退出登录必须清理账号本地数据");

console.log(JSON.stringify({ checks: "passed" }, null, 2));

