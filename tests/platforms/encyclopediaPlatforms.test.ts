/**
 * QQ / 网易云百科与歌曲详情映射契约测试：
 * fixture 全部来自 LIVE_VERIFY 真实响应抓取（tests/live/encyclopediaLive.test.ts 实测），
 * 防止字段级回归（QQ 路径参数→query 参数、singerMID 大写键、wiki CDATA、网易 body 包装等历史 bug）。
 */
import { describe, it, expect } from 'vitest'
import { QqMusicAdapter } from '../../src/platforms/qqmusic'
import { NeteaseAdapter, type NcmApi } from '../../src/platforms/netease'
import { KugouAdapter, type KugouApi, type KugouDevice } from '../../src/platforms/kugou'
import type { HttpHandler } from '../../src/platforms/httpHandler'

const jsonResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

/** 按真实抓取的路由表返回 QQ 响应 */
function qqHandler(): HttpHandler {
  return async (request) => {
    const url = new URL(request.url)
    if (url.pathname === '/getLyric') {
      expect(url.searchParams.get('songmid')).toBe('0039MnYb0qxYhV')
      return jsonResponse({
        response: { retcode: 0, code: 0, subcode: 0, lyric: '[00:00.00]晴天 - 周杰伦\n[00:29.26]故事的小黄花' },
      })
    }
    if (url.pathname === '/getAlbumInfo') {
      expect(url.searchParams.get('albummid')).toBe('000MkMni19ClKG')
      return jsonResponse({
        response: {
          code: 0,
          // 真实形态：data 为对象（非数组），发行时间字段为 aDate
          data: { aDate: '2003-07-31', name: '叶惠美', desc: '⊙历经一年企划　引爆市场' },
        },
      })
    }
    if (url.pathname === '/singer/songs') {
      expect(url.searchParams.get('mid')).toBe('0025NhlN2yWrP4')
      return jsonResponse({
        code: 200,
        songs: [
          {
            id: 97773,
            mid: '0039MnYb0qxYhV',
            name: '晴天',
            singer: [{ mid: '0025NhlN2yWrP4', name: '周杰伦' }],
            album: { id: 8220, mid: '000MkMni19ClKG', name: '叶惠美' },
            interval: 269,
          },
          {
            id: 718475,
            mid: '0027oMO61wWi55',
            name: '发如雪',
            singer: [{ mid: '0025NhlN2yWrP4', name: '周杰伦' }],
            album: { id: 60671, mid: '0024bjiL2aocxT', name: '十一月的萧邦' },
            interval: 300,
          },
        ],
      })
    }
    if (url.pathname === '/search' && url.searchParams.get('type') === 'singer') {
      return jsonResponse({
        items: [
          { singerID: 4558, singerMID: '0025NhlN2yWrP4', singerName: '周杰伦', singerPic: 'http://y.gtimg.cn/music/photo_new/T001R150x150M0000025NhlN2yWrP4_11.jpg' },
        ],
      })
    }
    if (url.pathname === '/search' && url.searchParams.get('type') === 'album') {
      return jsonResponse({
        items: [{ albummid: '000MkMni19ClKG', name: '叶惠美' }],
      })
    }
    if (url.pathname === '/search' && url.searchParams.get('type') === 'song') {
      const keyword = url.searchParams.get('keyword') ?? ''
      if (keyword === '叶惠美') {
        return jsonResponse({
          items: [
            {
              id: 97773,
              mid: '0039MnYb0qxYhV',
              name: '晴天',
              singer: [{ mid: '0025NhlN2yWrP4', name: '周杰伦' }],
              album: { id: 8220, mid: '000MkMni19ClKG', name: '叶惠美', time_public: '2003-07-31' },
            },
            {
              id: 97774,
              mid: '001n4C3p1yv0FU',
              name: '以父之名',
              singer: [{ mid: '0025NhlN2yWrP4', name: '周杰伦' }],
              album: { id: 8220, mid: '000MkMni19ClKG', name: '叶惠美', time_public: '2003-07-31' },
            },
            // 同名专辑干扰项：过滤后不应出现
            {
              id: 99991,
              mid: '003x0Cya1E9cTH',
              name: '三年二班',
              singer: [{ mid: '0025NhlN2yWrP4', name: '周杰伦' }],
              album: { id: 9000, mid: 'xxxxx', name: '周杰伦《叶惠美》吉他翻唱版', time_public: '2020-01-01' },
            },
          ],
        })
      }
      return jsonResponse({
        items: [
          {
            id: 97773,
            mid: '0039MnYb0qxYhV',
            name: '晴天',
            singer: [{ mid: '0025NhlN2yWrP4', name: '周杰伦' }],
            album: { id: 8220, mid: '000MkMni19ClKG', name: '叶惠美' },
          },
        ],
      })
    }
    throw new Error(`未预期的 QQ 请求: ${url.pathname}`)
  }
}

