import { createRequire } from 'node:module'
import { session } from 'electron'
import { getSetting, setSetting } from './settingsService'
import { logCenter } from './logging/logCenter'

const log = logCenter.logger('proxy')

/** axios 全局默认配置的最小类型（第三方平台包共用同一 axios 单例） */
interface AxiosDefaults {
  defaults: {
    proxy:
      | false
      | {
          protocol: string
          host: string
          port: number
          auth?: { username: string; password: string }
        }
  }
}

function axiosDefaults(): AxiosDefaults {
  return createRequire(import.meta.url)('axios') as AxiosDefaults
}

/** 解析并校验代理地址 */
function parseProxyUrl(raw: string): { protocol: string; host: string; port: number; auth?: { username: string; password: string } } {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new Error('无效的代理地址')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('代理协议仅支持 http/https')
  }
  if (!parsed.hostname) throw new Error('代理地址缺少主机名')
  const port = parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80
  const auth =
    parsed.username !== ''
      ? { username: decodeURIComponent(parsed.username), password: decodeURIComponent(parsed.password) }
      : undefined
  return { protocol: parsed.protocol.replace(':', ''), host: parsed.hostname, port, auth }
}

/** 应用代理：平台 API（axios defaults）+ 渲染层（session）+ Node fetch（环境变量）三路同时生效 */
export function applyProxy(url: string): void {
  const { protocol, host, port, auth } = parseProxyUrl(url)
  axiosDefaults().defaults.proxy = { protocol, host, port, ...(auth ? { auth } : {}) }
  session.defaultSession.setProxy({ proxyRules: `${protocol}://${host}:${port}` })
  process.env.HTTP_PROXY = `${protocol}://${host}:${port}`
  process.env.HTTPS_PROXY = `${protocol}://${host}:${port}`
  process.env.NO_PROXY = 'localhost,127.0.0.1'
  log.info('proxy.apply', '代理已应用', { host, port })
}

export function clearProxy(): void {
  axiosDefaults().defaults.proxy = false
  session.defaultSession.setProxy({ mode: 'direct' })
  delete process.env.HTTP_PROXY
  delete process.env.HTTPS_PROXY
  log.info('proxy.clear', '代理已清除')
}

/** 读取已保存的代理地址（空串表示未设置） */
export function getProxySetting(): string {
  return getSetting<string>('proxyUrl', '')
}

/** 保存并应用代理；空串清除 */
export function setProxySetting(url: unknown): void {
  if (url === null || url === undefined || url === '') {
    setSetting('proxyUrl', '')
    clearProxy()
    return
  }
  if (typeof url !== 'string') throw new Error('无效的代理参数')
  const trimmed = url.trim()
  applyProxy(trimmed)
  setSetting('proxyUrl', trimmed)
}

/** 启动时恢复已保存的代理配置（解析失败仅告警不阻塞启动） */
export function restoreProxy(): void {
  const saved = getProxySetting()
  if (!saved) return
  try {
    applyProxy(saved)
  } catch (e) {
    log.warn('proxy.restore-failed', '恢复代理失败，已忽略', { error: String(e) })
  }
}
