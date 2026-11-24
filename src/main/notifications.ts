import { BrowserWindow, Notification } from 'electron'
import { getSetting } from './settingsService'
import { logCenter } from './logging/logCenter'

const log = logCenter.logger('notify')

type Lang = 'zh-CN' | 'en-US'

const LABELS: Record<
  Lang,
  {
    syncDone: string
    syncDoneBody: (added: number, name: string) => string
    syncPartial: string
    syncPartialBody: (added: number, failed: number, name: string) => string
    syncNone: string
    syncNoneBody: (failed: number) => string
    syncStopped: string
    syncStoppedBody: (name: string) => string
    accountExpired: string
    accountExpiredBody: (platform: string) => string
    updateReady: string
    updateReadyBody: (version: string) => string
  }
> = {
  'zh-CN': {
    syncDone: '同步完成',
    syncDoneBody: (added, name) => `${added} 首歌曲已写入「${name}」`,
    syncPartial: '同步部分完成',
    syncPartialBody: (added, failed, name) =>
      `${added} 首已写入「${name}」，${failed} 首未匹配`,
    syncNone: '未创建歌单',
    syncNoneBody: (failed) => `${failed} 首歌曲均未找到匹配`,
    syncStopped: '同步已停止',
    syncStoppedBody: (name) => `「${name}」的同步任务已停止，已完成部分已保留`,
    accountExpired: '账号已过期',
    accountExpiredBody: (platform) => `${platform} 登录已失效，请重新扫码登录`,
    updateReady: '新版本已就绪',
    updateReadyBody: (version) => `SyncWave ${version} 已下载，重启应用即可完成安装`,
  },
  'en-US': {
    syncDone: 'Sync completed',
    syncDoneBody: (added, name) => `${added} songs written to "${name}"`,
    syncPartial: 'Sync partially completed',
    syncPartialBody: (added, failed, name) =>
      `${added} songs written to "${name}", ${failed} unmatched`,
    syncNone: 'No playlist created',
    syncNoneBody: (failed) => `None of the ${failed} songs matched`,
    syncStopped: 'Sync stopped',
    syncStoppedBody: (name) => `Sync of "${name}" was stopped; completed parts are kept`,
    accountExpired: 'Account expired',
    accountExpiredBody: (platform) => `${platform} login expired, please sign in again`,
    updateReady: 'Update ready',
    updateReadyBody: (version) => `SyncWave ${version} is downloaded; restart to install`,
  },
}

function labels(): (typeof LABELS)['zh-CN'] {
  return getSetting<string>('language', 'zh-CN') === 'en-US' ? LABELS['en-US'] : LABELS['zh-CN']
}

function mainWindowFocused(): boolean {
  return BrowserWindow.getAllWindows().some((w) => w.isFocused())
}

/** 窗口失焦时发送系统通知；点击通知聚焦主窗口 */
function sendNotification(title: string, body: string): void {
  if (mainWindowFocused()) return
  try {
    const notification = new Notification({ title, body })
    notification.on('click', () => {
      const win = BrowserWindow.getAllWindows()[0]
      if (win) {
        if (win.isMinimized()) win.restore()
        win.focus()
      }
    })
    notification.show()
    log.info('notify.sent', '系统通知已发送', { title })
  } catch (e) {
    log.warn('notify.failed', '系统通知发送失败', {
      error: e instanceof Error ? e.message : String(e),
    })
  }
}

/** 同步任务结束通知：全成功 / 部分成功 / 全部未匹配 */
export function notifySyncResult(name: string, added: number, failed: number): void {
  const t = labels()
  if (failed === 0) {
    sendNotification(t.syncDone, t.syncDoneBody(added, name))
  } else if (added > 0) {
    sendNotification(t.syncPartial, t.syncPartialBody(added, failed, name))
  } else {
    sendNotification(t.syncNone, t.syncNoneBody(failed))
  }
}

/** 同步任务被用户停止 */
export function notifySyncStopped(name: string): void {
  const t = labels()
  sendNotification(t.syncStopped, t.syncStoppedBody(name))
}

/** 平台账号凭证失效被清除 */
export function notifyAccountExpired(platform: string): void {
  const t = labels()
  sendNotification(t.accountExpired, t.accountExpiredBody(platform))
}

/** 新版本下载完成 */
export function notifyUpdateReady(version: string): void {
  const t = labels()
  sendNotification(t.updateReady, t.updateReadyBody(version))
}
