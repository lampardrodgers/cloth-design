# ClothDesign AI

服装行业 AI 生图商业化原型。前台不暴露模型名称，后台配置模型路由；浏览器只调用本地服务端 `/api/generate`，API Key 只在 Node 服务端读取。账号、充值订单和积分流水使用自托管 SQLite 账本，支付支持支付宝和微信支付扫码链路。

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

客户页不会显示后台入口；`/admin` 会校验 `owner/admin` 权限。

当前版本已接入 Better Auth 邮箱密码登录。第一个注册用户会成为 `owner`；也可以通过 `.env` 的 `ADMIN_EMAILS` 指定管理员邮箱。

本地调试时，登录页会显示“∞ 开发调试”按钮。它创建一个跳过账号登录和积分扣除的服务端调试会话，工作台右上角会显示“∞ 无限额度”。

调试入口的开关是 `DEBUG_UNLIMITED`：

- 不设置（默认）：只在非生产环境可用，`npm start`（`NODE_ENV=production`）下自动关闭。
- `DEBUG_UNLIMITED=true`：显式常开，`NODE_ENV=production` 下也保留入口。适合内部自用部署。
- `DEBUG_UNLIMITED=false`：始终关闭，优先级最高。公网部署用这个。

每个点过“开发调试”的浏览器会拿到一个**独立的调试座位**（cookie 里存 12 位随机座位号，有效期 180 天），对应一条自己的 `user_profile`，账号名形如“开发调试 · a1b2c3”。因此各人的成片、任务和用量互相隔离，后台“用户与用量”里也能一行一行看到谁用了多少。调试座位可以在“账户”页填自己的图像接口 Key。

注意 `DEBUG_UNLIMITED=true` 等于**取消登录**：任何能访问到这个地址的人点一下按钮就能进来用。仅在内网、或反向代理上另外加了访问控制（如 HTTP Basic Auth、IP 白名单）时才这么配。

## 图像 API 配置

`.env`：

```bash
OPENAI_API_KEY=sk-...
OPENAI_BASE_URL=https://www.packyapi.com
OPENAI_IMAGE_MODEL=gpt-image-2
OPENAI_IMAGE_TIMEOUT_MS=120000
IMAGE_DOWNLOAD_TIMEOUT_MS=120000
WORKFLOW_ASSET_DOWNLOAD_TIMEOUT_MS=120000
OPENAI_DEMO_MODE=false
IMAGE_ASSET_DIR=./data/generated-images
IMAGE_ASSET_PUBLIC_PATH=/generated-images
VIDEO_ASSET_DIR=./data/generated-videos
VIDEO_ASSET_PUBLIC_PATH=/generated-videos
FFMPEG_BIN=ffmpeg
AI_VIDEO_API_URL=
AI_VIDEO_API_KEY=
AI_VIDEO_TIMEOUT_MS=120000
VIDEO_DOWNLOAD_TIMEOUT_MS=120000
SEGMENTATION_API_URL=
SEGMENTATION_API_KEY=
SEGMENTATION_TIMEOUT_MS=120000
BRAND_TRAINING_API_URL=
BRAND_TRAINING_API_KEY=
BRAND_TRAINING_TIMEOUT_MS=120000
PAYMENT_REQUEST_TIMEOUT_MS=30000
PORT=8888
```

`OPENAI_BASE_URL` 可以填写根地址或 `/v1` 地址，服务端会自动拼接 Images API 端点。Packy 的 `gpt-image-2` 每次只支持 `n=1`，后端会在用户选择多张时拆成多次请求。`OPENAI_IMAGE_TIMEOUT_MS` 控制图像引擎请求超时，`IMAGE_DOWNLOAD_TIMEOUT_MS` 控制返回 URL 的图片下载超时；生成失败会自动退回本次扣除的积分。功能中心外部素材下载、视频服务、分割服务、品牌训练和真实支付预下单也有独立超时变量，避免第三方服务卡住时形成悬挂任务或悬挂订单。

如果没有 `OPENAI_API_KEY`，系统会进入演示模式，生成本地 SVG 示例图，不会调用图像引擎。真实商用前必须配置服务端 Key，并按实际可用模型更新 `OPENAI_IMAGE_MODEL`。真实图像会下载校验后保存到 `IMAGE_ASSET_DIR`，并记录尺寸、alpha 和基础内容信号；过小图片、纯色占位图、大面积空白且主体过小的结果会进入返工质量门，并同步到任务消息。“继续”把生成结果作为参考图时会复用受管 `/generated-images/...` 文件并进入 image edit 输入。虚拟模特工作流可用 `ffmpeg` 生成本地 MP4 动效预览并保存到 `VIDEO_ASSET_DIR`；配置 `AI_VIDEO_API_URL` 和 `AI_VIDEO_API_KEY` 后，短视频结果优先调用外部视频服务，支持 JSON `url`/`b64_video` 或直接 `video/mp4` 返回，`AI_VIDEO_TIMEOUT_MS` 和 `VIDEO_DOWNLOAD_TIMEOUT_MS` 分别控制视频服务请求和返回 URL 下载。后期抠图结果会检查真实 alpha 通道；配置 `SEGMENTATION_API_URL` 和 `SEGMENTATION_API_KEY` 后，抠图优先调用专用分割服务，支持 JSON `url`/`b64_json` 或直接 `image/png` 返回，`SEGMENTATION_TIMEOUT_MS` 控制分割请求超时。未配置分割服务时会回退到 image edit，棋盘格/白底 RGB 图会尝试转成真实透明 PNG；仍无 alpha 的结果不会被标记为像素级抠图通过。品牌 DNA 工作流配置 `BRAND_TRAINING_API_URL` 和 `BRAND_TRAINING_API_KEY` 后，会把品牌素材、任务 prompt 和 DNA JSON 提交到外部训练服务，并保存返回的训练任务 ID、模型 ID 和状态，`BRAND_TRAINING_TIMEOUT_MS` 控制训练提交超时。

