# Seedance 模块（火山方舟视频生成）

「短视频 → AI 直出」：提示词 / 首帧图 / 参考素材直接交给火山方舟（Ark）的 Seedance 视频模型出片。和「文案成片」（MoneyPrinterTurbo，见 [shortvideo-module.md](shortvideo-module.md)）并列放在「短视频」入口下，共用一把权限开关（`user_profile.shortvideo_enabled`，admin 天然可用）。

## 为什么不接进 MoneyPrinterTurbo

MPT 的素材来源写死是 Pexels / Pixabay / Coverr / 本地 / LoomLoom，没有文生视频模型的插槽；把 Seedance 生成的片段再塞回去拼素材也没意义——Seedance 本身就能出完整成片（含声音）。所以单做一个模块，直接对接方舟的异步任务接口。

## 架构

```
浏览器 ── /api/seedance/* ──► Express（本站）──► https://ark.cn-beijing.volces.com/api/v3
                                   │                    POST   /contents/generations/tasks      建任务
                                   │                    GET    /contents/generations/tasks/{id} 查状态
                                   │                    DELETE /contents/generations/tasks/{id} 取消 / 删记录
                                   │                    GET    /contents/generations/tasks      探活（只读）
                                   │                    GET    /models                           模型列表（只读）
                                   ├── seedance_task / seedance_ref / seedance_group（SQLite）
                                   ├── SEEDANCE_ASSET_DIR/tasks/<id>/video.mp4|mov, last-frame.png   （保留 3 天）
                                   ├── SEEDANCE_ASSET_DIR/groups/<groupId>/merged.mp4                  （分段接力拼出来的，保留 3 天）
                                   └── SEEDANCE_ASSET_DIR/refs/<32hex>.<ext>（方舟通过公网地址来取视频 / 音频；保留 24 小时）
```

- 鉴权 `Authorization: Bearer <API Key>`；方舟控制台「API Key 管理」给的「API Key Secret」就是要填的 Key。Key 存 `app_config`（AES-256-GCM 加密）或 `.env` 的 `SEEDANCE_API_KEY`，浏览器永远碰不到。
- 成片 URL 方舟只保 24 小时（2.5 还限 100 次下载），所以服务端轮询到 `succeeded` 就立刻拉回本地。
- 任务状态方舟侧保留 7 天；本站表是权威记录。
- 方舟 API Key 可以限定权限范围（全部资源 / 自定义资源）、IP 白名单、所属资源项目：越界时方舟回的是 `AuthenticationError`（和 Key 填错一个码），不是 `ModelNotOpen`。所以本站把 401 分两种：只读接口（列任务 / 列模型）都 401 → Key 不对；只读能过、带 model 建任务 401 → Key 没这个模型的权限，提示直接说去「API Key 管理」查权限范围 / IP 白名单 / 项目。后台「测一下」顺带对每个模型发一个 `content: []`、`resolution: "0p"` 的探测请求（方舟先鉴权再校验参数，永远建不出任务）判断「可调用 / Key 无权限 / 未开通」。

## 文件保留期（和生成图一套）

| 东西 | 放哪 | 留多久 | 到期怎么办 |
| --- | --- | --- | --- |
| 上传的参考素材（图 / 视频 / 音频、尾帧登记的图） | `refs/` + `seedance_ref` | **24 小时**（`UPLOAD_RETENTION_HOURS`） | 删文件和记录；还被排队 / 生成中任务引用的先留着 |
| 成片、尾帧 PNG | `tasks/<id>/` | **3 天**（`SERVER_RETENTION_DAYS`，和成片图同一个数） | 删文件，`seedance_task.storage_status = expired`、`expired_at` 落下；记录留着（参数 / 方舟任务号 / 云盘路径），取文件回 410 |
| 分段接力拼出来的整条 | `groups/<id>/` | 3 天 | 删文件，`seedance_group.merged_json.expiredAt` 落下 |
| `tmp/` 残留 | — | 24 小时 | 删 |

