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
import type { LocalPlaylist, LocalPlaylistSong } from '@core/models/localPlaylist'
import type { LogEntry } from '@core/logging'

export interface SyncProgress {
  platform: string
  taskId: string
  ratio: number
  stage: 'matching' | 'adding'
}

/** 自动更新状态（与主进程 updater.UpdateStatus 同构） */
export type UpdateStatus =
  | { state: 'checking' }
  | { state: 'available'; version: string }
  | { state: 'not-available'; version: string }
  | { state: 'downloading'; percent: number }
  | { state: 'downloaded'; version: string }
  | { state: 'error'; message: string }

export interface SyncStep {
  taskId: string
  item: SyncItemResult
}

/** 歌单数据拉取结果：缓存优先 + 刷新策略（throttled 表示手动刷新被限流拦截） */
export interface PlaylistFetchResult<T> {
  data: T
  fromCache: boolean
  throttled?: boolean
}

/** 分页拉取结果：items 为当前页切片，total 为全量数量 */
export interface PagedFetchResult<T> {
  items: T[]
  total: number
  fromCache: boolean
  throttled?: boolean
}

const api = {
  /** 运行平台（darwin/win32/linux），渲染层用于红绿灯避让等平台差异布局 */
  platform: process.platform,
  getVersion: (): Promise<string> => ipcRenderer.invoke('app:get-version'),
  encrypt: (plain: string): Promise<string> => ipcRenderer.invoke('crypto:encrypt', plain),
  /** 在系统浏览器/平台应用中打开链接（http/https/平台深链白名单） */
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('app:open-external', url),
  /** 打开文件选择器导入歌单文本文件（m3u/m3u8/csv/txt/lrc/json），取消返回 null */
  openTextFile: (): Promise<{ name: string; content: string } | null> =>
    ipcRenderer.invoke('app:open-text-file'),
  /** 导出文本文件：选择保存位置后写入，返回保存路径（取消返回 null） */
  saveTextFile: (defaultName: string, content: string, extension: string): Promise<string | null> =>
    ipcRenderer.invoke('app:save-text-file', defaultName, content, extension),

  /** 网络代理：读取/设置（空串清除） */
  proxy: {
    get: (): Promise<string> => ipcRenderer.invoke('proxy:get'),
    set: (url: string): Promise<void> => ipcRenderer.invoke('proxy:set', url),
  },
  /** 渲染进程日志上报：主进程校验后写入统一日志管线 */
  log: (entry: LogEntry): void => {
    ipcRenderer.send('log:write', entry)
  },
  /** 应用菜单导航请求（菜单快捷键触发，主进程广播视图切换） */
  onNavigate: (callback: (view: string) => void): (() => void) => {
    const listener = (_event: unknown, view: string) => callback(view)
    ipcRenderer.on('app:navigate', listener)
    return () => ipcRenderer.removeListener('app:navigate', listener)
  },
  /** 开机启动：读取系统登录项真实状态 / 应用设置 */
  getAutoLaunch: (): Promise<boolean> => ipcRenderer.invoke('app:get-auto-launch'),
  setAutoLaunch: (enabled: boolean): Promise<void> =>
    ipcRenderer.invoke('app:set-auto-launch', enabled),

  /** 自动更新：状态流转（与主进程 updater.UpdateStatus 保持同构） */
  updater: {
    check: (): Promise<void> => ipcRenderer.invoke('update:check'),
    quitAndInstall: (): Promise<void> => ipcRenderer.invoke('update:quit-and-install'),
    onStatus: (callback: (status: UpdateStatus) => void): (() => void) => {
      const listener = (_event: unknown, status: UpdateStatus) => callback(status)
      ipcRenderer.on('update:status', listener)
      return () => ipcRenderer.removeListener('update:status', listener)
    },
    /** 菜单「检查更新」触发（导航到设置页后由设置页响应） */
    onCheckRequested: (callback: () => void): (() => void) => {
      const listener = () => callback()
      ipcRenderer.on('update:check-requested', listener)
      return () => ipcRenderer.removeListener('update:check-requested', listener)
    },
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
    /** 歌单列表（force=true 手动强制刷新，受限流阈值约束） */
    userPlaylists: (platform: string, force?: boolean): Promise<PlaylistFetchResult<PlatformPlaylist[]>> =>
      ipcRenderer.invoke('platform:user-playlists', platform, force === true),
    /** 歌单列表分页（滚动加载：offset 从 0 起，limit ≤200） */
    userPlaylistsPage: (
      platform: string,
      offset: number,
      limit: number,
      force?: boolean,
    ): Promise<PagedFetchResult<PlatformPlaylist>> =>
      ipcRenderer.invoke('platform:user-playlists-page', platform, offset, limit, force === true),
    /** 歌单歌曲（force=true 手动强制刷新） */
    playlistSongs: (
      platform: string,
      playlistId: string,
      force?: boolean,
    ): Promise<PlaylistFetchResult<PlatformSong[]>> =>
      ipcRenderer.invoke('platform:playlist-songs', platform, playlistId, force === true),
    /** 歌单歌曲分页（滚动加载：offset 从 0 起，limit ≤200） */
    playlistSongsPage: (
      platform: string,
      playlistId: string,
      offset: number,
      limit: number,
      force?: boolean,
    ): Promise<PagedFetchResult<PlatformSong>> =>
      ipcRenderer.invoke('platform:playlist-songs-page', platform, playlistId, offset, limit, force === true),
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

  localPlaylists: {
    list: (): Promise<LocalPlaylist[]> => ipcRenderer.invoke('local-playlist:list'),
    create: (
      name: string,
      songs: Array<{ title: string; artist: string; album?: string; durationMs?: number }>,
    ): Promise<LocalPlaylist | null> => ipcRenderer.invoke('local-playlist:create', name, songs),
    rename: (id: string, name: string): Promise<void> =>
      ipcRenderer.invoke('local-playlist:rename', id, name),
    delete: (id: string): Promise<void> => ipcRenderer.invoke('local-playlist:delete', id),
    songs: (id: string): Promise<LocalPlaylistSong[]> =>
      ipcRenderer.invoke('local-playlist:songs', id),
    addSongs: (
      id: string,
      songs: Array<{ title: string; artist: string; album?: string; durationMs?: number }>,
    ): Promise<void> => ipcRenderer.invoke('local-playlist:add-songs', id, songs),
    removeSongs: (id: string, positions: number[]): Promise<void> =>
      ipcRenderer.invoke('local-playlist:remove-songs', id, positions),
  },
}

contextBridge.exposeInMainWorld('electronAPI', api)

export type ElectronAPI = typeof api
