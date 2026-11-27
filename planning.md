# 技术规划与当前状态

> 对应 `PRD.md` 的 V0.1（MVP）。本文以**当前代码**为准，描述现行技术约定、已交付能力与发布前人工验收清单；过程叙事（原计划、已变更注记、修复迭代与阶段性测试数字）不再保留，追溯请查 git 历史。

---

## 1. 技术选型（当前）

| 领域 | 选择 | 依据 |
|---|---|---|
| 桌面框架 | Electron（45） | TS 全栈对 AI 生成与调试最友好；国内平台非官方 API 参考实现多为 Node.js 生态；签名与自动更新链路成熟。core 层平台无关，保留未来迁移余地 |
| 语言 | TypeScript（strict，6.0.3） | 类型即契约，错误在编译期暴露；TS7 与 typescript-eslint 冲突，故固定 6.x |
| UI | React 19 + Vite 8 + Tailwind CSS 4 | 快速出可用界面，与 Vite 同源 |
| 状态管理 | Zustand 5 | 轻量、样板代码少 |
| 本地存储 | better-sqlite3 13.2.0（WAL） | 同步 API、性能足够（万级歌曲）、类型友好；native 模块需 rebuild 到 Electron ABI |
| 凭证存储 | Electron `safeStorage` | 满足「不明文落盘」硬性要求；无需额外 native 依赖；仅主进程读写 |
| 单元测试 | Vitest 5 | 与 Vite 同源、启动快、TS 原生支持 |
| 页面实测 | Playwright（调研工具，非项目依赖） | 用于上游登录态页面字段/DOM 实测，不是自动化 E2E 套件 |
| 代码规范 | ESLint + Prettier | agent 与人类遵守同一套约定 |
| 打包 | electron-builder 26 + electron-updater 6 | Windows NSIS + macOS dmg/zip + Linux AppImage；GitHub Releases 发布 |

**设计约束**
- `core/` 禁止 import Electron、Node 内置模块或任何平台 SDK —— 保证可独立测试与可迁移
- 主进程与渲染进程通过 preload contextBridge 通信，`nodeIntegration: false`、`contextIsolation: true`、渲染层 `sandbox: true`，preload 为 CJS 输出
- 平台差异全部收敛在 `platforms/`，core 只依赖 `PlatformAdapter` 接口
- 凭证只经主进程 safeStorage 加密读写，渲染进程永不接触原始凭证；日志全量脱敏
- 用户可见 UI 文案走 i18n（zh-CN / en-US），core 与主进程日志用简体中文

---

## 2. 架构分层

```
src/
├── core/          # 平台无关的纯业务逻辑（可用 Vitest 独立测试）
│   ├── models/    # 领域类型：Song / Playlist / ParseResult / PlatformAccount
│   ├── parser/    # 文本快速创建：探测、行分类、顺序判定、结构格式解析
│   ├── matcher/   # 歌曲匹配引擎：归一化、模糊匹配、金标准判定
│   ├── sync/      # 同步引擎：差异计算、并发搜索、候选确认、停止/跳过
│   ├── export/    # 歌单导出（m3u/csv）
│   ├── logging/   # 日志（递归脱敏、请求失败出入参记录）
│   ├── cachePolicy.ts
│   └── sync/tuning.ts  # 同步调优参数单一事实源
├── platforms/     # 插件化平台适配器（import.meta.glob 自动收集，每个平台一个目录）
│   ├── base.ts    # PlatformAdapter 接口与模板方法（BasePlatformAdapter）
│   ├── meta.ts    # PlatformModule 元信息类型
│   ├── index.ts   # glob 收集器
│   ├── netease/   # 网易云音乐（NeteaseCloudMusicApi）
│   ├── qqmusic/   # QQ 音乐（qq-music-api Node 模式）
│   ├── kugou/     # 酷狗音乐（kugoumusicapi 库模式）
│   └── applemusic/# Apple Music（社区路径 Web API）
├── main/          # Electron 主进程：IPC、数据库、凭证、平台注册、日志、更新
├── preload/       # 预加载脚本：安全的 contextBridge API（CJS 输出）
└── renderer/      # React UI（i18n 中英双语）
tests/             # Vitest 单元测试（core/main/platforms/renderer）
```

---

## 3. 已交付能力（当前状态）

### 3.1 文本快速创建
- 格式自动探测 `detectFormat`：json > m3u > lrc > csv > share > lines；行分类 `classifyLine`：`song / meta / template / chat / link / noise`。结果记入 `ParseResult.format` 与 `ignoredLines`，用户无需选择格式
- 字段顺序 `core/parser/orderInfer.ts`：仅用强结构信号（书名号 +0.40 歌名、版本词 +0.35 歌名、多人名 +0.35 歌手、feat. +0.30 歌手、长度弱信号），差值 ≥0.25 定序；整段投票阈值 60%（样本 ≥2）裁决歧义行；双字段均无中文默认 artist-first，其余默认 title-first。**不使用本地歌手词典**；`ParseOptions.order` 仅作高级覆盖
- 顺序最终由平台搜索验证裁决：`MatchQuery.alternatives` 携带双候选，`planSync` 主候选搜索 + `exactMatch` 反向精确匹配（候选标题 == query 歌手且候选歌手 == query 歌名 → 判定字段颠倒）+ 备选搜索；`maxSearchesPerSong=4` 控制开销；版本标记经 `pickBestVersion` 匹配同版本候选
- 边界处理：CSV 双引号转义与 `""` 转义；冒号前缀锚定剥离（数字冒号不剥、中文昵称必剥、英文昵称 ≤8 字符且剩余含中文才剥）；版本词边界正则 `\b(live|remix|cover|demo|acoustic|instrumental|ver\.?)\b` 避免词根误判
- 输入区 TAG 化：`lines` 为唯一数据源，实时解析；`onPaste` 从剪贴板取原始换行拆行；逐标签编辑（Enter 提交 / Esc 取消 / blur 提交）、删除；重复歌曲 `songDupKey` 归一化标记「重」徽章并在创建时去重；被忽略行可见可恢复
- 歌单名留空时按「今日日期 + 第一首匹配歌曲风格」自动命名；无风格时仅日期

