import './appPaths'
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  nativeTheme,
  safeStorage,
  shell,
} from 'electron'
import { join, basename } from 'node:path'
import { setDefaultResultOrder } from 'node:dns'
import { readFileSync, writeFileSync, statSync } from 'node:fs'
import { platformModules } from '../platforms'
import { registerPlatform, getPlatform, resolveAdapter, listPlatforms } from './platformRegistry'
import type { AdapterContext } from '../platforms/meta'
import { executeSync } from '@core/sync/syncPlaylist'
import {
  SyncAbortedError,
  type SyncMatchedResource,
  type SyncSelection,
} from '@core/models/sync'
import type { MatchQuery } from '@core/models/match'
import { logCenter } from './logging/logCenter'
import { upsertSyncTask, listSyncTasks, removeSyncTask, clearSyncTasks } from './syncHistoryService'
import { getSetting, setSetting, getAllSettings, syncTuning, SETTINGS_DEFAULTS } from './settingsService'
import { restoreProxy, getProxySetting, setProxySetting, testProxy } from './proxy'
import { applySecurityHeaders } from './security'
import {
  saveConfirmedMapping,
  clearMappings,
  mappingStats,
} from './mappingService'
import {
  pendingSyncs,
  stoppedReport,
  createTaskCheckpoint,
  runSyncPipeline,
  resumePendingSyncTask,
  beginRunningSync,
  abortRunningSync,
  skipRunningSync,
  registerLocalPlaylistSyncTarget,
} from './syncPipeline'
import {
  broadcastAccountsChanged,
  startKeepAliveScheduler,
  stopKeepAliveScheduler,
} from './keepAliveService'
import {
  clearCachedLoginStatus,
  getCachedLoginStatus,
  setCachedLoginStatus,
} from './loginStatusCache'
import {
  listLocalPlaylists,
  createLocalPlaylist,
  renameLocalPlaylist,
  deleteLocalPlaylist,
  getLocalPlaylistSongs,
  addLocalPlaylistSongs,
  removeLocalPlaylistSongs,
} from './localPlaylistService'
import { importPlatformPlaylistToLocal } from './localPlaylistImportService'
import { loadWindowState, trackWindowState } from './windowState'
import { beginWebLogin } from './webLoginService'
import { buildApplicationMenu, installWindowShortcuts } from './menu'
import { setupAutoUpdater, checkForUpdates, openInstaller, setAutoUpdateEnabled } from './updater'
import { notifySyncResult, notifySyncStopped } from './notifications'
import { createPlaylistCacheService } from './playlistCacheService'
import { getDatabase, takePendingResumeTasks } from './appDatabase'
import type { SyncTaskRecord, SyncChoice } from '@core/models/sync'

// 部分网络环境 IPv6 无路由（连接报 EHOSTUNREACH，IPv6 立即失败不会触发
// 双栈回退），强制 DNS 解析优先返回 IPv4，避免平台接口请求优先尝试 IPv6 失败。
setDefaultResultOrder('ipv4first')

// Electron 从终端启动后管道可能已关闭（如启动命令退出），
// 此时任何 console 写入都会抛 EPIPE 导致应用崩溃。吞掉即可。
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE') return
    throw err
  })
}

const isDev = process.env.NODE_ENV === 'development'
const isMac = process.platform === 'darwin'

// Windows 开机启动依赖 AppUserModelID 与打包 appId 一致
if (process.platform === 'win32') {
  app.setAppUserModelId('com.syncwave.app')
}

// --- 单实例锁：二次启动聚焦已有窗口，避免多进程并发写同一 SQLite ---
const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })
}

// 歌单缓存服务：缓存兜底 + 后台重新验证（逐行 diff 更新）+ 单飞 + 手动刷新限流（内存态，随进程生命周期）
const playlistCache = createPlaylistCacheService(getDatabase().playlistCache)
const playlistCacheStore = getDatabase().playlistCache

/** 广播歌单缓存后台刷新结果到所有窗口（渲染层按 platform/playlistId 过滤） */
function broadcastPlaylistRefresh(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, payload)
    }
  }
}

// --- 日志中心：初始化文件输出并注册为全局默认传输 ---
logCenter.init()
const log = logCenter.logger('app', { level: isDev ? 'debug' : 'info' })
const ipcLog = logCenter.logger('ipc')

// --- 全局异常兜底：进程崩溃前留下最后一条错误日志 ---
process.on('uncaughtException', (error) => {
  logCenter.logger('app').error('app.uncaught-exception', '未捕获异常', error)
})
process.on('unhandledRejection', (reason) => {
  logCenter.logger('app').error('app.unhandled-rejection', '未处理的 Promise 拒绝', reason)
})