/** 按真实抓取的模块结构返回网易云响应（{ status, body, cookie } 包装） */
function fakeNcm(): NcmApi {
  return {
    lyric: async () => ({
      status: 200,
      body: {
        lrc: { version: 70, lyric: '[00:00.000] 作词 : 周杰伦\n[00:29.000]故事的小黄花\n[00:32.000]从出生那年就飘着' },
      },
      cookie: [],
    }),
    song_detail: async () => ({
      status: 200,
      body: {
        songs: [
          { id: 186016, name: '晴天', publishTime: 1059580800000, al: { id: 18905, name: '叶惠美' } },
        ],
      },
      cookie: [],
    }),
    album: async () => ({
      status: 200,
      body: {
        album: { id: 18905, name: '叶惠美', picUrl: 'http://p4.music.126.net/cover.jpg', publishTime: 1059580800000 },
        songs: [
          { id: 186016, name: '晴天', dt: 269000, ar: [{ id: 6452, name: '周杰伦' }], al: { id: 18905, name: '叶惠美' } },
          { id: 186024, name: '以父之名', dt: 342000, ar: [{ id: 6452, name: '周杰伦' }], al: { id: 18905, name: '叶惠美' } },
        ],
      },
      cookie: [],
    }),
    artists: async () => ({
      status: 200,
      body: {
        artist: { id: 6452, name: '周杰伦', cover: 'http://p3.music.126.net/cover.jpg' },
        hotSongs: [
          { id: 186016, name: '晴天', dt: 269000, ar: [{ id: 6452, name: '周杰伦' }], al: { id: 18905, name: '叶惠美' } },
          { id: 167827, name: '青花瓷', dt: 239000, ar: [{ id: 6452, name: '周杰伦' }], al: { id: 18908, name: '我很忙' } },
        ],
      },
      cookie: [],
    }),
    cloudsearch: async () => ({
      status: 200,
      body: {
        result: {
          artists: [{ id: 6452, name: '周杰伦', alias: ['Jay Chou'], picUrl: 'http://p4.music.126.net/a.jpg' }],
          albums: [{ id: 18905, name: '叶惠美', picUrl: 'http://p4.music.126.net/b.jpg', artist: { name: '周杰伦' } }],
        },
      },
      cookie: [],
    }),
  } as unknown as NcmApi
}

describe('QqMusicAdapter — 百科与歌曲详情映射契约（真实响应样本）', () => {
  const adapter = new QqMusicAdapter(qqHandler(), {})

  it('歌曲详情：歌词取 response.lyric、发行时间取 response.data.aDate（对象形态）', async () => {
    const data = await adapter.songDetail!.detail('97773', {
      songMid: '0039MnYb0qxYhV',
      albumMid: '000MkMni19ClKG',
    })
    expect(data.lyrics).toContain('故事的小黄花')
    expect(data.releaseDate).toBe('2003-07-31')
    expect(data.webUrl).toContain('0039MnYb0qxYhV')
  })

  it('次级标识缺失时按「歌名+歌手」搜索兜底定位 mid 再取歌词', async () => {
    const data = await adapter.songDetail!.detail(
      '97773',
      {},
      { title: '晴天', artist: '周杰伦' },
    )
    expect(data.lyrics).toContain('故事的小黄花')
    expect(data.releaseDate).toBe('2003-07-31')
    expect(data.webUrl).toContain('0039MnYb0qxYhV')
  })

  it('歌手歌曲：/singer/songs 曲目映射为清单，歌手名取自首曲，附歌曲页跳转', async () => {
    const detail = await adapter.encyclopedia!.detail('singer', '0025NhlN2yWrP4')
    expect(detail.name).toBe('周杰伦')
    expect(detail.songs).toHaveLength(2)
    expect(detail.songs![0]).toMatchObject({ id: '97773', title: '晴天' })
    expect(detail.songs![1]).toMatchObject({ id: '718475', title: '发如雪' })
    expect(detail.songs![0].webUrl).toContain('0039MnYb0qxYhV')
    expect(detail.sourceUrl).toContain('0025NhlN2yWrP4')
  })

  it('专辑曲目：按专辑名搜索歌曲并精确过滤专辑名、发行时间取自条目 time_public', async () => {
    const detail = await adapter.encyclopedia!.detail('album', '000MkMni19ClKG', '叶惠美')
    expect(detail.name).toBe('叶惠美')
    expect(detail.releaseDate).toBe('2003-07-31')
    expect(detail.songs).toHaveLength(2)
    expect(detail.songs!.map((s) => s.title)).toEqual(['晴天', '以父之名'])
    expect(detail.songs![0].webUrl).toContain('0039MnYb0qxYhV')
    expect(detail.sourceUrl).toContain('000MkMni19ClKG')
  })

  it('歌手搜索：读取 singerMID/singerName/singerPic（大写后缀键）', async () => {
    const candidates = await adapter.encyclopedia!.search('singer', '周杰伦')
    expect(candidates).toEqual([
      expect.objectContaining({
        id: '0025NhlN2yWrP4',
        name: '周杰伦',
        picUrl: expect.stringContaining('https://'),
      }),
    ])
  })

  it('专辑搜索：读取 albummid（全小写键）', async () => {
    const candidates = await adapter.encyclopedia!.search('album', '叶惠美')
    expect(candidates).toEqual([expect.objectContaining({ id: '000MkMni19ClKG', name: '叶惠美' })])
  })
})