### 3.2 匹配与同步
- 同步流程**先建单 → 匹配 → 写入**（`runSyncPipeline` → `createThenSync`；core 入口 `syncPlaylist` 同序）：建单失败即任务失败；歌单已建即为成功，空歌单按 done + 明细失败数如实呈现（渲染层/主进程/系统通知提示「歌单已创建但未写入歌曲」）；choice-needed 挂起时歌单已建，确认后经 `existingPlaylistId` 直接写入；断点恢复按检查点阶段区分：`adding` → `resumeSync` 直写剩余批次，`created`/匹配中断 → `completeAfterCreate` 补跑匹配后写入；歌单名留空自动命名仅用日期
- 代理金标准（`core/matcher/exactMatch.ts`）：ISRC 国内平台不暴露，采用标题 + 歌手归一化精确相等 = `exact` 自动选；同歌不同作者 = `title-only` → `choice-needed` 两阶段（planSync → 用户选择 → executeSync，plan 缓存于 `pendingSyncs`，`platform:confirm-sync` 完成写入）；feat./多人名按人名交集判定，视为同一歌手则不进手动面板
- 评分因子（T8）：归一化含小写/繁转简/全角转半角/去括号；歌手 exact +0.15 / partial +0.05；专辑 exact +0.05 / partial +0.02；版本标记同 +0.08 / 异 −0.05；时长 +0.02。斜杠不切分（乐队名 `Weird Fishes/Arpeggi`）
- 并发（`core/sync/syncPlaylist.ts`）：`searchConcurrency` 默认 3 的受控并发池；`searchIntervalMs` 为**全局相邻两次搜索请求的最小间隔**（预约式限速器）；同一首歌「歌名+歌手」与「纯歌名」并行预取；任务内关键词缓存（normalize(keyword) 为 key，含在途 promise 去重，失败不缓存）；任一请求 `rateLimited` 触发全局冷却 4s；搜索超时 15s、建单/加歌 60s；结果按输入 index 顺序收敛，进度/明细/断点语义与串行一致
- 介入控制：`AbortSignal` 停止、`skipCheck` 跳过当前歌曲；`SyncAbortedError` 携带 partial 明细收敛为 `stopped` 报告；逐首明细存 `sync_tasks.detail`，重启后详情抽屉可见；重启残留 running 任务归 `interrupted`，stopped 保持
- 同步来源：文本快速创建（`text-import`）、平台歌单跨平台同步（`playlist-import:<来源平台id>`，同步历史行展示「A 平台 → B 平台」，旧记录 `playlist-import` 兜底显示「歌单导入」，`sourceLabel.ts` 的 `sourcePlatformId` 解析）与本地歌单同步（`local-playlist`）；失败按稳定 reason 码在渲染层翻译，平台原始错误透传；先建单流程下空输入不建单，未匹配保留已建空歌单

### 3.3 平台接入
- **网易云**：`NeteaseCloudMusicApi`（CJS + 内联 createRequire）；连续快搜触发 405 风控，限速 + 指数退避重试；`/login/qr/*` 扫码登录；歌单列表过滤 `specialType=5` 与 `subscribed=true`，仅显示自有歌单；写接口 `playlist_name_update` / `playlist_delete` / `playlist_track_delete`；`PlatformPlaylist` 带 `webUrl`（music.163.com）与 `appUrl`（orpheus://）；翻唱/改编条目歌手 `ar[].id` 上游恒 0（实测确认），过滤不进入 `singerIds`，点击回退名字搜索（百科服务层 `isValidEntityId` 再兜底拦截 "0"）
- **QQ音乐**：`@yakult-green-tea/qq-music-api` **Node 模式**（主进程加载包根模块启动内置 Koa 服务，含 MQTT，动态空闲端口，handler 转发 127.0.0.1:端口）；serverless 模式不支持 qqmusic 通道；`/login/qr/*`（key/create/check）为 **GET**（Node 模式 POST 会 405）；三通道扫码（qqmusic/wechat/qq）；`QQ_SESSION_SECRET` 与会话文件持久化到 userData；写操作每批 ≤100；`webUrl`（y.qq.com）与 `appUrl`（qqmusic://）；genre 字段上游恒 0，映射为 undefined，不调用 `/song/genre`
- **酷狗**：`kugoumusicapi` **库模式**（createRequire 直调扁平函数，不启动 HTTP 服务）；token 与设备指纹（guid/mid/dev/dfid）绑定，持久化到 `userData/kugou-device.json`，删除后登录失效；歌单过滤 `type=1`（收藏他人），`is_mine` 恒 0 不可用；歌曲拉取双路径（自建走云歌单 listid、收藏走公开歌单 global_collection_id，空则回退）；搜索 `v2/search/song` 的 `data.lists` 为 flat 歌曲数组（兼容嵌套协议），`error_code=1002` 判为限流；加歌 `名称|hash|album_id|mixsongid`、删歌按 fileid；标题 `<em>` 高亮需剥离，`timelen` 微秒脏值需换算
- **Apple Music**：社区路径（网页前端 developer token `iss=AMPWebPlay` + 登录 cookie 的 `media-user-token`）；读接口 `api.music.apple.com`，写接口必须 `amp-api.music.apple.com`（删除在官方主机固定 401）；无「移除歌曲」端点（UI 隐藏）；建单/加曲单次上限 100、分批写入，新建歌单 404 时 1.5s 重试一次；catalog search limit ≤25，搜索词把 ` - ` 替换为空格；官方 API 无用户资料接口，`userId` 为 storefront 地区码；网页登录 cookie 到手即落最小凭证并广播 `pending: true` 临时登录态，昵称（`profileSelector`）与账户页 Apple ID 邮箱（`accountProbe`）在隐藏窗口后台串行补全后经 `accounts:changed` 刷新；邮箱属 PII，仅存本地加密凭证，日志不记录

