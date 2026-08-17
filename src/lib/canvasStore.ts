/**
 * 画布内容存在浏览器本地（tldraw 的 IndexedDB），跟着这台机器的这个浏览器走。
 * 万一存坏了（迁移失败、写了一半断电），画布可能起不来 —— 留一个「清掉重来」的口子，
 * 放在单独的文件里，这样即使 tldraw 那个大包加载失败也能调用。
 */

export const CANVAS_PERSISTENCE_KEY = "clothdesign-free-canvas";

// tldraw 的库名规则：STORE_PREFIX + persistenceKey
const CANVAS_DB_NAME = `TLDRAW_DOCUMENT_v2${CANVAS_PERSISTENCE_KEY}`;

/** 清空本机保存的画布内容。清完要重新加载页面，编辑器才会重新建库。 */
export function resetCanvasStore() {
  return new Promise<void>((resolve) => {
    try {
      const request = window.indexedDB.deleteDatabase(CANVAS_DB_NAME);
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
      // 别的标签页占着库时会 blocked，等它也没意义，直接返回让用户刷新
      request.onblocked = () => resolve();
    } catch {
      resolve();
    }
  });
}
