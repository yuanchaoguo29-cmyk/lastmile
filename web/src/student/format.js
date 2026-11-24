/* 学生端纯函数：入口参数解析、倒计时、时间格式化、.ics 生成、下载。
   这里不碰 React，方便单独推理。 */

const LOCALE = {
  zh: 'zh-CN',
  en: 'en-GB',
  ru: 'ru-RU',
  vi: 'vi-VN',
  th: 'th-TH',
  id: 'id-ID',
  my: 'my-MM',
  fr: 'fr-FR'
}

export const localeOf = (lang) => LOCALE[lang] || undefined

/* ---------- 入口参数 ----------
   hash 路由由冻结的 main.jsx 驱动，`#/s/:id?lang=ru&sid=xxx` 会把查询串
   整段塞进 id，所以这里自己拆。同时兼容 location.search（`?sid=` 二维码）。 */
export function readEntry(idRaw) {
  const raw = String(idRaw == null ? '' : idRaw)
  const [idPart, hashQuery = ''] = raw.split('?')
  let hashParams = new URLSearchParams()
  let searchParams = new URLSearchParams()
  try {
    hashParams = new URLSearchParams(hashQuery)
  } catch {
    hashParams = new URLSearchParams()
  }
  try {
    searchParams = new URLSearchParams(location.search || '')
  } catch {
    searchParams = new URLSearchParams()
  }
  const pick = (key) => hashParams.get(key) || searchParams.get(key) || ''
  let id = idPart.replace(/^#/, '').split('&')[0]
  try {
    id = decodeURIComponent(id)
  } catch {
    /* 保持原样 */
  }
  return { id, lang: pick('lang'), sid: pick('sid') }
}

/* 把 api.js 抛出来的错误翻成「人话类别」。原始 message 只作为副标题展示。 */
export function describeError(e) {
  const msg = String((e && e.message) || e || '')
  if (/lm-timeout|timed out|timeout|超时/i.test(msg)) {
    return { kind: 'timeout', detail: '' }
  }
  if (/连不上服务器|连不上|Failed to fetch|NetworkError|network|Load failed|ERR_/i.test(msg)) {
    return { kind: 'net', detail: '' }
  }
  if (/不存在|not found|404|已失效|removed/i.test(msg)) {
    return { kind: 'notfound', detail: '' }
  }
  return { kind: 'generic', detail: msg.slice(0, 160) }
}

/* 给请求加一个前端超时：翻译一个还没生成的语种，服务端最长要 20 秒，
   不能让用户无限等一个不会回来的 Promise。超时抛 'lm-timeout'，
   交给 describeError 归成 timeout 类，页面保持原语言内容。 */
export function withTimeout(promise, ms, reason) {
  const limit = Number(ms) > 0 ? Number(ms) : 0
  return new Promise((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      reject(new Error(reason || 'lm-timeout'))
    }, limit)
    promise.then(
      (value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(err)
      }
    )
  })
}

/* ---------- 倒计时 ---------- */
export function hoursFromDeadline(deadline) {
  const raw = deadline && deadline.hours_left
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw
  if (typeof raw === 'string' && raw.trim() !== '' && Number.isFinite(Number(raw))) return Number(raw)
  const iso = deadline && deadline.iso
  if (!iso) return null
  const at = new Date(iso).getTime()
  if (Number.isNaN(at)) return null
  return (at - Date.now()) / 3600000
}

/* 返回 { text, tone }：tone ∈ ok | warn | over。不足 24 小时转 --s-warn。 */
export function countdownText(tr, hoursLeft) {
  if (hoursLeft == null || !Number.isFinite(hoursLeft)) return null
  if (hoursLeft <= 0) return { text: tr('overdue'), tone: 'over' }
  const totalMinutes = Math.max(1, Math.round(hoursLeft * 60))
  if (totalMinutes < 60) {
    return { text: tr('remainingMinutes', { m: totalMinutes }), tone: 'warn' }
  }
  const totalHours = Math.floor(totalMinutes / 60)
  const days = Math.floor(totalHours / 24)
  const restHours = totalHours % 24
  const tone = hoursLeft < 24 ? 'warn' : 'ok'
  if (days > 0) {
    if (restHours > 0) return { text: tr('remainingDH', { d: days, h: restHours }), tone }
    return { text: tr('remainingDays', { d: days }), tone }
  }
  return { text: tr('remainingHours', { h: totalHours }), tone }
}

