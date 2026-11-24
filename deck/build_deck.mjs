/* 最后一公里 · LastMile 汇报 deck
   深色主调，沿用产品自身的色板（navy + mint），文案中文、标签英文等宽感。
   跑法：$env:NODE_PATH='C:\Users\HONOR\.dsh\skills\pptx\node_modules'; node deck/build_deck.mjs */

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

/* pptxgenjs 装在 skill 目录里，ESM 不认 NODE_PATH，这里用绝对路径 require 进来 */
const require = createRequire(import.meta.url)
const pptxgen = require('pptxgenjs')

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ASSETS = path.join(HERE, 'assets')
const OUT = path.join(HERE, '最后一公里-LastMile.pptx')

const F = { cn: 'Microsoft YaHei', en: 'Arial' }
const C = {
  bg: '0B1220',
  panel: '111C2E',
  panel2: '16243A',
  line: '22304A',
  ink: 'E8EEF7',
  muted: '8FA3BF',
  dim: '5C6E88',
  mint: '3DDC97',
  mint2: '25B77D',
  amber: 'F5B547',
  red: 'FF6B6B',
  white: 'FFFFFF',
  ghost: '16352A'
}

const M = 0.66 // 页边距
const W = 13.333
const CW = W - M * 2

/* 换隧道地址只改这一行（cpolar 免费版每次重启都会变），全篇 4 处引用都跟着走 */
const PUBLIC_URL = 'https://lastmile.example.com'

const pres = new pptxgen()
pres.layout = 'LAYOUT_WIDE'
pres.author = 'LastMile'
pres.title = '最后一公里 · LastMile'
pres.subject = '留学生通知的签收与理解闭环'

/* ---------------- 基础件 ---------------- */

function slide(bg = C.bg) {
  const s = pres.addSlide()
  s.background = { color: bg }
  return s
}

function eyebrow(s, text, x, y, { color = C.muted, size = 10.5, w = 9 } = {}) {
  s.addText(text, {
    x, y, w, h: 0.24, fontFace: F.en, fontSize: size, bold: true,
    color, charSpacing: 2.2, margin: 0, valign: 'middle'
  })
}

function title(s, text, y, { x = M, w = CW, size = 32, color = C.white, h = 0.66 } = {}) {
  s.addText(text, { x, y, w, h, fontFace: F.cn, fontSize: size, bold: true, color, margin: 0, valign: 'top' })
}

function sub(s, text, y, { x = M, w = CW, size = 13, color = C.muted, h = 0.5 } = {}) {
  s.addText(text, { x, y, w, h, fontFace: F.cn, fontSize: size, color, margin: 0, valign: 'top' })
}

function panel(s, x, y, w, h, { fill = C.panel, line = C.line, radius = 0.1 } = {}) {
  s.addShape(pres.ShapeType.roundRect, {
    x, y, w, h, rectRadius: radius,
    fill: { color: fill }, line: { color: line, width: 1 }
  })
}

function fit(pw, ph, bw, bh) {
  const r = Math.min(bw / pw, bh / ph)
  return { w: pw * r, h: ph * r }
}

function shot(s, file, x, y, bw, bh, pw, ph, { frame = true, align = 'center', frameFill = C.panel, frameLine = C.line } = {}) {
  const { w, h } = fit(pw, ph, bw, bh)
  const ox = align === 'center' ? x + (bw - w) / 2 : x
  const oy = y + (bh - h) / 2
  if (frame) {
    panel(s, ox - 0.07, oy - 0.07, w + 0.14, h + 0.14, { fill: frameFill, line: frameLine, radius: 0.09 })
  }
  s.addImage({ path: path.join(ASSETS, file), x: ox, y: oy, w, h })
  return { x: ox, y: oy, w, h }
}

function stat(s, x, y, w, number, label, { color = C.mint, numSize = 44 } = {}) {
  s.addText(number, {
    x, y, w, h: 0.72, fontFace: F.en, fontSize: numSize, bold: true, color, margin: 0, valign: 'bottom'
  })
  s.addText(label, {
    x, y: y + 0.76, w, h: 0.34, fontFace: F.cn, fontSize: 12, color: C.muted, margin: 0, valign: 'top'
  })
}

