# ClothDesign AI 需求与完成确认

更新时间：2026-05-14

## 目标

做一个面向服装行业从业者的 AI 生图 Web 项目，让不会使用 AI 的用户也能完成图片生成、图片组合、服装迁移、广告图、商品主图、面料花型等工作流。第一版前台不暴露具体模型，后台统一配置模型映射，默认内部模型为 `gpt-image-2`。服务端默认端口为 `8888`，API Key 只允许在 Node 服务端读取。

## 验收清单

| 编号 | 用户要求 | 交付/证据 | 状态 |
| --- | --- | --- | --- |
| 1.1 | 单页完成主要生图工作台 | `src/components/StudioWorkspace.tsx`，客户页包含模式、参考图、提示词、参数、右侧出图区；任务放顶部弹层 | 已完成 |
| 1.2 | 出图显示位置 | `OutputGallery`，右侧主预览 + 缩略图切换；smoke 验证 1 张主图和 2 个缩略图 | 已验证 |
| 1.3 | prompt 提示词位置 | `PromptComposer`，首屏截图可见 | 已验证 |
| 1.4 | 参考图区域可添加，明确 A/B/C 标记 | `ReferencePanel` 支持上传、拖拽、添加、删除和角色标记；生成结果可继续变为 D | 已验证 |
| 1.5 | 模型参数设置：长宽比、分辨率、质量等 | `ParameterPanel` | 已完成 |
| 1.6 | 长宽比下拉/选项旁有比例方框 | `ratio-option` + `ratio-box` | 已验证 |
| 1.7 | 功能选择且不同模式尽量不改页面结构 | `ModePicker` 同一工作台切换模式 | 已完成 |
| 1.8 | 同时生成数量 | `settings.quantity`，范围 1-10；smoke 验证数量 2 | 已验证 |
| 1.9 | 参考 GPT Image API 的关键参数 | quality、size、output_format、background、compression、moderation、stream preview；高级参数折叠展示 | 已完成 |
| 1.10 | 用户充值、积分页面 | `AccountPanel` 只保留客户可见账户和充值；smoke 验证充值增加积分 | 已验证 |
| 2.1 | 账户管理系统方案 | `AdminPanel` 商业化底座：Auth.js/Supabase Auth、支付回调、审计 | 已完成 |
| 2.2 | 付费、后台管理、模型设置更新、充值积分管理 | `/admin` 独立后台；模型路由、积分规则、套餐、用户额度、存储策略、系统提示词均可编辑并本地持久化 | 已验证 |
| 2.3 | 传统核心功能：用户、角色、套餐、订单、人工调分、状态 | `/admin` 用户额度表、套餐表、积分规则和充值联动 | 已完成 |
| 3.1 | 服务器硬盘有限时的容量管理方案 | `StoragePanel` | 已完成 |
| 3.2 | 自动下载/限时云端/云盘 WebDAV | `StoragePolicy`、WebDAV 设置、生命周期说明、结果归档状态；smoke 验证 WebDAV 状态 | 已验证 |
| 4.1 | 客户工作台集中在一个 Web 页面展示 | 客户 SPA 左侧只保留生成/账户/存储；管理员后台移到 `/admin` 独立入口 | 已完成 |
| 4.2 | 页面简约漂亮，标题简单 | 顶栏仅显示 `ClothDesign AI` 和状态 | 已验证 |
| 5.1 | 系统提示词确保只能画图且前台不可见 | `buildOptimizedPrompt` 有系统限制；客户页 smoke 断言不显示“系统提示词” | 已验证 |
| 5.2 | 不同功能模式匹配不同提示词 | `/admin` 系统提示词模板可编辑，前台生成时内部使用 | 已完成 |
| 5.3 | A/B/C 参考图可被提示词识别 | `buildOptimizedPrompt` 内部输出参考图映射，前台只显示可编辑用户提示词 | 已完成 |
| 6.1 | AI 模型配置都在后台 | `/admin` 模型路由表 | 已完成 |
| 6.2 | 前台不显示具体模型类型 | 前台仅显示“图像引擎”，后台显示 `gpt-image-2` | 已验证 |
| 6.3 | 第一版模型为 gpt-image-2 | `modelRoutes`、`.env.example`、`server/index.mjs` 默认读取 `OPENAI_IMAGE_MODEL=gpt-image-2` | 已验证 |
| 6.4 | 前台设置参考 Image API | `ParameterPanel` + 官方文档校准 | 已完成 |
| 6.5 | 4K 分辨率不支持的长宽比置灰 | `ratio.allowedResolutions` 控制 disabled；smoke 验证 disabled 数量大于 0 | 已验证 |
| 7.1 | 任务系统展示运行中、成功、失败 | 顶部任务按钮弹层 + 卡片式 `TaskRail` | 已验证 |
| 7.2 | 不同任务消耗积分展示且有缩略图 | `TaskRail` 从生成结果匹配缩略图并显示积分 | 已验证 |
| 7.3 | 后台可设置积分分配 | `/admin` 可编辑 `creditPolicy` | 已完成 |
| 8.1 | 生成后能连续操作 | 出图可“继续”作为新参考，提示词和参数保留；smoke 验证参考图增加 | 已验证 |
| 8.2 | 连续操作与存储管理联动 | 结果状态 local/cloud/WebDAV 可切换；smoke 验证 WebDAV | 已验证 |
| 9.1 | 模块化设计和功能解耦 | `src/components`、`src/data`、`src/lib`、`src/types.ts` | 已完成 |
| 10.1 | 商业化网页效果 | `/tmp/clothdesign-desktop.png`、`/tmp/clothdesign-generated.png` 人工查看 | 已验证 |
| 10.2 | 前台后台系统联动正常 | `npm run smoke` 覆盖上传参考图、生成、任务弹层、充值、独立后台配置持久化、存储 | 已验证 |
| 10.3 | 页面大小适配，布局管理 | `/tmp/clothdesign-mobile.png`，smoke 验证移动端无横向溢出 | 已验证 |
| 10.4 | 原则上不拖动完成主要功能 | 1440x900 桌面首屏核心生成控件、参考图、参数、任务、出图区可见；上传多图仍允许参考区滚动 | 已验证 |

