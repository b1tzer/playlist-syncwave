import { createRequire } from 'node:module'
import { NeteaseAdapter, type NcmApi } from '../platforms/netease'
import { getCredential, setCredential, clearCredential } from './credentialStore'

const require = createRequire(import.meta.url)
const ncm = require('NeteaseCloudMusicApi') as NcmApi

export const netease = new NeteaseAdapter(ncm)

export function saveNeteaseCredential(cookie: string): void {
  setCredential('netease', cookie)
}

export function getNeteaseCredential(): string | null {
  return getCredential('netease')
}

export function logoutNetease(): void {
  clearCredential('netease')
}
