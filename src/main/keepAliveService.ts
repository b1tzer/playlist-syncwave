import { BrowserWindow } from 'electron'
import { getPlatform, listPlatforms, resolveAdapter } from './platformRegistry'
import { logCenter } from './logging/logCenter'
import { notifyAccountExpired } from './notifications'
import { clearCachedLoginStatus } from './loginStatusCache'

const log = logCenter.logger('keepalive')

/** 默认保活周期：每 6 小时一轮 */
export const KEEPALIVE_INTERVAL_MS = 6 * 60 * 60 * 1000

let timer: NodeJS.Timeout | null = null
let running = false

/** 广播账号状态变化：渲染层收到后重新查询该平台登录态 */
export function broadcastAccountsChanged(platform: string): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('accounts:changed', platform)
  }
}

/**
 * 单平台保活：校验凭证有效性，续期成功则更新本地凭证；
 * 判定失效则清除本地凭证并广播给渲染层。
 */
export async function keepAlivePlatform(platform: string): Promise<void> {
  const services = getPlatform(platform)
  const credential = services.getCredential()
  if (!credential) return

  const adapter = await resolveAdapter(platform)
  const result = await adapter.keepAlive(credential)

  if (result.cookie) {
    services.saveCredential(result.cookie)
    log.info('keepalive.renewed', '凭证已续期并保存', { platform })
  }
  if (!result.alive) {
    log.warn('keepalive.expired', '凭证已失效，清除本地登录态', { platform })
    services.logout()
    clearCachedLoginStatus(platform)
    broadcastAccountsChanged(platform)
    notifyAccountExpired(platform)
  }
}

/** 对所有已登录平台执行一轮保活 */
export async function keepAliveAll(): Promise<void> {
  if (running) return
  running = true
  try {
    for (const meta of listPlatforms()) {
      if (!getPlatform(meta.id).getCredential()) continue
      try {
        await keepAlivePlatform(meta.id)
      } catch (e) {
        log.error('keepalive.failed', '平台保活失败，下轮重试', e, { platform: meta.id })
      }
    }
  } finally {
    running = false
  }
}

/** 启动保活调度：立即执行一轮，之后按周期执行 */
export function startKeepAliveScheduler(intervalMs = KEEPALIVE_INTERVAL_MS): void {
  stopKeepAliveScheduler()
  void keepAliveAll()
  timer = setInterval(() => void keepAliveAll(), intervalMs)
  log.info('keepalive.start', '凭证保活调度已启动', { intervalMs })
}

export function stopKeepAliveScheduler(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
    log.info('keepalive.stop', '凭证保活调度已停止')
  }
}