### 3.4 歌单、缓存与数据层
- 歌单管理：重命名（内联编辑）、删除（两步确认）、增删歌曲，`capabilities.write` 平台才显示管理操作；本地歌单库（事务化整单替换/追加/按位删除重排，无需登录）；导入 m3u/m3u8/csv/txt/lrc/json（5MB 上限、去 BOM），导出 m3u/csv；平台与本地歌单列表共用唯一模板 `PlaylistList.tsx`（行结构、封面 / 单行名称 / 歌曲数、来源平台 logo、选中配色、错峰入场动效与行内重命名都在模板内），样式常量在 `playlistRowStyles.ts`、长文本在 `MarqueeText.tsx`，调用方只传数据与回调；平台标识在所有区域只显示 `PlatformLogo`，平台名称仅保留在 `title`/`alt`、右键菜单文字描述与必要说明文案中（平台切换、账号卡片、同步目标、文本导入、同步历史、扫码弹窗统一；右键菜单文案保持原样）
- 歌曲列表 `SongList.tsx`：`showHeader` 开启时渲染「# / 歌名 / 歌手 / 专辑 / 时长」固定表头（列宽与数据行对齐、整列缺失同步隐藏、行尾操作列等宽占位）；封面缺失回退音符图标；超长文本 marquee 裁剪；`selectable` 可选开启鼠标多选（无复选框：点击行切换选中、Shift 点选锚点到当前行整段连选、按下拖动超 5px 后按经过行整段框选并抑制一次 click；选中高亮与歌单列表一致用 `transition-colors` 渐变），列头在选中后切换为「已选 N 首 / 全选 / 取消选择 / 删除所选」文字工具条，一次 IPC 批量删除；平台歌单按 `removeSongs` 能力置灰并悬浮显示原因，本地歌单按 position 批量删除后同步重排序号；搜索结果与同步历史不开多选
- 歌单选择：`usePlaylistMultiSelect.ts` 统一实现拖拽框选（5px 阈值、锚点→当前行）、Cmd/Ctrl+单击切换，已选计数/清除用 `PlaylistSelectionStatus.tsx`；右键菜单由 `buildPlaylistMenu.tsx` 统一构造公共项（重命名/同步到/导出/删除），「新建歌单」仅列表空白区右键显示（行右键 stopPropagation 不显示），平台专属项（打开链接）走 `extraItems`，「同步到本地」经 `localSync` 参数排在所有平台目标之前（应用 logo，单选弹目标选择、多选逐个保存为新本地歌单），删除确认统一 `PlaylistDeleteDialog.tsx`，本地按平台同等对待；菜单渲染仍用 `ContextMenu.tsx`；新建歌单内联表单在 `PlaylistList.tsx` 统一渲染，本地不再有右上角独立新建按钮，平台新建通过 `platform:playlist-create` 调适配器（四平台均实现），本地走 `local-playlist:create`（portal 挂载、视口翻转定位、键盘导航、滚动/resize 关闭、role/aria）；多选支持「同步到」各平台与「同步到本地」，单选另含重命名/应用打开/浏览器打开（scheme 白名单 http/https/orpheus/qqmusic）；本地歌单列表右键复用同一菜单，含重命名、按目标歌单同步到（已登录且可写平台）、导出 m3u/csv、删除（两步确认），无歌曲时同步/导出项禁用，同步中或待确认时同步项禁用
- 添加歌曲搜索：`page` 参数贯通适配器和 IPC，四平台分页映射（酷狗 page/pagesize、QQ page 单页 20、网易云 offset=(page-1)*limit、Apple catalog offset）；渲染层单页 20 条，`LoadMoreSentinel` 提前 200px 预取；按钮三态（添加 / 添加中 / 已添加禁用）；面板失焦收起；`SongSearchResults` 在平台歌单与本地歌单两处复用；歌单卡片歌曲数增删后就地 ±1
- 异常与加载：所有异常统一走 `renderer/src/utils/notifyError.ts` 右上角 toast（平台中文文案作详情、代码性报错过滤为通用标题），无组件内联错误条；歌单列表/歌曲拉取 30s 超时；超 3s 文案切「网络较慢，正在获取中…」并保持转圈，loading 区域居中
- 数据库：正式版 `userData/app.db`、开发版 `userData/dev/app.db`（由 `src/main/appPaths.ts` 在 ready 前隔离，`PLAYLIST_USER_DATA_DIR` 可覆盖；WAL），十二张表——`sync_tasks`（同步历史，逐首明细存 `detail`）、`app_settings`、`song_mappings`（人工确认优先）、`playlist_cache`、`playlist_song_cache`、`playlist_song_meta`、`playlist_cache_schema`（按 platform 隔离 scope）、`local_playlists`、`local_playlist_songs`、`local_playlist_sources`（本地歌单 ↔ 平台歌单多来源）、`encyclopedia_entity_mappings`（百科纠偏「名字 → 实体 id」映射，`(platform, kind, name)` 唯一）、`schema_migrations`。本地歌单扩展：`local_playlists` 存 `source_platform` / `source_playlist_id` / 链接 / `owner_id` / `extra_ids` JSON（酷狗 gcid 等）/ `cover_url` / `cover_source`；`local_playlist_songs` 存 `source_platform` / `source_song_id` / `identifiers` JSON（平台次级唯一 id）/ `cover_url`，另有 `(source_platform, source_playlist_id)` 与 `(playlist_id, source_platform, source_song_id)` 索引；`local_playlist_sources` 主键 `(playlist_id, platform, source_playlist_id)`，存链接/ownerId/extra_ids/cover_url/last_synced_at 并有 `(platform, source_playlist_id)` 唯一索引（一个平台歌单只归属一个本地歌单，一对多而非多对多）
- 迁移：`main/migrations.ts` 当前为发布前基线 `version=6` + v7（本地歌单来源/唯一标识列与索引）+ v8（封面列）+ v9（多来源关系表 + 存量回填）+ v10（平台歌单唯一归属约束与重复来源清理）+ v11（`sync_tasks.source_local_playlist_id`，本地歌单 → 平台同步的来源记录）+ v12（`encyclopedia_entity_mappings` 百科纠偏映射表）+ v13（`playlist_song_cache.identifiers` 列，百科歌词/发行时间定位；列补丁均包在 `tableExists` 检查内，全新库跳过由 Store 最新 DDL 建表）；`runMigrations` 在 `getDatabase()` 中先于所有 Store 建表；后续 `MIGRATIONS` 只追加（version ≥ 14）、不修改、不删除
- 缓存策略（`core/cachePolicy.ts` + `playlistCacheService` + `playlistCacheStore`）：列表 TTL 10min、歌曲 TTL 30min；手动强制刷新为令牌桶（容量 3、每 10s 补 1 令牌），令牌不足静默降级返回缓存，渲染层按钮同步冷却；单飞去重共享在途请求；重命名/删除/增删歌曲/同步建单后联动失效；`PLAYLIST_CACHE_SCHEMA_VERSION=7`（v5→v6 封面 URL 统一 https；v6→v7 歌曲缓存补 `identifiers` 次级标识列，百科歌词/发行时间定位需要），字段映射/过滤规则/缓存内容协议变更需 bump；歌曲缓存 `identifiers` 参与 diff（JSON 文本比较，旧缓存缺标识时判变化整单重写）。封面一律 https：平台适配器源头 `toHttps` 升级，渲染层 `utils/coverUrl.ts` 兜底（打包版 CSP `img-src` 只放行 https）
- 登录态内存缓存（`main/loginStatusCache.ts`）：`platform:login-status` 命中直接返回，首次查询写入；扫码登录成功/登出/保活失效时清除，网页登录先写 `pending` 临时态、后台补全后覆盖；渲染层初始化逐平台独立点亮，失败平台 3s 重试
- 数据层模式：`createXxxStore(db)` 依赖注入 + `appDatabase.getDatabase()` 统一入口 + `xxxService.ts` 供 IPC 调用
- 平台歌单导出到本地：右键「保存到本地歌单」弹出选择层，可新建或合并到已有本地歌单；IPC `local-playlist:import-platform` 经 `localPlaylistImportService` 复用适配器 `getPlaylistSongs` 全量拉取（30s 超时、上限 10000 首），`syncPlatformPlaylistToLocal` 按「平台 + 歌单 id」查来源关系：命中则按来源歌曲 id 增量更新/追加（不删除上游已移除的歌），未命中才建单；把 `PlatformSong.id` 与 `PlatformSong.identifiers` 一并落库；写入后广播 `local-playlist:changed`，本地歌单面板自动刷新。字段白名单校验在 `localPlaylistService`，未知 key 丢弃。关系为**本地 1 → 平台多**：同一平台歌单只归属一个本地歌单，重复登记改派；v10 唯一索引保证约束。反向（本地歌单 → 平台）同步建单成功后经 `registerLocalPlaylistSyncTarget` → `localPlaylists.linkSyncTarget` 登记关系（只写关系表，不改本地歌单的来源/封面列）并广播 `local-playlist:changed` 点亮平台 logo；来源本地歌单 id 随 `SyncTaskRecord.sourceLocalPlaylistId`（`sync_tasks` 列，迁移 v11）持久化，重启续写完成时同样登记
- 本地歌单封面：`cover_url` / `cover_source` 只接受 https（service 层校验），导入复制平台歌单/歌曲封面，手工歌单首次添加带封面歌曲后派生；存量导入歌单在读取时从 `playlistCache` 惰性回填：歌单封面在 `listLocalPlaylists` 按来源歌单 id，歌曲封面在 `getLocalPlaylistSongs` 按缓存顺序/来源歌曲 id，只填空行，不发网络请求。渲染统一 `CoverImage.tsx`（https 兜底、加载失败回退图标、URL 变化重置），平台歌单/歌曲/候选卡片/本地歌单共用
- 实体面板（原百科面板）：`SongList` 中歌名/歌手名/专辑名可点（hover 品牌绿下划线），点击弹出 `EncyclopediaPopover`（锚点定位 + 点外部/Esc 关闭，沿用 ContextMenu 模式）。歌名点击为「歌曲详情卡」：封面/时长/歌手/专辑/来源平台本地即时渲染，经 `song-detail:lookup` → 主进程 `songDetailService`（LRU + 单飞 + 令牌桶，失败静默返回 null）异步补充歌词（LRC 剥离时间戳、预览 6 行展开收起）、发行时间与「在平台打开」跳转；**歌手点击显示歌手歌曲清单、专辑点击显示发行时间与专辑曲目清单（已按需求移除百科正文与 Wikipedia 兜底）**。歌手/专辑点击走 `encyclopedia:lookup` → 主进程 `encyclopediaService` 编排「纠偏映射 → 搜索 → 消歧打分 → 详情」，支持网易云 + QQ + 酷狗（adapter 可选原语 `encyclopedia.search/detail`、`songDetail.detail`；QQ 歌手歌曲走 `/singer/songs?mid=`、专辑曲目走「专辑名搜索 + 精确过滤 + mid 去重」、歌词走 `/getLyric?songmid=`；网易云歌手歌曲走 `artists` 模块 `body.hotSongs`、专辑曲目走 `album` 模块 `body.songs`+`publishTime`、歌词走 `body.lrc.lyric`；酷狗 android 加密 + 设备指纹即可读（`KUGOU_API_MID` 是设备指纹非登录态，登录凭证经 `getCredential` 注入、有登录态传登录 cookie）：歌手歌曲走 `artist_audios`（`data` 直接数组、条目 `audio_name`/`author_name`/`timelength`）、专辑走 `album_detail`（`data[0].publish_date`）+`album_songs`（`data.songs`）、搜索走 `search type=author/album`（歌手条目大写驼峰 `AuthorId`/`AuthorName`/`Avatar`、专辑条目全小写 `albumid`/`albumname`/`singer`）——✅ 匿名设备指纹实测；歌词接口需歌词 id+accesskey 无来源故仅提供平台跳转；发行时间归一化在 `platforms/releaseDate.ts`）。同名消歧：`rankCandidates` 打分（精确全名 100 > 前缀 60 > 子串 40，opencc 简繁归一、别名双向、流派/热度弱信号），唯一精确命中直达、多候选面板内点选；用户点选写入 `encyclopedia_entity_mappings`（迁移 v12，`(platform, kind, name)` 唯一）并回写本地歌曲 `identifiers.singerIds`（`local-playlist:update-song-identifiers`，白名单校验）下次直达；「不对？换一个」经 `forceSearch` 重查候选。服务内 LRU（forceSearch 独立键）+ 单飞 + 按平台令牌桶（容量 10 / 500ms），全程失败静默降级空态。平台歌曲适配器补 `identifiers.singerIds`（网易 `ar[].id`、QQ `singer[].mid`）供 id 直达；本地歌单多来源歌曲按歌曲来源平台解析面板目标（`encyclopediaPlatformOf`）
- 唯一性标识调研结论见 `docs/platform-api-fields.md` 第 7 节：四平台歌单主键与次级 id 逐项列出来源，ISRC 国内平台均不提供故不预留；跨平台匹配仍以「标题 + 歌手归一化」为代理金标准，次级 id 用于同平台回写定位、版本/翻唱区分与候选排序，不把不同平台主 id 当作全局 id；凭证与 QQ 会话文件保持文件存储，不进 SQLite

