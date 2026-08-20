# 短视频模块（MoneyPrinterTurbo 集成）设计

> 2026-08-19 起，「短视频」入口下分两个子模块：「AI 直出」（Seedance，火山方舟，见 [seedance-module.md](seedance-module.md)）排第一，本文描述的「文案成片」（MoneyPrinterTurbo）排第二；两者共用 `shortvideo_enabled` 这把权限开关。页壳在 `src/components/ShortVideoHub.tsx`。

> 状态：已实现第一版（仅 admin 可见 / 可用），本文是 API 与架构的权威说明。
> 上游：<https://github.com/harry0703/MoneyPrinterTurbo>（MIT，v1.3.x）。

## 1. 结论：怎么接

MoneyPrinterTurbo（下称 MPT）是一套 Python 工程：FastAPI 接口 + Streamlit 页面 + moviepy/ffmpeg 合成。
它做的事是「一句主题 → LLM 写文案 → 抽关键词 → 找素材（Pexels / Pixabay / 本地）→ TTS 配音 → 字幕 → 合成竖屏/横屏短视频」。

把它「集成进来」有三条路：

| 方案 | 说明 | 结论 |
| --- | --- | --- |
| A. 用 Node 重写整条流水线 | 要重做 TTS 时间轴、字幕排版、素材检索、moviepy 级别的拼接转场 | 工作量和维护成本都不划算，放弃 |
| B. iframe 内嵌 Streamlit 页面 | 风格、色调、账号体系全都对不上，也没法按账号隔离 | 与「整体风格一致」冲突，放弃 |
| **C. MPT 只当渲染引擎，本站做网关和界面** | MPT 的 FastAPI 只监听 `127.0.0.1`，本站 Express 代它收请求：登录、权限、任务表、文件落盘、轮询、界面全部在本站 | **采用** |

方案 C 下 MPT 对外完全不可见；用户看到的只有本站的「短视频」模块，样式沿用现有 `.simple-card / .chip / .btn / .field` 那一套和 `:root` 里的纸色 + 金色调。

一个关键取舍：**文案 / 关键词由本站自己调 OpenAI 兼容的 chat 接口生成，再把 `video_script` + `video_terms` 一起交给 MPT。**
MPT 收到现成文案就不再调它自己的 LLM，因此 MPT 侧 `config.toml` 不用配任何模型 Key；配音走 Edge TTS（免费）、字幕走 `edge` 时间轴（不需要 whisper 模型和 GPU）。这样 2 核 3G 的 VPS 也跑得动。

## 2. 架构

```
浏览器 ──(同源 /api/shortvideo/*)──▶ Express (server/shortvideo.mjs)
                                        │  requireAccount + canUseShortVideo
                                        │  shortvideo_task 表 / 文件落盘 / 轮询
                                        ├─▶ server/shortvideo-llm.mjs ──▶ OpenAI 兼容 chat（写文案、抽关键词）
                                        └─▶ server/shortvideo-engine.mjs ──▶ MPT FastAPI  127.0.0.1:18080
                                                                              /api/v1/videos, /tasks/{id}, /video_materials, /musics
                                                                              /tasks/{id}/final-1.mp4 (静态文件)
```

- **任务的真相在本站数据库**。MPT 默认用内存记任务状态，进程一重启就全忘；成片文件还在它的 `storage/tasks/<id>/`。
  所以本站在 MPT 报「完成」时立刻把 `final-*.mp4`、`subtitle.srt` 拉回 `SHORTVIDEO_ASSET_DIR/<taskId>/`，之后播放、下载都只碰本站文件；MPT 那边查不到任务时先试探成片是否已落盘，落了就照常收工，没落才判失败。
