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
1. 非平凡任务先更新 `planning.md` 的验收标准，再动手。
2. 一次只实现一个任务项，做完跑 typecheck + test。
3. 逻辑提交，提交前看 diff；push 由人确认，agent 不得自动 push。
4. 上下文接近上限时，把进展写回 `planning.md` 或 `execution-log.md`，再开新会话。
5. 任务完成后按下方「文档同步清单」更新对应文档——文档与代码同步是任务的完成标准之一，与测试全绿同等权重。

## 文档同步清单（每次改动后必须逐项核对）
项目文本资料是代码的契约，出现不一致即视为任务未完成。改动类型 → 必须更新的文档：

| 改动类型 | CLAUDE.md | planning.md | README.md | docs/platform-api-fields.md |
|---|---|---|---|---|
| 新增/删除平台接入 | ✅ 当前阶段 + 平台集成段 | ✅ 追加任务/补记条目 | ✅ 平台表 + 技术栈 | ✅ 平台接口章节 |
| 数据库表结构变更 | ✅ 表清单 | ✅ 对应任务条目 | — | — |
| 缓存/限流策略变更 | ✅ 对应条目（如缓存策略） | ✅ 补记演进 | — | — |
| 上游接口字段映射变更 | ✅ 平台规则（如有） | ✅ 任务条目 | — | ✅ 对应接口字段表 |
| 依赖增删/工具链升级 | ✅ 工具链/依赖描述 | ✅ 技术选型表 | ✅ 技术栈 | — |
| 用户可见行为/能力变更 | ✅ 当前阶段 | ✅ 任务条目 | ✅ 功能特性/说明 | — |
| 安全/凭证存储方案变更 | ✅ 不可违反约束 | ✅ 设计约束 + ADR | ✅ 安全设计 | — |

要点：
- `planning.md` 是演进日志：完成后在任务条目里写「实际结果」，不许改历史条目的原计划与验收标准（除标注需求演进外）；若历史决策被推翻（如 keytar→safeStorage、迁移 v1→v6 基线），在新条目记变更，并给旧条目/ADR 加「⚠️ 已变更，见 XX」注记，不删除旧记录。
- `docs/platform-api-fields.md` 是上游接口契约：字段表须标注来源（✅ 实测抓取 / 📐 SDK·NCM·适配器源码），未实测不得冒充实测。
- 版本号表、测试数等易腐化数字，改完顺手核对一次（如 CLAUDE.md 工具链版本、表数量、缓存常量）。

## 代码风格
- TypeScript strict，禁止 `any`（用 `unknown` + 类型守卫）。
- 用户可见 UI 文案必须走 i18n（`renderer/src/i18n/translations.ts` 同时补 zh-CN/en-US），禁止在组件里硬编码；日志/注释用简体中文；变量/函数/文件用英文。
- 不写解释性注释；只在「为什么」不直观处写一行。
- 依赖版本以 package.json 为准，不臆造不存在的包名或版本。

