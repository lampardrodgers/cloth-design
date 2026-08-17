import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    // getAssetUrlsByImport 依赖 `?url` 导入。被 Vite 预打包成 deps 后这些导入会变成
    // undefined，画布一挂载就抛错，所以这个包必须留在预打包之外。
    exclude: ["@tldraw/assets"],
  },
});
