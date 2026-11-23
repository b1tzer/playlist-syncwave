import { app, BrowserWindow, ipcMain, safeStorage } from 'electron'
import { join } from 'node:path'
import { netease, saveNeteaseCredential, getNeteaseCredential, logoutNetease } from './neteaseService'
import { getQqMusic, saveQqMusicCredential, getQqMusicCredential, logoutQqMusic } from './qqMusicService'
import { registerPlatform, getPlatform, resolveAdapter } from './platformRegistry'
import { executeSync, planSync } from '@core/sync/syncPlaylist'
import type { SyncPlan, SyncSelection, SyncTarget } from '@core/models/sync'
import type { MatchQuery } from '@core/models/match'

// Electron 从终端启动后管道可能已关闭（如启动命令退出），
// 此时任何 console 写入都会抛 EPIPE 导致应用崩溃。吞掉即可。
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE') return
    throw err
  })
}

const isDev = process.env.NODE_ENV === 'development'

registerPlatform('netease', {
  adapter: netease,
  getCredential: getNeteaseCredential,
  saveCredential: saveNeteaseCredential,
  logout: logoutNetease,
})

registerPlatform('qqmusic', {
  adapter: getQqMusic(),
  getCredential: getQqMusicCredential,
  saveCredential: saveQqMusicCredential,
  logout: logoutQqMusic,
})

// 应用就绪时预热 QQ音乐服务（异步，不阻塞启动）
app.whenReady().then(() => {
  void getQqMusic().catch((e) => {
    console.error('QQ音乐服务启动失败:', e instanceof Error ? e.message : e)
  })
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

  if (isDev && process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

ipcMain.handle('app:get-version', () => app.getVersion())

ipcMain.handle('crypto:encrypt', (_event, plain: string) => {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('系统加密不可用')
  }
  return safeStorage.encryptString(plain).toString('base64')
})

// --- 多平台通用 IPC（platform 参数分发）---

ipcMain.handle('platform:list', () => ['netease', 'qqmusic'])

ipcMain.handle(
  'platform:create-qr',
  async (_event, platform: string, channel?: string) => {
    const adapter = await resolveAdapter(platform)
    return adapter.createQrLogin(channel)
  },
)

ipcMain.handle('platform:check-qr', async (_event, platform: string, key: string) => {
  const services = getPlatform(platform)
  const adapter = await resolveAdapter(platform)
  const result = await adapter.checkQrLogin(key)
  if (result.status === 'success' && result.cookie) {
    services.saveCredential(result.cookie)
  }
  return result
})

ipcMain.handle('platform:login-status', async (_event, platform: string) => {
  const services = getPlatform(platform)
  const credential = services.getCredential()
  if (!credential) return null
  const adapter = await resolveAdapter(platform)
  return adapter.getLoginStatus(credential)
})

ipcMain.handle('platform:logout', (_event, platform: string) => {
  getPlatform(platform).logout()
})

ipcMain.handle('platform:user-playlists', async (_event, platform: string) => {
  const services = getPlatform(platform)
  const credential = services.getCredential()
  if (!credential) throw new Error('尚未登录')
  const adapter = await resolveAdapter(platform)
  const account = await adapter.getLoginStatus(credential)
  if (!account) throw new Error('登录已过期，请重新扫码')
  return adapter.getUserPlaylists(credential, account.userId)
})

ipcMain.handle('platform:playlist-songs', async (_event, platform: string, playlistId: string) => {
  const services = getPlatform(platform)
  const credential = services.getCredential()
  if (!credential) throw new Error('尚未登录')
  const adapter = await resolveAdapter(platform)
  return adapter.getPlaylistSongs(credential, playlistId)
})

/** 待确认的同步会话：choice-needed 后缓存 plan，等待用户选择 */
const pendingSyncs = new Map<
  string,
  { plan: SyncPlan; target: SyncTarget; playlistName: string; batchSize?: number }
>()

ipcMain.handle(
  'platform:sync-playlist',
  async (
    event,
    platform: string,
    payload: { queries: MatchQuery[]; playlistName: string; batchSize?: number },
  ) => {
    const services = getPlatform(platform)
    const credential = services.getCredential()
    if (!credential) throw new Error('尚未登录目标平台')
    const adapter = await resolveAdapter(platform)
    const target: SyncTarget = {
      searchSongs: (keyword, limit) => adapter.searchSongs(credential, keyword, limit),
      createPlaylist: (name) => adapter.createPlaylist(credential, name),
      addSongs: (playlistId, songIds) => adapter.addSongsToPlaylist(credential, playlistId, songIds),
    }
    const notify = (ratio: number, stage: 'matching' | 'adding') => {
      if (!event.sender.isDestroyed()) {
        event.sender.send('sync:progress', { platform, ratio, stage })
      }
    }

    const plan = await planSync(payload.queries, target, { onProgress: notify })

    if (plan.choices.length > 0) {
      const taskId = `sync-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      pendingSyncs.set(taskId, {
        plan,
        target,
        playlistName: payload.playlistName,
        batchSize: payload.batchSize,
      })
      return {
        taskId,
        report: {
          status: 'choice-needed',
          playlistName: payload.playlistName,
          playlistId: '',
          total: plan.total,
          matched: plan.matched.length,
          added: 0,
          failed: plan.failed,
          choices: plan.choices,
        },
      }
    }

    const report = await executeSync(plan, [], payload.playlistName, target, {
      batchSize: payload.batchSize,
      onProgress: notify,
    })
    return { taskId: '', report }
  },
)

ipcMain.handle(
  'platform:confirm-sync',
  async (event, platform: string, taskId: string, selections: SyncSelection[]) => {
    const pending = pendingSyncs.get(taskId)
    if (!pending) throw new Error('同步会话已过期，请重新解析')
    pendingSyncs.delete(taskId)
    return executeSync(pending.plan, selections, pending.playlistName, pending.target, {
      batchSize: pending.batchSize,
      onProgress: (ratio, stage) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send('sync:progress', { platform, ratio, stage })
        }
      },
    })
  },
)

app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
