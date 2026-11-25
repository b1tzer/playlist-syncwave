# 技术规划与实施计划

> 对应 `PRD.md` 的 V0.1（MVP）。本文是「先规划、后编码」的落地产物，随实施迭代更新，用 git 版本管理。

---

## 1. 技术选型决策

| 领域 | 选择 | 理由 | 备选/迁移路径 |
|---|---|---|---|
| 桌面框架 | **Electron** | ① 核心约束是 AI 能可靠生成与调试代码，TS 全栈最友好；② 国内平台非官方 API 参考实现多为 Node.js 生态，可复用；③ 签名与自动更新链路成熟 | Tauri v2：若 V1.0 对包体积/内存敏感再迁移；core 层平台无关设计降低迁移成本 |
| 语言 | **TypeScript（strict）** | 类型即契约，AI 生成代码错误可在编译期暴露 | — |
| UI | React 19 + Vite + Tailwind CSS | AI 最熟悉的组合，快速出可用界面 | — |
| 状态管理 | Zustand | 轻量、样板代码少 | — |
| 本地存储 | better-sqlite3 | 同步 API、性能足够（万级歌曲）、类型友好 | V0.1 若 native rebuild 受阻，临时退化为 JSON 文件 + zod 校验 |
| 凭证存储 | Electron `safeStorage`（⚠️ 原计划 keytar，实施时改为 safeStorage，见「架构变更」补记） | 满足 PRD「不明文落盘」硬性要求；无需额外 native 依赖 | keytar（系统钥匙串） |
| 单元测试 | Vitest | 与 Vite 同源、启动快、TS 原生支持 | — |
| E2E 测试 | Playwright（V0.5 引入） | 跨平台桌面 E2E 成本高，MVP 先用单元 + 手工验收 | — |
| 代码规范 | ESLint + Prettier | 让 agent 和人类遵守同一套约定 | — |
| 打包 | electron-builder | Windows NSIS + macOS dmg，成熟稳定 | — |

**关键取舍说明**：2026 年 Tauri v2 在体积（2-10MB vs 80-200MB）、内存、安全性上占优，但本项目 MVP 的首要风险不是体积，而是「AI 生成代码的可靠性」与「复用 Node 生态的平台 API 参考实现」。Electron 在这两点上胜出。core 层保持纯 TypeScript、不依赖 Electron API，为未来迁移留门。

---

## 2. 架构分层

```
src/
├── core/          # 平台无关的纯业务逻辑（可用 Vitest 独立测试）
│   ├── models/    # 领域类型：Song / Playlist / ParseResult
│   ├── parser/    # 文本快速创建：解析、去噪、字段归并
│   ├── matcher/   # 歌曲匹配引擎：归一化、模糊匹配、置信度
│   ├── sync/      # 同步引擎：差异计算、增量、重试
│   ├── export/    # 歌单导出（m3u/csv）
│   ├── logging/   # 日志（含递归脱敏）
│   └── cachePolicy.ts
├── platforms/     # 插件化平台适配器（import.meta.glob 自动收集，每个平台一个目录）
│   ├── base.ts    # PlatformAdapter 接口与模板方法（BasePlatformAdapter）
│   ├── meta.ts    # PlatformModule 元信息类型
│   ├── index.ts   # glob 收集器
│   ├── netease/   # 网易云音乐（NeteaseCloudMusicApi）
│   ├── qqmusic/   # QQ 音乐（qq-music-api Node 模式）
│   ├── kugou/     # 酷狗音乐（kugoumusicapi 库模式）
│   └── applemusic/# Apple Music（社区路径 Web API）
├── main/          # Electron 主进程：IPC、数据库、凭证、平台注册、日志
├── preload/       # 预加载脚本：安全的 contextBridge API（CJS 输出）
└── renderer/      # React UI（i18n 中英双语）
tests/             # Vitest 单元测试（core/main/platforms/renderer）
```

**设计约束**
- `core/` 禁止 import Electron、Node 内置模块或任何平台 SDK —— 保证可独立测试与可迁移
- 主进程与渲染进程通过 preload contextBridge 通信，`nodeIntegration: false`、`contextIsolation: true`
- 平台差异全部收敛在 `platforms/` 适配器内，core 只依赖 `PlatformAdapter` 接口
- 凭证只经主进程 safeStorage 加密读写，渲染进程永不接触原始凭证

---

## 3. 实施任务拆解（按 SDD 格式）

### T1 — 项目骨架与工程约定 ✅ 已完成
- **交付物**：package.json、tsconfig、Vite/Electron 配置、CLAUDE.md、.gitignore、目录结构
- **验收**：`npm install && npm run dev` 可启动空窗口；`npm run test` 可执行空测试集；`npm run typecheck` 通过
- **边界情况**：native 模块（better-sqlite3/keytar）rebuild 失败时需有明确报错与降级说明
- **验证命令**：`npm run typecheck && npm run test && npm run build`
- **实际结果**：全部通过。TypeScript 7 与 typescript-eslint 不兼容 → 降至 6.0.3；TS6 弃用 baseUrl 且路径别名需相对前缀 → 已修正。native 模块按既定策略延后到 T3。

### T2 — 文本快速创建歌单解析器（首个功能）✅ 已完成
- **交付物**：`core/models`、`core/parser`，含验收测试
- **验收**：
  - 支持 `歌名 - 歌手`、`歌手 - 歌名`、纯歌名、带序号、混排文本
  - 去噪：空行、时间戳、表情、序号、纯符号行
  - 输出 `ParseResult { songs, failedLines }`，含行号与原始文本
  - 单元测试覆盖 PRD FR-2.1 全部输入形式，通过率 100%
- **边界情况**：空输入、全噪声行、超长单行、重复行、繁简体、括号内 Live/Remix
- **验证命令**：`npm run test -- parser`
- **实际结果**：TDD 红→绿完成，11/11 测试通过；typecheck、lint、build 均通过。文件：`src/core/models/parse.ts`、`src/core/parser/parseText.ts`、`tests/core/parser/parseText.test.ts`。

### T3 — 匹配引擎 + 网易云平台适配器（读）✅ 编码完成（手工登录验收待用户执行）
- **交付物**：`core/matcher`、`platforms/base.ts`、`platforms/netease.ts`，账号授权与歌单读取
- **验收**：扫码登录后可拉取歌单列表与歌曲；文本解析结果匹配到平台歌曲，置信度评分可用
- **边界情况**：登录过期、API 变更、限流、歌曲下架
- **验证命令**：`npm run test -- matcher` + 手工登录验收
- **实际结果**：
  - 匹配引擎 `src/core/matcher/matchSong.ts`：归一化（小写/繁转简 opencc-js/全角转半角/去括号）+ 评分（标题精确 0.8 / 变体 0.7 / 部分 0.5，歌手精确 +0.15，时长 +0.02），TDD 13/13 通过。
  - `platforms/base.ts`：统一 `PlatformAdapter` 接口（二维码登录、账号状态、歌单列表、歌单歌曲、搜索）。
  - `platforms/netease.ts`：基于社区包 `NeteaseCloudMusicApi@4.34.1`（CJS，主进程 `createRequire` 加载），响应映射为领域模型，依赖注入设计使其可离线单测，7/7 通过。
  - 主进程：`credentialStore.ts`（safeStorage 加密落盘 + 内存缓存）、`neteaseService.ts`、IPC 白名单（create-qr/check-qr/login-status/logout/user-playlists/playlist-songs/search）。
  - preload 暴露 `window.electronAPI.netease.*`。
  - typecheck、lint、build、31 项测试全部通过。
- **待办**：用户执行 `npm run dev` 手工扫码登录验收（二维码登录 → 拉歌单列表 → 拉歌曲）。

### T4 — 单向同步引擎 + 最小可用 UI ✅ 编码完成（手工端到端验收待用户执行）
- **交付物**：`core/sync`、`renderer` 最小界面（文本输入 → 预览 → 选择目标 → 同步 → 结果）
- **验收**：端到端跑通「粘贴文本 → 创建歌单 → 同步到网易云」，有进度与结果报告
- **边界情况**：部分失败、重复歌曲、网络中断重试
- **验证命令**：`npm run test` + 手工端到端验收
- **实际结果**：
  - `core/sync/syncPlaylist.ts`：单向同步引擎（逐首搜索→匹配→建单→分批添加→报告），依赖注入 `SyncTarget`，9/9 测试通过。搜索词仅用歌名，歌手由匹配引擎二次校验。
  - `PlatformAdapter` 扩展 `createPlaylist` / `addSongsToPlaylist`；网易云适配器实现并补 4 项映射测试。
  - 主进程 IPC `netease:sync-playlist`（组装 SyncTarget 执行同步，进度经 `netease:sync-progress` 事件推送到渲染进程）。
  - UI：文本创建区新增「创建歌单并同步到网易云」按钮、歌单名输入、进度条、结果报告（成功数/失败明细）。
  - typecheck、lint、44 项测试、build 全部通过。
- **待办**：用户手工端到端验收（粘贴文本 → 同步 → 网易云 App 确认歌单）。

### 修复记录 — 搜索风控与歌单过滤 ✅
- **问题 1**：18 首全部「搜索失败」并创建了空歌单。诊断：网易云对带登录态的 `search` 请求返回 `405 操作频繁`（瞬时连发触发风控），且空匹配时仍创建空歌单。
- **修复**：
  - 同步引擎：搜索限速（默认 500ms/首 ⚠️ 已变更：并发化后为全局最小请求间隔，见「同步匹配阶段并发化」补记）+ 可重试错误指数退避重试（默认 2 次）+ 全部未匹配时不建单（失败明细保留）+ `rate-limited` 错误分类。
  - 网易云适配器：`searchSongs` 把 NCM 风格错误包装为 `SearchError`（405/5xx 可重试）；`getUserPlaylists` 过滤 `specialType=5`（我喜欢的音乐收藏夹）。
  - UI：区分「未建单」与「部分失败」文案；风控提示「稍等几分钟再试」。
  - 测试：同步引擎 9→14 项，适配器 11→13 项，共 51 项全绿。