- **轮询在服务端**。`shortvideo.mjs` 里一个惰性启动的 `setInterval`，只要有 `queued/running` 的任务就每 `SHORTVIDEO_POLL_INTERVAL_MS`（默认 3s）问一次 MPT；本站重启后会把库里未完成的任务重新纳入轮询，不会像 `/api/generate` 那样一刀切标失败。
- **权限**：服务端 `canUseShortVideo(profile)` = `isAdminRole(role) || shortvideo_enabled = 1`。第一版只有 admin（`owner`）能过；后台可以按账号打开 `shortvideo_enabled` 给别人用（默认关）。前端只在 `account.features.shortVideo === true` 时渲染导航入口和视图，别的账号连入口都看不见。
- **保留期和生成图一套**（`storage.mjs` 的每小时巡检，`registerStorageMaintenanceHook("shortvideo", runShortVideoMaintenance)`）：成片在本站留 3 天，到期删 `SHORTVIDEO_ASSET_DIR/<taskId>/`、`shortvideo_task.storage_status = expired`（记录和文案留着，取文件回 410）；开了 WebDAV 自动归档的账号完成即推云盘（`<目录>/短视频/<日期>/shortvideo-<主题>-<id>.mp4`），也可 `POST /api/shortvideo/tasks/:id/archive` 手动推。成片拉回本站后立刻 `DELETE` 引擎那边的任务（整个 `storage/tasks/<id>/` 目录，含下载的素材 / 配音 / 成片副本）。上传的素材 / 音乐登记在 `shortvideo_upload`，24 小时后删：引擎在本机（`SHORTVIDEO_ENGINE_DIR`，默认取 `SHORTVIDEO_ENGINE_CONFIG` 所在目录）就直接删 `storage/local_videos/<file>` / `resource/songs/<file>`（只删登记过的音乐，引擎自带的歌不动；`local_videos` 里没登记的旧文件也清），引擎 `storage/tasks` 里超过 24 小时、不属于在跑任务的目录一并清。
- **积分**：第一版不扣费（admin 自己用）。任务行上记 `credits = 0`，将来要收费的话在 `estimateShortVideoCredits()` 里给数、创建时调 `consumeCredits`，失败时 `refundCredits`，和图片生成同一套账本。

## 3. 数据表

`shortvideo_task`（`server/shortvideo.mjs` 里 `migrateShortVideoDatabase()` 建表；`server/schema.mjs` 有 drizzle 镜像）：

| 列 | 说明 |
| --- | --- |
| `id` TEXT PK | `sv-<时间戳>-<随机>` |
| `user_id` | 归属账号 |
| `engine_task_id` | MPT 那边的 task_id |
| `status` | `queued` / `running` / `completed` / `failed` / `cancelled` |
| `progress` INTEGER | 0–100，直接沿用 MPT 的进度 |
| `stage` | `script` / `terms` / `audio` / `subtitle` / `materials` / `render` / `import` / `done` |
| `subject`, `script`, `terms_json` | 主题、最终文案、关键词数组 |
| `params_json` | 本站规范化后的参数（下文 §4.4） |
| `result_json` | `{ videos:[{name,bytes,url}], subtitle?, audioDuration?, warnings? }` |
| `error`, `failure_source` | 失败原因；`engine`（MPT 报错）/ `system`（本站或网络） |
| `credits` | 第一版恒为 0 |
| `created_at`, `updated_at`, `finished_at` | ISO 时间 |

`user_profile` 新增 `shortvideo_enabled INTEGER NOT NULL DEFAULT 0`。

## 4. API

统一约定：同源、cookie 会话、`Content-Type: application/json`，错误 `{"error":"中文一句话"}`；
未登录 401，没有短视频权限 403 `{"error":"短视频功能暂未对这个账号开放。"}`，引擎未配置 503 `{"error":"短视频引擎未接入。","engine":{...}}`。

### 4.1 总览与引擎

`GET /api/shortvideo/overview`

