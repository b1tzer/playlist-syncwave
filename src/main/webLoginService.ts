import { BrowserWindow, session } from 'electron'
import { createLogger } from '@core/logging'
import type { WebLoginAccountProbe, WebLoginProfile } from '@core/models/platform'

const log = createLogger({ module: 'web-login' })

/** 登录窗口轮询间隔 */
const POLL_INTERVAL_MS = 2000
/** 登录等待上限：Apple ID 含双重认证，给足时间 */
const LOGIN_TIMEOUT_MS = 15 * 60 * 1000
/** cookie 到手后额外等页面昵称出现的上限（实测登录后约 4s 出现，留足余量；抓不到照常登录） */
const PROFILE_WAIT_MS = 15000
/** 页面昵称轮询间隔 */
const PROFILE_POLL_MS = 250
/** 账户设置页 iframe 里邮箱出现的等待上限（抓不到照常登录） */
const ACCOUNT_WAIT_MS = 15000
/** cookie 查询用根 URL 的协议+域名部分（供 cookies.get 的 url 参数） */

/** 网页登录结果：会话凭证 + 页面上顺带抓到的资料（可选） */
export interface WebLoginResult {
  cookie: string
  profile?: WebLoginProfile
}

/** 登录流程回调：cookie 到手立即通知；页面资料后台抓完后再通知 */
export interface WebLoginCallbacks {
  onCookie?: (cookie: string) => void
  onProfile?: (profile?: WebLoginProfile) => void
}

/**
 * 通用网页登录流程：打开登录窗口，用户手动登录后提取会话 cookie。
 *
 * - 使用独立持久化 session partition，登录态与主应用隔离；
 * - 登录窗口不加载 preload、sandbox 隔离，不暴露任何 IPC；
 * - cookie 到手立即 resolve 并隐藏窗口；昵称/邮箱改在隐藏窗口里后台抓取，
 *   通过回调交给主进程补全账号，不阻塞界面显示已登录；
 * - 用户关闭窗口视为取消，返回 null。
 *
 * @param loginUrl        登录页 URL（窗口加载地址）
 * @param cookieName      登录成功后写入的会话 cookie 名
 * @param cookieUrl       查询 cookie 的根 URL（如 https://music.apple.com）
 * @param title           窗口标题
 * @param profileSelector 可选的页面昵称选择器（如 Apple Music 的账号菜单用户名）
 * @param accountProbe    可选的账户设置页探针（跳页读登录邮箱）
 * @param callbacks       cookie / 后台资料回调
 */
