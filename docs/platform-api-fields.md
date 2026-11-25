# 上游平台接口出入参样例（实测）

> 本文档记录 SyncWave 所接入的**上游平台接口**（QQ音乐本地服务、网易云 API 网关、酷狗库模式 API、Apple Music Web API）的请求/响应样例，
> 供字段提取、模型映射与风格（genre）类需求参考。
>
> **样例真实性说明**（数据截至 2026-11-24）：
>
> | 标注 | 含义 |
> |---|---|
> | ✅ 实测抓取 | 通过临时启动 QQ 音乐本地服务（`@yakult-green-tea/qq-music-api`）或直连网易云公开接口抓取的真实响应，字段与值均为真实数据 |
> | 📐 SDK/NCM 源码 | 未做真实写操作/需登录未抓到的接口，字段与层级取自 SDK、NeteaseCloudMusicApi 模块源码或适配器代码，值为示意 |
>
> **完整性约定**：
>
> - 每个接口的**入参、出参字段全部列出**，逐字段标注含义；实测抓取的响应体中每个字段均保留。
> - 对含义未公开的内部字段，如实标注「未公开文档」并附实测值，不做猜测。
> - 数组型字段仅存在值层面重复（如 200 个 `trackIds` 元素结构相同），文档给出完整元素字段表并展示 1 个真实元素，其余注明数量。
>
> 应用日志（`<userData>/logs/app-*.log`）只记录调用元信息（事件、耗时、数量、userId），不含完整出入参，
> 因此写入类接口没有可直接引用的真实响应样例。

---

## 0. 响应外层约定

**QQ音乐**（`@yakult-green-tea/qq-music-api`）：

- 成功：`okResult` 统一为 `{ code: 200, ...业务字段 }`
- 失败：`{ code, kind?, errorKey?, message, retryable?, ... }`，其中 `kind` / `errorKey` 为 SDK 自定义错误分类
- 凭证：请求头 `x-qq-session` 携带登录 token；`/login/qr/check` 的 token 经 `set-cookie` 返回

**网易云**（`NeteaseCloudMusicApi`）：

- 统一响应外层：`{ status, body, cookie }`，`body` 为网易 Web API 原始响应（`{ code: 200, ... }`）
- 登录凭证：`cookie` 参数随请求透传

---

## 1. QQ音乐

### 1.1 登录

#### `GET /login/qr/key?channel=<qqmusic|wechat|qq>`

| 入参 | 类型 | 含义 |
|---|---|---|
| `channel` | string | 登录通道：`qqmusic`=QQ音乐App扫码（默认）、`wechat`=微信扫码、`qq`=手机QQ扫码 |

✅ 真实响应（2026-11-24 实测）：

```json
{ "code": 200, "data": { "unikey": "6e480269cfdaa95bc99a8fef3473993ebbd54bd9a30d8362" } }
```

| 出参 | 类型 | 含义 |
|---|---|---|
| `code` | number | 200 = 成功（SDK 统一外层） |
| `data.unikey` | string | 本次二维码票据 key，随后传给 `create` / `check` |

#### `GET /login/qr/create?key=<unikey>`

| 入参 | 类型 | 含义 |
|---|---|---|
| `key` | string | 上一步返回的 `unikey` |

响应（📐 结构来自 SDK；`qrimg` 为 base64 PNG 数据 URL，长度为数据内容不固定，这里给出字段而非完整值）：

```json
{ "code": 200, "data": { "qrimg": "data:image/png;base64,iVBORw0KGgo…" } }
```

| 出参 | 类型 | 含义 |
|---|---|---|
| `code` | number | 200 = 成功 |
| `data.qrimg` | string | 二维码图片（base64 数据 URL），前端直接用于 `<img src>` |

#### `GET /login/qr/check?key=<unikey>`

| 入参 | 类型 | 含义 |
|---|---|---|
| `key` | string | 上一步返回的 `unikey` |

| 出参 | 类型 | 含义 |
|---|---|---|
| `code` | number | 轮询状态：`800`=二维码已过期；`801`=等待扫码；`802`=已扫码待确认；`803`=登录成功 |
| `set-cookie` 响应头 | string | code=803 时返回 `qqmusic_session=<token>`，客户端提取后用作 `x-qq-session` 请求头 |

#### `GET /login/status`（需登录）

| 入参 | 位置 | 含义 |
|---|---|---|
| `x-qq-session` | 请求头 | 登录 token |

响应（📐 结构来自 SDK 源码 `publicProfileFromCredential` + 上游 `GetLoginUserInfo`）：

```json
{ "code": 200, "data": { "profile": { "musicid": "983843680", "str_musicid": "983843680", "nickname": "示例用户" } } }
```

| 出参 | 类型 | 含义 |
|---|---|---|
| `code` | number | 200 = 成功 |
| `data.profile.musicid` / `str_musicid` | string | 账号 ID（QQ 音乐 musicid；微信账号为长数字） |
| `data.profile.nickname` / `nick` | string | 昵称 |
| `data.profile.avatarUrl` | string | 头像 URL（存在时返回） |

✅ 未登录时的真实错误响应（2026-11-24 实测，`/song/genre` 未登录返回，为带完整错误分类的格式）：

```json
{
  "code": 401,
  "kind": "auth-missing",
  "errorKey": "auth.required",
  "message": "Login required",
  "retryable": false
}
```

| 出参 | 类型 | 含义 |
|---|---|---|
| `code` | number | 401 = 未登录/凭证无效 |
| `kind` | string | SDK 错误分类（`auth-missing`=缺凭证、`input`=参数错误、`invalid-response`=上游响应格式异常等） |
| `errorKey` | string | 错误键（`auth.required`） |
| `message` | string | 人类可读错误信息 |
| `retryable` | boolean | 是否可重试 |

注：部分路由（如 `/user/playlist`、`/user/playlist-detail`）未登录只返回 `{ "code": 401, "message": "Login required" }`（✅ 实测，无 `kind`/`errorKey`）。

### 1.2 搜索与歌曲条目

#### `GET /search?keyword=<kw>&type=<type>&page=<n>&limit=<n>`

| 入参 | 类型 | 含义 |
|---|---|---|
| `keyword` | string | 搜索关键字（必填，trim 后非空、≤60 字） |
| `type` | string | 搜索类型：`song`（默认）/ `album` / `playlist` / `singer` |
| `page` | number | 页码（正整数，默认 1） |
| `limit` | number | 每页条数（1-20，默认 10） |

✅ 真实响应（2026-11-24 实测，`keyword=晴天&type=song&limit=1`；完整响应，未裁剪）：

```json
{
  "code": 200,
  "type": "song",
  "page": 1,
  "limit": 1,
  "total": 980,
  "more": true,
  "items": [
    {
      "act": 3,
      "action": { "alert": 41, "icon2": 0, "icons": 14073854, "msgdown": 0, "msgfav": 0, "msgid": 13, "msgpay": 6, "msgshare": 0, "switch": 16897793, "switch2": 1048576 },
      "album": { "id": 8220, "mid": "000MkMni19ClKG", "name": "叶惠美", "pmid": "000MkMni19ClKG_5", "subtitle": "", "time_public": "", "title": "叶惠美" },
      "author": "",
      "bpm": 0,
      "content": "晴天 - 周杰伦 (Jay Chou)\n词：周杰伦\n曲：周杰伦\n编曲：周杰伦\n制作人：周杰伦\n合声：周杰伦\n合声编写：周杰伦\n吉他：蔡科俊Again\n贝斯：陈任佑\n鼓：陈柏州\n录音助理：刘勇志\n录音工程：杨瑞代（Alfa Studio）\n混音工程：杨大纬（杨大纬录音工作室）\n故事的小黄花\n从出生那年就飘着\n童年的荡秋千\n随记忆一直晃到现在\nRe So So Si Do Si La \nSo La Si Si Si Si La Si La So \n吹着前奏望着天空\n我想起花瓣试着掉落\n为你翘课的那一天\n花落的那一天\n教室的那一间\n我怎么看不见\n消失的下雨天\n我好想再淋一遍\n没想到失去的勇气我还留着\n好想再问一遍\n你会等待还是离开\n刮风这天我试过握着你手\n但偏偏雨渐渐大到我看你不见\n还要多久我才能在你身边\n等到放晴的那天也许我会比较好一点\n从前从前有个人爱你很久\n但偏偏风渐渐把距离吹得好远\n好不容易又能再多爱一天\n但故事的最后你好像还是说了拜拜\n为你翘课的那一天\n花落的那一天\n教室的那一间\n我怎么看不见\n消失的下雨天\n我好想再淋一遍\n没想到失去的勇气我还留着\n好想再问一遍\n你会等待还是离开\n刮风这天我试过握着你手\n但偏偏雨渐渐大到我看你不见\n还要多久我才能够在你身边\n等到放晴那天也许我会比较好一点\n从前从前有个人爱你很久\n但偏偏雨渐渐把距离吹得好远\n好不容易又能再多爱一天\n但故事的最后你好像还是说了拜",
      "custom_data": "",
      "data_type": 0,
      "desc": "",
      "docid": "4660176279196411288",
      "eq": 2,
      "es": "",
      "file": { "b_30s": 0, "e_30s": 60000, "hires_bitdepth": 0, "hires_sample": 0, "media_mid": "003Qui1q2u1Zho", "size_128mp3": 4317292, "size_192aac": 6519764, "size_192ogg": 5860576, "size_24aac": 0, "size_320mp3": 10792943, "size_360ra": [], "size_48aac": 1642440, "size_96aac": 3283546, "size_96ogg": 2927865, "size_ape": 0, "size_dolby": 0, "size_dts": 0, "size_flac": 55397039, "size_hires": 0, "size_new": [186980254, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], "size_try": 960887, "try_begin": 84346, "try_end": 142843, "url": "" },
      "fnote": 4009,
      "genre": 0,
      "grp": [],
      "hotness_desc": "",
      "href3": "http://stream10.qqmusic.qq.com/30097773.mp3",
      "id": 97773,
      "index_album": 3,
      "index_cd": 0,
      "interval": 269,
      "isonly": 0,
      "ksong": { "id": 8606, "mid": "000oBPpd23GbIo" },
      "label": "0",
      "language": 0,
      "lyric": "",
      "mid": "0039MnYb0qxYhV",
      "mv": { "id": 293791, "name": "", "title": "", "vid": "w0026q7f01a", "vt": 0 },
      "name": "晴天",
      "newStatus": 2,
      "ov": 0,
      "pay": { "pay_down": 1, "pay_month": 1, "pay_play": 1, "pay_status": 0, "price_album": 0, "price_track": 200, "time_free": 0 },
      "protect": 11,
      "sa": 0,
      "search_title": "",
      "singer": [ { "id": 4558, "mid": "0025NhlN2yWrP4", "name": "周杰伦", "pmid": "", "title": "周杰伦", "type": 0, "uin": 0 } ],
      "status": 0,
      "subtitle": "",
      "tag": 11,
      "tid": 0,
      "time_public": "2003-07-31",
      "title": "晴天",
      "title_extra": "",
      "title_main": "",
      "type": 1,
      "url": "",
      "vec_hotness": [],
      "version": 0,
      "volume": { "gain": -7.603000164031982, "lra": 3.7119998931884766, "peak": 0.9459999799728394 },
      "vs": []
    }
  ]
}
```

