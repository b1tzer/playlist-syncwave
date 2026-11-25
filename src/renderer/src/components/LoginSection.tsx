import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { PlatformAccount, PlatformMeta, QrLoginTicket } from '@core/models/platform'
import { createRendererLogger } from '../logging/rendererLogger'
import { useI18n } from '../i18n'
import type { TranslationKey } from '../i18n/translations'
import PlatformLogo from './PlatformLogo'
import { notify } from './toast'
import { notifyError } from '../utils/notifyError'

const log = createRendererLogger('renderer.login')

/** 二维码轮询状态码（渲染时按当前语言翻译） */
type QrStatus = 'waiting' | 'success' | 'expired' | 'scanned'

const QR_STATUS_LABELS: Record<QrStatus, TranslationKey> = {
  waiting: 'login.waitScan',
  success: 'login.success',
  expired: 'login.expired',
  scanned: 'login.scanned',
}

interface LoginSectionProps {
  platforms: PlatformMeta[]
  accounts: Record<string, PlatformAccount | null>
  onAccountChange: (platform: string, account: PlatformAccount | null) => void
}

export default function LoginSection({ platforms, accounts, onAccountChange }: LoginSectionProps) {
  const { t } = useI18n()
  const [qrFor, setQrFor] = useState<string | null>(null)
  const [qrChannel, setQrChannel] = useState<string>('')
  const [ticket, setTicket] = useState<QrLoginTicket | null>(null)
  const [qrStatus, setQrStatus] = useState<QrStatus | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>('')
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const stopPolling = () => {
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
  }

  useEffect(() => stopPolling, [])

  const closeQr = () => {
    if (qrFor) log.info('login.qr.close', '关闭二维码弹窗', { platform: qrFor })
    stopPolling()
    setQrFor(null)
    setTicket(null)
    setQrStatus(null)
    setError('')
    setLoading(false)
  }

  /** 当前二维码平台的登录渠道（无声明则为单一默认渠道） */
  const qrMeta = platforms.find((p) => p.id === qrFor)
  const qrChannels = qrMeta?.loginChannels ?? []

  const startLogin = async (platform: string, channel?: string) => {
    // 网页登录平台（如 Apple Music 无扫码接口）：主进程打开登录窗口，无二维码弹窗
    if (platforms.find((p) => p.id === platform)?.loginType === 'web') {
      return startWebLogin(platform)
    }
    const channels = platforms.find((p) => p.id === platform)?.loginChannels ?? []
    const activeChannel = channels.length > 0 ? (channel ?? qrChannel ?? channels[0]?.id) : undefined
    log.info('login.qr.start', '发起扫码登录', {
      platform,
      channel: activeChannel ?? 'default',
    })
    setError('')
    setLoading(true)
    setQrFor(platform)
    try {
      const ticket = await window.electronAPI.platforms.createQr(platform, activeChannel)
      setTicket(ticket)
      setQrStatus('waiting')
      pollRef.current = setInterval(async () => {
        try {
          const result = await window.electronAPI.platforms.checkQr(platform, ticket.key)
          if (result.status === 'success') {
            stopPolling()
            setQrStatus('success')
            log.info('login.qr.success', '扫码登录成功', { platform })
            setTicket(null)
            try {
              const status = await window.electronAPI.platforms.loginStatus(platform)
              onAccountChange(platform, status)
            } catch (e) {
              // 凭证已保存，账号查询失败不应阻塞流程；提示用户重启后会自动恢复登录态
              const name = platforms.find((p) => p.id === platform)?.name ?? platform
              log.warn('login.qr.status-failed', '登录成功但查询账号信息失败', {
                platform,
                message: e instanceof Error ? e.message : String(e),
              })
              notify(
                'warning',
                t('login.success'),
                t('login.statusQueryFailedDetail', { platform: name }),
              )
            }
            setTimeout(closeQr, 800)
          } else if (result.status === 'expired') {
            stopPolling()
            log.warn('login.qr.expired', '二维码已过期', { platform })
            setQrStatus('expired')
            setError(t('login.expiredHint'))
          } else if (result.status === 'scanned') {
            setQrStatus('scanned')
          }
        } catch (e) {
          // 轮询失败保持现状，避免高频错误日志刷屏
          log.debug('login.qr.poll-failed', '轮询失败，继续等待', {
            platform,
            message: e instanceof Error ? e.message : String(e),
          })
        }
      }, 2000)
    } catch (e) {
      log.error('login.qr.create-failed', '获取二维码失败', e, { platform })
      // 异常提示走右上角 toast，代码性报错过滤为通用文案
      notifyError(e, t('login.failed'))
      setQrFor(null)
    } finally {
      setLoading(false)
    }
  }

  /** 网页登录：主进程打开登录窗口，用户登录完成后返回账号；取消返回 null */
  const startWebLogin = async (platform: string) => {
    const name = platforms.find((p) => p.id === platform)?.name ?? platform
    log.info('login.web.start', '发起网页登录', { platform })
    setError('')
    setLoading(true)
    try {
      const account = await window.electronAPI.platforms.beginWebLogin(platform)
      if (account) {
        log.info('login.web.success', '网页登录成功', { platform })
        onAccountChange(platform, account)
        notify('success', t('login.success'), t('login.webSuccessDetail', { platform: name }))
      } else {
        log.info('login.web.cancelled', '网页登录已取消', { platform })
      }
    } catch (e) {
      log.error('login.web.failed', '网页登录失败', e, { platform })
      notifyError(e, t('login.failed'))
    } finally {
      setLoading(false)
    }
  }

  /** 在二维码弹窗内切换扫码方式 */
  const switchChannel = (channel: string) => {
    log.info('login.qr.switch-channel', '切换扫码通道', { platform: qrFor, channel })
    setQrChannel(channel)
    stopPolling()
    setTicket(null)
    setError('')
    if (qrFor) void startLogin(qrFor, channel)
  }

  const logout = async (platform: string) => {
    log.info('login.logout', '退出登录', { platform })
    await window.electronAPI.platforms.logout(platform)
    onAccountChange(platform, null)
  }

  const loggedInCount = platforms.filter((p) => accounts[p.id] !== null).length

  // 网格列宽 = 内容最长的卡片宽度（所有卡片等宽、文字不缩略；auto-fit 放不下自动折单列）
  const gridRef = useRef<HTMLDivElement>(null)
  const [cardMinWidth, setCardMinWidth] = useState<number | null>(null)

  useLayoutEffect(() => {
    let cancelled = false
    const measure = () => {
      const grid = gridRef.current
      if (!grid) return
      // 临时把列宽压到 0，让每张卡片溢出，读取完整内容宽度（scrollWidth）
      const prevTemplate = grid.style.gridTemplateColumns
      grid.style.setProperty('grid-template-columns', '0px')
      let max = 0
      grid.querySelectorAll<HTMLElement>('[data-card]').forEach((card) => {
        max = Math.max(max, card.scrollWidth)
      })
      grid.style.gridTemplateColumns = prevTemplate
      if (!cancelled && max > 0) {
        setCardMinWidth((prev) => (prev === max ? prev : max))
      }
    }
    measure()
    // 字体加载完成后重测一次，避免首次测量偏小
    if (document.fonts?.ready) {
      document.fonts.ready.then(() => {
        if (!cancelled) measure()
      })
    }
    return () => {
      cancelled = true
    }
  }, [platforms, accounts, t])

  return (
    <div>
      <div className="flex items-start justify-between">
        <div>
          <h1 className="mt-1 font-headline-lg text-headline-lg font-semibold">
            {t('login.title')}
          </h1>
        </div>
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1.5 rounded-full bg-surface-container-high px-3 py-1.5 font-label-sm text-label-sm text-on-surface-variant">
            <span className="material-symbols-outlined text-sm text-primary">verified_user</span>
            {t('login.onlineBadge', { count: loggedInCount, total: platforms.length })}
          </span>
        </div>
      </div>

      <div
        ref={gridRef}
        className="mt-6 grid gap-3"
        style={
          cardMinWidth
            ? { gridTemplateColumns: `repeat(auto-fit, minmax(${cardMinWidth}px, 1fr))` }
            : undefined
        }
      >
        {platforms.map((p) => {
          const account = accounts[p.id] ?? null
          const status = account ? t('login.authorized') : t('login.disconnected')
          return (
            <div
              key={p.id}
              data-card
              className="rounded-lg border border-outline-variant bg-surface-container-low p-4"
            >
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <PlatformLogo
                    platform={p.id}
                    name={p.name}
                    icon={p.icon}
                    size="h-8 w-8"
                    iconSize="text-2xl"
                    className="shrink-0"
                  />
                  <div className="flex items-baseline gap-2 whitespace-nowrap">
                    <p className="font-body-md text-body-md font-medium">{p.name}</p>
                    {account && (
                      <>
                        <p className="font-label-md text-label-md text-on-surface-variant">
                          {account.nickname}
                        </p>
                        <p className="font-label-sm text-label-sm text-outline">
                          {account.pending
                            ? t('login.pending')
                            : account.account
                              ? t('login.account', { value: account.account })
                              : t('login.uid', { value: account.userId })}
                        </p>
                      </>
                    )}
                  </div>
                </div>

                <div className="flex shrink-0 items-center gap-3">
                  {account ? (
                    <button
                      onClick={() => logout(p.id)}
                      className="flex items-center gap-1 rounded-lg border border-outline-variant px-3 py-1.5 font-label-sm text-label-sm text-on-surface-variant transition-colors hover:bg-surface-container-highest hover:text-error"
                    >
                      <span className="material-symbols-outlined text-sm">logout</span>
                      {t('login.logout')}
                    </button>
                  ) : (
                    <button
                      onClick={() => startLogin(p.id)}
                      disabled={loading}
                      className="flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 font-label-md text-label-md font-medium text-on-primary transition-colors hover:bg-primary/85 disabled:opacity-50"
                    >
                      <span className="material-symbols-outlined text-sm">
                        {p.loginType === 'web' ? 'open_in_new' : 'qr_code_scanner'}
                      </span>
                      {p.loginType === 'web'
                        ? loading
                          ? t('login.webWaiting')
                          : t('login.webLogin')
                        : loading && qrFor === p.id
                          ? t('login.gettingQr')
                          : t('login.scanLogin')}
                    </button>
                  )}
                  {/* 红绿灯：绿 = 已授权在线，红 = 未连接 */}
                  <span
                    title={status}
                    aria-label={status}
                    className={`h-2.5 w-2.5 shrink-0 rounded-full ${
                      account
                        ? 'bg-primary shadow-[0_0_6px] shadow-primary/60'
                        : 'bg-error shadow-[0_0_6px] shadow-error/40'
                    }`}
                  />
                </div>
              </div>
            </div>
          )
        })}
      </div>

      {qrFor && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="w-80 rounded-lg border border-outline-variant bg-surface-container p-5">
            <div className="flex items-center justify-between">
              <p className="font-body-md text-body-md font-medium">
                {t('login.qrTitle', { platform: qrMeta?.name ?? qrFor })}
              </p>
              <button
                onClick={closeQr}
                className="text-on-surface-variant transition-colors hover:text-on-surface"
              >
                <span className="material-symbols-outlined text-base">close</span>
              </button>
            </div>

            {qrChannels.length > 0 && (
              <div className="mt-4 flex justify-center gap-2">
                {qrChannels.map((c) => (
                  <button
                    key={c.id}
                    onClick={() => switchChannel(c.id)}
                    className={`rounded-lg px-2.5 py-1 font-label-sm text-label-sm transition-colors ${
                      qrChannel === c.id
                        ? 'bg-primary text-on-primary'
                        : 'bg-surface-container-highest text-on-surface-variant hover:bg-surface-container-highest/70'
                    }`}
                  >
                    {c.label}
                  </button>
                ))}
              </div>
            )}

            {ticket ? (
              <>
                <img
                  src={ticket.qrBase64}
                  alt={t('login.qrAlt')}
                  className="mx-auto mt-4 h-48 w-48 rounded-lg border border-outline-variant bg-surface"
                />
                <p className="mt-3 text-center font-label-md text-label-md text-on-surface-variant">
                  {qrStatus ? t(QR_STATUS_LABELS[qrStatus]) : ''}
                </p>
                <p className="mt-1 text-center font-label-sm text-label-sm text-outline">
                  {t('login.qrHint')}
                </p>
              </>
            ) : (
              <p className="py-10 text-center font-label-md text-label-md text-on-surface-variant">
                {t('login.fetchingQr')}
              </p>
            )}

            {error && (
              <p className="mt-2 text-center font-label-sm text-label-sm text-error">{error}</p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