export async function beginWebLogin(
  loginUrl: string,
  cookieName: string,
  cookieUrl: string,
  title: string,
  profileSelector?: string,
  accountProbe?: WebLoginAccountProbe,
  callbacks: WebLoginCallbacks = {},
): Promise<WebLoginResult | null> {
  const partition = 'persist:web-login'
  const ses = session.fromPartition(partition)

  // 清理上次登录残留的会话 cookie：分区跨登录共享，
  // 不清除的话旧登录态会让页面直接判定已登录，用户无法切换账号。
  // 按实际种下的 domain 逐个删除，覆盖父域 cookie（如 .apple.com）。
  try {
    const existing = await ses.cookies.get({ name: cookieName })
    for (const c of existing) {
      const domain = (c.domain ?? '').replace(/^\./, '')
      if (!domain) continue
      await ses.cookies.remove(`https://${domain}`, cookieName).catch(() => undefined)
    }
  } catch (e) {
    log.debug('login.web.clear-cookie-failed', '清理旧会话 cookie 失败', {
      message: e instanceof Error ? e.message : String(e),
    })
  }

  const win = new BrowserWindow({
    width: 860,
    height: 700,
    title,
    autoHideMenuBar: true,
    webPreferences: {
      // 关键：窗口必须与 cookie 轮询使用同一 session，否则登录 cookie 写进 defaultSession，
      // 轮询在 persist:web-login 里永远查不到，登录流程卡死
      partition,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  return new Promise<WebLoginResult | null>((resolve) => {
    let resolved = false
    let pendingCookie: string | undefined
    const pollTimer = setInterval(() => void checkCookie(), POLL_INTERVAL_MS)

    const closeWindow = () => {
      if (!win.isDestroyed()) win.destroy()
    }
    const resolveOnce = (value: WebLoginResult | null) => {
      if (resolved) return
      resolved = true
      clearInterval(pollTimer)
      resolve(value)
    }
    const abort = (value: null) => {
      resolveOnce(value)
      closeWindow()
    }

    const collectProfile = async () => {
      const collectStartedAt = Date.now()
      log.debug('login.web.collect-start', '后台开始收集页面账号资料', {
        hasProfileSelector: Boolean(profileSelector),
        hasAccountProbe: Boolean(accountProbe),
      })
      let profile = profileSelector ? await readProfile(win, profileSelector) : undefined
      if (accountProbe) {
        const email = await readAccountEmail(win, accountProbe)
        if (email) profile = { ...profile, email }
      }
      log.debug('login.web.collect-done', '后台页面账号资料收集结束（不记录值本身）', {
        durationMs: Date.now() - collectStartedAt,
        hasNickname: Boolean(profile?.nickname),
        hasEmail: Boolean(profile?.email),
      })
      callbacks.onProfile?.(profile)
    }

    const checkCookie = async () => {
      if (pendingCookie) return
      try {
        // 先按 url 精确查；未命中时按 name 全量兜底（cookie 可能种在父域如 .apple.com）
        let cookies = await ses.cookies.get({ url: cookieUrl, name: cookieName })
        if (cookies.length === 0) {
          cookies = await ses.cookies.get({ name: cookieName })
        }
        const hit = cookies.find((c) => c.value) ?? cookies[0]
        if (hit?.value) {
          pendingCookie = hit.value
          log.info('login.web.success', '提取到会话 cookie', {
            cookieName,
            domain: hit.domain,
          })
          // 用户视角窗口立即消失：主进程先落凭证显示已登录，页面资料在隐藏窗口后台抓
          callbacks.onCookie?.(hit.value)
          win.hide()
          resolveOnce({ cookie: hit.value })
          void collectProfile()
            .catch((e) => {
              log.debug('login.web.collect-failed', '后台收集账号资料失败', {
                message: e instanceof Error ? e.message : String(e),
              })
              callbacks.onProfile?.(undefined)
            })
            .finally(() => closeWindow())
        }
      } catch (e) {
        log.debug('login.web.poll-failed', 'cookie 查询失败，继续等待', {
          message: e instanceof Error ? e.message : String(e),
        })
      }
    }

    win.on('closed', () => {
      if (!resolved) resolveOnce(pendingCookie ? { cookie: pendingCookie } : null)
    })
    win.webContents.on('did-finish-load', () => void checkCookie())
    win.webContents.on('did-navigate', () => void checkCookie())
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
      if (!pendingCookie) abort(null)
      else {
        resolveOnce({ cookie: pendingCookie })
        closeWindow()
      }
    }, LOGIN_TIMEOUT_MS)

    log.info('login.web.start', '打开网页登录窗口', { loginUrl, cookieName })
    void win.loadURL(loginUrl).catch((e: unknown) => {
      log.error('login.web.load-failed', '登录页加载失败', e, { loginUrl })
      abort(null)
    })
  })
}

/**
 * 跳到账户设置页并从 iframe 中读登录邮箱，轮询至出现或超时。
 * 读不到返回 undefined，登录流程照常继续；日志只记命中情况，不记邮箱本身。
 */
async function readAccountEmail(
  win: BrowserWindow,
  probe: WebLoginAccountProbe,
): Promise<string | undefined> {
  const navStartedAt = Date.now()
  log.debug('login.web.account-nav-start', '跳转账户设置页', { url: probe.url })
  try {
    await win.loadURL(probe.url)
  } catch (e) {
    log.debug('login.web.account-nav-failed', '账户设置页跳转失败', {
      durationMs: Date.now() - navStartedAt,
      message: e instanceof Error ? e.message : String(e),
    })
    return undefined
  }
  log.debug('login.web.account-nav-done', '账户设置页加载完成', {
    durationMs: Date.now() - navStartedAt,
  })
  const script = `(() => {
    const frame = document.querySelector(${JSON.stringify(probe.frameSelector)});
    const doc = frame?.contentDocument;
    const el = doc?.querySelector(${JSON.stringify(probe.emailSelector)});
    const text = el?.textContent || '';
    const match = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}/i);
    return { email: match ? match[0] : null, frameFound: !!frame, fieldFound: !!el };
  })()`
  const startedAt = Date.now()
  const deadline = startedAt + ACCOUNT_WAIT_MS
  let attempts = 0
  let firstError: string | undefined
  let frameFound = false
  let fieldFound = false
  while (!win.isDestroyed() && Date.now() < deadline) {
    attempts += 1
    try {
      const result = (await win.webContents.executeJavaScript(script)) as {
        email: string | null
        frameFound: boolean
        fieldFound: boolean
      }
      frameFound = result.frameFound
      fieldFound = result.fieldFound
      if (result.email) {
        log.debug('login.web.account-email-found', '抓到账户邮箱（值不记录）', {
          durationMs: Date.now() - startedAt,
          attempts,
          frameFound,
          fieldFound,
        })
        return result.email
      }
    } catch (e) {
      // 页面/iframe 仍在加载：只记首次错误，避免 250ms 轮询刷屏
      if (!firstError) firstError = e instanceof Error ? e.message : String(e)
    }
    await new Promise((resolve) => setTimeout(resolve, PROFILE_POLL_MS))
  }
  log.debug('login.web.account-email-missed', '未抓到账户邮箱（不影响登录）', {
    durationMs: Date.now() - startedAt,
    attempts,
    frameFound,
    fieldFound,
    windowDestroyed: win.isDestroyed(),
    firstError,
  })
  return undefined
}

/**
 * 从已登录页面读取账号昵称：轮询至元素出现或超时。
 * 读不到返回 undefined，登录流程照常继续；日志只记命中情况，不记昵称本身。
 */
async function readProfile(
  win: BrowserWindow,
  selector: string,
): Promise<WebLoginProfile | undefined> {
  const script = `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    return el?.textContent?.trim() || null;
  })()`
  const startedAt = Date.now()
  const deadline = startedAt + PROFILE_WAIT_MS
  let attempts = 0
  let firstError: string | undefined
  while (!win.isDestroyed() && Date.now() < deadline) {
    attempts += 1
    try {
      const nickname = (await win.webContents.executeJavaScript(script)) as string | null
      if (nickname) {
        log.debug('login.web.profile-found', '抓到页面昵称（值不记录）', {
          durationMs: Date.now() - startedAt,
          attempts,
        })
        return { nickname }
      }
    } catch (e) {
      // 页面仍在跳转或窗口已关闭：只记首次错误
      if (!firstError) firstError = e instanceof Error ? e.message : String(e)
    }
    await new Promise((resolve) => setTimeout(resolve, PROFILE_POLL_MS))
  }
  log.debug('login.web.profile-missed', '未抓到页面昵称（不影响登录）', {
    durationMs: Date.now() - startedAt,
    attempts,
    windowDestroyed: win.isDestroyed(),
    firstError,
  })
  return undefined
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
