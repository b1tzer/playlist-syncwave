import { createHash } from 'node:crypto'
import {
  chmodSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  renameSync,
  unlinkSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { basename, join } from 'node:path'
import { Transform, type TransformCallback } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { app, BrowserWindow, shell } from 'electron'
import { logHttpError } from '@core/logging'
import { logCenter } from './logging/logCenter'
import { notifyUpdateReady } from './notifications'
import { getSetting } from './settingsService'
import { findInstallerAsset, releaseAssetUrl } from './updateAsset'

// CJS 包在 ESM 主进程下无可靠 named export，内联 createRequire 加载（与平台 SDK 加载方式一致）
const { autoUpdater } = createRequire(import.meta.url)(
  'electron-updater',
) as typeof import('electron-updater')

const log = logCenter.logger('updater')

// --- 更新源配置 ---
// 唯一更新源为 GitHub Releases，由 electron-builder.yml 的 publish 配置打包进 app-update.yml。
// electron-updater 只负责检查版本；安装包自行下载并交给系统打开/展示，由用户完成安装步骤。

export type UpdateStatus =
  | { state: 'checking' }
  | { state: 'available'; version: string }
  | { state: 'not-available'; version: string }
  | { state: 'downloading'; percent: number }
  | { state: 'downloaded'; version: string }
  | { state: 'error'; message: string }

interface UpdateInfoLite {
  version: string
  files: Array<{ url: string; sha512?: string }>
}

interface AxiosStreamResponse {
  data: NodeJS.ReadableStream
  headers: Record<string, string | string[] | undefined>
}

interface AxiosStreamClient {
  get(url: string, config: Record<string, unknown>): Promise<AxiosStreamResponse>
}

type InstallerPlatform = 'darwin' | 'win32' | 'linux'

function installerPlatform(): InstallerPlatform {
  if (process.platform === 'darwin' || process.platform === 'win32' || process.platform === 'linux') {
    return process.platform
  }
  throw new Error(`不支持的更新平台：${process.platform}`)
}

let initialized = false
/** 自动更新开关（默认开启），由设置项 autoUpdateEnabled 驱动 */
let enabled = true
let autoCheckTimer: ReturnType<typeof setTimeout> | undefined
/** 检查+下载同一时间只允许一个流程，避免菜单与启动静默检查并发 */
let busy = false
let downloadedInstallerPath: string | undefined
let downloadedVersion: string | undefined

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
    checkForUpdates().catch((e) => log.warn('updater.check-failed', '启动静默检查失败', e))
  }, 10_000)
}

/** 计算文件 sha512 的 base64 摘要（与 electron-updater 元数据一致） */
async function fileSha512(filePath: string): Promise<string> {
  const hash = createHash('sha512')
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk as Buffer)
  }
  return hash.digest('base64')
}

/** 流式下载安装包并校验 sha512，失败时删除残片 */
async function downloadInstaller(
  url: string,
  target: string,
  expectedSha512?: string,
): Promise<void> {
  const axios = createRequire(import.meta.url)('axios') as AxiosStreamClient
  const started = Date.now()
  let response: AxiosStreamResponse
  try {
    response = await axios.get(url, { responseType: 'stream', timeout: 300_000 })
  } catch (e) {
    logHttpError(log, 'updater.download-failed', '安装包下载请求失败', e, {
      method: 'GET',
      url,
      requestBody: expectedSha512 !== undefined ? { expectedSha512 } : undefined,
      status: (e as { response?: { status?: number } }).response?.status,
      durationMs: Date.now() - started,
    })
    throw e
  }
  const header = response.headers['content-length']
  const total = typeof header === 'string' ? Number(header) : 0
  const hash = createHash('sha512')
  let received = 0
  const progress = new Transform({
    transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
      hash.update(chunk)
      received += chunk.length
      if (total > 0) {
        broadcast({
          state: 'downloading',
          percent: Math.min(100, Math.round((received / total) * 100)),
        })
      }
      callback(null, chunk)
    },
  })

  try {
    await pipeline(response.data, progress, createWriteStream(target))
  } catch (e) {
    if (existsSync(target)) unlinkSync(target)
    logHttpError(log, 'updater.download-failed', '安装包下载中断', e, {
      method: 'GET',
      url,
      requestBody: expectedSha512 !== undefined ? { expectedSha512 } : undefined,
      durationMs: Date.now() - started,
    })
    throw e
  }

  if (expectedSha512 && hash.digest('base64') !== expectedSha512) {
    unlinkSync(target)
    throw new Error('安装包校验失败，请重新检查更新')
  }
}