- 开了 WebDAV「生成完自动归档」的账号，成片完成后会自动推云盘（`storage_status = webdav`，路径 `<目录>/短视频/<日期>/seedance-<提示词>-<id 尾 6 位>.mp4`）；任务卡上也有「推到云盘」手动推。服务器上的文件照旧 3 天到期。
- 清理挂在 `storage.mjs` 的每小时巡检里（`registerStorageMaintenanceHook("seedance", runSeedanceMaintenance)`），后台存储巡检摘要的 `modules.seedance` 能看到这一轮清了多少。

## 中间帧

方舟的 `image_url.role` 只有 `first_frame` / `last_frame` / `reference_image`，而且三种场景互斥，没有「第 N 秒出现这张」的接口。界面上允许首帧 + 中间帧 + 尾帧（最多 `MAX_KEYFRAMES = 9` 张），提交时按 `keyframeStrategy` 落地：

| 方式 | 谁能用 | 怎么做 | 代价 / 效果 |
| --- | --- | --- | --- |
| `reference` 一镜到底 | 2.x（有 `omni`） | 全部关键帧按顺序当 `reference_image`，提示词前自动加 `keyframePrompt()`：「@图像1 是视频的第一帧画面；随后依次经过 @图像2、@图像3 的画面；@图像4 是视频的最后一帧画面。各画面之间用连贯的运镜自然过渡…」 | 一条任务、一次计费；首尾帧大体一致、中间帧是「经过」的画面，官方文档也说这是「间接实现」，严格程度不如首尾帧 |
| `segments` 分段接力 | 任何支持尾帧的模型 | 拆成 N-1 份首尾帧参数（没给尾帧时最后一段只有首帧），建一个 `seedance_group`；并发允许的段立刻交方舟，其余 `ark_task_id` 为空留在本站排队，每轮轮询 `submitPendingTasks()` 按创建顺序补交；全部完成后 `settleGroup()` 用 ffmpeg concat（先流拷贝，失败退回重编码）拼成 `groups/<id>/merged.mp4` | 按段计费、严格以指定图开头结尾；有一段失败整组标 `partial`（成功的段照样能单独下载），合并失败可 `POST /groups/:id/merge` 重试；没装 ffmpeg 就照实说 |

`count` 在分段接力下强制 1。删掉组里最后一段时组和合并成片一起清。

## 文件

| 文件 | 作用 |
| --- | --- |
| `server/seedance-ark.mjs` | 方舟 HTTP 客户端：建 / 查 / 删任务、探活、模型列表、拉文件；错误翻译（Key 不对 / 模型未开通 / 限流 / 安全审核 / 参数错） |
| `server/seedance-settings.mjs` | 后台可改配置（`app_config.seedance`）：Key、接口地址、默认模型、每人并发、公网地址、可用模型 |
| `server/seedance.mjs` | 模型能力矩阵、参数规范化、方舟请求组装、素材上传 / 公网暴露、任务表、轮询 / 回传、路由、后台路由 |
| `src/components/ShortVideoHub.tsx` | 「短视频」页壳：两个子模块切换（mode-strip） |
| `src/components/SeedanceStudio.tsx` | 工坊页面：按模型能力增减参数；高级参数默认收起 |
| `src/components/AdminSeedance.tsx` | 后台「Seedance 接口」 |
| `tests/server-seedance.mjs` | 纯函数 + 假方舟全链路；绝不碰真接口 |
| `tests/client-seedance.mjs` | 客户端源码断言 |

## 模型能力矩阵（来自官方文档「创建视频生成任务」，2026-08）

