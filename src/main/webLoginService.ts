import { BrowserWindow, session } from 'electron'
import { createLogger } from '@core/logging'

const log = createLogger({ module: 'web-login' })

/** 登录窗口轮询间隔 */
const POLL_INTERVAL_MS = 2000
/** 登录等待上限：Apple ID 含双重认证，给足时间 */
const LOGIN_TIMEOUT_MS = 15 * 60 * 1000
/** cookie 查询用根 URL 的协议+域名部分（供 cookies.get 的 url 参数） */

/**
 * 通用网页登录流程：打开登录窗口，用户手动登录后提取会话 cookie。
 *
 * - 使用独立持久化 session partition，登录态与主应用隔离；
 * - 登录窗口不加载 preload、sandbox 隔离，不暴露任何 IPC；
 * - 用户关闭窗口视为取消，返回 null。
 *
 * @param loginUrl   登录页 URL（窗口加载地址）
 * @param cookieName 登录成功后写入的会话 cookie 名
 * @param cookieUrl  查询 cookie 的根 URL（如 https://music.apple.com）
 * @param title      窗口标题
 */
export async function beginWebLogin(
  loginUrl: string,
  cookieName: string,
  cookieUrl: string,
  title: string,
): Promise<string | null> {
  const partition = 'persist:web-login'
  const ses = session.fromPartition(partition)

  const win = new BrowserWindow({
    width: 860,
    height: 700,
    title,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  return new Promise<string | null>((resolve) => {
    let settled = false
    // 轮询回调与 settle 均为事件触发，声明时引用后续 const 不会触发 TDZ
    const pollTimer = setInterval(() => void checkCookie(), POLL_INTERVAL_MS)

    const settle = (value: string | null) => {
      if (settled) return
      settled = true
      if (pollTimer) clearInterval(pollTimer)
      // 登录完成或取消：清理本次登录会话（token 已由主进程取出保存）
      if (!win.isDestroyed()) win.destroy()
      resolve(value)
    }

    const checkCookie = async () => {
      try {
        const cookies = await ses.cookies.get({ url: cookieUrl, name: cookieName })
        if (cookies.length > 0 && cookies[0]?.value) {
          log.info('login.web.success', '提取到会话 cookie', { cookieName })
          settle(cookies[0].value)
        }
      } catch (e) {
        log.debug('login.web.poll-failed', 'cookie 查询失败，继续等待', {
          message: e instanceof Error ? e.message : String(e),
        })
      }
    }

    win.on('closed', () => settle(null))
    win.webContents.on('did-finish-load', () => void checkCookie())
    win.webContents.setWindowOpenHandler(() => {
      // 登录页可能弹出新窗口（如条款页面）：外部浏览器打开，避免脱离会话
      return { action: 'deny' }
    })
    win.webContents.on('will-navigate', (event, url) => {
      // 仅放行与登录页同注册域的导航（如 music.apple.com → idmsa.apple.com），
      // 拦截站外跳转防止登录窗口被带偏
      if (!sameRegisterDomain(url, loginUrl)) {
        log.warn('login.web.nav-blocked', '登录窗口拦截站外导航', { url })
        event.preventDefault()
      }
    })

    // 超时兜底：用户长时间未完成登录
    setTimeout(() => {
      log.warn('login.web.timeout', '网页登录超时', { cookieName })
      settle(null)
    }, LOGIN_TIMEOUT_MS)

    log.info('login.web.start', '打开网页登录窗口', { loginUrl, cookieName })
    void win.loadURL(loginUrl).catch((e: unknown) => {
      log.error('login.web.load-failed', '登录页加载失败', e, { loginUrl })
      settle(null)
    })
  })
}

/** 提取 URL 的注册域（hostname 末两段，如 apple.com），非法返回 null */
function registerDomain(url: string): string | null {
  try {
    return new URL(url).hostname.split('.').slice(-2).join('.')
  } catch {
    return null
  }
}

/** 两 URL 是否同注册域（允许子域间跳转，如 music.apple.com → idmsa.apple.com） */
function sameRegisterDomain(a: string, b: string): boolean {
  const da = registerDomain(a)
  const db = registerDomain(b)
  if (!da || !db) return false
  return da === db
}
