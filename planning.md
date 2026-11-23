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
  - 采用 `@yakult-green-tea/qq-music-api@3.3.8` 的 serverless `handleRequest` 函数式调用（无本地 HTTP 服务），主进程内嵌。
  - `QQ_SESSION_SECRET` 随机生成后持久化到 userData（sealed token 依赖它解密，必须跨重启稳定）。
  - QQ 音乐适配器 9/9 测试通过（mock HttpHandler 验证映射与参数）。
  - 架构重构：主进程 `platformRegistry` 注册表 + 通用 `platform:*` IPC（platform 参数分发），替换原 netease 专属 IPC。
  - UI：登录区/歌单区双平台标签页；同步区增加「同步到」平台下拉。
  - 踩坑：ESM 下 `createRequire` 的 `const require` 与 electron-vite 注入的 require 冲突 → 改 ESM 具名导入 `handleRequest`。
- **待办**：用户手工验收（QQ音乐扫码登录 → 拉歌单 → 文本同步创建歌单）。

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