| 模型 | 分辨率 | 时长 | 有声 | 多模态参考 | 尾帧 | 其他 |
| --- | --- | --- | --- | --- | --- | --- |
| `doubao-seedance-2-5-260628` | 480p / 720p / 1080p（10bit H.265） | 4–30 s 或 -1 | ✓ | 图 30 / 视频 10 / 音频 10，可只给音频；`omni_reference_task_type` auto / reference / edit / extend | ✓（画幅只能 adaptive） | MOV 输出、优先级、联网搜索 |
| `doubao-seedance-2-0-260128` | 480p–4K | 4–15 s 或 -1 | ✓ | 图 9 / 视频 3 / 音频 3 | ✓ | 优先级、联网搜索 |
| `doubao-seedance-2-0-fast-260128` | 480p / 720p | 同上 | ✓ | 同上 | ✓ | 同上 |
| `doubao-seedance-2-0-mini-260615` | 480p / 720p | 同上 | ✓ | 同上 | ✓ | 同上 |
| `doubao-seedance-1-5-pro-251215`（退役中） | 480p–1080p | 4–12 s 或 -1 | ✓ | — | ✓ | seed、固定镜头、样片模式（480p）、离线半价 |
| `doubao-seedance-1-0-pro-250528` | 480p–1080p（默认 1080p） | 2–12 s 或 frames 29–289（25+4n） | ✗ | — | ✓ | seed、固定镜头、离线半价；文生视频不支持 adaptive |
| `doubao-seedance-1-0-pro-fast-251015` | 同上 | 同上 | ✗ | — | ✗ | 同上 |

规范化（`normalizeSeedanceRequest`）按这张表裁剪：不支持的参数直接丢掉不发；取值越界 400；2.5 的首帧 / 首尾帧和编辑 / 延长任务强制 `ratio=adaptive`，编辑任务强制 `duration=-1`；样片强制 480p 且不返回尾帧。每个请求都带 `safety_identifier`（账号 ID 的 sha256 前 48 位）。

## API