```json
{
  "engine": { "configured": true, "online": true, "url": "127.0.0.1:18080", "checkedAt": "…", "error": null, "version": "1.3.4" },
  "llm": { "configured": true, "model": "gpt-4o-mini", "source": "shortvideo" },
  "options": {
    "aspects": [{ "id": "9:16", "label": "竖屏 9:16", "width": 1080, "height": 1920 }, …],
    "languages": [{ "id": "", "label": "跟随主题" }, { "id": "zh-CN", "label": "简体中文" }, …],
    "voices": [{ "id": "zh-CN-XiaoxiaoNeural-Female", "label": "晓晓 · 女", "locale": "zh-CN" }, …],
    "fonts": [{ "id": "STHeitiMedium.ttc", "label": "黑体 · 中" }, …],
    "subtitlePositions": ["top", "center", "bottom"],
    "concatModes": [{ "id": "random", "label": "随机拼接" }, { "id": "sequential", "label": "顺序拼接" }],
    "transitions": [{ "id": "", "label": "无" }, { "id": "Shuffle", "label": "随机" }, …],
    "sources": [{ "id": "pexels", "label": "Pexels" }, { "id": "pixabay", "label": "Pixabay" }, { "id": "local", "label": "本地素材" }],
    "bgm": [{ "id": "random", "label": "随机" }, { "id": "none", "label": "无" }, { "id": "file", "label": "指定文件" }],
    "limits": { "maxActivePerUser": 2, "maxScriptChars": 3000, "maxCount": 3, "clipDuration": [2, 10] }
  },
  "musics": [{ "name": "output000.mp3", "size": 2249517 }],
  "materials": [{ "name": "mat1.mp4", "size": 89445 }],
  "tasks": [ …最近 30 条，见 4.3 ]
}
```

引擎状态服务端缓存 30s；`musics` / `materials` 引擎离线时为空数组，不报错。

`POST /api/shortvideo/engine/test` → `{ "engine": {…实时探测…} }`。探测只打 `GET /api/v1/tasks?page=1&page_size=1`，不会生成任何东西。

### 4.2 文案与关键词

`POST /api/shortvideo/script` `{ "subject": "…", "language": "zh-CN", "paragraphs": 1, "prompt": "可选补充要求" }` → `{ "script": "…" }`

`POST /api/shortvideo/terms` `{ "subject": "…", "script": "…", "amount": 5 }` → `{ "terms": ["city skyline", …] }`

- 用 `SHORTVIDEO_LLM_BASE_URL` / `SHORTVIDEO_LLM_API_KEY` / `SHORTVIDEO_LLM_MODEL`；没单独配就按 `SHORTVIDEO_LLM_PROVIDER`（`default` / `apimart`）复用那条图像线路的地址和共享 Key，模型默认 `gpt-4o-mini`。Packy 的图像 Key 只有 `gpt-image-2`、不能聊天，线上指到 `apimart`。
- `OPENAI_DEMO_MODE=true` 时返回演示文案 / 关键词，不出网。
- 关键词一律要英文（Pexels / Pixabay 只认英文），文案语言跟 `language`（空 = 跟随主题的语言）。

### 4.3 任务

`POST /api/shortvideo/tasks` → `202 { "task": {…} }`

请求体（都是可选，除了 `subject` 或 `script` 至少给一个）：

```json
{
  "subject": "秋冬大衣穿搭三招",
  "script": "留空则服务端先用 LLM 生成",
  "terms": ["autumn coat street style"],
  "language": "zh-CN",
  "aspect": "9:16",
  "clipDuration": 5,
  "concatMode": "random",
  "transition": "",
  "count": 1,
  "source": "pexels",
  "materials": ["mat1.mp4"],
  "voice": "zh-CN-XiaoxiaoNeural-Female",
  "voiceRate": 1.0,
  "voiceVolume": 1.0,
  "bgm": { "type": "random", "file": "", "volume": 0.2 },
  "subtitle": { "enabled": true, "position": "bottom", "font": "STHeitiMedium.ttc", "size": 60, "color": "#FFFFFF", "strokeColor": "#000000", "strokeWidth": 1.5 }
}
```

服务端做的事：规范化 + 校验（越界值一律 400 报中文）→ 没文案就调 LLM 写 → `source !== "local"` 且没关键词就调 LLM 抽 → 组 MPT `TaskVideoRequest` → `POST {engine}/api/v1/videos` → 落库 `queued` → 启动轮询。
同一账号最多 `maxActivePerUser` 条未完成任务，超了 429。

任务对象：

```json
{
  "id": "sv-1787060000000-a1b2c3",
  "status": "running", "progress": 40, "stage": "materials", "stageLabel": "找素材",
  "subject": "…", "script": "…", "terms": ["…"],
  "params": { …4.3 请求体规范化后… },
  "result": { "videos": [{ "name": "final-1.mp4", "bytes": 718404, "url": "/api/shortvideo/tasks/sv-…/files/final-1.mp4" }], "subtitle": "subtitle.srt", "audioDuration": 14 },
  "error": null, "failureSource": null, "credits": 0,
  "createdAt": "…", "updatedAt": "…", "finishedAt": null
}
```

