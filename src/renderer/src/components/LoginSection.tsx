import { useEffect, useRef, useState } from 'react'
import type { PlatformAccount, PlatformMeta, QrLoginTicket } from '@core/models/platform'
import { createRendererLogger } from '../logging/rendererLogger'

const log = createRendererLogger('renderer.login')

interface LoginSectionProps {
  platforms: PlatformMeta[]
  accounts: Record<string, PlatformAccount | null>
  onAccountChange: (platform: string, account: PlatformAccount | null) => void
}

export default function LoginSection({ platforms, accounts, onAccountChange }: LoginSectionProps) {
  const [qrFor, setQrFor] = useState<string | null>(null)
  const [qrChannel, setQrChannel] = useState<string>('')
  const [ticket, setTicket] = useState<QrLoginTicket | null>(null)
  const [qrStatus, setQrStatus] = useState<string>('')
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
    setQrStatus('')
    setError('')
    setLoading(false)
  }

  /** 当前二维码平台的登录渠道（无声明则为单一默认渠道） */
  const qrMeta = platforms.find((p) => p.id === qrFor)
  const qrChannels = qrMeta?.loginChannels ?? []

  const startLogin = async (platform: string, channel?: string) => {
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
      const t = await window.electronAPI.platforms.createQr(platform, activeChannel)
      setTicket(t)
      setQrStatus('等待扫码…')
      pollRef.current = setInterval(async () => {
        try {
          const result = await window.electronAPI.platforms.checkQr(platform, t.key)
          if (result.status === 'success') {
            stopPolling()
            setQrStatus('登录成功！')
            const status = await window.electronAPI.platforms.loginStatus(platform)
            log.info('login.qr.success', '扫码登录成功', { platform })
            setTicket(null)
            onAccountChange(platform, status)
            setTimeout(closeQr, 800)
          } else if (result.status === 'expired') {
            stopPolling()
            log.warn('login.qr.expired', '二维码已过期', { platform })
            setQrStatus('二维码已过期')
            setError('二维码已过期，请重新获取')
          } else if (result.status === 'scanned') {
            setQrStatus('已扫码，请在手机上确认')
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
      setError(e instanceof Error ? e.message : '登录失败')
      setQrFor(null)
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

  return (
    <div>
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2 font-label-mono text-label-mono text-primary">
            <span className="material-symbols-outlined text-sm">vault</span>
            <span>AUTHENTICATION VAULT</span>
            <span className="rounded-full bg-primary-container/15 px-2 py-0.5 text-primary">
              SQLite AES-256 Local Encrypted
            </span>
          </div>
          <h1 className="mt-1 font-headline-lg text-headline-lg font-semibold">音乐平台账号</h1>
          <p className="mt-1 font-body-md text-body-md text-on-surface-variant">
            管理网易云音乐、QQ音乐授权凭证，支持扫码登录与 Cookie 导入，自动维系无感知后台同步。
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1.5 rounded-full bg-surface-container-high px-3 py-1.5 font-label-sm text-label-sm text-on-surface-variant">
            <span className="material-symbols-outlined text-base text-primary">verified_user</span>
            {loggedInCount}/{platforms.length} 平台在线 · Token 有效
          </span>
        </div>
      </div>

      <div className="mt-6 grid max-w-3xl grid-cols-1 gap-3">
        {platforms.map((p) => {
          const account = accounts[p.id] ?? null
          return (
            <div
              key={p.id}
              className="rounded-lg border border-outline-variant bg-surface-container-low p-4"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-surface-container-highest">
                    <span className="material-symbols-outlined text-xl text-tertiary">
                      {p.icon}
                    </span>
                  </span>
                  <div>
                    <div className="flex items-center gap-2">
                      <p className="font-body-md text-body-md font-medium">{p.name}</p>
                      {account ? (
                        <span className="flex items-center gap-1 rounded-full bg-primary-container/15 px-2 py-0.5 font-label-sm text-label-sm text-primary">
                          <span className="h-1.5 w-1.5 rounded-full bg-primary" />
                          已授权（活跃）
                        </span>
                      ) : (
                        <span className="rounded-full bg-surface-container-highest px-2 py-0.5 font-label-sm text-label-sm text-on-surface-variant">
                          未连接
                        </span>
                      )}
                    </div>
                    <p className="font-label-mono text-label-mono text-outline">{p.apiLabel}</p>
                  </div>
                </div>

                {account ? (
                  <div className="flex items-center gap-3">
                    <div className="text-right">
                      <p className="font-label-md text-label-md">{account.nickname}</p>
                      <p className="font-label-mono text-label-mono text-outline">
                        UID: {account.userId}
                      </p>
                    </div>
                    <button
                      onClick={() => logout(p.id)}
                      className="flex items-center gap-1 rounded-lg border border-outline-variant px-3 py-1.5 font-label-sm text-label-sm text-on-surface-variant transition-colors hover:bg-surface-container-highest hover:text-error"
                    >
                      <span className="material-symbols-outlined text-base">logout</span>
                      退出登录
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => startLogin(p.id)}
                    disabled={loading}
                    className="flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 font-label-md text-label-md font-medium text-on-primary transition-colors hover:bg-primary/85 disabled:opacity-50"
                  >
                    <span className="material-symbols-outlined text-base">qr_code_scanner</span>
                    {loading && qrFor === p.id ? '获取二维码…' : '扫码登录'}
                  </button>
                )}
              </div>

              {account && (
                <div className="mt-3 flex items-center gap-2 border-t border-outline-variant pt-3 font-label-sm text-label-sm text-on-surface-variant">
                  <span className="flex items-center gap-1">
                    <span className="material-symbols-outlined text-sm">bolt</span>
                    同步频率：即时监听
                  </span>
                  <span className="mx-2 h-3 w-px bg-outline-variant" />
                  <span className="flex items-center gap-1">
                    <span className="material-symbols-outlined text-sm">sync_lock</span>
                    凭证经系统钥匙串加密
                  </span>
                  <span className="ml-auto font-label-mono text-label-mono text-outline">
                    AUTO-REFRESH
                  </span>
                </div>
              )}
            </div>
          )
        })}
      </div>

      {qrFor && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="w-80 rounded-lg border border-outline-variant bg-surface-container p-5">
            <div className="flex items-center justify-between">
              <p className="font-body-md text-body-md font-medium">
                扫码登录 {qrMeta?.name ?? qrFor}
              </p>
              <button
                onClick={closeQr}
                className="text-on-surface-variant transition-colors hover:text-on-surface"
              >
                <span className="material-symbols-outlined text-xl">close</span>
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
                  alt="登录二维码"
                  className="mx-auto mt-4 h-48 w-48 rounded-lg border border-outline-variant bg-surface"
                />
                <p className="mt-3 text-center font-label-md text-label-md text-on-surface-variant">
                  {qrStatus}
                </p>
                <p className="mt-1 text-center font-label-sm text-label-sm text-outline">
                  使用手机端 App 扫码确认登录
                </p>
              </>
            ) : (
              <p className="py-10 text-center font-label-md text-label-md text-on-surface-variant">
                正在获取二维码…
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