/** 酷狗响应样本：字段契约来自 kugoumusicapi 源码与安卓端惯例（📐 未实测），映射多键容错 */
const KUGOU_DEVICE: KugouDevice = {
  guid: 'guid-1',
  mid: '123456789012345678901234567890',
  dev: 'ABCDEFGHIJ',
}

describe('KugouAdapter — 实体面板映射契约（📐 源码契约，未实测响应）', () => {
  function makeKugouApi(): KugouApi {
    return {
      search: async (params?: Record<string, unknown>) => {
        const type = params?.type
        if (type === 'author') {
          return {
            status: 200,
            body: {
              data: {
                lists: [
                  { AuthorId: 3520, AuthorName: '周杰伦', Avatar: 'http://singerimg.kugou.com/uploadpic/softhead/240/avatar.jpg', FansNum: 25988691 },
                ],
              },
            },
            cookie: [],
          }
        }
        if (type === 'album') {
          return {
            status: 200,
            body: {
              data: {
                lists: [
                  { albumid: 966846, albumname: '叶惠美', singer: '周杰伦', img: 'http://imge.kugou.com/stdmusic/240/cover.jpg', publish_time: '2003-07-31' },
                ],
              },
            },
            cookie: [],
          }
        }
        return { status: 200, body: { data: { lists: [] } }, cookie: [] }
      },
      artist_audios: async () => ({
        status: 200,
        body: {
          total: 2,
          error_code: 0,
          data: [
            { audio_id: 314877945, hash: 'HASHAAAA', audio_name: '晴天', author_name: '周杰伦', album_name: '叶惠美', timelength: 269000 },
            { audio_id: 314877946, hash: 'HASHBBBB', audio_name: '发如雪', author_name: '周杰伦', album_name: '十一月的萧邦', timelength: 300000 },
          ],
        },
        cookie: [],
      }),
      album_detail: async () => ({
        status: 200,
        body: { data: [{ album_id: 966846, album_name: '叶惠美', publish_date: '2003-07-31', sizable_cover: 'http://img/cover.jpg' }] },
        cookie: [],
      }),
      album_songs: async () => ({
        status: 200,
        body: {
          data: {
            songs: [
              { audio_id: 314877945, hash: 'HASHAAAA', audio_name: '晴天', author_name: '周杰伦', album_name: '叶惠美', timelength: 269000 },
              { audio_id: 314877946, hash: 'HASHBBBB', audio_name: '以父之名', author_name: '周杰伦', album_name: '叶惠美', timelength: 342000 },
            ],
          },
        },
        cookie: [],
      }),
    } as unknown as KugouApi
  }

  it('歌手搜索：author 类型候选含歌手 id/名/头像', async () => {
    const adapter = new KugouAdapter(makeKugouApi(), KUGOU_DEVICE)
    const candidates = await adapter.encyclopedia!.search('singer', '周杰伦', 'cookie')
    expect(candidates).toEqual([
      expect.objectContaining({
        id: '3520',
        name: '周杰伦',
        picUrl: expect.stringContaining('https://'),
        followerCount: 25988691,
      }),
    ])
  })

  it('专辑搜索：album 类型候选含专辑 id/名/歌手（singer）', async () => {
    const adapter = new KugouAdapter(makeKugouApi(), KUGOU_DEVICE)
    const candidates = await adapter.encyclopedia!.search('album', '叶惠美', 'cookie')
    expect(candidates).toEqual([
      expect.objectContaining({ id: '966846', name: '叶惠美', singer: '周杰伦' }),
    ])
  })

  it('歌手歌曲：artist_audios 曲目映射（data 数组、author_name 歌手、timelength 毫秒）', async () => {
    const adapter = new KugouAdapter(makeKugouApi(), KUGOU_DEVICE)
    const detail = await adapter.encyclopedia!.detail('singer', '3520', '周杰伦', 'cookie')
    expect(detail.songs).toHaveLength(2)
    expect(detail.songs![0]).toMatchObject({ id: 'hashaaaa', title: '晴天', artist: '周杰伦', durationMs: 269000 })
    expect(detail.songs![0].webUrl).toContain('hashaaaa')
    expect(detail.sourceUrl).toContain('3520')
  })

  it('专辑曲目：album_detail 发行时间 + album_songs 曲目清单（data.songs）', async () => {
    const adapter = new KugouAdapter(makeKugouApi(), KUGOU_DEVICE)
    const detail = await adapter.encyclopedia!.detail('album', '966846', '叶惠美', 'cookie')
    expect(detail.name).toBe('叶惠美')
    expect(detail.releaseDate).toBe('2003-07-31')
    expect(detail.songs).toHaveLength(2)
    expect(detail.songs!.map((s) => s.title)).toEqual(['晴天', '以父之名'])
  })

  it('歌曲详情：仅提供平台跳转（酷狗无公开歌词 id 来源，歌词/发行时间缺失）', async () => {
    const adapter = new KugouAdapter(makeKugouApi(), KUGOU_DEVICE)
    const data = await adapter.songDetail!.detail('HASH1', {})
    expect(data.webUrl).toContain('HASH1')
    expect(data.lyrics).toBeUndefined()
  })
})

