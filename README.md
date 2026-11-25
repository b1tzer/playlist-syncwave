# Playlist-SyncWave

> 跨平台歌单同步桌面应用 —— 一款本地优先的桌面工具，帮你把任意国内音乐平台的歌单，快速创建并同步到目标平台。

## 功能特性

- **快速建歌单**：粘贴文本 / 导入文件（m3u、csv、txt）/ 平台分享链接，自动探测格式并解析「歌名 - 歌手」批量创建歌单，全程无需手动选择格式
- **跨平台同步**：从网易云音乐、QQ 音乐拉取歌单，经「标题 + 歌手」归一化精确匹配后写入目标平台；同歌不同作者时进入候选确认，由用户裁决
- **歌单管理**：创建、重命名、删除歌单，增删歌曲；本地歌单库与导入导出（m3u / csv）
- **同步中心**：同步任务历史、增量同步、跨平台歌曲映射缓存（人工确认优先）
- **账号安全**：扫码登录，凭证经系统钥匙串（safeStorage）加密仅主进程读写，日志全量脱敏
- **桌面体验**：窗口状态记忆、系统通知、网络代理、自动更新、开机启动、浅色 / 深色主题、崩溃恢复

## 支持平台

| 平台 | 角色 | 登录方式 |
|---|---|---|
| 网易云音乐 | 源 + 目标 | 二维码扫码 |
| QQ 音乐 | 源 + 目标 | 二维码扫码（QQ音乐 App / 微信 / 手机 QQ 三通道） |
| 酷狗音乐 | 源 + 目标 | 二维码扫码（登录凭证与设备指纹绑定） |
| Apple Music | 源 + 目标 | 网页登录（社区路径：网页前端 developer token + 登录 cookie） |

> Apple Music 说明：官方 API 支持创建/追加曲目/改名/删除歌单，但不提供「移除歌曲」端点（该操作不可用）；凭证由应用内登录窗口自动提取，无需开发者账号。
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

### 测试与检查

```bash
npm run test       # Vitest 单元测试
npm run typecheck  # TypeScript 全量类型检查
npm run lint       # ESLint
```

### 打包

```bash
npm run dist        # 当前平台安装包（electron-builder）
npm run dist:mac    # macOS：dmg / zip
npm run dist:win    # Windows：nsis
npm run dist:linux  # Linux：AppImage
```

发布前需配置签名证书（`CSC_LINK` / `CSC_KEY_PASSWORD`）与更新源地址（`SYNCWAVE_UPDATE_URL`），详见 `electron-builder.yml`。

## 技术栈

- **桌面框架**：Electron + electron-vite
- **前端**：React + TypeScript（strict）+ Tailwind CSS + Zustand
- **数据**：better-sqlite3（WAL 模式，版本化 schema 迁移）
- **平台接入**：NeteaseCloudMusicApi（网易云）、@yakult-green-tea/qq-music-api（QQ 音乐 Node 模式）、kugoumusicapi（酷狗，库模式直调）、Apple Music Web API（社区路径，适配器自实现）
- **测试**：Vitest
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