### 3.5 桌面体验与设置
- 桌面能力：单实例锁与二次启动聚焦、窗口状态记忆（防抖 500ms 保存、跨显示器校验）、应用菜单（中英随语言重建）、开机启动真实设置、系统通知（仅窗口失焦、四类事件）、崩溃恢复对话框与重启、版本号显示、自动更新
- 自动更新：唯一源为 GitHub Releases（`electron-builder.yml` 的 `publish`），无备用源；状态广播 `checking/available/not-available/downloading/downloaded/error`；开发模式拒绝检查。全平台关闭 `autoDownload/autoInstallOnAppQuit`，`updater.ts` 检查命中后按平台下载安装包（dmg/exe/AppImage）、校验 sha512、打开或定位，由用户手动完成安装；不再有原生自动安装分支
- 快捷键：`main/menu.ts` 统一定义——导航 `CmdOrCtrl+1..5`（快速创建/歌单/同步/账号/设置），`CmdOrCtrl+N` 为隐藏别名；`before-input-event` 处理 `Cmd/Ctrl+,`（设置）与正式包吞掉 `Cmd/Ctrl+R`（含 Shift）/F5；View 菜单 Reload/DevTools 仅开发模式，`webPreferences.devTools: isDev`；不注册 globalShortcut
- 设置页：分区（外观/通用/网络/高级/数据/关于）+ 设置搜索（命中自动展开高级区）+ 主题三态 `light/dark/system`（默认深色；渲染层 `prefers-color-scheme` 联动，主进程同步 `nativeTheme.themeSource`）+ 阈值语义预设（宽松 0.45 / 平衡 0.6 / 严格 0.75）+ 重试/间隔滑块（350ms 防抖回写）+ 高级区默认折叠与「恢复默认」+ 开关失败回滚 + 代理「先测后用」（`main/proxy.ts testProxy` 独立 axios 请求 Cloudflare 204，测试通过且输入未改动才应用，未通过时 Apply 置灰、外层 span 悬浮 Tooltip、Enter 同样拦截）+ 清空歌曲缓存两步确认（`playlistCacheStore.clearAll` 物理删除）
- 调优参数单一事实源 `core/sync/tuning.ts`：`SYNC_TUNING_DEFAULTS`（threshold 0.6 / retries 2 / interval 500ms）、`SYNC_TUNING_RANGE`（0.4~0.9 / 0~5 / 300~3000ms）、`THRESHOLD_PRESETS`（0.45/0.6/0.75）；引擎、主进程、设置页三处同源引用
- i18n：自研轻量类型安全方案（`renderer/src/i18n/translations.ts`，en-US 以 `Record<TranslationKey, string>` 强制键一致）；语言偏好存 SQLite，非法值回退 zh-CN；同步失败/解析失败按稳定 reason 码翻译。首帧用 preload `settings:initial` 同步快照取语言/主题，缺键回退中文文案；避免异步恢复导致 key 或深色闪烁
- 视图切换：已访问视图保持挂载、`display:none` 隐藏，切回不重新挂载、不重复 IPC；歌单页 `visible` prop 在隐藏时暂停轮询；去掉 0.3s 整页入场动画。拉伸窗口原生底色与 CSS 表面色一致，长列表行改为悬浮时测量一次（不再每行常驻 `ResizeObserver`）
- 安全：渲染层 `sandbox: true`、`contextIsolation: true`，通信仅走 preload 白名单；打包环境由 `main/security.ts` 注入 CSP 与 nosniff；`core/logging/redact.ts` 递归脱敏
- 日志：主进程统一落 `userData/logs/`，按天分文件 `app-YYYY-MM-DD.log`；error 级别单独落 `error-YYYY-MM-DD.log`（app 文件排除 error，生产/开发均生效，`FileLogTransport` 的 `levels` 选项过滤，渲染进程日志经 IPC 校验后与主进程同落）。请求失败统一走 `core/logging/httpError.ts` 的 `logHttpError`：开发模式记录完整出入参（请求头/入参 body/出参 body，敏感字段沿用脱敏、正文超 8KB 截断），生产仅 method/url/status/durationMs 精简信息；覆盖四平台适配器与主进程 axios（安装包下载、代理连通性测试）

