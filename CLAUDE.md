# 项目规则（AI 与人类共同遵守）

## 命令
- `npm run dev` — 启动 Electron 开发模式
- `npm run test` — 运行 Vitest 单元测试
- `npm run typecheck` — TypeScript 全量类型检查
- `npm run build` — 生产构建
- `npm run lint` — ESLint 检查

## 不可违反的约束
- `src/core/` 是平台无关的纯业务逻辑：禁止 import `electron`、`node:*`、任何平台 SDK。必须能被 Vitest 独立测试。
- 平台差异全部收敛在 `src/platforms/`；core 只依赖 `PlatformAdapter` 接口。
- 凭证只经主进程读写，渲染进程永不接触原始凭证。MVP 用 Electron `safeStorage` 加密，不明文落盘。
- 主进程与渲染进程通信只走 `preload` 的 contextBridge 白名单；`nodeIntegration: false`、`contextIsolation: true`。
- 凭证、密钥、token 不得出现在日志、测试快照或 git 提交中。

## 测试约定
- 验收用例先于实现编写；实现不得修改 `tests/` 下已有测试来「过测」。
- 测试断言公开契约（输入→输出），不锁定内部实现细节。
- 每个 core 模块改动后必须 `npm run test` 全绿、`npm run typecheck` 通过。

## 工作节奏（SDD）
1. 非平凡任务先更新 `planning.md` 的当前状态/验收条目，再动手。
2. 一次只实现一个任务项，做完跑 typecheck + test。
3. 逻辑提交，提交前看 diff；push 由人确认，agent 不得自动 push。
4. 上下文接近上限时，把进展写回 `planning.md`，再开新会话。
5. 任务完成后按下方「文档同步清单」更新对应文档——文档与代码同步是任务的完成标准之一，与测试全绿同等权重。

## 文档同步清单（每次改动后必须逐项核对）
项目文本资料是代码的契约，出现不一致即视为任务未完成。改动类型 → 必须更新的文档：

| 改动类型 | CLAUDE.md | planning.md | README.md | docs/platform-api-fields.md |
|---|---|---|---|---|
| 新增/删除平台接入 | ✅ 当前状态 + 平台集成段 | ✅ 当前状态对应条目 | ✅ 平台表 + 技术栈 | ✅ 平台接口章节 |
| 数据库表结构变更 | ✅ 表清单 | ✅ 当前状态对应条目 | — | — |
| 缓存/限流策略变更 | ✅ 对应条目（如缓存策略） | ✅ 当前状态对应条目 | — | — |
| 上游接口字段映射变更 | ✅ 平台规则（如有） | ✅ 当前状态对应条目 | — | ✅ 对应接口字段表 |
| 依赖增删/工具链升级 | ✅ 工具链版本 | ✅ 技术选型 | ✅ 技术栈 | — |
| 用户可见行为/能力变更 | ✅ 当前状态 | ✅ 当前状态对应条目 | ✅ 功能特性/说明 | — |
| 安全/凭证存储方案变更 | ✅ 不可违反约束 | ✅ 设计约束 + ADR | ✅ 安全设计 | — |

要点：
- `planning.md` 以**当前状态**为准：只描述现行技术约定、已交付能力与发布前人工验收清单；过程叙事（原计划/已变更/修复迭代/历史测试数）不进正文，需要追溯时查 git 历史。
- `docs/platform-api-fields.md` 是上游接口契约：字段表须标注来源（✅ 实测抓取 / 📐 SDK·NCM·适配器源码），未实测不得冒充实测。
- 版本号表、测试数等易腐化数字，改完顺手核对一次。当前基线：四平台、十张 SQLite 表（含 `schema_migrations`）、迁移基线 v6、缓存 schema v5、383 项测试、TypeScript 6.0.3 / Vite 8 / Vitest 5 / Electron 45。
- 发布前自动化门禁：`npm run typecheck && npm run lint && npm run test && npm run build` 全绿；人工验收清单见 `planning.md` 第 5 节（2026-11-25 已完成）。
- 发布相关变更（版本、流程、更新源）同步更新 `CHANGELOG.md`，并在 `README.md`「发布流程」与 `planning.md` 第 8 节保持一致。

