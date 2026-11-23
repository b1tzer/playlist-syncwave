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

## 代码风格
- TypeScript strict，禁止 `any`（用 `unknown` + 类型守卫）。
- 用户可见文案用简体中文；变量/函数/文件用英文。
- 不写解释性注释；只在「为什么」不直观处写一行。
- 依赖版本以 package.json 为准，不臆造不存在的包名或版本。

## 当前阶段
- V0.1 MVP。已完成：`PRD.md`、`planning.md`、工程骨架、T2 文本解析器、T3 匹配引擎 + 网易云适配器、T4 单向同步引擎 + 最小可用 UI。
- 扫码登录已验收通过；搜索风控（405 限流）已修复：同步引擎内置搜索限速与重试。
- 已验证的工具链版本：TypeScript 6.0.3（TS7 与 typescript-eslint 冲突）、Vite 8、Vitest 5、Electron 45。
- 网易云集成使用社区包 `NeteaseCloudMusicApi`（CJS），仅主进程通过 `createRequire` 加载。
- 主进程必须吞掉 stdout/stderr 的 EPIPE（NCM logger 写 console 会触发崩溃）。
- native 模块（better-sqlite3/keytar）尚未引入；引入前先验证 rebuild。
- npm 11 默认拦截安装脚本（如 electron 二进制），需 `npm install-scripts approve <pkg>` 后再 rebuild。
- 网易云 API 风控敏感：搜索请求需限速（>=500ms）并支持重试；连续快速请求会触发 405 风控。