## 当前阶段
- V0.1 MVP。已完成：`PRD.md`、`planning.md`、工程骨架、T2 文本解析器、T3 匹配引擎 + 网易云适配器、T4 单向同步引擎 + 最小可用 UI、T5 QQ音乐接入、T6 全自动解析、T7 歌单管理、T8 匹配增强、T9 同步中心、T10 列表模板、T11 歌单页增强、T12 歌单缓存，基础能力补齐 B1-B16（打包分发/单实例/窗口状态/应用菜单/开机启动/自动更新/系统通知/本地歌单库/文件导入/歌单导出/同步参数设置/代理/CSP+沙箱/迁移框架/浅色主题/崩溃恢复），以及酷狗音乐与 Apple Music 平台接入（详见 planning.md 补记条目）。共接入四个平台：网易云、QQ音乐、酷狗、Apple Music。
- 已验收：网易云扫码登录；已修复：搜索风控（限速+重试）、EPIPE 崩溃、启动失败；已完成：同步匹配阶段并发化（并发池 + 双关键词并行 + 任务内关键词缓存 + 限流全局冷却 + 搜索超时收紧 15s）。
- 待验收：网易云端到端同步、QQ音乐扫码登录与同步、酷狗音乐扫码登录与同步、Apple Music 网页登录与同步、基础能力 B1-B16 手工验收。
- 已验证的工具链版本：TypeScript 6.0.3（TS7 与 typescript-eslint 冲突）、Vite 8、Vitest 5、Electron 45。
- 平台集成：网易云用 `NeteaseCloudMusicApi`（CJS + createRequire）；QQ音乐用 `@yakult-green-tea/qq-music-api` 的 **Node 模式**（主进程加载包根模块启动内置 Koa 服务，含 MQTT，监听动态空闲端口；主进程 handler 转发到 127.0.0.1:端口）。QQ音乐 serverless 模式不支持 qqmusic 通道（需 MQTT），勿回退。酷狗用 `kugoumusicapi`（github 依赖）的**库模式**（createRequire 直调扁平函数，不启动 HTTP 服务），token 与设备指纹绑定，指纹持久化到 `userData/kugou-device.json`。Apple Music 走**社区路径**（网页前端 developer token `iss=AMPWebPlay` + 登录 cookie 的 media-user-token），读接口走官方主机 `api.music.apple.com`，写接口必须走 `amp-api.music.apple.com`（删除在官方主机固定 401）。
- 平台架构：插件化平台模块。每个平台在 `src/platforms/<id>/index.ts` 中 default 导出 `PlatformModule`（meta：名称/图标/能力/登录渠道 + `createAdapter` 工厂，平台代码不直接依赖 electron，依赖经 `AdapterContext` 注入），由 `src/platforms/index.ts` 的 `import.meta.glob` 自动收集，主进程 `platformRegistry` 统一注册与预热。新增平台只需新建目录实现适配器（可继承 `BasePlatformAdapter` 只实现所需能力），无需修改任何历史代码；渲染层平台列表/图标/渠道/目标平台均从 `platform:list` 返回的 `PlatformMeta` 动态渲染。
- ESM 下不要用 `const require = createRequire()` —— 与 electron-vite 注入的 require 冲突；用内联 `createRequire(import.meta.url)(...)`。
- QQ音乐 Node 模式的 `/login/qr/*`（key/create/check）路由是 **GET**，不是 POST（serverless 模式可以 POST，Node 模式会 405）。
- 主进程必须吞掉 stdout/stderr 的 EPIPE（NCM logger 写 console 会触发崩溃）。
- better-sqlite3@13.2.0 已引入（统一应用数据库）。安装后需 `npx electron-builder install-app-deps` rebuild 到 Electron ABI（已验证 Node 与 Electron 双环境可用）。数据库文件在 `userData/app.db`（WAL 模式），含十张表：`sync_tasks`（同步历史）、`app_settings`（应用设置 key-value）、`song_mappings`（跨平台歌曲映射缓存，人工确认优先）、`playlist_cache`（歌单列表缓存）、`playlist_song_cache`（歌单歌曲缓存）、`playlist_song_meta`（每单歌曲缓存时间戳）、`playlist_cache_schema`（缓存 schema 版本表，按 platform 隔离 scope）、`local_playlists`/`local_playlist_songs`（本地歌单库）、`schema_migrations`（版本化迁移，只追加 `main/migrations.ts` 的 MIGRATIONS 数组，启动时迁移先于 store 初始化）。
- 歌单缓存策略（T12，`core/cachePolicy.ts` 常量 + `playlistCacheService` 单飞去重/限流 + `playlistCacheStore` 存储）：列表 TTL 10min、歌曲 TTL 30min；手动强制刷新限流用**令牌桶**（容量 3、每 10s 补 1 令牌，`REFRESH_BUCKET_*` 常量），令牌不足时静默降级返回缓存；渲染层手动刷新按钮同步冷却；重命名/删除/增删歌曲/同步建单后主进程联动失效对应缓存。平台字段映射调整需 bump `PLAYLIST_CACHE_SCHEMA_VERSION`（现为 4）。
- 凭证与 QQ 会话文件（credentials.json / qq-session*.json / qq-device.json）保持文件存储，不进 SQLite（凭证安全隔离）。
- 数据层模式：`createXxxStore(db)` 依赖注入 + `appDatabase.getDatabase()` 统一入口 + `xxxService.ts` 供 IPC 调用。
- npm 11 默认拦截安装脚本（如 electron 二进制），需 `npm install-scripts approve <pkg>` 后再 rebuild。
- 酷狗平台规则：歌单列表仅显示自建/系统歌单，收藏的他人歌单不显示。判定用 v7/get_all_list 条目的 `type` 字段（实测 0=自建/系统收藏夹——默认收藏 `is_def=1`、我喜欢 `is_def=2`，1=收藏他人歌单；`is_mine` 恒为 0 不可用）。过滤只作用于显示列表（`fetchPlaylists`），写操作索引 `playlistIndex` 保留完整；过滤规则变更需 bump `PLAYLIST_CACHE_SCHEMA_VERSION` 使旧缓存重新验证。
- 网易云 API 风控敏感：搜索请求需限速（>=500ms）并支持重试；连续快速请求会触发 405 风控。同步匹配阶段为受控并发池（`searchConcurrency` 默认 3）：`searchIntervalMs` 语义为**全局相邻两次搜索请求的最小间隔**（原「每首间隔」收敛为全局限速，预约式限速器）；同一首歌「歌名+歌手」与「纯歌名」并行预取（预算内）；任务内关键词缓存（normalize(keyword)，含在途 promise 去重，失败不缓存）；任一请求被风控（rateLimited）触发全局冷却 4s 暂停后续发起；搜索请求超时 15s（建单/加歌 60s）。
- QQ音乐 sealed token 依赖 `QQ_SESSION_SECRET`，该密钥已持久化到 userData，删除会导致全部登录失效。
- 文本快速创建全自动解析（T6）：格式自动探测（json/m3u/lrc/csv/share/lines）→ 行分类去噪 → 字段顺序仅用强结构信号判定（书名号/版本词/多人名/feat/长度，**无本地词典**）+ 整段投票（`core/parser/orderInfer.ts`）→ 无信号行保留双候选，**顺序最终由平台搜索验证裁决**（`exactMatch.classifyCandidates` 反向精确匹配 + `planSync` alternatives 备选搜索）；`ParseOptions.order` 仅高级覆盖，UI 无手动格式选择。
- 同步金标准（T6.4）：标题+歌手归一化精确相等 = 自动选（`core/matcher/exactMatch.ts`）；同歌不同作者（标题精确、歌手不同）→ `choice-needed` 两阶段（planSync/executeSync + `pendingSyncs` 缓存 + `platform:confirm-sync`），用户手动选择。行业真金标准 ISRC 国内平台不暴露，故用代理金标准。
- 基础能力要点：渲染层 `sandbox: true`，preload 必须是 **CJS**（electron-vite preload 已配置 `format: 'cjs'` 输出 `out/preload/index.js`，主进程加载 `../preload/index.js`，勿改回 .mjs）；打包环境 CSP 由 `main/security.ts` 注入响应头；`electron-updater` 等 CJS 包在主进程 ESM 下需内联 `createRequire(import.meta.url)(...)` 加载（named import 运行时失败）；打包用 `npm run dist`（electron-builder.yml，发布前配置 CSC 证书与 SYNCWAVE_UPDATE_URL）。
