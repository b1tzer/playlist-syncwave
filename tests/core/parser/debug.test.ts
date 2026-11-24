import { describe, it, expect } from 'vitest'
import { parseText } from '@core/parser/parseText'

const INPUT = `Radiohead - Weird Fishes/Arpeggi
Black Country, New Road - Basketball Shoes
The War on Drugs - Under the Pressure
Yussef Dayes - Black Classical Music
Hiatus Kaiyote - Breathing Underwater
Cory Wong - Golden
Björk - Hidden Place`

describe('回归：英文独立乐队清单（用户实测报告）', () => {
  it('七行默认「歌手 - 歌名」展示正确，双候选交由搜索验证', () => {
    const r = parseText(INPUT)
    expect(r.songs.map((s) => [s.title, s.artist])).toEqual([
      ['Weird Fishes/Arpeggi', 'Radiohead'],
      ['Basketball Shoes', 'Black Country, New Road'],
      ['Under the Pressure', 'The War on Drugs'],
      ['Black Classical Music', 'Yussef Dayes'],
      ['Breathing Underwater', 'Hiatus Kaiyote'],
      ['Golden', 'Cory Wong'],
      ['Hidden Place', 'Björk'],
    ])
    expect(r.songs.every((s) => s.candidates?.length === 2)).toBe(true)
  })

  it('斜杠歌名不触发多人名误判（Radiohead 行）', () => {
    const r = parseText('Radiohead - Weird Fishes/Arpeggi')
    expect(r.songs[0]).toMatchObject({ title: 'Weird Fishes/Arpeggi', artist: 'Radiohead' })
  })

  it('英文带逗号乐队名不误判多人名', () => {
    const r = parseText('Black Country, New Road - Basketball Shoes')
    expect(r.songs[0]).toMatchObject({ title: 'Basketball Shoes', artist: 'Black Country, New Road' })
  })
})
