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
  platform: string
  ratio: number
  stage: 'matching' | 'adding'
}

const api = {
  getVersion: (): Promise<string> => ipcRenderer.invoke('app:get-version'),
  encrypt: (plain: string): Promise<string> => ipcRenderer.invoke('crypto:encrypt', plain),

  platforms: {
    list: (): Promise<string[]> => ipcRenderer.invoke('platform:list'),
    createQr: (platform: string): Promise<QrLoginTicket> =>
      ipcRenderer.invoke('platform:create-qr', platform),
    checkQr: (platform: string, key: string): Promise<QrLoginResult> =>
      ipcRenderer.invoke('platform:check-qr', platform, key),
    loginStatus: (platform: string): Promise<PlatformAccount | null> =>
      ipcRenderer.invoke('platform:login-status', platform),
    logout: (platform: string): Promise<void> => ipcRenderer.invoke('platform:logout', platform),
    userPlaylists: (platform: string): Promise<PlatformPlaylist[]> =>
      ipcRenderer.invoke('platform:user-playlists', platform),
    playlistSongs: (platform: string, playlistId: string): Promise<PlatformSong[]> =>
      ipcRenderer.invoke('platform:playlist-songs', platform, playlistId),
    syncPlaylist: (
      platform: string,
      queries: MatchQuery[],
      playlistName: string,
      batchSize?: number,
    ): Promise<SyncReport> =>
      ipcRenderer.invoke('platform:sync-playlist', platform, { queries, playlistName, batchSize }),
    onSyncProgress: (callback: (progress: SyncProgress) => void): (() => void) => {
      const listener = (_event: unknown, progress: SyncProgress) => callback(progress)
      ipcRenderer.on('sync:progress', listener)
      return () => ipcRenderer.removeListener('sync:progress', listener)
    },
  },
}

contextBridge.exposeInMainWorld('electronAPI', api)

export type ElectronAPI = typeof api
