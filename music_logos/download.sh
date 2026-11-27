#!/bin/bash
# 下载常见音乐平台图标
set -u
cd "$(dirname "$0")"

declare -a urls=(
  "spotify.jpg|https://is1-ssl.mzstatic.com/image/thumb/Purple221/v4/ce/b5/1c/ceb51c33-0a63-56fb-db99-5d345728ae9e/AppIcon-0-0-1x_U007epad-0-1-0-0-85-220.png/512x512bb.jpg"
  "apple_music.jpg|https://is1-ssl.mzstatic.com/image/thumb/Purple211/v4/d5/45/38/d5453893-7719-0067-ed45-1de44d0d8eb9/musicValkyrie-0-0-1x_U007epad-0-1-0-85-220.png/512x512bb.jpg"
  "youtube_music.jpg|https://is1-ssl.mzstatic.com/image/thumb/Purple211/v4/bb/ae/84/bbae8447-05ac-1058-54d4-306f9073d8ec/logo_youtube_music_2024_q4_color-0-0-1x_U007emarketing-0-0-0-7-0-0-0-85-220.png/512x512bb.jpg"
  "tidal.jpg|https://is1-ssl.mzstatic.com/image/thumb/Purple221/v4/64/cb/50/64cb5033-713f-d48c-fb2f-e7971b1d2ced/AppIcon-0-0-1x_U007epad-0-1-0-85-220.png/512x512bb.jpg"
  "deezer.jpg|https://is1-ssl.mzstatic.com/image/thumb/Purple211/v4/b2/07/78/b20778ef-8050-1f23-0ba9-9da049b13b56/AppIcon-0-0-1x_U007epad-0-11-0-0-85-220.png/512x512bb.jpg"
  "soundcloud.jpg|https://is1-ssl.mzstatic.com/image/thumb/Purple211/v4/6e/5e/1a/6e5e1a1d-ee08-4ff0-dd0f-1d9f1de34aff/AppIcon-0-0-1x_U007epad-0-1-0-85-220.png/512x512bb.jpg"
  "amazon_music.jpg|https://is1-ssl.mzstatic.com/image/thumb/Purple211/v4/35/72/a4/3572a400-de5c-0954-333d-431454be03ea/AppIcon-0-0-1x_U007epad-0-1-0-85-220.png/512x512bb.jpg"
  "pandora.jpg|https://is1-ssl.mzstatic.com/image/thumb/Purple221/v4/69/1d/a4/691da433-8725-cab3-7f17-e240ff8d5247/AppIcon-0-0-1x_U007epad-0-1-0-0-85-220.png/512x512bb.jpg"
  "bandcamp.jpg|https://is1-ssl.mzstatic.com/image/thumb/Purple211/v4/84/d4/d6/84d4d655-65e6-c295-ef04-c885507baa1b/AppIcon-0-0-1x_U007emarketing-0-7-0-85-220.png/512x512bb.jpg"
  "netease_cloud_music.svg|https://cdn.simpleicons.org/neteasecloudmusic"
  "qq_music.png|https://play-lh.googleusercontent.com/TUK3hsFWriQJvtd9jfpNd81Zc7DKHF7Q8R_iZNjQWfo0FyEGvBX_2DR314DrdDjmMHE3JHRe9Qx0NY49wiKJYg=w512-h512"
  "kugou.png|https://upload.wikimedia.org/wikipedia/commons/e/e9/KuGou_app_icon.png"
  "kuwo.png|https://pp.myapp.com/ma_icon/0/icon_11771_1794475624/256"
  "migu.png|https://pp.myapp.com/ma_icon/0/icon_1044241_1793412197/256"
  "qishui.png|https://pp.myapp.com/ma_icon/0/icon_52575843_1794464538/256"
  "spotify.svg|https://cdn.simpleicons.org/spotify"
  "apple_music.svg|https://cdn.simpleicons.org/applemusic"
  "youtube_music.svg|https://cdn.simpleicons.org/youtubemusic"
  "tidal.svg|https://cdn.simpleicons.org/tidal"
  "deezer.svg|https://cdn.simpleicons.org/deezer"
  "soundcloud.svg|https://cdn.simpleicons.org/soundcloud"
  "bandcamp.svg|https://cdn.simpleicons.org/bandcamp"
  "pandora.svg|https://cdn.simpleicons.org/pandora"
)

fail=0
for entry in "${urls[@]}"; do
  name="${entry%%|*}"
  url="${entry#*|}"
  ok=0
  for attempt in 1 2 3; do
    code=$(curl -sL --retry 2 --connect-timeout 15 -o "$name" -w "%{http_code}" "$url")
    if [ "$code" = "200" ] && [ -s "$name" ]; then
      ok=1
      break
    fi
    sleep 1
  done
  if [ "$ok" = "1" ]; then
    echo "OK   $name ($(du -h "$name" | cut -f1))"
  else
    echo "FAIL $name"
    fail=1
  fi
done
echo "---"
ls -la
exit $fail