- **问题 2**：主进程 `EPIPE` 崩溃（NeteaseCloudMusicApi 的 logger 写 console 时管道破裂）。修复：入口吞掉 stdout/stderr 的 EPIPE。
- **问题 3**：应用启动失败。修复：`package.json` 缺 `main` 字段；npm 11 默认拦截安装脚本导致 Electron 二进制未下载（`npm install-scripts approve electron`）。

---

### T5 — QQ音乐平台接入 ✅ 编码完成（手工验收待用户执行）
- **交付物**：`platforms/qqmusic.ts`、`platforms/httpHandler.ts`、多平台注册表与 IPC、多平台 UI
- **实现**：
  - 采用 `@yakult-green-tea/qq-music-api@3.3.8`。**注意**：serverless 模式只支持 wechat/qq(网页登录)，不支持 QQ音乐 App 扫码（qqmusic 通道需要 MQTT 长连接）；为支持 qqmusic 通道已切换到 **Node 模式**（主进程加载包根模块启动内置 Koa 服务，含 MQTT），监听动态空闲端口（实测 51270 等）。
  - `QQ_SESSION_SECRET`、设备身份 `qq-device.json`、加密会话 `qq-session.json` 均持久化到 userData，登录态跨重启保留。
  - QQ 音乐适配器 10/10 测试通过（mock HttpHandler 验证映射与参数）；`createQrLogin(channel)` 支持 qqmusic/wechat/qq 三通道。
  - 架构重构：主进程 `platformRegistry` 注册表（支持异步适配器工厂）+ 通用 `platform:*` IPC（platform 参数分发），替换原 netease 专属 IPC。
  - UI：登录区/歌单区双平台标签页；同步区增加「同步到」平台下拉；QQ音乐扫码弹窗内可切换扫码方式（QQ音乐 App / 微信 / 手机QQ）。
  - 踩坑：ESM 下 `createRequire` 的 `const require` 与 electron-vite 注入的 require 冲突 → Node 模式加载包根模块时用 `createRequire(import.meta.url)(...)` 内联形式。
- **待办**：用户手工验收（QQ音乐 App 扫码登录 → 拉歌单 → 文本同步创建歌单）。

### T6 — 文本快速创建全自动解析（设计已定，待实施）

> 目标：移除「解析格式」手动选择，用户粘贴任意文本后全自动完成解析（格式探测 → 去噪 → 字段顺序判定 → 可选搜索验证）。

**问题清单（分析结论）**

| # | 问题 | 现状 | 影响 |
|---|---|---|---|
| P1 | 格式需手动指定 | UI 下拉框 `order`（title-first/artist-first），全局生效 | 混排来源文本一半解析错位，歌名/歌手互换后匹配全失败 |
| P2 | 字段顺序本质歧义 | `晴天 - 周杰伦` vs `周杰伦 - 晴天` 无纯文本区分法 | 必须靠外部知识（词典/搜索）判定 |
| P3 | 输入格式多样 | 仅支持行式拆分 | m3u/csv/json/lrc/分享文本/聊天混排/URL 均无法正确解析 |
| P4 | 噪声识别不足 | `isNoise` 只过滤无字行 | 分享模板行、聊天语、歌词元信息（作词/作曲）被当纯歌名塞进 songs |
| P5 | 多歌手/复合字段 | 只取前两个分隔段 | `周杰伦、蔡依林 - 歌名`、`A feat. B - 歌名`、`歌名 (Cover: x)` 处理不完整 |
| P6 | 分隔符歧义 | 固定正则 | 歌名内含 `-`、全角/半角混用、分隔符混用会误拆 |
| P7 | 版本词/书名号语义 | 不识别 | `《乌梅子酱》李荣浩` 整行当歌名；`(Live)` 挂在错误字段 |
| P8 | 无外部校验闭环 | 置信度 0.9/0.6 为常量 | 顺序判错无反馈；纯歌名无歌手，后续匹配宽松且易错 |
| P9 | 验证成本与风控 | — | 数百行全量搜索会触发 405 风控（已有踩坑记录） |
| P10 | 交互缺失 | 预览只读 | PRD 要求逐条修正；失败行与预览脱节 |

**方案：四级流水线（用户零选择）**

1. **格式自动探测 `detectFormat`**：JSON（可 parse）> m3u（`#EXTM3U`/`#EXTINF`）> LRC（时间戳行占比≥60%）> CSV/表格（≥80% 行列数一致）> 平台分享模板（URL 域名/分享词）> 行式文本。结果记录 `ParseResult.format`，用户可见「已自动识别：xxx」但无需选择。
2. **行分类器 + 结构解析**：每行分 `song/meta/template/chat/link/noise`。meta（作词/作曲/专辑）过滤、template（"分享xx的歌单《x》"）过滤但含《歌名》时可提取、chat 剥 `名字:` 前缀后递归解析、link 提 URL 走平台 API（最高置信度来源）。分隔符按整段统计选主导符，优先空格包围的 ` - `。
3. **字段顺序自动判定 `inferOrder`**：信号加权——书名号（+0.40 歌名）、版本词 Live/Remix/Cover/OST（+0.35 歌名）、多人名连接词 `、` `/` `&`（+0.35 歌手）、`feat./ft.`（+0.30 歌手）、内置歌手名词典命中（+0.30 歌手，压缩数百 KB 随版本更新，未命中不计负分）、字段长度/歌名高频词（弱信号）。差值≥0.25 定序；否则标记 `ambiguous` 保留双候选。整段一致性投票校正个别行。
4. **搜索验证闭环（按需、限速、缓存）**：仅对 `ambiguous` / 低置信度行触发；候选 A/B 分别搜索 + 复用 `matchSong` 评分，胜者回写；结果写 SongMapping 缓存；限速 ≥500ms/首纳入风控预算；未登录/断网降级为纯本地解析并标记「未验证」。验证器经依赖注入 `SongVerifier`（主进程用 `PlatformAdapter.searchSongs` 组装），core 保持平台无关。

**数据模型变更**（`core/models/parse.ts`）

- `ParseOptions.order` 保留为高级覆盖项（缺省全自动）；新增可选 `verify?: SongVerifier`
- `ParsedSong` 新增 `orderConfidence?`、`candidates?`（歧义候选含验证得分）、`verified?`
- `FailedLine.reason` 扩展 `'ambiguous-order' | 'unrecognized'`
- `ParseResult` 新增 `format: DetectedFormat`、`detectedOrder?`、`ignoredLines`（模板/元信息/聊天噪声，供 UI 折叠展示）

**UI 变更（TextCreator）**：删除「解析格式」下拉框，解析后显示「自动识别：歌名-歌手（置信度 92%）」；歧义行黄色高亮 + 候选一键切换；预览行内可编辑 title/artist（PRD FR-2.1 逐条修正）；被忽略行折叠展示。

**验收标准**

- 不传任何选项，混排两种顺序的构造文本（≥20 行）解析正确率 100%
- 网易云/QQ 音乐分享文本自动提取歌曲列表；m3u/csv/json/lrc 自动识别
- 聊天混排：噪声行进 `ignoredLines`，歌曲行进 `songs`
- 歧义行标记 `ambiguous-order` 且预览可一键切换候选
- 搜索验证仅触发低置信度行，限速 ≥500ms，结果缓存；断网降级不阻塞
- 数百行文本解析 < 1s（不含搜索验证）
- 现有 11 项测试除「混排」用例外全部保持通过；「混排」用例断言「分享歌单：我的收藏」被当纯歌名，与 PRD FR-2.1「自动忽略非歌曲行」相悖，属需求演进，实施时经确认后更新该用例并记录

**边界情况**：空输入、全噪声、超长行、重复行（保留不去重）、繁简体、混合语言、行内多分隔符、CSV 引号转义、分享链接失效（降级为行式解析）。

**实施拆分**：T6.1 格式探测 + 行分类器（纯本地）→ T6.2 顺序自动判定（信号+投票）→ T6.3 结构格式解析器（json/csv/m3u/lrc/share）→ T6.4 搜索验证闭环 + UI 改造。均 TDD，每步 `npm run test` + `npm run typecheck`。

**T6.4 金标准匹配已实施 ✅（同歌不同作者手动选择）**
- **金标准**：行业真金标准 ISRC 国内平台不暴露 → 代理金标准 = 标题归一化精确相等 + 歌手归一化精确相等（`normalize` 含繁转简/去括号/全角转半角）。
- `core/matcher/exactMatch.ts`（新）：`classifyCandidates` 三类判定——`exact`（完全匹配，自动选；同歌同唱多收录按时长最接近者选）、`title-only`（同歌不同作者，产出候选待手动选）、`variant`（交给 `findBestMatch` 评分）。
- 同步引擎两阶段改造（`core/sync/syncPlaylist.ts`）：`planSync`（搜索+判定，产出 `SyncPlan{matched,choices,failed}`，不建单）+ `executeSync`（确认后建单+分批添加，未确认 choice 计 `unresolved`）+ `syncPlaylist` 组合入口（有 choices 返回 `status:'choice-needed'`）。
- 主进程：`platform:sync-playlist` 返回 `{taskId, report}`，choice-needed 时 plan 缓存进 `pendingSyncs`；新增 `platform:confirm-sync(taskId, selections)` 完成写入。preload 暴露 `confirmSync`。
- UI（TextCreator）：choice-needed 时展示「同名不同歌手」选择面板（候选含歌手/专辑/时长），全部选定后「确认选择并创建歌单」；完全匹配的歌曲自动添加，无需干预。
- 测试：exactMatch 10 项 + syncPlaylist 新增 7 项（完全匹配自动选、同歌不同作者 choice-needed、无歌手唯一标题自动、混合场景暂不建单、confirm 后合并写入、未选择计 unresolved），共 79 项全绿；typecheck、lint 通过。
- 待办：手工端到端验收（构造含翻唱的文本 → 选择面板 → 确认创建）。

