import { describe, it, expect } from 'vitest'
import { ipcErrorMessage } from '../../src/renderer/src/utils/ipcError'

describe('ipcErrorMessage — IPC 错误包装解包', () => {
  it('剥离 Electron invoke 包装还原真实消息', () => {
    expect(
      ipcErrorMessage(
        new Error(
          "Error invoking remote method 'platform:playlist-remove-songs': Error: Apple Music 官方接口暂不支持从歌单移除歌曲",
        ),
      ),
    ).toBe('Apple Music 官方接口暂不支持从歌单移除歌曲')
  })

  it('兼容无 Error 前缀的包装', () => {
    expect(
      ipcErrorMessage(new Error("Error invoking remote method 'platform:logout': 未知平台")),
    ).toBe('未知平台')
  })

  it('非 IPC 包装的消息原样返回', () => {
    expect(ipcErrorMessage(new Error('尚未登录'))).toBe('尚未登录')
  })

  it('非 Error 输入安全兜底', () => {
    expect(ipcErrorMessage('普通字符串错误')).toBe('普通字符串错误')
    expect(ipcErrorMessage(undefined)).toBe('undefined')
  })
})
