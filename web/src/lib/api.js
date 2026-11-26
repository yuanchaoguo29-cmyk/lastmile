/* 全站唯一的数据通道 —— 冻结。页面不要直接 fetch。 */

const KEY = 'lm.counselor_key'
const SID = 'lm.student_id'
const NAME = 'lm.student_name'
const LANG = 'lm.lang'

function ls(key, val) {
  try {
    if (val === undefined) return localStorage.getItem(key)
    localStorage.setItem(key, val)
    return val
  } catch {
    return null
  }
}

export function getCounselorKey() {
  return ls(KEY) || ''
}
export function setCounselorKey(v) {
  if (!v) {
    try {
      localStorage.removeItem(KEY)
    } catch {}
    return
  }
  ls(KEY, v)
}
export function getStudentId() {
  return ls(SID) || ''
}
export function setStudentId(v) {
  ls(SID, v)
}
export function getStudentName() {
  return ls(NAME) || ''
}
export function setStudentName(v) {
  ls(NAME, v)
}
export function getLang() {
  return ls(LANG) || ''
}
export function setLang(v) {
  ls(LANG, v)
}

async function req(path, { method = 'GET', body, counselor = false } = {}) {
  const headers = {}
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (counselor) headers['x-counselor-key'] = getCounselorKey()

  let res
  try {
    res = await fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    })
  } catch (e) {
    throw new Error('连不上服务器，检查后端是否在 3000 端口运行')
  }

  const text = await res.text()
  let data = {}
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      throw new Error('服务器返回了非 JSON 内容：' + text.slice(0, 160))
    }
  }
  if (!res.ok) {
    throw new Error(data?.error?.message || `HTTP ${res.status}`)
  }
  return data
}

/* ---------- 辅导员 ---------- */

export const parseNotice = (raw_text, sent_at) =>
  req('/api/notices/parse', { method: 'POST', body: { raw_text, sent_at }, counselor: true })

export const createNotice = (payload) =>
  req('/api/notices', { method: 'POST', body: payload, counselor: true })

export const listNotices = () => req('/api/notices', { counselor: true })

export const getNotice = (id) => req(`/api/notices/${id}`, { counselor: true })

export const patchNotice = (id, patch) =>
  req(`/api/notices/${id}`, { method: 'PATCH', body: patch, counselor: true })

export const deleteNotice = (id) => req(`/api/notices/${id}`, { method: 'DELETE', counselor: true })

export const translateNotice = (id, langs) =>
  req(`/api/notices/${id}/translate`, { method: 'POST', body: { langs }, counselor: true })

export const getDashboard = (id) => req(`/api/notices/${id}/dashboard`, { counselor: true })

export const buildNudge = (id, payload) =>
  req(`/api/notices/${id}/nudge`, { method: 'POST', body: payload, counselor: true })

export const exportCsvUrl = (id) => `/api/notices/${id}/export.csv?k=${encodeURIComponent(getCounselorKey())}`

export const getRoster = (query) => {
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(query || {})) {
    if (v !== undefined && v !== null && v !== '') q.set(k, String(v))
  }
  const qs = q.toString()
  return req('/api/roster' + (qs ? '?' + qs : ''), { counselor: true })
}

/* 名单体检：只给提示，不改数据 */
export const checkRoster = () => req('/api/roster/check', { method: 'POST', body: {}, counselor: true })

/* ---------- 身份 / 助理账号 ---------- */

export const getMe = () => req('/api/me', { counselor: true })
export const listStaff = () => req('/api/staff', { counselor: true })
export const createStaff = (name) => req('/api/staff', { method: 'POST', body: { name }, counselor: true })
export const updateStaff = (id, patch) =>
  req(`/api/staff/${id}`, { method: 'PATCH', body: patch, counselor: true })
export const deleteStaff = (id) => req(`/api/staff/${id}`, { method: 'DELETE', counselor: true })

/* 自己的发件邮箱 */
export const getMyEmail = () => req('/api/staff/me/email', { counselor: true })
export const setMyEmail = (payload) =>
  req('/api/staff/me/email', { method: 'PUT', body: payload, counselor: true })
export const clearMyEmail = () => req('/api/staff/me/email', { method: 'DELETE', counselor: true })

/* ---------- 花名册 ---------- */

export const importRoster = (rows, mode, keepDemo) =>
  req('/api/roster/import', { method: 'POST', body: { rows, mode, keep_demo: keepDemo }, counselor: true })
export const clearRoster = (keepDemo) =>
  req('/api/roster/clear', { method: 'POST', body: { keep_demo: keepDemo }, counselor: true })
export const restoreDemoRoster = () => req('/api/roster/restore-demo', { method: 'POST', counselor: true })

/* ---------- 设置（密码 / AI 配置）---------- */

export const getSettings = () => req('/api/settings', { counselor: true })

export const updateSettings = (patch) =>
  req('/api/settings', { method: 'PATCH', body: patch, counselor: true })

export const testAiConnection = () => req('/api/settings/test', { method: 'POST', counselor: true })

/** 改访问密码：成功后把本机存的密码换成新的，用户不会掉线 */
export async function changeCounselorKey(current, next) {
  const out = await req('/api/auth/change-key', { method: 'POST', body: { current, next }, counselor: true })
  setCounselorKey(next)
  return out
}

/* ---------- 学生 ---------- */

export const whoAmI = (student_id) =>
  req(`/api/student/me?student_id=${encodeURIComponent(student_id)}`)

export const getStudentNotice = (id, lang, student_id) => {
  const q = new URLSearchParams()
  if (lang) q.set('lang', lang)
  if (student_id) q.set('student_id', student_id)
  return req(`/api/student/notice/${id}?${q.toString()}`)
}

export const markSeen = (id, student_id) =>
  req(`/api/student/notice/${id}/seen`, { method: 'POST', body: { student_id, lang: getLang() } })

export const submitQuiz = (id, choice, student_id) =>
  req(`/api/student/notice/${id}/quiz`, { method: 'POST', body: { choice, student_id } })

export const submitReceipt = (id, payload) =>
  req(`/api/student/notice/${id}/receipt`, { method: 'POST', body: payload })

export const askQuestion = (id, question, lang, student_id) =>
  req(`/api/student/notice/${id}/ask`, { method: 'POST', body: { question, lang, student_id } })

export const health = () => req('/api/health')