describe('NeteaseAdapter — 百科与歌曲详情映射契约（真实响应样本）', () => {
  const adapter = new NeteaseAdapter(fakeNcm())

  it('歌曲详情：歌词取 body.lrc.lyric、发行时间取 body.songs[0].publishTime（东八区日期）', async () => {
    const data = await adapter.songDetail!.detail('186016', { albumId: '18905' })
    expect(data.lyrics).toContain('故事的小黄花')
    // publishTime 1059580800000 = 北京时间 2003-07-31 00:00（UTC 为 7-30 16:00）
    expect(data.releaseDate).toBe('2003-07-31')
    expect(data.webUrl).toContain('186016')
  })

  it('歌手歌曲：artists 模块 hotSongs 映射为清单，附歌曲页跳转', async () => {
    const detail = await adapter.encyclopedia!.detail('singer', '6452')
    expect(detail.name).toBe('周杰伦')
    expect(detail.songs).toHaveLength(2)
    expect(detail.songs![0]).toMatchObject({ id: '186016', title: '晴天' })
    expect(detail.songs![1]).toMatchObject({ id: '167827', title: '青花瓷' })
    expect(detail.songs![0].webUrl).toContain('186016')
    expect(detail.imageUrl).toContain('https://')
  })

  it('专辑曲目：album 模块 songs + publishTime → 曲目清单与发行时间（东八区日期）', async () => {
    const detail = await adapter.encyclopedia!.detail('album', '18905')
    expect(detail.name).toBe('叶惠美')
    // publishTime 1059580800000 = 北京时间 2003-07-31 00:00
    expect(detail.releaseDate).toBe('2003-07-31')
    expect(detail.songs).toHaveLength(2)
    expect(detail.songs!.map((s) => s.title)).toEqual(['晴天', '以父之名'])
  })

  it('歌手搜索：body.result.artists 含别名与头像', async () => {
    const candidates = await adapter.encyclopedia!.search('singer', '周杰伦')
    expect(candidates).toEqual([
      expect.objectContaining({ id: '6452', name: '周杰伦', aliases: ['Jay Chou'] }),
    ])
  })

  it('专辑搜索：body.result.albums 附歌手名（singer）', async () => {
    const candidates = await adapter.encyclopedia!.search('album', '叶惠美')
    expect(candidates).toEqual([
      expect.objectContaining({ id: '18905', name: '叶惠美', singer: '周杰伦' }),
    ])
  })
})