function bullets(s, items, x, y, w, { size = 13, gap = 0.42, color = C.ink } = {}) {
  items.forEach((t, i) => {
    s.addText(t, {
      x, y: y + i * gap, w, h: gap, fontFace: F.cn, fontSize: size, color,
      margin: 0, valign: 'middle', lineSpacing: size * 1.35
    })
  })
}

function arrow(s, x, y, w, color = C.mint) {
  s.addShape(pres.ShapeType.line, { x, y, w, h: 0, line: { color, width: 1.5, beginArrowType: 'none', endArrowType: 'triangle' } })
}

/* ================= 01 封面 ================= */
{
  const s = slide()
  // 背景大号赛题编号，呼应官方海报
  s.addText('01', {
    x: 9.5, y: 3.3, w: 3.6, h: 3.4, fontFace: F.en, fontSize: 210, bold: true,
    color: C.ghost, margin: 0, valign: 'bottom', align: 'right'
  })

  s.addImage({ path: path.join(ASSETS, 'icon.png'), x: M, y: 0.8, w: 0.78, h: 0.78 })

  s.addText('SWUFE 2026 · 36H 极限黑客松 · 学院官方赛题 01', {
    x: M + 1.0, y: 0.9, w: 8, h: 0.3, fontFace: F.cn, fontSize: 12, bold: true,
    color: C.muted, charSpacing: 0.8, margin: 0, valign: 'middle'
  })
  s.addText('留学生通知的「最后一公里」', {
    x: M + 1.0, y: 1.2, w: 8, h: 0.3, fontFace: F.cn, fontSize: 12,
    color: C.dim, margin: 0, valign: 'middle'
  })

  s.addText('最后一公里', {
    x: M - 0.06, y: 2.05, w: 9, h: 1.3, fontFace: F.cn, fontSize: 72, bold: true,
    color: C.white, margin: 0, valign: 'middle'
  })
  s.addText('The “last mile” of notices', {
    x: M, y: 3.32, w: 9, h: 0.44, fontFace: F.en, fontSize: 20, color: C.mint, margin: 0, valign: 'middle'
  })
  s.addText('把中文行政通知，变成留学生看得懂、能确认、可追踪的卡片。', {
    x: M, y: 4.0, w: 8.6, h: 0.9, fontFace: F.cn, fontSize: 19, color: C.ink, margin: 0, valign: 'top', lineSpacing: 30
  })

  const facts = [
    ['单体原型 · 已上公网', '一个进程，一个 SQLite 文件'],
    ['4 份真实通知 · 114 人', '六种语言常驻，缺则当场生成'],
    ['65 / 65 端到端断言', '含敏感五类拦截 6 组']
  ]
  facts.forEach(([a, b], i) => {
    const x = M + i * 4.05
    s.addText(a, { x, y: 5.62, w: 3.8, h: 0.3, fontFace: F.cn, fontSize: 13, bold: true, color: C.ink, margin: 0 })
    s.addText(b, { x, y: 5.94, w: 3.8, h: 0.3, fontFace: F.cn, fontSize: 11, color: C.muted, margin: 0 })
  })

  s.addText(PUBLIC_URL, {
    x: M, y: 6.86, w: 6, h: 0.3, fontFace: F.en, fontSize: 11, color: C.dim, margin: 0
  })
  s.addText('2026-11-21', {
    x: W - M - 2, y: 6.86, w: 2, h: 0.3, fontFace: F.en, fontSize: 11, color: C.dim, margin: 0, align: 'right'
  })

  s.addNotes('封面。一句话定位：不是翻译工具，是通知的签收与理解闭环。')
}

