import { app, BrowserWindow, ipcMain, safeStorage } from 'electron'
import { join } from 'node:path'
import { platformModules } from '../platforms'
import { registerPlatform, getPlatform, resolveAdapter, listPlatforms } from './platformRegistry'
import type { AdapterContext } from '../platforms/meta'
import { executeSync, planSync } from '@core/sync/syncPlaylist'
import type { SyncPlan, SyncSelection, SyncTarget } from '@core/models/sync'
import type { MatchQuery } from '@core/models/match'
import { logCenter } from './logging/logCenter'
import { upsertSyncTask, listSyncTasks, removeSyncTask, clearSyncTasks } from './syncHistoryService'
import { getSetting, setSetting, getAllSettings } from './settingsService'
import { saveConfirmedMapping, clearMappings, mappingStats, findMappings } from './mappingService'
import { startKeepAliveScheduler, stopKeepAliveScheduler } from './keepAliveService'
import { getDatabase } from './appDatabase'
import type { SyncTaskRecord, SyncChoice } from '@core/models/sync'

// Electron 从终端启动后管道可能已关闭（如启动命令退出），
// 此时任何 console 写入都会抛 EPIPE 导致应用崩溃。吞掉即可。
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE') return
    throw err
  })
}

const isDev = process.env.NODE_ENV === 'development'

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

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1200,
    height: 820,
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
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

ipcMain.handle('crypto:encrypt', (_event, plain: string) => {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('系统加密不可用')
  }
  ipcLog.debug('crypto.encrypt', '加密数据', { length: plain.length })
  return safeStorage.encryptString(plain).toString('base64')
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
      return adapter.createQrLogin(channel)
    },
    { platform, channel: channel ?? 'default' },
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
      const adapter = await resolveAdapter(platform)
      return adapter.getLoginStatus(credential)
    },
    { platform },
  ),
)

ipcMain.handle('platform:logout', (_event, platform: string) =>
  ipcLog.time(
    'platform.logout',
    async () => {
      getPlatform(platform).logout()
    },
    { platform },
  ),
)

ipcMain.handle('platform:user-playlists', (_event, platform: string) =>
  ipcLog.time(
    'platform.user-playlists',
    async () => {
      const services = getPlatform(platform)
      const credential = services.getCredential()
      if (!credential) throw new Error('尚未登录')
      const adapter = await resolveAdapter(platform)
      const account = await adapter.getLoginStatus(credential)
      if (!account) throw new Error('登录已过期，请重新扫码')
      const playlists = await adapter.getUserPlaylists(credential, account.userId)
      ipcLog.info('platform.user-playlists', '拉取歌单列表完成', {
        platform,
        count: playlists.length,
      })
      return playlists
    },
    { platform },
  ),
)

ipcMain.handle('platform:playlist-songs', (_event, platform: string, playlistId: string) =>
  ipcLog.time(
    'platform.playlist-songs',
    async () => {
      const services = getPlatform(platform)
      const credential = services.getCredential()
      if (!credential) throw new Error('尚未登录')
      const adapter = await resolveAdapter(platform)
      const songs = await adapter.getPlaylistSongs(credential, playlistId)
      ipcLog.info('platform.playlist-songs', '拉取歌单歌曲完成', {
        platform,
        playlistId,
        count: songs.length,
      })
      return songs
    },
    { platform, playlistId },
  ),
)

/** 歌单管理类 IPC 的统一前置：已登录平台 + 凭证 */
async function withPlaylistCredential(platform: string) {
  const services = getPlatform(platform)
  const credential = services.getCredential()
  if (!credential) throw new Error('尚未登录')
  const adapter = await resolveAdapter(platform)
  return { credential, adapter }
}

ipcMain.handle('platform:search-songs', (_event, platform: string, keyword: string, limit?: number) =>
  ipcLog.time(
    'platform.search-songs',
    async () => {
      const { credential, adapter } = await withPlaylistCredential(platform)
      // 限速与风控由平台适配器/同步引擎负责；这里仅约束单次数量
      const capped = Math.min(Math.max(1, Math.floor(limit ?? 30)), 50)
      return adapter.searchSongs(credential, keyword, capped)
    },
    { platform, keyword },
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
        ipcLog.info('platform.playlist-rename', '歌单重命名完成', { platform, playlistId })
      },
      { platform, playlistId },
    ),
)

ipcMain.handle('platform:playlist-delete', (_event, platform: string, playlistId: string) =>
  ipcLog.time(
    'platform.playlist-delete',
    async () => {
      const { credential, adapter } = await withPlaylistCredential(platform)
      await adapter.deletePlaylist(credential, playlistId)
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
        ipcLog.info('platform.playlist-add-songs', '添加歌曲完成', {
          platform,
          playlistId,
          count: songIds.length,
        })
      },
      { platform, playlistId, count: Array.isArray(songIds) ? songIds.length : 0 },
    ),
)

