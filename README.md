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

要让某个账号出图不扣积分，在 `/admin` 的“用户与用量”里把那一行的“无限”打开即可，登录后顶栏会显示“∞ 无限额度”。

服务端还保留着一个 `/api/debug/session` 调试座位端点（跳过登录、无限额度，每个浏览器一个独立座位），由 `DEBUG_UNLIMITED` 控制，默认只在非生产环境可用。**界面上已经没有任何入口**，登录页和顶栏都不再显示。它等于取消登录，公网部署请保持 `DEBUG_UNLIMITED=false`。

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

`OPENAI_BASE_URL` 和 `OPENAI_IMAGE_MODEL` 是**默认值**：登录 `/admin` 后在「图像接口」一节可以随时改成别的地址和模型，保存即刻生效、不用重启，改完还能点「测试连接」验一下（走 `GET /v1/models`，不产图不花钱）。想回到 `.env` 的值就点「恢复默认」。覆盖值存在数据库的 `app_config` 表里。地址填根地址或 `/v1` 地址都行，服务端会自动拼接 Images API 端点。Packy 的 `gpt-image-2` 每次只支持 `n=1`，后端会在用户选择多张时拆成多次请求。`OPENAI_IMAGE_TIMEOUT_MS` 控制图像引擎请求超时，`IMAGE_DOWNLOAD_TIMEOUT_MS` 控制返回 URL 的图片下载超时；生成失败会自动退回本次扣除的积分。功能中心外部素材下载、视频服务、分割服务、品牌训练和真实支付预下单也有独立超时变量，避免第三方服务卡住时形成悬挂任务或悬挂订单。

如果没有 `OPENAI_API_KEY`，系统会进入演示模式，生成本地 SVG 示例图，不会调用图像引擎。真实商用前必须配置服务端 Key，并按实际可用模型更新 `OPENAI_IMAGE_MODEL`。真实图像会下载校验后保存到 `IMAGE_ASSET_DIR`，并记录尺寸、alpha 和基础内容信号；过小图片、纯色占位图、大面积空白且主体过小的结果会进入返工质量门，并同步到任务消息。“继续”把生成结果作为参考图时会复用受管 `/generated-images/...` 文件并进入 image edit 输入。虚拟模特工作流可用 `ffmpeg` 生成本地 MP4 动效预览并保存到 `VIDEO_ASSET_DIR`；配置 `AI_VIDEO_API_URL` 和 `AI_VIDEO_API_KEY` 后，短视频结果优先调用外部视频服务，支持 JSON `url`/`b64_video` 或直接 `video/mp4` 返回，`AI_VIDEO_TIMEOUT_MS` 和 `VIDEO_DOWNLOAD_TIMEOUT_MS` 分别控制视频服务请求和返回 URL 下载。后期抠图结果会检查真实 alpha 通道；配置 `SEGMENTATION_API_URL` 和 `SEGMENTATION_API_KEY` 后，抠图优先调用专用分割服务，支持 JSON `url`/`b64_json` 或直接 `image/png` 返回，`SEGMENTATION_TIMEOUT_MS` 控制分割请求超时。未配置分割服务时会回退到 image edit，棋盘格/白底 RGB 图会尝试转成真实透明 PNG；仍无 alpha 的结果不会被标记为像素级抠图通过。品牌 DNA 工作流配置 `BRAND_TRAINING_API_URL` 和 `BRAND_TRAINING_API_KEY` 后，会把品牌素材、任务 prompt 和 DNA JSON 提交到外部训练服务，并保存返回的训练任务 ID、模型 ID 和状态，`BRAND_TRAINING_TIMEOUT_MS` 控制训练提交超时。

