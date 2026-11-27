# Playlist-SyncWave

> 跨平台歌单同步桌面应用 —— 一款本地优先的桌面工具，帮你把任意国内音乐平台的歌单，快速创建并同步到目标平台。

**产品介绍页**：[https://b1tzer.github.io/playlist-syncwave/](https://b1tzer.github.io/playlist-syncwave/)

## 功能特性

- **快速建歌单**：粘贴文本 / 导入文件（m3u、csv、txt）/ 平台分享链接，自动探测格式并解析「歌名 - 歌手」批量创建歌单，全程无需手动选择格式
- **跨平台同步**：从网易云音乐、QQ 音乐、酷狗音乐、Apple Music 拉取歌单，经「标题 + 歌手」归一化精确匹配后写入目标平台；匹配阶段受控并发加速（并发搜索池 + 双关键词并行预取 + 关键词缓存 + 全局限速与限流冷却）；同歌不同作者时进入候选确认，由用户裁决
- **歌单管理**：右键新建、重命名、删除歌单，增删歌曲（平台搜索添加支持滚动分页与已添加标记）；歌曲列表带 # / 歌名 / 歌手 / 专辑 / 时长固定表头，支持鼠标点选、Shift 连选与拖拽多选并批量删除；平台歌单可整单保存到本地并显示封面，重复保存按来源增量更新、可合并到同一个本地歌单并显示来源平台；保留来源平台 id 与歌曲次级唯一标识；本地歌单库支持右键菜单（重命名 / 同步到 / 导出 / 删除）与导入导出（m3u / csv）
- **同步中心**：同步任务历史（按状态多选筛选，默认全部）、增量同步、跨平台歌曲映射缓存（人工确认优先）
- **歌曲与实体面板**：点击歌名弹出歌曲详情卡（封面 / 时长 / 歌手 / 专辑 / 发行时间 / 歌词预览与展开 / 来源平台，可在平台打开，卡内歌手 / 专辑可直接跳转查询）；点击歌手名显示该歌手的歌曲清单，点击专辑名显示发行时间与专辑曲目清单（支持网易云音乐、QQ 音乐、酷狗音乐，曲目可点击直达平台歌曲页）；同名歌手自动消歧，多候选时点选确认并记住选择，之后点击直达
- **账号安全**：扫码登录，凭证经系统钥匙串（safeStorage）加密仅主进程读写，日志全量脱敏
- **设置中心**：分组设置页 + 设置搜索；浅色 / 深色 / 跟随系统主题；匹配策略语义预设与搜索参数调优（高级区）；网络代理支持连通性测试；清空歌曲缓存危险区
- **桌面体验**：窗口状态记忆、系统通知、网络代理、自动更新、开机启动、崩溃恢复；`⌘/Ctrl+1..5` 切换视图、`⌘/Ctrl+N` 快速创建、`⌘/Ctrl+,` 打开设置（正式包不提供刷新与开发者工具入口）

## 支持平台

| 平台 | 角色 | 登录方式 |
|---|---|---|
| 网易云音乐 | 源 + 目标 | 二维码扫码 |
| QQ 音乐 | 源 + 目标 | 二维码扫码（QQ音乐 App / 微信 / 手机 QQ 三通道） |
| 酷狗音乐 | 源 + 目标 | 二维码扫码（登录凭证与设备指纹绑定） |
| Apple Music | 源 + 目标 | 网页登录（社区路径：网页前端 developer token + 登录 cookie） |

> Apple Music 说明：官方 API 支持创建/追加曲目/改名/删除歌单，但不提供「移除歌曲」端点（该操作不可用）；凭证由应用内登录窗口自动提取，无需开发者账号。官方 API 不提供用户资料接口；网页登录在 cookie 到手后立即显示已登录，随后在后台抓取页面昵称、跳转账户设置页读取 Apple ID 邮箱并自动刷新账号卡片（抓不到则显示地区码 UID）；邮箱仅存于本地加密凭证。
>
> 酷狗说明：歌单列表仅显示自建/系统歌单（收藏的他人歌单不显示）；写操作依赖设备指纹，删除 `kugou-device.json` 会导致登录失效。

同步仅操作用户自己账号下的歌单元数据，不绕过平台版权限制。

## 快速开始

### 开发

```bash
npm install
npx electron-builder install-app-deps   # 首次安装需将 better-sqlite3 rebuild 到 Electron ABI
npm run dev
```

> npm 11 默认拦截依赖安装脚本（如 Electron 二进制），首次安装需 `npm install-scripts approve <pkg>` 放行。

> 数据目录：正式版使用系统默认 `userData`（macOS 为 `~/Library/Application Support/playlist-sync/`），开发版自动隔离到其下的 `dev/` 子目录；如需自定义可设置 `PLAYLIST_USER_DATA_DIR`。

### 测试与检查

```bash
npm run test       # Vitest 单元测试
npm run typecheck  # TypeScript 全量类型检查
npm run lint       # ESLint
```

发布前依次执行 `npm run typecheck && npm run lint && npm run test && npm run build`，全部通过后再打包；人工验收已于 2026-11-25 完成（清单见 `planning.md` 第 5 节）。当前基线：552 项测试全部通过（含 jsdom + Testing Library 组件测试），另有 9 项真实网络链路验证可经 `LIVE_VERIFY=1 npx vitest run tests/live` 运行。

### 打包

```bash
npm run dist        # 当前平台安装包（electron-builder）
npm run dist:mac    # macOS：dmg / zip
npm run dist:win    # Windows：nsis
npm run dist:linux  # Linux：AppImage
```

### 发布流程

正式发布由 `git tag v<version>` 触发 `.github/workflows/release.yml`，流程为：校验 tag 与 `package.json` 版本一致 → 三平台**未签名**构建 → 生成 **draft release** → 人工复核安装包与更新元数据后转正式。回滚不要重发同版本，必须发布更高版本。

本项目不购买代码签名/公证证书，构建不校验、不提示签名凭据。未签名包的安装方式：

- **macOS**：打开 dmg/zip 后若被 Gatekeeper 拦截，右键安装包 →「打开」，或在「系统设置 → 隐私与安全性」中允许
- **Windows**：SmartScreen 提示时选择「更多信息」→「仍要运行」
- **Linux**：AppImage 直接运行即可，无需安装

应用内检查到新版本时会自动下载对应平台安装包并展示：macOS 打开 dmg、Windows 运行 NSIS 安装程序、Linux 在文件管理器中定位 AppImage，由你手动完成后续步骤；设置页可重新打开或定位安装包。

`workflow_dispatch` 仅用于构建预演：产出三平台 Artifacts，不发布。本地临时打包可直接用上面的 `npm run dist*`，但不会上传更新元数据。

更新源为 GitHub Releases（`electron-builder.yml` 的 `publish` 配置），无备用源。版本变更记录见 `CHANGELOG.md`。

## 产品介绍页

介绍页源码位于 `site/`，是零依赖的纯静态页面（HTML / CSS / JS + 平台 logo），直接打开 `site/index.html` 即可本地预览。页面产品截图取自应用实际运行界面，存放在 `site/assets/screenshots/`，示例歌单为本地演示数据。推送 `main` 分支上的 `site/` 或 `.github/workflows/pages.yml` 变更时，`.github/workflows/pages.yml` 会自动发布到 GitHub Pages；也可在 Actions 中手动触发 `pages` 工作流。

首次部署前需在仓库 **Settings → Pages → Build and deployment** 将 **Source** 设为 **GitHub Actions**；发布地址为 <https://b1tzer.github.io/playlist-syncwave/>。页面中的下载入口始终指向 GitHub Releases 的最新版本，不需要随应用版本手动改链接。

## 技术栈

- **桌面框架**：Electron + electron-vite
- **前端**：React + TypeScript（strict）+ Tailwind CSS + Zustand
- **数据**：better-sqlite3（WAL 模式，版本化 schema 迁移）
- **平台接入**：NeteaseCloudMusicApi（网易云）、@yakult-green-tea/qq-music-api（QQ 音乐 Node 模式）、kugoumusicapi（酷狗，库模式直调）、Apple Music Web API（社区路径，适配器自实现）
- **测试**：Vitest（+ jsdom / Testing Library 组件测试）
- **打包分发**：electron-builder + electron-updater

## 项目结构

```
src/
├── main/        # Electron 主进程（IPC、数据库、凭证存储、平台注册、日志）
├── preload/     # contextBridge 白名单（sandbox 环境，CJS 输出）
├── renderer/    # React 渲染层（i18n 中英双语）
├── core/        # 平台无关纯业务逻辑（文本解析、匹配引擎、同步引擎、缓存策略）
└── platforms/   # 插件化平台适配器（netease / qqmusic / ...）
tests/           # Vitest 单元测试
```

## 架构

- **分层约束**：`src/core/` 禁止依赖 Electron、Node 内建模块与任何平台 SDK，保证可被 Vitest 独立测试；平台差异全部收敛在 `src/platforms/`，core 只依赖 `PlatformAdapter` 接口。
- **插件化平台**：每个平台在 `src/platforms/<id>/` 导出 `PlatformModule`（元信息 + 适配器工厂），经 `import.meta.glob` 自动收集注册；新增平台只需实现适配器，无需修改历史代码。
- **同步金标准**：标题 + 歌手归一化精确相等自动选定；同歌不同作者走两阶段候选确认，由用户手动选择。

## 安全设计

- 凭证仅经主进程读写，Electron `safeStorage` 加密落盘，渲染进程永不接触原始凭证
- 渲染层 `sandbox: true` + `contextIsolation: true`，通信仅走 preload 白名单 IPC
- 凭证 / token / 会话绝不写入日志（`src/core/logging/redact.ts` 递归脱敏）
