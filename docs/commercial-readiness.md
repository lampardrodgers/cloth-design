# 商用就绪说明

## 当前已经具备

- 单页服装 AI 生图客户工作台，包含提示词、可拖拽 A/B/C 参考图、参数、右侧出图区和顶部任务弹层。
- Node 服务端统一入口，默认端口 `8888`。
- `/api/generate` 服务端代理，浏览器不会接触 `OPENAI_API_KEY`。
- `/api/generate` 在读取参考图、创建任务和扣费前校验提示词，空提示词直接返回 400，避免无效请求进入图像引擎或产生扣费/退款噪音。
- 无参考图时调用 Images generations，有参考图时调用 Images edits。
- 图像引擎请求、返回 URL 图片下载、工作流素材下载、视频服务、分割服务、品牌训练服务和真实支付预下单都有可配置超时；上游卡住时会明确失败，普通生图会退回本次扣费，避免用户长时间等待或形成悬挂任务/订单。
- 工作流外部服务失败时，失败原因、下一步处理建议和不可交付标记会写入任务、失败步骤和结果元数据；功能中心会显示“工作流未通过生产验收”，避免把占位图或未完成结果误报为可交付。
- 图像结果会下载校验后写入 `IMAGE_ASSET_DIR`，前端只拿 `/generated-images/...`，避免数据库和 dashboard 堆积 base64；落盘时记录尺寸、alpha、基础内容信号和前景覆盖率，过小图片、纯色占位图或大面积空白且主体过小的结果会进入返工质量门，并同步到任务消息，避免把返工结果误报为可直接交付。
- 主工作台普通生图响应会带回 `imageInspection` 和 `qualityGate`；结果卡会显示“质量通过/需返工”、归一化说明或返工原因，用户不用打开日志也能看到交付质量证据。
- 普通生图落盘前会按用户选择的 API `size` 对 PNG 结果做中心裁切和下采样归一化，修正上游模型偶发的比例偏差；源图小于目标尺寸时不会放大，仍交给质量门识别为坏图。
- 落盘时不盲信上游 `content-type` 或本地 fallback，会按 PNG/JPEG/WebP 文件签名纠正真实 MIME 和扩展名；JPEG/WebP 结果也会记录宽高、参与低信息/主体覆盖率质量门，并通过 `sharp` 按目标尺寸中心裁切/重编码；重编码会沿用用户选择的压缩/质量参数，避免非 PNG 输出绕过尺寸、内容和压缩参数验收。
- “继续”使用生成结果作为参考图时，会保留受管 `/generated-images/...` 路径，服务端从本地生成图目录安全读取并作为 image edit 的 `image` 表单字段提交，并把这种仅携带 `sourceUrl` 的参考图计入积分估算。
- 虚拟模特 live 工作流会基于真实上身图生成本地 MP4 动效预览，文件写入 `VIDEO_ASSET_DIR` 并通过 `/generated-videos/...` 播放；配置 `AI_VIDEO_API_URL` 和 `AI_VIDEO_API_KEY` 后，短视频结果会优先调用外部视频服务，支持 JSON `url`/`b64_video` 或直接 `video/mp4` 返回，并由 `AI_VIDEO_TIMEOUT_MS` / `VIDEO_DOWNLOAD_TIMEOUT_MS` 防止服务请求或视频下载长期悬挂。未配置视频服务时，本地 MP4 仍只是动效预览，不等同于 AI 行走/转身视频模型。
- 后期处理选择抠图时会要求透明 alpha PNG，并在落盘后检查真实 alpha 通道；配置 `SEGMENTATION_API_URL` 和 `SEGMENTATION_API_KEY` 后会优先调用专用分割服务，支持 JSON `url`/`b64_json` 或直接 `image/png` 返回，并由 `SEGMENTATION_TIMEOUT_MS` 控制请求超时。未配置分割服务时会回退到 image edit；如果返回棋盘格/白底 RGB 图，会先尝试转成真实透明 PNG，仍无 alpha 时标记为 `rework`，不算像素级精准抠图通过。
- 无 API Key 时自动进入演示模式，便于测试除真实生图以外的完整业务链路。
- Better Auth 邮箱密码登录，首个用户或 `ADMIN_EMAILS` 指定用户为管理员。
- SQLite 服务端账本，保存用户额度、充值套餐、支付订单、支付事件、积分流水、生成任务和审计日志。
- 支持支付宝官方 SDK 扫码预下单与通知验签，支持微信支付 API v3 Native 扫码、请求签名、通知验签和 AES-GCM 解密。
- 独立 `/admin` 后台可编辑模型映射、积分规则、充值套餐、用户额度、存储/WebDAV 策略和系统提示词模板，并展示支付订单、支付事件和积分流水。
- `/admin` 展示支付宝/微信支付配置健康状态；关闭演示模式后，服务端会按 `PAYMENT_REQUIRED_PROVIDERS` 校验商户密钥、证书和 HTTPS 回调。
- `npm run backup:db` 可在线备份 SQLite 账本到 `backups/`。
- `npm run cleanup:images` 可按数据库引用清理旧的未引用生成图片。
- `docs/payments-setup.md` 记录支付宝/微信支付真实商户配置、联调步骤和 `PAYMENT_REQUEST_TIMEOUT_MS` 预下单超时。
- 客户页只显示账户充值、生成和存储相关页面，不暴露管理员后台入口。
- `npm run smoke` 覆盖主要交互和移动端布局。
- `npm run test:server` 覆盖支付配置校验、支付通知幂等、金额不匹配拒绝入账、扣费、退款和人工调分审计。