### 3.6 产品介绍页
- `site/` 为零依赖静态站点（HTML / CSS / JS + `assets/` 平台 logo 与真实截图），介绍产品定位、六项能力、三步流程、四平台矩阵、下载与常见问题；产品截图来自 v0.1.1 实际运行界面（`site/assets/screenshots/`，示例歌单为本地演示数据），不使用设计稿；favicon 与页头页脚品牌标记复用 `build/icon.svg` 的应用图标，不另设站点标识；页面下载入口固定指向 `releases/latest`，不随版本改动
- `/.github/workflows/pages.yml` 在 `main` 分支的 `site/**` 或工作流文件变更时上传站点并部署（也可 `workflow_dispatch` 手动触发）；权限仅 `contents: read` + `pages: write` + `id-token: write`；`eslint.config.mjs` 为 `site/**/*.js` 声明浏览器全局，站点脚本仍纳入 lint 门禁
- 发布地址 <https://b1tzer.github.io/playlist-syncwave/>；首次需在仓库 Settings → Pages → Build and deployment 将 Source 设为 GitHub Actions（此设置不在仓库文件内，需人工完成）

---

## 4. 发布前自动化检查（已执行，2026-11-27）

| 检查项 | 结果 |
|---|---|
| `npm run typecheck` | 通过（无错误） |
| `npm run lint` | 通过（无错误） |
| `npm run test` | 49 个测试文件、583 项测试全部通过（另 9 项真实网络验证，`LIVE_VERIFY=1 npx vitest run tests/live` 时运行） |
| `npm run build` | 通过（主进程 / preload / renderer 均产出） |

