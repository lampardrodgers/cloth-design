/**
 * 按需加载的代码块（画布那 1.7MB 的 tldraw）在版本更新后会换文件名。
 * 老页面一直开着、后台部署了新版本，再点「画布」时 import 就会 404 ——
 * 而 React 遇到 lazy 加载失败会把整棵树卸载，用户看到的就是整页白屏。
 *
 * 所以这里：加载失败先自动刷一次页面（刷新后拿到的是新文件名，正常就好了），
 * 同一会话只刷一次，避免真的坏了以后反复刷；第二次失败就把错误抛给错误边界，
 * 让用户看到一句人话加一个「刷新」按钮。
 */

import { lazy, type ComponentType } from "react";
import { reportClientError } from "./clientErrors";

const RELOAD_FLAG = "clothdesign:chunk-reloaded";

function alreadyReloaded(key: string) {
  try {
    return window.sessionStorage.getItem(`${RELOAD_FLAG}:${key}`) === "1";
  } catch {
    return false;
  }
}

function markReloaded(key: string) {
  try {
    window.sessionStorage.setItem(`${RELOAD_FLAG}:${key}`, "1");
  } catch {
    // 隐私模式下写不了，就当刷过了，最多少刷一次
  }
}

/** 加载成功后清掉标记，下次更新还能再自动刷一次。 */
function clearReloaded(key: string) {
  try {
    window.sessionStorage.removeItem(`${RELOAD_FLAG}:${key}`);
  } catch {
    // 同上
  }
}

// 和 React.lazy 一样对组件 props 不作要求，交给调用处的 JSX 去校验。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function lazyWithReload<T extends ComponentType<any>>(key: string, loader: () => Promise<{ default: T }>) {
  return lazy(async () => {
    try {
      const module = await loader();
      clearReloaded(key);
      return module;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      reportClientError({ scope: "chunk", message: `加载 ${key} 失败：${message}`, detail: { retried: alreadyReloaded(key) } });
      if (!alreadyReloaded(key)) {
        markReloaded(key);
        window.location.reload();
        // 刷新是异步的，这里挂住别让 React 先渲染出错误界面
        await new Promise(() => undefined);
      }
      throw new Error("这部分界面没能加载出来（站点可能刚更新过版本）。刷新页面通常就好了。");
    }
  });
}
