import { app } from 'electron'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { handleRequest } from '@yakult-green-tea/qq-music-api/serverless'
import { QqMusicAdapter } from '../platforms/qqmusic'
import type { HttpHandler } from '../platforms/httpHandler'
import { getCredential, setCredential, clearCredential } from './credentialStore'

/**
 * QQ 音乐的 sealed token 用 QQ_SESSION_SECRET 加密，secret 必须跨重启稳定，
 * 否则已登录的 token 全部失效。生成一次后持久化到 userData。
 */
function loadSessionSecret(): string {
  const file = join(app.getPath('userData'), 'qq-session-secret')
  if (existsSync(file)) {
    const existing = readFileSync(file, 'utf-8').trim()
    if (existing.length >= 32) return existing
  }
  const secret = randomBytes(32).toString('base64')
  mkdirSync(app.getPath('userData'), { recursive: true })
  writeFileSync(file, secret, 'utf-8')
  return secret
}

const handler: HttpHandler = (request, env) => handleRequest(request, env)

let adapter: QqMusicAdapter | null = null

export function getQqMusic(): QqMusicAdapter {
  if (!adapter) {
    adapter = new QqMusicAdapter(handler, {
      QQ_SESSION_SECRET: loadSessionSecret(),
    })
  }
  return adapter
}

export function saveQqMusicCredential(token: string): void {
  setCredential('qqmusic', token)
}

export function getQqMusicCredential(): string | null {
  return getCredential('qqmusic')
}

export function logoutQqMusic(): void {
  clearCredential('qqmusic')
}