**T6.1 + T6.2 全自动解析已实施 ✅**
- `core/parser/detect.ts`（新）：`detectFormat` 格式自动探测（json > m3u > lrc > csv > share > lines）+ `classifyLine` 行分类（song/meta/template/chat/link/noise；模板行先于聊天前缀剥离判断，避免「分享歌单：xxx」误当说话人；chat 支持 `名字:` 与 `【昵称】` 前缀多层剥离）。
- `core/parser/artistLexicon.ts`（新）：内置常见歌手词典（华语/欧美/日韩 ~150 条，经 normalize 归一化匹配），仅作正信号。
- `core/parser/orderInfer.ts`（新）：`inferPair` 字段顺序信号评分（书名号+0.40/版本词+0.35 歌名侧；多人名+0.35/feat.+0.30/词典+0.30/短名+0.10 歌手侧；差值≥0.25 定序否则 ambiguous）+ `majorityOrder` 整段投票（≥80% 且样本≥2 裁决歧义行）+ `splitQuotedTitle` 书名号锚定（《歌名》歌手/歌手《歌名》）。
- `parseText` 管线重写：探测 → 行分类去噪（空行/纯符号静默跳过，meta/template/link 进 ignoredLines，模板行含《歌名》时提取为歌）→ 书名号锚定 → 分隔符拆分 → 顺序判定（override > 信号 > 投票）；歧义行保留双候选。`ParseOptions.order` 仅作高级覆盖，默认全自动。
- 模型：`ParseResult` 新增 `format`/`detectedOrder`/`ignoredLines`；`ParsedSong` 新增 `orderConfidence`/`candidates`。
- UI（TextCreator）：移除「解析格式」下拉框；预览显示「已自动识别：歌名 - 歌手」标签；歧义行高亮 + 一键切换候选；展示已忽略行数。
- 测试：detect 14 项 + orderInfer 14 项 + parseText 由 11 项扩至 18 项（混排两种顺序全自动、投票纠正、聊天行、书名号、歧义候选、模板提取、share 探测），共 115 项全绿；typecheck、lint 通过。
- 需求演进更新的既有断言（计划内，非改测试过测）：置信度 0.9 常量 → 信号计算值；混排用例「分享歌单：我的收藏」从纯歌名改为 ignoredLines（PRD FR-2.1「自动忽略非歌曲行」）；空输入 toEqual 增加新模型字段。
- 待办：T6.3 结构格式解析器（json/csv/m3u/lrc，当前探测后返回空结果）；手工验收混排/分享文本解析。

**T6.3 结构格式解析器已实施 ✅（T6 全部完成）**
- `core/parser/structured.ts`（新）：`parseJson`（数组/嵌套对象取第一个数组，键别名 title/name/song/track + artist/singer/author）、`parseM3u`（提取 `#EXTINF` 逗号后描述）、`parseLrc`（剥时间戳后复用行式管线，元信息行进 ignoredLines）、`parseCsv`（tab/逗号主导分隔符，表头列映射 title/artist 键别名，无表头按 [歌名,歌手]）。
- 行式管线抽至 `core/parser/lines.ts`（`parseLineText`），供 m3u/lrc 复用（避免循环依赖）；`parseText` 瘦身为「探测 + 分派」入口。
- 测试：structured 8 项（json 数组/键别名嵌套/m3u/lrc/csv 表头与无表头/空歌手列），共 123 项全绿；typecheck、lint 通过。
- T6 全部交付：格式自动探测、行分类去噪、字段顺序自动判定 + 投票、书名号锚定、结构格式解析、金标准匹配（完全匹配自动选/同歌不同作者手动选）。UI 已移除手动格式下拉框。
- 待办：手工端到端验收（混排两种顺序文本、分享文本、csv/m3u/lrc 粘贴、含翻唱的同步选择面板）。

### 修复记录 — 英文独立乐队清单解析失败 ✅
- **问题**（用户实测清单 Radiohead/Black Country New Road 等 7 首）：
  1. `Weird Fishes/Arpeggi` 被 `MULTI_ARTIST` 误判（斜杠当多人名分隔符）→ 首行 title/artist 颠倒；
  2. 其余 6 行为英文独立乐队、不在歌手词典 → 顺序歧义 → 默认 title=乐队名 → 同步搜索词是乐队名，全部匹配失败；UI 歧义行 artist 缺失显示不完整；
  3. 预览「切换候选」是交替盲切，用户无法明确选择。
- **修复**：
  1. `MULTI_ARTIST` 收窄为「顿号连接的中文人名」（英文逗号/斜杠常见于乐队名与歌名）；
  2. 歌手词典扩充 ~60 个欧美摇滚/独立/电子/爵士艺人（含清单 7 个），存储改为 `normalize` 归一化 key；移除歧义单词型乐队名（Ride）；
  3. **搜索验证闭环**（T6 第四级落地）：`MatchQuery.alternatives` 携带歧义行双候选，`planSync` 主候选无匹配时逐个搜索备选——备选完全匹配自动选、备选多版本进 choice 面板；
  4. UI：歧义行改为两个明确候选按钮（点选即用）；同步请求自动携带 `alternatives`；预览列表高度 max-h-64→96 避免末条裁剪。
- **测试**：回归用例（用户清单 7 行全对、斜杠/逗号乐队名不误判）3 项 + planSync alternatives 4 项，共 131 项全绿；typecheck、lint 通过。
- 待办：手工验收真实平台同步（该清单应 7 首全部匹配并自动建单）。

### 修复记录 — 全自动解析 P0/P1 缺陷 ✅
- **P0-1 冒号误剥**：`detect.ts` 说话人前缀剥除改为锚定判定——数字冒号（`04:44`）不剥；中文昵称冒号必剥；英文昵称仅当剩余内容含中文且昵称 ≤8 字符时剥。修复 `04:44 晴天 - 周杰伦`、`Time: The Revelator - Gillian Welch` 被剥坏。测试 +5（detect）+3（parseText）。
- **P0-4 版本差异被金标准吞掉**：`exactMatch.ts` 新增 `pickBestVersion`——query 带版本标记（Live/Remix）优先同版本候选；无版本标记优先原版（无标记候选）；无符合候选回退全部，再按时长兜底。复用 T8 的 `extractVersionTag`。测试 +4。
- **P0-5 搜索膨胀/风控**：`SyncOptions` 新增 `maxSearchesPerSong`（默认 4），`planSync` 按每首歌计数预算，超预算停止备选搜索。风控（`SearchError.rateLimited`）保持不试备选（继续请求会加剧风控，属正确行为）。测试 +2。
- **P1-6 被忽略行不可见**：TAG 流中被忽略行由 `return null` 改为渲染灰色标签（删除线 + 删除按钮 + 点击编辑恢复），误滤可见且可恢复。i18n 新增 `textCreator.ignoredLine` 词条（中英）。
- 验证：typecheck、lint 通过，221 项测试全绿（17 文件）。
- 待办：手工验收（粘贴含 `04:44` 时间戳/英文冒号歌名/聊天记录的混排文本；同步含 Live 版本差异的歌单）。

### 修复记录 — 解析器剩余缺陷（P0-3/P1-7/P1-12/P2-15）✅
- **P0-3 全歧义默认顺序**：`orderInfer.ts` 新增 `defaultOrderForPair` 启发式——双字段均无中文（英文 tracklist/m3u 常见「歌手 - 歌名」）默认 artist-first，其余默认 title-first；仅影响预览默认展示与候选排序，同步仍由备选验证闭环裁决。
- **P1-12 投票阈值**：`majorityOrder` 80% → 60%（样本 ≥2 不变），3 行 2:1 场景可投票裁决歧义行。
- **P1-7 CSV 引号转义**：新增 `core/parser/csv.ts`（`splitCsvLine` 支持双引号包裹字段与 `""` 转义），`detectFormat` 列数探测与 `parseCsv` 表头/数据行统一改用引号感知拆分。
- **P2-15 版本词边界**：`VERSION_WORD` 拆分为英文边界正则 `\b(live|remix|cover|demo|acoustic|instrumental|ver\.?)\b` + 中文子串正则，修复 `Deliver`/`Recover`/`Forever.` 词根误作版本词信号。
- 测试：orderInfer +4、parseText +2、structured +4，共 229 项全绿；typecheck、lint 通过。
- 本轮明确不做（用户确认）：歌词文件判别、JSON 数组启发式、链接解析。

### 架构变更 — 移除本地词典，字段顺序交由搜索验证 ✅
- **决策（用户确认）**：不再用本地歌手词典猜测字段顺序，也不在预览提供手动切换；直接用平台搜索接口验证。
- **改动**：
  1. 删除 `core/parser/artistLexicon.ts`；`orderInfer.signalFor` 移除词典信号（+0.30），仅保留强结构信号（书名号/版本词/多人名/feat/长度）。
  2. `exactMatch.classifyCandidates` 新增**搜索反向验证**：候选标题 == query 歌手 且 候选歌手 == query 歌名（即平台结果与 query 交换后精确相等）→ 证明字段顺序颠倒 → 自动采纳。正向精确优先于反向。
  3. UI 移除歧义行「切换候选」chip 与 `applyCandidate`；`textCreator.pickCandidate` 词条删除。歧义行仅显示默认解读（中英文启发式），双候选随 `alternatives` 进入同步闭环（主候选组合关键词搜索 + 反向验证 + 备选搜索三重兜底）。
