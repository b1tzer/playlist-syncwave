import { normalize } from '@core/matcher/matchSong'

const RAW_ARTISTS: string[] = [
  // 华语
  '周杰伦', '林宥嘉', '陈奕迅', '王力宏', '林俊杰', '邓紫棋', '孙燕姿', '蔡依林',
  '梁静茹', '五月天', '李荣浩', '薛之谦', '周深', '毛不易', '张杰', '张学友',
  '刘德华', '王菲', '陈粒', '许嵩', '汪苏泷', '朴树', '陶喆', '张惠妹', '田馥甄',
  '苏打绿', '陈绮贞', '林忆莲', '莫文蔚', '杨千嬅', '容祖儿', '潘玮柏', '吴青峰',
  '华晨宇', '李健', '谭维维', '郁可唯', '张靓颖', '杨宗纬', '萧敬腾', '林志炫',
  '李宗盛', '罗大佑', '伍佰', '张信哲', '光良', '任贤齐', '刘若英', '梁咏琪',
  '萧亚轩', '王心凌', '张韶涵', '戴佩妮', '徐佳莹', '金志文', '棉子', '莫艳琳',
  '胡彦斌', '方大同', '蔡健雅', '魏如萱', '黄霄云', '单依纯', '王源', '易烊千玺',
  '王俊凯', '张碧晨', '周笔畅', '李宇春', '凤凰传奇', '刀郎', '汪峰', '许巍',
  '郑钧', '窦唯', '崔健', '赵雷', '宋冬野', '马頔', '房东的猫', '海来阿木',
  '任素汐', '程响', '半阳', '花粥', '隔壁老樊', '李玖哲', '郑秀文', '古巨基',
  '张国荣', '梅艳芳', '邓丽君', '黄家驹', '陈慧娴', '李克勤', '谭咏麟', '林子祥',
  '蔡徐坤', '小鬼', '大张伟', '徐良', '本兮', '阿肆', '逃跑计划', 'gala',
  // 欧美流行
  'Taylor Swift', 'Ed Sheeran', 'Adele', 'Bruno Mars', 'Billie Eilish', 'Coldplay',
  'Maroon 5', 'Imagine Dragons', 'Lady Gaga', 'Rihanna', 'Eminem', 'Justin Bieber',
  'Beyonce', 'The Weeknd', 'Dua Lipa', 'Charlie Puth', 'Alan Walker', 'Sia',
  'Shawn Mendes', 'One Direction', 'Linkin Park', 'Avicii', 'Queen', 'Michael Jackson',
  'Madonna', 'John Legend', 'Sam Smith', 'Post Malone', 'Ariana Grande', 'Katy Perry',
  'Selena Gomez', 'Troye Sivan', 'Lauv', 'James Blunt', 'Westlife', 'Backstreet Boys',
  'OneRepublic', 'Panic At The Disco', 'Owl City', 'Keane', 'Greenday', 'Blur', 'Oasis',
  // 欧美摇滚/独立/电子/爵士（真实使用清单场景）
  'Radiohead', 'The War On Drugs', 'Black Country, New Road', 'Yussef Dayes',
  'Hiatus Kaiyote', 'Cory Wong', 'Björk', 'The Beatles', 'Pink Floyd', 'Nirvana',
  'Arctic Monkeys', 'The Strokes', 'The Smiths', 'The Cure', 'Depeche Mode',
  'David Bowie', 'Fleetwood Mac', 'Led Zeppelin', 'Metallica', 'Portishead',
  'Massive Attack', 'Aphex Twin', 'Kraftwerk', 'Daft Punk', 'Tame Impala', 'Bon Iver',
  'Bonobo', 'Thundercat', 'Snarky Puppy', 'Vulfpeck', 'Khruangbin', 'Badbadnotgood',
  'J Dilla', 'MF DOOM', 'Kendrick Lamar', 'Tyler The Creator', 'Frank Ocean',
  'Phoebe Bridgers', 'Sufjan Stevens', 'Arcade Fire', 'Interpol', 'Joy Division',
  'New Order', 'Nick Cave', 'Tom Waits', 'Fiona Apple', 'Sigur Ros', 'Mogwai',
  'Nils Frahm', 'Max Richter', 'Philip Glass', 'Steve Reich', 'Mac DeMarco',
  'Little Simz', 'Nas', 'Beck', 'The National', 'Vampire Weekend', 'Gorillaz',
  'Bjork', 'Tool', 'Muse', 'The Verve', 'Slowdive', 'My Bloody Valentine',
  'The Flaming Lips', 'Wilco', 'Elliott Smith', 'Modest Mouse', 'Death Cab For Cutie',
  'Lana Del Rey', 'Twenty One Pilots', 'The 1975', 'FKA Twigs', 'James Blake',
  'Sampha', 'Moses Sumney', 'Kali Uchis', 'Anderson Paak', 'Mac Miller',
  'D Angelo', 'Erykah Badu', 'Bad Bunny', 'Rosalia',
  // 日韩
  '米津玄师', '宇多田光', 'Aimer', '中岛美嘉', 'Radwimps', 'Yoasobi', 'Reol',
  'BTS', 'IU', 'Blackpink', 'Bigbang', 'EXO', 'Twice', '少女时代',
]

/**
 * 内置常见歌手/乐队词典（轻量 seed，随版本扩充）。
 * 存储为归一化 key；仅作正信号：命中倾向歌手侧，未命中不计负分。
 */
export const ARTIST_LEXICON: ReadonlySet<string> = new Set(RAW_ARTISTS.map((n) => normalize(n)))