/* ================= 02 断点 ================= */
{
  const s = slide()
  eyebrow(s, 'WHERE IT BREAKS', M, 0.72)
  title(s, '断点不在通知本身，在通知之后', 0.98)

  const stats = [
    ['1', '名留学生辅导员', '全院只有一个人，还要兼管 114 人的日常'],
    ['114', '名 2026 级新生', '本科生 + 硕士生，语言与作息完全不同'],
    ['88%', '没有 HSK 成绩', '行政中文对他们不是「难」，是「不成立」']
  ]
  stats.forEach(([n, l, d], i) => {
    const x = M + i * 4.03
    panel(s, x, 2.06, 3.72, 2.02)
    stat(s, x + 0.34, 2.28, 3.1, n, l, { numSize: 46 })
    s.addText(d, {
      x: x + 0.34, y: 3.42, w: 3.06, h: 0.5, fontFace: F.cn, fontSize: 10.5,
      color: C.dim, margin: 0, valign: 'top', lineSpacing: 15
    })
  })

  s.addText('于是每一份通知都是这样走完的：', {
    x: M, y: 4.42, w: 8, h: 0.3, fontFace: F.cn, fontSize: 12, color: C.muted, margin: 0
  })

  const flow = ['中文原文 + 一段机翻', '发到班级群', '不知道谁看了', '挨个点名催办']
  flow.forEach((t, i) => {
    const x = M + i * 2.62
    panel(s, x, 4.82, 2.24, 0.62, { fill: C.panel2, radius: 0.08 })
    s.addText(t, {
      x: x + 0.12, y: 4.82, w: 2.0, h: 0.62, fontFace: F.cn, fontSize: 11.5, color: C.ink,
      margin: 0, valign: 'middle', align: 'center'
    })
    if (i < 3) arrow(s, x + 2.26, 5.13, 0.32, C.dim)
  })

  s.addText('一份通知平均发三轮。', {
    x: M, y: 5.78, w: 8, h: 0.36, fontFace: F.cn, fontSize: 15, bold: true, color: C.amber, margin: 0
  })
  s.addText('发完没有回执记录 —— 这是整个赛题的起点，也是我们唯一要解决的问题。', {
    x: M, y: 6.18, w: 11, h: 0.36, fontFace: F.cn, fontSize: 12, color: C.muted, margin: 0
  })

  s.addNotes('三个数字直接来自赛题：1 名辅导员、114 名新生、88% 无 HSK。三行事实：三轮、无回执、挨个点名。')
}

/* ================= 03 缺的是证据 ================= */
{
  const s = slide()
  eyebrow(s, 'THE REAL GAP', M, 0.72)
  title(s, '缺的不是译文，是证据', 0.98)
  sub(s, '「转发」不等于「收到」，「收到」不等于「看懂」。学院真正缺的是一条能证明的链路。', 1.62, { size: 13 })

  // 左：现状
  panel(s, M, 2.28, 5.86, 2.9, { fill: C.panel, line: C.line })
  s.addText('现在的链路', { x: M + 0.34, y: 2.48, w: 5, h: 0.3, fontFace: F.cn, fontSize: 14, bold: true, color: C.red, margin: 0 })
  const bad = ['通知发出去了', '→  谁看了？没有人知道', '→  谁看懂了？没有人知道', '→  谁没做？只能挨个问']
  bad.forEach((t, i) => {
    s.addText(t, {
      x: M + 0.34, y: 2.94 + i * 0.46, w: 5.2, h: 0.4, fontFace: F.cn, fontSize: 12.5,
      color: i === 0 ? C.ink : C.dim, margin: 0, valign: 'middle'
    })
  })

  // 右：目标
  panel(s, M + 6.08, 2.28, 5.86, 2.9, { fill: C.panel, line: C.line })
  s.addText('我们要的链路', { x: M + 6.42, y: 2.48, w: 5, h: 0.3, fontFace: F.cn, fontSize: 14, bold: true, color: C.mint, margin: 0 })
  const good = ['送达  →  打点，看到谁打开', '看懂  →  一道题答对才算懂', '签收  →  带时间戳的回执', '留痕  →  可导出、可追责']
  good.forEach((t, i) => {
    s.addText(t, {
      x: M + 6.42, y: 2.94 + i * 0.46, w: 5.3, h: 0.4, fontFace: F.cn, fontSize: 12.5,
      color: C.ink, margin: 0, valign: 'middle'
    })
  })

  s.addText('我们不生产译文，我们生产回执。', {
    x: M, y: 5.62, w: 11, h: 0.5, fontFace: F.cn, fontSize: 26, bold: true, color: C.mint, margin: 0
  })
  s.addText('翻译是手段，「谁已经知道、谁还没动作」才是可交付的结果。', {
    x: M, y: 6.18, w: 11, h: 0.4, fontFace: F.cn, fontSize: 13, color: C.muted, margin: 0
  })

  s.addNotes('这一页是全场的产品论点：把不可观测的“传达”变成可观测的“回执”。')
}