- **行为变化**：无强信号的双字段行几乎全部标记歧义（保留双候选），预览按中英文默认顺序展示；正确性由同步阶段搜索验证保证。单曲搜索预算（maxSearchesPerSong=4）控制验证开销。
- **测试**：删除 3 项词典用例，更新 6 项依赖词典的断言（按新语义：默认解读 + 双候选），新增反向验证 2 项，共 229 项全绿；typecheck、lint 通过。

### 国际化接入 ✅（中英双语）
- **范围**：渲染层全量 UI 文案（6 个组件）+ 窗口标题/`<html lang>`；core 与主进程日志保持中文（不面向用户）。
- **方案**：自研轻量类型安全 i18n（不引入第三方依赖）。`renderer/src/i18n/translations.ts` 扁平键词典（zh-CN 基准 + en-US 以 `Record<TranslationKey, string>` 编译期强制键一致）；`renderer/src/i18n/index.tsx` 提供 `I18nProvider`/`useI18n`（`t()` 支持 `{param}` 插值、`formatTime/formatDate` 按语言格式化）。
- **持久化**：语言偏好走现有 `settings.set('language', ...)`（SQLite），启动时 `settings.get` 恢复，非法值回退 zh-CN；设置页「语言」行改为中/英切换器。
- **可翻译性修正**：同步历史 `source` 由中文文本改为稳定代码 `text-import`，展示时翻译（旧数据原样显示）；同步失败/解析失败按稳定 reason 码在渲染层翻译，平台原始错误透传；二维码轮询状态改为状态码（waiting/success/expired/scanned）渲染时翻译。
- **测试**：`tests/renderer/i18n.test.ts` 6 项（键集合/占位符一致性、插值、未知键回退、normalizeLocale、LOCALES）；共 171 项全绿；typecheck、lint 通过。
- 待办：手工验收中英切换即时生效、重启后语言保持、同步历史新旧数据展示。

### T7 — 歌单管理操作（重命名/删除/歌曲增删）✅ 编码完成（手工验收待用户执行）
- **交付物**：`PlatformAdapter` 扩展歌单管理方法（rename/delete/remove songs）+ 网易云/QQ音乐实现 + 通用 IPC + 「我的歌单」UI 管理操作
- **验收**：
  - 歌单可重命名：改后列表即时更新，重启后平台侧仍为新名
  - 歌单可删除：两步确认（点击「删除歌单」→「确认删除？」），删除后从列表消失
  - 歌单内歌曲可单首移除：点击行尾移除按钮即时生效
  - 歌单内可添加歌曲：搜索关键词 → 候选列表 → 点击添加，重复添加不报错
  - 以上操作仅对 `capabilities.write` 平台显示；未登录或凭证过期时给出明确错误
- **边界情况**：空歌单名（前端 trim 校验）、QQ音乐歌单名 ≤20 字符（平台限制）、移除/添加空列表跳过、删除当前已打开的选中歌单、跨平台搜索限速（沿用限速策略）、非本人歌单操作失败（平台报错透传）
- **验证命令**：`npm run test -- platforms` + 手工验收（双平台歌单重命名/删除/增删歌曲）
- **实际结果**：
  - 接口：`PlatformAdapter` 追加 `renamePlaylist` / `deletePlaylist` / `removeSongsFromPlaylist`；`BasePlatformAdapter` 同步默认「不支持」实现（插件化架构下新平台可选择性实现）。
  - 网易云：`playlist_name_update` / `playlist_delete` / `playlist_track_delete`（ids 逗号拼接），错误 code 非 200 抛异常。
  - QQ音乐：`POST /user/playlist/rename`（body `{tid,name}`）、`/user/playlist/delete`（body `{tid}`）、`/user/playlist/tracks`（`op:'del'`，每批 ≤100，与 add 共抽取 `updatePlaylistTracks` 私有方法）。
  - IPC：新增通用 `platform:search-songs` / `playlist-rename` / `playlist-delete` / `playlist-add-songs` / `playlist-remove-songs`（统一 `withPlaylistCredential` 前置校验登录，search 单次 ≤50 条防滥用）；preload 白名单同步暴露。
  - UI（PlaylistSection）：歌单详情头部支持重命名（inline 编辑，Enter 保存 / Esc 取消）；删除歌单两步确认；歌曲行 hover 显示移除按钮；「添加歌曲」搜索区（搜索 → 候选列表 → 逐首添加，添加后候选移除并同步到本地列表）。所有管理操作仅 `capabilities.write` 平台显示。i18n 中英双语补齐 12 键。
  - TDD：先写 6 项适配器测试（netease 3 + qqmusic 3）红 → 实现转绿；全量 177 项测试、typecheck、lint、build 全部通过。
- **待办**：手工验收（双平台歌单重命名/删除/移除歌曲/搜索添加歌曲）。

### 快速创建页精修：一步创建 + 风格自动命名 ✅
- **需求**：去掉「解析歌曲」按钮（输入即解析、直接创建）；歌单名留空时默认「今日日期 + 第一首歌曲风格」；去掉顶部「本地优先 · 凭证经系统钥匙串加密」文案与页面模块装饰标签。
- **实现**：
  - `PlatformSong` 新增 `genre?`；网易云/QQ音乐搜索结果映射提取 `item.genre`（上游不返回时为空）。
  - 同步引擎：`SyncPlan`/`SyncReport` 新增 `firstGenre`（planSync 记录第一首匹配/候选的风格并随报告返回）。
  - 主进程 `platform:sync-playlist` 接收 `autoNameDate`（渲染层按当前语言格式化的今日日期），歌单名留空时拼「日期 + 风格」为最终名，建单与 choice-needed 会话均使用最终名。
  - UI（TextCreator）：textarea 输入实时解析（useEffect），删除「解析歌曲」按钮与 `handleParse`；任务记录名使用报告返回的最终名。App 头部删除 securityNote 区块；两处 `MODULE://` 装饰标签删除；i18n 清理 `app.securityNote`/`textCreator.parse`/`textCreator.defaultPlaylistName` 中英 3 键。
- **测试**：新增 firstGenre 传播 3 项（完全匹配/choice 取第一候选/无风格 undefined）。
- **文档**：新增 `docs/platform-api-fields.md`——两个平台全部上游接口的返回参数字段清单（含歌曲条目字段、genre 获取结论与待实测项）。
- **待办**：手工验收（粘贴文本即时出预览、留空歌单名后建单名为「日期 + 风格」；上游不返回风格时仅日期）。

### 文本输入框 TAG 化 ✅
- **需求**：输入即把每行文本转换为标签，删除输入块下方的独立识别预览面板。
- **实现**：`TextCreator` 输入区改为标签编辑器——行集合 `lines` 为唯一数据源（`useMemo` 实时解析）；每行渲染为歌曲标签（主色、歧义行内嵌候选切换）、失败行标签（红色、悬停显示原因）或中性原文标签，被忽略行与空行不显示；末尾常驻输入行，回车/粘贴自动拆行提交，退格删除末标签；点击标签就地编辑（Enter 提交 / Esc 取消 / blur 提交）；每个标签带 X 删除；结构化格式（json/csv/m3u/lrc）行号错位的歌曲追加渲染为标签（可删除）。候选点选改为改写该行原文为「歌名 - 歌手」。
- **i18n**：新增 `textCreator.tagPlaceholder`；删除预览面板相关 9 键（recognizedPrefix/recognizedSuffix/linesFailed/autoDetected/titleArtist/artistTitle/noArtist/ignoredLines/textareaPlaceholder）。
- **验证**：196 项测试全绿、typecheck、lint 通过。
- **待办**：手工验收标签编辑交互（粘贴多行、回车、点选候选、删除、Esc 取消）。

### 粘贴修复与重复识别 ✅
- **粘贴修复**：单行 `<input>` 会把粘贴的换行符净化为空格（HTML 值净化），改用 `onPaste` 在净化前从剪贴板取原文按行拆分提交（`onChange` 检测换行永远不触发，已移除）。
- **重复识别**：`songDupKey`（标题+歌手 `normalize` 归一化，与匹配引擎同口径）标记重复歌曲；重复 TAG 前缀「重」徽章 + 灰调样式（类似禁用），仍可点击编辑/删除/切换候选，不修改用户输入；创建时 `queries` 过滤重复（保留首次出现），任务 total 为去重后数量。i18n 新增 `duplicateBadge`/`duplicateHint`。
- **待办**：手工验收粘贴多行清单、重复歌曲灰调标记与创建去重。

### 桌面布局重构（mac 应用标准）✅
- **问题**：内容区 `mx-auto max-w-5xl` 居中限宽，窗口放大后内容聚在中间。
- **改动**：移除 main 容器的 `max-w-5xl` 限制，内容铺满窗口（侧边栏 w-60 固定 + 内容区 flex-1 自适应）；LoginSection 去掉 `max-w-3xl` 并改宽屏双列网格（`xl:grid-cols-2`）；SettingsView 去掉 `max-w-2xl`；PlaylistSection（w-64 + flex-1）与 TextCreator（flex-1 + w-72 侧栏）本身自适应，随容器铺满。
- **顺带清理**：删除上轮遗漏的同类装饰标签——SyncCenter「Hub Engine v2.4 / DAEMON ONLINE」、LoginSection「AUTHENTICATION VAULT / SQLite AES-256…」、SettingsView「PREFERENCES LOCAL ONLY」。
- **待办**：手工验收窗口缩放各页面铺满效果。

### T8 — 匹配引擎增强（对标第三方：专辑因子 / feat 归一化 / 版本标记消歧）
> 背景：第三方（Soundiiz/TuneMyMusic 等）匹配均基于「标题+歌手+专辑+时长」多因子；本项目此前缺专辑因子、feat./多歌手变体归一化、括号版本标记（Live/Remix/Cover）排序。候选重选 UI（ConfirmSyncDialog）与人工映射写回（confirm-sync → saveConfirmedMapping）已闭环，本轮不动；低置信度不自动选（threshold 0.6）维持现状。