**代码事实核对**（文档与代码同步基准）：

| 项目 | 当前值 | 证据 |
|---|---|---|
| 应用版本 / 名称 | 0.2.0 / playlist-sync（产品名 SyncWave） | `package.json:2-3` |
| 平台 | 4：netease / qqmusic / kugou / applemusic | `src/platforms/*/index.ts` |
| SQLite 表 | 12（含 `schema_migrations`） | `src/main/*Store.ts`、`migrations.ts` |
| 迁移 | 基线 `version=6` + v7（唯一性字段）+ v8（封面列）+ v9（多来源表）+ v10（唯一归属约束）+ v11（sync_tasks 来源本地歌单 id）+ v12（百科纠偏映射表）+ v13（歌曲缓存 identifiers 列），启动先于 Store 建表 | `src/main/migrations.ts`、`appDatabase.ts:73-80` |
| 缓存 schema | `PLAYLIST_CACHE_SCHEMA_VERSION=7` | `src/core/cachePolicy.ts:12` |
| 缓存常量 | 列表 TTL 10min / 歌曲 TTL 30min / 令牌桶 3 个、10s 补 1 | `src/core/cachePolicy.ts:18-37` |
| 同步调优 | 默认 0.6 / 2 / 500ms；预设 0.45 / 0.6 / 0.75 | `src/core/sync/tuning.ts:17-40` |
| 更新源 | GitHub Releases（唯一源） | `electron-builder.yml:26-32`、`src/main/updater.ts:14-15` |
| 测试数 | 583（+9 项 live 真实网络验证，需 `LIVE_VERIFY=1`） | `npm run test` 输出 |

