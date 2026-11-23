import { contextBridge, ipcRenderer } from 'electron'
import type {
  PlatformAccount,
  PlatformPlaylist,
  PlatformSong,
  QrLoginResult,
  QrLoginTicket,
} from '@core/models/platform'
import type { MatchQuery } from '@core/models/match'
import type { SyncReport } from '@core/models/sync'

export interface SyncProgress {
  ratio: number
  stage: 'matching' | 'adding'
}

const api = {
  getVersion: (): Promise<string> => ipcRenderer.invoke('app:get-version'),
  encrypt: (plain: string): Promise<string> => ipcRenderer.invoke('crypto:encrypt', plain),

  netease: {
    createQr: (): Promise<QrLoginTicket> => ipcRenderer.invoke('netease:create-qr'),
    checkQr: (key: string): Promise<QrLoginResult> => ipcRenderer.invoke('netease:check-qr', key),
    loginStatus: (): Promise<PlatformAccount | null> => ipcRenderer.invoke('netease:login-status'),
    logout: (): Promise<void> => ipcRenderer.invoke('netease:logout'),
    userPlaylists: (): Promise<PlatformPlaylist[]> => ipcRenderer.invoke('netease:user-playlists'),
    playlistSongs: (playlistId: string): Promise<PlatformSong[]> =>
      ipcRenderer.invoke('netease:playlist-songs', playlistId),
    search: (keyword: string, limit?: number): Promise<PlatformSong[]> =>
      ipcRenderer.invoke('netease:search', keyword, limit),
    syncPlaylist: (queries: MatchQuery[], playlistName: string, batchSize?: number): Promise<SyncReport> =>
      ipcRenderer.invoke('netease:sync-playlist', { queries, playlistName, batchSize }),
    onSyncProgress: (callback: (progress: SyncProgress) => void): (() => void) => {
      const listener = (_event: unknown, progress: SyncProgress) => callback(progress)
      ipcRenderer.on('netease:sync-progress', listener)
      return () => ipcRenderer.removeListener('netease:sync-progress', listener)
    },
  },
}

contextBridge.exposeInMainWorld('electronAPI', api)

export type ElectronAPI = typeof api