功能中心的“生产验收”会列出外部服务配置状态，但当前基础三模块只把图像接口健康状态计入阻断项；真实 AI 行走/转身视频、像素级 alpha matte 抠图和品牌专属模型训练都是可选增强。对应服务配置后，能力标签会从“可选增强”切换为“真实接入”。真实 AI 行走/转身视频由 `AI_VIDEO_API_URL` 和 `AI_VIDEO_API_KEY` 控制；像素级 alpha matte 抠图由 `SEGMENTATION_API_URL` 和 `SEGMENTATION_API_KEY` 控制；品牌专属模型训练需要 `BRAND_TRAINING_API_URL` 和 `BRAND_TRAINING_API_KEY`。

## 多人使用（部署到 VPS 给朋友用）

### 部署

1. 服务器上配好 `.env`（至少 `AUTH_SECRET`、`PUBLIC_APP_URL`、`ADMIN_EMAILS`，共享出图的话再加 `OPENAI_API_KEY`），`npm run build && npm start`，用反向代理挂上 HTTPS。
2. 你自己先注册（第一个**真实**账号自动成为 owner，调试座位不参与这个判定，也可用 `ADMIN_EMAILS` 指定）。
3. 拿到 owner 之后把 `ALLOW_SELF_SIGNUP=false` 写进 `.env` 重启，从此登录页只剩登录框（填账号名，不是邮箱），别人注册不进来。

反向代理要注意两项，用默认值应用会坏：`client_max_body_size` 调到 64m（默认 1m，参考图上传会 413），`proxy_read_timeout` 调到 300s（默认 60s，一次出图可能跑 3 分钟）。

### 怎么管账号

账号体系是「管理员发号」：对外只有**账号名 + 密码**，没有邮箱，也没有注册入口。
`/admin` 只有管理员账号能进，后台发出去的号一律是普通用户，进不了后台。

全在 `/admin` 的「用户与用量」里：

| 想做的事 | 怎么做 |
| --- | --- |
| 给朋友开号 | 填账号名（2-32 位字母数字，如 `xiaoli`）、初始密码（≥8 位）、显示名、图像接口 Key（可选）、初始积分，勾不勾「无限额度」，点「创建账号」。把账号名和密码发给对方就能登录 |
| 让某人不扣积分 | 那一行的「无限」点成「∞ 已开」。登录后顶栏显示 ∞，出图不计费 |
| 指定积分 | 建号时填「初始积分」，之后用「+100 / -100」调 |
| 配专属 Key | 那一行「KEY」那格点一下，粘贴 Key。配好后对方**登录就自带**，不用自己填；出图走他自己那把 Key，不扣积分也不占站点额度。留空确定 = 清除，改回站点共享 Key |
| 换出图接口 | 「图像接口」一节改 Base URL 和模型名，保存即生效。注意这是**全站**设置，所有人（包括用自备 Key 的）都走这个地址 |
| 忘记密码 | 那一行点「改密」（没配邮件服务，这是唯一的找回途径） |
| 停用某人 | 「状态」改成「锁定」。想留着数据又不想他用，用这个 |

需要再加一个管理员时，在用户表里把某行的「角色」改成 `admin` 或 `owner`；默认不会有人拿到这个角色。

### 怎么看情况

`/admin` 打开就是「运行概览」，五个数：账号数（含待开通）、今日活跃人数、今日生成次数（含失败数）、累计成片、30 天消耗积分，右下角还标着自助注册当前是开是关。

再往下按需要看：

- **用户与用量** —— 每个账号的任务数 / 成片数 / 消耗积分 / 近 30 天次数 / 自备 Key 次数，鼠标悬停「用量」能看到最近活跃时间。开了「无限」的账号消耗积分恒为 0，看任务数和成片数即可。
- **最近生成审计** —— 最近 80 张成片，带质量门结论，用来抽查出图质量。
- **积分流水 / 支付订单 / 支付事件** —— 计费和充值的明细。
- **商业化底座** —— 图像接口、支付、存储的配置健康度。

服务端日志在 `/var/log/clothdesign.log`（按本文档的 systemd 配置部署时），`journalctl -u clothdesign -f` 也能跟。

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
