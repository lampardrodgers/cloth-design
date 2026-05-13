# 商用就绪说明

## 当前已经具备

- 单页服装 AI 生图工作台，包含提示词、A/B/C 参考图、参数、出图区、任务区。
- Node 服务端统一入口，默认端口 `8888`。
- `/api/generate` 服务端代理，浏览器不会接触 `OPENAI_API_KEY`。
- 无参考图时调用 Images generations，有参考图时调用 Images edits。
- 无 API Key 时自动进入演示模式，便于测试除真实生图以外的完整业务链路。
- 后台模型映射可编辑，配置保存在本地持久化层。
- 用户、充值、积分、任务、存储/WebDAV 策略页面齐全。
- `npm run smoke` 覆盖主要交互和移动端布局。

## 上线前必须接入

- `.env` 中配置 `OPENAI_API_KEY`，并按实际可用模型确认 `OPENAI_IMAGE_MODEL`。
- 将本地持久化替换为数据库，建议 Supabase/Postgres 或现有业务数据库。
- 将充值按钮接入真实支付，例如 Stripe、Lemon Squeezy、Creem、支付宝/微信聚合支付。
- 将 WebDAV 策略接入真实账号、上传队列、失败重试和后台清理任务。
- 增加登录态、RBAC 权限、审计日志、请求限流、成本告警和异常监控。

## 测试命令

```bash
npm run typecheck
npm run build
npm run smoke
```

生产模式验证：

```bash
npm run build
npm start
APP_URL=http://127.0.0.1:8888/ npm run smoke
```