全部要登录且账号开了短视频权限（admin 天然有）；否则 401 / 403。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/seedance/overview` | 方舟状态、选项目录（模型 / 画幅 / 分辨率 / 格式 / 任务类型 / 上限）、我的素材、任务第一页 |
| POST | `/api/seedance/test` | 重新探活（只读） |
| GET / POST / DELETE | `/api/seedance/refs`、`/api/seedance/refs/:id` | 素材列表 / 上传（multipart `file`）/ 删除 |
| GET | `/api/seedance/refs/:id/file` | 本人看素材（带登录） |
| GET | `/api/seedance/refs/public/:file` | 公网取素材（不带登录，`<32hex>.<ext>` 当口令，给方舟用） |
| GET / POST | `/api/seedance/tasks` | 任务分页（`page` / `pageSize`）/ 建任务（`count` 条 = `count` 个方舟任务；201 返回 `tasks[]` 与 `warning`） |
| GET / DELETE | `/api/seedance/tasks/:id` | 详情 / 删除（本站排队中直接删；排队中 → 方舟取消；生成中 409，`?force` 只删本站；跑完的顺手删方舟记录） |
| GET | `/api/seedance/tasks/:id/files/:name` | 成片 / 尾帧（Range，`?download`；到期清理后 410） |
| POST | `/api/seedance/tasks/:id/archive` | 手动推到账号的 WebDAV |
| POST | `/api/seedance/tasks/:id/last-frame-ref` | 把尾帧登记成一张参考图 |
| GET | `/api/seedance/groups/:id` | 分段接力组：状态 + 各段 |
| POST | `/api/seedance/groups/:id/merge` | 合并失败后再试一次 |
| GET | `/api/seedance/groups/:id/files/:name` | 拼好的整条（`?download`；到期 410） |
| GET | `/api/admin/seedance` | 后台：状态、设置视图（无明文 Key）、目录、在跑数 |
| PUT | `/api/admin/seedance/settings` | 后台：`apiKey` / `baseUrl` / `defaultModel` / `maxActivePerUser` / `publicBaseUrl` / `enabledModels`（传空串 = 恢复 .env / 默认） |
| POST | `/api/admin/seedance/test` | 后台：探活 + 拉方舟模型列表 + 每个模型的调用权限自检（`probeModels: false` 可跳过；全程不建任务） |

建任务请求体（均可省略，按模型能力取默认）：`model, mode(text|image|omni), prompt, firstFrame{refId|url}, middleFrames[{refId|url}], lastFrame, keyframeStrategy(reference|segments), references[{kind,refId|url}], omniTaskType, ratio, resolution, duration(-1 智能), frames, generateAudio, watermark, seed, cameraFixed, returnLastFrame, outputFormat, serviceTier, priority, draft, webSearch, expiresAfter, count, draftTaskId`。分段接力的响应多一个 `group`。任务对象带 `pendingSubmit`（本站排队）、`group`（第几段 / 共几段 / 合并状态）、`storage`（cloud-temp / webdav / expired、到期时间、云盘路径）。

方舟侧的 401 / 403 不原样透传（浏览器会当成掉线）：统一回 502，body 里 `arkCode` / `arkStatus` / `requestId` 照给。

## 状态

`queued → running → completed | failed | cancelled | expired`。轮询间隔 `SEEDANCE_POLL_INTERVAL_MS`（默认 8 s），服务重启后未完成的任务自动续上。成功后下载失败会重试 5 次，仍失败就标失败但把方舟远端地址留给用户（24 小时内能下）。

## 环境变量

`SEEDANCE_API_KEY`、`SEEDANCE_BASE_URL`（默认北京节点）、`SEEDANCE_DEFAULT_MODEL`、`SEEDANCE_MAX_ACTIVE_PER_USER`、`SEEDANCE_PUBLIC_BASE_URL`（默认 `PUBLIC_APP_URL`；回环 / 内网不算）、`SEEDANCE_ASSET_DIR`、`SEEDANCE_POLL_INTERVAL_MS`、`SEEDANCE_TIMEOUT_MS`、`SEEDANCE_DOWNLOAD_TIMEOUT_MS`、`FFPROBE_BIN`、`FFMPEG_BIN`（分段接力合并用）。后台改过的项覆盖 `.env`。

## 测试

`node tests/server-seedance.mjs`：进程内测能力矩阵 / 规范化（含中间帧两种方式）/ 请求组装 / 设置 / 到期清理（Seedance 与文案成片两边）；再起一个假方舟（按提示词里的 `FAIL` / `SLOW` / `RUNNING` / `LOST` / `MODELNOTOPEN` / `BADPARAM` 模拟各种结局，`doubao-seedance-1-0-pro-fast-251015` 对测试 Key「没权限」，有 ffmpeg 时成片是真做的 3 秒小视频）跑全链路：权限、上传、一镜到底的参考图请求、分段接力（并发 1 → 第二段本站排队 → 自动补交 → ffmpeg 拼成一条 → 删段清组）、Key 无权限的 502、后台模型权限自检、成片到期 410。真接口只在人工验证时用只读的任务列表 / 模型列表，不会创建任务。

## 已知限制

- 生成中的任务方舟不支持取消；删本站记录不会停止计费。
- 2.5 的 1080p / 2.0 的 4K 是 10bit H.265，MOV 是 yuv444p + PCM，浏览器里可能放不出来。
- 视频 / 音频参考必须公网可取：本地开发没有公网地址时只能用图片（base64 内联）。
- 模型是否开通、余额是否够，只能在提交时从方舟的报错里知道（本站会翻译成中文）；Key 有没有模型的调用权限可以在后台「测一下」先看。
- 中间帧没有原生接口：一镜到底靠提示词引导、不保证严格；分段接力严格但按段计费，段与段之间的衔接依赖同一张关键帧做尾帧 / 首帧。
- 还没接：方舟「素材 & 虚拟人像库」的浏览（已支持手填 `asset://` 编号）、TOS 数据订阅转存、回调地址（现在靠轮询）。