/* ================= 04 产品全貌 ================= */
{
  const s = slide()
  eyebrow(s, 'THE PRODUCT', M, 0.66)
  title(s, '一份通知进，一张卡片 + 一条闭环出', 0.92, { size: 28 })

  const shots = [
    ['console.png', 1440, 1004, '① 粘贴原文', '辅导员把通知粘进来，10 秒出结构化草稿'],
    ['student.png', 390, 1215, '② 学生卡片', '链接发出去，学生扫码就看，不用注册'],
    ['dashboard.png', 1440, 1010, '③ 回执看板', '谁确认了、谁没读、谁有困难，一屏看完']
  ]
  shots.forEach(([file, pw, ph, cap, desc], i) => {
    const x = M + i * 4.03
    const bw = 3.78
    const bh = 3.5
    shot(s, file, x, 1.82, bw, bh, pw, ph, { frameFill: C.panel2, frameLine: '2C405F' })
    s.addText(cap, {
      x, y: 5.46, w: bw, h: 0.3, fontFace: F.cn, fontSize: 13, bold: true, color: C.ink, margin: 0
    })
    s.addText(desc, {
      x, y: 5.78, w: bw, h: 0.52, fontFace: F.cn, fontSize: 10.5, color: C.muted, margin: 0, lineSpacing: 15
    })
  })

  s.addNotes('三个界面就是三张实拍。左边是入口，中间是学生看到的，右边是辅导员得到的。')
}

/* ================= 05 学生端 ================= */
{
  const s = slide()
  eyebrow(s, 'STUDENT SIDE', M, 0.72)
  title(s, '一屏只讲一件事', 0.98, { size: 30 })

  shot(s, 'student.png', M, 1.72, 1.98, 5.2, 390, 1215)

  const x2 = M + 2.5
  const rows = [
    ['六种语言常驻', '中 / 英 / 俄 / 越 / 泰 / 印尼；缺哪种当场生成并缓存'],
    ['大字 + 朗读', '正文 18px、行动项 20px；点一下念出来，给低识字率的人'],
    ['倒计时 + 加日历', '「还剩 4 天 18 小时」写进手机日历，截止时间不再靠记'],
    ['三色分层', '灰=通知，蓝=要你答题，绿=要你按下确认']
  ]
  rows.forEach(([h, d], i) => {
    const y = 1.86 + i * 1.22
    s.addShape(pres.ShapeType.ellipse, {
      x: x2, y: y + 0.04, w: 0.14, h: 0.14, fill: { color: C.mint }, line: { color: C.mint, width: 0 }
    })
    s.addText(h, { x: x2 + 0.3, y, w: 7.6, h: 0.32, fontFace: F.cn, fontSize: 15, bold: true, color: C.white, margin: 0 })
    s.addText(d, { x: x2 + 0.3, y: y + 0.34, w: 7.6, h: 0.6, fontFace: F.cn, fontSize: 11.5, color: C.muted, margin: 0, lineSpacing: 17 })
  })

  s.addNotes('学生端只做三件事：看懂、记住截止、按下确认。所有设计都在压这个路径的摩擦。')
}

