import { app, BrowserWindow, ipcMain, safeStorage } from 'electron'
import { join } from 'node:path'
import { netease, saveNeteaseCredential, getNeteaseCredential, logoutNetease } from './neteaseService'
import { syncPlaylist } from '@core/sync/syncPlaylist'
import type { SyncTarget } from '@core/models/sync'
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

async function neteaseWithCookie<T>(fn: (cookie: string) => Promise<T>): Promise<T> {
  const cookie = getNeteaseCredential()
  if (!cookie) throw new Error('尚未登录网易云')
  return fn(cookie)
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1100,
    height: 760,
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

// --- 网易云 ---

ipcMain.handle('netease:create-qr', async () => {
  return netease.createQrLogin()
})

ipcMain.handle('netease:check-qr', async (_event, key: string) => {
  const result = await netease.checkQrLogin(key)
  if (result.status === 'success' && result.cookie) {
    saveNeteaseCredential(result.cookie)
  }
  return result
})

ipcMain.handle('netease:login-status', async () => {
  const cookie = getNeteaseCredential()
  if (!cookie) return null
  return netease.getLoginStatus(cookie)
})

ipcMain.handle('netease:logout', () => {
  logoutNetease()
})

ipcMain.handle('netease:user-playlists', async () => {
  const cookie = getNeteaseCredential()
  if (!cookie) throw new Error('尚未登录网易云')
  const account = await netease.getLoginStatus(cookie)
  if (!account) throw new Error('登录已过期，请重新扫码')
  return netease.getUserPlaylists(cookie, account.userId)
})

ipcMain.handle('netease:playlist-songs', async (_event, playlistId: string) => {
  return neteaseWithCookie((cookie) => netease.getPlaylistSongs(cookie, playlistId))
})

ipcMain.handle('netease:search', async (_event, keyword: string, limit?: number) => {
  return neteaseWithCookie((cookie) => netease.searchSongs(cookie, keyword, limit ?? 30))
})

ipcMain.handle(
  'netease:sync-playlist',
  async (event, payload: { queries: MatchQuery[]; playlistName: string; batchSize?: number }) => {
    const cookie = getNeteaseCredential()
    if (!cookie) throw new Error('尚未登录网易云')
    const target: SyncTarget = {
      searchSongs: (keyword, limit) => netease.searchSongs(cookie, keyword, limit),
      createPlaylist: (name) => netease.createPlaylist(cookie, name),
      addSongs: (playlistId, songIds) => netease.addSongsToPlaylist(cookie, playlistId, songIds),
    }
    return syncPlaylist(payload.queries, payload.playlistName, target, {
      batchSize: payload.batchSize,
      onProgress: (ratio, stage) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send('netease:sync-progress', { ratio, stage })
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