**验收标准**
1. 专辑因子：`MatchQuery` 新增 `album?`；query 带专辑且候选专辑归一化精确相等 → +0.05（album-exact），部分包含 → +0.02（album-partial）；query 无专辑时行为不变。
2. feat/多歌手归一化：歌手串按 `feat./ft./featuring/&/＆/,/，/;/；/、` 切分为多个人名（先 normalize 整串再切分），query 与候选任一人名精确相等即视为歌手匹配；`classifyCandidates` 金标准同口径（feat 变体视为同一歌手 → exact 自动选，不再进手动面板）。
3. 版本标记消歧：提取标题括号内版本词（live/remix/remastered/cover/instrumental/acoustic/unplugged/dj/radio edit/伴奏/现场/翻唱/纯音乐）；query 与候选同标记 +0.08（version-match）、异标记 −0.05（version-mismatch）；无标记方不受影响。
4. 现有测试 2 项断言按需求演进更新（计划内，非改测试过测）：feat 断言 title-only → exact；「标题变体分数低于精确」跨 query 分数比较改为各自选中正确候选（版本标记使「query 带标记 + 候选同标记且标题逐字一致」成为最强信号 0.86，跨 query 分数比较无业务含义）。其余全部保持通过；全量 test + typecheck + lint 通过。

**边界情况**：歌手名含斜杠（乐队名 `Weird Fishes/Arpeggi`）不切分；版本词在标题非括号处（如 `晴天现场版` 无括号）不误提取；版本词大小写/全角归一化；`(Live in Taipei)` 命中 live 词根。

**实施拆分**：T8.1 feat/多歌手归一化 + 金标准口径 → T8.2 版本标记消歧 → T8.3 专辑因子 + 查询透传。均 TDD。

**实际结果（T8 全部完成 ✅）**：
- `matchSong.ts`：新增 `artistParts`（先 normalize 整串再按 `feat./ft./featuring/&/,/;/、` 切分，斜杠不切防乐队名误拆）与 `extractVersionTag`（括号内版本词表，长词先于短词，如 remastered 先于 remaster）；评分新增专辑因子（exact +0.05 / partial +0.02）、版本标记信号（同标记 +0.08 version-match / 异标记 −0.05 version-mismatch）、歌手比对改为人名交集（exact +0.15 / partial +0.05）。
- `exactMatch.ts`：金标准歌手判定改用 `artistParts` 交集（feat./多人名顿号变体视为同一歌手 → exact 自动选，不再进手动面板）。
- `models/match.ts`：`MatchQuery` 新增 `album?`；`syncPlaylist.ts` attempts 透传 album（跨平台歌单同步时专辑因子生效，文本场景 album 缺省不受影响）。
- TDD：先写 9 项新用例 + 2 项计划内断言演进（红 10 项）→ 实现转绿。全量 207 项测试、lint 通过；本次改动文件 typecheck 无误。
- 注：typecheck 现存 3 个错误（keepAliveService.ts / platforms/base.ts / App.tsx）来自工作区其他未提交的「凭证保活」改动，与本任务无关，未处理。

### T9 — 同步中心强化：任务详情清单 + 报错原因 + 卡住手动介入 ✅ 编码完成（手工验收待用户执行）

> 需求：同步中心支持查看任务详情（具体歌曲清单、报错原因）；任务长时间卡住时，用户可手动介入「继续往下走（跳过当前歌曲）」或「停止任务」。

**验收标准**
1. 任务详情：同步中心点击任务可打开详情抽屉，逐首展示清单（已匹配/待选择/失败/已跳过）与失败原因；详情随任务持久化（重启后可见），旧任务无明细时回退展示原失败列表。
2. 停止任务：运行中任务可一键停止，引擎在下一个检查点（每首歌之间/批次之间/重试等待之间）响应；已建单的部分写入保留；任务状态归为 `stopped`，重启后不再被归为 interrupted。
3. 跳过当前歌曲：运行中任务可「跳过当前歌曲」，引擎在该曲处理结束后放弃当前曲（记为 `skipped` 失败项）继续下一首，不中断整体任务。
4. 卡住根因缓解：主进程对平台搜索/写歌单调用加 60s 超时包装（超时抛可重试错误），挂起请求不会永久卡死任务。
5. 现有全部测试保持通过；新增介入控制与明细的验收用例；typecheck + lint 通过。

**边界情况**：任务在「等待确认选择」阶段不可停止（走原有取消流程）；停止时建单尚未发生则不建单；跳过请求对已开始的歌曲不生效（下一首开始前消耗）；重启残留的 running 任务仍归 interrupted，stopped 任务保持 stopped。

**实现要点**
- core：`SyncOptions` 新增 `signal`（AbortSignal）/`skipCheck`/`onStep`；`SyncPlan`/`SyncReport` 新增 `items`（逐首明细）；`SyncReport.status` 新增 `stopped`；`SyncFailedItem.reason` 新增 `skipped`；新增 `SyncAbortedError`（携带 partial 明细）；`SyncTaskStatus` 新增 `stopped`；`SyncTaskRecord` 新增 `detail`。
- 主进程：`runningSyncs` 注册表（AbortController + skip 标志）+ `platform:stop-sync`/`platform:skip-sync`；`sync-playlist` 接收渲染层 taskId（待确认会话与任务记录统一同一 id）；`sync:step` 事件广播逐首明细；SyncAbortedError 收敛为 stopped 报告返回渲染层。
- 存储：`sync_tasks` 新增 `detail` 列（JSON 明细），旧库 ALTER TABLE 迁移。
- UI：SyncCenter 卡片新增「跳过当前/停止」按钮（仅真正执行中的任务）与详情抽屉；失败原因按稳定 reason 码翻译，平台原始错误透传。

**实际结果（T9 编码完成 ✅）**
- core：`SyncOptions` 新增 `signal`/`skipCheck`/`onStep`；`planSync` 每首歌前与重试等待中检查中止信号（抛 `SyncAbortedError`，partial 携带已处理明细），`skipCheck` 命中记 `skipped` 失败项继续下一首；`executeSync` 建单前/批次间检查中止，unresolved/add-failed 回写逐首明细；`SyncPlan`/`SyncReport` 新增 `items`，`SyncReport.status` 新增 `stopped`。
- 主进程：`runningSyncs` 注册表（AbortController + 一次性 skip 标志）+ `platform:stop-sync`/`platform:skip-sync`；`sync-playlist` 接收渲染层 taskId（待确认会话与任务记录统一 id）；`sync:step` 逐首明细广播；搜索/写歌单调用 60s 超时包装（超时转可重试 SearchError，根除挂起卡死）；`SyncAbortedError` 收敛为 stopped 报告返回渲染层；confirm-sync 执行阶段同样可停止。
- 存储：`sync_tasks` 新增 `detail` 列（JSON 明细），旧库 `ALTER TABLE` 自动补齐；`finalizeInterrupted` 只归 running 残留，stopped 保持。
- UI：SyncCenter 任务卡片可打开详情抽屉（汇总 + 逐首清单：已匹配/待选择/已跳过/失败 + 报错原因，旧任务回退 failedDetail 列表）；执行中任务显示「跳过当前/停止」按钮与卡住提示；App 计算 intervenableIds（排除待确认阶段，确认写入中仍可停止）；TextCreator 实时累积 step 明细并落库，stopped 分支正确归因；i18n 中英补齐 15 键。
- TDD：引擎介入控制与明细 7 项新用例 + store detail 往返/旧库迁移 2 项；既有断言按需求演进更新（makeTask 补 detail 字段，计划内）。全量 241 项测试、typecheck、lint、build 全部通过。
- 待办：手工验收（运行中大歌单任务 → 同步中心详情抽屉实时清单 → 跳过当前/停止任务 → 重启后 stopped 任务状态与明细保持）。

### T10 — 歌曲列表显示模板 ✅
- **需求**：定义歌曲列表的统一显示模板，展示歌曲基本信息（序号、封面、歌名、歌手、专辑、时长），供「我的歌单」歌曲列表、搜索结果列表与同步中心任务详情清单复用。
- **交付物**：`renderer/src/components/SongList.tsx`（可复用模板组件）；`PlaylistSection` 两处列表接入；`SyncCenter` 任务详情分组清单接入。
- **验收**：
  - 模板展示基本信息：序号（可隐藏）、封面（缺省或加载失败回退音符图标）、歌名、歌手、专辑（整列缺失时隐藏）、时长（mm:ss，缺失显示 --）
  - 行尾操作区由调用方注入（`renderAction`），模板不关心具体操作
  - 歌名下方可选第二行辅助信息（`renderSubtitle`，如同步失败原因）
  - 我的歌单主列表与搜索结果列表均使用该模板，视觉与交互保持一致（移除按钮 hover 显现等原有行为不变）
  - 同步中心任务详情：已匹配/待选择/失败（含原因副标题与状态图标）三组清单均用模板渲染，分组标题样式与旧任务 failedDetail 回退不变
  - 文案走 i18n（封面 alt 中英双语，占位符一致）
- **边界情况**：coverUrl 缺失/加载失败、album/durationMs 缺失（整列隐藏）、超长标题/歌手/专辑截断、空列表（渲染空容器，空态由调用方展示）、明细项无封面（详情清单 `showCover=false`）
- **验证命令**：`npm run test -- renderer` + `npm run typecheck`
- **实际结果**：全量 241 项测试全绿（含 i18n 键一致性与占位符校验）、typecheck、ESLint（改动文件）全部通过；PlaylistSection 两处列表与 SyncCenter 详情三组清单统一走模板，原有交互（添加/移除、hover 显现、失败原因展示）保持不变。