/* ================= 06 小测 ================= */
{
  const s = slide()
  eyebrow(s, 'COMPREHENSION, NOT JUST DELIVERY', M, 0.72)
  title(s, '答错不拦路，只让你看原文', 0.98, { size: 30 })

  const x2 = M
  const rows = [
    ['一道题，必须答', '问「要你做什么、什么时候截止」——正是评委事后抽考的原题'],
    ['答错就高亮原文', '不是弹「错了」，是把通知里那一段翻出来给你看'],
    ['可以无限重试', '不阻塞回执。学会比考倒重要'],
    ['答对才留下痕迹', '回执里带 quiz_passed 时间戳，「看懂」这件事第一次有了记录']
  ]
  rows.forEach(([h, d], i) => {
    const y = 1.86 + i * 1.22
    s.addShape(pres.ShapeType.ellipse, {
      x: x2, y: y + 0.04, w: 0.14, h: 0.14, fill: { color: C.mint }, line: { color: C.mint, width: 0 }
    })
    s.addText(h, { x: x2 + 0.3, y, w: 7.4, h: 0.32, fontFace: F.cn, fontSize: 15, bold: true, color: C.white, margin: 0 })
    s.addText(d, { x: x2 + 0.3, y: y + 0.34, w: 7.4, h: 0.6, fontFace: F.cn, fontSize: 11.5, color: C.muted, margin: 0, lineSpacing: 17 })
  })

  shot(s, 'quiz.png', M + 8.1, 1.72, 2.0, 5.2, 390, 1017)

  s.addNotes('这一页回应评分口径：「抽 10 人问要你做什么、什么时候截止，答对 8 人」。小测就是这个指标的日常训练。')
}

/* ================= 07 辅导员端 ================= */
{
  const s = slide()
  eyebrow(s, 'COUNSELOR SIDE', M, 0.72)
  title(s, 'AI 不是黑箱：每个字段都能点回原文', 0.98, { size: 28 })

  shot(s, 'counselor_confirm.png', M, 1.62, 7.62, 5.3, 1440, 1080)

  const x2 = M + 7.95
  const rows = [
    ['字段级溯源', '标题、一句话、行动项下面都有一行「↵ 原文片段」'],
    ['抽不到就留空', '不猜。宁可空着标红，也不编一个截止时间'],
    ['相对时间要交代', '「下周三」换算成绝对日期，并标 low confidence 说明推算依据'],
    ['风险条先说清', '涉及居留许可，页面顶部直接写明：只转述，不提供建议']
  ]
  rows.forEach(([h, d], i) => {
    const y = 1.78 + i * 1.24
    s.addText(h, { x: x2, y, w: 4.7, h: 0.3, fontFace: F.cn, fontSize: 13.5, bold: true, color: C.mint, margin: 0 })
    s.addText(d, { x: x2, y: y + 0.3, w: 4.7, h: 0.66, fontFace: F.cn, fontSize: 10.5, color: C.muted, margin: 0, lineSpacing: 15 })
  })

  s.addNotes('AI 在这里不是替人决策，是替人做第一稿，并且把每一个结论都锚回原文。')
}

/* ================= 08 看板与催办 ================= */
{
  const s = slide()
  eyebrow(s, 'FREEZE THE CHAOS', M, 0.72)
  title(s, '从「挨个点名」到「复制一段话」', 0.98, { size: 28 })

  shot(s, 'dashboard.png', M, 1.72, 5.9, 4.1, 1440, 1010)
  shot(s, 'nudge.png', M + 6.08, 1.72, 5.9, 4.1, 1440, 1180)

  s.addText('看板', { x: M, y: 5.98, w: 3, h: 0.28, fontFace: F.cn, fontSize: 12, bold: true, color: C.ink, margin: 0 })
  s.addText('已确认 / 已读未回执 / 未读 / 有困难，四档分开；24 小时到齐曲线；拒绝日志单列。', {
    x: M, y: 6.28, w: 5.9, h: 0.5, fontFace: F.cn, fontSize: 10.5, color: C.muted, margin: 0, lineSpacing: 15
  })
  s.addText('催办', { x: M + 6.08, y: 5.98, w: 3, h: 0.28, fontFace: F.cn, fontSize: 12, bold: true, color: C.ink, margin: 0 })
  s.addText('选范围 + 语气 + 语言 → 一段能直接粘进群的话：一句话、截止、未确认名单、可点链接、二维码。', {
    x: M + 6.08, y: 6.28, w: 5.9, h: 0.5, fontFace: F.cn, fontSize: 10.5, color: C.muted, margin: 0, lineSpacing: 15
  })

  s.addNotes('辅导员从「25 分钟 + 三轮点名」变成「3 分钟 + 一次复制」。')
}

