/* 辅导员端通用工具：复制、时间、状态、结构化字段兜底。
   全部是纯函数，不碰 DOM（copyText 除外），方便在页面里复用。 */

/* 语言标签：只用于标签，不用于正文（正文走服务端翻译） */
export const LANG_LABEL = {
  zh: '中文',
  en: 'EN',
  ru: 'RU',
  vi: 'VI',
  th: 'TH',
  id: 'ID',
  my: 'MY',
  fr: 'FR'
}

export const LANG_FULL = {
  zh: '中文',
  en: 'English',
  ru: 'Русский',
  vi: 'Tiếng Việt',
  th: 'ไทย',
  id: 'Bahasa Indonesia',
  my: 'မြန်မာ',
  fr: 'Français'
}

/* 学生回执状态。服务端只会有这四种。 */
export const STATUS_META = {
  confirmed: { label: '已确认', color: 'var(--mint)' },
  seen: { label: '已读未回执', color: 'var(--blue)' },
  unread: { label: '未读', color: 'var(--red)' },
  help: { label: '有困难', color: 'var(--amber)' }
}

export const RISK_LABEL = {
  residence_permit: '居留许可',
  visa: '签证',
  medical: '医疗与体检',
  mental: '心理健康',
  safety: '人身安全',
  scholarship: '奖学金',
  exam: '考试',
  out_of_scope: '超出范围'
}

export const KIND_LABEL = {
  residence_permit: '居留许可',
  visa: '签证',
  medical: '体检医疗',
  exam: '考试',
  scholarship: '奖学金',
  safety: '安全',
  general: '一般通知'
}

export const NOTICE_STATUS = {
  draft: { label: '草稿', color: 'var(--amber)' },
  published: { label: '已发布', color: 'var(--mint)' },
  closed: { label: '已结束', color: 'var(--muted)' }
}

export function normStatus(s) {
  return s === 'confirmed' || s === 'seen' || s === 'help' || s === 'unread' ? s : 'unread'
}

export function errText(e) {
  const m = e && e.message ? String(e.message) : ''
  return m || '出错了，请重试一次'
}

/* api.js 不把 HTTP 状态码抛出来，只能按人话文案判断是不是密钥不对。
   后端 401 的 message 里通常带 key / 密钥 / 未授权 之类的词。 */
export function isAuthError(e) {
  const m = errText(e)
  return /401|403|unauthor|forbidden|key|密钥|授权|口令|counselor/i.test(m)
}

/* ---------- 复制 ---------- */

export async function copyText(text) {
  const s = text === null || text === undefined ? '' : String(text)
  if (!s) return false
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(s)
      return true
    }
  } catch {
    /* 落到下面的 execCommand 兜底 */
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = s
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.top = '-2000px'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.focus()
    ta.select()
    ta.setSelectionRange(0, s.length)
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}

/* ---------- 时间 ---------- */

function pad2(n) {
  return String(n).padStart(2, '0')
}

export function tzOffset(d) {
  const date = d instanceof Date ? d : new Date()
  const mins = -date.getTimezoneOffset()
  const sign = mins >= 0 ? '+' : '-'
  const a = Math.abs(mins)
  return `${sign}${pad2(Math.floor(a / 60))}:${pad2(a % 60)}`
}

export function parseDate(iso) {
  if (!iso) return null
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? null : d
}

/* 11月25日 17:00 */
export function fmtDateTime(iso) {
  const d = parseDate(iso)
  if (!d) return iso ? String(iso) : '—'
  return `${d.getMonth() + 1}月${d.getDate()}日 ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

/* 11-25 17:00 */
export function fmtShort(iso) {
  const d = parseDate(iso)
  if (!d) return '—'
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

/* 17:42 */
export function fmtClock(iso) {
  const d = parseDate(iso)
  if (!d) return '—'
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

/* 3 小时前 */
export function fmtRel(iso) {
  const d = parseDate(iso)
  if (!d) return '—'
  const diff = Date.now() - d.getTime()
  if (diff < 0) return '刚刚'
  const min = Math.floor(diff / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h} 小时前`
  const day = Math.floor(h / 24)
  if (day < 30) return `${day} 天前`
  return fmtShort(iso)
}

/* deadline 剩余小时数，负数表示已过期；无 deadline 返回 null */
export function hoursLeft(iso) {
  const d = parseDate(iso)
  if (!d) return null
  return (d.getTime() - Date.now()) / 3600000
}

export function leftText(iso) {
  const h = hoursLeft(iso)
  if (h === null) return '未设置截止'
  if (h <= 0) return '已过截止时间'
  if (h < 1) return `还剩 ${Math.max(1, Math.round(h * 60))} 分钟`
  if (h < 48) return `还剩 ${Math.floor(h)} 小时`
  return `还剩 ${Math.floor(h / 24)} 天 ${Math.floor(h % 24)} 小时`
}