### T11 — 我的歌单页：平台图标统一 + 封面展示 + 多选与右键菜单 ✅
- **需求**：
  1. 平台切换标签与其他页面统一使用品牌 logo（`PLATFORM_LOGOS`，缺失回退 material 图标）
  2. 歌单列表行展示平台封面图（缺失回退图标）
  3. 歌单列表支持单选/多选（复选框切换，点击行打开歌单不变）
  4. 右键菜单：多选/单选均可「同步到某个平台」；单选额外含「重命名」「在对应应用打开歌单」「浏览器打开分享链接」
- **验收**：
  - `PlatformPlaylist` 新增 `webUrl?`/`appUrl?`，网易云（music.163.com / orpheus://）与 QQ音乐（y.qq.com / qqmusic://）适配器填充；既有 2 项歌单映射测试按新契约更新（计划内需求演进，非改测试过测）
  - 主进程 `app:open-external` 校验 scheme 白名单（http/https/orpheus/qqmusic），preload 暴露 `openExternal`
  - 歌单同步：选中歌单 → 右键「同步到 {平台}」→ 拉取源歌单歌曲去重 → 走 `syncPlaylist` 完整流程（progress/choice-needed 会话/stopped/toast），任务 source 记 `playlist-import`（同步中心显示「歌单导入」）
  - 单选右键：重命名复用头部内联编辑器（目标歌单未激活时先激活）；「在应用中打开」「浏览器打开」调用 openExternal，失败 toast 提示
  - 多选右键菜单仅含「同步到」各目标平台；目标平台排除源平台、仅 write 能力且已登录
  - 文案走 i18n 中英双语，占位符一致；现有 241 项测试除上述 2 项映射断言外全部保持通过
- **边界情况**：右键未选中行（先选中该行再弹菜单）、切平台清空选择、目标未登录提示、空歌单（无歌曲）不发起同步、openExternal 无处理器报错、菜单在窗口边缘定位
- **验证命令**：`npm run test` + `npm run typecheck` + `npm run lint`
- **实际结果**：241 项测试全绿（其中 netease/qqmusic 各 1 项歌单映射断言按新契约更新，计划内需求演进）、typecheck、ESLint（改动文件）全部通过。实现要点：`PlatformPlaylist` 新增 `webUrl`/`appUrl`（netease: music.163.com/orpheus://；qqmusic: y.qq.com/qqmusic://）；主进程 `app:open-external`（scheme 白名单 http/https/orpheus/qqmusic）；PlaylistSection 平台标签统一品牌 logo、歌单行封面+复选框选择、行右键自定义菜单（单选：重命名/同步到各平台/应用打开/浏览器打开；多选：同步到各平台），同步走完整 syncPlaylist 流程（progress/choice-needed/stopped/toast），任务 source=playlist-import；SyncCenter 来源显示「歌单导入」。i18n 中英补齐 12 键。

### 修复记录 — 右键菜单全量缺陷修复 ✅
- **问题**（审查发现）：① 无可用操作时弹出空壳菜单（目标平台未登录时多选右键必现）；② 定位用硬编码尺寸（232/320）钳制，菜单高度动态变化时底部溢出或位置错位；③ 滚动/resize 不关闭，菜单悬空；④ 菜单内右键弹出系统菜单；⑤ 无 menuitem 角色、无键盘导航、无焦点管理；⑥ shadow-black/40 在浅色主题下过重；⑦ 长文案溢出（英文平台名）。
- **方案**：抽通用组件 `renderer/src/components/ContextMenu.tsx`（条目由调用方构建：`{type:'item'|'divider', label, icon/iconNode, danger, disabled, onSelect}`）——useLayoutEffect 实测尺寸做视口翻转定位（绘制前修正无闪烁）、scroll（capture，scroll 不冒泡必须 capture）/resize/blur/mousedown 关闭、键盘上下键循环+Home/End+禁用项跳过+Escape、打开聚焦首项关闭还原焦点、role=menu/menuitem+aria-label、菜单内 contextmenu preventDefault、`max-h-[80vh] overflow-y-auto` 防超高、label truncate 防溢出、阴影走 `--sw-menu-shadow` 主题变量。
- PlaylistSection：`handleRowContextMenu` 同步构建条目（未选中右键 → 单选语义正确、多选保留、空条目不弹），移除旧 menu 渲染块与关闭监听、MENU_ITEM 常量。i18n 新增 `playlist.menuLabel` 中英。
- **验证**：typecheck、lint、278 项测试、build 通过；dev 启动无报错。待手工验收（空菜单不弹、窗口边缘翻转、键盘上下键、滚动关闭、浅色阴影）。

### 修复记录 — 右键菜单定位偏离与列表文字对齐 ✅
- **问题 1 右键菜单远离鼠标**：根因是 `.view-enter`（fill both）动画结束后残留 `translateX(0)`，非 none 的 transform 使视图容器成为 fixed 后代的 containing block——菜单 `fixed` 坐标从视口变成了相对容器，页面滚动后菜单位置与鼠标严重错位。修复：① 所有 fill both 动画（view-enter/dialog-panel-enter/list-item-enter/detail-enter）to 帧移除 transform 残留；② ContextMenu 经 `createPortal(document.body)` 挂载，双保险隔离 transform/overflow 祖先。同类隐患（LoginSection 二维码弹窗 fixed inset-0 在视图容器内）随动画修复一并解除。
- **问题 2 列表文字垂直偏移 + hover 微跳**：MarqueeText 旧结构为两层 span（外层 truncate + 内层 inline-block），inline-block 参与基线对齐产生 line-box descender 空隙（视觉不居中），且外层 `truncate` 的省略号对 inline-block 子元素无效；hover 切换 `overflow`/`will-change-transform` 合成层时文字微跳。修复：重构为单层 span（文字直接作 flex item 文本节点——省略号生效、无基线空隙、无 hover 位移），调用点移除冗余 `truncate` 类。
- **排查范围**：全仓仅有 MarqueeText 一处 inline-block+nowrap 模式；fixed 元素共 4 处（toast/LoginSection 弹窗/ConfirmSyncDialog/ContextMenu），除 ContextMenu 已 Portal 外其余均在无 transform 祖先下（LoginSection 弹窗随 view-enter 修复恢复正常）。构建产物确认 to 帧无 translate 残留。
- **验证**：typecheck、lint、278 项测试、build 通过；dev 启动无报错。待手工验收（滚动列表后右键菜单贴鼠标、歌单行文字垂直居中、hover 无位移）。

### 修复记录 — marquee 滚动文字溢出到相邻元素 ✅
- **问题**：上一版单层化后文字滚动时无裁剪容器，translateX 动画文字直接绘制到封面/歌单数字上。
- **修复**：MarqueeText 回到「外层裁剪 + 内层动画」结构，但外层改 flex 布局（`flex min-w-0 items-center overflow-hidden`，滚动文字被裁剪在文本区边界内，不溢出到相邻元素），内层 `max-w-full` block 元素负责省略号（非 hover）与 translateX 动画（hover），flex 布局避免 inline-block 基线空隙（保留上一版的对齐修复）。
- **验证**：typecheck、lint、278 项测试、build 通过。待手工验收（hover 长歌单名：文字在自身区域滚动，不盖封面与数字）。

### 修复记录 — 歌单选择交互改为拖拽框选 ✅
- **需求**：去掉歌单行复选框；单击按住拖拽框选多个（锚点行到当前行范围）；Cmd/Ctrl + 单击切换单行选择。
- **实现**：行 mousedown 记录锚点，全局 mousemove 超 5px 阈值进入框选（先选中锚点行），行 mouseenter 按「锚点→当前行」重算范围；拖拽结束抑制同源 click 防止误打开歌单；行 onClick 区分 Cmd/Ctrl 切换与普通打开；列表 `select-none` 防拖拽时选中文字；右键、清除选择、选中计数等原有行为不变。
- **验证**：typecheck、ESLint 通过；全量 241 项测试保持全绿。

### T12 — 歌单数据本地缓存与刷新策略 ✅
- **需求**：歌单列表与歌单歌曲数据保存到本地 SQLite 作为缓存；合理刷新周期；避免自动刷新与手动刷新冲突；手动刷新限流防平台风控。
- **方案**：
  1. 缓存策略常量放 `core/cachePolicy.ts`（双端共用）：歌单列表 TTL 10 分钟、歌单歌曲 TTL 30 分钟、手动强制刷新最小间隔 30 秒
  2. 存储 `main/playlistCacheStore.ts`：`playlist_cache`（歌单列表）/ `playlist_song_cache`（歌曲，整单替换写入）/ `playlist_song_meta`（每单更新时间）；支持失效操作
  3. 服务 `main/playlistCacheService.ts`（依赖注入时钟，可单测）：缓存优先（新鲜直接返回）→ TTL 过期自动刷新 → 单飞（同一资源并发请求共享一次拉取，消除自动/手动冲突）→ 手动强制刷新限流（30s 内返回缓存 + throttled 标记）→ 成功后写缓存并记 lastSuccess
  4. 本地变更联动失效：重命名/删除/增删歌曲后失效对应缓存；同步建单成功后失效目标平台列表缓存
- **验收**：
  - 缓存命中：平台切换/打开歌单不再请求平台接口（日志 fromCache=true）
  - TTL 过期后首次访问自动刷新并更新缓存；并发访问同一资源只发一次平台请求
  - 手动刷新 30s 内二次点击：按钮冷却禁用（倒计时提示）+ 主进程限流兜底（返回缓存并标 throttled，渲染层 toast 提示）
  - 重命名/删除/增删歌曲/同步建单后，对应缓存失效，下次访问拿到新数据
  - 服务层与存储层新增验收测试（fake store + 可控时钟 + :memory: 库）；全量测试、typecheck、lint 通过