/* 本地时间：优先通知自带文案，其次本地化 iso。 */
export function formatWhen(iso, lang) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  try {
    return d.toLocaleString(localeOf(lang), { dateStyle: 'medium', timeStyle: 'short' })
  } catch {
    try {
      return d.toLocaleString()
    } catch {
      return d.toISOString().slice(0, 16).replace('T', ' ')
    }
  }
}

/* 截止时间的可读文案：优先服务端本地化文案，其次本地化 iso，最后原文。 */
export function deadlineLabel(deadline, lang) {
  const d = deadline || {}
  return String(d.text || formatWhen(d.iso, lang) || d.raw || '').trim()
}

export function prefersReducedMotion() {
  try {
    return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

export function scrollBehavior() {
  return prefersReducedMotion() ? 'auto' : 'smooth'
}

/* ---------- .ics ---------- */

const encoder = typeof TextEncoder === 'function' ? new TextEncoder() : null

const octets = (ch) => (encoder ? encoder.encode(ch).length : 1)

const pad2 = (n) => String(n).padStart(2, '0')

/* iCalendar 要求 UTC 时间（末尾 Z），这里统一换算，避免客户端时区解析歧义。 */
function icsStamp(date) {
  return (
    String(date.getUTCFullYear()) +
    pad2(date.getUTCMonth() + 1) +
    pad2(date.getUTCDate()) +
    'T' +
    pad2(date.getUTCHours()) +
    pad2(date.getUTCMinutes()) +
    pad2(date.getUTCSeconds()) +
    'Z'
  )
}

function icsEscape(value) {
  return String(value == null ? '' : value)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n')
}

/* RFC 5545：单行不超过 75 个八位组，续行以一个空格开头。 */
function foldLine(line) {
  const chunks = []
  let current = ''
  let size = 0
  for (const ch of line) {
    const n = octets(ch)
    if (size + n > 73) {
      chunks.push(current)
      current = ' '
      size = 1
    }
    current += ch
    size += n
  }
  chunks.push(current)
  return chunks.join('\r\n')
}

/* 生成 .ics 文本：DTSTART 用 deadline.iso，DTEND 取 +1 小时，
   SUMMARY 用 one_line，DESCRIPTION 用 actions 拼起来。日期不合法返回 null。 */
export function buildIcs({ noticeId, oneLine, actions, startIso, location, lang }) {
  if (!startIso) return null
  const start = new Date(startIso)
  if (Number.isNaN(start.getTime())) return null
  const end = new Date(start.getTime() + 60 * 60 * 1000)
  const list = (Array.isArray(actions) ? actions : [])
    .slice()
    .sort((a, b) => (Number(a?.order) || 0) - (Number(b?.order) || 0))
    .map((a, i) => `${Number(a?.order) || i + 1}. ${String(a?.text || '').trim()}`)
    .filter((line) => line.replace(/^\d+\.\s*/, '').length > 0)
  const summary = String(oneLine || '').trim() || 'LastMile'
  const description = list.join('\n')

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//LastMile//Student Notice//' + String(lang || 'en').toUpperCase(),
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    'UID:lm-' + String(noticeId || 'notice') + '-' + start.getTime() + '@lastmile',
    'DTSTAMP:' + icsStamp(new Date()),
    'DTSTART:' + icsStamp(start),
    'DTEND:' + icsStamp(end),
    'SUMMARY:' + icsEscape(summary)
  ]
  if (description) lines.push('DESCRIPTION:' + icsEscape(description))
  if (location) lines.push('LOCATION:' + icsEscape(location))
  // 提前 3 小时提醒一次，降低「看懂了但还是忘了」的漏掉率
  lines.push(
    'BEGIN:VALARM',
    'TRIGGER:-PT3H',
    'ACTION:DISPLAY',
    'DESCRIPTION:' + icsEscape(summary),
    'END:VALARM'
  )
  lines.push('END:VEVENT', 'END:VCALENDAR')
  return lines.map(foldLine).join('\r\n') + '\r\n'
}

/* 触发浏览器下载。失败返回 false，由上层显示人话提示。 */
export function downloadIcs(filename, text) {
  if (!text || typeof document === 'undefined') return false
  try {
    const blob = new Blob([text], { type: 'text/calendar;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename || 'lastmile.ics'
    a.rel = 'noopener'
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    setTimeout(() => {
      try {
        URL.revokeObjectURL(url)
      } catch {
        /* 忽略 */
      }
    }, 2000)
    return true
  } catch {
    return false
  }
}

export function icsFilename(noticeId) {
  const safe = String(noticeId || 'notice').replace(/[^\w.-]+/g, '')
  return `lastmile-${safe || 'notice'}.ics`
}
