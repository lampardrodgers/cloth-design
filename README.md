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

客户页只对管理员显示后台入口；`/admin` 只有 `owner`（部署时建的那一个 `admin` 账号）能进，普通账号直接敲地址会被送回首页，后台 API 也一律 403。账号角色不开放修改。

当前版本已接入 Better Auth 邮箱密码登录。第一个注册用户会成为 `owner`；也可以通过 `.env` 的 `ADMIN_EMAILS` 指定管理员邮箱。

要让某个账号出图不扣积分，在 `/admin` 的“用户与用量”里把那一行的“无限”打开即可，登录后顶栏会显示“∞ 无限额度”。

服务端还保留着一个 `/api/debug/session` 调试座位端点（跳过登录、无限额度，每个浏览器一个独立座位），由 `DEBUG_UNLIMITED` 控制，默认只在非生产环境可用。**界面上已经没有任何入口**，登录页和顶栏都不再显示。它等于取消登录，公网部署请保持 `DEBUG_UNLIMITED=false`。

## 图像 API 配置

`.env`：

```bash
OPENAI_API_KEY=sk-...
OPENAI_BASE_URL=https://www.packyapi.com
OPENAI_IMAGE_MODEL=gpt-image-2
APIMART_API_KEY=sk-...
APIMART_BASE_URL=https://api.apimart.ai/v1
APIMART_IMAGE_MODEL=gpt-image-2
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

`OPENAI_*` 与 `APIMART_*` 是两套同时生效、互不覆盖的图像供应商配置。登录 `/admin` 后在「图像接口」一节可分别修改地址和模型，保存即刻生效、不用重启，也可用「测试连接」走 `GET /v1/models` 验证 Key（不产图不花钱）。账户页可选择后续生成使用哪一套 URL Base；账号自备 Key 也会和所选供应商配对。后台覆盖值存在 `app_config` 表里，留空保存或点「恢复默认」会回到对应 `.env` 值。地址填根地址或 `/v1` 地址都可以，服务端会自动归一化。

APIMart 的 `gpt-image-2` 使用异步任务协议：服务端提交 `/images/generations` 后自动轮询 `/tasks/{task_id}`，参考图按 `image_urls` 传入。自由生成支持 `auto` 与 15 种比例，以及 1K / 2K / 4K 三档分辨率——档位按线路能力开放：OpenAI 兼容协议没有 `resolution` 参数、出图恒定 1024/1536，因此只开 1K；APIMart 才有 2K / 4K。后台还能按账号把上限再往下压（只能压低，压不过线路本身的能力），服务端出图前会按这个上限裁剪，避免按用不上的档位计费。多张生成仍拆成多次 `n=1` 请求，避免不同供应商对批量参数支持不一致。`OPENAI_IMAGE_TIMEOUT_MS` 控制提交与轮询总等待时间，`IMAGE_DOWNLOAD_TIMEOUT_MS` 控制返回 URL 的图片下载超时；失败会自动退回本次扣除的积分。

如果没有 `OPENAI_API_KEY`，系统会进入演示模式，生成本地 SVG 示例图，不会调用图像引擎。真实商用前必须配置服务端 Key，并按实际可用模型更新 `OPENAI_IMAGE_MODEL`。真实图像会下载校验后保存到 `IMAGE_ASSET_DIR`，并记录尺寸、alpha 和基础内容信号；过小图片、纯色占位图、大面积空白且主体过小的结果会进入返工质量门，并同步到任务消息。“继续”把生成结果作为参考图时会复用受管 `/generated-images/...` 文件并进入 image edit 输入。虚拟模特工作流可用 `ffmpeg` 生成本地 MP4 动效预览并保存到 `VIDEO_ASSET_DIR`；配置 `AI_VIDEO_API_URL` 和 `AI_VIDEO_API_KEY` 后，短视频结果优先调用外部视频服务，支持 JSON `url`/`b64_video` 或直接 `video/mp4` 返回，`AI_VIDEO_TIMEOUT_MS` 和 `VIDEO_DOWNLOAD_TIMEOUT_MS` 分别控制视频服务请求和返回 URL 下载。后期抠图结果会检查真实 alpha 通道；配置 `SEGMENTATION_API_URL` 和 `SEGMENTATION_API_KEY` 后，抠图优先调用专用分割服务，支持 JSON `url`/`b64_json` 或直接 `image/png` 返回，`SEGMENTATION_TIMEOUT_MS` 控制分割请求超时。未配置分割服务时会回退到 image edit，棋盘格/白底 RGB 图会尝试转成真实透明 PNG；仍无 alpha 的结果不会被标记为像素级抠图通过。品牌 DNA 工作流配置 `BRAND_TRAINING_API_URL` 和 `BRAND_TRAINING_API_KEY` 后，会把品牌素材、任务 prompt 和 DNA JSON 提交到外部训练服务，并保存返回的训练任务 ID、模型 ID 和状态，`BRAND_TRAINING_TIMEOUT_MS` 控制训练提交超时。

功能中心的“生产验收”会列出外部服务配置状态，但当前基础三模块只把图像接口健康状态计入阻断项；真实 AI 行走/转身视频、像素级 alpha matte 抠图和品牌专属模型训练都是可选增强。对应服务配置后，能力标签会从“可选增强”切换为“真实接入”。真实 AI 行走/转身视频由 `AI_VIDEO_API_URL` 和 `AI_VIDEO_API_KEY` 控制；像素级 alpha matte 抠图由 `SEGMENTATION_API_URL` 和 `SEGMENTATION_API_KEY` 控制；品牌专属模型训练需要 `BRAND_TRAINING_API_URL` 和 `BRAND_TRAINING_API_KEY`。

## 多人使用（部署到 VPS 给朋友用）

### 部署

1. 服务器上配好 `.env`（至少 `AUTH_SECRET`、`PUBLIC_APP_URL`、`ADMIN_EMAILS`，共享出图的话再加 `OPENAI_API_KEY`），`npm run build && npm start`，用反向代理挂上 HTTPS。`npm run build` 会先在独立 release 目录完成全部资源，再原子切换 `dist`，不要改回直接清空线上 `dist` 的构建方式。
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
| 选择出图接口 | 账户页直接选择 URL Base；后台「图像接口」可分别维护 Packy / OpenAI 兼容接口和 APIMart，两套同时在线。用户自备 Key 会和自己选择的 URL Base 配对 |
| 忘记密码 | 那一行点「改密」（没配邮件服务，这是唯一的找回途径） |
| 停用某人 | 「状态」改成「锁定」。想留着数据又不想他用，用这个 |

管理员只有一个（`admin`），用户表里没有改角色的地方——之前误点角色下拉框把人提成管理员 / 把自己降成普通用户，两头都出过事。真要换管理员，上服务器改 `user_profile.role`。

### 怎么看情况

`/admin` 打开就是「运行概览」，五个数：账号数（含待开通）、今日活跃人数、今日生成次数（含失败数）、累计成片、30 天消耗积分，右下角还标着自助注册当前是开是关。

再往下按需要看：

- **用户与用量** —— 每个账号的任务数 / 成片数 / 消耗积分 / 近 30 天次数 / 自备 Key 次数，鼠标悬停「用量」能看到最近活跃时间。开了「无限」的账号消耗积分恒为 0，看任务数和成片数即可。
- **最近生成审计** —— 最近 80 张成片，带质量门结论，用来抽查出图质量。
- **积分流水 / 支付订单 / 支付事件** —— 计费和充值的明细。
- **存储策略** —— 服务器上成片文件数和占用、3 天暂存 / 已推云盘 / 已清理数量、上次巡检结果，可手动巡检。
- **商业化底座** —— 图像接口、支付、存储的配置健康度。

服务端日志在 `/var/log/clothdesign.log`（按本文档的 systemd 配置部署时），`journalctl -u clothdesign -f` 也能跟。

### 界面崩了怎么查

前端出问题时用户看到的往往只是一片空白，报错留在他们自己的浏览器里。所以页面会把崩溃现场发回服务端：

- 渲染崩溃、未捕获异常、画布空白自检都会 `POST /api/client-errors`，服务端按 `[client-error] <位置> | <一句话> | <页面地址> | user=<账号>` 写进日志：`grep client-error /var/log/clothdesign.log`（按本文档的 systemd 配置，服务的 stdout 落在这个文件里，不在 journal 里）。
- 最近 50 条也能直接读：`GET /api/admin/client-errors`（仅 admin）。只在内存里，重启就清空。
- 上报内容只有一句话、调用栈、页面路径和浏览器串，不带图片和提示词；接口按 IP 限速（每分钟 30 条）。

用户那边看到的不再是白屏，而是一张写着原因的卡片，带「刷新页面」；画布还多两个自救按钮（改用简易模式 / 清空本机画布内容）。画布万一变空白，页面会自己重挂一次编辑器（内容存在 IndexedDB 里，不会丢），救不回来才提示刷新。

### 成片放哪：服务器 3 天 → 本地文件夹 / WebDAV

服务器不是网盘。成片出来后**在服务器上固定保留 3 天**（写死，后台不开放修改），服务进程每小时巡检一次，到期删文件、记录标「已清理」（标题、时间、云盘备份路径还在，图看不了了）。这 3 天里每个人在「文件管理」页自己决定往哪存，两条路可以都开：

| 去处 | 怎么用 | 跟着谁 |
| --- | --- | --- |
| 本地文件夹 | 点「选择文件夹」挑一个本机目录（Chrome / Edge 桌面版，HTTPS），勾「每次出图后自动存到这个文件夹」；也能逐张「存本地」或「全部存到本地」。文件放在 `<文件夹>/日期/标题-id.png` | 这台电脑的这个浏览器（目录句柄存在 IndexedDB 里） |
| WebDAV 云盘 | 填远程地址 / 账号 / 密码 / 目录，「测试连接」通了就「保存」并勾「启用」；再勾「每次出图后自动推到云盘」就全自动。坚果云地址 `https://dav.jianguoyun.com/dav/`，密码要用应用密码。文件放在 `<目录>/日期/标题-id.png` | 账号（配置存服务端，密码加密落库，任何浏览器登录都生效） |