响应外层字段：

| 字段 | 类型 | 含义 |
|---|---|---|
| `code` | number | 200 = 成功 |
| `type` | string | 本次搜索类型（回显） |
| `page` | number | 当前页码 |
| `limit` | number | 每页条数 |
| `total` | number | 匹配总数 |
| `more` | boolean | 是否还有下一页 |
| `items` | array | 上游 `item_song` 条目数组（原样透传） |

`items[]`（`item_song`）条目字段（全部）：

| 字段 | 类型 | 含义 |
|---|---|---|
| `act` | number | 活动标记位（实测 3） |
| `action` | object | 客户端交互开关位，见下表 |
| `album` | object | 专辑对象，见下表 |
| `author` | string | 词曲作者（实测空字符串） |
| `bpm` | number | 每分钟节拍数（实测 0 = 未标注） |
| `content` | string | 歌词全文 |
| `custom_data` | string | 自定义数据（实测空） |
| `data_type` | number | 数据类型（实测 0） |
| `desc` | string | 描述（实测空） |
| `docid` | string | 搜索系统文档 ID |
| `eq` | number | 均衡器标记（实测 2） |
| `es` | string | 未公开文档（实测空字符串） |
| `file` | object | 文件信息，见下表 |
| `fnote` | number | 备注标记位（实测 4009） |
| `genre` | number | 风格编号（**实测恒为 0**，不可用于风格判断，见 1.5） |
| `grp` | array | 分组（实测空数组） |
| `hotness_desc` | string | 热度描述（实测空） |
| `href3` | string | 播放地址（流媒体 URL） |
| `id` | number | 歌曲数字 ID |
| `index_album` | number | 专辑内曲目序号 |
| `index_cd` | number | CD 序号 |
| `interval` | number | 时长（秒） |
| `isonly` | number | 独家标记（0 = 非独家） |
| `ksong` | object | K 歌伴奏对象：`id`=伴奏 ID、`mid`=伴奏 mid |
| `label` | string | 标签（实测 "0"） |
| `language` | number | 语言代码（0 = 国语） |
| `lyric` | string | 歌词（实测空，全文在 `content`） |
| `mid` | string | 歌曲 mid |
| `mv` | object | MV 对象：`id`=MV ID、`name`/`title`=MV 名、`vid`=MV vid、`vt`=MV 类型 |
| `name` | string | 歌名 |
| `newStatus` | number | 新歌状态（实测 2） |
| `ov` | number | 未公开文档（实测 0） |
| `pay` | object | 付费信息，见下表 |
| `protect` | number | 版权保护等级（实测 11） |
| `sa` | number | 未公开文档（实测 0） |
| `search_title` | string | 搜索标题（实测空） |
| `singer` | array | 歌手列表，元素见下表 |
| `status` | number | 状态（0 = 正常） |
| `subtitle` | string | 副标题（实测空） |
| `tag` | number | 标签位掩码（实测 11） |
| `tid` | number | 未公开文档（实测 0） |
| `time_public` | string | 发行日期（"2003-07-31"） |
| `title` | string | 歌名（与 `name` 同值） |
| `title_extra` | string | 附加标题（实测空） |
| `title_main` | string | 主标题（实测空） |
| `type` | number | 条目类型（1 = 歌曲） |
| `url` | string | 播放 URL（实测空） |
| `vec_hotness` | array | 热度向量（实测空数组） |
| `version` | number | 版本（实测 0） |
| `volume` | object | 响度信息：`gain`=增益(dB)、`lra`=响度范围(LU)、`peak`=峰值 |
| `vs` | array | 多版本列表（实测空数组） |

`action`（客户端交互开关位）：

| 字段 | 类型 | 含义 |
|---|---|---|
| `alert` | number | 弹窗提示位 |
| `icon2` | number | 图标位 2 |
| `icons` | number | 图标位掩码 |
| `msgdown` | number | 下载消息位 |
| `msgfav` | number | 收藏消息位 |
| `msgid` | number | 消息 ID |
| `msgpay` | number | 付费消息位 |
| `msgshare` | number | 分享消息位 |
| `switch` | number | 功能开关位掩码 |
| `switch2` | number | 功能开关位掩码 2 |

`album`（专辑对象）：

| 字段 | 类型 | 含义 |
|---|---|---|
| `id` | number | 专辑 ID |
| `mid` | string | 专辑 mid |
| `name` | string | 专辑名 |
| `pmid` | string | 专辑图 mid（封面拼图床 URL 用，见 1.5 实测要点） |
| `subtitle` | string | 副标题（实测空） |
| `time_public` | string | 发行时间（实测空） |
| `title` | string | 专辑名（与 `name` 同值） |

`file`（文件信息）：

| 字段 | 类型 | 含义 |
|---|---|---|
| `b_30s` | number | 试听片段起点（毫秒） |
| `e_30s` | number | 试听片段终点（毫秒） |
| `hires_bitdepth` | number | Hi-Res 位深（0 = 无） |
| `hires_sample` | number | Hi-Res 采样率（0 = 无） |
| `media_mid` | string | 媒体文件 mid |
| `size_128mp3` / `size_192aac` / `size_192ogg` / `size_24aac` / `size_320mp3` / `size_48aac` / `size_96aac` / `size_96ogg` / `size_ape` / `size_dolby` / `size_dts` / `size_flac` / `size_hires` | number | 各音质文件大小（字节，0 = 无该音质） |
| `size_360ra` | array | 360RA 音质大小（实测空） |
| `size_new` | array | 新格式大小数组（16 位定长） |
| `size_try` | number | 试听片段大小（字节） |
| `try_begin` | number | 试听范围起点（毫秒） |
| `try_end` | number | 试听范围终点（毫秒） |
| `url` | string | 文件地址（实测空） |

`pay`（付费信息）：

| 字段 | 类型 | 含义 |
|---|---|---|
| `pay_down` | number | 下载需付费标记（1 = 是） |
| `pay_month` | number | 包月付费标记（1 = 是） |
| `pay_play` | number | 试听需付费标记（1 = 是） |
| `pay_status` | number | 付费状态（0） |
| `price_album` | number | 专辑价格 |
| `price_track` | number | 单曲价格（分） |
| `time_free` | number | 免费试听时长 |

`singer[]`（歌手元素）：

| 字段 | 类型 | 含义 |
|---|---|---|
| `id` | number | 歌手 ID |
| `mid` | string | 歌手 mid |
| `name` | string | 歌手名 |
| `pmid` | string | 歌手图 mid（实测空） |
| `title` | string | 歌手名（与 `name` 同值） |
| `type` | number | 类型（0） |
| `uin` | number | QQ 号（0 = 无） |

### 1.3 歌单（读）

#### `GET /user/playlist?uid=<userId>&favoriteOffset=<n>&playCount=<1>`（需登录）

| 入参 | 类型 | 含义 |
|---|---|---|
| `uid` | string | 用户 musicid（必填；SDK 内部实际以会话凭证对应的账号为准读取自建歌单） |
| `favoriteOffset` | number | 收藏歌单续读偏移（正整数，可选；收藏类超过 1000 条时分页续读用） |
| `playCount` | number | `1` = 额外拉取歌单播放数（可选，会多一次上游请求） |

✅ 未登录真实响应：`{ "code": 401, "message": "Login required" }`。

登录后响应（📐 结构来自 SDK 源码 `userPlaylistResponse.ts`；条目为上游 `v_playlist` **原样透传**，SDK 仅补充封面字段）：

```json
{
  "code": 200,
  "playlist": [ { "tid": 111, "dirId": 1, "dirName": "我的歌单", "songNum": 33, "picUrl": "http://x/y.jpg" } ],
  "total": 19,
  "more": false
}
```