/* ================= 09 合规 ================= */
{
  const s = slide()
  eyebrow(s, 'COMPLIANCE · THE FIVE CATEGORIES', M, 0.72)
  title(s, '转述可以，咨询不行', 0.98, { size: 30 })
  sub(s, '签证、居留许可、看病体检、心理、安全五类问题，产品不自己回答。难点是分清「复述通知」和「给建议」。', 1.6, { size: 12.5 })

  panel(s, M, 2.22, 5.86, 2.62, { fill: C.panel, line: C.line })
  s.addText('允许 · 只复述通知', { x: M + 0.34, y: 2.42, w: 5, h: 0.3, fontFace: F.cn, fontSize: 13.5, bold: true, color: C.mint, margin: 0 })
  const allow = ['「这份通知要我带什么材料？」', '「截止到几号？」', '「我能让人代办吗？」→ 答：不接受代办']
  allow.forEach((t, i) => {
    s.addText(t, { x: M + 0.34, y: 2.86 + i * 0.5, w: 5.2, h: 0.44, fontFace: F.cn, fontSize: 11.5, color: C.ink, margin: 0, valign: 'middle' })
  })

  panel(s, M + 6.08, 2.22, 5.86, 2.62, { fill: C.panel, line: C.line })
  s.addText('拒绝 · 个性化判断', { x: M + 6.42, y: 2.42, w: 5, h: 0.3, fontFace: F.cn, fontSize: 13.5, bold: true, color: C.red, margin: 0 })
  const deny = ['「我护照丢了还能办吗？」', '「我会不会被遣返？」', '「体检不合格会退学吗？」']
  deny.forEach((t, i) => {
    s.addText(t, { x: M + 6.42, y: 2.86 + i * 0.5, w: 5.3, h: 0.44, fontFace: F.cn, fontSize: 11.5, color: C.dim, margin: 0, valign: 'middle' })
  })

  const mech = ['规则层 0 ms 命中', '模型层判 scope', '拿不准 → 默认拒绝', '每次拒绝都留痕']
  mech.forEach((t, i) => {
    const x = M + i * 3.02
    panel(s, x, 5.06, 2.72, 0.62, { fill: C.panel2, radius: 0.08 })
    s.addText(t, { x: x + 0.1, y: 5.06, w: 2.52, h: 0.62, fontFace: F.cn, fontSize: 11, color: C.ink, margin: 0, valign: 'middle', align: 'center' })
  })

  s.addText('拒绝不是失败，是产品的一部分 —— 它出现在看板的「AI 主动拒绝并转人工」里。', {
    x: M, y: 5.94, w: 11.4, h: 0.4, fontFace: F.cn, fontSize: 12.5, color: C.muted, margin: 0
  })

  s.addNotes('答辩最容易被追问的一页。要点：五类不是全拒，通知本身关于居留许可时，复述通知内容是合规的；个性化判断才拒绝。')
}

/* ================= 10 实现路径 ================= */
{
  const s = slide()
  eyebrow(s, 'HOW IT\'S BUILT', M, 0.72)
  title(s, '四层，一个进程', 0.98, { size: 30 })
  sub(s, '没有微服务、没有消息队列、没有前端构建服务端渲染。一条 npm start 就是全部。', 1.6, { size: 12.5 })

  const layers = [
    ['HTTP 层', 'api.js', '16 个端点，静态页和接口同一个进程；AI 全部 try/catch，挂了照样能发通知'],
    ['数据层', 'repo.js', '所有 SQL 只在这一个文件里；表结构 6 张，数据库是一个可拷贝的文件'],
    ['AI 管线', 'ai.js / prompts.js', '抽取结构化字段 → 生成小测 → 六语翻译 → 催办文案，全部 JSON 模式 + 校验'],
    ['合规层', 'guard.js', '规则词表 + 意图分类双层，fail-closed；允许的回答只能是原文复述']
  ]
  layers.forEach(([name, file, desc], i) => {
    const y = 2.28 + i * 1.16
    panel(s, M, y, 8.3, 0.98, { fill: i === 3 ? C.panel2 : C.panel })
    s.addText(name, { x: M + 0.26, y: y + 0.1, w: 1.3, h: 0.3, fontFace: F.cn, fontSize: 13.5, bold: true, color: C.mint, margin: 0 })
    s.addText(file, { x: M + 0.26, y: y + 0.46, w: 1.3, h: 0.26, fontFace: F.en, fontSize: 9, color: C.dim, margin: 0 })
    s.addText(desc, { x: M + 1.72, y: y + 0.12, w: 6.4, h: 0.78, fontFace: F.cn, fontSize: 10.5, color: C.ink, margin: 0, valign: 'middle', lineSpacing: 15 })
  })

  // 右侧技术栈
  const stack = ['Node 24', 'Express 4', 'SQLite（内置）', 'React 19', 'Vite', 'DeepSeek API']
  s.addText('技术栈', { x: M + 8.62, y: 2.28, w: 3, h: 0.3, fontFace: F.cn, fontSize: 11, color: C.muted, margin: 0 })
  stack.forEach((t, i) => {
    const y = 2.68 + i * 0.52
    panel(s, M + 8.62, y, 2.52, 0.42, { fill: C.panel2, radius: 0.06 })
    s.addText(t, { x: M + 8.62, y, w: 2.52, h: 0.42, fontFace: F.en, fontSize: 10.5, color: C.ink, margin: 0, align: 'center', valign: 'middle' })
  })
  s.addText('零外部服务\n零 npm 原生依赖\n密钥只在服务端', {
    x: M + 8.62, y: 5.96, w: 2.6, h: 0.9, fontFace: F.cn, fontSize: 10, color: C.dim, margin: 0, lineSpacing: 15
  })

  s.addNotes('强调工程克制：36 小时里，能少一个组件就少一个。四层的边界是清楚可维护的。')
}

