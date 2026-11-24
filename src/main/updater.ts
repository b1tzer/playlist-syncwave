import { app, BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'
import { logCenter } from './logging/logCenter'
import { notifyUpdateReady } from './notifications'

const log = logCenter.logger('updater')

export type UpdateStatus =
  | { state: 'checking' }
  | { state: 'available'; version: string }
  | { state: 'not-available'; version: string }
  | { state: 'downloading'; percent: number }
  | { state: 'downloaded'; version: string }
  | { state: 'error'; message: string }

let initialized = false

function broadcast(status: UpdateStatus): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('update:status', status)
    }
  }
}

/** 初始化自动更新：打包环境启动 10s 后静默检查，自动下载，退出时安装 */
export function setupAutoUpdater(): void {
  if (initialized || !app.isPackaged) return
  initialized = true

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('checking-for-update', () => broadcast({ state: 'checking' }))
  autoUpdater.on('update-available', (info) => {
    log.info('updater.available', '发现新版本，开始下载', { version: info.version })
    broadcast({ state: 'available', version: info.version })
  })
  autoUpdater.on('update-not-available', (info) => {
    log.info('updater.not-available', '已是最新版本', { version: info.version })
    broadcast({ state: 'not-available', version: info.version })
  })
  autoUpdater.on('download-progress', (progress) => {
    broadcast({ state: 'downloading', percent: Math.round(progress.percent) })
  })
  autoUpdater.on('update-downloaded', (info) => {
    log.info('updater.downloaded', '新版本已下载，等待安装', { version: info.version })
    broadcast({ state: 'downloaded', version: info.version })
    notifyUpdateReady(info.version)
  })
  autoUpdater.on('error', (err) => {
    log.error('updater.error', '更新流程出错', err)
    broadcast({ state: 'error', message: err.message })
  })

  setTimeout(() => {
    autoUpdater
      .checkForUpdates()
      .catch((e) => log.warn('updater.check-failed', '启动静默检查失败', e))
  }, 10_000)
}

/** 手动检查更新（设置页按钮）；开发模式未打包，直接拒绝 */
export async function checkForUpdates(): Promise<void> {
  if (!app.isPackaged) throw new Error('开发模式不支持自动更新')
  await autoUpdater.checkForUpdates()
}

/** 下载完成后重启并安装 */
export function quitAndInstall(): void {
  autoUpdater.quitAndInstall()
}