| 出参 | 类型 | 含义 |
|---|---|---|
| `code` | number | 200 = 成功 |
| `playlist` | array | `v_playlist` 条目数组 |
| `total` | number | 歌单真实总数 |
| `more` | boolean | 列表是否还不能确认完整（`bFinish === false` 时为 true） |
| `nextFavoriteOffset` | number | 收藏歌单续读偏移（仅当确实可以接着读时出现） |
| `playCountComplete` | boolean | 播放数是否拉全（仅当传了 `playCount=1` 时出现） |

`playlist[]`（`v_playlist`）条目字段（上游 `GetPlaylistByUin` 原样透传，以下为 SDK 源码实际读取/补充的字段；上游可能还携带其他字段）：

| 字段 | 类型 | 含义 |
|---|---|---|
| `tid` | number | 歌单 ID |
| `dirId` | number | 目录号；`>= 200` 为「我喜欢」/收藏夹（适配器过滤掉） |
| `dirName` | string | 歌单名 |
| `dirType` | number | 目录类型（0 = 普通自建） |
| `uin` | number | 所属账号 uin |
| `songNum` / `songCnt` | number | 歌曲数 |
| `picUrl` / `bigpicUrl` / `picurl` / `coverUrl` | string | 封面 URL（SDK 会保证 `bigpicUrl`/`picUrl` 有值） |
| `logo` / `albumPicUrl` | string | 上游原始封面字段（自建歌单 `logo`、收藏歌单 `albumPicUrl`；SDK 补封面时读取） |

#### `GET /user/playlist-detail?tid=<tid>&offset=<n>&limit=<n>&playCount=<1>`（需登录）

| 入参 | 类型 | 含义 |
|---|---|---|
| `tid` | number | 歌单 ID（纯数字；与 `dirid` 二选一，都缺返回 400） |
| `dirid` | number | 目录号（与 `tid` 二选一） |
| `offset` | number | 歌曲偏移（默认 0） |
| `limit` | number | 每页条数（1-100，默认 100） |
| `playCount` | number | `1` = 返回歌单播放数（可选） |

响应（📐 结构来自 SDK 源码 `getOwnedPlaylistSongs.js`；上游为 `CgiGetDiss`（`music.srfDissInfo.DissInfo`），`songs` 条目**原样透传**、剥离 `sid`/`vkey` 等私有键）：

```json
{
  "code": 200,
  "songs": [ { "songid": "97773", "songname": "晴天", "singer": [ { "name": "周杰伦" } ], "albumname": "叶惠美", "interval": 269 } ],
  "total": 33,
  "more": false
}
```

| 出参 | 类型 | 含义 |
|---|---|---|
| `code` | number | 200 = 成功 |
| `songs` | array | `songlist` 歌曲条目数组 |
| `total` | number | 歌曲总数 |
| `more` | boolean | 是否还有下一页 |
| `play_cnt` | number | 歌单播放数（仅当传了 `playCount=1` 时出现） |

`songs[]` 条目字段（适配器实际读取的字段，`/search` 条目的「歌单版」命名，无 `genre`）：

| 字段 | 类型 | 含义 |
|---|---|---|
| `songid` / `id` / `songmid` | string/number | 歌曲 ID（数字 id / mid） |
| `songname` / `name` / `title` | string | 歌名 |
| `singer` / `singers` | array | 歌手列表，元素含 `name` |
| `albumname` / `album.name` | string | 专辑名 |
| `interval` | number | 时长（秒） |

### 1.4 歌单（写，均需登录、POST）

未登录/请求体非法时统一返回 `{ code: 401/400, kind, errorKey, message, retryable }`（见 1.1 错误格式）。

#### `POST /user/playlist/create`

请求体：

```json
{ "name": "周杰伦精选" }
```

| 入参 | 类型 | 约束 |
|---|---|---|
| `name` | string | 必填；trim 后非空、≤20 字符、不含控制字符（ASCII < 32 或 127） |

响应（📐 结构来自 SDK 源码 `playlistManagement.ts`，值为示意）：

```json
{ "code": 200, "tid": 83712345, "dirId": 201, "name": "周杰伦精选", "verified": true }
```

| 出参 | 类型 | 含义 |
|---|---|---|
| `code` | number | 200 = 成功 |
| `tid` | number | 新歌单 ID |
| `dirId` | number | 新歌单目录号（< 200） |
| `name` | string | 歌单名（回读确认） |
| `verified` | boolean | SDK 已回读校验（恒 true） |
| `moderation` | object | 内容审核信息，仅在命中审核时出现：`bSafetyHitName`/`bSafetyHitDesc`=名称/描述是否命中、`hit_type`/`hit_reason`=命中类型/原因 |

#### `POST /user/playlist/rename`

请求体：

```json
{ "tid": 83712345, "name": "新名字" }
```

| 入参 | 类型 | 约束 |
|---|---|---|
| `tid` | number | 歌单 ID（正整数，≤15 位） |
| `name` | string | 新歌单名（约束同 create 的 name） |

响应（📐）：

```json
{ "code": 200, "tid": 83712345, "name": "新名字", "verified": true }
```

| 出参 | 类型 | 含义 |
|---|---|---|
| `code` | number | 200 = 成功 |
| `tid` | number | 歌单 ID |
| `name` | string | 改名后的歌单名（回读确认） |
| `verified` | boolean | SDK 已回读校验（恒 true） |

#### `POST /user/playlist/delete`

请求体：

```json
{ "tid": 83712345 }
```

| 入参 | 类型 | 约束 |
|---|---|---|
| `tid` | number | 歌单 ID（正整数，≤15 位） |

响应（📐）：

```json
{ "code": 200, "tid": 83712345, "deleted": true, "verified": true }
```

| 出参 | 类型 | 含义 |
|---|---|---|
| `code` | number | 200 = 成功 |
| `tid` | number | 被删除的歌单 ID |
| `deleted` | boolean | 已删除（恒 true） |
| `verified` | boolean | SDK 已回读校验（恒 true） |

#### `POST /user/playlist/tracks`

请求体（每批 1-100 首）：

```json
{
  "tid": 83712345,
  "op": "add",
  "songs": [
    { "id": 97773, "type": 0 },
    { "id": 186016, "type": 0 }
  ]
}
```

| 入参 | 类型 | 约束 |
|---|---|---|
| `tid` | number | 歌单 ID（正整数；必须属于本人自建歌单且 dirId < 200、dirType=0） |
| `op` | string | `add`=添加、`del`=移除 |
| `songs` | array | 1-100 个元素 |
| `songs[].id` | number | 歌曲数字 ID（正整数） |
| `songs[].type` | number | 歌曲来源类型，仅接受 `0`（曲库歌曲；SDK 只实现了 type 0 编码器） |

响应（📐）：

```json
{ "code": 200, "changed": true }
```

| 出参 | 类型 | 含义 |
|---|---|---|
| `code` | number | 200 = 成功 |
| `changed` | boolean | 歌单内容是否发生变化（SDK 以回包 `dirId`/`tid` 与请求一致判定） |
| `verification` | object | 仅当 `changed=false` 时出现：`status`=逐首回读校验结果（`present`=歌单中已存在、`absent`=确认不在、`unknown`=无法确认） |

写操作失败时（📐 SDK 源码 `failedPlaylistWrite`），错误响应额外携带：`writeAttempted: true`（已尝试写入）、`verification: "unconfirmed"`（写入结果未确认）、`tid`/`dirId`（已确认的 ID）。

### 1.5 风格（genre）专用接口

#### `GET /song/genre?id=<纯数字 songid>`（需登录）

| 入参 | 类型 | 含义 |
|---|---|---|
| `id` | string | 歌曲数字 ID（必填；纯数字、正整数、安全整数范围内，非法回 400 `input`） |

✅ 未登录真实响应（2026-11-24 实测）：

```json
{
  "code": 401,
  "kind": "auth-missing",
  "errorKey": "auth.required",
  "message": "Login required",
  "retryable": false
}
```

登录后响应（📐 结构来自 SDK 源码 `song/genre.ts`；上游为 `music.recommend.TrackRelationServer.GetSongGenre`）：

```json
{ "code": 200, "genres": [ { "id": 1, "name": "流行" } ] }
```

| 出参 | 类型 | 含义 |
|---|---|---|
| `code` | number | 200 = 成功；无流派时也为 200 且 `genres` 为空数组 |
| `genres` | array | 流派列表 |
| `genres[].id` | number | 流派 ID（正整数） |
| `genres[].name` | string | 流派名称 |

> QQ音乐风格结论：搜索条目 `genre` 数字实测恒为 `0`（晴天/青花瓷/双截棍均如此），不可用于风格判断。
> 适配器当前直接映射 `item.genre`（结果恒为 undefined），**不再调用** `/song/genre` 接口——
> 早期文档描述的「按 songid 查流派」路径已废弃（`/song/genre` 需登录且未接入，见第 6 节结论）。

---

## 2. 网易云音乐（NeteaseCloudMusicApi）

### 2.1 登录

#### `login_qr_key`（`GET /api/login/qrcode/unikey`）

| 入参 | 类型 | 含义 |
|---|---|---|
| （无，固定上游参数） | — | NCM 模块固定向上游发送 `type: 3` |

响应（📐 结构来自 NCM 模块源码）：

```json
{ "status": 200, "body": { "data": { "code": 200, "unikey": "<unikey>" }, "code": 200 }, "cookie": [] }
```

