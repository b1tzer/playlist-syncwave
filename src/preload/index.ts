import { contextBridge, ipcRenderer } from 'electron'
import type {
  PlatformAccount,
  PlatformMeta,
  PlatformPlaylist,
  PlatformSong,
  QrLoginResult,
  QrLoginTicket,
} from '@core/models/platform'
import type { MatchQuery } from '@core/models/match'
import type { SyncItemResult, SyncReport, SyncSelection, SyncTaskRecord } from '@core/models/sync'
import type { LogEntry } from '@core/logging'

export interface SyncProgress {
  platform: string
  taskId: string
  ratio: number
  stage: 'matching' | 'adding'
}

export interface SyncStep {
  taskId: string
  item: SyncItemResult
}

const api = {
  getVersion: (): Promise<string> => ipcRenderer.invoke('app:get-version'),
  encrypt: (plain: string): Promise<string> => ipcRenderer.invoke('crypto:encrypt', plain),
  /** 在系统浏览器/平台应用中打开链接（http/https/平台深链白名单） */
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('app:open-external', url),
  /** 渲染进程日志上报：主进程校验后写入统一日志管线 */
  log: (entry: LogEntry): void => {
    ipcRenderer.send('log:write', entry)
  },

  platforms: {
    list: (): Promise<PlatformMeta[]> => ipcRenderer.invoke('platform:list'),
    createQr: (platform: string, channel?: string): Promise<QrLoginTicket> =>
      ipcRenderer.invoke('platform:create-qr', platform, channel),
    checkQr: (platform: string, key: string): Promise<QrLoginResult> =>
      ipcRenderer.invoke('platform:check-qr', platform, key),
    loginStatus: (platform: string): Promise<PlatformAccount | null> =>
      ipcRenderer.invoke('platform:login-status', platform),
    logout: (platform: string): Promise<void> => ipcRenderer.invoke('platform:logout', platform),
    userPlaylists: (platform: string): Promise<PlatformPlaylist[]> =>
      ipcRenderer.invoke('platform:user-playlists', platform),
    playlistSongs: (platform: string, playlistId: string): Promise<PlatformSong[]> =>
      ipcRenderer.invoke('platform:playlist-songs', platform, playlistId),
    searchSongs: (platform: string, keyword: string, limit?: number): Promise<PlatformSong[]> =>
      ipcRenderer.invoke('platform:search-songs', platform, keyword, limit),
    renamePlaylist: (platform: string, playlistId: string, name: string): Promise<void> =>
      ipcRenderer.invoke('platform:playlist-rename', platform, playlistId, name),
    deletePlaylist: (platform: string, playlistId: string): Promise<void> =>
      ipcRenderer.invoke('platform:playlist-delete', platform, playlistId),
    addSongsToPlaylist: (platform: string, playlistId: string, songIds: string[]): Promise<void> =>
      ipcRenderer.invoke('platform:playlist-add-songs', platform, playlistId, songIds),
    removeSongsFromPlaylist: (
      platform: string,
      playlistId: string,
      songIds: string[],
    ): Promise<void> => ipcRenderer.invoke('platform:playlist-remove-songs', platform, playlistId, songIds),
    syncPlaylist: (
      platform: string,
      taskId: string,
      queries: MatchQuery[],
      playlistName: string,
      autoNameDate?: string,
      batchSize?: number,
    ): Promise<{ taskId: string; report: SyncReport }> =>
      ipcRenderer.invoke('platform:sync-playlist', platform, {
        taskId,
        queries,
        playlistName,
        autoNameDate,
        batchSize,
      }),
    confirmSync: (
      platform: string,
      taskId: string,
      selections: SyncSelection[],
    ): Promise<SyncReport> =>
      ipcRenderer.invoke('platform:confirm-sync', platform, taskId, selections),
    cancelSync: (taskId: string): Promise<void> =>
      ipcRenderer.invoke('platform:cancel-sync', taskId),
    /** 停止运行中的同步任务（已完成部分保留） */
    stopSync: (taskId: string): Promise<void> =>
      ipcRenderer.invoke('platform:stop-sync', taskId),
    /** 请求跳过当前正在处理的歌曲，从下一首继续 */
    skipSync: (taskId: string): Promise<void> =>
      ipcRenderer.invoke('platform:skip-sync', taskId),
    onSyncProgress: (callback: (progress: SyncProgress) => void): (() => void) => {
      const listener = (_event: unknown, progress: SyncProgress) => callback(progress)
      ipcRenderer.on('sync:progress', listener)
      return () => ipcRenderer.removeListener('sync:progress', listener)
    },
    /** 逐首处理明细（任务详情清单实时更新） */
    onSyncStep: (callback: (step: SyncStep) => void): (() => void) => {
      const listener = (_event: unknown, step: SyncStep) => callback(step)
      ipcRenderer.on('sync:step', listener)
      return () => ipcRenderer.removeListener('sync:step', listener)
    },
    /** 账号状态变化（凭证保活续期/失效清除）时由主进程广播，渲染层重新查询该平台 */
    onAccountsChanged: (callback: (platform: string) => void): (() => void) => {
      const listener = (_event: unknown, platform: string) => callback(platform)
      ipcRenderer.on('accounts:changed', listener)
      return () => ipcRenderer.removeListener('accounts:changed', listener)
    },
  },

  syncHistory: {
    list: (): Promise<SyncTaskRecord[]> => ipcRenderer.invoke('sync-history:list'),
    upsert: (task: SyncTaskRecord): Promise<void> =>
      ipcRenderer.invoke('sync-history:upsert', task),
    remove: (id: string): Promise<void> => ipcRenderer.invoke('sync-history:remove', id),
    clear: (): Promise<void> => ipcRenderer.invoke('sync-history:clear'),
  },

  settings: {
    getAll: (): Promise<Record<string, string | number | boolean>> =>
      ipcRenderer.invoke('settings:get-all'),
    get: (key: string, fallback: string | number | boolean): Promise<string | number | boolean> =>
      ipcRenderer.invoke('settings:get', key, fallback),
    set: (key: string, value: string | number | boolean): Promise<void> =>
      ipcRenderer.invoke('settings:set', key, value),
  },

  mappings: {
    stats: (): Promise<Array<{ platform: string; count: number; confirmed: number }>> =>
      ipcRenderer.invoke('mappings:stats'),
    clear: (platform: string): Promise<void> => ipcRenderer.invoke('mappings:clear', platform),
  },
}

contextBridge.exposeInMainWorld('electronAPI', api)

export type ElectronAPI = typeof api
