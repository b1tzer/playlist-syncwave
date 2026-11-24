# 上游平台接口返回参数（字段清单）

> 本文档记录 SyncWave 所接入的**上游平台接口**（QQ音乐本地服务、网易云 API 网关）的返回参数/字段，
> 供字段提取、模型映射与风格（genre）类需求参考。
>
> 数据来源：`src/platforms/*/index.ts` 适配器代码 + node_modules 中 SDK 源码
> （`@yakult-green-tea/qq-music-api`、`NeteaseCloudMusicApi`）。
> 上游协议字段可能随平台变化，标注「待实测」的字段使用前请先抓包确认。

---

## 1. QQ音乐（@yakult-green-tea/qq-music-api · Node 模式本地服务）

- 统一响应外层：`okResult` 为 `{ code: 200, ...业务字段 }`；失败为 `{ code, errorKey, message, ... }`。
- SDK 对上游条目（歌曲/歌单）**原样透传**，不做字段裁剪。
- 凭证：`x-qq-session` 请求头携带登录 token；`/login/qr/check` 的 token 经 `set-cookie` 返回。

### 1.1 登录

| 接口 | 返回参数 |
|---|---|
| `GET /login/qr/key?channel=` | `{ code, data: { unikey } }` |
| `GET /login/qr/create?key=` | `{ code, data: { qrimg } }`（base64 二维码） |
| `GET /login/qr/check?key=` | `{ code: 800\|802\|803, ... }`；code=803 成功，响应头 `set-cookie` 含 `qqmusic_session=<token>` |
| `GET /login/status` | `{ code, data: { profile } }`；profile 字段：`musicid` / `str_musicid` / `encryptUin`、`nickname` 等 |

### 1.2 歌单

| 接口 | 返回参数 |
|---|---|
| `GET /user/playlist?uid=` | `{ code, playlist: v_playlist[], total, more, nextFavoriteOffset? }`。条目（上游 `v_playlist` 原样）字段：`tid` / `id`、`dirId`、`dirName`、`songNum` / `songCnt`、`picUrl` 等 |
| `GET /user/playlist-detail?tid=&limit=` | `{ code, songs: songlist[], total, more, play_cnt? }`。歌曲条目见 1.4 |

### 1.3 歌单写入（POST，均需登录）

| 接口 | 请求体 | 返回参数 |
|---|---|---|
| `/user/playlist/create` | `{ name }` | `{ code, tid, dirId, name, verified: true, moderation? }` |
| `/user/playlist/rename` | `{ tid, name }` | `{ code, tid, name, verified: true }` |
| `/user/playlist/delete` | `{ tid }` | `{ code, tid, deleted: true, verified: true }` |
| `/user/playlist/tracks` | `{ tid, op: 'add'\|'del', songs: [{ id, type }] }` | `{ code, changed, verification? }` |

### 1.4 搜索与歌曲条目

| 接口 | 返回参数 |
|---|---|
| `GET /search?keyword=&type=song&limit=` | `{ code, type, page, limit, total, more, items }`。`items` 为上游 `item_song` 条目数组（原样透传） |

歌曲条目（`item_song`）已知/使用字段：

| 字段 | 类型 | 说明 | 项目使用 |
|---|---|---|---|
| `id` / `mid` / `songmid` | string/number | 歌曲 ID（数字 id / mid） | `PlatformSong.id` |
| `name` / `title` / `songname` | string | 歌名 | `PlatformSong.title` |
| `singer` | array | 歌手列表，元素含 `name` | `PlatformSong.artist` |
| `album` | object | 专辑对象：`name`、`picUrl` / `albumPic`、`pmid` | `album` / `coverUrl` |
| `interval` | number | 时长（秒） | `durationMs` |
| `genre` | number/string | 风格编号（SDK 注释证实「详情里有 genre 数字」；搜索条目是否携带 **待实测**） | `PlatformSong.genre` |
| `pay` / `vip` / `icon` / `action` 等 | — | 付费/版权标记，暂未使用 | — |

### 1.5 风格（genre）专用接口

| 接口 | 返回参数 |
|---|---|
| `GET /song/genre?id=<纯数字 songid>` | `{ code, genres: [{ id, name }] }`；无流派返回空数组。需登录。上游为 `music.recommend.TrackRelationServer.GetSongGenre` |

> 结论：QQ音乐获取风格有两条路——搜索/详情条目里的 `genre` 数字（需查表或实测确认是否携带）、
> 以及 `/song/genre` 按 songid 返回流派名称列表。

---

## 2. 网易云音乐（NeteaseCloudMusicApi）

