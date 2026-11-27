/**
 * 真实网络端到端验证（默认跳过，不影响常规测试与 CI）：
 *   LIVE_VERIFY=1 npx vitest run tests/live
 * 直接实例化 QQ（本地 Koa 服务 + 真实 HttpHandler）与网易云（真实 NCM 模块）适配器，
 * 验证百科搜索/详情与歌曲详情补充（歌词/发行时间）的真实响应字段映射。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { spawn, type ChildProcess } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { join } from 'node:path'
import type { PlatformAdapter } from '../../src/platforms/base'

const run = describe.skipIf(!process.env.LIVE_VERIFY)

run('百科与歌曲详情真实链路验证', () => {
  const require = createRequire(import.meta.url)
  let qq: PlatformAdapter
  let netease: PlatformAdapter
  let qqServer: ChildProcess | null = null
  let kugou: PlatformAdapter

  beforeAll(async () => {
    // --- 网易云：真实 NCM 模块（无网络鉴权需求，匿名接口） ---
    const { NeteaseAdapter } = await import('../../src/platforms/netease')
    const ncm = require('NeteaseCloudMusicApi') as Record<string, (q?: unknown) => Promise<unknown>>
    netease = new NeteaseAdapter(ncm)

    // --- QQ：独立子进程启动真实 Koa 服务（包在 NODE_ENV=test 下不监听端口，
    //      子进程内切为 production；与 Electron 主进程同款 require 根模块方式） ---
    const port = 32127 + Math.floor(Math.random() * 500)
    qqServer = spawn(process.execPath, [join(process.cwd(), 'scripts/qq-api-server.mjs')], {
      env: { ...process.env, PORT: String(port), NODE_ENV: 'production' },
      stdio: ['ignore', 'ignore', 'ignore'],
    })
    const baseUrl = `http://127.0.0.1:${port}`
    let ready = false
    for (let i = 0; i < 40; i++) {
      await sleep(250)
      try {
        const res = await fetch(`${baseUrl}/login/status`)
        if (res.status < 500) {
          ready = true
          break
        }
      } catch {
        // 服务未就绪
      }
    }
    expect(ready).toBe(true)

    const { QqMusicAdapter } = await import('../../src/platforms/qqmusic')
    const handler = async (request: Request): Promise<Response> => {
      const url = new URL(request.url)
      return fetch(`${baseUrl}${url.pathname}${url.search}`, {
        method: request.method,
        headers: request.headers,
        body:
          request.body && request.method !== 'GET' && request.method !== 'HEAD'
            ? await request.arrayBuffer()
            : undefined,
      })
    }
    qq = new QqMusicAdapter(handler, {})

    // --- 酷狗：库模式直调真实 kugoumusicapi，空凭证（设备指纹匿名），验证读接口匿名可用性 ---
    const { KugouAdapter, loadKugouDevice } = await import('../../src/platforms/kugou')
    const kugouApi = require('kugoumusicapi') as Record<string, unknown>
    kugou = new KugouAdapter(kugouApi as never, loadKugouDevice('/tmp/kugou-live-device'))
  }, 60_000)

  afterAll(() => {
    qqServer?.kill()
  })

  // QQ 搜索类接口需登录态（上游已封禁匿名搜索）：设置 QQ_LIVE_SESSION（session token）并配合
  // QQ_SESSION_SECRET / QQ_AUTH_SESSION_PATH / QQ_AUTH_STATE_PATH 指向真实 userData 才运行
  it.skipIf(!process.env.QQ_LIVE_SESSION)('QQ：歌手搜索返回候选，歌手歌曲清单真实可取', async () => {
    const token = process.env.QQ_LIVE_SESSION
    const candidates = await qq.encyclopedia!.search('singer', '周杰伦', token)
    expect(candidates.length).toBeGreaterThan(0)
    const mid = candidates[0].id
    expect(mid).toMatch(/^[0-9A-Za-z]+$/)
    const detail = await qq.encyclopedia!.detail('singer', mid, undefined, token)
    expect(detail.name).toBeTruthy()
    expect(detail.songs!.length).toBeGreaterThan(0)
    expect(detail.songs![0].title).toBeTruthy()
  }, 30_000)

  it('QQ：歌曲详情补充返回歌词与发行时间', async () => {
    const data = await qq.songDetail!.detail('97773', {
      songMid: '0039MnYb0qxYhV',
      albumMid: '000MkMni19ClKG',
    })
    expect(data.lyrics).toBeTruthy()
    expect(data.lyrics).toContain('晴天')
    expect(data.releaseDate).toBe('2003-07-31')
    expect(data.webUrl).toContain('0039MnYb0qxYhV')
  }, 30_000)

  it.skipIf(!process.env.QQ_LIVE_SESSION)('QQ：专辑曲目与发行时间（专辑名搜索 + 精确过滤）', async () => {
    const token = process.env.QQ_LIVE_SESSION
    const detail = await qq.encyclopedia!.detail('album', '000MkMni19ClKG', '叶惠美', token)
    expect(detail.name).toBe('叶惠美')
    expect(detail.releaseDate).toBeTruthy()
    expect(detail.songs!.length).toBeGreaterThan(5)
    expect(detail.songs!.every((s) => s.title)).toBeTruthy()
  }, 30_000)

  it.skipIf(!process.env.QQ_LIVE_SESSION)('QQ：次级标识缺失时按「歌名+歌手」搜索兜底仍能取到歌词', async () => {
    const token = process.env.QQ_LIVE_SESSION
    const data = await qq.songDetail!.detail(
      '97773',
      {},
      { title: '晴天', artist: '周杰伦' },
      token,
    )
    expect(data.lyrics).toBeTruthy()
    expect(data.lyrics).toContain('晴天')
    expect(data.releaseDate).toBe('2003-07-31')
  }, 30_000)

  it('网易云：歌手歌曲清单（artists 模块 hotSongs）', async () => {
    const candidates = await netease.encyclopedia!.search('singer', '周杰伦')
    expect(candidates.length).toBeGreaterThan(0)
    const detail = await netease.encyclopedia!.detail('singer', '6452')
    expect(detail.name).toBe('周杰伦')
    expect(detail.songs!.length).toBeGreaterThan(10)
    expect(detail.songs![0].title).toBeTruthy()
  }, 30_000)

  it('网易云：专辑曲目清单与发行时间（album 模块 songs）', async () => {
    const detail = await netease.encyclopedia!.detail('album', '18905', '叶惠美')
    expect(detail.name).toBe('叶惠美')
    // 上游 publishTime 在 07-30/07-31 间漂移过，live 只校验格式与稳定的年月
    expect(detail.releaseDate).toMatch(/^2003-07-\d{2}$/)
    expect(detail.songs!.length).toBeGreaterThan(5)
  }, 30_000)

  it('网易云：歌曲详情补充返回歌词与发行时间', async () => {
    const data = await netease.songDetail!.detail('186016', { albumId: '18905' })
    // 网易 LRC 前段为作词/作曲 credits，正文在后续行；断言歌词长度与时间戳形态
    expect(data.lyrics).toBeTruthy()
    expect(data.lyrics!.length).toBeGreaterThan(200)
    expect(data.lyrics).toMatch(/\[\d{2}:\d{2}/)
    expect(data.releaseDate).toBeTruthy()
    expect(data.webUrl).toContain('186016')
  }, 30_000)

  it('酷狗：匿名（仅设备指纹）歌手搜索与歌手歌曲清单（含头像）', async () => {
    const candidates = await kugou.encyclopedia!.search('singer', '周杰伦', '')
    expect(candidates.length).toBeGreaterThan(0)
    const detail = await kugou.encyclopedia!.detail('singer', candidates[0].id, '周杰伦', '')
    expect(detail.name).toBeTruthy()
    expect(detail.songs!.length).toBeGreaterThan(0)
    expect(detail.songs![0].title).toBeTruthy()
    // 头像：详情接口不带图，经名字搜索补 Avatar（https 可直达）
    expect(detail.imageUrl).toMatch(/^https:\/\//)
  }, 30_000)

  it('酷狗：匿名（仅设备指纹）专辑曲目与发行时间', async () => {
    const candidates = await kugou.encyclopedia!.search('album', '叶惠美', '')
    expect(candidates.length).toBeGreaterThan(0)
    const detail = await kugou.encyclopedia!.detail(
      'album',
      candidates[0].id,
      candidates[0].name,
      '',
    )
    expect(detail.name).toBeTruthy()
    expect(detail.songs!.length).toBeGreaterThan(0)
  }, 30_000)
})