## API 参数校准记录

- 本项目按用户要求默认配置 `OPENAI_IMAGE_MODEL=gpt-image-2`，但模型字符串在 `.env` 和后台映射中可调整，便于按实际账号可用模型切换。
- OpenAI Images API 关键参数包括 `prompt`、`model`、`n`、`size`、`quality`、`background`、`output_format`、`output_compression`、`moderation`。
- GPT 图像模型的常见 `size` 为 `1024x1024`、`1024x1536`、`1536x1024`、`auto`。本项目的 4K 为业务导出档位，通过后台后处理映射控制支持比例。

## 验证记录

- `npm install`：通过，0 vulnerabilities。
- `npm run typecheck`：通过。
- `npm run build`：通过。
- `npm run smoke`：通过，默认地址 `http://127.0.0.1:8888/`。
- `APP_URL=http://127.0.0.1:8890/ npm run smoke`：通过，用 `npm start` 生产服务验证 `dist` 部署。
- 开发服务：`npm run dev`，本地地址 `http://127.0.0.1:8888/`。
- API 配置：`GET /api/config` 返回 `mode=demo`、`providerReady=false`、`port=8888`。
- API 生成框架：`POST /api/generate` 在无 `OPENAI_API_KEY` 时返回演示图和明确消息；有 Key 时服务端将根据是否上传参考图调用 OpenAI Images generations 或 edits。
- 浏览器截图：`/tmp/clothdesign-desktop.png`、`/tmp/clothdesign-generated.png`、`/tmp/clothdesign-mobile.png`。
- smoke 覆盖：页面标题、首屏渲染、演示/真实模式状态、前台隐藏系统提示词、参考图上传预览、模式切换、生成 2 张图、右侧主图 + 缩略图、任务弹层成功状态和缩略图、出图继续作为参考图、WebDAV 状态、4K 比例置灰、充值积分增加、客户页不暴露用户管理、独立 `/admin` 后台 `gpt-image-2` 映射、后台模型配置持久化、后台系统提示词模板、存储策略、移动端无横向溢出。
- Computer Use：按要求尝试 `Google Chrome` 和 `list_apps`，两次均 120 秒超时，当前 Computer Use 通道不可用；已用 Playwright 做等价浏览器自动化验证。

## 完成审计

本轮实现满足用户列出的 10 组需求中除真实 OpenAI 出图以外的可测试部分。当前已具备商用 MVP 框架：Node 服务端代理、8888 端口、API Key 服务端读取、无 Key 演示模式、客户生成工作台、独立管理员后台、账户积分、任务弹层、存储/WebDAV 策略、持久化和响应式测试。

仍需用户配置后才能验证的内容：

- 真实 OpenAI 出图：需要用户在 `.env` 设置 `OPENAI_API_KEY`，然后运行 `npm run dev` 或 `npm start` 后手动/自动测试。
- 真实支付收款：当前充值是商用页面和积分流水框架，未绑定 Stripe、Lemon Squeezy 或国内支付商户密钥。
- 真实 WebDAV 上传：当前已完成策略、状态和 UI 框架，未配置真实 WebDAV 账号密码。
