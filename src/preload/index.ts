import { contextBridge, ipcRenderer } from 'electron'

const api = {
  getVersion: (): Promise<string> => ipcRenderer.invoke('app:get-version'),
  encrypt: (plain: string): Promise<string> => ipcRenderer.invoke('crypto:encrypt', plain),
}

contextBridge.exposeInMainWorld('electronAPI', api)

export type ElectronAPI = typeof api