功能中心的“生产验收”会列出外部服务配置状态，但当前基础三模块只把图像接口健康状态计入阻断项；真实 AI 行走/转身视频、像素级 alpha matte 抠图和品牌专属模型训练都是可选增强。对应服务配置后，能力标签会从“可选增强”切换为“真实接入”。真实 AI 行走/转身视频由 `AI_VIDEO_API_URL` 和 `AI_VIDEO_API_KEY` 控制；像素级 alpha matte 抠图由 `SEGMENTATION_API_URL` 和 `SEGMENTATION_API_KEY` 控制；品牌专属模型训练需要 `BRAND_TRAINING_API_URL` 和 `BRAND_TRAINING_API_KEY`。

## 多人使用（部署到 VPS 给朋友用）

流程只有三步：

1. 服务器上配好 `.env`（至少 `AUTH_SECRET`、`PUBLIC_APP_URL`、`ADMIN_EMAILS`，共享出图的话再加 `OPENAI_API_KEY`），`npm run build && npm start`，用反向代理挂上 HTTPS。
2. 你自己先注册（第一个**真实**账号自动成为 owner，调试座位不参与这个判定，也可用 `ADMIN_EMAILS` 指定）。朋友用「邮箱 + 密码」注册后账号处于「待开通」状态，登录会被拦住并提示等待开通；你到 `/admin` 的「用户与用量」里点「开通」即可放行。不想审核就设 `SIGNUP_APPROVAL=false`。
3. 出图费用二选一：
   - 用你的共享 Key：朋友按积分计费，你在后台给他们调分；
   - 朋友自备 Key：在「账户」页填入自己的图像接口 Key（AES-256-GCM 加密落库，页面只回显前 3 位和后 4 位），之后创作台、自由创作和功能中心的生成都走这把 Key，不扣积分。

内部自用、不想让朋友一个个注册和等开通的话，直接设 `DEBUG_UNLIMITED=true`：每人点一次“开发调试”即可，各自拿到独立座位，同样按人隔离和统计，只是不需要账号密码。

后台「用户与用量」按账号显示任务数、成片数、消耗积分、最近 30 天次数、自备 Key 次数和最近活跃时间，也能锁定账号或收回开通。调试座位的“消耗积分”恒为 0（本来就不扣分），看任务数和成片数即可。注意自备 Key 必须与服务端 `OPENAI_BASE_URL` 是同一家接口——Base URL 和模型名是全站统一配置。

## 账号与支付配置

默认使用：

- Better Auth：邮箱密码登录和 session。
- SQLite：`DATABASE_URL=file:./data/clothdesign.db`，自动启用 WAL。
- 支付宝：官方 `alipay-sdk`，扫码预下单和异步通知验签。
- 微信支付：API v3 Native 扫码支付，请求签名、通知验签和 AES-GCM 解密。

无支付商户密钥时 `PAYMENT_DEMO_MODE=true`，可用页面里的“模拟支付成功”验证订单和积分流水。真实商用需要配置 `.env.example` 中的支付宝/微信支付商户号、密钥、证书路径和 HTTPS 回调地址。

后台 `/admin` 会显示支付宝和微信支付配置健康状态。关闭演示模式时，服务端会检查 `PAYMENT_REQUIRED_PROVIDERS` 指定渠道的密钥、证书和 HTTPS 回调地址；缺失时拒绝启动，避免上线后才发现不能收款。

完整上线配置见 [支付上线配置](docs/payments-setup.md)。

## 验证

```bash
npm run typecheck
npm run test:server
npm run build
npm run smoke
```

`npm run test:server` 覆盖支付、图片落盘、图片清理、MP4 动效预览和工作流质量门。`npm run smoke` 默认验证 `http://127.0.0.1:8888/`，覆盖登录、支付宝模拟充值入账、前台隐藏系统提示词、生成扣费、连续操作、顶部任务弹层、WebDAV 状态、独立后台模型映射、支付配置、支付订单/事件和移动端布局。

生产环境默认禁止模拟支付接口。若只是验证构建产物且没有真实商户密钥，可临时设置：

```bash
AUTH_SECRET=test-secret-for-production-smoke-1234567890 ALLOW_PAYMENT_DEMO_API=true npm start
APP_URL=http://127.0.0.1:8888/ npm run smoke
```

SQLite 账本备份：

```bash
npm run backup:db
```

旧生成图片清理：

```bash
IMAGE_CLEANUP_DRY_RUN=true npm run cleanup:images
npm run cleanup:images
```