后台「存储策略」一节能看到服务器上文件数 / 占用、暂存中 / 已推云盘 / 已清理数量，以及上一次巡检的结果，也可以「立即巡检一次」。

**服务器上的东西一律有保留期**，每小时那次巡检一起清：

| 东西 | 留多久 |
| --- | --- |
| 生成的图（作图）、Seedance 成片 / 尾帧 / 分段接力拼出来的整条、文案成片的 MP4 / 字幕 | **3 天**：删文件、记录标「已清理」（参数 / 云盘路径还在）；开了 WebDAV 自动归档的账号生成完就自动推云盘，任务卡上也能手动「推到云盘」 |
| 上传的东西——Seedance 参考素材（图 / 视频 / 音频）、文案成片的本地素材 / 背景音乐 | **24 小时**：到点删文件和记录（还被排队 / 生成中任务引用的素材先留着）。文案成片的素材 / 音乐是上传到同机的 MoneyPrinterTurbo 引擎目录里的，引擎在本机（`SHORTVIDEO_ENGINE_CONFIG` 或 `SHORTVIDEO_ENGINE_DIR` 指着它）就直接删；引擎自带的歌不动；引擎 `storage/tasks` 里超过 24 小时的旧任务目录也一并清，成片拉回本站后引擎侧的副本立刻删 |
| 作图时上传的参考图 | 不落盘：在内存里直接转给模型 |