/** macOS/Windows 打开安装包；Linux 在文件管理器中定位 AppImage，均由用户完成安装 */
async function revealInstaller(installerPath: string): Promise<void> {
  if (process.platform === 'linux') {
    shell.showItemInFolder(installerPath)
    return
  }
  const error = await shell.openPath(installerPath)
  if (error) throw new Error(`打开安装包失败：${error}`)
}

/** 下载安装包并交给系统打开/展示，由用户完成后续安装步骤 */
async function downloadAndOpenInstaller(info: UpdateInfoLite): Promise<void> {
  const platform = installerPlatform()
  const asset = findInstallerAsset(info.files, platform)
  if (!asset) throw new Error(`更新元数据中没有 ${platform} 安装包`)

  const fileName = basename(asset.url)
  const url = releaseAssetUrl(info.version, fileName)
  const dir = app.getPath('downloads')
  mkdirSync(dir, { recursive: true })
  const target = join(dir, fileName)
  const temp = `${target}.download`

  if (existsSync(target) && (!asset.sha512 || (await fileSha512(target)) === asset.sha512)) {
    log.info('updater.installer-cached', '安装包已存在，跳过下载', { path: target })
  } else {
    if (existsSync(temp)) unlinkSync(temp)
    await downloadInstaller(url, temp, asset.sha512)
    renameSync(temp, target)
  }
  // Linux AppImage 需要可执行位；其他平台设置也无副作用
  chmodSync(target, 0o755)

  downloadedInstallerPath = target
  downloadedVersion = info.version

  try {
    await revealInstaller(target)
  } catch (e) {
    log.warn('updater.reveal-failed', '自动展示安装包失败', {
      error: e instanceof Error ? e.message : String(e),
      path: target,
    })
  }
  log.info('updater.installer-downloaded', '安装包已下载并展示', {
    version: info.version,
    path: target,
    platform,
  })
  broadcast({ state: 'downloaded', version: info.version })
  notifyUpdateReady(info.version)
}

/** 初始化更新：打包环境启动 10s 后静默检查；安装包下载后交给用户手动安装 */
export function setupAutoUpdater(): void {
  if (initialized || !app.isPackaged) return
  initialized = true
  enabled = getSetting<boolean>('autoUpdateEnabled', true)

  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false

  autoUpdater.on('checking-for-update', () => broadcast({ state: 'checking' }))
  autoUpdater.on('update-available', (info) => {
    log.info('updater.available', '发现新版本，开始下载', { version: info.version })
    broadcast({ state: 'available', version: info.version })
  })
  autoUpdater.on('update-not-available', (info) => {
    log.info('updater.not-available', '已是最新版本', { version: info.version })
    broadcast({ state: 'not-available', version: info.version })
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

/** 手动/静默检查更新（设置页按钮与启动检查共用）；开发模式未打包，直接拒绝 */
export async function checkForUpdates(): Promise<void> {
  if (!app.isPackaged) throw new Error('开发模式不支持自动更新')
  if (busy) return
  busy = true
  try {
    const result = await autoUpdater.checkForUpdates()
    if (!result?.isUpdateAvailable) return
    await downloadAndOpenInstaller({
      version: result.updateInfo.version,
      files: (result.updateInfo.files ?? []).map((file) => ({
        url: file.url,
        sha512: file.sha512,
      })),
    })
  } finally {
    busy = false
  }
}

/** 重新打开/定位已下载的安装包 */
export async function openInstaller(): Promise<void> {
  if (!downloadedInstallerPath || !existsSync(downloadedInstallerPath)) {
    throw new Error('安装包不存在，请重新检查更新')
  }
  await revealInstaller(downloadedInstallerPath)
  log.info('updater.installer-reopened', '重新展示安装包', {
    version: downloadedVersion,
    path: downloadedInstallerPath,
  })
}
