import { app, session } from 'electron'
import { logCenter } from './logging/logCenter'

const log = logCenter.logger('security')

/**
 * 渲染层 CSP（仅打包环境注入；开发模式需放行 Vite HMR，不注入）。
 * 外链仅放行字体（Google Fonts），平台封面走 https:。
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: https:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
].join('; ')

/** 打包环境为渲染层响应注入 CSP 头 */
export function applySecurityHeaders(): void {
  if (!app.isPackaged) return
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [CSP],
        'X-Content-Type-Options': ['nosniff'],
      },
    })
  })
  log.info('security.headers', '渲染层 CSP 已注入')
}