/* ================= 11 部署可行性 ================= */
{
  const s = slide()
  eyebrow(s, 'DEPLOYMENT', M, 0.66)
  title(s, '从这台笔记本，到一台服务器', 0.92, { size: 28 })
  sub(s, '同一份代码，三种落差很小的部署形态。换环境不需要改业务代码。', 1.5, { size: 12.5 })

  const cols = [
    ['现在 · 演示', '本机 + cpolar 免费隧道', ['npm start 一个进程', 'cpolar http 3000', '地址每次重启会变', '成本 0，10 分钟上线'], C.mint],
    ['48h 实测', '本机 + 更稳的穿透', ['换国内节点付费版（99 元/年）', '或 named tunnel 固定域名', '保持机器不休眠', '成本 ≈ 100 元'], C.amber],
    ['长期 · 正式', '域名 + 香港轻量服务器', ['域名 30–60 元/年', '2C2G 轻量 24–40 元/月（免备案）', 'Caddy 自动 HTTPS', '首年 300–500 元'], C.muted]
  ]
  cols.forEach(([h, sub2, items, accent], i) => {
    const x = M + i * 4.03
    panel(s, x, 2.02, 3.72, 3.32)
    s.addText(h, { x: x + 0.3, y: 2.22, w: 3.1, h: 0.3, fontFace: F.cn, fontSize: 13, bold: true, color: C.white, margin: 0 })
    s.addText(sub2, { x: x + 0.3, y: 2.56, w: 3.1, h: 0.3, fontFace: F.cn, fontSize: 10, color: accent, margin: 0 })
    items.forEach((t, j) => {
      s.addText('·  ' + t, { x: x + 0.3, y: 3.02 + j * 0.52, w: 3.1, h: 0.46, fontFace: F.cn, fontSize: 9.8, color: C.muted, margin: 0, lineSpacing: 13 })
    })
  })

  panel(s, M, 5.56, 11.6, 1.0, { fill: C.panel2, line: C.line })
  s.addText('迁移成本：只有 repo.js 一个文件', {
    x: M + 0.3, y: 5.68, w: 6.6, h: 0.32, fontFace: F.cn, fontSize: 13.5, bold: true, color: C.mint, margin: 0
  })
  s.addText('数据访问全部收在一个文件里，api.js 只调 repo.*。换 Postgres 或云数据库 = 重写这一个文件，前端与接口契约一行不动。', {
    x: M + 0.3, y: 6.02, w: 10.9, h: 0.44, fontFace: F.cn, fontSize: 10.5, color: C.muted, margin: 0, lineSpacing: 14
  })

  s.addNotes('可行性论证：不是「理论上能上云」，是接口层已经把数据访问隔离了，迁移是替换实现而不是重写。')
}