`GET /api/shortvideo/tasks?limit=30` → `{ "tasks": [...] }`（只回自己的；admin 也只看自己的，后台总览另说）
`GET /api/shortvideo/tasks/:id` → `{ "task": {...} }`
`DELETE /api/shortvideo/tasks/:id` → `{ "ok": true }`。跑着的任务不能删（409），完成 / 失败的删掉本站文件并顺手让 MPT 清它的目录（尽力而为，失败不阻塞）。
`GET /api/shortvideo/tasks/:id/files/:name` → 成片 / 字幕文件，支持 `Range`（`<video>` 拖进度条要用）。只认 `result.videos[].name` 和 `subtitle.srt`，路径穿越一律 404。

### 4.4 素材与音乐

`GET /api/shortvideo/materials` → `{ "files": [{ "name", "size", "uploadedAt"?, "expiresAt"?, "mine"?, "originalName"? }] }`（MPT `storage/local_videos/` 目录；本站上传的带着上传时间 / 几点清理）
`POST /api/shortvideo/materials`（multipart，字段 `file`；mp4/mov/avi/flv/mkv/jpg/jpeg/png，≤ 100 MB）→ `{ "file": "xxx.mp4", "expiresAt" }`（24 小时后自动清）
`GET /api/shortvideo/musics` → `{ "files": [...] }`（同样标注本站上传的）

第一版不做 BGM 上传（MPT 自带 4 首，`random` 够用）。

### 4.5 发布文案与音乐

`POST /api/shortvideo/metadata` `{ subject, script, platform, language }` → `{ metadata: { title, caption, hashtags[] }, platform }`
平台：`douyin | xiaohongshu | bilibili | tiktok | youtube | instagram`。走本站自己的模型（引擎那条 `/social-metadata` 也能做，但那样要给引擎配模型 Key）。

`POST /api/shortvideo/musics`（multipart，字段 `file`；mp3/m4a/aac/wav/flac/ogg/opus/wma，≤30 MB）→ `{ file, originalName, size }`，转发到引擎 `/api/v1/musics`（引擎会 ffmpeg 全解码校验并改成 UUID 文件名）。

### 4.6 后台

`PUT /api/admin/users/:id/shortvideo` `{ "enabled": true }` → `{ "shortVideoEnabled": true, "canUseShortVideo": true }`（单独端点，不混进 `PATCH /api/admin/users/:id`；写 `audit_log`）。
`GET /api/admin/overview` 的每个用户带 `shortVideoEnabled` 和 `canUseShortVideo`（admin 天然为 true）。
`GET /api/me` 的 `account.features = { shortVideo: boolean }`。

配置页（`server/shortvideo-settings.mjs` + `server/shortvideo-engine-config.mjs`）：

- `GET /api/admin/shortvideo` → `{ engine, llm, settings, engineConfig, activeTasks }`
- `PUT /api/admin/shortvideo/settings` → 本站设置（`llmProviderId / llmBaseUrl / llmModel / llmApiKey / maxActivePerUser / renderThreads`），存 `app_config` 的 `shortvideo` 键；某项传空串 = 恢复 `.env` 默认；Key 用 AES-256-GCM 加密落库，只回脱敏提示。
- `POST /api/admin/shortvideo/llm/test` → 发一条最短请求验证线路 / Key / 模型。
- `PUT /api/admin/shortvideo/engine-config` → 白名单字段写回引擎 `config.toml`（按节+行定点替换，保留注释，先备份 `.bak`）。需要 `SHORTVIDEO_ENGINE_CONFIG`。
- `POST /api/admin/shortvideo/engine/restart` → 跑 `SHORTVIDEO_ENGINE_RESTART_CMD`（不经 shell）。有任务在跑时 409，除非 `force: true`。

## 5. 状态机与阶段映射