| 出参 | 类型 | 含义 |
|---|---|---|
| `status` | number | NCM 外层状态（200） |
| `body.code` | number | NCM 包装状态（200） |
| `body.data.code` | number | 上游状态（200 = 成功） |
| `body.data.unikey` | string | 二维码 key，传给 `login_qr_create` / `login_qr_check` |
| `cookie` | array | 上游 `set-cookie` 列表 |

#### `login_qr_create`（本地生成，`music.163.com/login?codekey=`）

| 入参 | 类型 | 含义 |
|---|---|---|
| `key` | string | 上一步的 `unikey` |
| `qrimg` | boolean | `true` = 返回 base64 二维码图片（适配器传 true） |
| `platform` | string | 平台（`pc` 默认；`web` 会追加 chainId 参数） |

响应（📐 结构来自 NCM 模块源码）：

```json
{ "code": 200, "status": 200, "body": { "code": 200, "data": { "qrurl": "https://music.163.com/login?codekey=<key>", "qrimg": "data:image/png;base64,…" } } }
```

| 出参 | 类型 | 含义 |
|---|---|---|
| `code` / `status` | number | 200 |
| `body.code` | number | 200 |
| `body.data.qrurl` | string | 登录页 URL |
| `body.data.qrimg` | string | 二维码图片（base64 数据 URL；`qrimg` 未传 true 时为空字符串） |

#### `login_qr_check`（`/api/login/qrcode/client/login`）

| 入参 | 类型 | 含义 |
|---|---|---|
| `key` | string | 二维码 key |

响应（📐 结构来自 NCM 模块源码；`body` 为上游响应展开并附加 `cookie` 串）：

```json
{ "status": 200, "body": { "code": 803, "cookie": "MUSIC_U=…;", "message": "授权登陆成功", "avatarUrl": "…", "nickname": "…" }, "cookie": ["MUSIC_U=…"] }
```

| 出参 | 类型 | 含义 |
|---|---|---|
| `status` | number | NCM 外层状态 |
| `body.code` | number | `800`=二维码过期、`801`=等待扫码、`802`=已扫码待确认、`803`=登录成功 |
| `body.cookie` | string | 登录 Cookie 串（803 时；NCM 将上游 `set-cookie` 数组合并而来） |
| `body.message` / `avatarUrl` / `nickname` | string | 登录成功时的提示与账号信息（上游返回） |
| `cookie` | array | 上游 `set-cookie` 列表 |

#### `login_status`（`GET /api/w/nuser/account/get`）

| 入参 | 类型 | 含义 |
|---|---|---|
| `cookie` | string | 登录 Cookie 串 |

响应（📐 结构来自 NCM 模块源码，`body.data` 为上游响应展开）：

```json
{ "status": 200, "body": { "data": { "code": 200, "profile": { "userId": 451311619, "nickname": "示例用户" }, "account": { "id": 451311619 } } }, "cookie": [] }
```

| 出参 | 类型 | 含义 |
|---|---|---|
| `body.data.code` | number | 上游状态（200 = 已登录） |
| `body.data.profile` | object | 用户资料：`userId`=用户 ID、`nickname`=昵称 等 |
| `body.data.account` | object | 账号信息：`id`=账号 ID |
| `cookie` | array | 上游 `set-cookie` 列表 |

### 2.2 搜索与歌曲条目

#### `cloudsearch`（`GET /api/cloudsearch/pc`）

| 入参 | 类型 | 含义 |
|---|---|---|
| `keywords` | string | 搜索关键字（必填） |
| `type` | number | 搜索类型：`1`=单曲（默认）、`10`=专辑、`100`=歌手、`1000`=歌单、`1002`=用户、`1004`=MV、`1006`=歌词、`1009`=电台、`1014`=视频 |
| `limit` | number | 每页条数（默认 30） |
| `offset` | number | 偏移（默认 0） |
| `total` | boolean | 固定 `true`（NCM 模块内定） |
| `cookie` | string | 登录 Cookie 串（可选） |

✅ 真实响应（2026-11-24 实测，`s=晴天&type=1&limit=1`；完整响应，未裁剪）：

```json
{
  "result": {
    "songs": [
      {
        "no": 1,
        "rt": "",
        "copyright": 1,
        "fee": 8,
        "hr": { "br": 1394128, "fid": 0, "size": 47185529, "vd": 91241, "sr": 48000 },
        "privilege": {
          "flag": 260, "code": 0, "dlLevel": "none", "subp": 1, "fl": 320000, "fee": 8, "dl": 0,
          "plLevel": "exhigh", "maxBrLevel": "hires", "rightSource": 0, "maxbr": 999000, "id": 2668397359,
          "sp": 7, "payed": 0, "st": 0,
          "chargeInfoList": [ { "rate": 128000, "chargeType": 0 }, { "rate": 192000, "chargeType": 0 }, { "rate": 320000, "chargeType": 0 }, { "rate": 999000, "chargeType": 1 }, { "rate": 1999000, "chargeType": 1 } ],
          "freeTrialPrivilege": { "userConsumable": false, "resConsumable": false },
          "downloadMaxbr": 999000, "downloadMaxBrLevel": "hires", "cp": 1, "preSell": false,
          "playMaxBrLevel": "hires", "cs": false, "toast": false, "playMaxbr": 999000, "flLevel": "exhigh", "pl": 320000
        },
        "mst": 9,
        "pst": 0,
        "pop": 100,
        "dt": 270738,
        "rtype": 0,
        "s_id": 0,
        "rtUrls": [],
        "resourceState": true,
        "id": 2668397359,
        "sq": { "br": 646443, "fid": 0, "size": 21882106, "vd": 91241, "sr": 48000 },
        "st": 0,
        "cd": "01",
        "publishTime": 1738684800000,
        "cf": "",
        "originCoverType": 2,
        "h": { "br": 320000, "fid": 0, "size": 10831725, "vd": 91239, "sr": 48000 },
        "mv": 0,
        "al": { "picUrl": "http://p1.music.126.net/-NVLOT5vt9I91LRiZV1TCQ==/109951170413587092.jpg", "name": "晴天", "tns": [], "pic_str": "109951170413587092", "id": 260499608, "pic": 109951170413587090 },
        "originSongSimpleData": { "artists": [ { "name": "周杰伦", "id": 6452 } ], "name": "晴天", "songId": 186016, "albumMeta": { "name": "叶惠美", "id": 18905 } },
        "l": { "br": 128000, "fid": 0, "size": 4332717, "vd": 95615, "sr": 48000 },
        "m": { "br": 192000, "fid": 0, "size": 6499053, "vd": 93870, "sr": 48000 },
        "version": 5,
        "cp": 679014,
        "alia": [],
        "djId": 0,
        "single": 0,
        "ar": [ { "name": "RyaVocal", "tns": [], "alias": [], "id": 0 } ],
        "ftype": 0,
        "t": 0,
        "v": 39,
        "name": "晴天 (原唱 周杰伦)",
        "mark": 17716748288
      }
    ],
    "songCount": 334
  },
  "code": 200,
  "trp": { "rules": [ "search_tab_song::2668397359::searchAlg$isGlobalQuality$1" ] }
}
```

响应外层字段：

| 字段 | 类型 | 含义 |
|---|---|---|
| `code` | number | 200 = 成功 |
| `result.songs` | array | 歌曲条目数组 |
| `result.songCount` | number | 匹配总数 |
| `trp.rules` | array | 搜索策略规则列表（搜索算法标注） |

`songs[]` 条目字段（全部；与 2.3 歌单详情 `tracks[]` 基本一致）：

| 字段 | 类型 | 含义 |
|---|---|---|
| `no` | number | 排序序号 |
| `rt` | string | 电台类型（空 = 非电台曲目） |
| `copyright` | number | 版权状态码（1） |
| `fee` | number | 付费类型：`0`=免费、`1`=VIP 专享、`4`=数字专辑、`8`=付费/VIP 专享 |
| `hr` | object | Hi-Res 音质对象（见音质对象表） |
| `privilege` | object | 播放权限对象（见下表） |
| `mst` | number | 母带相关标记（9） |
| `pst` | number | 状态标记（0） |
| `pop` | number | 热度（0-100） |
| `dt` | number | 时长（毫秒） |
| `rtype` | number | 资源类型（0） |
| `s_id` | number | 歌曲 ID（旧字段，0） |
| `rtUrls` | array | 电台播放 URL 列表（空 = 无） |
| `resourceState` | boolean | 资源可用状态 |
| `id` | number | 歌曲 ID |
| `sq` | object | 无损音质对象（见音质对象表） |
| `st` | number | 状态（0） |
| `cd` | string | CD 序号（"01"） |
| `publishTime` | number | 发布时间（毫秒时间戳） |
| `cf` | string | 版权方（空） |
| `originCoverType` | number | 原始封面类型（2） |
| `h` | object | 高音质对象（320kbps，见音质对象表） |
| `mv` | number | 关联 MV ID（0 = 无） |
| `al` | object | 专辑对象（见下表） |
| `originSongSimpleData` | object | 原曲信息（翻唱场景指向原唱曲）：`songId`=原曲 ID、`name`=原曲名、`artists[{id,name}]`=原曲歌手、`albumMeta{id,name}`=原曲专辑；非翻唱为 null |
| `l` | object | 低音质对象（128kbps，见音质对象表） |
| `m` | object | 中音质对象（192kbps，见音质对象表） |
| `version` | number | 版本号（5） |
| `cp` | number | 版权方 ID |
| `alia` | array | 别名列表 |
| `djId` | number | 电台节目 ID（0 = 无） |
| `single` | number | 是否单曲（0） |
| `ar` | array | 歌手数组（见下表） |
| `ftype` | number | 文件类型（0） |
| `t` | number | 歌曲类型（0） |
| `v` | number | 版本号（39） |
| `name` | string | 歌曲名 |
| `mark` | number | 标记位掩码 |

