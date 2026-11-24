# 技术规划与实施计划

> 对应 `PRD.md` 的 V0.1（MVP）。本文是「先规划、后编码」的落地产物，随实施迭代更新，用 git 版本管理。

---

## 1. 技术选型决策

| 领域 | 选择 | 理由 | 备选/迁移路径 |
|---|---|---|---|
| 桌面框架 | **Electron** | ① 核心约束是 AI 能可靠生成与调试代码，TS 全栈最友好；② 国内平台非官方 API 参考实现多为 Node.js 生态，可复用；③ 签名与自动更新链路成熟 | Tauri v2：若 V1.0 对包体积/内存敏感再迁移；core 层平台无关设计降低迁移成本 |
| 语言 | **TypeScript（strict）** | 类型即契约，AI 生成代码错误可在编译期暴露 | — |
| UI | React 18 + Vite + Tailwind CSS | AI 最熟悉的组合，快速出可用界面 | — |
| 状态管理 | Zustand | 轻量、样板代码少 | — |
| 本地存储 | better-sqlite3 | 同步 API、性能足够（万级歌曲）、类型友好 | V0.1 若 native rebuild 受阻，临时退化为 JSON 文件 + zod 校验 |
| 凭证存储 | keytar（系统钥匙串） | 满足 PRD「不明文落盘」硬性要求 | Electron `safeStorage`（仅加密不入钥匙串，降级） |
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
│   └── sync/      # 同步引擎：差异计算、增量、重试
├── platforms/     # 平台适配器（实现统一接口 PlatformAdapter）
│   ├── base.ts    # 接口定义与通用逻辑
│   ├── netease.ts # 网易云音乐
│   └── qqmusic.ts # QQ 音乐
├── main/          # Electron 主进程：IPC、数据库、凭证、平台适配器宿主
├── preload/       # 预加载脚本：安全的 contextBridge API
└── renderer/      # React UI
tests/
└── core/          # core 层单元测试（验收用例）
```

**设计约束**
- `core/` 禁止 import Electron、Node 内置模块或任何平台 SDK —— 保证可独立测试与可迁移
- 主进程与渲染进程通过 preload contextBridge 通信，`nodeIntegration: false`、`contextIsolation: true`
- 平台差异全部收敛在 `platforms/` 适配器内，core 只依赖 `PlatformAdapter` 接口
- 凭证只经主进程 keytar 读写，渲染进程永不接触原始凭证

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
  - 同步引擎：搜索限速（默认 500ms/首）+ 可重试错误指数退避重试（默认 2 次）+ 全部未匹配时不建单（失败明细保留）+ `rate-limited` 错误分类。
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
| ADR-003 | 凭证用 keytar 系统钥匙串 | 已定 |
| ADR-004 | MVP 先做文本解析，平台同步后置 | 已定（遵循「最独立最易验证优先」） |