## 短视频模块（默认仅 admin）

左栏「短视频」下面分两个子模块（和「开始创作」的用途选择一个样式），共用一把权限开关：默认只有 admin（`owner`）能看到入口，后台「用户与用量」表里每个账号有一个「短视频」开关。服务端每个 `/api/shortvideo/*`、`/api/seedance/*` 接口都单独把关，别人直接打接口一律 403。第一版都不扣积分。

### AI 直出（Seedance，火山方舟）

提示词 / 首帧图 / 参考素材直接交给火山方舟的 Seedance 视频模型出片，成片回传到本站保留 3 天（可推云盘），上传的素材 24 小时后自动清理。设计与 API 见 [docs/seedance-module.md](docs/seedance-module.md)。

- **在哪配**：后台 → 「Seedance 接口」：API Key（填方舟控制台「API Key 管理」里的「API Key Secret」那一串）、接口地址、默认模型、每人同时几条、公网地址（方舟来取参考视频 / 音频用）、开放给用户哪些模型。存数据库、保存即生效；Key 加密落库，只回脱敏提示。「测一下」列任务 + 拉模型列表 + 自检每个模型的调用权限（只发注定被参数校验拦下的请求），不会生成视频、不产生费用。`.env` 里对应 `SEEDANCE_*`（后台改过的覆盖 `.env`）。
- **Key 的权限范围**：方舟的 API Key 可以限定「全部资源 / 自定义资源」、IP 白名单、所属资源项目。Key 能连通（列任务 200）却一提交就被拒、报 `AuthenticationError`，多半就是这把 Key 的权限范围没包含 Seedance 模型——去「API Key 管理」把权限范围改成「全部资源」（或把 Seedance 模型加进去）、关掉 IP 白名单、确认 Key 建在开通了 Seedance 的那个项目下。本站的报错会直接说这句话，后台「测一下」能逐个模型看「可调用 / Key 无权限 / 未开通」。
- **模型**：按官方文档列了能力矩阵——Seedance 2.5 / 2.0 / 2.0 fast / 2.0 mini / 1.5 pro（退役中）/ 1.0 pro / 1.0 pro fast。界面按所选模型增减参数：2.x 才有多模态参考、联网搜索、优先级；2.5 才有 MOV 输出、显式任务类型（参考 / 编辑 / 延长）；1.x 才有种子、固定镜头、离线半价；1.5 才有样片模式；1.0 才能按帧数出小数秒；1.0 系列无声。2.x 系列模型要先在方舟「开通管理」开通（账户余额 > 200 元或买节省计划），否则提交会报「模型未开通」。
- **三种方式**：文生视频；图生视频（首帧 + 可选中间帧 + 可选尾帧，2.5 下画幅只能跟随首帧）；多模态参考（2.5：图 30 / 视频 10 / 音频 10，2.0：9 / 3 / 3，提示词里用 `@图像1` `@视频1` `@音频1` 引用）。图片可以直接拖到槽位、⌘ / Ctrl + V 粘贴，或从「最近上传」拖过去，一次多张按顺序落位。
- **中间帧**：方舟只认首尾帧，所以给两种落地法：「一镜到底（参考）」把所有关键帧当参考图交给 2.x，提示词前自动说明谁是开头 / 经过 / 结尾，一条任务、一次计费，严格程度一般；「分段接力（严格）」相邻两张各出一段首尾帧视频（任何支持尾帧的模型都行），超出并发的段在本站排队依次补交，全部完成后用 ffmpeg 自动拼成一条，各段也能单独下载，按段计费。参考图 ≤ 8 MB 直接 base64 内联；更大的图和所有视频 / 音频要靠本站公网地址给方舟取（`/api/seedance/refs/public/<32 位随机编号>.<ext>`，不带登录态、靠编号当口令），所以线上要有 `PUBLIC_APP_URL` 或后台填公网地址。素材上传时就按方舟的硬限制拦（图 300–6000 px、宽高比 0.4–2.5、≤ 30 MB；视频 2–30 秒、≥ 24 fps、≤ 200 MB；音频 2–30 秒、≤ 15 MB；有 ffprobe 才量得出视频 / 音频时长）。
- **常用参数直接摆**：方式 / 模型 / 提示词 / 素材 / 画幅（6 种 + 自动）/ 分辨率（480p–4K 按模型）/ 时长（秒或「智能」）/ 有声。**高级参数收在「高级参数」里**：随机种子、固定镜头、水印、返回尾帧图、帧数、输出格式、服务等级、优先级、样片模式、任务类型、联网搜索、任务超时、一次几条。
- **任务**：服务端每 8 秒去方舟查一次，成功后把成片（和尾帧 PNG）拉回 `SEEDANCE_ASSET_DIR/tasks/<taskId>/`（方舟的 URL 只保 24 小时；本站保留 3 天，开了自动归档就推云盘），播放 / 下载走 `/api/seedance/tasks/:id/files/:name`（带登录、支持 Range）。任务卡上能「用尾帧接着拍」（连续镜头）、「同参数再来一条」、样片「出正式版」。排队中的能取消；生成中的方舟不支持取消（照样计费），只能等或强制删本站记录。方舟回的 2.5 的 1080p / 2.0 的 4K 是 10bit H.265，MOV 是 yuv444p，浏览器可能放不了，下载后用 VLC / QuickTime。
- **费用**：按方舟实际用量（按秒 / token）计费，模型旁边给了官方活动价提示，任务完成后显示消耗的 token 数。