/* ================= 12 现状 ================= */
{
  const s = slide()
  eyebrow(s, 'STATUS · 2026-11-21', M, 0.72)
  title(s, '不是 PPT，是能打开的系统', 0.98, { size: 30 })

  const stats = [
    ['65 / 65', '端到端断言通过', C.mint],
    ['4', '份真实通知在跑', C.mint],
    ['114', '人花名册（可导入替换）', C.mint],
    ['6', '种语言，缺则当场生成', C.mint],
    ['2.9 s', '1 Mbps 下首屏加载', C.mint],
    ['0', '答案泄漏 / 越权访问', C.mint]
  ]
  stats.forEach(([n, l, c], i) => {
    const col = i % 3
    const row = Math.floor(i / 3)
    const x = M + col * 3.9
    const y = 1.86 + row * 1.86
    panel(s, x, y, 3.62, 1.56)
    s.addText(n, { x: x + 0.3, y: y + 0.18, w: 3.0, h: 0.66, fontFace: F.en, fontSize: 34, bold: true, color: c, margin: 0, valign: 'bottom' })
    s.addText(l, { x: x + 0.3, y: y + 0.9, w: 3.05, h: 0.42, fontFace: F.cn, fontSize: 10.5, color: C.muted, margin: 0, lineSpacing: 14 })
  })

  panel(s, M, 5.72, 11.6, 0.96, { fill: C.panel2, line: C.line })
  s.addText(`公网可用：${PUBLIC_URL}   ·   辅导员端密码 123456   ·   学生端不用登录`, {
    x: M + 0.3, y: 5.72, w: 11, h: 0.96, fontFace: F.cn, fontSize: 12.5, color: C.ink, margin: 0, valign: 'middle'
  })

  s.addText('数据是真的：连续真调 DeepSeek 跑过抽取、六语翻译、催办；敏感五类 6 组越权请求全部被拒。', {
    x: M, y: 6.86, w: 11.6, h: 0.3, fontFace: F.cn, fontSize: 10, color: C.dim, margin: 0
  })

  s.addNotes('这一页给评委可验证的东西：地址能打开、断言能复跑、越权打不进去。')
}

/* ================= 13 收尾 ================= */
{
  const s = slide()
  s.addText('我们没做翻译工具。', {
    x: M, y: 1.62, w: 11, h: 0.7, fontFace: F.cn, fontSize: 30, color: C.muted, margin: 0
  })
  s.addText('我们做的是通知的签收与理解闭环。', {
    x: M, y: 2.38, w: 11.6, h: 0.9, fontFace: F.cn, fontSize: 40, bold: true, color: C.white, margin: 0
  })

  const goals = [
    ['≥ 18 / 20', '48 小时内提交回执'],
    ['≥ 8 / 10', '抽问「做什么、何时截止」答对'],
    ['3 轮 → 1 轮', '同一份通知的催办次数']
  ]
  goals.forEach(([n, l], i) => {
    const x = M + i * 4.03
    panel(s, x, 3.72, 3.72, 1.34)
    s.addText(n, { x: x + 0.3, y: 3.88, w: 3.1, h: 0.5, fontFace: F.en, fontSize: 22, bold: true, color: C.mint, margin: 0 })
    s.addText(l, { x: x + 0.3, y: 4.44, w: 3.1, h: 0.4, fontFace: F.cn, fontSize: 10.5, color: C.muted, margin: 0, lineSpacing: 14 })
  })

  s.addText(`打开看：${PUBLIC_URL}/#/c`, {
    x: M, y: 5.62, w: 8, h: 0.34, fontFace: F.en, fontSize: 13, color: C.ink, margin: 0
  })
  s.addText(`密码 123456   ·   学生端 ${PUBLIC_URL}/#/s/ntc_residence_2026`, {
    x: M, y: 5.98, w: 10, h: 0.3, fontFace: F.cn, fontSize: 10.5, color: C.dim, margin: 0
  })

  s.addImage({ path: path.join(ASSETS, 'icon.png'), x: W - M - 0.66, y: 5.6, w: 0.66, h: 0.66 })

  s.addNotes('结尾把三个可测指标再打一遍，对应赛题的评分口径。')
}

await pres.writeFile({ fileName: OUT })
console.log('written:', OUT)