app.on('before-quit', () => {
  log.info('app.before-quit', '应用即将退出')
  stopKeepAliveScheduler()
  logCenter.flush()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

log.info('app.startup', '应用启动', {
  version: app.getVersion(),
  os: process.platform,
  electron: process.versions.electron,
  node: process.versions.node,
  logDir: join(app.getPath('userData'), 'logs'),
})

// 应用就绪后注册全部平台插件模块并预热（失败只影响对应平台，不阻塞启动）。
// 平台模块由 src/platforms/index.ts 自动收集，新增平台无需修改本文件。
app.whenReady().then(() => {
  const ctx: AdapterContext = { userDataDir: app.getPath('userData') }
  for (const mod of platformModules) {
    registerPlatform(mod, ctx)
  }
  for (const mod of platformModules) {
    resolveAdapter(mod.meta.id).catch((e) => {
      logCenter.logger('app').error('platform.prewarm-failed', '平台服务预热失败', e, {
        platform: mod.meta.id,
      })
    })
  }
  // 凭证保活：应用就绪后立即执行一轮并进入周期调度
  startKeepAliveScheduler()
})

/** 渲染进程崩溃弹窗防重入（单窗口应用仅一次提示） */
let crashDialogShown = false

/** 渲染进程崩溃：提示用户重启（应用数据已持久化，重启安全） */
function handleRenderProcessGone(reason: string): void {
  if (crashDialogShown) return
  crashDialogShown = true
  log.error('app.render-process-gone', '渲染进程异常退出', { reason })
  const zh = getSetting<string>('language', 'zh-CN') !== 'en-US'
  void dialog
    .showMessageBox({
      type: 'error',
      title: zh ? 'SyncWave 遇到问题' : 'SyncWave ran into a problem',
      message: zh ? '界面进程意外退出' : 'The interface process quit unexpectedly',
      detail: zh
        ? '数据已保存到本地。重启应用通常可以恢复；若反复出现，请反馈日志目录内容。'
        : 'Your data is saved locally. Restarting usually fixes this; please share your logs if it keeps happening.',
      buttons: [zh ? '重启应用' : 'Restart', zh ? '关闭' : 'Quit'],
      defaultId: 0,
      cancelId: 1,
    })
    .then(({ response }) => {
      if (response === 0) {
        app.relaunch()
        app.exit(0)
      } else {
        app.quit()
      }
    })
}

/** 与 renderer/styles.css 的 --sw-surface 保持一致；拉伸时新暴露区域先由原生窗口填色，避免白边 */
function windowBackgroundColor(): string {
  return nativeTheme.shouldUseDarkColors ? '#121318' : '#f7f7f9'
}

function syncWindowBackground(): void {
  const color = windowBackgroundColor()
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.setBackgroundColor(color)
  }
}

function createWindow(): void {
  const state = loadWindowState()
  const win = new BrowserWindow({
    width: state.width,
    height: state.height,
    x: state.x,
    y: state.y,
    backgroundColor: windowBackgroundColor(),
    // macOS 隐藏标题栏（红绿灯内嵌），标题文字不再显示；Windows 保留标准标题栏
    ...(isMac ? ({ titleBarStyle: 'hiddenInset' } as const) : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: isDev,
    },
  })

  if (state.maximized) win.maximize()
  trackWindowState(win)
  installWindowShortcuts(win)

  // 渲染进程崩溃兜底：除用户主动刷新导致的 killed 外均弹重启提示
  win.webContents.on('render-process-gone', (_event, details) => {
    if (details.reason === 'clean-exit') return
    handleRenderProcessGone(details.reason)
  })

  log.info('window.create', '创建主窗口', { dev: isDev })

  if (isDev && process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

ipcMain.handle('app:get-version', () => {
  ipcLog.debug('app.get-version', '查询应用版本')
  return app.getVersion()
})

// --- 自动更新（仅打包环境可用）---

ipcMain.handle('update:check', () =>
  ipcLog.time('update.check', async () => {
    await checkForUpdates()
  }),
)

ipcMain.handle('update:open-installer', () =>
  ipcLog.time('update.open-installer', async () => {
    await openInstaller()
  }),
)

// --- 网络代理 ---

ipcMain.handle('proxy:get', () => getProxySetting())

ipcMain.handle('proxy:set', (_event, url: unknown) =>
  ipcLog.time(
    'proxy.set',
    async () => {
      setProxySetting(url)
    },
    { url: typeof url === 'string' ? url : '' },
  ),
)

ipcMain.handle('proxy:test', (_event, url: unknown) =>
  ipcLog.time(
    'proxy.test',
    async () => {
      if (typeof url !== 'string' || url.trim() === '') throw new Error('无效的代理地址')
      return testProxy(url.trim())
    },
    { url: typeof url === 'string' ? url : '' },
  ),
)

// --- 开机启动：打包环境对接系统登录项，开发环境仅持久化偏好 ---

ipcMain.handle('app:get-auto-launch', () => {
  if (app.isPackaged) {
    return app.getLoginItemSettings().openAtLogin
  }
  return getSetting<boolean>('autoLaunch', false)
})

ipcMain.handle('app:set-auto-launch', (_event, enabled: unknown) => {
  if (typeof enabled !== 'boolean') throw new Error('无效的开机启动参数')
  setSetting('autoLaunch', enabled)
  if (app.isPackaged) {
    app.setLoginItemSettings({ openAtLogin: enabled })
  }
  ipcLog.info('app.set-auto-launch', '开机启动设置已应用', { enabled, packaged: app.isPackaged })
})

/** 文件导入大小上限 */
const MAX_IMPORT_BYTES = 5 * 1024 * 1024
/** 导出内容大小上限 */
const MAX_EXPORT_BYTES = 20 * 1024 * 1024

/** 打开文件选择器读取歌单文本文件（m3u/m3u8/csv/txt/lrc/json），取消返回 null */
ipcMain.handle('app:open-text-file', async () => {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  if (!win) return null
  const zh = getSetting<string>('language', 'zh-CN') !== 'en-US'
  const result = await dialog.showOpenDialog(win, {
    title: zh ? '选择歌单文件' : 'Choose playlist file',
    properties: ['openFile'],
    filters: [
      {
        name: zh ? '歌单文件' : 'Playlist files',
        extensions: ['m3u', 'm3u8', 'csv', 'txt', 'lrc', 'json'],
      },
      { name: zh ? '所有文件' : 'All files', extensions: ['*'] },
    ],
  })
  if (result.canceled || result.filePaths.length === 0) return null
  const filePath = result.filePaths[0]
  try {
    const size = statSync(filePath).size
    if (size > MAX_IMPORT_BYTES) {
      throw new Error(zh ? '文件过大（上限 5MB）' : 'File too large (5MB limit)')
    }
    const content = readFileSync(filePath, 'utf-8').replace(/^\uFEFF/, '')
    ipcLog.info('app.open-text-file', '读取歌单文件', { name: basename(filePath), size })
    return { name: basename(filePath), content }
  } catch (e) {
    ipcLog.error('app.open-text-file', '读取文件失败', e)
    throw e
  }
})

/** 保存文本文件（歌单导出）：选择保存位置后写入，取消返回 null */
ipcMain.handle(
  'app:save-text-file',
  async (_event, defaultName: unknown, content: unknown, extension: unknown) => {
    if (typeof defaultName !== 'string' || typeof content !== 'string' || typeof extension !== 'string') {
      throw new Error('无效的导出参数')
    }
    if (content.length > MAX_EXPORT_BYTES) throw new Error('导出内容过大')
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    if (!win) return null
    const zh = getSetting<string>('language', 'zh-CN') !== 'en-US'
    const safeName = defaultName.replace(/[\\/:*?"<>|]/g, '_').slice(0, 80) || 'playlist'
    const result = await dialog.showSaveDialog(win, {
      title: zh ? '导出歌单' : 'Export playlist',
      defaultPath: `${safeName}.${extension}`,
      filters: [
        { name: extension.toUpperCase(), extensions: [extension] },
        { name: zh ? '所有文件' : 'All files', extensions: ['*'] },
      ],
    })
    if (result.canceled || !result.filePath) return null
    writeFileSync(result.filePath, content, 'utf-8')
    ipcLog.info('app.save-text-file', '导出文件已保存', { name: basename(result.filePath) })
    return result.filePath
  },
)

ipcMain.handle('crypto:encrypt', (_event, plain: string) => {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('系统加密不可用')
  }
  ipcLog.debug('crypto.encrypt', '加密数据', { length: plain.length })
  return safeStorage.encryptString(plain).toString('base64')
})

// 浏览器/平台应用深链打开的白名单：拦截未知 scheme 防注入
const EXTERNAL_SCHEMES = new Set(['http:', 'https:', 'orpheus:', 'qqmusic:'])

ipcMain.handle('app:open-external', async (_event, url: unknown) => {
  if (typeof url !== 'string' || !url.trim()) throw new Error('无效的链接')
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error('无效的链接')
  }
  if (!EXTERNAL_SCHEMES.has(parsed.protocol)) {
    ipcLog.warn('app.open-external', '拦截未知协议的链接', { scheme: parsed.protocol })
    throw new Error('不允许打开的链接类型')
  }
  ipcLog.info('app.open-external', '打开外部链接', { scheme: parsed.protocol })
  await shell.openExternal(url)
})

// --- 渲染进程日志通道：校验后转发到统一日志管线 ---
ipcMain.on('log:write', (_event, entry: unknown) => {
  logCenter.writeRendererEntry(entry)
})

// --- 多平台通用 IPC（platform 参数分发）---

ipcMain.handle('platform:list', () => {
  ipcLog.debug('platform.list', '查询平台列表')
  return listPlatforms()
})

ipcMain.handle('platform:create-qr', (_event, platform: string, channel?: string) =>
  ipcLog.time(
    'platform.create-qr',
    async () => {
      const adapter = await resolveAdapter(platform)
      // 空字符串不是有效渠道（渲染层历史 bug 曾传空串给 QQ音乐 API 导致 400）
      const normalized = channel?.trim() || undefined
      return adapter.createQrLogin(normalized)
    },
    { platform, channel: channel?.trim() || 'default' },
  ),
)

/**
 * 网页登录（无扫码接口的平台，如 Apple Music）：
 * cookie 到手立即落最小凭证并返回临时登录态，界面不再等待后台抓取；
 * 凭证校验、昵称/邮箱补全在后台串行执行，完成后广播 accounts:changed 刷新。
 * 用户关闭窗口或超时返回 null。
 */
ipcMain.handle('platform:begin-web-login', (_event, platform: string) =>
  ipcLog.time(
    'platform.begin-web-login',
    async () => {
      const services = getPlatform(platform)
      const webLogin = services.meta.webLogin
      if (services.meta.loginType !== 'web' || !webLogin) {
        throw new Error('该平台不支持网页登录')
      }
      const adapter = await resolveAdapter(platform)

      // 后台任务串行：先校验凭证，再把页面抓到的资料补进凭证
      let chain: Promise<void> = Promise.resolve()
      const queue = (task: () => Promise<void>) => {
        chain = chain.then(task).catch((e) => {
          ipcLog.warn('platform.web-login-background', '后台登录任务失败', {
            platform,
            message: e instanceof Error ? e.message : String(e),
          })
        })
      }
      const notify = () => broadcastAccountsChanged(platform)

      const loginResult = await beginWebLogin(
        webLogin.url,
        webLogin.cookieName,
        webLogin.cookieUrl,
        services.meta.name,
        webLogin.profileSelector,
        webLogin.accountProbe,
        {
          onCookie: (cookie) => {
            // 先落最小凭证：其他页面立即视为已登录，首次请求会自动补齐 developer token
            services.saveCredential(
              JSON.stringify({
                v: 1,
                mediaUserToken: cookie,
                developerToken: '',
                devTokenAt: 0,
              }),
            )
            setCachedLoginStatus(platform, {
              platform,
              userId: '',
              nickname: services.meta.name,
              pending: true,
            })
            notify()
            queue(async () => {
              try {
                const provisional = services.getCredential()
                if (!provisional) return
                const kept = await adapter.keepAlive(provisional)
                if (kept.cookie) services.saveCredential(kept.cookie)
                const credential = services.getCredential() ?? provisional
                const account = await adapter.getLoginStatus(credential)
                if (!account) throw new Error('登录未生效')
                setCachedLoginStatus(platform, account)
                ipcLog.info('platform.begin-web-login', '凭证校验完成，登录态已刷新', {
                  platform,
                })
              } catch (e) {
                services.logout()
                clearCachedLoginStatus(platform)
                throw e
              } finally {
                notify()
              }
            })
          },
          onProfile: (profile) => {
            queue(async () => {
              const current = services.getCredential()
              if (!current) return
              const updated =
                profile && adapter.withWebLoginProfile
                  ? adapter.withWebLoginProfile(current, profile)
                  : current
              if (updated !== current) services.saveCredential(updated)
              const account = await adapter.getLoginStatus(updated)
              if (account) setCachedLoginStatus(platform, account)
              ipcLog.debug('platform.begin-web-login', '后台账号资料已补全（不记录值）', {
                platform,
                hasNickname: Boolean(profile?.nickname),
                hasEmail: Boolean(profile?.email),
              })
              notify()
            })
          },
        },
      )
      if (!loginResult) {
        ipcLog.info('platform.begin-web-login', '网页登录取消', { platform })
        return null
      }
      ipcLog.info('platform.begin-web-login', '会话 cookie 已到手，立即返回登录态', {
        platform,
      })
      return { platform, userId: '', nickname: services.meta.name, pending: true }
    },
    { platform },
  ),
)

ipcMain.handle('platform:check-qr', (_event, platform: string, key: string) =>
  ipcLog.time(
    'platform.check-qr',
    async () => {
      const services = getPlatform(platform)
      const adapter = await resolveAdapter(platform)
      const result = await adapter.checkQrLogin(key)
      if (result.status === 'success' && result.cookie) {
        services.saveCredential(result.cookie)
        // 凭证已更换：清缓存，渲染层下次 login-status 查询用新凭证并重新缓存
        clearCachedLoginStatus(platform)
        ipcLog.info('platform.check-qr', '扫码登录成功，凭证已保存', { platform })
      }
      return result
    },
    { platform },
    // 轮询接口高频调用，完成日志降为 debug
    'debug',
  ),
)

ipcMain.handle('platform:login-status', (_event, platform: string) =>
  ipcLog.time(
    'platform.login-status',
    async () => {
      const services = getPlatform(platform)
      const credential = services.getCredential()
      if (!credential) return null
      // 渲染层 reload（Ctrl+R）后主进程缓存直接命中，避免每平台全量网络查询拖慢界面
      const cached = getCachedLoginStatus(platform)
      if (cached !== undefined) return cached
      const adapter = await resolveAdapter(platform)
      const account = await adapter.getLoginStatus(credential)
      setCachedLoginStatus(platform, account)
      return account
    },
    { platform },
  ),
)

ipcMain.handle('platform:logout', (_event, platform: string) =>
  ipcLog.time(
    'platform.logout',
    async () => {
      clearCachedLoginStatus(platform)
      getPlatform(platform).logout()
    },
    { platform },
  ),
)

/** 歌单类 IPC 的统一前置：已登录平台 + 凭证 */
async function withPlaylistCredential(platform: string) {
  const services = getPlatform(platform)
  const credential = services.getCredential()
  if (!credential) throw new Error('尚未登录')
  const adapter = await resolveAdapter(platform)
  return { credential, adapter }
}

ipcMain.handle('platform:user-playlists', (_event, platform: string, force?: boolean) =>
  ipcLog.time(
    'platform.user-playlists',
    async () => {
      const { credential, adapter } = await withPlaylistCredential(platform)
      const result = await playlistCache.playlists(
        platform,
        // 登录态校验并入实际拉取路径：缓存命中时不产生平台请求；平台挂起时超时转错
        () =>
          withTimeout(
            (async () => {
              const account = await adapter.getLoginStatus(credential)
              if (!account) throw new Error('登录已过期，请重新扫码')
              return adapter.getUserPlaylists(credential, account.userId)
            })(),
            PLAYLIST_FETCH_TIMEOUT_MS,
          ),
        {
          force: force === true,
          onRefreshed: (event) =>
            broadcastPlaylistRefresh('playlist:list-refreshed', { platform, ...event }),
        },
      )
      ipcLog.info('platform.user-playlists', '歌单列表返回', {
        platform,
        count: result.data.length,
        fromCache: result.fromCache,
        stale: result.stale === true,
        force: force === true,
      })
      return result
    },
    { platform, force: force === true },
  ),
)

ipcMain.handle(
  'platform:playlist-songs',
  (_event, platform: string, playlistId: string, force?: boolean) =>
    ipcLog.time(
      'platform.playlist-songs',
      async () => {
        const { credential, adapter } = await withPlaylistCredential(platform)
        const result = await playlistCache.songs(
          platform,
          playlistId,
          () =>
            withTimeout(
              adapter.getPlaylistSongs(credential, playlistId),
              PLAYLIST_FETCH_TIMEOUT_MS,
            ),
          {
            force: force === true,
            onRefreshed: (event) =>
              broadcastPlaylistRefresh('playlist:songs-refreshed', { platform, playlistId, ...event }),
          },
        )
        ipcLog.info('platform.playlist-songs', '歌单歌曲返回', {
          platform,
          playlistId,
          count: result.data.length,
          fromCache: result.fromCache,
          stale: result.stale === true,
          force: force === true,
        })
        return result
      },
      { platform, playlistId, force: force === true },
    ),
)

/** 缓存全量切片出 offset/limit 一页，供渲染层滚动分页使用 */
function slicePage<T>(data: T[], offset: number, limit: number) {
  const from = Math.max(0, Math.floor(Number(offset) || 0))
  const size = Math.min(200, Math.max(1, Math.floor(Number(limit) || 200)))
  return { items: data.slice(from, from + size), total: data.length }
}

/** 歌单数据拉取超时：平台接口永久挂起时转为错误，渲染层 toast 提示而非一直 loading */
const PLAYLIST_FETCH_TIMEOUT_MS = 30_000
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('请求超时，请稍后重试')), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

ipcMain.handle(
  'platform:playlist-songs-page',
  (
    _event,
    platform: string,
    playlistId: string,
    offset: number,
    limit: number,
    force?: boolean,
    silent?: boolean,
  ) =>
    ipcLog.time(
      'platform.playlist-songs-page',
      async () => {
        const { credential, adapter } = await withPlaylistCredential(platform)
        const result = await playlistCache.songs(
          platform,
          playlistId,
          () =>
            withTimeout(
              adapter.getPlaylistSongs(credential, playlistId),
              PLAYLIST_FETCH_TIMEOUT_MS,
            ),
          {
            force: force === true,
            silent: silent === true,
            onRefreshed: (event) =>
              broadcastPlaylistRefresh('playlist:songs-refreshed', { platform, playlistId, ...event }),
          },
        )
        const page = slicePage(result.data, offset, limit)
        ipcLog.info('platform.playlist-songs-page', '歌单歌曲分页返回', {
          platform,
          playlistId,
          offset,
          limit,
          total: page.total,
          fromCache: result.fromCache,
          stale: result.stale === true,
        })
        return {
          ...page,
          fromCache: result.fromCache,
          stale: result.stale === true,
        }
      },
      { platform, playlistId, offset, limit },
    ),
)

ipcMain.handle(
  'platform:user-playlists-page',
  (
    _event,
    platform: string,
    offset: number,
    limit: number,
    force?: boolean,
    silent?: boolean,
  ) =>
    ipcLog.time(
      'platform.user-playlists-page',
      async () => {
        const { credential, adapter } = await withPlaylistCredential(platform)
        const result = await playlistCache.playlists(
          platform,
          () =>
            withTimeout(
              (async () => {
                const account = await adapter.getLoginStatus(credential)
                if (!account) throw new Error('登录已过期，请重新扫码')
                return adapter.getUserPlaylists(credential, account.userId)
              })(),
              PLAYLIST_FETCH_TIMEOUT_MS,
            ),
          {
            force: force === true,
            silent: silent === true,
            onRefreshed: (event) =>
              broadcastPlaylistRefresh('playlist:list-refreshed', { platform, ...event }),
          },
        )
        const page = slicePage(result.data, offset, limit)
        ipcLog.info('platform.user-playlists-page', '歌单列表分页返回', {
          platform,
          offset,
          limit,
          total: page.total,
          fromCache: result.fromCache,
          stale: result.stale === true,
        })
        return {
          ...page,
          fromCache: result.fromCache,
          stale: result.stale === true,
        }
      },
      { platform, offset, limit },
    ),
)

ipcMain.handle(
  'platform:search-songs',
  (_event, platform: string, keyword: string, limit?: number, page?: number) =>
    ipcLog.time(
      'platform.search-songs',
      async () => {
        const { credential, adapter } = await withPlaylistCredential(platform)
        // 限速与风控由平台适配器/同步引擎负责；这里仅约束单次数量与页码
        const capped = Math.min(Math.max(1, Math.floor(limit ?? 30)), 50)
        const pageNum = Math.max(1, Math.floor(Number(page) || 1))
        return adapter.searchSongs(credential, keyword, capped, pageNum)
      },
      { platform, keyword, page },
    ),
)

ipcMain.handle(
  'platform:playlist-rename',
  (_event, platform: string, playlistId: string, name: string) =>
    ipcLog.time(
      'platform.playlist-rename',
      async () => {
        if (typeof name !== 'string' || !name.trim()) throw new Error('歌单名不能为空')
        const { credential, adapter } = await withPlaylistCredential(platform)
        await adapter.renamePlaylist(credential, playlistId, name.trim())
        // 就地同步缓存中的歌单名：不清缓存，避免旧名兜底闪回
        playlistCacheStore.updatePlaylistName(platform, playlistId, name.trim())
        ipcLog.info('platform.playlist-rename', '歌单重命名完成', { platform, playlistId })
      },
      { platform, playlistId },
    ),
)

ipcMain.handle('platform:playlist-create', (_event, platform: string, name: string) =>
  ipcLog.time(
    'platform.playlist-create',
    async () => {
      if (typeof name !== 'string' || !name.trim()) throw new Error('歌单名不能为空')
      const { credential, adapter } = await withPlaylistCredential(platform)
      const playlistId = await adapter.createPlaylist(credential, name.trim())
      playlistCacheStore.markStalePlaylists(platform)
      ipcLog.info('platform.playlist-create', '歌单创建完成', { platform, playlistId })
      return playlistId
    },
    { platform },
  ),
)

ipcMain.handle('platform:playlist-delete', (_event, platform: string, playlistId: string) =>
  ipcLog.time(
    'platform.playlist-delete',
    async () => {
      const { credential, adapter } = await withPlaylistCredential(platform)
      await adapter.deletePlaylist(credential, playlistId)
      playlistCacheStore.removePlaylist(platform, playlistId)
      playlistCacheStore.markStaleSongs(platform, playlistId)
      ipcLog.info('platform.playlist-delete', '歌单删除完成', { platform, playlistId })
    },
    { platform, playlistId },
  ),
)

ipcMain.handle(
  'platform:playlist-remove-songs',
  (_event, platform: string, playlistId: string, songIds: string[]) =>
    ipcLog.time(
      'platform.playlist-remove-songs',
      async () => {
        if (!Array.isArray(songIds)) throw new Error('无效的歌曲列表')
        const { credential, adapter } = await withPlaylistCredential(platform)
        await adapter.removeSongsFromPlaylist(credential, playlistId, songIds)
        playlistCacheStore.markStaleSongs(platform, playlistId)
        playlistCacheStore.markStalePlaylists(platform)
        ipcLog.info('platform.playlist-remove-songs', '移除歌曲完成', {
          platform,
          playlistId,
          count: songIds.length,
        })
      },
      { platform, playlistId, count: Array.isArray(songIds) ? songIds.length : 0 },
    ),
)

ipcMain.handle(
  'platform:playlist-add-songs',
  (_event, platform: string, playlistId: string, songIds: string[]) =>
    ipcLog.time(
      'platform.playlist-add-songs',
      async () => {
        if (!Array.isArray(songIds)) throw new Error('无效的歌曲列表')
        const { credential, adapter } = await withPlaylistCredential(platform)
        await adapter.addSongsToPlaylist(credential, playlistId, songIds)
        playlistCacheStore.markStaleSongs(platform, playlistId)
        playlistCacheStore.markStalePlaylists(platform)
        ipcLog.info('platform.playlist-add-songs', '添加歌曲完成', {
          platform,
          playlistId,
          count: songIds.length,
        })
      },
      { platform, playlistId, count: Array.isArray(songIds) ? songIds.length : 0 },
    ),
)

// 运行控制（runningSyncs / abort / skip）与执行核心已提取到 syncPipeline，
// 由同步发起与重启恢复执行共用；此处不再保留本地副本。

ipcMain.handle(
  'platform:sync-playlist',
  (
    event,
    platform: string,
    payload: {
      taskId: string
      queries: MatchQuery[]
      playlistName: string
      /** 渲染层按当前语言格式化的今日日期：歌单名留空时与第一首歌风格拼成默认名 */
      autoNameDate?: string
      batchSize?: number
      /** 重新执行时复用上次已匹配结果：dupKey -> songId，命中后跳过搜索 */
      reuseMatches?: Array<{ key: string; songId: string; matchedSong?: SyncMatchedResource }>
      /** 来源本地歌单 id：同步建单成功后登记反向关联（本地列表点亮平台 logo） */
      sourceLocalPlaylistId?: string
    },
  ) =>
    ipcLog.time(
      'platform.sync-playlist',
      async () => {
        const taskId = payload.taskId || `sync-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        // 主进程侧检查点持久化：执行中定期落库，应对渲染进程崩溃/应用突然中断
        const checkpoint = createTaskCheckpoint(taskId)
        const notify = (ratio: number, stage: 'matching' | 'adding') => {
          checkpoint.onProgress(ratio)
          if (!event.sender.isDestroyed()) {
            event.sender.send('sync:progress', { platform, taskId, ratio, stage })
          }
        }
        const control = beginRunningSync(taskId)
        try {
          const report = await runSyncPipeline({
            platform,
            taskId,
            queries: payload.queries,
            playlistName: payload.playlistName,
            autoNameDate: payload.autoNameDate,
            batchSize: payload.batchSize,
            reuseMatches: payload.reuseMatches,
            sourceLocalPlaylistId: payload.sourceLocalPlaylistId,
            signal: control.signal,
            skipCheck: control.skipCheck,
            onStep: (item) => {
              if (!event.sender.isDestroyed()) {
                event.sender.send('sync:step', { taskId, item })
              }
              checkpoint.onStep(item)
            },
            onProgress: notify,
            onCheckpoint: checkpoint.onCheckpoint,
            onChoiceNeeded: (plan, finalName, target, batchSize, playlistId) => {
              pendingSyncs.set(taskId, {
                platform,
                plan,
                target,
                playlistName: finalName,
                playlistId,
                batchSize,
                sourceLocalPlaylistId: payload.sourceLocalPlaylistId,
              })
            },
          })
          return { taskId, report }
        } finally {
          control.done()
        }
      },
      { platform, taskId: payload.taskId, playlistName: payload.playlistName, total: payload.queries.length },
    ),
)

/** 停止运行中的同步任务：引擎在下一个检查点中止，已完成部分保留 */
ipcMain.handle('platform:stop-sync', (_event, taskId: string) =>
  ipcLog.time(
    'platform.stop-sync',
    async () => {
      if (abortRunningSync(taskId)) {
        ipcLog.info('platform.stop-sync', '已请求停止同步任务', { taskId })
      }
      // 待确认会话也允许停止（等同放弃选择）
      if (pendingSyncs.delete(taskId)) {
        ipcLog.info('platform.stop-sync', '待确认同步会话已放弃', { taskId })
      }
    },
    { taskId },
  ),
)

/** 跳过当前歌曲：引擎在该曲处理结束后放弃当前曲，从下一首继续 */
ipcMain.handle('platform:skip-sync', (_event, taskId: string) =>
  ipcLog.time(
    'platform.skip-sync',
    async () => {
      if (skipRunningSync(taskId)) {
        ipcLog.info('platform.skip-sync', '已请求跳过当前歌曲', { taskId })
      }
    },
    { taskId },
  ),
)

// --- 同步历史（SQLite 持久化）---

ipcMain.handle('sync-history:list', () =>
  ipcLog.time('sync-history.list', async () => listSyncTasks(), undefined, 'debug'),
)

ipcMain.handle('sync-history:upsert', (_event, task: SyncTaskRecord) =>
  ipcLog.time(
    'sync-history.upsert',
    async () => {
      upsertSyncTask(task)
    },
    { taskId: task.id, status: task.status, progress: task.progress },
    // 进度更新时高频写入，完成日志降为 debug
    'debug',
  ),
)

ipcMain.handle('sync-history:remove', (_event, id: string) =>
  ipcLog.time(
    'sync-history.remove',
    async () => {
      removeSyncTask(id)
    },
    { taskId: id },
  ),
)

ipcMain.handle('sync-history:clear', () =>
  ipcLog.time('sync-history.clear', async () => {
    clearSyncTasks()
  }),
)

// --- 本地歌单库 ---

ipcMain.handle('local-playlist:list', () =>
  ipcLog.time(
    'local-playlist.list',
    async () => listLocalPlaylists(),
    undefined,
    'debug',
  ),
)

ipcMain.handle('local-playlist:create', (_event, name: unknown, songs: unknown) =>
  ipcLog.time(
    'local-playlist.create',
    async () => createLocalPlaylist(name, songs),
    { songCount: Array.isArray(songs) ? songs.length : 0 },
  ),
)

ipcMain.handle(
  'local-playlist:import-platform',
  (_event, platform: unknown, playlist: unknown, targetId?: unknown) =>
    ipcLog.time(
      'local-playlist.import-platform',
      async () => {
        const result = await importPlatformPlaylistToLocal(platform, playlist, targetId)
        broadcastPlaylistRefresh('local-playlist:changed', { id: result.playlist.id })
        return result
      },
      { platform: String(platform ?? '') },
    ),
)

ipcMain.handle('local-playlist:rename', (_event, id: unknown, name: unknown) =>
  ipcLog.time(
    'local-playlist.rename',
    async () => {
      renameLocalPlaylist(id, name)
    },
    { id: String(id) },
  ),
)

ipcMain.handle('local-playlist:delete', (_event, id: unknown) =>
  ipcLog.time(
    'local-playlist.delete',
    async () => {
      deleteLocalPlaylist(id)
    },
    { id: String(id) },
  ),
)

ipcMain.handle('local-playlist:songs', (_event, id: unknown) =>
  ipcLog.time(
    'local-playlist.songs',
    async () => getLocalPlaylistSongs(id),
    { id: String(id) },
    'debug',
  ),
)

ipcMain.handle('local-playlist:add-songs', (_event, id: unknown, songs: unknown) =>
  ipcLog.time(
    'local-playlist.add-songs',
    async () => {
      addLocalPlaylistSongs(id, songs)
    },
    { id: String(id), count: Array.isArray(songs) ? songs.length : 0 },
  ),
)

ipcMain.handle('local-playlist:remove-songs', (_event, id: unknown, positions: unknown) =>
  ipcLog.time(
    'local-playlist.remove-songs',
    async () => {
      removeLocalPlaylistSongs(id, positions)
    },
    { id: String(id), count: Array.isArray(positions) ? positions.length : 0 },
  ),
)

// --- 应用设置（SQLite 持久化）---

ipcMain.handle('settings:get-all', () =>
  ipcLog.time('settings.get-all', async () => getAllSettings(), undefined, 'debug'),
)

// 首帧同步快照：preload 在渲染进程启动前取回，避免语言/主题异步恢复导致的闪烁与卡顿
ipcMain.on('settings:initial', (event) => {
  event.returnValue = {
    language: getSetting<string>('language', 'zh-CN'),
    theme: getSetting<string>('theme', SETTINGS_DEFAULTS.theme),
  }
})

ipcMain.handle('settings:set', (_event, key: string, value: unknown) =>
  ipcLog.time(
    'settings.set',
    async () => {
      if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
        throw new Error('不支持的设置值类型')
      }
      setSetting(key, value)
      // 语言变更时重建菜单（菜单文案在主进程侧，不依赖渲染层 i18n）
      if (key === 'language') buildApplicationMenu()
      // 自动更新开关：实时生效（关闭取消静默检查，开启重新计划）
      if (key === 'autoUpdateEnabled' && typeof value === 'boolean') {
        setAutoUpdateEnabled(value)
      }
      // 主题变更：同步原生 UI 主题源（light/dark/system），渲染层经媒体查询联动
      if (key === 'theme' && (value === 'light' || value === 'dark' || value === 'system')) {
        nativeTheme.themeSource = value
        syncWindowBackground()
      }
    },
    { key },
    'debug',
  ),
)

ipcMain.handle('settings:get', (_event, key: string, fallback: unknown) =>
  ipcLog.time(
    'settings.get',
    async () => {
      if (
        typeof fallback !== 'string' &&
        typeof fallback !== 'number' &&
        typeof fallback !== 'boolean'
      ) {
        throw new Error('不支持的默认值类型')
      }
      return getSetting(key, fallback)
    },
    { key },
    'debug',
  ),
)

// --- 缓存清理（设置页「数据」危险区）---

ipcMain.handle('cache:clear', () =>
  ipcLog.time('cache.clear', async () => getDatabase().playlistCache.clearAll(), undefined, 'info'),
)

// --- 歌曲映射缓存 ---

ipcMain.handle('mappings:confirm', (_event, platform: string, choice: SyncChoice, songId: string) =>
  ipcLog.time(
    'mappings.confirm',
    async () => {
      saveConfirmedMapping(platform, choice, songId)
    },
    { platform, songId },
    'debug',
  ),
)

ipcMain.handle('mappings:clear', (_event, platform: string) =>
  ipcLog.time(
    'mappings.clear',
    async () => {
      clearMappings(platform)
    },
    { platform },
  ),
)

ipcMain.handle('mappings:stats', () =>
  ipcLog.time('mappings.stats', async () => mappingStats(), undefined, 'debug'),
)

/**
 * 查询当前待确认的同步会话：渲染进程刷新/重新加载后据此恢复确认窗口。
 * 单窗口应用同一时刻至多一个待确认会话，返回数组以便后续扩展。
 */
ipcMain.handle('platform:pending-confirm', () =>
  ipcLog.time(
    'platform.pending-confirm',
    async () =>
      Array.from(pendingSyncs.entries()).map(([taskId, p]) => ({
        taskId,
        platform: p.platform,
        playlistName: p.playlistName,
        choices: p.plan.choices,
      })),
    undefined,
    'debug',
  ),
)

ipcMain.handle('platform:cancel-sync', (_event, taskId: string) =>
  ipcLog.time(
    'platform.cancel-sync',
    async () => {
      // 幂等：会话不存在（已完成/已过期）也视为取消成功
      if (pendingSyncs.delete(taskId)) {
        ipcLog.info('platform.cancel-sync', '待确认同步会话已放弃', { taskId })
      }
    },
    { taskId },
  ),
)

ipcMain.handle(
  'platform:confirm-sync',
  (event, platform: string, taskId: string, selections: SyncSelection[]) =>
    ipcLog.time(
      'platform.confirm-sync',
      async () => {
        const pending = pendingSyncs.get(taskId)
        if (!pending) throw new Error('同步会话已过期，请重新解析')
        pendingSyncs.delete(taskId)
        ipcLog.info('platform.confirm-sync', '用户确认选择，开始写入', {
          platform,
          taskId,
          selections: selections.length,
        })
        // 用户人工选择写入映射缓存（后续同步直接命中，无需再选）；显式跳过的不写入
        for (const selection of selections) {
          if (selection.skipped) continue
          const choice = pending.plan.choices[selection.choiceIndex]
          if (choice) {
            saveConfirmedMapping(platform, choice, selection.songId)
          }
        }
        // 主进程侧检查点持久化：写入阶段定期落库（playlistId/added），中断后可续写
        const checkpoint = createTaskCheckpoint(taskId)
        const notify = (ratio: number, stage: 'matching' | 'adding') => {
          checkpoint.onProgress(ratio)
          if (!event.sender.isDestroyed()) {
            event.sender.send('sync:progress', { platform, taskId, ratio, stage })
          }
        }
        const control = beginRunningSync(taskId)
        try {
          // 先建单流程：确认阶段不再建单，直接向已创建的歌单写入
          const report = await executeSync(pending.plan, selections, pending.playlistName, pending.target, {
            batchSize: pending.batchSize,
            ...syncTuning(),
            signal: control.signal,
            skipCheck: control.skipCheck,
            existingPlaylistId: pending.playlistId,
            onProgress: notify,
            onStep: (item) => {
              if (!event.sender.isDestroyed()) {
                event.sender.send('sync:step', { taskId, item })
              }
              checkpoint.onStep(item)
            },
            onCheckpoint: checkpoint.onCheckpoint,
          })
          if (report.playlistId !== '') {
            playlistCacheStore.markStalePlaylists(platform)
          }
          registerLocalPlaylistSyncTarget(pending.sourceLocalPlaylistId, platform, report.playlistId)
          notifySyncResult(report.playlistName, report.added, report.failed.length)
          return report
        } catch (e) {
          if (e instanceof SyncAbortedError) {
            ipcLog.info('platform.confirm-sync', '写入被用户停止', { platform, taskId })
            notifySyncStopped(pending.playlistName)
            registerLocalPlaylistSyncTarget(pending.sourceLocalPlaylistId, platform, e.partial.playlistId ?? '')
            return stoppedReport(e.partial, pending.playlistName)
          }
          throw e
        } finally {
          control.done()
        }
      },
      { platform, taskId, selections: selections.length },
    ),
)

app.whenReady().then(() => {
  // 主题跟随设置（light/dark/system）：system 让原生 UI（菜单/滚动条等）跟随系统外观，
  // 渲染层经 prefers-color-scheme 媒体查询感知同一来源，两者保持一致。
  const theme = getSetting<string>('theme', SETTINGS_DEFAULTS.theme)
  nativeTheme.themeSource =
    theme === 'light' || theme === 'dark' || theme === 'system' ? theme : SETTINGS_DEFAULTS.theme
  nativeTheme.on('updated', syncWindowBackground)
  buildApplicationMenu()
  setupAutoUpdater()
  restoreProxy()
  applySecurityHeaders()
  createWindow()
  // 重启自动继续执行：恢复上次异常退出残留的 running 任务（复用已匹配数据/续写已建歌单）
  const pendingResume = takePendingResumeTasks()
  if (pendingResume.length > 0) {
    log.info('app.resume-pending-sync', '发现待恢复的同步任务，自动继续执行', {
      count: pendingResume.length,
      taskIds: pendingResume.map((t) => t.id),
    })
    for (const task of pendingResume) {
      void resumePendingSyncTask(task)
    }
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})