## 代码风格
- TypeScript strict，禁止 `any`（用 `unknown` + 类型守卫）。
- 用户可见 UI 文案必须走 i18n（`renderer/src/i18n/translations.ts` 同时补 zh-CN/en-US），禁止在组件里硬编码；日志/注释用简体中文；变量/函数/文件用英文。
- 不写解释性注释；只在「为什么」不直观处写一行。
- 依赖版本以 package.json 为准，不臆造不存在的包名或版本。

## 当前状态
- V0.1（MVP，package.json version 0.1.0）。已交付：文本快速创建、匹配与单向同步、歌单管理（含本地歌单库）、歌单缓存、同步中心、设置中心与桌面基础能力。接入四平台：网易云、QQ音乐、酷狗、Apple Music。
- 当前行为：网易云扫码登录可用；搜索限速 + 指数退避重试；主进程吞掉 EPIPE；npm 11 安装脚本需 `npm install-scripts approve <pkg>` 放行。异常提示统一走右上角 toast（`renderer/src/utils/notifyError.ts`），代码性报错过滤为通用标题；主进程歌单拉取（列表/歌曲）带 30s 超时；慢加载超 3s 文案切为「网络较慢，正在获取中…」并保持转圈。
- 同步匹配：受控并发池（`searchConcurrency` 默认 3）+ 双关键词并行预取 + 任务内关键词缓存（normalize key，含在途去重）+ 全局相邻搜索最小间隔（`searchIntervalMs`，预约式限速器）+ rateLimited 全局冷却 4s + 搜索超时 15s（建单/加歌 60s）；同歌不同作者走 choice-needed 两阶段确认；运行中任务可停止/跳过当前歌，逐首明细持久化。
- 歌单添加歌曲搜索：`page` 参数贯通 IPC/适配器，单页 20 条 + 哨兵提前 200px 预取，`SongSearchResults` 两处复用；歌单卡片歌曲数增删后就地同步。同步中心任务卡片展示「来源 → 目标平台」及品牌 logo、状态徽标置于时间前、状态多选筛选（空集合＝全部）；歌曲列表带「# / 歌名 / 歌手 / 专辑 / 时长」固定表头。
- 发布流程：`git tag v<version>` 触发 `.github/workflows/release.yml`（校验版本 → 三平台未签名构建 → draft release → 人工转正式）；不购买签名/公证证书，构建不校验也不提示签名凭据；回滚必须发更高版本。详见 `README.md`「发布流程」与 `planning.md` 第 8 节。
- Apple Music 账号展示：官方 API 无用户资料接口，登录态 `userId` 为 storefront 地区码；网页登录 cookie 到手即落最小凭证（`developerToken` 为空、首次请求自动补齐）并广播 `pending: true` 临时登录态，界面立即显示已登录；凭证校验、页面昵称、账户页 Apple ID 邮箱在隐藏窗口后台串行补全，完成后 `accounts:changed` 广播刷新为正式账号（UI 显示「账号: 邮箱」，否则「UID: 地区码」）。邮箱属敏感 PII，日志不记录，仅加密凭证文件保存。
- 工具链版本（与 package.json 一致）：TypeScript 6.0.3（TS7 与 typescript-eslint 冲突）、Vite 8、Vitest 5、Electron 45。
- 平台集成：网易云用 `NeteaseCloudMusicApi`（CJS + createRequire）；QQ音乐用 `@yakult-green-tea/qq-music-api` 的 **Node 模式**（主进程加载包根模块启动内置 Koa 服务，含 MQTT，监听动态空闲端口；主进程 handler 转发到 127.0.0.1:端口），serverless 模式不支持 qqmusic 通道（需 MQTT），勿回退。酷狗用 `kugoumusicapi`（github 依赖）的**库模式**（createRequire 直调扁平函数，不启动 HTTP 服务），token 与设备指纹绑定，指纹持久化到 `userData/kugou-device.json`。Apple Music 走**社区路径**（网页前端 developer token `iss=AMPWebPlay` + 登录 cookie 的 media-user-token），读接口走官方主机 `api.music.apple.com`，写接口必须走 `amp-api.music.apple.com`（删除在官方主机固定 401）。网页登录的 `profileSelector` 从账号菜单 DOM 抓展示用昵称（✅ Playwright 登录态实测，非账号 ID），`accountProbe` 再跳账户设置页读 iframe 里的 Apple ID 邮箱，两者抓不到都照常登录。
- 平台架构：插件化平台模块。每个平台在 `src/platforms/<id>/index.ts` 中 default 导出 `PlatformModule`（meta：名称/图标/能力/登录渠道 + `createAdapter` 工厂，平台代码不直接依赖 electron，依赖经 `AdapterContext` 注入），由 `src/platforms/index.ts` 的 `import.meta.glob` 自动收集，主进程 `platformRegistry` 统一注册与预热。新增平台只需新建目录实现适配器（可继承 `BasePlatformAdapter` 只实现所需能力），无需修改任何历史代码；渲染层平台列表/图标/渠道/目标平台均从 `platform:list` 返回的 `PlatformMeta` 动态渲染。
- ESM 下不要用 `const require = createRequire()` —— 与 electron-vite 注入的 require 冲突；用内联 `createRequire(import.meta.url)(...)`。
- QQ音乐 Node 模式的 `/login/qr/*`（key/create/check）路由是 **GET**，不是 POST（serverless 模式可以 POST，Node 模式会 405）。
- 主进程必须吞掉 stdout/stderr 的 EPIPE（NCM logger 写 console 会触发崩溃）。
- 统一应用数据库为 better-sqlite3@13.2.0（`userData/app.db`，WAL 模式），含十张表：`sync_tasks`（同步历史，逐首明细存 `detail`）、`app_settings`（应用设置 key-value）、`song_mappings`（跨平台歌曲映射缓存，人工确认优先）、`playlist_cache`（歌单列表缓存）、`playlist_song_cache`（歌单歌曲缓存）、`playlist_song_meta`（每单歌曲缓存时间戳）、`playlist_cache_schema`（缓存 schema 版本表，按 platform 隔离 scope）、`local_playlists`/`local_playlist_songs`（本地歌单库）、`schema_migrations`（版本化迁移记录）。唯一迁移为发布前基线 `version=6`（幂等），启动时 `runMigrations` 先于各 Store 建表；正式发布后 `MIGRATIONS` 只追加（version ≥ 7）、不修改、不删除。
- 歌单缓存策略（`core/cachePolicy.ts` 常量 + `playlistCacheService` 单飞去重/限流 + `playlistCacheStore` 存储）：列表 TTL 10min、歌曲 TTL 30min；手动强制刷新限流用**令牌桶**（容量 3、每 10s 补 1 令牌，`REFRESH_BUCKET_*` 常量），令牌不足时静默降级返回缓存；渲染层手动刷新按钮同步冷却；重命名/删除/增删歌曲/同步建单后主进程联动失效对应缓存。`PLAYLIST_CACHE_SCHEMA_VERSION=5`，平台字段映射/过滤规则调整需 bump。
- 凭证与 QQ 会话文件（credentials.json / qq-session*.json / qq-device.json）保持文件存储，不进 SQLite（凭证安全隔离）。
- 登录态内存缓存（`main/loginStatusCache.ts`）：`platform:login-status` 命中缓存直接返回（渲染层 reload 后秒回，不重复网络查询），首次查询写入；扫码登录成功/登出/保活失效清除，网页登录 cookie 到手先写 `pending` 临时态、后台校验/资料补全后覆盖为正式账号。
- 数据层模式：`createXxxStore(db)` 依赖注入 + `appDatabase.getDatabase()` 统一入口 + `xxxService.ts` 供 IPC 调用。
- npm 11 默认拦截安装脚本（如 electron 二进制），需 `npm install-scripts approve <pkg>` 后再 rebuild。
- 酷狗平台规则：歌单列表仅显示自建/系统歌单，收藏的他人歌单不显示。判定用 v7/get_all_list 条目的 `type` 字段（实测 0=自建/系统收藏夹——默认收藏 `is_def=1`、我喜欢 `is_def=2`，1=收藏他人歌单；`is_mine` 恒为 0 不可用）。过滤只作用于显示列表（`fetchPlaylists`），写操作索引 `playlistIndex` 保留完整。酷狗搜索接口 `v2/search/song` 响应 `data.lists` 为**歌曲对象数组（flat）**，解析需兼容嵌套数组协议版本（见 `docs/platform-api-fields.md` 3.4）。
- 网易云平台规则：歌单列表仅显示自有歌单——过滤 `specialType=5`（「我喜欢的音乐」收藏夹）与 `subscribed=true`（收藏的他人歌单）；缺失字段视为自有。
- 网易云 API 风控敏感：连续快速请求会触发 405 风控，需限速并支持重试。同步匹配阶段为受控并发池（`searchConcurrency` 默认 3）：`searchIntervalMs` 语义为**全局相邻两次搜索请求的最小间隔**（预约式限速器）；同一首歌「歌名+歌手」与「纯歌名」并行预取（预算内）；任务内关键词缓存（normalize(keyword)，含在途 promise 去重，失败不缓存）；任一请求被风控（rateLimited）触发全局冷却 4s 暂停后续发起；搜索请求超时 15s（建单/加歌 60s）。
- QQ音乐 sealed token 依赖 `QQ_SESSION_SECRET`，该密钥已持久化到 userData，删除会导致全部登录失效。
- 文本快速创建全自动解析（T6）：格式自动探测（json/m3u/lrc/csv/share/lines）→ 行分类去噪 → 字段顺序仅用强结构信号判定（书名号/版本词/多人名/feat/长度，**无本地词典**）+ 整段投票（`core/parser/orderInfer.ts`）→ 无信号行保留双候选，**顺序最终由平台搜索验证裁决**（`exactMatch.classifyCandidates` 反向精确匹配 + `planSync` alternatives 备选搜索）；`ParseOptions.order` 仅高级覆盖，UI 无手动格式选择。
- 同步金标准（T6.4）：标题+歌手归一化精确相等 = 自动选（`core/matcher/exactMatch.ts`）；同歌不同作者（标题精确、歌手不同）→ `choice-needed` 两阶段（planSync/executeSync + `pendingSyncs` 缓存 + `platform:confirm-sync`），用户手动选择。行业真金标准 ISRC 国内平台不暴露，故用代理金标准。
- 基础能力要点：渲染层 `sandbox: true`，preload 必须是 **CJS**（electron-vite preload 已配置 `format: 'cjs'` 输出 `out/preload/index.js`，主进程加载 `../preload/index.js`，勿改回 .mjs）；打包环境 CSP 由 `main/security.ts` 注入响应头；`electron-updater` 等 CJS 包在主进程 ESM 下需内联 `createRequire(import.meta.url)(...)` 加载（named import 运行时失败）。打包用 `npm run dist`；正式发布由 `v*` tag 触发 `.github/workflows/release.yml`，不在本地执行 `--publish always`（详见 `README.md`「发布流程」）；更新源为 GitHub Releases（`electron-builder.yml` 的 `publish`），无备用源。
- 设置页：分区（外观/通用/网络/高级/数据/关于）+ 设置搜索（标题/描述过滤，命中自动展开高级区）+ 主题三态 `light/dark/system`（默认深色；渲染层经 `prefers-color-scheme` 媒体查询联动，主进程启动恢复与 `settings:set` 时同步 `nativeTheme.themeSource`，两侧同源保持一致）+ 匹配阈值语义预设（宽松 0.45/平衡 0.6/严格 0.75）。同步调优参数单一事实源 `core/sync/tuning.ts`（`SYNC_TUNING_DEFAULTS`/`SYNC_TUNING_RANGE`/`THRESHOLD_PRESETS`），引擎（syncPlaylist/matchSong）、主进程（settingsService.syncTuning）、设置页滑块/预设三处同源引用，禁止再散落 `?? 0.6` 类魔数。设置页交互约定：滑块防抖回写（350ms）、开关/主题切换失败回滚 + toast、代理「测试」走 `main/proxy.ts testProxy`（独立 axios 实例请求 Cloudflare 204 端点）、清空歌曲缓存走 `playlistCacheStore.clearAll`（物理删除，区别于 markStale 兜底）。代理交互为「先测后用」：仅连通性测试通过且输入未再改动时才真正应用；未通过时 Apply 置灰禁用、悬浮即时 Tooltip 显示「请先测试代理连接」（对齐歌单移除歌曲效果：disabled 不响应鼠标事件，悬浮事件挂外层 span；不用 not-allowed 光标），Enter 键同拦截并弹 warning 兜底。
- 快捷键：`main/menu.ts` 统一定义。导航 `CmdOrCtrl+1..5`（快速创建/歌单/同步/账号/设置），`CmdOrCtrl+N` 作为快速创建的隐藏别名；`Cmd/Ctrl+,` 由 `before-input-event` 打开设置（macOS 惯例）。Edit 菜单保留系统剪贴板快捷键；View 菜单的 Reload/Force Reload/DevTools 仅开发模式提供，正式包屏蔽 `Cmd/Ctrl+R`（含 Shift）与 F5，并设 `webPreferences.devTools: isDev`；不注册全局快捷键。