## 上线前必须接入

- `.env` 中配置 `OPENAI_API_KEY`，并按实际可用模型确认 `OPENAI_IMAGE_MODEL`。
- 生产环境必须设置高强度 `AUTH_SECRET`、`PUBLIC_APP_URL` 和 `ADMIN_EMAILS`。
- 配置支付宝开放平台应用、应用私钥、支付宝公钥和 `ALIPAY_NOTIFY_URL`。
- 配置微信支付商户号、商户私钥、商户证书序列号、API v3 密钥、微信支付公钥和 `WECHAT_NOTIFY_URL`。
- 将 `PAYMENT_DEMO_MODE=false`，用支付宝沙箱和微信真实小额订单完成联调。
- 生产环境不要开启 `ALLOW_PAYMENT_DEMO_API=true`；该变量只用于无真实商户密钥时验证构建产物。
- 将 WebDAV 策略接入真实账号、上传队列、失败重试和后台清理任务。
- 真实视频生成服务已经预留调用适配；配置 `AI_VIDEO_API_URL` 和 `AI_VIDEO_API_KEY` 后，虚拟模特短视频会优先走该服务。真实行走/转身效果取决于接入的视频模型本身。
- 专用图像分割/抠图服务已经预留调用适配；配置 `SEGMENTATION_API_URL` 和 `SEGMENTATION_API_KEY` 后，后期抠图会优先走该服务并用 alpha 质量门验收。真正的像素级效果仍取决于接入的分割服务本身。
- 品牌模型训练服务已经预留调用适配；配置 `BRAND_TRAINING_API_URL` 和 `BRAND_TRAINING_API_KEY` 后，会提交品牌素材和 DNA JSON，并把训练任务 ID、模型 ID 和状态写回品牌档案。真实专属模型质量仍取决于接入的训练/托管服务。
- 外部服务配置后，功能中心会把对应能力从“可选增强”动态切换为“真实接入”；未配置的视频、专用分割和品牌训练服务不计入基础三模块生产阻断项。
- 增加请求限流、成本告警和异常监控。

## 测试命令

```bash
npm run typecheck
npm run test:server
npm run build
npm run backup:db
npm run cleanup:images
npm run smoke
```

生产模式验证：

```bash
npm run build
npm start
APP_URL=http://127.0.0.1:8888/ npm run smoke
```