音质对象（`hr` / `sq` / `h` / `m` / `l` 同构）：

| 字段 | 类型 | 含义 |
|---|---|---|
| `br` | number | 码率（bps） |
| `fid` | number | 文件 ID |
| `size` | number | 文件大小（字节） |
| `vd` | number | 音质版本标记 |
| `sr` | number | 采样率（Hz） |
| （注） | — | `vd`、`size` 随资源状态动态变化，同一条目两次抓取值可能不同 |

`privilege`（播放权限）：

| 字段 | 类型 | 含义 |
|---|---|---|
| `flag` | number | 权限位掩码 |
| `code` | number | 权限状态码（0） |
| `dlLevel` | string | 下载等级（`none`=不可下载） |
| `subp` | number | 是否替换曲目（1） |
| `fl` | number | 免费等级（320000 = 可免费听 320k） |
| `fee` | number | 付费类型（同条目 `fee`） |
| `dl` | number | 下载权限位 |
| `plLevel` | string | 播放等级（`exhigh`） |
| `maxBrLevel` | string | 最高码率等级（`hires`） |
| `rightSource` | number | 权益来源（0） |
| `maxbr` | number | 最高码率（999000） |
| `id` | number | 歌曲 ID |
| `sp` | number | 特殊权限（7） |
| `payed` | number | 已付费标记（0） |
| `st` | number | 状态（0） |
| `chargeInfoList` | array | 计费信息：`rate`=码率、`chargeType`=计费类型（0=免费、1=付费） |
| `freeTrialPrivilege` | object | 免费试用权限：`userConsumable`/`resConsumable`=用户/资源是否可消耗试用额度 |
| `downloadMaxbr` | number | 可下载最高码率 |
| `downloadMaxBrLevel` | string | 可下载最高码率等级 |
| `cp` | number | 版权方（1） |
| `preSell` | boolean | 是否预售 |
| `playMaxBrLevel` | string | 可播放最高码率等级 |
| `cs` | boolean | 是否云盘替换曲目 |
| `toast` | boolean | 是否弹提示 |
| `playMaxbr` | number | 可播放最高码率 |
| `flLevel` | string | 免费等级（`exhigh`） |
| `pl` | number | 播放等级码率（320000） |

`al`（专辑对象）：

| 字段 | 类型 | 含义 |
|---|---|---|
| `id` | number | 专辑 ID |
| `name` | string | 专辑名 |
| `picUrl` | string | 封面 URL |
| `pic` | number | 封面 ID |
| `pic_str` | string | 封面 ID 字符串 |
| `tns` | array | 专辑翻译名列表 |

`ar[]`（歌手元素）：

| 字段 | 类型 | 含义 |
|---|---|---|
| `id` | number | 歌手 ID（0 = 无主页） |
| `name` | string | 歌手名 |
| `tns` | array | 翻译名列表 |
| `alias` | array | 别名列表 |

### 2.3 歌单（读）

#### `user_playlist`（`GET /api/user/playlist`，需登录）

| 入参 | 类型 | 含义 |
|---|---|---|
| `uid` | string | 用户 ID（必填） |
| `limit` | number | 每页条数（默认 30） |
| `offset` | number | 偏移（默认 0） |
| `includeVideo` | boolean | 固定 `true`（NCM 模块内定，返回视频信息） |
| `cookie` | string | 登录 Cookie 串（必填，需与 `uid` 对应） |

响应（📐 结构来自 NCM 模块源码，`body` 为上游原始响应）：

```json
{ "status": 200, "body": { "code": 200, "playlist": [ { "id": 317785848, "name": "示例歌单", "trackCount": 33, "specialType": 0, "coverImgUrl": "…" } ], "more": false, "version": "…" }, "cookie": [] }
```

| 出参 | 类型 | 含义 |
|---|---|---|
| `body.code` | number | 上游状态（200） |
| `body.playlist` | array | 歌单条目数组 |
| `body.more` | boolean | 是否还有更多 |
| `body.version` | string | 版本标识 |

`body.playlist[]` 条目字段（与 2.4 歌单详情 `playlist` 对象字段同源，见 2.4 完整字段表；适配器只读取 `id`、`name`、`trackCount`/`track_count`、`specialType`、`coverImgUrl`）。

#### `playlist_detail`（`GET /api/v6/playlist/detail?id=<pid>&n=<n>&s=<n>`，公开）

| 入参 | 类型 | 含义 |
|---|---|---|
| `id` | string | 歌单 ID（必填） |
| `n` | number | 返回歌曲数（NCM 模块默认 100000；实测直接请求可传 1） |
| `s` | number | 返回最近收藏者数（NCM 模块默认 8） |
| `cookie` | string | 登录 Cookie 串（可选；未登录部分字段为 null） |

✅ 真实响应（2026-11-24 实测，`id=3778678&n=1`，未登录；`tracks` 实为 1 条、`trackIds` 实为 200 个同构元素，此处完整列出 1 个元素并注明总数；其余标量字段全部保留）：

```json
{
  "code": 200,
  "playlist": {
    "id": 3778678,
    "name": "热歌榜",
    "coverImgId": 109951170048519520,
    "coverImgUrl": "https://p1.music.126.net/0SUEG8yDACfx0Bw2MYFv4Q==/109951170048519512.jpg",
    "coverImgId_str": "109951170048519512",
    "adType": 0,
    "userId": 1,
    "createTime": 1378721406014,
    "status": 0,
    "opRecommend": false,
    "highQuality": false,
    "newImported": false,
    "updateTime": 1795482256660,
    "trackCount": 200,
    "specialType": 10,
    "privacy": 0,
    "trackUpdateTime": 1795503060609,
    "commentThreadId": "A_PL_0_3778678",
    "playCount": 14261827584,
    "trackNumberUpdateTime": 1795482256395,
    "subscribedCount": 13257248,
    "cloudTrackCount": 0,
    "ordered": true,
    "description": "云音乐热歌榜：云音乐用户一周内收听所有线上歌曲官方TOP排行榜，每日更新。",
    "tags": [],
    "updateFrequency": null,
    "backgroundCoverId": 0,
    "backgroundCoverUrl": null,
    "titleImage": 0,
    "titleImageUrl": null,
    "detailPageTitle": null,
    "englishTitle": null,
    "officialPlaylistType": null,
    "copied": false,
    "relateResType": null,
    "coverStatus": 3,
    "mix": false,
    "subscribers": [],
    "subscribed": null,
    "creator": {
      "defaultAvatar": false,
      "province": 110000,
      "authStatus": 1,
      "followed": false,
      "avatarUrl": "http://p1.music.126.net/kMuXXbwHbduHpLYDmHXrlA==/109951168152833223.jpg",
      "accountStatus": 0,
      "gender": 1,
      "city": 110101,
      "birthday": 0,
      "userId": 1,
      "userType": 2,
      "nickname": "网易云音乐",
      "signature": "网易云音乐是8亿人都在使用的音乐平台，致力于帮助音乐爱好者发现音乐惊喜，帮助音乐人实现梦想。 \n2019年8月31日起，将不再提供实时在线人工服务。您可以优先通过自助方式解决问题，如仍需求助，可在相关页面留下您的问题，后续会有人工为您解答，辛苦您耐心等待，给您带来的不便敬请谅解。 如果仍然不能解决您的问题，可以邮件我们： 用户：ncm5990@163.com 音乐人：yyr599@163.com",
      "description": "网易云音乐官方账号",
      "detailDescription": "网易云音乐官方账号",
      "avatarImgId": 109951168152833220,
      "backgroundImgId": 109951166515550960,
      "backgroundUrl": "http://p1.music.126.net/cwi82gitJJ0DfMO4cXbP8A==/109951166515550955.jpg",
      "authority": 3,
      "mutual": false,
      "expertTags": null,
      "experts": null,
      "djStatus": 10,
      "vipType": 11,
      "remarkName": null,
      "authenticationTypes": 4098,
      "avatarDetail": { "userType": 2, "identityLevel": 1, "identityIconUrl": "https://p5.music.126.net/obj/wo3DlcOGw6DClTvDisK1/4788940880/1a1f/68f5/b59a/b444b81b88567108ba88194fa29144f5.png" },
      "avatarImgIdStr": "109951168152833223",
      "backgroundImgIdStr": "109951166515550955",
      "anchor": true,
      "avatarImgId_str": "109951168152833223"
    },
    "tracks": [
      {
        "name": "海屿你",
        "mainTitle": null,
        "additionalTitle": null,
        "id": 1973665667,
        "pst": 0,
        "t": 0,
        "ar": [ { "id": 13288861, "name": "马也_Crabbit", "tns": [], "alias": [] } ],
        "alia": [ "求你别离开我" ],
        "pop": 100,
        "st": 0,
        "rt": "",
        "fee": 8,
        "v": 55,
        "crbt": null,
        "cf": "",
        "al": { "id": 150006421, "name": "海屿你", "picUrl": "http://p2.music.126.net/RfguLkQJ8aMVkiIaxdy70Q==/109951170483263672.jpg", "tns": [], "pic_str": "109951170483249998", "pic": 109951170483250000 },
        "dt": 295940,
        "h": { "br": 320000, "fid": 0, "size": 11839725, "vd": -52137, "sr": 48000 },
        "m": { "br": 192000, "fid": 0, "size": 7103853, "vd": -49585, "sr": 48000 },
        "l": { "br": 128000, "fid": 0, "size": 4735917, "vd": -47978, "sr": 48000 },
        "sq": { "br": 1016106, "fid": 0, "size": 37588339, "vd": -52120, "sr": 48000 },
        "hr": { "br": 1785265, "fid": 0, "size": 66041443, "vd": -52120, "sr": 48000 },
        "a": null,
        "cd": "01",
        "no": 1,
        "rtUrl": null,
        "ftype": 0,
        "rtUrls": [],
        "djId": 0,
        "copyright": 0,
        "s_id": 0,
        "mark": 17716748288,
        "originCoverType": 1,
        "originSongSimpleData": null,
        "tagPicList": null,
        "resourceState": true,
        "version": 21,
        "songJumpInfo": null,
        "entertainmentTags": null,
        "awardTags": null,
        "displayTags": null,
        "artistClassics": false,
        "markTags": [],
        "songFeature": null,
        "single": 0,
        "freePromotion": 0,
        "noCopyrightRcmd": null,
        "alg": null,
        "displayReason": null,
        "pubDJProgramData": null,
        "rtype": 0,
        "rurl": null,
        "mst": 9,
        "cp": 0,
        "mv": 0,
        "publishTime": 1660924800000
      }
    ],
    "videoIds": null,
    "videos": null,
    "trackIds": [
      { "id": 1973665667, "v": 21, "t": 0, "at": 1767573351833, "alg": null, "uid": 1, "rcmdReason": "", "rcmdReasonTitle": "", "sc": null, "f": null, "sr": null, "dpr": null, "tr": 0, "lr": 0 }
    ],
    "bannedTrackIds": null,
    "mvResourceInfos": null,
    "shareCount": 67783,
    "commentCount": 320344,
    "remixVideo": null,
    "newDetailPageRemixVideo": null,
    "sharedUsers": null,
    "historySharedUsers": null,
    "gradeStatus": "NONE",
    "score": null,
    "algTags": null,
    "distributeTags": [],
    "trialMode": 1,
    "displayTags": null,
    "displayUserInfoAsTagOnly": false,
    "playlistType": "UGC",
    "uiPlaylistType": "UGC",
    "bizExtInfo": {},
    "bizExtData": null,
    "promptedMgcInfo": null,
    "mixPodcastPlaylist": false,
    "podcastTrackCount": 0,
    "mixInfo": null,
    "ToplistType": "H"
  }
}
```

