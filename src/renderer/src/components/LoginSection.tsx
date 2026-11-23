import { useEffect, useRef, useState } from 'react'
import type { PlatformAccount, QrLoginTicket } from '@core/models/platform'

interface LoginSectionProps {
  account: PlatformAccount | null
  onAccountChange: (account: PlatformAccount | null) => void
}

export default function LoginSection({ account, onAccountChange }: LoginSectionProps) {
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

  const startLogin = async () => {
    setError('')
    setLoading(true)
    try {
      const t = await window.electronAPI.netease.createQr()
      setTicket(t)
      setQrStatus('等待扫码…')
      pollRef.current = setInterval(async () => {
        try {
          const result = await window.electronAPI.netease.checkQr(t.key)
          if (result.status === 'success') {
            stopPolling()
            setQrStatus('登录成功！')
            const status = await window.electronAPI.netease.loginStatus()
            setTicket(null)
            onAccountChange(status)
          } else if (result.status === 'expired') {
            stopPolling()
            setQrStatus('二维码已过期')
            setError('二维码已过期，请重新获取')
          } else if (result.status === 'scanned') {
            setQrStatus('已扫码，请在手机上确认')
          }
        } catch {
          // 轮询失败保持现状
        }
      }, 2000)
    } catch (e) {
      setError(e instanceof Error ? e.message : '登录失败')
    } finally {
      setLoading(false)
    }
  }

  const logout = async () => {
    await window.electronAPI.netease.logout()
    onAccountChange(null)
  }

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5">
      <h2 className="text-base font-semibold text-slate-800">网易云音乐</h2>

      {account ? (
        <div className="mt-3 flex items-center justify-between">
          <div className="text-sm text-slate-600">
            <span className="text-slate-800">{account.nickname}</span>
            <span className="ml-2 text-xs text-slate-400">ID: {account.userId}</span>
          </div>
          <button
            onClick={logout}
            className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm text-slate-500 hover:bg-slate-50"
          >
            退出登录
          </button>
        </div>
      ) : (
        <div className="mt-3">
          <button
            onClick={startLogin}
            disabled={loading}
            className="rounded-lg bg-red-500 px-4 py-2 text-sm font-medium text-white hover:bg-red-600 disabled:opacity-50"
          >
            {loading ? '获取二维码…' : '扫码登录'}
          </button>
          {error && <p className="mt-2 text-sm text-red-500">{error}</p>}
        </div>
      )}

      {ticket && (
        <div className="mt-4 text-center">
          <img
            src={ticket.qrBase64}
            alt="网易云登录二维码"
            className="mx-auto h-48 w-48 rounded-lg border border-slate-100"
          />
          <p className="mt-2 text-sm text-slate-500">{qrStatus}</p>
          <button
            onClick={() => {
              stopPolling()
              setTicket(null)
            }}
            className="mt-2 text-xs text-slate-400 underline"
          >
            取消
          </button>
        </div>
      )}
    </section>
  )
}
