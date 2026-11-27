/* global process, setInterval */
/**
 * 独立启动 QQ 音乐本地 Koa 服务（供真实链路验证使用）：
 *   PORT=xxxx node scripts/qq-api-server.mjs
 * 保持进程存活直到被 kill；真实主进程（Electron）采用同样的 require 根模块方式。
 */
process.env.NODE_ENV = process.env.NODE_ENV === 'test' ? 'production' : process.env.NODE_ENV
process.env.QQ_SESSION_SECRET =
  process.env.QQ_SESSION_SECRET || 'live-verify-secret-0123456789abcdef0123456789abcdef'

const { createRequire } = await import('node:module')
const require = createRequire(import.meta.url)
require('@yakult-green-tea/qq-music-api')

// 服务 listen 由包内部完成；进程随服务器句柄保持存活
setInterval(() => {}, 60_000)