`playlist` 对象字段（全部）：

| 字段 | 类型 | 含义 |
|---|---|---|
| `id` | number | 歌单 ID |
| `name` | string | 歌单名 |
| `coverImgId` | number | 封面图 ID（数字） |
| `coverImgUrl` | string | 封面 URL |
| `coverImgId_str` | string | 封面图 ID（字符串） |
| `adType` | number | 广告类型（0 = 无） |
| `userId` | number | 创建者用户 ID |
| `createTime` | number | 创建时间（毫秒时间戳） |
| `status` | number | 状态（0 = 正常） |
| `opRecommend` | boolean | 运营推荐标记 |
| `highQuality` | boolean | 精品歌单标记 |
| `newImported` | boolean | 新导入标记 |
| `updateTime` | number | 更新时间（毫秒时间戳） |
| `trackCount` | number | 歌曲总数 |
| `specialType` | number | 特殊类型：`0`=普通、`5`=「我喜欢的音乐」、`10`=官方榜单（适配器过滤 `!== 0`） |
| `privacy` | number | 隐私：0 = 公开、10 = 私密 |
| `trackUpdateTime` | number | 歌曲更新时间（毫秒时间戳） |
| `commentThreadId` | string | 评论线程 ID |
| `playCount` | number | 播放次数 |
| `trackNumberUpdateTime` | number | 曲目数更新时间（毫秒时间戳） |
| `subscribedCount` | number | 订阅人数 |
| `cloudTrackCount` | number | 云盘歌曲数 |
| `ordered` | boolean | 是否已排序 |
| `description` | string | 歌单描述 |
| `tags` | array | 标签列表（字符串数组） |
| `updateFrequency` | string \| null | 更新频率（未设置 = null） |
| `backgroundCoverId` | number | 背景封面 ID（0 = 无） |
| `backgroundCoverUrl` | string \| null | 背景封面 URL |
| `titleImage` | number | 标题图 ID（0 = 无） |
| `titleImageUrl` | string \| null | 标题图 URL |
| `detailPageTitle` | string \| null | 详情页标题 |
| `englishTitle` | string \| null | 英文名 |
| `officialPlaylistType` | string \| null | 官方歌单类型 |
| `copied` | boolean | 是否复制歌单 |
| `relateResType` | string \| null | 关联资源类型 |
| `coverStatus` | number | 封面状态（3） |
| `mix` | boolean | 是否混音歌单 |
| `subscribers` | array | 最近订阅者列表（未登录为空；元素为 creator 同构的用户对象） |
| `subscribed` | boolean \| null | 当前用户是否已订阅（未登录 = null） |
| `creator` | object | 创建者用户对象（见下表） |
| `tracks` | array | 歌曲条目数组（见歌曲条目表） |
| `videoIds` | object \| null | 视频 ID 列表 |
| `videos` | object \| null | 视频列表 |
| `trackIds` | array | 歌曲 ID 数组（元素见下表） |
| `bannedTrackIds` | object \| null | 被屏蔽歌曲 ID |
| `mvResourceInfos` | object \| null | MV 资源信息 |
| `shareCount` | number | 分享次数 |
| `commentCount` | number | 评论数 |
| `remixVideo` | object \| null | 混音视频 |
| `newDetailPageRemixVideo` | object \| null | 新版详情页混音视频 |
| `sharedUsers` | object \| null | 分享用户 |
| `historySharedUsers` | object \| null | 历史分享用户 |
| `gradeStatus` | string | 评级状态（`NONE`） |
| `score` | number \| null | 评分 |
| `algTags` | object \| null | 算法标签 |
| `distributeTags` | array | 分发标签列表 |
| `trialMode` | number | 试听模式（1） |
| `displayTags` | object \| null | 展示标签 |
| `displayUserInfoAsTagOnly` | boolean | 用户信息是否仅作标签展示 |
| `playlistType` | string | 歌单类型（`UGC`=用户生成内容） |
| `uiPlaylistType` | string | UI 歌单类型（`UGC`） |
| `bizExtInfo` | object | 业务扩展信息（空对象） |
| `bizExtData` | object \| null | 业务扩展数据 |
| `promptedMgcInfo` | object \| null | MGC（AI 生成内容）提示信息 |
| `mixPodcastPlaylist` | boolean | 是否混音播客歌单 |
| `podcastTrackCount` | number | 播客音频数 |
| `mixInfo` | object \| null | 混音信息 |
| `ToplistType` | string \| null | 榜单类型（`H`=热歌榜） |

`creator` / `subscribers[]`（用户对象，字段全部）：

| 字段 | 类型 | 含义 |
|---|---|---|
| `defaultAvatar` | boolean | 是否默认头像 |
| `province` | number | 省份代码 |
| `authStatus` | number | 认证状态 |
| `followed` | boolean | 是否已关注 |
| `avatarUrl` | string | 头像 URL |
| `accountStatus` | number | 账号状态（0） |
| `gender` | number | 性别（1） |
| `city` | number | 城市代码 |
| `birthday` | number | 生日（毫秒时间戳，0 = 未设置） |
| `userId` | number | 用户 ID |
| `userType` | number | 用户类型（2 = 官方账号） |
| `nickname` | string | 昵称 |
| `signature` | string | 个性签名 |
| `description` | string | 描述 |
| `detailDescription` | string | 详细描述 |
| `avatarImgId` | number | 头像图 ID（数字） |
| `backgroundImgId` | number | 背景图 ID（数字） |
| `backgroundUrl` | string | 背景图 URL |
| `authority` | number | 权限等级 |
| `mutual` | boolean | 是否互相关注 |
| `expertTags` | object \| null | 专家标签 |
| `experts` | object \| null | 专家信息 |
| `djStatus` | number | 电台主播状态 |
| `vipType` | number | VIP 类型 |
| `remarkName` | string \| null | 备注名 |
| `authenticationTypes` | number | 认证类型位掩码 |
| `avatarDetail` | object | 头像详情：`userType`=用户类型、`identityLevel`=身份等级、`identityIconUrl`=身份图标 URL |
| `avatarImgIdStr` | string | 头像图 ID（字符串） |
| `backgroundImgIdStr` | string | 背景图 ID（字符串） |
| `anchor` | boolean | 是否主播 |
| `avatarImgId_str` | string | 头像图 ID（字符串，旧键） |

`trackIds[]`（元素字段全部）：

| 字段 | 类型 | 含义 |
|---|---|---|
| `id` | number | 歌曲 ID |
| `v` | number | 版本号 |
| `t` | number | 类型 |
| `at` | number | 添加时间（毫秒时间戳） |
| `alg` | string \| null | 算法来源 |
| `uid` | number | 添加用户 ID |
| `rcmdReason` | string | 推荐原因 |
| `rcmdReasonTitle` | string | 推荐原因标题 |
| `sc` | number \| null | 未公开文档（实测 null） |
| `f` | number \| null | 未公开文档（实测 null） |
| `sr` | number \| null | 未公开文档（实测 null） |
| `dpr` | number \| null | 未公开文档（实测 null） |
| `tr` | number | 未公开文档（实测 0） |
| `lr` | number | 未公开文档（实测 0） |