/** 待确认的同步会话：choice-needed 后缓存 plan，等待用户选择 */
const pendingSyncs = new Map<
  string,
  { plan: SyncPlan; target: SyncTarget; playlistName: string; batchSize?: number }
>()

ipcMain.handle(
  'platform:sync-playlist',
  (
    event,
    platform: string,
    payload: {
      queries: MatchQuery[]
      playlistName: string
      /** 渲染层按当前语言格式化的今日日期：歌单名留空时与第一首歌风格拼成默认名 */
      autoNameDate?: string
      batchSize?: number
    },
  ) =>
    ipcLog.time(
      'platform.sync-playlist',
      async () => {
        const services = getPlatform(platform)
        const credential = services.getCredential()
        if (!credential) throw new Error('尚未登录目标平台')
        const adapter = await resolveAdapter(platform)
        const target: SyncTarget = {
          searchSongs: (keyword, limit) => adapter.searchSongs(credential, keyword, limit),
          createPlaylist: (name) => adapter.createPlaylist(credential, name),
          addSongs: (playlistId, songIds) => adapter.addSongsToPlaylist(credential, playlistId, songIds),
          lookupMapping: (query) => {
            const rows = findMappings(platform, query)
            const confirmed = rows.find((r) => r.confirmed === 1)
            if (confirmed) return { songId: confirmed.songId, confirmed: true }
            return null
          },
          saveMapping: (query, songId) => {
            // 只缓存非人工确认的自动匹配（人工确认经 confirm-sync 单独写入）
            getDatabase().mappings.saveAutoMatch(platform, query, { id: songId, title: query.title, artist: query.artist ?? '' }, 1)
          },
        }
        const notify = (ratio: number, stage: 'matching' | 'adding') => {
          if (!event.sender.isDestroyed()) {
            event.sender.send('sync:progress', { platform, ratio, stage })
          }
        }

        const plan = await planSync(payload.queries, target, { onProgress: notify })

        // 歌单名留空时自动命名：今日日期 + 第一首歌风格
        const autoName = [payload.autoNameDate, plan.firstGenre].filter(Boolean).join(' ')
        const finalName = (payload.playlistName ?? '').trim() || autoName || '未命名歌单'

        if (plan.choices.length > 0) {
          const taskId = `sync-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
          pendingSyncs.set(taskId, {
            plan,
            target,
            playlistName: finalName,
            batchSize: payload.batchSize,
          })
          ipcLog.info('platform.sync-playlist', '同步需要用户确认', {
            platform,
            taskId,
            playlistName: finalName,
            total: plan.total,
            matched: plan.matched.length,
            choices: plan.choices.length,
            failed: plan.failed.length,
          })
          return {
            taskId,
            report: {
              status: 'choice-needed',
              playlistName: finalName,
              playlistId: '',
              total: plan.total,
              matched: plan.matched.length,
              added: 0,
              failed: plan.failed,
              choices: plan.choices,
              firstGenre: plan.firstGenre,
            },
          }
        }

        const report = await executeSync(plan, [], finalName, target, {
          batchSize: payload.batchSize,
          onProgress: notify,
        })
        ipcLog.info('platform.sync-playlist', '同步完成', {
          platform,
          playlistName: finalName,
          playlistId: report.playlistId,
          total: report.total,
          added: report.added,
          failed: report.failed.length,
        })
        return { taskId: '', report }
      },
      { platform, playlistName: payload.playlistName, total: payload.queries.length },
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

// --- 应用设置（SQLite 持久化）---

ipcMain.handle('settings:get-all', () =>
  ipcLog.time('settings.get-all', async () => getAllSettings(), undefined, 'debug'),
)

ipcMain.handle('settings:set', (_event, key: string, value: unknown) =>
  ipcLog.time(
    'settings.set',
    async () => {
      if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
        throw new Error('不支持的设置值类型')
      }
      setSetting(key, value)
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
        // 用户人工选择写入映射缓存（后续同步直接命中，无需再选）
        for (const selection of selections) {
          const choice = pending.plan.choices[selection.choiceIndex]
          if (choice) {
            saveConfirmedMapping(platform, choice, selection.songId)
          }
        }
        return executeSync(pending.plan, selections, pending.playlistName, pending.target, {
          batchSize: pending.batchSize,
          onProgress: (ratio, stage) => {
            if (!event.sender.isDestroyed()) {
              event.sender.send('sync:progress', { platform, ratio, stage })
            }
          },
        })
      },
      { platform, taskId, selections: selections.length },
    ),
)

app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})