- **边界情况**：缓存为空时强制刷新不受限流；拉取失败不记 lastSuccess（可立即重试）；无缓存且拉取失败向上抛错；多歌单并发拉取互不阻塞
- **验证命令**：`npm run test -- main` + `npm run typecheck` + `npm run lint`
- **实际结果**：新增 17 项测试（store 7 项 + service 10 项）全绿，全量 258 项测试、typecheck、ESLint 全部通过。实现要点：`core/cachePolicy.ts` 策略常量（列表 10min / 歌曲 30min / 手动刷新 30s）；`playlistCacheStore` 三张表（列表整份替换、歌曲整单替换 + meta 时间戳、ORDER BY rowid 保平台顺序）；`playlistCacheService` 缓存优先 → TTL 自动刷新 → 单飞去重（自动/手动冲突共享在途请求）→ 手动限流（返回缓存 + throttled 标记）；主进程两个拉取 IPC 接入服务（登录态校验并入实际拉取路径，缓存命中零平台请求），重命名/删除/增删歌曲/同步建单后联动失效对应缓存；渲染层平台切换与打开歌单缓存优先、手动刷新按钮 30s 冷却倒计时 + 主进程限流兜底 toast。i18n 中英补齐 2 键。

### 基础能力补齐（对照差距分析逐项实施，一项一提交）
> 目标：补齐合格桌面 App 应具备的基础能力，按差距分析顺序逐项实施。

- **B1 打包分发 ✅**：electron-builder 配置（`electron-builder.yml`：appId/productName/图标/mac dmg+zip/win nsis/linux AppImage/asarUnpack native 模块）+ `dist` 脚本 + `build/icon.svg`→`icon.png`（1024）。验证：`npm run build` + `npx electron-builder --mac --dir` 产出 SyncWave.app，better-sqlite3 正确解包。签名未配置（发布前用 CSC_LINK/CSC_KEY_PASSWORD）。
- **B2 单实例锁 ✅**：`requestSingleInstanceLock` 失败即退出；二次启动聚焦/还原已有窗口，防 SQLite 并发写。typecheck 通过。
- **B3 窗口状态记忆 ✅**：`main/windowState.ts` 持久化窗口 bounds/maximized 到 userData，resize/move 防抖 500ms 保存、close 立即保存；恢复时校验与可见显示器相交（显示器变化后自动回退居中）。typecheck、lint 通过。
- **B4 应用菜单与快捷键 ✅**：`main/menu.ts` 构建标准菜单（mac 含 appMenu/editMenu/viewMenu/windowMenu，Edit 菜单恢复剪贴板快捷键）；导航菜单 CmdOrCtrl+N（快速创建）/CmdOrCtrl+2..5（歌单/同步/账号/设置），经 `app:navigate` 广播到渲染层切换视图；菜单文案按 settings.language 中英生成，语言变更时重建。typecheck、lint、264 项测试通过。
- **B5 开机启动真实现 ✅**：新增 `app:get-auto-launch`/`app:set-auto-launch` IPC，打包环境对接 `app.setLoginItemSettings`（win 补 `setAppUserModelId`），开发环境仅持久化偏好；SettingsView 开关改读系统登录项真实状态。typecheck、lint、264 项测试通过。
- **B6 自动更新 ✅**：接入 `electron-updater`（generic provider，`SYNCWAVE_UPDATE_URL` 环境变量配置发布源）；打包环境启动 10s 后静默检查、自动下载、退出时安装；`main/updater.ts` 状态广播（checking/available/not-available/downloading/downloaded/error）+ `update:check`/`update:quit-and-install` IPC；设置页「自动更新」行（检查按钮/进度/重启安装）+ 帮助菜单「检查更新」入口；开发模式明确拒绝并提示。typecheck、lint、264 项测试、build 通过。
- **B7 系统通知 ✅**：`main/notifications.ts` 系统通知模块（仅窗口失焦时发送，点击聚焦窗口，中英双语随语言设置）；接入同步完成/部分完成/全部未匹配/停止、账号凭证失效、新版本下载就绪四类事件。typecheck、lint、264 项测试通过。
- **B8 本地歌单库 ✅**：SQLite 新表 `local_playlists`/`local_playlist_songs`（`localPlaylistStore` 事务化整单替换/追加/按位删除重排）+ `localPlaylistService` 校验 + 7 项 `local-playlist:*` IPC；「我的歌单」页新增「本地」标签（`LocalPlaylistPanel`：列表/详情/新建/重命名/两步删除/删歌/平台搜索添加/同步到目标平台走现有 syncPlaylist 流程）；快速创建页新增「保存到本地」按钮（去重后写入，无需登录）。`SqliteDb` 增加可选 `transaction` 接口 + `withTransaction`（fake db 退化直执行）。typecheck、lint、271 项测试（+7）、build 通过。
- **B9 文件导入 ✅**：主进程 `app:open-text-file`（dialog 文件选择，m3u/m3u8/csv/txt/lrc/json，5MB 上限，去 BOM），快速创建页「导入文件」按钮把内容按行追加进标签流，复用现有全自动解析管线。typecheck、lint、271 项测试通过。
- **B10 歌单导出 ✅**：core 新增 `export/toM3u.ts`/`toCsv.ts` 纯函数（+4 测试）；主进程 `app:save-text-file`（保存对话框 + 文件名清洗 + 20MB 上限）；本地歌单与平台歌单详情头部均新增导出按钮（m3u/csv 下拉）。typecheck、lint、275 项测试、build 通过。
- **B11 匹配/同步设置项 ✅**：`settingsService.syncTuning()` 从设置读取阈值（0.4-0.9）/重试次数（0-5）/搜索间隔（300-3000ms）并 clamp 兜底，主进程 `planSync`/`executeSync`（含 confirm-sync）三处传入；设置页新增三个滑块行（实时保存）。typecheck、lint、275 项测试通过。
- **B12 代理设置 ✅**：`main/proxy.ts` 三路注入——axios defaults（平台 API，共享单例）、`session.setProxy`（渲染层请求）、HTTP_PROXY/HTTPS_PROXY 环境变量（Node fetch）；启动自动恢复、设置页代理行（输入/应用/清除，失败 toast）。typecheck、lint、275 项测试通过。
- **B13 CSP 与 sandbox 加固 ✅**：窗口开启 `sandbox: true`（preload 改 CJS 输出 `index.js`，仅 require electron）；`main/security.ts` 打包环境注入 CSP（仅放行字体外链与 https 图片）+ nosniff。附带修复任务 6 埋下问题：electron-updater 在 ESM 主进程下 named export 运行时失败，改 createRequire 加载。dev 启动实测：无报错、IPC 正常、退出流程完整；typecheck、lint、275 项测试通过。
- **B14 SQLite 版本化迁移 ✅**：`main/migrations.ts`（`schema_migrations` 版本表 + 只追加的迁移数组 + `addColumnIfMissing` pragma 判列 + 每迁移独立事务）；启动顺序调整为「迁移 → 建 store」；`syncHistoryStore` 散落 ALTER 移除由迁移 v1 接管；新增 3 项迁移测试 + 1 项旧库升级测试按新路径演进（升级职责从 store 移交框架，测试语义不变）。typecheck、lint、278 项测试通过。
- **B15 浅色主题 ✅**：styles.css 改为双主题 CSS 变量（:root 浅色 Material 3 light / .dark 深色），@theme 颜色 token 引用运行时变量（含透明度修饰经 color-mix 生效）；`renderer/theme.ts`（applyTheme/restoreTheme）+ 入口恢复 + 设置页浅/深切换按钮组，持久化 settings.theme；index.html 移除 body 内联背景。构建产物含两套变量，typecheck、lint、278 项测试通过。
- **B16 关于版本号 + 崩溃恢复 ✅**：渲染进程崩溃（render-process-gone，排除 clean-exit）弹出双语错误对话框，「重启应用」走 `app.relaunch()`（防重入标志）；设置页「关于」行显示实际版本号（SyncWave v{version}）。typecheck、lint、278 项测试、build 通过。

### 补记 — 酷狗音乐平台接入 ✅
> 本条目为文档同步补记（此前迭代未及时落文档，从代码与测试反推核实的事实，不含无法核实的细节）。

- **接入方式**：`kugoumusicapi`（github 依赖 `MakcRe/KuGouMusicApi`）**库模式**——createRequire 直调扁平函数（`login_qr_key`/`login_qr_create`/`login_qr_check`/`user_info`/`login_token`/`user_playlist`/`playlist_track_all_new`/`playlist_track_all`/`search`/`playlist_tracks_add`/`playlist_tracks_del`/`playlist_update` 等），不启动 HTTP 服务。
- **设备指纹**：token 与设备绑定（guid/mid/dev/dfid），持久化到 `userData/kugou-device.json`，跨重启保持；删除指纹文件会导致登录失效。
- **歌单列表规则**：仅显示自建/系统歌单，收藏的他人歌单（`type=1`）不显示；`is_mine` 恒为 0 不可用；过滤只作用于显示列表，写操作索引保留完整。过滤规则变更已 bump `PLAYLIST_CACHE_SCHEMA_VERSION` → 4。
- **歌曲拉取双路径**：自建歌单走云歌单接口（listid），收藏歌单走公开歌单接口（global_collection_id），任一路径返回空自动回退另一路径。
- **写操作**：加歌按 `名称|hash|album_id|mixsongid` 格式（元数据在搜索/拉歌单时缓存）；删歌按云歌单条目 fileid 而非 hash。
- **风控**：搜索错误 `error_code=1002` 判定为限流（rate-limited）。