`tracks[]`（歌曲条目，字段全部；`al`/`ar`/音质对象结构见 2.2 对应表）：

| 字段 | 类型 | 含义 |
|---|---|---|
| `name` | string | 歌曲名 |
| `mainTitle` | string \| null | 主标题（拆分展示用，null = 无） |
| `additionalTitle` | string \| null | 副标题（拆分展示用，null = 无） |
| `id` | number | 歌曲 ID |
| `pst` | number | 状态标记（0） |
| `t` | number | 歌曲类型（0） |
| `ar` | array | 歌手数组（见 2.2 `ar[]` 表） |
| `alia` | array | 别名列表 |
| `pop` | number | 热度（0-100） |
| `st` | number | 状态（0） |
| `rt` | string | 电台类型（空 = 非电台曲目） |
| `fee` | number | 付费类型（同 2.2 `fee`） |
| `v` | number | 版本号 |
| `crbt` | string \| null | 彩铃信息（null = 无） |
| `cf` | string | 版权方（空） |
| `al` | object | 专辑对象（见 2.2 `al` 表） |
| `dt` | number | 时长（毫秒） |
| `h` / `m` / `l` / `sq` / `hr` | object | 高/中/低/无损/Hi-Res 音质对象（同 2.2 音质对象表） |
| `a` | object \| null | 未公开文档（实测 null） |
| `cd` | string | CD 序号 |
| `no` | number | 专辑内曲序 |
| `rtUrl` | string \| null | 电台播放 URL（null = 无） |
| `ftype` | number | 文件类型（0） |
| `rtUrls` | array | 电台播放 URL 列表 |
| `djId` | number | 电台节目 ID（0 = 无） |
| `copyright` | number | 版权状态码 |
| `s_id` | number | 歌曲 ID（旧字段，0） |
| `mark` | number | 标记位掩码 |
| `originCoverType` | number | 原始封面类型 |
| `originSongSimpleData` | object \| null | 原曲信息（翻唱场景，同 2.2 同名字段） |
| `tagPicList` | object \| null | 标签图列表 |
| `resourceState` | boolean | 资源可用状态 |
| `version` | number | 版本号 |
| `songJumpInfo` | object \| null | 歌曲跳转信息 |
| `entertainmentTags` | object \| null | 娱乐标签 |
| `awardTags` | object \| null | 获奖标签 |
| `displayTags` | object \| null | 展示标签 |
| `artistClassics` | boolean | 歌手经典标记 |
| `markTags` | array | 标记标签列表 |
| `songFeature` | object \| null | 歌曲特征 |
| `single` | number | 是否单曲（0） |
| `freePromotion` | number | 免费推广标记（0） |
| `noCopyrightRcmd` | string \| null | 无版权推荐 |
| `alg` | string \| null | 算法来源 |
| `displayReason` | string \| null | 展示原因 |
| `pubDJProgramData` | object \| null | 电台节目数据 |
| `rtype` | number | 资源类型（0） |
| `rurl` | string \| null | 重定向 URL |
| `mst` | number | 母带相关标记（9） |
| `cp` | number | 版权方 ID（0） |
| `mv` | number | 关联 MV ID（0 = 无） |
| `publishTime` | number | 发布时间（毫秒时间戳） |

> 实测确认：网易云搜索与歌单详情条目均**无 `genre` 字段**，`PlatformSong.genre` 恒为 undefined。

### 2.4 歌单（写）

| 模块函数 | 上游路径 | 请求参数（📐 适配器实际传参 + NCM 模块内定值） | 返回参数（📐） |
|---|---|---|---|
| `playlist_create` | `POST /api/playlist/create` | `name`（必填）、`privacy`（'0'=公开/'10'=私密，适配器传 '0'）、`type`（'NORMAL'/'VIDEO'/'SHARED'，模块默认 'NORMAL'）、`cookie` | `{ code: 200, playlist: { id, name, ... }, id }` |
| `playlist_tracks` | `POST /api/playlist/manipulate/tracks` | `op`（'add'/'del'，必填）、`pid`（歌单 ID，必填）、`tracks`（歌曲 ID 逗号分隔字符串，必填）、`imme`（固定 'true'）、`cookie` | `{ code: 200, trackIds, count }`；code 非 200 视为失败（512 时 NCM 模块自动重试一次） |
| `playlist_name_update` | `POST /api/playlist/update/name` | `id`（歌单 ID，必填）、`name`（新名字，必填）、`cookie` | `{ code }` |
| `playlist_delete` | `POST /api/playlist/remove` | `id`（歌单 ID，必填；NCM 模块转为 `ids: '[<id>]'` 发送）、`cookie` | `{ code }` |

说明：以上写接口的 `body` 均为上游原始响应（`code` 为网易云业务码，200 = 成功）；`playlist_create` 成功时 `body.playlist.id` 为新歌单 ID。

---

## 3. 酷狗音乐（📐 来源：kugoumusicapi 库模式，适配器实际调用与读取字段）

> 接入方式：`kugoumusicapi`（github `MakcRe/KuGouMusicApi`）**库模式**——createRequire 直调扁平函数，
> 不启动 HTTP 服务。统一返回结构 `{ status, body, cookie, headers }`，reject 时 `body` 携带 `error_code`/`error_msg`。
> 凭证为 cookie 串（token 与设备指纹绑定），设备指纹（guid/mid/dev/dfid）持久化到 `userData/kugou-device.json`。

### 3.1 登录（扫码）

| 函数 | 上游接口 | 入参 | 出参（适配器读取） |
|---|---|---|---|
| `register_dev` | 设备注册 | `cookie`（空） | `data.dfid` —— 扫码前必须注册真实 dfid，未注册的 token 会被设备绑定风控拦截 |
| `login_qr_key` | 二维码 key | `cookie`（空） | `data.qrcode` / `data.key` |
| `login_qr_create` | 二维码图片 | `key`、`qrimg: true` | `data.base64` / `data.qrimg`（base64 dataURL，官方库本地生成） |
| `login_qr_check` | 轮询 | `key`、`cookie`（空） | 状态码 **0=过期 / 1=等待 / 2=已扫待确认 / 4=成功**（适配器映射为基类统一状态机）；成功时 `data.token`/`data.userid` 组装 cookie 凭证 |

### 3.2 登录态与保活

| 函数 | 上游接口 | 说明 |
|---|---|---|
| `user_info` | get_my_userinfo（主路径，社区实测可用） | 明文平铺 `data.userid`/`nickname`（兼容 `data.info` 嵌套） |
| `user_detail` | get_my_info（回退路径） | 部分协议版本为 `data.info` 嵌套，取 `info.userid` |
| `login_token` | login_by_token（保活） | 返回 `data.token` 时续期成功；失败回退登录态校验 |

会话失效错误码：`error_code` **20017/20018**（设备绑定问题）、**20028**（触发安全验证）。

### 3.3 歌单（读）

| 函数 | 上游接口 | 说明 |
|---|---|---|
| `user_playlist` | v7/get_all_list | 分页（page/pagesize=100，上限 50 页）。响应 `data.info`（自建）+ `data.other_special`（部分协议版本单独返回的收藏他人歌单）。条目字段：`listid`、`type`（**0=自建/系统收藏夹，1=收藏他人歌单**；`is_mine` 恒为 0 不可用）、`name`、`count`/`source_count`、`pic`/`imgurl`/`cover`（含 `{size}` 占位符需替换）、`encode_gcid`/`gcid`（分享页标识）、`list_create_gid`/`global_collection_id`（收藏歌单公开 id）、`list_create_userid`、`total_ver`（条目无该字段时写操作按官方实践传 0）、`from_listid`/`list_create_listid`（旧版分享 specialid）。**歌单列表仅显示 type≠1** |
| `playlist_track_all_new` | 云歌单歌曲接口（App 现行端点，覆盖自建与收藏） | 入参 `listid`/`type`/分页（pagesize=300，上限 50 页），响应 `data.info`。条目字段：`hash`/`file_hash`/`song_hash`、`name`/`filename`（「歌手 - 标题.mp3」格式，无独立歌名/歌手）、`singerinfo`/`singer_info`（歌手数组）、`title`/`songname`、`album_id`、`mixsongid`、`fileid`/`file_id`（删歌用）、`timelen`（毫秒；个别为微秒脏值，>24h 需换算/置空）、`albuminfo.name`（实测唯一携带专辑名的位置）、`trans_param.union_cover`/`cover`/`img`/`pic`（封面，缺省按 hash 拼 `https://imge.kugou.com/stdmusic/240/{hash}.jpg`） |
| `playlist_track_all` | 公开歌单歌曲接口 | 入参 `id`（= global_collection_id）、分页，响应 **`data.songs`**（无 info 字段）；`songs` 混有 `{fileid, shield}` 屏蔽位条目，按缺 `hash` 过滤；`data.count` 为总数 |

歌曲拉取双路径：收藏歌单（type=1）先走公开接口（listid 拉不到），自建歌单先走云歌单接口；任一路径返回空自动回退另一路径。

### 3.4 搜索

| 函数 | 上游接口 | 说明 |
|---|---|---|
| `search` | 歌曲搜索（v2/search/song） | 入参 `keyword`/`page`/`pagesize`（适配器分页 page 从 1 起）；响应 `data.lists` **为歌曲对象数组（flat）**——📐 依据 kugoumusicapi `module/search.js`（v2/search/song 端点，x-router complexsearch.kugou.com）+ 公开实测响应（直接遍历 lists 元素取 `SongName`/`FileHash`）；兼容嵌套数组协议版本（lists[0] 为数组时取其内容）。条目字段：`FileHash`/`filehash`/`hash`（标题可能带 `<em>` 高亮标签需剥离）、`SongName`/`songname`/`name`、`SingerName`（歌手）、`AlbumID`、`MixSongID`。搜索错误分类：`error_code=1002` 为高频风控限流（rate-limited），HTTP 5xx/网络错误可重试 |

