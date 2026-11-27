import { describe, it, expect } from 'vitest'
import {
  ipcErrorMessage,
  userFacingErrorMessage,
} from '../../src/renderer/src/utils/ipcError'
import { isUserReadableMessage, normalizeIpcError } from '../../src/core/ipcError'

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

  it('剥离裸 Error: 前缀（preload 兜底后的残留）', () => {
    expect(ipcErrorMessage(new Error('Error: 酷狗：创建歌单失败'))).toBe('酷狗：创建歌单失败')
    expect(ipcErrorMessage(new Error('Error: Error: 已重试 3 次'))).toBe('已重试 3 次')
  })
})

describe('normalizeIpcError — 多层包装统一剥离', () => {
  it('只剥一层 invoke 包装，消息内 "Error" 字样保留', () => {
    expect(
      normalizeIpcError(
        new Error("Error invoking remote method 'platform:sync-playlist': Error: 酷狗：创建歌单失败"),
      ),
    ).toBe('酷狗：创建歌单失败')
  })

  it('无包装字符串原样返回（trim）', () => {
    expect(normalizeIpcError('  登录已过期  ')).toBe('登录已过期')
    expect(normalizeIpcError('')).toBe('')
  })
})

describe('isUserReadableMessage — 技术性报错识别', () => {
  it('中文可读文案放行', () => {
    expect(isUserReadableMessage('酷狗：操作频繁，请稍候再试')).toBe(true)
    expect(isUserReadableMessage('酷狗：创建歌单失败')).toBe(true)
  })

  it('英文可读文案放行（英文界面平台错误）', () => {
    expect(isUserReadableMessage('Apple Music: playlist creation failed')).toBe(true)
  })

  it('技术性报错回退', () => {
    expect(isUserReadableMessage('Request failed with status code 500')).toBe(false)
    expect(isUserReadableMessage('Error invoking remote method \'platform:sync-playlist\': Error: 酷狗：创建歌单失败')).toBe(false)
    expect(isUserReadableMessage('Error: connect ECONNREFUSED 127.0.0.1:443')).toBe(false)
    expect(isUserReadableMessage('Cannot read properties of undefined (reading \'map\')')).toBe(false)
    expect(isUserReadableMessage('Unexpected token < in JSON at position 0')).toBe(false)
    expect(isUserReadableMessage('undefined')).toBe(false)
  })

  it('空串/纯符号/超长文案回退', () => {
    expect(isUserReadableMessage('')).toBe(false)
    expect(isUserReadableMessage('###')).toBe(false)
    expect(isUserReadableMessage(`失败${'原因'.repeat(80)}`)).toBe(false)
  })
})

describe('userFacingErrorMessage — 展示统一出口', () => {
  it('可读错误原样返回', () => {
    expect(userFacingErrorMessage(new Error('酷狗：创建歌单失败'), '同步失败')).toBe(
      '酷狗：创建歌单失败',
    )
  })

  it('IPC 包装剥离后可读则还原', () => {
    expect(
      userFacingErrorMessage(
        new Error(
          "Error invoking remote method 'platform:sync-playlist': Error: 酷狗：创建歌单失败",
        ),
        '同步失败',
      ),
    ).toBe('酷狗：创建歌单失败')
  })

  it('技术性报错回退通用文案', () => {
    expect(
      userFacingErrorMessage(
        new Error("Error invoking remote method 'platform:sync-playlist': Error: connect ETIMEDOUT"),
        '同步失败',
      ),
    ).toBe('同步失败')
    expect(userFacingErrorMessage(new Error('Request failed with status code 502'), '同步失败')).toBe(
      '同步失败',
    )
  })

  it('空消息回退通用文案', () => {
    expect(userFacingErrorMessage(new Error(''), '同步失败')).toBe('同步失败')
    expect(userFacingErrorMessage(undefined, '同步失败')).toBe('同步失败')
  })

  it('已友好文案幂等保留（重复过滤不误伤）', () => {
    expect(userFacingErrorMessage('未找到匹配：晴天 - 周杰伦', '同步失败')).toBe(
      '未找到匹配：晴天 - 周杰伦',
    )
  })
})