**构建**：本地未执行 `electron-builder` 打包；tag 推送后由发布工作流在 CI 完成三平台未签名构建、更新元数据生成与 draft release（见第 8 节，尚未执行）。

---

## 5. 发布前人工验收清单

> 已于 2026-11-25 由用户确认 v0.1.0/v0.1.1 验收全部完成（真实平台账号与安装包环境）；2026-11-26 补充 v0.1.2 更新安装改动（下载后手动安装）的全平台手动安装实测。自动化检查已覆盖的部分不再重复。

**账号登录**
- [x] 网易云扫码登录 → 拉取歌单列表与歌曲
- [x] QQ音乐三通道扫码登录（App / 微信 / 手机 QQ）→ 拉取歌单列表与歌曲
- [x] 酷狗扫码登录与保活；删除 `kugou-device.json` 后登录失效行为符合预期
- [x] Apple Music 网页登录：cookie 到手立即显示临时登录态，后台补全昵称/邮箱后自动刷新；无效登录回退未连接；日志无邮箱与 token
- [x] 渲染层刷新后各平台登录态逐平台快速点亮，失败平台 3s 重试

**文本创建与解析**
- [x] 混排两种顺序、分享文本、m3u/csv/lrc/json 粘贴均能自动识别并解析正确
- [x] TAG 编辑：多行粘贴、回车/退格、点标签编辑、Esc 取消、删除；忽略行可见可恢复
- [x] 重复歌曲灰调标记与创建去重；歌单名留空时「日期 + 风格」自动命名
- [x] 含 Live/Remix 版本差异与翻唱文本的候选确认与同版本优先

**同步与任务中心**
- [x] 真平台端到端同步：搜索匹配 → 建单 → 加歌；同名不同作者进入选择面板并确认写入
- [x] 大歌单并发同步不触发 405 风控；限流冷却后自动恢复
- [x] 运行中任务「停止 / 跳过当前歌曲」生效；重启后明细与 stopped 状态保持
- [x] 同步中心状态多选筛选、空态与重置、来源 → 目标平台 logo 展示
- [x] 匹配率抽样 ≥ 90%（PRD 验收项）
- [x] 1000 首歌曲同步无崩溃且有完整日志（PRD 验收项）

**歌单与列表**
- [x] 平台歌单与本地歌单的重命名、删除（两步确认）、增删歌曲
- [x] 添加歌曲搜索分页（提前 200px 预取）、三态按钮、失焦收起；歌单卡片歌曲数即时同步
- [x] 酷狗/网易云仅显示自有歌单；固定表头列宽对齐、缺失列同步隐藏
- [x] 拖拽框选、多选右键「同步到」、右键菜单键盘导航 / 边缘翻转 / 滚动关闭 / 浅色主题阴影
- [x] 文件导入（m3u/csv/txt/lrc/json）与导出（m3u/csv）
- [ ] v0.2 新增：四平台歌单右键「保存到本地歌单」均成功，歌曲顺序/数量与平台一致，本地歌单面板自动刷新
- [ ] v0.2 新增：导出后本地歌单保留来源平台 id 与次级唯一标识（网易云 albumId/原曲 id、QQ mid、酷狗 fileid/mixsongid/album_id、Apple librarySongId），日志无原始凭证
- [ ] v0.2 新增：导入的本地歌单显示平台封面；手工歌单首次添加带封面歌曲后显示派生封面；封面不可达时回退占位图标
- [ ] v0.2 新增：同一平台歌单多次保存到本地不会重复建单，第二次仅提示新增/更新数量且歌曲不重复；合并到已有歌单后本地列表显示两个平台 logo
- [ ] v0.2 新增：本地歌单右键菜单的重命名、同步到、导出 m3u/csv、删除均作用于右键目标歌单（非当前选中项），无歌曲时同步/导出禁用
- [ ] v0.2 新增：平台歌单与本地歌单的歌曲列表均可用鼠标点选/Shift 连选/拖拽多选/全选并一次批量删除，Apple Music 无删除端点时批量按钮置灰并提示原因；删除后剩余歌曲序号与歌单歌曲数正确

**设置与缓存**
- [x] 主题三态（浅色 / 深色 / 跟随系统）随系统切换，重启后保持；原生菜单与界面一致
- [x] 设置搜索命中展开高级区；阈值预设与滑块防抖回写；开关失败回滚
- [x] 代理「先测后用」：未测通过时 Apply 禁用 + 悬浮 Tooltip、Enter 拦截、测试通过后应用
- [x] 清空歌曲缓存两步确认后列表重新拉取；缓存 TTL 与令牌桶冷却行为符合预期
- [x] 异常统一右上角 toast，不暴露状态码/堆栈等代码性报错；慢加载提示与超时提示正确

