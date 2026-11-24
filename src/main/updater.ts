import { createRequire } from 'node:module'
import { app, BrowserWindow } from 'electron'
import { logCenter } from './logging/logCenter'
import { notifyUpdateReady } from './notifications'
import { getSetting } from './settingsService'

// CJS 包在 ESM 主进程下无可靠 named export，内联 createRequire 加载（与平台 SDK 加载方式一致）
const { autoUpdater } = createRequire(import.meta.url)(
  'electron-updater',
) as typeof import('electron-updater')

const log = logCenter.logger('updater')

// --- 更新源配置 ---
// 主源：GitHub Releases，由 electron-builder.yml 的 publish 配置打包进 app-update.yml，无需在此声明。
// 备用源（主源检查失败后依次尝试）：国内 git 服务静态托管。generic 源要求 url 目录下
// 同时存在 latest-mac.yml / latest.yml / latest-linux.yml 与对应安装包（如 Gitee raw 目录）。
type FeedOptions = Parameters<typeof autoUpdater.setFeedURL>[0]

const FALLBACK_FEEDS: Array<{ name: string; options: FeedOptions }> = [
  {
    name: 'gitee',
    options: {
      provider: 'generic',
      // Gitee 仓库 release 分支下的 releases/ 目录，需包含 latest*.yml 与安装包
      url: 'https://gitee.com/bibobibo_309/playlist-syncwave/raw/release/releases',
    },
  },
]

/** 依序尝试更新源：默认源（app-update.yml）→ 备用源；任一成功即返回，全部失败抛出 */
async function checkFeeds(): Promise<void> {
  for (let i = 0; i <= FALLBACK_FEEDS.length; i++) {
    const feed = i === 0 ? undefined : FALLBACK_FEEDS[i - 1]
    if (feed) {
      log.info('updater.fallback', '主源不可用，切换备用更新源', { feed: feed.name })
      autoUpdater.setFeedURL(feed.options)
    }
    try {
      await autoUpdater.checkForUpdates()
      return
    } catch (e) {
      log.warn('updater.feed-failed', '当前更新源检查失败，尝试下一个', {
        feed: feed?.name ?? 'default',
        error: e instanceof Error ? e.message : String(e),
      })
    }
  }
  throw new Error('所有更新源均检查失败')
}

export type UpdateStatus =
  | { state: 'checking' }
  | { state: 'available'; version: string }
  | { state: 'not-available'; version: string }
  | { state: 'downloading'; percent: number }
  | { state: 'downloaded'; version: string }
  | { state: 'error'; message: string }

let initialized = false
/** 自动更新开关（默认开启），由设置项 autoUpdateEnabled 驱动 */
let enabled = true
let autoCheckTimer: ReturnType<typeof setTimeout> | undefined

function broadcast(status: UpdateStatus): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('update:status', status)
    }
  }
}

/** 计划启动后的静默检查（10s 后）；自动更新被关闭时不计划 */
function scheduleAutoCheck(): void {
  clearTimeout(autoCheckTimer)
  if (!enabled) return
  autoCheckTimer = setTimeout(() => {
    checkFeeds().catch((e) => log.warn('updater.check-failed', '启动静默检查失败', e))
  }, 10_000)
}

/** 初始化自动更新：打包环境启动 10s 后静默检查，自动下载，退出时安装 */
export function setupAutoUpdater(): void {
  if (initialized || !app.isPackaged) return
  initialized = true
  enabled = getSetting<boolean>('autoUpdateEnabled', true)

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

  scheduleAutoCheck()
}

/** 切换自动更新开关（设置变更时调用）：关闭时取消尚未发起的静默检查，开启时立即重新计划 */
export function setAutoUpdateEnabled(next: boolean): void {
  enabled = next
  if (next) scheduleAutoCheck()
  else clearTimeout(autoCheckTimer)
  log.info('updater.enabled-changed', '自动更新开关已变更', { enabled: next })
}

/** 手动检查更新（设置页按钮）：同样走多源 fallback；开发模式未打包，直接拒绝 */
export async function checkForUpdates(): Promise<void> {
  if (!app.isPackaged) throw new Error('开发模式不支持自动更新')
  await checkFeeds()
}

/** 下载完成后重启并安装 */
export function quitAndInstall(): void {
  autoUpdater.quitAndInstall()
}
