import { app } from 'electron'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { QqMusicAdapter } from '../platforms/qqmusic'
import type { HttpHandler } from '../platforms/httpHandler'
import { getCredential, setCredential, clearCredential } from './credentialStore'

/**
 * QQ 音乐登录态需要跨重启稳定：
 * - session 文件用 QQ_SESSION_SECRET 加密
 * - 设备身份（QIMEI 引导）保存在 QQ_AUTH_STATE_PATH
 * 全部放到 userData 目录。
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

/** 找一个空闲的本地端口，避免 3200 被占用时起不来 */
function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address()
      const port = typeof address === 'object' && address ? address.port : 3200
      srv.close(() => resolve(port))
    })
  })
}

let adapter: QqMusicAdapter | null = null

/**
 * 启动 QQ 音乐本地服务（Node 模式）：
 * 加载包根模块会启动内置 Koa 服务（含 MQTT，支持 qqmusic/qq 通道扫码）。
 * 返回适配器，handler 为转发到本地服务的 fetch。
 */
export async function getQqMusic(): Promise<QqMusicAdapter> {
  if (adapter) return adapter

  const userData = app.getPath('userData')
  mkdirSync(userData, { recursive: true })
  const port = await findFreePort()

  process.env['PORT'] = String(port)
  process.env['QQ_SESSION_SECRET'] = loadSessionSecret()
  process.env['QQ_AUTH_STATE_PATH'] = join(userData, 'qq-device.json')
  process.env['QQ_AUTH_SESSION_PATH'] = join(userData, 'qq-session.json')

  // 根模块加载副作用：启动 Koa 服务（MQTT 支持 qqmusic 通道）
  createRequire(import.meta.url)('@yakult-green-tea/qq-music-api')

  const baseUrl = `http://127.0.0.1:${port}`
  const handler: HttpHandler = async (request) => {
    const url = new URL(request.url)
    const target = `${baseUrl}${url.pathname}${url.search}`
    const init: RequestInit = {
      method: request.method,
      headers: request.headers,
    }
    if (request.body && request.method !== 'GET' && request.method !== 'HEAD') {
      init.body = await request.arrayBuffer()
    }
    return fetch(target, init)
  }

  adapter = new QqMusicAdapter(handler, {})
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
