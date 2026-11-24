/* 生成 PWA 图标，零依赖（自己写 PNG 编码）。
   用法：node scripts/make-icons.mjs
   产物：web/public/icon-192.png / icon-512.png / icon-maskable-512.png / apple-touch-icon.png */

import { deflateSync } from 'node:zlib'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(ROOT, 'web', 'public')
fs.mkdirSync(OUT, { recursive: true })

/* ---------- 极简 PNG 编码 ---------- */
const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crc32(buf) {
  let c = ~0
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (~c >>> 0) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const t = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])))
  return Buffer.concat([len, t, data, crc])
}

function encodePng(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h)
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/* ---------- 画图 ---------- */
const NAVY = [0x0b, 0x12, 0x20]
const MINT = [0x3d, 0xdc, 0x97]

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v)

function inRoundRect(x, y, w, h, r) {
  const cx = Math.min(Math.max(x, r), w - r)
  const cy = Math.min(Math.max(y, r), h - r)
  return Math.hypot(x - cx, y - cy) <= r
}

function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax
  const dy = by - ay
  const len2 = dx * dx + dy * dy || 1
  let t = ((px - ax) * dx + (py - ay) * dy) / len2
  t = t < 0 ? 0 : t > 1 ? 1 : t
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
}

/** check 三点（归一化 0..1），s = 缩放，厚度按尺寸走 */
const CHECK = [
  [0.295, 0.525],
  [0.44, 0.665],
  [0.715, 0.36]
]

function draw(size, { maskable = false, radius = 0.19 } = {}) {
  const buf = Buffer.alloc(size * size * 4)
  const inset = maskable ? 0.72 : 0.88 // maskable 要留安全区
  const scale = (v) => (v - 0.5) * inset + 0.5
  const pts = CHECK.map(([x, y]) => [scale(x) * size, scale(y) * size])
  const thick = size * 0.052
  const r = maskable ? 0 : size * radius

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x + 0.5
      const py = y + 0.5
      let bgA = maskable ? 1 : inRoundRect(px, py, size, size, r) ? 1 : 0

      // 抗锯齿：圆角边缘 1px 羽化
      if (!maskable) {
        const cx = Math.min(Math.max(px, r), size - r)
        const cy = Math.min(Math.max(py, r), size - r)
        const d = Math.hypot(px - cx, py - cy) - r
        bgA = clamp01(0.5 - d)
      }

      const d1 = segDist(px, py, pts[0][0], pts[0][1], pts[1][0], pts[1][1])
      const d2 = segDist(px, py, pts[1][0], pts[1][1], pts[2][0], pts[2][1])
      const d = Math.min(d1, d2)
      const markA = clamp01(thick - d + 0.5)

      const outA = Math.max(bgA, markA * bgA)
      const i = (y * size + x) * 4
      if (outA <= 0) {
        buf[i] = 0
        buf[i + 1] = 0
        buf[i + 2] = 0
        buf[i + 3] = 0
        continue
      }
      const mix = markA * bgA
      buf[i] = Math.round(NAVY[0] * (1 - mix) + MINT[0] * mix)
      buf[i + 1] = Math.round(NAVY[1] * (1 - mix) + MINT[1] * mix)
      buf[i + 2] = Math.round(NAVY[2] * (1 - mix) + MINT[2] * mix)
      buf[i + 3] = Math.round(outA * 255)
    }
  }
  return encodePng(size, size, buf)
}

const jobs = [
  ['icon-192.png', 192, {}],
  ['icon-512.png', 512, {}],
  ['icon-maskable-512.png', 512, { maskable: true }],
  ['apple-touch-icon.png', 180, { radius: 0 }]
]

for (const [name, size, opts] of jobs) {
  const png = draw(size, opts)
  fs.writeFileSync(path.join(OUT, name), png)
  console.log(`  ${name.padEnd(24)} ${size}x${size}  ${(png.length / 1024).toFixed(1)} KB`)
}
console.log('icons written to web/public')
