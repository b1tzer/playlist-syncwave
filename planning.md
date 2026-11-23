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

### T3 — 匹配引擎 + 网易云平台适配器（读）
- **交付物**：`core/matcher`、`platforms/base.ts`、`platforms/netease.ts`，账号授权与歌单读取
- **验收**：扫码登录后可拉取歌单列表与歌曲；文本解析结果匹配到平台歌曲，置信度评分可用
- **边界情况**：登录过期、API 变更、限流、歌曲下架
- **验证命令**：`npm run test -- matcher` + 手工登录验收

### T4 — 单向同步引擎 + 最小可用 UI
- **交付物**：`core/sync`、`renderer` 最小界面（文本输入 → 预览 → 选择目标 → 同步 → 结果）
- **验收**：端到端跑通「粘贴文本 → 创建歌单 → 同步到网易云」，有进度与结果报告
- **边界情况**：部分失败、重复歌曲、网络中断重试
- **验证命令**：`npm run test` + 手工端到端验收

---

## 4. 风险与缓解

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