### 文案成片（MoneyPrinterTurbo 引擎）

左栏「短视频」：一句主题 → AI 写文案 → 抽关键词 → 找素材（Pexels / Pixabay / 本地上传）→ Edge TTS 配音 → 字幕 → 合成竖屏 / 横屏 / 方形短视频。
渲染交给 [MoneyPrinterTurbo](https://github.com/harry0703/MoneyPrinterTurbo) 的 FastAPI 引擎（只监听本机回环地址），账号、权限、任务表、成片文件、轮询、界面都在本站；文案 / 关键词由本站自己调 OpenAI 兼容的 chat 接口，引擎侧不用配任何模型 Key。设计与 API 见 [docs/shortvideo-module.md](docs/shortvideo-module.md)。

- **在哪配**：后台 → 「短视频接口」一页全在那儿：上半段是本站（文案模型走哪条线路 / 模型名 / 单独的 Key / 每人同时几条 / 渲染线程），存数据库、保存即生效；下半段直接改引擎的 `config.toml`（素材库 Key、字幕方案、引擎并发、Azure / 硅基流动的 TTS Key、Whisper 模型），保存后点「重启引擎」生效。要开这半段，本站 `.env` 得指到引擎配置：`SHORTVIDEO_ENGINE_CONFIG=/opt/apps/moneyprinterturbo/config.toml` + `SHORTVIDEO_ENGINE_RESTART_CMD=systemctl restart mpt-api`。
- **接引擎**：`.env` 里配 `SHORTVIDEO_ENGINE_URL=http://127.0.0.1:18080`（引擎 `config.toml` 里 `listen_host="127.0.0.1"`、`listen_port=18080`、`subtitle_provider="edge"`；如果设了 `[app].api_key`，本站对应填 `SHORTVIDEO_ENGINE_API_KEY`）。没配就是「引擎未接入」，创建任务 503。
- **文案模型**：`SHORTVIDEO_LLM_PROVIDER=default|apimart` 复用哪条图像线路的地址和共享 Key（Packy 的图像 Key 只列出 `gpt-image-2`、不能聊天，所以线上指到 `apimart`），或者用 `SHORTVIDEO_LLM_BASE_URL / SHORTVIDEO_LLM_API_KEY` 单独指定；模型 `SHORTVIDEO_LLM_MODEL`（默认 `gpt-4o-mini`）。`OPENAI_DEMO_MODE=true` 时用示例文案。
- **在线素材**要 Pexels / Pixabay / Coverr 的免费 Key，在后台那一页填即可；没配之前只能选「本地素材」（页面里直接上传 mp4 / mov / jpg / png，图片会被引擎转成带缓慢推近的片段）。
- **成片放哪**：本站 `SHORTVIDEO_ASSET_DIR`（默认 `./data/shortvideo/<taskId>/`），引擎报完成后立刻拉回来，播放 / 下载走 `/api/shortvideo/tasks/:id/files/:name`（带登录、支持 Range）。引擎重启丢了任务态也不影响已经落盘的成片。
- **能调什么**：画幅 9:16 / 16:9 / 1:1、单段时长、片段倍速、拼接与转场、一次几条、素材来源、素材跟着文案走、文案段落数与额外写作要求、22 个 Edge 音色 + 语速音量、背景音乐（随机 / 指定 / 自己上传）、字幕开关与位置（含自定义高度）/ 字体 / 字号 / 颜色 / 描边 / 底色圆角。成片旁边可以一键生成对应平台的标题、简介和话题标签（抖音 / 小红书 / B 站 / TikTok / YouTube / Instagram）。
- **上游还有、这里暂时没接**：跨平台自动发布（要接第三方账号授权）、AI 生成配乐（Sonilo / ElevenLabs，按条计费）、LoomLoom 付费素材生成、ElevenLabs 等动态音色列表、Whisper 字幕（后台能开，但 2 核机器上会很吃力）、上传自己的配音（需要配套 Whisper 出字幕）。
- **VPS 上装引擎**：`git clone` 到 `/opt/apps/moneyprinterturbo`，用 uv 装 Python 3.11 + `uv sync --frozen`，`apt install ffmpeg`，systemd 单元 `mpt-api`（`ExecStart=… python main.py`），不装 whisper 模型（字幕用配音时间轴，2 核 3G 够用）。

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

`npm run test:server` 覆盖支付、图片落盘、图片清理、成片 3 天暂存与 WebDAV 归档（对着一个假 WebDAV 服务）、MP4 动效预览、工作流质量门和短视频模块（对着一个假 MoneyPrinterTurbo 引擎和假 chat 接口：权限门禁、创建 → 轮询 → 回传成片、Range 播放、参数校验、并发上限、后台开关）。`npm run smoke` 默认验证 `http://127.0.0.1:8888/`，覆盖登录、支付宝模拟充值入账、前台隐藏系统提示词、生成扣费、连续操作、顶部任务弹层、WebDAV 状态、独立后台模型映射、支付配置、支付订单/事件和移动端布局。

生产环境默认禁止模拟支付接口。若只是验证构建产物且没有真实商户密钥，可临时设置：

```bash
AUTH_SECRET=test-secret-for-production-smoke-1234567890 ALLOW_PAYMENT_DEMO_API=true npm start
APP_URL=http://127.0.0.1:8888/ npm run smoke
```

SQLite 账本备份：

```bash
npm run backup:db
```

成片文件的到期清理由服务进程自己每小时跑（见「成片放哪」），不需要 cron。下面这个脚本只清数据库里已经没人引用的孤儿文件，平时用不上：

```bash
IMAGE_CLEANUP_DRY_RUN=true npm run cleanup:images
npm run cleanup:images
```