### 3.5 歌单（写，均需登录）

| 函数 | 上游接口 | 入参 | 说明 |
|---|---|---|---|
| `playlist_add` | 创建歌单 | `name`（trim 后）、`type: 0` | 返回新歌单 listid |
| `playlist_tracks_add` | 添加歌曲 | `listid`、`data` | `data` 为 `名称\|hash\|album_id\|mixsongid` 格式，多条逗号拼接，每批 ≤100；名称中的 `\|`/`,` 替换为空格；元数据在搜索/拉歌单时已缓存 |
| `playlist_tracks_del` | 移除歌曲 | `listid`、`fileids` | **按云歌单条目 fileid 而非 hash**，逗号拼接；缓存缺失时先拉歌单歌曲填充 |
| `playlist_update` | 重命名 | `listid`、`name`、`type`、`total_ver` | 必须携带歌单 type 与版本号 total_ver |
| `playlist_del` | 删除歌单 | `listid` | — |

---

## 4. Apple Music（📐 来源：社区路径 Web API，适配器实际调用与读取字段）

> 接入方式：社区路径。developer token 从 `music.apple.com` 网页前端 bundle 提取（JWT `payload.iss === 'AMPWebPlay'`），
> 用户凭证为登录窗口 cookie `media-user-token`。**读接口走官方主机 `api.music.apple.com`，
> 写接口必须走 `amp-api.music.apple.com`**（删除在官方主机固定 401）。仅 `/v1/me/` 路径带 `music-user-token` 请求头。

### 4.1 登录

- **无扫码接口**：`createQrLogin`/`checkQrLogin` 直接抛错，UI 隐藏扫码渠道，走应用内网页登录窗口。
- 凭证 = `{ mediaUserToken, developerToken, devTokenAt }` 序列化串；developer token 过期自动重抓（401 时强制重抓重试一次）。

### 4.2 登录态与保活

| 接口 | 说明 |
|---|---|
| `GET /v1/me/storefront` | 登录态校验；`data[0].id` 为 storefront（如 `cn`），缓存供搜索拼接目录路径。403 判定登录失效；429 抛 rate-limited |
| 保活 | 校验 developer token 时效 → 必要时重抓 → 调 storefront 校验；token 更新时返回新凭证由主进程持久化 |

### 4.3 歌单与歌曲（读，均 `/v1/me/` 需用户 token）

| 接口 | 说明 |
|---|---|
| `GET /v1/me/library/playlists?limit=100&offset=0` | 分页经响应 `next` 游标（防御上限 50 页）。条目：`id`（`pl.u-` 前缀=自建，`pl.` 前缀=官方）、`attributes.name`、`attributes.artwork`（封面）、`attributes.trackCount`（**官方列表接口不提供资料库歌单歌曲数**，缺省让 UI 留空） |
| `GET /v1/me/library/playlists/{id}/tracks?limit=100` | 分页经 `next`（防御上限 100 页）。歌曲条目：`attributes.playParams.catalogId`（优先作 id，可跨端写入，无则退条目 `id`）、`attributes.name`、`attributes.artistName`、`attributes.albumName`、`attributes.artwork`、`attributes.durationInMillis`、`attributes.genreNames[]`（取第一个） |

### 4.4 搜索

| 接口 | 说明 |
|---|---|
| `GET /v1/catalog/{storefront}/search?term=<kw>&types=songs&limit=<n>` | **limit 上限 25**（超限 400 Invalid Parameter Value，适配器自动封顶）；搜索词把 ` - ` 替换为空格（整串带连字符易命中 Live 版）。响应 `results.songs.data` 条目与 4.3 歌曲条目同构。错误分类：5xx/无状态码可重试，429 rate-limited，403 认证失效 |

### 4.5 歌单（写，走 `amp-api.music.apple.com`）

| 接口 | 请求体 | 说明 |
|---|---|---|
| `POST /v1/me/library/playlists` | `{ attributes: { name, isPublic: false } }` | 创建；响应 `data[0].id`（形如 `p.xxx`） |
| `POST /v1/me/library/playlists/{id}/tracks` | `{ data: [{ id, type: 'songs' }] }` | 追加曲目，**每批 ≤100** 分批写入；新建歌单 iCloud 传播延迟，404 时等 1.5s 重试一次 |
| `PATCH /v1/me/library/playlists/{id}` | `{ attributes: { name } }` | 重命名（社区实测返回 204） |
| `DELETE /v1/me/library/playlists/{id}` | — | 删除（实测官方主机固定 401，必须走 amp-api） |
| 移除歌曲 | — | **官方 API 无此端点**，`unsupportedOperations.removeSongs`，UI 隐藏该操作 |

---

## 5. 项目字段映射（上游 → 领域模型）

| 上游平台 | 上游字段 | 领域模型字段 |
|---|---|---|
| QQ音乐 / 网易云 / 酷狗 / Apple Music | `id` / `songid` / `mid` / `FileHash`(hash) / `catalogId` | `PlatformSong.id` |
| QQ音乐 / 网易云 / 酷狗 / Apple Music | `name` / `title` / `songname` / `SongName` / `attributes.name` | `PlatformSong.title` |
| QQ音乐 / 网易云 / 酷狗 / Apple Music | `singer[].name` / `ar[].name` / `SingerName` / `attributes.artistName` | `PlatformSong.artist` |
| QQ音乐 / 网易云 / 酷狗 / Apple Music | `album.name` / `al.name` / `albuminfo.name` / `attributes.albumName` | `PlatformSong.album` |
| QQ音乐 | `album.picUrl`（搜索条目无此字段，用 `album.pmid` 拼图床 URL：`https://y.gtimg.cn/music/photo_new/T002R500x500M000{pmid}.jpg`） | `PlatformSong.coverUrl` |
| 网易云 | `al.picUrl` | `PlatformSong.coverUrl` |
| 酷狗 | `pic`/`cover`/`trans_param.union_cover`（`{size}` 占位符替换为具体尺寸；缺省按 hash 拼 imge.kugou.com 图床） | `PlatformSong.coverUrl` |
| Apple Music | `attributes.artwork`（拼图 URL） | `PlatformSong.coverUrl` |
| QQ音乐 / 网易云 | `interval`(秒) / `dt`(毫秒) | `PlatformSong.durationMs` |
| 酷狗 | `timelen`（毫秒；微秒脏值需换算，>24h 置空） / `duration`(秒) | `PlatformSong.durationMs` |
| Apple Music | `attributes.durationInMillis` | `PlatformSong.durationMs` |
| QQ音乐 | `genre`（搜索条目恒为 0 → 实际恒 undefined；**不再调用** `/song/genre`） | `PlatformSong.genre` |
| Apple Music | `attributes.genreNames[0]` | `PlatformSong.genre` |
| （网易云 / 酷狗） | （上游不提供 genre 字段） | `PlatformSong.genre`（恒 undefined） |

## 6. 实测结论与待确认

实测结论：

1. QQ音乐 `/search` 的 `item_song` 条目**携带 `genre` 字段但恒为 `0`**（晴天/青花瓷/双截棍均实测为 0），不可用于风格判断；适配器直接映射 `item.genre`（结果恒 undefined），`/song/genre` 接口未接入。
2. QQ音乐搜索条目 `album` 对象**无 `picUrl`**，仅有 `pmid`，封面必须拼图床 URL。
3. 网易云搜索与歌单详情条目均**无 `genre` 字段**（适配器虽解析 `item.genre`，上游不返回故恒为 undefined）；酷狗同样无 genre 字段；四平台中仅 Apple Music 提供 `genreNames`。
4. 需登录接口未登录时，QQ音乐 SDK 返回 `{ code: 401, kind, errorKey, message, retryable }` 格式（`/user/*` 部分路由只返回 `{ code: 401, message }`）。
5. 酷狗（库模式）：歌单条目 `type` 实测 0=自建/系统收藏夹、1=收藏他人歌单，`is_mine` 恒为 0；搜索条目标题带 `<em>` 高亮标签需剥离；云歌单条目 `timelen` 存在微秒级脏值；写接口字段要求（fileid 删歌、`名称|hash|album_id|mixsongid` 加歌、rename 带 total_ver）均来自官方库实践。
6. Apple Music：读接口官方主机可用；写接口（含删除）必须走 `amp-api.music.apple.com`（删除在官方主机固定 401）；官方 API 无「移除歌曲」端点；资料库歌单列表无歌曲数；catalog search limit 上限 25。

待确认（需登录态抓包）：

1. QQ音乐 `/user/playlist`、`/user/playlist-detail` 登录后的完整条目字段（上游原样透传，本文档仅列 SDK 读取的字段）。
2. 各写入接口（QQ音乐 create/rename/delete/tracks、网易云 create/tracks/update/remove、酷狗 add/del/update/create、Apple Music create/tracks/patch/delete）的真实响应值。
3. 酷狗库模式各接口的完整响应体（本文档仅列适配器实际读取的字段，上游可能携带更多字段）。
4. 网易云 `trackIds[]` 元素中 `sc`/`f`/`sr`/`dpr`/`tr`/`lr` 字段的含义（未公开文档）。
