# ClothDesign AI

服装行业 AI 生图商业化原型。前台不暴露模型名称，后台配置模型路由；浏览器只调用本地服务端 `/api/generate`，API Key 只在 Node 服务端读取。

## 运行

```bash
npm install
cp .env.example .env
npm run dev
```

默认地址：

```text
http://127.0.0.1:8888/
```

管理员后台独立入口：

```text
http://127.0.0.1:8888/admin
```

客户页不会显示后台入口；生产上线时需要给 `/admin` 加真实管理员鉴权。

## OpenAI 配置

`.env`：

```bash
OPENAI_API_KEY=sk-...
OPENAI_IMAGE_MODEL=gpt-image-2
OPENAI_DEMO_MODE=false
PORT=8888
```

如果没有 `OPENAI_API_KEY`，系统会进入演示模式，生成本地 SVG 示例图，不会调用 OpenAI。真实商用前必须配置服务端 Key，并按实际可用模型更新 `OPENAI_IMAGE_MODEL`。

## 验证

```bash
npm run typecheck
npm run build
npm run smoke
```

`npm run smoke` 默认验证 `http://127.0.0.1:8888/`，覆盖首屏渲染、前台隐藏系统提示词、生成、连续操作、顶部任务弹层、WebDAV 状态、充值、独立后台模型映射和移动端布局。