**桌面与打包**
- [x] 快捷键 `Cmd/Ctrl+1..5`、`Cmd/Ctrl+N`、`Cmd/Ctrl+,`；开发包刷新与 DevTools 可用，正式包不可用
- [x] 单实例、窗口状态记忆、开机启动、系统通知、崩溃恢复、自动更新（GitHub Releases）
- [x] v0.1.2 更新安装全平台实测（2026-11-26）：检查到新版本后按平台下载 dmg/exe/AppImage、sha512 校验、存入「下载」并打开或定位，「重新打开安装包」按钮与通知文案正确
- [x] macOS dmg/zip 与 Windows nsis 安装包产出、安装与首次启动
- [x] 未签名安装包在 macOS（右键打开）与 Windows（仍要运行）的放行路径可完成安装与首次启动

---

## 6. 决策记录（ADR，当前状态）

| 编号 | 决策 | 当前状态 |
|---|---|---|
| ADR-001 | 桌面壳选 Electron 而非 Tauri v2 | 已采用；core 层保持平台无关 |
| ADR-002 | core 层纯 TS、不依赖 Electron | 已采用 |
| ADR-003 | 凭证用 Electron `safeStorage` 加密落盘 | 已采用（keytar 未引入） |
| ADR-004 | 先做文本解析，再接平台同步 | 已完成 |
| ADR-005 | 字段顺序不使用本地词典，由平台搜索验证裁决 | 已采用；强结构信号 + 投票仅决定预览默认顺序 |
| ADR-006 | 发布前迁移压缩为单一基线 `version=6` | 已采用；正式发布后仅追加（现有 v7~v13，后续 ≥14），每条迁移须幂等且对全新库安全 |
| ADR-007 | 缓存手动刷新限流用令牌桶替代固定间隔 | 已采用（3 个令牌 / 10s 补充） |
| ADR-008 | 自动更新只用 GitHub Releases，不设备用源 | 已采用（Gitee 单文件 100MB 配额无法托管安装包） |
| ADR-009 | 发布由 `v*` tag 触发，先产出 draft release 人工复核再转正式 | 已采用；回滚必须发更高版本 |
| ADR-010 | 不购买代码签名/公证证书，发布未签名包，用户按平台指引放行 | 已决定；工作流不校验也不提示签名凭据 |

---

## 7. 风险与边界

| 风险 | 缓解 |
|---|---|
| 平台 API 变更 / 风控 | 适配器接口解耦；全局限速 + 限流冷却 + 指数退避；文件导入作为降级通道 |
| native 模块 rebuild 失败 | 安装后 `npx electron-builder install-app-deps`；npm 11 需先 `npm install-scripts approve <pkg>` |
| AI 生成代码引入安全漏洞 | ESLint + typecheck 作为提交门禁；凭证/输入校验集中处理并人工审查 |
| 文档与代码腐烂 | `CLAUDE.md` 文档同步清单逐项核对；易腐化数字（平台数/表数/常量/测试数/工具链版本）改完即核对 |
| 测试自证 | 验收用例由人（或独立测试 agent）先写，实现 agent 不得修改测试文件 |
| 未签名包安装门槛 | macOS 右键打开、Windows「仍要运行」；在 `README.md` 与发布说明中给出指引，不购买签名/公证证书 |
| 坏版本无法降级 | 只发 draft 供人工复核后再转正式；回滚必须发更高版本（electron-updater 不降级） |

---

## 8. 发布流程（当前）

- **触发**：`git tag v<version>` 推送后触发 `.github/workflows/release.yml`；`workflow_dispatch` 仅做构建预演（不发布）
- **校验**：tag 必须与 `package.json` 的 `version` 一致；不校验签名凭据（本项目不购买签名/公证证书，构建不提示）
- **构建**：mac（dmg/zip）、win（nsis）、linux（AppImage）三平台独立 job，均执行 lint/typecheck/test/build 后 `electron-builder --<target> --publish never`（`CSC_IDENTITY_AUTO_DISCOVERY: 'false'`），上传安装包与 `latest*.yml` 到 Artifacts
- **draft release**：汇总 Artifacts、校验 `latest.yml`/`latest-mac.yml`/`latest-linux.yml` 三份更新元数据齐全，创建 GitHub draft release；release notes 从 `CHANGELOG.md` 对应版本章节自动提取（前缀未签名安装提示；不用 `--generate-notes`，本项目直推 main 无 PR 元数据会生成空文本）；人工复核安装包与元数据后转正式
- **更新源**：仅 GitHub Releases（`electron-builder.yml` 的 `publish`），未配置备用源（Gitee 单文件 100MB 配额无法托管安装包）；客户端按 `v<version>/<asset>` 固定地址下载对应平台安装包，不调用 GitHub API `/releases/latest`（未认证限流 60 次/小时）
- **用户安装**：未签名包在 macOS 需右键打开，在 Windows 需选择「仍要运行」（见 `README.md`「发布流程」）
- **版本记录**：`CHANGELOG.md` 随版本更新；回滚只发更高版本，不重发同版本
- **工具链边界**：当前 electron-builder 26.18.0 不强制更新清单签名；升级到 27 时发布构建需 `electron-builder create-update-key` 生成的 Ed25519 key（`ELECTRON_BUILDER_UPDATE_SIGN_KEY`），不在发布窗口升级