- 统一响应外层：`{ status, body, cookie }`；`body` 为网易 Web API 原始响应（`{ code: 200, ... }`）。
- 登录凭证：`cookie` 参数随请求透传。

### 2.1 登录

| 模块函数 | 上游路径 | 返回参数 |
|---|---|---|
| `login_qr_key` | `GET /api/login/qrcode/unikey` | `{ code, data: { unikey } }` |
| `login_qr_create` | 本地生成（`music.163.com/login?codekey=`） | `{ code, data: { qrurl, qrimg } }` |
| `login_qr_check` | `/api/login/qrcode/client/login` | `{ code: 800\|802\|803, cookie }`；803 时 `body.cookie` 为登录 Cookie 串 |
| `login_status` | `GET /api/w/nuser/account/get` | `{ code, data: { profile: { userId, nickname }, account: { id } } }` |

### 2.2 歌单

| 模块函数 | 上游路径 | 返回参数 |
|---|---|---|
| `user_playlist` | `GET /api/user/playlist` | `{ code, playlist: [...], more, version }`。条目字段：`id`、`name`、`trackCount` / `track_count`、`specialType`（5=「我喜欢的音乐」）、`coverImgUrl` 等 |
| `playlist_detail` | `GET /api/v6/playlist/detail` | `{ code, playlist: { tracks: [...] } }`。歌曲条目见 2.4 |

### 2.3 歌单写入

| 模块函数 | 上游路径 | 返回参数 |
|---|---|---|
| `playlist_create` | `POST /api/playlist/create` | `{ code, playlist: { id }, id }` |
| `playlist_tracks` | `POST /api/playlist/manipulate/tracks` | `{ code }`；code 非 200 视为失败（512 时 SDK 自动重试） |
| `playlist_name_update` | `POST /api/playlist/update/name` | `{ code }` |
| `playlist_delete` | `POST /api/playlist/remove` | `{ code }` |

### 2.4 搜索与歌曲条目

| 模块函数 | 上游路径 | 返回参数 |
|---|---|---|
| `cloudsearch` | `GET /api/cloudsearch/pc` | `{ code, result: { songs: [...], songCount } }` |

歌曲条目字段（简化版 `SongDetail`）：

| 字段 | 类型 | 说明 | 项目使用 |
|---|---|---|---|
| `id` | number | 歌曲 ID | `PlatformSong.id` |
| `name` / `title` | string | 歌名 | `PlatformSong.title` |
| `ar` / `artists` | array | 歌手列表，元素含 `name` | `PlatformSong.artist` |
| `al` / `album` | object | 专辑对象：`name`、`picUrl` | `album` / `coverUrl` |
| `dt` | number | 时长（毫秒） | `durationMs` |
| `alia` / `tns` | array | 别名/翻译名，暂未使用 | — |
| `mv` | number | 关联 MV ID，暂未使用 | — |
| `privilege` / `fee` / `copyright` 等 | — | 版权/付费标记，暂未使用 | — |
| **`genre`** | — | **上游不返回该字段** | `PlatformSong.genre`（恒为 undefined） |

> 结论：网易云搜索与详情接口均无歌曲风格字段；如需风格只能另行探索（歌单标签等，当前不接入）。

---

## 3. 项目字段映射（上游 → 领域模型）

| 上游平台 | 上游字段 | 领域模型字段 |
|---|---|---|
| QQ音乐 / 网易云 | `id` / `songid` / `mid` | `PlatformSong.id` |
| QQ音乐 / 网易云 | `name` / `title` / `songname` | `PlatformSong.title` |
| QQ音乐 / 网易云 | `singer[].name` / `ar[].name` | `PlatformSong.artist` |
| QQ音乐 / 网易云 | `album.name` / `al.name` | `PlatformSong.album` |
| QQ音乐 / 网易云 | `album.picUrl` 等 | `PlatformSong.coverUrl` |
| QQ音乐 / 网易云 | `interval`(秒) / `dt`(毫秒) | `PlatformSong.durationMs` |
| QQ音乐 | `genre` | `PlatformSong.genre`（网易云无此字段） |

## 4. 待实测确认项

1. QQ音乐 `/search` 的 `item_song` 条目是否实际携带 `genre` 字段（SDK 注释证实歌曲详情有 genre 数字，搜索条目未证实）。
2. 若不携带，改用 `GET /song/genre?id=`（需登录、纯数字 songid）为第一首歌查询流派名称。
3. QQ音乐歌单条目（`v_playlist`）的确切字段名随上游版本可能变化，适配器已用多字段兜底读取。