### 补记 — Apple Music 平台接入 ✅
- **接入方式**：社区路径 Web API（适配器自实现）。登录：应用内网页登录窗口自动提取 `media-user-token` cookie；developer token 从 `music.apple.com` 网页前端 bundle 提取（JWT `payload.iss === 'AMPWebPlay'`），过期自动重抓。
- **双主机**：读接口走官方主机 `api.music.apple.com`；写接口（创建/追加/改名/删除）必须走 `amp-api.music.apple.com`（删除在官方主机固定 401）。仅 `/v1/me/` 路径带 `music-user-token` 头。
- **能力**：read + write，但**移除歌曲无官方端点**（`unsupportedOperations.removeSongs`，UI 层隐藏该操作）。建单/加曲单次上限 100 首，分批写入；新建歌单 iCloud 传播延迟，404 时 1.5s 重试一次。
- **搜索**：catalog search limit 上限 25，超限返回 400；搜索词把 ` - ` 替换为空格（整串带连字符易命中 Live 版）。

### 补记 — 后续演进（与历史条目相关的变更）✅
- **凭证存储**：keytar 未引入，改为 Electron `safeStorage` 加密落盘（ADR-003 已变更）。
- **缓存限流**：T12 的「手动强制刷新最小间隔 30s」已演进为令牌桶（容量 3、每 10s 补 1 令牌，`core/cachePolicy.ts` 的 `REFRESH_BUCKET_*`），令牌不足时静默降级返回缓存。
- **QQ音乐 genre 简化**：不再调用 `/song/genre` 接口，搜索条目直接映射 `item.genre`（上游恒为 0，genre 实际为空）。
- **schema 迁移压缩**：发布前将早期演进迁移 v1~v6 压缩为单一基线迁移（version=6，幂等），B14 的「迁移 v1 接管」描述对应压缩前历史；正式发布后 MIGRATIONS 只追加（version ≥ 7）。
- **React 版本**：工程实际采用 React 19（package.json），技术选型表已同步。
- 现状：typecheck、lint、全量 375 项测试、build 通过（四个平台：网易云/QQ音乐/酷狗/Apple Music）。

### 补记 — 同步匹配阶段并发化 ✅
- **需求**：同步导入逐首串行搜索 + 每首固定间隔（默认 500ms），等待时间占大头（500 首匹配约 10 分钟），要求提高同步执行效率、加快创建速度。
- **变更**（`core/sync/syncPlaylist.ts` planSync 重构 + `SyncOptions.searchConcurrency`）：
  - P0 受控并发池：`searchConcurrency`（默认 3、最小 1）个 worker 并发处理歌曲；`searchIntervalMs` 语义从「每首之间」演进为「全局相邻两次搜索请求的最小间隔」（预约式限速器，并发池共享）；输出按输入 index 顺序收敛（slots 槽位 + flush 连续前缀），`onStep`/`onProgress`/`onCheckpoint`/明细顺序与串行语义一致，中断恢复与明细落库不受影响。
  - P1 双关键词并行预取：同一首歌「歌名+歌手」与「纯歌名」并行发出（`maxSearchesPerSong` 预算内），组合精确命中直接采用组合结果，无精确命中时纯歌名结果立即可用（省一次串行 RTT）；任务内关键词缓存（normalize(keyword) 为 key，含在途 promise 去重避免并发重复请求，失败不缓存）。
  - 风控兜底：任一搜索被风控（`rateLimited`）触发全局冷却 4s（`RATE_LIMIT_COOLDOWN_MS`），后续发起暂停；重试退避逻辑不变。
  - P2 搜索超时收紧：60s→15s（`SEARCH_TIMEOUT_MS`，建单/加歌保持 60s），卡死请求快速失败进入退避重试。
  - 中止语义：abort 后在途请求完成保留（partial 按序收敛），不再发起新请求；skipCheck 每首歌处理开始时消耗，语义不变。
  - 手动确认无二次搜索确认：`executeSync` 直接复用 `plan.choices[].candidates`（plan 完整缓存在 `pendingSyncs`），确认后仅建单 + 分批写入。
- **验证**：新增 3 项测试（并发在途重叠、任务内关键词缓存、非法并发数回退为 1）；按并发语义更新 3 项既有断言（组合精确命中并行双发、风控双关键词失败不搜备选、中止在途保留后续不发起）。全量 374 项测试、typecheck、lint 通过。
- **旧记录注记**：T4 修复记录「500ms/首」限速已演进为全局最小间隔；T9 中止检查点语义保持（flush 按序收敛）。

### 补记 — 歌单添加歌曲搜索修复与分页增强 ✅
- **问题**：① 酷狗歌单内搜索输入什么都显示无结果；② 搜索结果按钮文案恒为「已添加」（未添加即显示已添加）；③ 搜索结果面板不随焦点离开收起；④ 搜索无滚动分页、清单无序号、分页哨兵要拉到空白行才请求下一页、搜索结果清单与歌单歌曲清单未复用组件。
- **修复**：
  - ① 根因：酷狗 `v2/search/song` 真实响应 `data.lists` 为**歌曲对象数组（flat）**，旧解析按嵌套数组 `lists[0]` 取值恒为空。改为 flat 解析并兼容嵌套协议版本（`Array.isArray(lists[0])` 判断）；`tests/platforms/kugou.test.ts` 搜索 mock 同步更新为真实结构并新增嵌套兼容用例。
  - ② 搜索结果按钮三态：未添加「添加」/ 添加中「添加中」（转圈）/ 已在歌单或刚添加成功「已添加」（禁用）；添加成功后结果行保留标记而非移除。
  - ③ 搜索面板聚焦展开、点击面板外（blur 且 relatedTarget 不在容器内）收起，结果保留。
  - ④ 搜索分页贯通：`PlatformAdapter.searchSongs`/`doSearch` 与 IPC `platform:search-songs`、preload 增加 `page`（默认 1）；四平台分页映射——酷狗 page/pagesize、QQ `/search` page（单页上限 20）、网易云 cloudsearch offset=(page-1)*limit、Apple catalog offset；渲染层统一单页 20 条，返回达上限视为还有下一页，`LoadMoreSentinel` 增加 rootMargin 提前 200px 预取（不等拉到空白行）；搜索结果清单带行号（复用 SongList 默认 showIndex）。
  - 组件复用：抽离 `renderer/src/components/SongSearchResults.tsx`（SongList + 分页哨兵 + 三态按钮），歌单详情「添加歌曲」与本地歌单「从平台添加」两处共用；本地歌单搜索结果由自绘行改为 SongList。
- **验证**：酷狗搜索 flat 结构 + 分页透传 + 嵌套兼容 3 处断言（1 项改写 + 1 项新增），网易云搜索断言补 offset 分页。全量 375 项测试、typecheck、lint 通过。待手工验收：酷狗歌单内搜索出结果、滚动提前加载下一页、按钮三态、点击歌单列表收起搜索面板。
- **追加修复**：① 搜索修复后仍无结果的根因是 dev 进程主进程未随代码修改重启（主进程日志最后启动时间早于修改时间，IPC 返回空但无报错），重启后生效——非代码缺陷；② 添加/移除歌曲成功后左侧歌单卡片歌曲数未即时同步，`handleAddSong`/`handleRemoveSong` 增补 `setPlaylists` 就地 ±1（`songCount` 为 undefined 的平台不动，主进程已标记缓存失效后台重新验证兜底）。
- **追加优化 — 登录态恢复提速（Ctrl+R 秒回）**：reload 后渲染层 `accounts` 内存丢失且初始化 `setAccounts` 等全部平台 `Promise.allSettled` 完成才一次设置，最慢平台（Apple Music 重抓 developer token 等）拖慢整体，期间全部显示未连接。修复：① 主进程新增 `main/loginStatusCache.ts` 登录态内存缓存——`platform:login-status` 命中缓存直接返回（渲染层 reload 主进程不重启，秒回），首次查询写入；扫码登录成功/登出/保活判定失效时清除，网页登录成功直接写入；② 渲染层初始化改为逐平台独立完成即 `setAccounts`，慢平台不阻塞快平台，失败平台保留 3s 重试。
- **追加优化 — 异常提示统一右上角 toast（不给用户看代码）**：歌单详情区顶端错误条与搜索区内联错误条移除，所有异常统一走 `renderer/src/utils/notifyError.ts`——右上角 toast 展示，平台中文可读文案作为详情，技术性报错（状态码/网络错误/堆栈等）过滤为通用标题；覆盖歌单拉取/打开/重命名/删除/增删歌曲/搜索/同步确认/登录异常/导入导出等全部错误路径；同步失败内联错误（TextCreator）与确认对话框内联错误一并移除（toast 已提示）。主进程歌单拉取（列表/歌曲，含分页）补 30s 超时包装，平台接口永久挂起时转为「请求超时」错误走 toast，不再一直 loading。

---

| 风险 | 缓解 |
|---|---|
| 平台 API 变更/风控 | 适配器接口解耦；限速 + 指数退避；文件导入作为降级通道 |
| native 模块 rebuild 失败 | T1 阶段先验证；DB 与凭证各有降级方案 |
| AI 生成代码引入安全漏洞 | ESLint + typecheck 作为提交门禁；凭证/输入校验集中处理并人工审查 |
| 上下文腐烂（context rot） | `CLAUDE.md` 精简；每任务独立会话；进展写入文档后 `/clear` |
| 测试自证 | 验收用例由人（或独立测试 agent）先写，实现 agent 不得修改测试文件 |

---

## 5. 决策记录（ADR 简表）

| 编号 | 决策 | 状态 |
|---|---|---|
| ADR-001 | 桌面壳选 Electron 而非 Tauri v2 | 已定，V1.0 可重新评估 |
| ADR-002 | core 层纯 TS、不依赖 Electron | 已定 |
| ADR-003 | 凭证用 keytar 系统钥匙串 | ⚠️ 已变更：实施时改为 Electron `safeStorage` 加密落盘（见补记），keytar 未引入 |
| ADR-004 | MVP 先做文本解析，平台同步后置 | 已定（遵循「最独立最易验证优先」） |