/* 今天 yyyy-mm-dd（本地时区） */
export function todayInput() {
  const d = new Date()
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

/* date input 的值 → 带偏移的 ISO，固定中午，避开时区把日期推一天 */
export function dateToSentAt(dateStr) {
  const v = String(dateStr || '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return new Date().toISOString()
  return `${v}T12:00:00${tzOffset()}`
}

/* ISO → datetime-local 的 value */
export function toLocalInput(iso) {
  const d = parseDate(iso)
  if (!d) return ''
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(
    d.getMinutes()
  )}`
}

/* datetime-local 的 value → 带偏移的 ISO */
export function fromLocalInput(v) {
  if (!v) return null
  const s = String(v)
  const withSec = s.length === 16 ? `${s}:00` : s
  const d = new Date(s)
  return `${withSec}${tzOffset(Number.isNaN(d.getTime()) ? new Date() : d)}`
}

/* ---------- 结构化字段兜底 ---------- */

function str(v) {
  return v === null || v === undefined ? '' : String(v)
}

function arr(v) {
  return Array.isArray(v) ? v : []
}

export const EMPTY_STRUCTURED = {
  title_zh: '',
  kind: 'general',
  one_line: '',
  who: '',
  what: '',
  actions: [],
  deadline: { raw: '', iso: null, confidence: 'low', basis: '' },
  materials: [],
  place: { raw: '', note: '' },
  consequence: '',
  official_links: [],
  contacts: [],
  risk_flags: [],
  spans: {},
  warnings: []
}

/* 后端可能少字段、给 null、给字符串，一律补成前端能安全渲染的形状 */
export function normalizeStructured(input) {
  const s = input && typeof input === 'object' ? input : {}
  const dl = s.deadline && typeof s.deadline === 'object' ? s.deadline : {}
  const pl = s.place && typeof s.place === 'object' ? s.place : {}
  return {
    title_zh: str(s.title_zh || s.title),
    kind: str(s.kind) || 'general',
    one_line: str(s.one_line),
    who: str(s.who),
    what: str(s.what),
    actions: arr(s.actions)
      .filter((a) => a && typeof a === 'object')
      .map((a, i) => ({
        order: Number(a.order) || i + 1,
        zh: str(a.zh),
        en: str(a.en)
      })),
    deadline: {
      raw: str(dl.raw),
      iso: dl.iso ? str(dl.iso) : null,
      confidence: dl.confidence === 'high' ? 'high' : 'low',
      basis: str(dl.basis)
    },
    materials: arr(s.materials)
      .map((m) => str(m))
      .filter(Boolean),
    place: { raw: str(pl.raw), note: str(pl.note) },
    consequence: str(s.consequence),
    official_links: arr(s.official_links)
      .filter((l) => l && typeof l === 'object')
      .map((l) => ({ label: str(l.label), url: str(l.url) })),
    contacts: arr(s.contacts)
      .filter((c) => c && typeof c === 'object')
      .map((c) => ({ name: str(c.name), phone: str(c.phone), note: str(c.note) })),
    risk_flags: arr(s.risk_flags)
      .map((f) => str(f))
      .filter(Boolean),
    spans: s.spans && typeof s.spans === 'object' ? s.spans : {},
    warnings: arr(s.warnings)
      .map((w) => str(w))
      .filter(Boolean)
  }
}

/* 解析彻底失败时，用原文拼一个最小 structured，保证仍然能建单给人补 */
export function minimalDraft(raw) {
  const text = str(raw).trim()
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  const first = lines[0] || '未命名通知'
  const title = first.length > 90 ? `${first.slice(0, 90)}…` : first
  const flat = text.replace(/\s+/g, ' ').trim()
  return {
    ...EMPTY_STRUCTURED,
    title_zh: title,
    one_line: flat.slice(0, 90) || title,
    what: text.slice(0, 600),
    deadline: { raw: '', iso: null, confidence: 'low', basis: '未解析，待人工填写' },
    warnings: ['AI 解析失败，本通知按原文创建，字段请人工补全后再发布']
  }
}

/* 学生链接：发布后发给班级群的那个地址 */
export function studentLink(id) {
  const origin = typeof location !== 'undefined' && location.origin ? location.origin : ''
  return `${origin}/#/s/${id}`
}

/* 辅导员视角的群发文案（中文，带链接），一键复制到班级群 */
export function groupMessage(s, link) {
  const st = normalizeStructured(s)
  const lines = []
  lines.push(`【${st.title_zh || '通知'}】`)
  if (st.one_line) lines.push(st.one_line)
  lines.push('')
  if (st.deadline.iso || st.deadline.raw) {
    lines.push(`截止时间：${st.deadline.iso ? fmtDateTime(st.deadline.iso) : st.deadline.raw}`)
  }
  if (st.place.raw) lines.push(`地点：${st.place.raw}`)
  if (st.actions.length) {
    lines.push('', '你要做的事：')
    st.actions.forEach((a, i) => {
      if (a.zh) lines.push(`${i + 1}. ${a.zh}`)
    })
  }
  if (st.materials.length) lines.push('', `要带的材料：${st.materials.join('、')}`)
  if (st.consequence) lines.push('', `注意：${st.consequence}`)
  lines.push('', '点开链接，选你的语言，看完点「我已知晓」就算确认：', link || '（先发布，链接才会生成）')
  return lines.join('\n')
}
