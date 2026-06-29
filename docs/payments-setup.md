# 支付宝/微信支付上线配置

本项目采用自托管账号和账本，支付只直连官方商户接口：

- 支付宝：`alipay-sdk` + `alipay.trade.precreate` 扫码支付。
- 微信支付：API v3 Native 扫码支付。
- 账本：SQLite `payment_order`、`payment_event`、`credit_ledger`。

## 1. 基础环境

生产环境必须设置：

```bash
NODE_ENV=production
PUBLIC_APP_URL=https://your-domain.example
AUTH_SECRET=<32字节以上随机密钥>
ADMIN_EMAILS=admin@example.com
DATABASE_URL=file:./data/clothdesign.db
PAYMENT_DEMO_MODE=false
PAYMENT_REQUIRED_PROVIDERS=alipay,wechat
PAYMENT_REQUEST_TIMEOUT_MS=30000
```

`PUBLIC_APP_URL`、`ALIPAY_NOTIFY_URL` 和 `WECHAT_NOTIFY_URL` 必须是公网 HTTPS 地址。
`PAYMENT_REQUEST_TIMEOUT_MS` 控制支付宝/微信预下单请求超时，避免商户接口卡住时形成悬挂下单请求。

## 2. 支付宝

需要准备：

- 支付宝开放平台应用 ID。
- 应用私钥 PEM 文件。
- 支付宝公钥 PEM 文件，或 `ALIPAY_ALIPAY_PUBLIC_KEY`。
- 异步通知地址：`https://your-domain.example/api/payments/alipay/notify`。

`.env`：

```bash
ALIPAY_APP_ID=2021000000000000
ALIPAY_PRIVATE_KEY_PATH=./secrets/alipay-app-private-key.pem
ALIPAY_PUBLIC_KEY_PATH=./secrets/alipay-public-key.pem
ALIPAY_NOTIFY_URL=https://your-domain.example/api/payments/alipay/notify
ALIPAY_GATEWAY=https://openapi.alipay.com/gateway.do
```

联调步骤：

1. 先在支付宝沙箱完成扫码支付。
2. 确认 `/admin` 的“支付配置”显示支付宝配置完整。
3. 创建一个最低金额套餐订单。
4. 扫码支付后确认订单变为 `paid`。
5. 确认 `credit_ledger` 只新增一条 `recharge` 流水。

## 3. 微信支付

需要准备：

- 微信支付商户号。
- 应用 `appid`。
- 商户 API 证书序列号。
- 商户私钥 PEM 文件。
- API v3 密钥，长度必须为 32 字节。
- 微信支付平台公钥 PEM 文件，或 `WECHAT_PAY_PUBLIC_KEY`。
- 异步通知地址：`https://your-domain.example/api/payments/wechat/notify`。

`.env`：

```bash
WECHAT_APP_ID=wx0000000000000000
WECHAT_MCH_ID=1900000000
WECHAT_MCH_SERIAL_NO=0000000000000000000000000000000000000000
WECHAT_PRIVATE_KEY_PATH=./secrets/wechat-mch-private-key.pem
WECHAT_API_V3_KEY=12345678901234567890123456789012
WECHAT_PAY_PUBLIC_KEY_PATH=./secrets/wechatpay-public-key.pem
WECHAT_NOTIFY_URL=https://your-domain.example/api/payments/wechat/notify
```

联调步骤：

1. 用真实小额 Native 扫码订单测试。
2. 确认 `/admin` 的“支付配置”显示微信支付配置完整。
3. 扫码支付后确认订单变为 `paid`。
4. 确认重复通知不会重复加积分。
5. 确认金额不匹配通知不会写入支付事件或积分流水。

## 4. 启动前检查

```bash
npm run typecheck
npm run test:server
npm run build
npm audit --omit=dev
```

如果 `PAYMENT_DEMO_MODE=false` 且支付宝/微信任一必需配置缺失，服务端会拒绝启动。

## 5. 备份

SQLite 早期商用必须做文件备份：

```bash
npm run backup:db
```

默认备份到 `backups/`，可通过 `DB_BACKUP_DIR=/path/to/backups` 修改。备份目录已被 `.gitignore` 忽略，建议用系统计划任务每天执行一次，并定期把备份同步到独立磁盘或云存储。