MPT 只有 `state ∈ {4 进行中, 1 完成, -1 失败}` 和 `progress`。本站按进度段翻译成阶段：

| MPT progress | stage | 界面文案 |
| --- | --- | --- |
| < 10 | script | 写文案 |
| < 20 | terms | 抽关键词 |
| < 30 | audio | 配音 |
| < 40 | subtitle | 排字幕 |
| < 50 | materials | 找素材 |
| < 100 | render | 合成视频 |
| 完成后本站拉文件 | import | 回传成片 |
| 落盘完成 | done | 完成 |

失败时 MPT 会带 `failed_stage` + `error`，本站原样进 `error`，`failure_source = engine`。
轮询连续 10 分钟打不通 MPT → `failure_source = system`，错误写「引擎失联」。

## 6. 环境变量

```
SHORTVIDEO_ENGINE_URL=http://127.0.0.1:18080   # 空 = 模块显示「未接入」，创建任务 503
SHORTVIDEO_ENGINE_API_KEY=                     # 对应 MPT config.toml [app].api_key（x-api-key 头）
SHORTVIDEO_ENGINE_TIMEOUT_MS=20000
SHORTVIDEO_ASSET_DIR=./data/shortvideo
SHORTVIDEO_POLL_INTERVAL_MS=3000
SHORTVIDEO_MAX_ACTIVE_PER_USER=2
SHORTVIDEO_RENDER_THREADS=2                    # 交给引擎的 FFmpeg 线程数
SHORTVIDEO_ENGINE_CONFIG=                      # 指到引擎 config.toml，后台才能改引擎配置
SHORTVIDEO_ENGINE_RESTART_CMD=                 # 例如 systemctl restart mpt-api
SHORTVIDEO_LLM_PROVIDER=default                # default | apimart：复用哪条图像线路的地址 + 共享 Key
SHORTVIDEO_LLM_BASE_URL=                       # 单独指定时才填
SHORTVIDEO_LLM_API_KEY=
SHORTVIDEO_LLM_MODEL=gpt-4o-mini
```

## 7. 部署（VPS）

MPT 作为独立 systemd 服务跑在本机回环地址上，和 `clothdesign` 互不影响：

```
/opt/apps/moneyprinterturbo        # git clone，uv 管的 Python 3.11 venv
  config.toml                      # listen_host=127.0.0.1, listen_port=18080, subtitle_provider="edge", api_key=<随机>
  storage/tasks/<id>/              # MPT 自己的产物；本站拉走后可以定期清
systemctl status mpt-api           # ExecStart=/opt/apps/moneyprinterturbo/.venv/bin/python main.py
```

系统依赖只要 `ffmpeg`（apt）。不装 whisper 模型、不装 ImageMagick（moviepy 2.x 用 Pillow 画字幕）。
本站 `.env` 加 `SHORTVIDEO_ENGINE_URL=http://127.0.0.1:18080` 后 `systemctl restart clothdesign` 即可。

在线素材要 Pexels / Pixabay 的免费 Key，写在 MPT 的 `config.toml`（`pexels_api_keys = ["…"]`）；没配之前只能选「本地素材」。

## 8. 测试

- `tests/server-shortvideo.mjs`：起真实 Express + 一个 Node 写的假 MPT（`/api/v1/videos`、`/tasks/{id}`、静态 mp4、`/video_materials`、`/musics`）+ 假 chat 接口。覆盖：普通账号 403 / 入口不可见、admin 创建 → 轮询 → 成片落盘 → 文件路由 Range → 删除；引擎未配置 503；参数越界 400；并发上限 429；后台开关 `shortVideoEnabled`。
- `tests/client-shortvideo.mjs`：源码断言——导航入口在 `features.shortVideo` 分支里、视图守卫、样式类存在、api.ts 有对应方法。

## 9. 已知边界

- MPT 内存态：它重启后正在跑的任务会丢，本站会在下一轮轮询里判失败并写明原因。
- Edge TTS 是微软的免费接口，偶发限流；MPT 会重试，失败会体现在 `failed_stage = audio`。
- 2 核 VPS 合成 60 秒 1080×1920 大约 1–3 分钟，同时跑多条会互相拖慢，所以默认每人最多 2 条在跑。
