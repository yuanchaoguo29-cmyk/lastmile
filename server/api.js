/* LastMile HTTP 层 —— 归属 A（后端）。
   逐条实现 docs/api.md。AI 全部 try/catch：AI 挂了通知照样能发布、能看板、能催办。 */

import { Router } from 'express'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { randomBytes, createHash } from 'node:crypto'
import QRCode from 'qrcode'
import { nowIso } from './db.js'
import { repo } from './repo.js'
import * as ai from './ai.js'
import { guardAsk } from './guard.js'
import { seedIfEmpty, buildRoster } from './seed.js'
import {
  loadSettingsIntoEnv,
  getSetting,
  setSetting,
  deleteSetting,
  testAi,
  AI_DEFAULTS,
  keyStatus,
  brokenKeyList
} from './settings.js'
import {
  safeEqual,
  secretSource,
  fingerprint,
  encryptSecret,
  decryptSecret,
  hashPassword,
  verifyPassword,
  DEFAULT_STAFF_PASSWORD
} from './crypto.js'
import { parseStudentId } from './student-id.js'
import { sendMail } from './email.js'

/* 兜底补载 .env：正式启动请用 `node --env-file-if-exists=.env server/index.js`。
   万一启动命令漏了 --env-file，这里补一次，保证 AI 与 COUNSELOR_KEY 不是空的。
   只填「当前还没有」的变量，绝不覆盖外部显式传入的值。 */
;(function loadDotEnvFallback() {
  try {
    if (process.env.DEEPSEEK_API_KEY) return
    const here = path.dirname(fileURLToPath(import.meta.url))
    const envPath = path.resolve(here, '..', '.env')
    if (!fs.existsSync(envPath)) return
    let n = 0
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line)
      if (!m) continue
      if (process.env[m[1]] !== undefined) continue
      process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '')
      n++
    }
    if (n) console.log(`[env] 从 .env 补载 ${n} 个变量（建议改用 --env-file-if-exists=.env 启动）`)
  } catch (e) {
    console.error('[env] 读取 .env 失败（忽略）：', e?.message || e)
  }
})()

const VERSION = '0.1.0'
// 与 docs/api.md §1 一致：6 种。zh 是母版，不算「目标语言」
const LANGS = ['zh', 'en', 'ru', 'vi', 'th', 'id']
const TARGET_LANGS = LANGS.filter((l) => l !== 'zh')
const DEFAULT_LANGS = ['en', 'ru', 'vi']

/* =========================================================================
   小工具
   ========================================================================= */

/** 失败统一出口：HTTP 4xx/5xx + {error:{code,message}} */
function fail(res, status, code, message) {
  return res.status(status).json({ error: { code, message } })
}

/** async 路由包装，异常交给 index.js 的统一错误出口（Express 4 不自动 catch） */
const wrap = (fn) => (req, res, next) => {
  try {
    const out = fn(req, res, next)
    if (out && typeof out.catch === 'function') out.catch(next)
  } catch (e) {
    next(e)
  }
}

/* 总管（owner）账号：username 固定 'owner'，密码来自 COUNSELOR_KEY（默认 12345678，见 .env.example），
   后台改密码则落 settings 表。总管不落 staff 表——表里 id='owner' 那行只存他自己的发件邮箱。 */
const DEFAULT_OWNER_KEY = '12345678'
const counselorKey = () => process.env.COUNSELOR_KEY || DEFAULT_OWNER_KEY

/** 带角色的登录态。owner 的 id 固定为 'owner'（不在 staff 表里，除了邮箱那行隐藏配置） */
const OWNER_ID = 'owner'
const OWNER_NAME = '总管'
const OWNER_USERNAME = 'owner'

/* 辅导员/助理账号：账号名由创建者给（允许中文），初始密码一律 DEFAULT_STAFF_PASSWORD(123456)，
   本人登录后自行修改；access_key 列只为兼容旧库保留，不再参与任何登录校验。 */

/* 登录失败限速：同一 IP 5 分钟内错 10 次，锁 5 分钟。
   目的是掐断「爆破辅导员密码 → 进后台替换/试探 API Key」这条路。
   新登录接口 /api/auth/login 与鉴权中间件共用这套计数。 */
const AUTH_WINDOW_MS = 5 * 60 * 1000
const AUTH_MAX_FAILS = 10
const authFails = new Map()

function authBlockRemain(ip) {
  const rec = authFails.get(ip)
  if (!rec) return 0
  const now = Date.now()
  if (rec.until && now < rec.until) return Math.ceil((rec.until - now) / 1000)
  if (now - rec.firstAt > AUTH_WINDOW_MS) {
    authFails.delete(ip)
    return 0
  }
  return 0
}

function authNoteFail(ip) {
  const now = Date.now()
  let rec = authFails.get(ip)
  if (!rec || now - rec.firstAt > AUTH_WINDOW_MS) rec = { n: 0, firstAt: now, until: 0 }
  rec.n += 1
  if (rec.n >= AUTH_MAX_FAILS) rec.until = now + AUTH_WINDOW_MS
  authFails.set(ip, rec)
}

/** 登录态：对外只暴露这五个字段（不带 access_key / pwd_* / 邮箱凭据） */
const sessionOf = (row) => ({
  id: row.id,
  name: row.name,
  role: row.role || 'assistant',
  parent_id: row.parent_id || null,
  username: row.username || null
})

const ownerSession = () => ({
  id: OWNER_ID,
  name: OWNER_NAME,
  role: 'owner',
  parent_id: null,
  username: OWNER_USERNAME
})

/** 账号名 + 密码 → 登录态；失败返回 null。
    不区分「没这个账号」与「密码不对」，避免被用来枚举账号。
    总管：username === 'owner' + 环境变量/设置里的密码；其余：staff 表 + scrypt 校验。 */
function loginCheck(username, password) {
  const user = String(username ?? '').trim()
  const pass = String(password ?? '')
  if (!user || !pass) return null

  if (user.toLowerCase() === OWNER_USERNAME) {
    return safeEqual(pass, counselorKey()) ? ownerSession() : null
  }

  const row = repo.getStaffByUsername(user)
  if (!row || row.role === 'owner' || Number(row.active) !== 1) return null
  if (!row.pwd_hash || !row.pwd_salt) return null
  return verifyPassword(pass, row.pwd_hash, row.pwd_salt) ? sessionOf(row) : null
}

/* 认证缓存：scrypt 单次约 50-80ms，每个请求都跑一遍太重。
   校验通过后缓存 sha256(username \0 password) → 登录态，5 分钟有效；
   只缓存「成功」，改密码/停用/删账号时整表清空（cacheClear）。
   明文密码只在计算缓存键时用一次，不进缓存键、不入日志。 */
const AUTH_CACHE_TTL_MS = 5 * 60 * 1000
const AUTH_CACHE_MAX = 500
const authCache = new Map()

const authCacheKey = (username, password) =>
  createHash('sha256').update(`${username}\u0000${password}`, 'utf8').digest('hex')

function authCacheGet(key) {
  const hit = authCache.get(key)
  if (!hit) return null
  if (hit.exp <= Date.now()) {
    authCache.delete(key)
    return null
  }
  return hit.staff
}

function authCacheSet(key, staff) {
  const now = Date.now()
  if (authCache.size >= AUTH_CACHE_MAX) {
    for (const [k, v] of authCache) if (v.exp <= now) authCache.delete(k)
    while (authCache.size >= AUTH_CACHE_MAX) authCache.delete(authCache.keys().next().value)
  }
  authCache.set(key, { staff, exp: now + AUTH_CACHE_TTL_MS })
}

function authCacheClear() {
  authCache.clear()
}

/** 带缓存的登录校验 */
function loginCheckCached(username, password) {
  const user = String(username ?? '').trim()
  const pass = String(password ?? '')
  if (!user || !pass) return null
  const key = authCacheKey(user, pass)
  const hit = authCacheGet(key)
  if (hit) return { ...hit }
  const staff = loginCheck(user, pass)
  if (staff) authCacheSet(key, staff)
  return staff
}

/** /notices* /roster /staff /me 的鉴权：账号名 + 密码（x-counselor-user + x-counselor-key）。
    通过的请求挂 req.staff = { id, name, role, parent_id, username }，供 scopeOf 与留痕用。
    失败计入限速。旧路径只给 x-counselor-key 时按总管密码处理，保证老前端/老脚本不改也能用。 */
function requireCounselor(req, res, next) {
  const ip = String(req.ip || req.socket?.remoteAddress || '?')
  const remain = authBlockRemain(ip)
  if (remain > 0) {
    res.setHeader('Retry-After', String(remain))
    return fail(res, 429, 'TOO_MANY_ATTEMPTS', `密码错误次数太多，请 ${Math.ceil(remain / 60)} 分钟后再试`)
  }

  // 浏览器不允许 HTTP 头里出现非 ASCII 字节，中文账号名由前端 encodeURIComponent 后放进来 → 这里容错解码。
  // 已经是明文（老脚本 / 纯 ASCII 账号名）时 decodeURIComponent 不改变内容；遇到畸形的 % 就原样用。
  const rawUser = String(req.get('x-counselor-user') || '').trim()
  let user = rawUser
  if (rawUser) {
    try {
      user = decodeURIComponent(rawUser)
    } catch {
      user = rawUser
    }
  }
  const key = String(req.get('x-counselor-key') || '')
  const pathOnly = String(req.originalUrl || '').split('?')[0]
  const queryKey = String(req.query?.k || '')
  const queryUser = String(req.query?.u || '').trim() // 导出链接用（<a href> 发不出请求头）
  const queryAllowed = /\/export\.csv$/i.test(pathOnly)

  let staff = null
  if (user) {
    // 新路径：账号名 + 密码（密码仍在 x-counselor-key 里，只是含义变成「密码」）
    staff = loginCheckCached(user, key)
  } else if (queryAllowed && queryUser) {
    // 导出 CSV：只能走 query，?u= 账号名 & k= 密码（Express 已经对 query 做过一次解码）
    staff = loginCheckCached(queryUser, queryKey)
  } else {
    // 旧路径：只有 x-counselor-key（导出的 ?k= 同理），当作总管密码
    const presented = key || (queryAllowed ? queryKey : '')
    if (presented && safeEqual(presented, counselorKey())) staff = ownerSession()
  }

  if (!staff) {
    authNoteFail(ip)
    return fail(res, 401, 'UNAUTHORIZED', '账号或密码不对')
  }

  authFails.delete(ip)
  req.staff = staff
  if (staff.role !== 'owner') {
    try {
      repo.updateStaff(staff.id, { last_seen_at: nowIso() })
    } catch {}
  }
  return next()
}

/** 数据可见范围：owner → null（全部）；counselor → 自己；assistant → 所属辅导员。
    所有列表/看板/导入/导出都拿它过滤 students.owner_staff_id。 */
export function scopeOf(req) {
  const me = req?.staff
  if (!me) return null
  if (me.role === 'owner') return null
  if (me.role === 'assistant') return me.parent_id || me.id
  return me.id
}

/** 越权一律当「不存在」：只把调用者可见范围内的通知交出去，其余返回 null */
function visibleNotice(req, id) {
  const notice = repo.getNotice(id)
  if (!notice) return null
  const scope = scopeOf(req)
  if (scope !== null && String(notice.owner_staff_id || '') !== String(scope)) return null
  return notice
}

/** 账号管理权限：owner 只管 counselor；counselor 只管 parent_id = 自己的 assistant */
function canManage(req, row) {
  const me = req.staff
  if (!row || row.role === 'owner') return false
  if (me.role === 'owner') return row.role === 'counselor'
  if (me.role === 'counselor') return row.role === 'assistant' && String(row.parent_id || '') === String(me.id)
  return false
}

/** 只有总管能进：设置、改密码（账号管理另有更细的按角色权限） */
function requireOwner(req, res, next) {
  if (req.staff?.role !== 'owner') {
    return fail(res, 403, 'FORBIDDEN', '只有总管（owner）能改这里，辅导员与助理账号没有权限。')
  }
  next()
}

/** 对外地址：给了 PUBLIC_BASE_URL 就用它（cpolar 这类地址每次变，配一行就不用改代码） */
function publicBase(req) {
  const fixed = str(process.env.PUBLIC_BASE_URL).trim().replace(/\/+$/, '')
  if (fixed) return fixed
  return `${req.protocol}://${req.get('host')}`
}

/** ISO → 毫秒；解析不出返回 null */
function toMs(iso) {
  if (!iso) return null
  const t = Date.parse(String(iso))
  return Number.isFinite(t) ? t : null
}

/** 距截止还有多少小时（四舍五入，可能为负） */
function hoursLeft(iso) {
  const t = toMs(iso)
  if (t === null) return null
  return Math.round((t - Date.now()) / 3600000)
}

/** 从回执行推四态：confirmed | help | seen | unread（顺序即优先级） */
function statusOf(receipt) {
  if (!receipt) return 'unread'
  if (receipt.confirmed_at) return 'confirmed'
  if (receipt.help_at) return 'help'
  if (receipt.first_seen_at) return 'seen'
  return 'unread'
}

/** 学生端可披露的 quiz：只给题面与选项，answer_index / explain / source_span 一律剥掉 */
function publicQuiz(quiz) {
  if (!quiz || typeof quiz !== 'object') return null
  const options = Array.isArray(quiz.options) ? quiz.options.map((o) => String(o)) : []
  if (!options.length) return null
  return {
    question: String(quiz.question || ''),
    options,
    total: options.length
  }
}

/** 学生端隐藏字段兜底：任何响应出门前再扫一遍，命中就删掉并报警，绝不让答案漏出去 */
function assertNoAnswer(payload) {
  const HIDDEN = new Set(['answer_index', 'explain', 'source_span'])
  const scrub = (v, path = '') => {
    if (!v || typeof v !== 'object') return
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) scrub(v[i], `${path}[${i}]`)
      return
    }
    for (const k of Object.keys(v)) {
      if (HIDDEN.has(k)) {
        console.error('[api] 学生端响应里出现了不该出现的字段，已删除：', `${path}.${k}`)
        delete v[k]
        continue
      }
      scrub(v[k], `${path}.${k}`)
    }
  }
  scrub(payload, '')
  return payload
}

const str = (v) => (v === null || v === undefined ? '' : String(v))

/** 花名册字段的确定性校验规则（/api/roster/check 用，不调模型） */
const DEGREES = ['本科', '硕士', '博士']
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/
const GRADE_RE = /^20\d{2}级$/

/* =========================================================================
   语言视图：把 StructuredNotice + Translation 压成学生卡片要的字段
   ========================================================================= */

/** 按 lang 取翻译；取不到回退 en，再取不到回退中文 structured */
function resolveLang(notice, wanted) {
  const tr = notice.translations && typeof notice.translations === 'object' ? notice.translations : {}
  const available = ['zh', ...Object.keys(tr).filter((k) => tr[k])]
  const ask = str(wanted).trim().toLowerCase()
  if (ask === 'zh' || available.includes(ask)) {
    return { lang: ask === 'zh' ? 'zh' : ask, available }
  }
  if (available.includes('en')) return { lang: 'en', available }
  return { lang: 'zh', available }
}

/** 某一语言的卡片正文（zh 直接用 structured，其它语言用 translations[lang]） */
function localizedView(notice, lang) {
  const s = notice.structured || {}
  const tr =
    notice.translations && typeof notice.translations === 'object' ? notice.translations[lang] : null
  const zhDeadline = s?.deadline?.raw || ''
  const zhPlace = typeof s.place === 'object' && s.place ? s.place.raw || '' : str(s.place)
  const zhActions = Array.isArray(s.actions) ? s.actions : []
  const zhQuiz = notice.quiz || null

  if (!tr || lang === 'zh') {
    return {
      title: str(s.title_zh),
      one_line: str(s.one_line),
      what: str(s.what),
      who: str(s.who),
      actions: zhActions.map((a, i) => ({ order: Number(a.order) || i + 1, text: str(a.zh || a.text) })),
      deadline_text: zhDeadline,
      place_text: zhPlace,
      materials: (Array.isArray(s.materials) ? s.materials : []).map(str),
      consequence: str(s.consequence),
      quiz: zhQuiz
    }
  }
  return {
    title: str(tr.title || s.title_zh),
    one_line: str(tr.one_line || s.one_line),
    what: str(tr.what || s.what),
    who: str(tr.who || s.who),
    actions: (Array.isArray(tr.actions) ? tr.actions : []).map((a, i) => ({
      order: Number(a.order) || i + 1,
      text: str(a.text || a.en || a.zh)
    })),
    deadline_text: str(tr.deadline_text || zhDeadline),
    place_text: str(tr.place_text || zhPlace),
    materials: (Array.isArray(tr.materials) ? tr.materials : s.materials || []).map(str),
    consequence: str(tr.consequence || s.consequence),
    quiz: tr.quiz && Array.isArray(tr.quiz.options) && tr.quiz.options.length ? tr.quiz : zhQuiz
  }
}

/* =========================================================================
   AI 降级：正则兜底解析（AI 挂了也不许 500）
   ========================================================================= */

function pad2(n) {
  return String(n).padStart(2, '0')
}

/** 从正文里捞「X月X日 + 时:分」，优先带「前 / 截止」的那一个 */
function extractDeadline(raw, sentAtIso) {
  const sent = toMs(sentAtIso)
  const year = sent !== null ? new Date(sent).getFullYear() : new Date().getFullYear()

  const candidates = []
  const covered = []

  // 第一遍：年月日 + 时:分
  const reDT = /(?:(\d{4})\s*年\s*)?(\d{1,2})\s*月\s*(\d{1,2})\s*日([^\n。；;]{0,20}?)(\d{1,2})\s*[:：]\s*(\d{2})/g
  let m
  while ((m = reDT.exec(raw))) {
    const [, y, mo, d, , hh, mm] = m
    candidates.push({
      start: m.index,
      end: m.index + m[0].length,
      y: y ? Number(y) : year,
      mo: Number(mo),
      d: Number(d),
      hh: Number(hh),
      mm: Number(mm),
      hasTime: true,
      text: m[0]
    })
    covered.push([m.index, m.index + m[0].length])
  }

  // 第二遍：只有日期（跳过已被第一遍覆盖的位置）
  const reD = /(?:(\d{4})\s*年\s*)?(\d{1,2})\s*月\s*(\d{1,2})\s*日/g
  while ((m = reD.exec(raw))) {
    const start = m.index
    const end = start + m[0].length
    if (covered.some(([a, b]) => start < b && end > a)) continue
    const [, y, mo, d] = m
    candidates.push({
      start,
      end,
      y: y ? Number(y) : year,
      mo: Number(mo),
      d: Number(d),
      hh: 17, // 原文没写时刻，按当日 17:00 估算（会在 warnings 里标出来）
      mm: 0,
      hasTime: false,
      text: m[0]
    })
  }

  if (!candidates.length) return null

  for (const c of candidates) {
    const after = raw.slice(c.end, c.end + 12)
    c.hasBefore = /前|截止|之前/.test(after)
    c.ms = Date.parse(`${c.y}-${pad2(c.mo)}-${pad2(c.d)}T${pad2(c.hh)}:${pad2(c.mm)}:00+08:00`)
  }

  const rank = (c) => (c.hasBefore ? 0 : c.hasTime ? 1 : 2)
  candidates.sort((a, b) => rank(a) - rank(b) || (a.ms || 0) - (b.ms || 0))
  const pick = candidates[0]
  if (!Number.isFinite(pick.ms)) return null

  return {
    raw: pick.text.trim(),
    iso: `${pick.y}-${pad2(pick.mo)}-${pad2(pick.d)}T${pad2(pick.hh)}:${pad2(pick.mm)}:00+08:00`,
    confidence: pick.hasTime ? 'high' : 'low',
    basis: pick.hasTime ? '正则兜底：原文含绝对日期 + 时刻' : '正则兜底：只有日期，时刻按当日 17:00 估算',
    span: pick.text
  }
}

function extractPlace(raw, lines) {
  const cut = (s) =>
    str(s)
      .replace(/^[^：:]*[：:]/, '')
      .split(/[，,。]/)[0]
      .trim()

  // 优先「地点：」「地址：」
  for (const line of lines) {
    if (/地点\s*[：:]|地址\s*[：:]/.test(line)) {
      const v = cut(line)
      if (v) return { raw: v, note: '', span: v }
    }
  }
  // 退一步：正文里第一个带「楼/办公室/教室/中心/馆」的短语
  const m = raw.match(/([\u4e00-\u9fa5A-Za-z0-9（）()]{2,40}(?:楼|办公室|教室|中心|馆)[^\n，,。；;]{0,20})/)
  if (m) return { raw: m[1].trim(), note: '', span: m[1].trim() }
  return { raw: '', note: '', span: '' }
}

function extractMaterials(lines) {
  const start = lines.findIndex((l) => /所需材料|须携带|携带材料|需要携带/.test(l))
  if (start < 0) return { list: [], span: [] }
  // 「两证缺一不得入场」「逾期不予受理」这类是要求，不是要带的材料
  const NOT_MATERIAL = /不得|缺一|不予受理|严禁|否则|逾期|请提|须本人|不接受/
  const push = (list, piece) => {
    let t = piece.replace(/^[\s\d.、）)（(]+/, '').trim()
    t = t.replace(/[。；;\s]+$/, '').trim()
    if (t.length < 2 || NOT_MATERIAL.test(t)) return
    // 没有括号的「学生证、护照」拆成两条；带括号的（照片页、签证页…）保持完整
    if (!/[（(]/.test(t) && t.includes('、')) {
      for (const sub of t.split('、')) {
        const s2 = sub.trim()
        if (s2.length > 1 && !NOT_MATERIAL.test(s2)) list.push(s2)
      }
      return
    }
    list.push(t)
  }

  const list = []
  for (let i = start; i < lines.length && list.length < 10; i++) {
    const line = lines[i]
    if (i > start && /^[一二三四五六七八九十]+、/.test(line)) break // 到下一节就停
    const body = i === start ? line.replace(/^[^：:]*[：:]/, '') : line
    for (const piece of body.split(/[；;]/)) push(list, piece)
  }
  return { list, span: list.slice() }
}

function extractContacts(raw, lines) {
  const out = []
  // 「张老师」「李主任」这类称呼；前面必须是一个边界，避免把「联系人的张老师」整段吞掉
  const NAME_RE = /(?:^|[：:，,、\s（(])([\u4e00-\u9fa5]{1,2}(?:老师|主任|辅导员))/
  const PHONE_RE = /((?:0\d{2,3}-)?\d{7,8}|1[3-9]\d{9})/
  const pickFrom = (text) => {
    for (const piece of text.split(/[；;]/)) {
      const nameM = piece.match(NAME_RE)
      const phoneM = piece.match(PHONE_RE)
      if (nameM || phoneM) {
        out.push({ name: nameM ? nameM[1] : '', phone: phoneM ? phoneM[1] : '', note: '' })
      }
    }
  }
  for (const line of lines) if (/联系人|咨询电话|联系/.test(line)) pickFrom(line)
  if (!out.length) {
    const m = raw.match(/[\u4e00-\u9fa5]{1,2}(?:老师|主任|辅导员)/g)
    if (m) for (const n of m.slice(0, 3)) out.push({ name: n, phone: '', note: '' })
  }
  // 去重
  const seen = new Set()
  return out.filter((c) => {
    const k = `${c.name}|${c.phone}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

function extractConsequence(raw) {
  const sentences = raw.split(/[\n。]/).map((s) => s.trim()).filter(Boolean)
  const hit = sentences.find((s) => /逾期|后果自负|不得入场|不予受理|非法居留/.test(s))
  return hit ? `${hit}。` : ''
}

function guessKind(raw) {
  if (/居留许可|居留/.test(raw)) return 'residence_permit'
  if (/签证|visa/i.test(raw)) return 'visa'
  if (/体检|医院|健康证明|疫苗|防疫/.test(raw)) return 'medical'
  if (/考试|缓考|成绩|重修/.test(raw)) return 'exam'
  if (/奖学金|助学金|资助/.test(raw)) return 'scholarship'
  if (/安全|消防|诈骗|报警|心理/.test(raw)) return 'safety'
  return 'general'
}

const KIND_VERB = {
  residence_permit: '办理居留许可延期',
  visa: '办理签证相关手续',
  medical: '参加体检',
  exam: '参加考试',
  scholarship: '提交奖学金申请材料',
  safety: '参加安全相关安排',
  general: '按通知要求办理'
}

/** AI 解析失败时的兜底 StructuredNotice：形状与 docs/api.md §2.1 完全一致 */
/* 标题兜底：模型常抽不到标题，退回原文首行就会变成「🎃各位同学：」这种称呼行，
   列表卡片第一眼就像坏了。这类行不像标题，用「一句话结论」的前半句回填。 */
function polishTitle(structured) {
  if (!structured || typeof structured !== 'object') return structured
  const t = str(structured.title_zh).trim()
  const isSalutation =
    !t || /[：:]\s*$/.test(t) || /^(各位|亲爱的|同学|老师们|大家好|全体)/.test(t) || /^\p{Extended_Pictographic}/u.test(t)
  if (!isSalutation) return structured

  const one = str(structured.one_line).trim()
  if (!one) return structured

  const head = one.split(/[，,。；;！!？?]/)[0].trim().slice(0, 28)
  if (!head || head === t) return structured

  structured.title_zh = head
  return structured
}

function naiveDraft(rawText, sentAtIso) {
  const raw = str(rawText)
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)

  const title = lines[0] || '未命名通知'
  const kind = guessKind(raw)
  const deadline = extractDeadline(raw, sentAtIso)
  const place = extractPlace(raw, lines)
  const materials = extractMaterials(lines)
  const contacts = extractContacts(raw, lines)
  const consequence = extractConsequence(raw)

  const riskFlags = []
  if (['residence_permit', 'visa', 'medical', 'safety'].includes(kind)) riskFlags.push(kind)
  if (/心理|抑郁|精神/.test(raw) && !riskFlags.includes('mental')) riskFlags.push('mental')

  const actions = []
  if (materials.list.length) {
    actions.push({
      order: actions.length + 1,
      zh: `备齐材料：${materials.list.join('、')}`,
      en: 'Prepare the required documents listed in this notice.'
    })
  }
  if (deadline || place.raw) {
    actions.push({
      order: actions.length + 1,
      zh: `${deadline ? deadline.raw + '前' : ''}${place.raw ? '到' + place.raw : ''}${KIND_VERB[kind] || '按通知办理'}`,
      en: `${deadline ? 'Before the deadline, ' : ''}go to the place stated in the notice and follow the instructions.`
    })
  }
  if (contacts.length) {
    actions.push({
      order: actions.length + 1,
      zh: `有问题联系 ${contacts.map((c) => `${c.name || ''}${c.phone ? ' ' + c.phone : ''}`).join('、')}`,
      en: 'If you have questions, contact the person listed in the notice.'
    })
  }
  if (!actions.length) {
    actions.push({
      order: 1,
      zh: '仔细阅读原文，按通知要求完成',
      en: 'Read the original notice and follow the instructions.'
    })
  }

  const deadlineText = deadline ? deadline.raw : ''
  const oneLine = [
    deadlineText ? `${deadlineText}前` : '',
    place.raw ? `到${place.raw}` : '',
    KIND_VERB[kind] || '按通知要求办理'
  ]
    .filter(Boolean)
    .join('，')

  const warnings = ['AI 解析失败，请人工补充']
  if (!deadline) warnings.push('没抓到截止时间，请手工填写 deadline（否则卡片不显示倒计时）')
  else if (deadline.confidence === 'low') warnings.push('截止时间由正则兜底抽取且缺具体时刻，请核对')

  return {
    title_zh: title,
    kind,
    one_line: oneLine,
    who: (lines.find((l) => /全体|各位|同学|学生/.test(l)) || '').replace(/[：:].*$/, '').slice(0, 60),
    what: lines.slice(1, 4).join(' ').slice(0, 300),
    actions,
    deadline: deadline
      ? { raw: deadline.raw, iso: deadline.iso, confidence: deadline.confidence, basis: deadline.basis }
      : { raw: '', iso: null, confidence: 'low', basis: '正文未给出可识别的截止时间' },
    materials: materials.list,
    place: { raw: place.raw, note: '' },
    consequence,
    official_links: [],
    contacts,
    risk_flags: riskFlags,
    spans: {
      deadline: deadline ? deadline.span : '',
      place: place.span || place.raw,
      actions: materials.span.slice(0, 4)
    },
    warnings
  }
}

/** 由 actions 生成兜底单选题（AI 也生成不出 quiz 时用） */
function fallbackQuizFromActions(structured) {
  const actions = Array.isArray(structured?.actions) ? structured.actions : []
  const first = str(actions[0]?.zh || actions[0]?.text) || '按通知要求完成'
  const deadlineRaw = str(structured?.deadline?.raw)
  const right = `${deadlineRaw ? deadlineRaw + '前' : ''}${first}`
  const options = [
    right,
    '在宿舍等老师上门通知，不用自己办',
    '把材料交给同学代交，本人不用去',
    '先不管，等有人催了再处理'
  ].filter((v, i, arr) => arr.indexOf(v) === i)

  return {
    question: '这份通知要求你做什么？什么时候截止？',
    options,
    answer_index: 0,
    source_span: str(structured?.spans?.deadline) || deadlineRaw,
    explain: right
  }
}

/* =========================================================================
   路由
   ========================================================================= */

export function createApiRouter() {
  const r = Router()

  // 契约要求总管密码默认 12345678；settings.js 里还写着老的 123456 兜底，
  // 所以先在这里落好默认值，再让它把 .env / 环境变量 / 数据库里配置灌回来（真实配置优先）。
  if (!process.env.COUNSELOR_KEY) process.env.COUNSELOR_KEY = DEFAULT_OWNER_KEY

  // 界面里改过的配置（密码 / AI）会写进 settings 表，这里先灌回 env，再谈别的
  try {
    loadSettingsIntoEnv()
  } catch (e) {
    console.error('[settings] 载入失败（继续用 env）：', e?.message || e)
  }

  // 首次启动就有数据：读 /notices、/roster、学生卡片都不空
  try {
    const seeded = seedIfEmpty()
    if (seeded?.seeded) {
      console.log(
        `[seed] 首次启动灌入种子数据：通知 ${seeded.notices} 份 / 名单 ${seeded.students} 人 / 演示回执 ${seeded.receipts} 条`
      )
    }
  } catch (e) {
    console.error('[seed] 种子数据写入失败（服务继续）：', e?.message || e)
  }

  /* ---------------- 公开：健康检查 / 二维码 ---------------- */

  r.get(
    '/health',
    wrap((req, res) => {
      let notices = null
      let students = null
      try {
        notices = repo.listNotices().length
        students = repo.listStudents().length
      } catch (e) {
        console.error('[health]', e?.message || e)
      }
      res.json({
        ok: true,
        db: 'sqlite',
        ai: process.env.DEEPSEEK_API_KEY ? 'configured' : 'missing',
        version: VERSION,
        notices,
        students,
        langs: LANGS
      })
    })
  )

  r.get(
    '/qr',
    wrap(async (req, res) => {
      const url = str(req.query.url).trim()
      if (!url) return fail(res, 400, 'INVALID_BODY', '缺少 url 参数')
      const png = await QRCode.toBuffer(url, {
        type: 'png',
        width: Math.min(Math.max(Number(req.query.size) || 480, 120), 1600),
        margin: 1,
        errorCorrectionLevel: 'M'
      })
      res.type('image/png').setHeader('Cache-Control', 'no-store')
      res.send(png)
    })
  )

  /* ---------------- 辅导员接口（x-counselor-key 保护） ---------------- */

  r.use('/notices', requireCounselor)
  r.use('/roster', requireCounselor)
  r.use('/me', requireCounselor)
  r.use('/settings', requireCounselor, requireOwner)
  // /auth 不再整体挂鉴权：/auth/login 必须公开；/auth/change-key 在路由上单独挂 requireCounselor + requireOwner
  r.use('/staff', requireCounselor)

  /* ---------------- 设置：访问密码 / AI 配置（改完立即生效，不用重启） ---------------- */

  const settingsView = () => {
    const st = keyStatus()
    return {
      counselor_key_custom: Boolean(getSetting('counselor_key')),
      ai: {
        ...st,
        base_url: process.env.DEEPSEEK_BASE_URL || AI_DEFAULTS.base_url,
        model: process.env.DEEPSEEK_MODEL || AI_DEFAULTS.model
      },
      security: {
        encryption: 'AES-256-GCM',
        secret_source: secretSource(), // env | file | none
        broken: brokenKeyList()
      },
      defaults: { base_url: AI_DEFAULTS.base_url, model: AI_DEFAULTS.model }
    }
  }

  /** 敏感操作留痕：只记动作、操作人、指纹，不记明文 */
  const audit = (req, action, extra = {}) => {
    try {
      repo.addEvent(null, null, 'settings', {
        action,
        staff_id: req.staff?.id || null,
        staff_name: req.staff?.name || null,
        ...extra
      })
    } catch (e) {
      console.error('[audit] 记录失败：', e?.message || e)
    }
  }

  r.get(
    '/settings',
    wrap((req, res) => res.json(settingsView()))
  )

  r.patch(
    '/settings',
    wrap((req, res) => {
      const body = req.body || {}

      if ('api_key' in body) {
        const v = str(body.api_key).trim()
        if (!v) {
          deleteSetting('deepseek_api_key')
          audit(req, 'api_key_cleared')
          console.log('[settings] API Key 已清空')
        } else {
          setSetting('deepseek_api_key', v) // 落库前自动 AES-256-GCM 加密
          audit(req, 'api_key_updated', { fingerprint: fingerprint(v), length: v.length })
          console.log(`[settings] API Key 已更新（指纹 ${fingerprint(v)}，密文存储）`)
        }
      }

      if ('base_url' in body) {
        const v = str(body.base_url).trim().replace(/\/+$/, '')
        if (!v) {
          deleteSetting('deepseek_base_url')
          process.env.DEEPSEEK_BASE_URL = AI_DEFAULTS.base_url
        } else {
          setSetting('deepseek_base_url', v)
        }
      }

      if ('model' in body) {
        const v = str(body.model).trim()
        if (!v) {
          deleteSetting('deepseek_model')
          process.env.DEEPSEEK_MODEL = AI_DEFAULTS.model
        } else {
          setSetting('deepseek_model', v)
        }
      }

      res.json({ ok: true, ...settingsView() })
    })
  )

  r.post(
    '/settings/test',
    wrap(async (req, res) => res.json(await testAi()))
  )

  /* ---------------- 登录：账号名 + 密码（唯一的公开写接口） ---------------- */

  /** 登录成功后前端把 username 放进 x-counselor-user、password 放进 x-counselor-key。
      这里和鉴权中间件吃同一套限速计数：错 10 次锁 5 分钟。 */
  r.post(
    '/auth/login',
    wrap((req, res) => {
      const ip = String(req.ip || req.socket?.remoteAddress || '?')
      const remain = authBlockRemain(ip)
      if (remain > 0) {
        res.setHeader('Retry-After', String(remain))
        return fail(res, 429, 'TOO_MANY_ATTEMPTS', `密码错误次数太多，请 ${Math.ceil(remain / 60)} 分钟后再试`)
      }

      const username = str(req.body?.username).trim()
      const password = String(req.body?.password ?? '')
      if (!username || !password) {
        return fail(res, 400, 'INVALID_BODY', '账号名和密码都要填')
      }

      const staff = loginCheckCached(username, password)
      if (!staff) {
        authNoteFail(ip)
        return fail(res, 401, 'UNAUTHORIZED', '账号或密码不对')
      }

      authFails.delete(ip)
      if (staff.role !== 'owner') {
        try {
          repo.updateStaff(staff.id, { last_seen_at: nowIso() })
        } catch {}
      }
      console.log(`[auth] ${staff.username}（${staff.role}）登录成功`)
      res.json({ ok: true, staff })
    })
  )

  /** 总管改自己的密码（只有 owner 能进；staff 账号的密码由账号管理重置） */
  r.post(
    '/auth/change-key',
    requireCounselor,
    requireOwner,
    wrap((req, res) => {
      const cur = String(req.body?.current ?? '')
      const next = String(req.body?.next ?? '').trim()
      if (!safeEqual(cur, counselorKey())) return fail(res, 401, 'UNAUTHORIZED', '访问密码不对，请重新输入。')
      if (next.length < 6) return fail(res, 400, 'WEAK_KEY', '新密码至少 6 位')
      setSetting('counselor_key', next)
      authCacheClear() // 缓存里还留着旧密码的那条，清掉
      console.log('[settings] 访问密码已更新')
      res.json({ ok: true })
    })
  )

  /* ---------------- 我是谁（前端据此决定能看到哪些入口） ---------------- */

  /** 邮箱脱敏：zhangsan@example.com → z***@example.com（对外只给这个） */
  const maskEmail = (addr) => {
    const s = str(addr).trim()
    const at = s.lastIndexOf('@')
    if (at <= 0) return s ? '••••' : ''
    return `${s.slice(0, 1)}***${s.slice(at)}`
  }

  /** staff 表里 id='owner' 的隐藏行：只存总管自己的发件邮箱，不参与账号列表 */
  const ownerEmailRow = () => repo.getStaff(OWNER_ID)

  /** 配邮箱时按需建这行；username/pwd_* 都留空，所以它不是登录账号（owner 只走环境变量密码） */
  const ensureEmailRow = (staff) => {
    if (staff.role !== 'owner') return repo.getStaff(staff.id)
    const existed = ownerEmailRow()
    if (existed) return existed
    return repo.createStaff({
      id: OWNER_ID,
      name: OWNER_NAME,
      role: 'owner',
      parent_id: null
    })
  }

  /** SMTP 用户名脱敏：notice@x.edu.cn → n***@x.edu.cn；非邮箱形态只留首字 */
  const maskUser = (name) => {
    const s = str(name).trim()
    if (!s) return ''
    const at = s.lastIndexOf('@')
    if (at > 0) return `${s.slice(0, 1)}***${s.slice(at)}`
    return `${s.slice(0, 1)}***`
  }

  /* 发件凭据统一放在 staff.email_api_key 里（v1. 密文），明文是一段 JSON：
   * { host, port, secure, user, pass, resendKey }
   *  - smtp   → 用 host/port/secure/user/pass，resendKey 为 null；
   *  - resend → 用 resendKey，其余字段为 null。
   * 老库的 email_api_key 直接存的是 Resend API Key（不是 JSON），这里兼容读出。 */
  const mailConfigOf = (row) => {
    const empty = { host: '', port: null, secure: false, user: '', pass: '', resendKey: '' }
    const plain = decryptSecret(row?.email_api_key)
    if (!plain) return empty
    try {
      const obj = JSON.parse(plain)
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        const port = Number(obj.port) > 0 ? Math.round(Number(obj.port)) : null
        return {
          host: str(obj.host).trim(),
          port,
          secure: port === 465 || obj.secure === true,
          user: str(obj.user).trim(),
          pass: String(obj.pass ?? ''),
          resendKey: str(obj.resendKey).trim()
        }
      }
    } catch {}
    // 老库：裸的 Resend API Key
    return { ...empty, resendKey: String(plain).trim() }
  }

  /** SMTP 对外视图：只给主机 / 端口 / 加密方式 / 掩码用户名，永远不含密码 */
  const smtpView = (cfg) =>
    cfg && cfg.host
      ? {
          host: cfg.host,
          port: cfg.port,
          secure: Boolean(cfg.secure),
          user_masked: maskUser(cfg.user)
        }
      : null

  /** 发件邮箱视图：没绑定时什么都不透露；配了但凭据解不出来时 broke=true（让上层给准确提示） */
  const emailView = (row) => {
    const address = str(row?.email).trim()
    const provider = str(row?.email_provider).trim().toLowerCase()
    const known = provider === 'smtp' || provider === 'resend'
    const cfg = known && address ? mailConfigOf(row) : null
    const usable = Boolean(cfg) && (provider === 'smtp' ? Boolean(cfg.host) : Boolean(cfg.resendKey))
    const bound = Boolean(address) && known && usable
    const from = str(row?.email_from).trim()
    return {
      bound,
      address: bound ? maskEmail(address) : '',
      address_masked: bound ? maskEmail(address) : '',
      provider: bound ? provider : null,
      from: from || (bound ? address : ''),
      smtp: bound && provider === 'smtp' ? smtpView(cfg) : null,
      broke: Boolean(address) && known && !usable
    }
  }

  r.get(
    '/me',
    wrap((req, res) => {
      const me = req.staff
      const row = me.role === 'owner' ? ownerEmailRow() : repo.getStaff(me.id)
      const mail = emailView(row)
      res.json({
        id: me.id,
        name: me.name,
        username: me.username || (me.role === 'owner' ? OWNER_USERNAME : null),
        role: me.role,
        parent_id: me.parent_id || null,
        // 调用者能创建哪种账号：owner → counselor，counselor → assistant，assistant → 无
        can_create: me.role === 'owner' ? 'counselor' : me.role === 'counselor' ? 'assistant' : null,
        email: { bound: mail.bound, address: mail.address_masked, provider: mail.provider },
        is_owner: me.role === 'owner'
      })
    })
  )

  /* ---------------- 账号管理：owner 管辅导员，辅导员管自己的助理 ---------------- */

  /* 账号密码不再由服务端随机生成（一次性明文口令已取消）：
     新建/重置统一用 DEFAULT_STAFF_PASSWORD，创建者可提示本人登录后自行修改。 */

  /** 账号对外视图：永远不含 access_key 明文、密码派生值与邮箱凭据 */
  const memberView = (s, assistantCount = 0) => ({
    id: s.id,
    name: s.name,
    username: s.username || null,
    role: s.role,
    active: Number(s.active) === 1,
    created_at: s.created_at,
    last_seen_at: s.last_seen_at,
    // 旧前端的「密码」一列：只给固定掩码（密码已经存在库里，但永远不回明文）
    key_masked: '••••••',
    parent_id: s.parent_id || null,
    assistant_count: Number(assistantCount) || 0
  })

  /** 账号名规则：允许中文与空格（姓名兜底时会有），只去掉控制字符、限长 32；'owner' 是总管保留名 */
  const cleanUsername = (raw) =>
    String(raw ?? '')
      .trim()
      .replace(/[\u0000-\u001f\u007f]/g, '')

  const usernameProblem = (username) => {
    if (!username) return '给账号起个账号名（登录用，可以中文）'
    if (username.length > 32) return '账号名太长了（最多 32 个字）'
    if (username.toLowerCase() === OWNER_USERNAME) return '「owner」是总管保留的账号名'
    return null
  }

  r.get(
    '/staff',
    wrap((req, res) => {
      const me = req.staff
      if (me.role === 'assistant') {
        return fail(res, 403, 'FORBIDDEN', '助理账号没有账号管理权限。')
      }
      const all = repo.listStaff().filter((s) => s.role !== 'owner')
      const members =
        me.role === 'owner'
          ? all.filter((s) => s.role === 'counselor')
          : all.filter(
              (s) => s.role === 'assistant' && String(s.parent_id || '') === String(me.id)
            )
      const views = members.map((s) =>
        memberView(s, all.filter((x) => String(x.parent_id || '') === String(s.id)).length)
      )
      // members 是契约字段；staff 是旧前端的别名，避免老页面白屏
      res.json({ members: views, staff: views, owner: { name: OWNER_NAME } })
    })
  )

  r.post(
    '/staff',
    wrap((req, res) => {
      const me = req.staff
      if (me.role === 'assistant') {
        return fail(res, 403, 'FORBIDDEN', '助理账号不能创建账号。')
      }
      const name = str(req.body?.name).trim()
      if (!name) return fail(res, 400, 'INVALID_BODY', '给账号起个名字')
      if (name.length > 24) return fail(res, 400, 'INVALID_BODY', '名字太长了')

      // 账号名由调用者给（允许中文，如「王辅导员」）；老前端只传 name，就拿姓名当账号名
      const username = cleanUsername(req.body?.username) || name
      const bad = usernameProblem(username)
      if (bad) return fail(res, 400, 'INVALID_BODY', bad)
      if (repo.getStaffByUsername(username)) {
        return fail(res, 400, 'USERNAME_TAKEN', `账号名「${username}」已经被用了，换一个`)
      }

      // 角色由调用者决定：总管建辅导员（parent_id = NULL），辅导员建自己的助理
      const role = me.role === 'owner' ? 'counselor' : 'assistant'
      // 密码不发给调用者指定：一律默认 123456，由本人登录后自行修改
      const { hash, salt } = hashPassword(DEFAULT_STAFF_PASSWORD)
      let row
      try {
        row = repo.createStaff({
          name,
          username,
          pwd_hash: hash,
          pwd_salt: salt,
          role,
          parent_id: role === 'assistant' ? me.id : null
        })
      } catch (e) {
        // 并发建同名账号时靠 username 的唯一索引兜底
        if (/UNIQUE/i.test(String(e?.message || ''))) {
          return fail(res, 400, 'USERNAME_TAKEN', `账号名「${username}」已经被用了，换一个`)
        }
        throw e
      }

      console.log(
        `[staff] ${me.name} 创建了${role === 'counselor' ? '辅导员' : '助理'}「${name}」（账号 ${username}，初始密码为默认值）`
      )
      const view = memberView(row, 0)
      res.json({
        ok: true,
        member: view,
        staff: view, // 旧前端的别名
        username: row.username,
        // 初始密码就是固定默认值；不再由服务端生成一次性口令
        default_password: DEFAULT_STAFF_PASSWORD,
        access_key: DEFAULT_STAFF_PASSWORD, // 旧前端字段别名（值＝默认密码，不是口令凭据）
        hint: `账号 ${row.username} 的初始密码是 ${DEFAULT_STAFF_PASSWORD}，请提醒本人登录后自行修改`
      })
    })
  )

  r.patch(
    '/staff/:id',
    wrap((req, res) => {
      const me = req.staff
      const row = repo.getStaff(req.params.id)
      if (!row || row.role === 'owner') return fail(res, 404, 'NOT_FOUND', '没有这个账号')
      if (!canManage(req, row)) {
        return fail(res, 403, 'FORBIDDEN', '这个账号不在你的管理范围里。')
      }

      const patch = {}
      if (req.body?.name !== undefined) {
        const name = str(req.body.name).trim()
        if (!name) return fail(res, 400, 'INVALID_BODY', '名字不能为空')
        if (name.length > 24) return fail(res, 400, 'INVALID_BODY', '名字太长了')
        patch.name = name
      }
      if (req.body?.active !== undefined) {
        const active = Boolean(req.body.active)
        if (!active && String(row.id) === String(me.id)) {
          return fail(res, 403, 'FORBIDDEN', '不能停用自己的账号。')
        }
        patch.active = active
      }

      // 重置密码：只有「恢复成默认 123456」这一种（旧字段 regenerate 是同一个意思，保留兼容）
      const resetPassword = Boolean(req.body?.regenerate || req.body?.reset_password)
      if (resetPassword) {
        const { hash, salt } = hashPassword(DEFAULT_STAFF_PASSWORD)
        patch.pwd_hash = hash
        patch.pwd_salt = salt
      }

      const next = repo.updateStaff(row.id, patch)
      if (resetPassword || patch.active === false) authCacheClear() // 旧密码/旧登录态立刻失效
      console.log(`[staff] ${me.name} 改动了账号「${row.name}」${resetPassword ? '（密码已重置为默认值）' : ''}`)
      const view = memberView(next, 0)
      const out = { ok: true, member: view, staff: view } // staff 是旧前端的别名
      if (resetPassword) {
        out.default_password = DEFAULT_STAFF_PASSWORD
        out.access_key = DEFAULT_STAFF_PASSWORD // 旧前端字段别名
        out.hint = `账号 ${next.username || row.name} 的密码已重置为 ${DEFAULT_STAFF_PASSWORD}，请提醒本人登录后修改`
      }
      res.json(out)
    })
  )

  r.delete(
    '/staff/:id',
    wrap((req, res) => {
      const me = req.staff
      const row = repo.getStaff(req.params.id)
      if (!row || row.role === 'owner') return fail(res, 404, 'NOT_FOUND', '没有这个账号')
      if (!canManage(req, row)) {
        return fail(res, 403, 'FORBIDDEN', '这个账号不在你的管理范围里。')
      }
      if (String(row.id) === String(me.id)) return fail(res, 403, 'FORBIDDEN', '不能删除自己的账号。')

      const removed = repo.deleteStaff(row.id)
      authCacheClear() // 删掉的账号不能再靠缓存里的登录态进来
      console.log(
        `[staff] ${me.name} 删除了账号「${row.name}」，连带助理 ${removed?.assistants ?? 0} 个 / 学生 ${removed?.students ?? 0} 人回到未分配`
      )
      res.json({ ok: true, removed: removed || { assistants: 0, students: 0 } })
    })
  )

  /* ---------------- 修改自己的密码（默认 123456 的账号在这里改成自己的） ---------------- */

  r.patch(
    '/staff/me/password',
    wrap((req, res) => {
      const me = req.staff
      const current = String(req.body?.current ?? '')
      const next = String(req.body?.next ?? '').trim()
      if (!next) return fail(res, 400, 'INVALID_BODY', '新密码不能为空')
      if (next.length < 6) return fail(res, 400, 'WEAK_KEY', '新密码至少 6 位')

      // 总管改的是 COUNSELOR_KEY（落 settings 表，立即生效），其余账号改的是自己那行的 scrypt 值
      if (me.role === 'owner') {
        if (!safeEqual(current, counselorKey())) return fail(res, 401, 'UNAUTHORIZED', '当前密码不对')
        setSetting('counselor_key', next)
        authCacheClear()
        console.log('[auth] 总管密码已更新')
        return res.json({ ok: true, username: me.username || OWNER_USERNAME })
      }

      if (next === DEFAULT_STAFF_PASSWORD) {
        return fail(res, 400, 'WEAK_KEY', `新密码不能还是默认的 ${DEFAULT_STAFF_PASSWORD}`)
      }
      const row = repo.getStaff(me.id)
      if (!row || !verifyPassword(current, row.pwd_hash, row.pwd_salt)) {
        return fail(res, 401, 'UNAUTHORIZED', '当前密码不对')
      }
      const { hash, salt } = hashPassword(next)
      repo.updateStaff(row.id, { pwd_hash: hash, pwd_salt: salt })
      authCacheClear() // 旧密码缓存出来的登录态立刻作废
      console.log(`[auth] ${row.username || row.name} 修改了自己的密码`)
      res.json({ ok: true, username: row.username || null })
    })
  )

  /* ---------------- 自己的发件邮箱 ---------------- */

  r.get(
    '/staff/me/email',
    wrap((req, res) => {
      const row = req.staff.role === 'owner' ? ownerEmailRow() : repo.getStaff(req.staff.id)
      const v = emailView(row)
      // 对外只回掩码：没有 pass，也没有完整 username
      res.json({
        bound: v.bound,
        address: v.address,
        provider: v.provider,
        from: v.from,
        smtp: v.smtp
      })
    })
  )

  r.put(
    '/staff/me/email',
    wrap((req, res) => {
      const body = req.body || {}
      const email = str(body.email).trim()
      const provider = str(body.provider).trim().toLowerCase() || 'smtp'
      if (!EMAIL_RE.test(email)) {
        return fail(res, 400, 'INVALID_BODY', '邮箱格式不对，例如 name@university.edu')
      }
      if (!['smtp', 'resend'].includes(provider)) {
        return fail(res, 400, 'INVALID_BODY', 'provider 只能是 smtp（学校服务器）或 resend（Railway）')
      }

      const row = ensureEmailRow(req.staff)
      if (!row) return fail(res, 500, 'INTERNAL', '账号配置行创建失败，请稍后重试')

      const prev = mailConfigOf(row)
      const patch = { email, email_provider: provider }
      if (body.from !== undefined) patch.email_from = str(body.from).trim() || null

      if (provider === 'smtp') {
        const s = body.smtp && typeof body.smtp === 'object' ? body.smtp : {}
        const host = str(s.host).trim() || prev.host
        const portRaw = Number(s.port)
        const port = Number.isFinite(portRaw) && portRaw > 0 ? Math.round(portRaw) : prev.port || 587
        if (!host) {
          return fail(res, 400, 'INVALID_BODY', 'SMTP 需要服务器地址，例如 smtp.university.edu.cn')
        }
        if (port < 1 || port > 65535) {
          return fail(res, 400, 'INVALID_BODY', 'SMTP 端口不对（465 直连 SSL / 587 STARTTLS）')
        }
        const user = str(s.user).trim() || prev.user
        // 密码留空＝不改已保存的那份；首次配置或换用户名时必须填
        const passGiven = s.pass !== undefined && s.pass !== null && String(s.pass) !== ''
        const pass = passGiven ? String(s.pass) : prev.pass
        if (user && !pass) {
          return fail(res, 400, 'INVALID_BODY', 'SMTP 需要密码或授权码（留空表示不改已保存的那份）')
        }
        patch.email_api_key = encryptSecret(
          JSON.stringify({
            host,
            port,
            secure: port === 465, // 加密方式只由端口决定：465=true，587=false
            user,
            pass,
            resendKey: null
          })
        )
      } else {
        // Resend：api_key 留空＝沿用已保存的那把
        const apiKey = str(body.api_key).trim() || prev.resendKey
        if (!apiKey) {
          return fail(res, 400, 'INVALID_BODY', 'provider=resend 需要 api_key（在 Resend 后台生成）')
        }
        patch.email_api_key = encryptSecret(
          JSON.stringify({
            host: null,
            port: null,
            secure: false,
            user: null,
            pass: null,
            resendKey: apiKey
          })
        )
      }

      repo.updateStaff(row.id, patch)
      console.log(`[email] ${req.staff.name} 绑定发件邮箱 ${email}（provider=${provider}）`)
      res.json({ ok: true, email: emailView(repo.getStaff(row.id)) })
    })
  )

  r.delete(
    '/staff/me/email',
    wrap((req, res) => {
      const row = req.staff.role === 'owner' ? ownerEmailRow() : repo.getStaff(req.staff.id)
      if (row) {
        repo.updateStaff(row.id, {
          email: null,
          email_from: null,
          email_provider: null,
          email_api_key: null
        })
      }
      console.log(`[email] ${req.staff.name} 解绑了发件邮箱`)
      res.json({ ok: true })
    })
  )

  /* ---------------- 花名册：导入 / 清空 / 恢复示例 ---------------- */

  const normalizeLangCode = (v) => {
    const raw = str(v).trim().toLowerCase()
    if (!raw) return 'en'
    const map = {
      zh: 'zh', cn: 'zh', 中文: 'zh', 汉语: 'zh',
      en: 'en', eng: 'en', 英语: 'en', english: 'en',
      ru: 'ru', rus: 'ru', 俄语: 'ru', russian: 'ru',
      vi: 'vi', vie: 'vi', 越南语: 'vi', vietnamese: 'vi',
      th: 'th', tha: 'th', 泰语: 'th', thai: 'th',
      id: 'id', ind: 'id', 印尼语: 'id', indonesian: 'id'
    }
    return map[raw] || (LANGS.includes(raw) ? raw : 'en')
  }

  const cleanRows = (rows) => {
    const seen = new Set()
    const out = []
    let bad = 0
    let dup = 0
    for (const r of Array.isArray(rows) ? rows : []) {
      const sid = str(r?.student_id).trim()
      if (!sid) {
        bad++
        continue
      }
      if (seen.has(sid)) {
        dup++
        continue
      }
      seen.add(sid)
      // 学号能解析出学历/年级就先补上；手填的优先，手填错了由 /roster/check 指出来
      const inferred = parseStudentId(sid)
      out.push({
        student_id: sid,
        name: str(r?.name).trim() || sid,
        name_en: str(r?.name_en).trim() || null,
        lang: normalizeLangCode(r?.lang),
        class_no: str(r?.class_no).trim() || null,
        cohort: str(r?.cohort).trim() || null,
        // v2 新增的花名册字段：缺了留 null，由 /roster/check 把缺口报出来，不在这里拦截
        nationality: str(r?.nationality).trim() || null,
        email: str(r?.email).trim() || null,
        degree: str(r?.degree).trim() || inferred?.degree || null,
        grade: str(r?.grade).trim() || inferred?.grade || null
      })
    }
    return { rows: out, bad, dup }
  }

  /** 人数统计按 scope：总管看全部，辅导员/助理只看自己名下 */
  const rosterSummary = (req) => {
    const scope = scopeOf(req)
    return {
      total: repo.countStudents(scope),
      demo_count: repo.countDemoStudents(scope)
    }
  }

  r.post(
    '/roster/import',
    wrap((req, res) => {
      const scope = scopeOf(req)
      const mode = req.body?.mode === 'replace' ? 'replace' : 'append'
      const keepDemo = Boolean(req.body?.keep_demo)
      const { rows, bad, dup } = cleanRows(req.body?.rows)
      if (!rows.length) return fail(res, 400, 'INVALID_BODY', '没有解析出任何学生（学号那一列是空的？）')

      let removed = 0
      if (mode === 'replace') {
        // 「保留示例」= 只清掉之前导入的真实学生，示例学生还留着；清的范围永远不越界
        removed = keepDemo ? repo.deleteImportedStudents(scope) : repo.deleteAllStudents(scope)
      }

      // 谁导入算谁的：owner 导入记 NULL（只有总管看得见），辅导员/助理记自己的 scope
      const { added, updated, skipped } = repo.insertStudentsBulk(rows, scope)
      console.log(
        `[roster] ${req.staff.name}（${req.staff.role}）${mode} 导入 ${rows.length} 条（新增 ${added} / 更新 ${updated} / 跳过 ${skipped + bad + dup} / 归属 ${scope ?? '未分配'}）`
      )
      res.json({
        ok: true,
        added,
        updated,
        skipped: skipped + bad + dup,
        removed,
        mode,
        ...rosterSummary(req)
      })
    })
  )

  r.post(
    '/roster/clear',
    wrap((req, res) => {
      const scope = scopeOf(req)
      const keepDemo = Boolean(req.body?.keep_demo)
      const removed = keepDemo ? repo.deleteImportedStudents(scope) : repo.deleteAllStudents(scope)
      console.log(`[roster] ${req.staff.name} 清空名单，删掉 ${removed} 人（keepDemo=${keepDemo}）`)
      res.json({ ok: true, removed, ...rosterSummary(req) })
    })
  )

  r.post(
    '/roster/restore-demo',
    wrap((req, res) => {
      // 示例学生一律 owner_staff_id = NULL，恢复动作只对总管有意义
      if (req.staff.role !== 'owner') {
        return fail(res, 403, 'FORBIDDEN', '示例名单只有总管能恢复。')
      }
      const n = repo.insertDemoStudents(buildRoster())
      console.log(`[roster] 恢复示例学生 ${n} 人`)
      res.json({ ok: true, added: n, ...rosterSummary(req) })
    })
  )

  /** 解析通知，不落库。AI 失败 → 正则兜底，仍然 200 */
  r.post(
    '/notices/parse',
    wrap(async (req, res) => {
      const rawText = str(req.body?.raw_text || req.body?.rawText)
      if (!rawText.trim()) return fail(res, 400, 'INVALID_BODY', 'raw_text 不能为空')
      const sentAt = req.body?.sent_at || null
      const t0 = Date.now()
      try {
        const draft = await ai.parseNotice(rawText, sentAt)
        if (!draft || typeof draft !== 'object' || !str(draft.title_zh)) {
          throw new Error('AI 返回的结构为空')
        }
        res.json({
          draft: polishTitle(draft),
          meta: {
            model: process.env.DEEPSEEK_MODEL || 'deepseek-flash',
            ms: Date.now() - t0,
            degraded: false
          }
        })
      } catch (e) {
        const draft = naiveDraft(rawText, sentAt)
        console.error('[parse] AI 解析失败，降级为正则兜底：', e?.message || e)
        res.json({
          draft: polishTitle(draft),
          meta: {
            model: 'fallback-rule',
            ms: Date.now() - t0,
            degraded: true,
            note: 'AI 解析失败，已用正则兜底生成草稿，请人工补充'
          }
        })
      }
    })
  )

  /** 落库并发布：quiz 缺失就用 AI，AI 失败就用 actions 兜底单选题 */
  r.post(
    '/notices',
    wrap(async (req, res) => {
      const body = req.body || {}
      const structured0 =
        body.structured && typeof body.structured === 'object'
          ? body.structured
          : body.draft && typeof body.draft === 'object'
            ? body.draft
            : null
      if (!structured0) return fail(res, 400, 'INVALID_BODY', 'structured 必须是 StructuredNotice 对象')
      const structured = polishTitle(structured0)

      const rawText =
        str(body.raw_text || body.rawText).trim() ||
        [str(structured.title_zh), '', str(structured.what)].filter(Boolean).join('\n')

      const status = ['draft', 'published', 'closed'].includes(body.status) ? body.status : 'published'
      const now = nowIso()

      let quiz = body.quiz && typeof body.quiz === 'object' ? body.quiz : null
      let quizSource = quiz ? 'provided' : null
      if (!quiz) {
        try {
          const built = await ai.buildQuiz(structured)
          if (built && Array.isArray(built.options) && built.options.length >= 2) {
            quiz = built
            quizSource = 'ai'
          }
        } catch (e) {
          console.error('[notices] AI 生成小测失败，用 actions 兜底：', e?.message || e)
        }
      }
      if (!quiz || !Array.isArray(quiz.options) || quiz.options.length < 2) {
        quiz = fallbackQuizFromActions(structured)
        quizSource = 'fallback'
      }

      const translations =
        body.translations && typeof body.translations === 'object' ? body.translations : {}

      // 目标学生：省略 / null / [] 都表示「名下全部」；给了数组就必须逐个校验可见范围
      const scope = scopeOf(req)
      let targetIds = null
      if (body.target_ids !== undefined && body.target_ids !== null) {
        if (!Array.isArray(body.target_ids)) {
          return fail(res, 400, 'INVALID_BODY', 'target_ids 必须是学号数组')
        }
        const wanted = [...new Set(body.target_ids.map((v) => str(v).trim()).filter(Boolean))]
        if (wanted.length) {
          const visible = new Set(repo.getStudentsByIds(wanted, scope).map((s) => String(s.student_id)))
          const missing = wanted.filter((id) => !visible.has(id))
          if (missing.length) {
            // 越权当「不存在」：既不动库，也不透露这些学号在别人名下
            return fail(
              res,
              400,
              'OUT_OF_SCOPE',
              `这些学号不在你的名单里，不能作为发送目标：${missing.slice(0, 8).join('、')}${missing.length > 8 ? ` 等 ${missing.length} 个` : ''}`
            )
          }
          targetIds = wanted
        }
      }

      const notice = repo.createNotice({
        raw_text: rawText,
        structured,
        quiz,
        translations,
        risk_flags: Array.isArray(body.risk_flags)
          ? body.risk_flags
          : Array.isArray(structured.risk_flags)
            ? structured.risk_flags
            : [],
        status,
        published_at: status === 'published' ? now : null,
        // 谁发通知谁维护：没显式给 owner 就记当前登录的人（辅导员或某个助理）
        owner: str(body.owner) || req.staff?.name || null,
        // 归属账号 = 可见范围，数据隔离靠它（owner 发的是 NULL，只有总管看得见）
        owner_staff_id: scope,
        target_ids: targetIds,
        sent_at: body.sent_at || null
      })

      if (status === 'published') {
        repo.addEvent(notice.id, null, 'publish', {
          owner: notice.owner,
          staff_id: req.staff?.id || null,
          staff_name: req.staff?.name || null,
          target_ids: targetIds
        })
      }

      // 契约里「失败统一 4xx/5xx」，成功一律 200，避免前端/评委脚本按 200 判断时踩 201
      res.json({ notice, counts: repo.counts(notice.id, scope), quiz_source: quizSource })
    })
  )

  /** 列表 + 计数（按 scope 过滤：辅导员只看自己名下的通知） */
  r.get(
    '/notices',
    wrap((req, res) => {
      const scope = scopeOf(req)
      const notices = repo.listNotices(scope).map((n) => {
        const counts = repo.counts(n.id, scope)
        const tr = n.translations && typeof n.translations === 'object' ? n.translations : {}
        const langs = Object.keys(tr).filter((k) => tr[k])
        return {
          id: n.id,
          title_zh: n.title_zh,
          status: n.status,
          created_at: n.created_at,
          published_at: n.published_at,
          sent_at: n.sent_at,
          deadline_at: n.deadline_at,
          kind: n.kind,
          owner: n.owner,
          owner_staff_id: n.owner_staff_id || null,
          target_ids: n.target_ids || null,
          risk_flags: n.risk_flags,
          one_line: str(n.structured?.one_line),
          counts,
          langs,
          hours_left: hoursLeft(n.deadline_at)
        }
      })
      res.json({ notices, total: notices.length, server_time: nowIso() })
    })
  )

  /** 详情 */
  r.get(
    '/notices/:id',
    wrap((req, res) => {
      const notice = visibleNotice(req, req.params.id)
      if (!notice) return fail(res, 404, 'NOTICE_NOT_FOUND', '没有这份通知')
      const scope = scopeOf(req)
      const counts = repo.counts(notice.id, scope)
      const tr = notice.translations && typeof notice.translations === 'object' ? notice.translations : {}
      const langs = Object.keys(tr).filter((k) => tr[k])
      res.json({
        notice: { ...notice, counts, langs, hours_left: hoursLeft(notice.deadline_at) },
        counts,
        langs,
        receipts: repo.listReceipts(notice.id)
      })
    })
  )

  /** 改结构化字段 / 换状态 / 改目标学生 */
  r.patch(
    '/notices/:id',
    wrap((req, res) => {
      const existing = visibleNotice(req, req.params.id)
      if (!existing) return fail(res, 404, 'NOTICE_NOT_FOUND', '没有这份通知')
      const body = req.body || {}
      const scope = scopeOf(req)
      const patch = {}

      for (const k of ['status', 'owner', 'sent_at', 'title_zh', 'raw_text', 'kind']) {
        if (body[k] !== undefined) patch[k] = body[k]
      }
      if (body.deadline_at !== undefined) patch.deadline_at = body.deadline_at
      if (body.published_at !== undefined) patch.published_at = body.published_at
      if (body.quiz !== undefined) patch.quiz = body.quiz
      if (body.risk_flags !== undefined) patch.risk_flags = body.risk_flags

      // 目标学生：同样要逐个校验可见范围，越权 400
      if (body.target_ids !== undefined) {
        if (body.target_ids !== null && !Array.isArray(body.target_ids)) {
          return fail(res, 400, 'INVALID_BODY', 'target_ids 必须是学号数组')
        }
        const wanted = [...new Set((body.target_ids || []).map((v) => str(v).trim()).filter(Boolean))]
        if (wanted.length) {
          const visible = new Set(repo.getStudentsByIds(wanted, scope).map((s) => String(s.student_id)))
          const missing = wanted.filter((id) => !visible.has(id))
          if (missing.length) {
            return fail(
              res,
              400,
              'OUT_OF_SCOPE',
              `这些学号不在你的名单里，不能作为发送目标：${missing.slice(0, 8).join('、')}${missing.length > 8 ? ` 等 ${missing.length} 个` : ''}`
            )
          }
          patch.target_ids = wanted
        } else {
          patch.target_ids = null // 清空 = 名下全部
        }
      }

      if (body.translations !== undefined) {
        patch.translations = {
          ...(existing.translations || {}),
          ...(body.translations && typeof body.translations === 'object' ? body.translations : {})
        }
      }
      if (body.structured !== undefined) {
        if (!body.structured || typeof body.structured !== 'object') {
          return fail(res, 400, 'INVALID_BODY', 'structured 必须是对象')
        }
        patch.structured = { ...(existing.structured || {}), ...body.structured }
      }

      // 状态切到 published 时补 published_at，并留痕
      if (patch.status === 'published' && !existing.published_at && patch.published_at === undefined) {
        patch.published_at = nowIso()
      }
      if (patch.status && patch.status !== existing.status) {
        repo.addEvent(existing.id, null, 'status', { from: existing.status, to: patch.status })
      }

      const notice = repo.updateNotice(existing.id, patch)
      res.json({ notice, counts: repo.counts(notice.id, scope) })
    })
  )

  /** 删除一份通知：回执、小测、拒绝日志、事件一起删，不可恢复 */
  r.delete(
    '/notices/:id',
    wrap((req, res) => {
      const notice = visibleNotice(req, req.params.id)
      if (!notice) return fail(res, 404, 'NOTICE_NOT_FOUND', '没有这份通知，可能已经删过了')
      const removed = repo.deleteNotice(notice.id)
      console.log(
        `[notices] 删除 ${notice.id}「${notice.title_zh || '未命名'}」，连带回执 ${removed?.receipts ?? 0} 条 / 拒绝 ${removed?.refusals ?? 0} 条，操作人 ${req.staff?.name || '?'}`
      )
      res.json({ ok: true, id: notice.id, removed: removed || { receipts: 0, events: 0, refusals: 0 } })
    })
  )

  /** 生成 / 补齐多语言 + 各自 quiz。单语言失败不影响其他语言 */
  r.post(
    '/notices/:id/translate',
    wrap(async (req, res) => {
      const notice = visibleNotice(req, req.params.id)
      if (!notice) return fail(res, 404, 'NOTICE_NOT_FOUND', '没有这份通知')

      const requested = Array.isArray(req.body?.langs) && req.body.langs.length ? req.body.langs : DEFAULT_LANGS
      const langs = requested
        .map((l) => str(l).trim().toLowerCase())
        .filter((l) => TARGET_LANGS.includes(l))
      if (!langs.length) {
        return fail(res, 400, 'INVALID_LANGS', `langs 至少给一个目标语言：${TARGET_LANGS.join('/')}`)
      }

      const structured = notice.structured || {}
      const quiz = notice.quiz || null
      const fresh = {}
      const failed = []
      const errors = {}

      // 先整批调一次。ai.translateNotice 内部已经做过「某语言缺失就单独重试」，
      // 所以批量返回时直接采信；只有当整批抛错、且属于「内容类」错误时才在这里逐语言再兜一层，
      // 避免网络超时 / 未配置 key 时把一次失败放大成 N 次长耗时调用。
      let batch = null
      let batchError = null
      try {
        batch = await ai.translateNotice(structured, quiz, langs)
      } catch (e) {
        batchError = e
        errors.__batch = str(e?.message || e)
        console.error('[translate] 批量翻译失败：', e?.message || e)
      }

      if (batch && typeof batch === 'object') {
        for (const l of langs) {
          const t = batch[l]
          if (t && typeof t === 'object') fresh[l] = t
        }
      }

      const CONTENT_ERRORS = new Set(['AI_BAD_JSON', 'AI_TRUNCATED', 'AI_EMPTY', 'AI_BAD_RESPONSE'])
      const retryPerLang = !batch && CONTENT_ERRORS.has(str(batchError?.code))
      for (const l of langs) {
        if (fresh[l]) continue
        if (!retryPerLang) {
          failed.push(l)
          if (!errors[l]) errors[l] = str(batchError?.message || 'AI 没有返回该语言')
          continue
        }
        try {
          const one = await ai.translateNotice(structured, quiz, [l])
          const t = one && typeof one === 'object' ? one[l] || (one.lang === l ? one : null) : null
          if (t && typeof t === 'object') {
            fresh[l] = t
            delete errors[l]
          } else {
            failed.push(l)
            errors[l] = 'AI 没有返回该语言'
          }
        } catch (e) {
          failed.push(l)
          errors[l] = str(e?.message || e)
          console.error(`[translate] ${l} 失败：`, e?.message || e)
        }
      }

      // 兜底补字段：AI 少给字段时用中文母版填，别让卡片空着
      for (const l of Object.keys(fresh)) {
        const t = fresh[l]
        t.lang = t.lang || l
        if (!t.title) t.title = str(structured.title_zh)
        if (!t.one_line) t.one_line = str(structured.one_line)
        if (!t.what) t.what = str(structured.what)
        if (!t.who) t.who = str(structured.who)
        if (!Array.isArray(t.actions)) t.actions = []
        if (!Array.isArray(t.materials)) t.materials = Array.isArray(structured.materials) ? structured.materials : []
        if (!t.deadline_text) t.deadline_text = str(structured?.deadline?.raw)
        if (!t.place_text) t.place_text = str(structured?.place?.raw)
        if (!t.consequence) t.consequence = str(structured.consequence)
        if (t.quiz && quiz && typeof t.quiz === 'object') {
          // 答案只能来自服务端中文母版，AI 给的不采信
          t.quiz.answer_index = Number(quiz.answer_index) || 0
          if (!t.quiz.source_span) t.quiz.source_span = str(quiz.source_span)
          if (!t.quiz.explain) t.quiz.explain = str(quiz.explain)
        }
      }

      const translations = { ...(notice.translations || {}), ...fresh }
      const saved = repo.updateNotice(notice.id, { translations })
      repo.addEvent(notice.id, null, 'translate', { langs, failed })

      res.json({
        ok: failed.length === 0,
        notice_id: notice.id,
        langs: Object.keys(fresh),
        failed,
        errors: Object.keys(errors).length ? errors : undefined,
        translations: saved?.translations || translations
      })
    })
  )

  /** 看板（只列目标学生，且不越出调用者的可见范围） */
  r.get(
    '/notices/:id/dashboard',
    wrap((req, res) => {
      const notice = visibleNotice(req, req.params.id)
      if (!notice) return fail(res, 404, 'NOTICE_NOT_FOUND', '没有这份通知')

      const scope = scopeOf(req)
      const counts = repo.counts(notice.id, scope)
      const rows = repo.rosterWithReceipts(notice.id, scope)
      const visibleIds = new Set(rows.map((row) => String(row.student_id)))

      // by_lang：按 roster 的语言统计已确认数（doc 里就是 {en:8,ru:6} 这种纯数字）
      const byLang = {}
      const byLangRoster = {}
      for (const row of rows) {
        const l = str(row.lang) || 'en'
        if (!(l in byLang)) {
          byLang[l] = 0
          byLangRoster[l] = 0
        }
        byLangRoster[l] += 1
        if (row.confirmed_at) byLang[l] += 1
      }

      const students = rows.map((row) => ({
        student_id: row.student_id,
        name: row.name,
        name_en: row.name_en,
        lang: row.lang,
        class_no: row.class_no,
        nationality: row.nationality,
        email: row.email,
        degree: row.degree,
        grade: row.grade,
        status: row.status,
        first_seen_at: row.first_seen_at,
        confirmed_at: row.confirmed_at,
        quiz_passed_at: row.quiz_passed_at,
        quiz_ok: row.quiz_ok,
        help_at: row.help_at,
        help_message: row.help_message
      }))

      // timeline：按发布后小时数分桶，至少 24 桶
      const publishedMs = toMs(notice.published_at) ?? toMs(notice.created_at) ?? Date.now()
      const spanHours = Math.max(24, Math.ceil((Date.now() - publishedMs) / 3600000))
      const bucketCount = Math.min(Math.max(spanHours + 1, 24), 24 * 14)
      const timeline = Array.from({ length: bucketCount }, (_, hour) => ({
        hour,
        confirmed: 0,
        seen: 0,
        help: 0,
        quiz: 0
      }))
      const bump = (iso, key) => {
        const t = toMs(iso)
        if (t === null) return
        const h = Math.floor((t - publishedMs) / 3600000)
        const i = Math.min(Math.max(h, 0), bucketCount - 1)
        timeline[i][key] += 1
      }
      for (const rc of repo.listReceipts(notice.id)) {
        if (!visibleIds.has(String(rc.student_id))) continue
        bump(rc.first_seen_at, 'seen')
        bump(rc.quiz_passed_at, 'quiz')
        bump(rc.confirmed_at, 'confirmed')
        bump(rc.help_at, 'help')
      }

      res.json({
        notice_id: notice.id,
        notice: {
          id: notice.id,
          title_zh: notice.title_zh,
          status: notice.status,
          published_at: notice.published_at,
          deadline_at: notice.deadline_at,
          risk_flags: notice.risk_flags,
          owner: notice.owner
        },
        counts,
        by_lang: byLang,
        by_lang_roster: byLangRoster,
        students,
        timeline,
        refusals: repo.listRefusals(notice.id, 30),
        recent_events: repo.listEvents(notice.id, 50),
        langs: Object.keys(notice.translations || {}).filter((k) => notice.translations[k]),
        hours_left: hoursLeft(notice.deadline_at),
        server_time: nowIso()
      })
    })
  )

  /** 催办：选目标 + 生成文案 + 链接 + 二维码 */
  r.post(
    '/notices/:id/nudge',
    wrap(async (req, res) => {
      const notice = visibleNotice(req, req.params.id)
      if (!notice) return fail(res, 404, 'NOTICE_NOT_FOUND', '没有这份通知')
      const scope = scopeOf(req)

      const rawTier = req.body?.tier
      // 兼容前端的 'unconfirmed' 写法，统一到 'all'
      const tier = rawTier === 'unconfirmed' ? 'all' : ['unread', 'all', 'help'].includes(rawTier) ? rawTier : 'unread'
      // 语气：gentle 温和 / firm 明确 / final 最后通牒（ai.nudgeText 认 gentle|firm|final）
      const tone = ['gentle', 'firm', 'final', 'warm'].includes(req.body?.tone) ? req.body.tone : 'firm'
      const lang = str(req.body?.lang) || 'zh'

      const rows = repo.rosterWithReceipts(notice.id, scope)
      let targets
      if (tier === 'unread') {
        targets = rows.filter((row) => !row.first_seen_at && !row.confirmed_at && !row.help_at)
      } else if (tier === 'help') {
        targets = rows.filter((row) => Boolean(row.help_at))
      } else {
        targets = rows.filter((row) => !row.confirmed_at)
      }
      targets = targets.map((row) => ({
        student_id: row.student_id,
        name: row.name,
        name_en: row.name_en,
        lang: row.lang,
        class_no: row.class_no,
        status: row.status,
        help_message: row.help_message || null
      }))

      const link = `${publicBase(req)}/#/s/${notice.id}`

      let text = ''
      let source = 'ai'
      try {
        // link 一起传进去：群消息里必须出现完整可点的地址，不能是 /#/s/xxx 这种相对路径
        text = await ai.nudgeText({ notice, targets, lang, tone, tier, link })
        if (!text || typeof text !== 'string' || !text.trim()) throw new Error('AI 返回空文案')
      } catch (e) {
        source = 'fallback'
        console.error('[nudge] AI 文案失败，用内置模板：', e?.message || e)
        text = fallbackNudgeText({ notice, targets, lang, tone, tier, link })
      }
      // 催办文案的硬要求：必须出现截止时间和可点链接。模型偶有漏写，这里确定性补齐。
      text = ensureNudgeEssentials(text, notice, lang, link)

      let qrDataUrl = null
      try {
        qrDataUrl = await QRCode.toDataURL(link, { margin: 1, width: 480, errorCorrectionLevel: 'M' })
      } catch (e) {
        console.error('[nudge] 二维码生成失败：', e?.message || e)
      }

      repo.addEvent(notice.id, null, 'nudge', {
        tier,
        tone,
        lang,
        count: targets.length,
        source,
        staff_id: req.staff?.id || null,
        staff_name: req.staff?.name || null
      })

      res.json({
        text,
        targets,
        count: targets.length,
        link,
        qr_data_url: qrDataUrl,
        tier,
        tone,
        lang,
        source,
        counts: repo.counts(notice.id, scope)
      })
    })
  )

  /** 回执存证导出（Excel 直接打开：UTF-8 BOM） */
  r.get(
    '/notices/:id/export.csv',
    wrap((req, res) => {
      const notice = visibleNotice(req, req.params.id)
      if (!notice) return fail(res, 404, 'NOTICE_NOT_FOUND', '没有这份通知')

      const STATUS_ZH = { confirmed: '已确认', help: '已求助', seen: '仅查看', unread: '未读' }
      const rows = repo.rosterWithReceipts(notice.id, scopeOf(req))
      const header = [
        '学号',
        '姓名',
        '姓名(拉丁)',
        '语言',
        '班级',
        '状态',
        '首次打开',
        '小测通过',
        '回执确认时间',
        '求助时间',
        '求助内容'
      ]
      const esc = (v) => `"${str(v).replace(/"/g, '""')}"`
      const lines = [header.map(esc).join(',')]
      for (const row of rows) {
        lines.push(
          [
            row.student_id,
            row.name,
            row.name_en,
            row.lang,
            row.class_no,
            STATUS_ZH[row.status] || row.status,
            row.first_seen_at,
            row.quiz_passed_at,
            row.confirmed_at,
            row.help_at,
            row.help_message
          ]
            .map(esc)
            .join(',')
        )
      }

      const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '')
      const filename = `lastmile-${String(notice.id).replace(/[^\w-]/g, '')}-${stamp}.csv`
      res.setHeader('Content-Type', 'text/csv; charset=utf-8')
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
      res.setHeader('Cache-Control', 'no-store')
      res.send('\uFEFF' + lines.join('\r\n') + '\r\n')
    })
  )

  /* ---------------- 邮件通知：逐个学生发，失败收集不中断 ---------------- */

  /** 发件头：给了显示名就拼成 "名字" <地址> */
  const mailFrom = (row) => {
    const address = str(row?.email).trim()
    const name = str(row?.email_from).trim().replace(/[<>"]/g, '')
    return name ? `"${name}" <${address}>` : address
  }

  const escapeHtml = (v) =>
    str(v).replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
    )

  /** 一封信：该通知的结构化内容 + 这位学生自己的卡片链接 */
  function buildMail(notice, student, link) {
    const s = notice.structured || {}
    const title = str(notice.title_zh) || str(s.title_zh) || '通知'
    const who = str(student.name || student.name_en || student.student_id)
    const actions = Array.isArray(s.actions) ? s.actions : []
    const materials = Array.isArray(s.materials) ? s.materials : []

    const lines = [`你好 ${who}：`, '', `这是一条需要你处理的通知：${title}`]
    if (str(s.one_line)) lines.push(`要点：${str(s.one_line)}`)
    if (str(s.what)) lines.push(`说明：${str(s.what)}`)
    if (str(s?.deadline?.raw)) lines.push(`截止：${str(s.deadline.raw)}`)
    if (str(s?.place?.raw)) lines.push(`地点：${str(s.place.raw)}`)
    if (actions.length) {
      lines.push('', '要做的步骤：')
      actions.forEach((a, i) => lines.push(`${i + 1}. ${str(a.zh || a.text)}`))
    }
    if (materials.length) {
      lines.push('', '需要带的材料：')
      for (const m of materials) lines.push(`- ${str(m)}`)
    }
    if (str(s.consequence)) lines.push('', `注意：${str(s.consequence)}`)
    lines.push('', `点开卡片查看并确认（30 秒）：${link}`, '', '—— 最后一公里 LastMile')

    const text = lines.join('\n')
    const html = `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.7;color:#1f2328">${escapeHtml(
      text
    )
      .replace(escapeHtml(link), `<a href="${escapeHtml(link)}">${escapeHtml(link)}</a>`)
      .replace(/\n/g, '<br>')}</div>`

    return { subject: `【LastMile】${title}`, text, html }
  }

  r.post(
    '/notices/:id/email',
    wrap(async (req, res) => {
      const notice = visibleNotice(req, req.params.id)
      if (!notice) return fail(res, 404, 'NOTICE_NOT_FOUND', '没有这份通知')

      const me = req.staff
      const row = me.role === 'owner' ? ownerEmailRow() : repo.getStaff(me.id)
      const mail = emailView(row)
      if (!mail.bound) {
        if (mail.broke) {
          return fail(
            res,
            400,
            'EMAIL_NOT_BOUND',
            '发件邮箱凭据读不出来（SECRET_KEY 换过？），请到「我的邮箱」里重新填写'
          )
        }
        return fail(
          res,
          400,
          'EMAIL_NOT_BOUND',
          '还没有绑定发件邮箱：先在「我的邮箱」里填发件地址与邮件通道（SMTP 需要主机 / 用户名 / 密码，Resend 需要 API Key）'
        )
      }
      const provider = mail.provider
      const cfg = mailConfigOf(row)
      // 按通道分派：SMTP 直接把主机/端口/账号/密码交给 nodemailer；Resend 只给 API Key
      const config =
        provider === 'smtp'
          ? { host: cfg.host, port: cfg.port, secure: cfg.secure, user: cfg.user, pass: cfg.pass }
          : null
      const apiKey = provider === 'resend' ? cfg.resendKey : null
      if (provider === 'resend' && !apiKey) {
        return fail(
          res,
          400,
          'EMAIL_NOT_BOUND',
          '邮箱 API Key 解密失败（SECRET_KEY 换过？），请在后台重新填写'
        )
      }

      const scope = scopeOf(req)
      const from = mailFrom(row)
      const link = `${publicBase(req)}/#/s/${notice.id}`
      // 收件人 = 这份通知的目标学生（target_ids 为空则名下全部）里有邮箱的人
      const rows = repo.rosterWithReceipts(notice.id, scope)

      let sent = 0
      let failed = 0
      let skipped = 0
      const errors = []
      const seen = new Set()

      for (const student of rows) {
        const to = str(student.email).trim()
        if (!to) {
          skipped++ // 目标学生但没填邮箱
          continue
        }
        const dedupe = to.toLowerCase()
        if (seen.has(dedupe)) {
          skipped++ // 同一个邮箱只发一封（/roster/check 会提示重复）
          continue
        }
        seen.add(dedupe)

        try {
          await sendMail({ provider, config, apiKey, from, to, ...buildMail(notice, student, link) })
          sent++
        } catch (e) {
          // 单人失败只记下来，继续发下一个
          failed++
          const reason = str(e?.message || e).slice(0, 300)
          errors.push({ student_id: student.student_id, reason })
          console.error(`[email] 发给 ${student.student_id} 失败：`, reason)
        }
      }

      repo.addEvent(notice.id, null, 'email', {
        provider,
        sent,
        failed,
        skipped,
        staff_id: me.id,
        staff_name: me.name
      })
      console.log(
        `[email] ${notice.id} ▸ provider=${provider} 成功 ${sent} / 失败 ${failed} / 跳过 ${skipped}（${me.name}）`
      )
      res.json({ ok: failed === 0, provider, sent, failed, skipped, errors })
    })
  )

  /** 名单（v2：关键词 / 学历 / 年级 / 语言 / 班级 过滤，永远只在自己可见范围内）。
      每行额外带 id_degree / id_grade：学号推断值，前端用它和手填值对比、提示「与学号不一致」。 */
  r.get(
    '/roster',
    wrap((req, res) => {
      const scope = scopeOf(req)
      const rows = repo.listStudents({
        scope,
        q: req.query.q,
        degree: req.query.degree,
        grade: req.query.grade,
        lang: req.query.lang,
        class_no: req.query.class_no
      })
      const students = rows.map((s) => {
        const inferred = parseStudentId(s.student_id)
        return {
          ...s,
          id_degree: inferred?.degree || null,
          id_grade: inferred?.grade || null
        }
      })
      res.json({
        roster: students, // 旧前端的别名，别让老页面白屏
        students,
        total: students.length,
        demo_count: repo.countDemoStudents(scope)
      })
    })
  )

  /** 花名册体检：纯确定性规则（不调模型），把发邮件前必须补齐的字段缺口列出来 */
  r.post(
    '/roster/check',
    wrap((req, res) => {
      const scope = scopeOf(req)
      const students = repo.listStudents({ scope })
      const hints = []

      const emailCount = new Map()
      for (const s of students) {
        const email = str(s.email).trim().toLowerCase()
        if (email) emailCount.set(email, (emailCount.get(email) || 0) + 1)
      }

      for (const s of students) {
        const who = str(s.name || s.name_en || s.student_id)
        const push = (field, level, message) =>
          hints.push({
            student_id: s.student_id,
            name: str(s.name || s.name_en),
            field,
            level,
            message
          })

        const email = str(s.email).trim()
        if (!email) push('email', 'warn', `${who} 的邮箱缺失，没法给他发邮件通知`)
        else if (!EMAIL_RE.test(email)) push('email', 'warn', `${who} 的邮箱格式不对：${email}`)
        else if ((emailCount.get(email.toLowerCase()) || 0) > 1) {
          push('email', 'warn', `${who} 的邮箱 ${email} 和别的同学重复，通知可能发错人`)
        }

        // 学号推断：8 位数字 + 第 1 位 1/2/5，能推断出学历与年级
        const inferred = parseStudentId(s.student_id)
        if (!inferred) {
          push(
            'student_id',
            'warn',
            `${who} 的学号「${s.student_id}」不是 8 位数字（第 1 位应为 1=博士 / 2=硕士 / 5=本科），推断不出学历与年级`
          )
        }

        const degree = str(s.degree).trim()
        if (!degree) push('degree', 'warn', `${who} 的学历信息缺失`)
        else if (!DEGREES.includes(degree)) {
          push('degree', 'warn', `${who} 的学历「${degree}」不在 本科/硕士/博士 里`)
        } else if (inferred && degree !== inferred.degree) {
          push('degree', 'warn', `${who} 手填学历「${degree}」与学号推断出的「${inferred.degree}」不一致，请核对`)
        }

        const grade = str(s.grade).trim()
        if (!grade) push('grade', 'warn', `${who} 的年级信息缺失`)
        else if (!GRADE_RE.test(grade)) {
          push('grade', 'warn', `${who} 的年级「${grade}」不是 20xx级 的形式`)
        } else if (inferred && grade !== inferred.grade) {
          push('grade', 'warn', `${who} 手填年级「${grade}」与学号推断出的「${inferred.grade}」不一致，请核对`)
        }

        if (!str(s.nationality).trim()) push('nationality', 'info', `${who} 的国籍信息缺失`)
      }

      res.json({ hints, scanned: students.length })
    })
  )

  /* ---------------- 学生接口（公开，不需要登录） ---------------- */

  /** 校验学号，回姓名 / 语言 */
  r.get(
    '/student/me',
    wrap((req, res) => {
      const studentId = str(req.query.student_id).trim()
      if (!studentId) return fail(res, 400, 'INVALID_BODY', '缺少 student_id')
      const student = repo.getStudent(studentId)
      if (!student) {
        return fail(res, 404, 'UNKNOWN_STUDENT', '这个学号不在名单里，请检查后重试（或联系辅导员）')
      }
      res.json({
        ok: true,
        student,
        student_id: student.student_id,
        name: student.name,
        name_en: student.name_en,
        lang: student.lang,
        class_no: student.class_no
      })
    })
  )

  /** 学生卡片页全部数据（无答案）。
      请求的语种如果还没翻译过，这里当场生成一次并缓存，学生下次点就不用等。 */
  r.get(
    '/student/notice/:id',
    wrap(async (req, res) => {
      let notice = repo.getNotice(req.params.id)
      if (!notice) return fail(res, 404, 'NOTICE_NOT_FOUND', '没有这份通知')

      const studentId = str(req.query.student_id).trim()
      const student = studentId ? repo.getStudent(studentId) : null
      const wanted = str(req.query.lang).trim() || (student?.lang ?? '')
      const requested = wanted.toLowerCase()
      const isKnown = LANGS.includes(requested)
      const have =
        notice.translations && typeof notice.translations === 'object' ? notice.translations : {}

      let generated = false
      let langError = null
      if (isKnown && requested !== 'zh' && !have[requested] && process.env.DEEPSEEK_API_KEY) {
        try {
          const out = await ai.translateNotice(notice.structured || {}, notice.quiz || null, [requested])
          const t = out?.[requested]
          if (t && (t.title || t.one_line)) {
            const merged = { ...have, [requested]: t }
            const updated = repo.updateNotice(notice.id, { translations: merged })
            if (updated) notice = updated
            generated = true
            console.log(`[translate] 按需生成 ${notice.id} → ${requested}`)
          }
        } catch (e) {
          langError = String(e?.message || e).slice(0, 200)
          console.error('[translate] 按需生成失败（回退）：', langError)
        }
      }

      const { lang, available } = resolveLang(notice, wanted)
      const view = localizedView(notice, lang)
      const s = notice.structured || {}
      const receipt = student ? repo.getReceipt(notice.id, studentId) : null

      const deadlineIso = notice.deadline_at || s?.deadline?.iso || null

      const payload = {
        notice_id: notice.id,
        lang,
        lang_requested: isKnown ? requested : null,
        lang_ready: !isKnown || requested === 'zh' ? true : lang === requested,
        lang_generated: generated,
        lang_error: langError,
        available_langs: available,
        title: view.title,
        one_line: view.one_line,
        what: view.what,
        who: view.who,
        actions: view.actions,
        deadline: {
          iso: deadlineIso,
          text: view.deadline_text,
          hours_left: hoursLeft(deadlineIso),
          confidence: s?.deadline?.confidence || null
        },
        place: view.place_text,
        materials: view.materials,
        consequence: view.consequence,
        official_links: Array.isArray(s.official_links) ? s.official_links : [],
        contacts: Array.isArray(s.contacts) ? s.contacts : [],
        risk_flag: Array.isArray(notice.risk_flags) ? notice.risk_flags[0] || 'none' : 'none',
        risk_flags: notice.risk_flags || [],
        original_zh: notice.raw_text,
        spans: s.spans || {},
        quiz: publicQuiz(view.quiz),
        my_status: statusOf(receipt),
        // ui-spec §4 的状态机有 quiz_passed 这一档，my_status 仍保持 api.md 的 4 态
        quiz_passed: Boolean(receipt?.quiz_passed_at),
        counts: repo.counts(notice.id, notice.owner_staff_id || null),
        status: notice.status,
        student: student
          ? { student_id: student.student_id, name: student.name, name_en: student.name_en, lang: student.lang }
          : null,
        server_time: nowIso()
      }
      res.json(assertNoAnswer(payload))
    })
  )

  /** 已读打点 */
  r.post(
    '/student/notice/:id/seen',
    wrap((req, res) => {
      const notice = repo.getNotice(req.params.id)
      if (!notice) return fail(res, 404, 'NOTICE_NOT_FOUND', '没有这份通知')

      const studentId = str(req.body?.student_id).trim()
      const student = studentId ? repo.getStudent(studentId) : null
      const lang = str(req.body?.lang) || student?.lang || null
      const ua = str(req.get('user-agent')).slice(0, 300) || null
      const ip = str(req.ip) || null

      if (!student) {
        // 匿名浏览：只记事件，不建回执（回执必须实名，否则 114 的口径会被污染）
        repo.addEvent(notice.id, null, 'view', { anonymous: true, lang })
        return res.json({
          ok: true,
          anonymous: true,
          my_status: 'unread',
          counts: repo.counts(notice.id, notice.owner_staff_id || null)
        })
      }

      const receipt = repo.upsertReceipt(notice.id, student.student_id, {
        name: student.name,
        lang,
        first_seen_at: nowIso(),
        ua,
        ip
      })
      repo.addEvent(notice.id, student.student_id, 'view', { lang })
      res.json({
        ok: true,
        receipt,
        my_status: statusOf(receipt),
        counts: repo.counts(notice.id, notice.owner_staff_id || null)
      })
    })
  )

  /** 交答案：回正误 + 原文片段 + 解释 */
  r.post(
    '/student/notice/:id/quiz',
    wrap((req, res) => {
      const notice = repo.getNotice(req.params.id)
      if (!notice) return fail(res, 404, 'NOTICE_NOT_FOUND', '没有这份通知')

      const quiz = notice.quiz
      if (!quiz || !Array.isArray(quiz.options) || quiz.options.length < 2) {
        return fail(res, 409, 'NO_QUIZ', '这份通知还没有生成小测')
      }

      const choice = Number(req.body?.choice)
      if (!Number.isInteger(choice) || choice < 0 || choice >= quiz.options.length) {
        return fail(res, 400, 'INVALID_CHOICE', `choice 必须是 0-${quiz.options.length - 1} 之间的整数`)
      }

      const answer = Number(quiz.answer_index) || 0
      const correct = choice === answer
      const studentId = str(req.body?.student_id).trim()
      const student = studentId ? repo.getStudent(studentId) : null

      repo.addQuizAttempt(notice.id, studentId || null, choice, correct)
      repo.addEvent(notice.id, studentId || null, 'quiz', { choice, correct })

      if (correct && student) {
        const existing = repo.getReceipt(notice.id, student.student_id)
        const patch = { name: student.name, lang: student.lang }
        if (!existing?.first_seen_at) patch.first_seen_at = nowIso()
        if (!existing?.quiz_passed_at) patch.quiz_passed_at = nowIso()
        repo.upsertReceipt(notice.id, student.student_id, patch)
      }

      res.json({
        correct,
        correct_index: answer,
        source_span: str(quiz.source_span),
        explain: str(quiz.explain),
        attempts: repo.quizAttemptCount(notice.id, studentId || null),
        counts: repo.counts(notice.id, notice.owner_staff_id || null)
      })
    })
  )

  /** 回执 / 求助 */
  r.post(
    '/student/notice/:id/receipt',
    wrap((req, res) => {
      const notice = repo.getNotice(req.params.id)
      if (!notice) return fail(res, 404, 'NOTICE_NOT_FOUND', '没有这份通知')

      const kind = str(req.body?.kind)
      if (kind !== 'confirm' && kind !== 'help') {
        return fail(res, 400, 'INVALID_KIND', 'kind 只能是 confirm 或 help')
      }

      const studentId = str(req.body?.student_id).trim()
      if (!studentId) return fail(res, 400, 'UNKNOWN_STUDENT', '缺少 student_id，请先填写学号')
      const student = repo.getStudent(studentId)
      if (!student) {
        return fail(res, 400, 'UNKNOWN_STUDENT', '这个学号不在 2026 级名单里，请检查（或联系辅导员）')
      }

      const now = nowIso()
      const patch = {
        name: student.name || str(req.body?.name) || null,
        lang: str(req.body?.lang) || student.lang || null,
        first_seen_at: now,
        ua: str(req.get('user-agent')).slice(0, 300) || null,
        ip: str(req.ip) || null
      }
      if (kind === 'confirm') patch.confirmed_at = now
      if (kind === 'help') {
        patch.help_at = now
        patch.help_message = str(req.body?.help_message).slice(0, 2000) || null
      }

      const receipt = repo.upsertReceipt(notice.id, student.student_id, patch)
      repo.addEvent(notice.id, student.student_id, kind === 'confirm' ? 'receipt' : 'help', {
        kind,
        lang: patch.lang,
        message: kind === 'help' ? patch.help_message : null
      })

      const counts = repo.counts(notice.id, notice.owner_staff_id || null)
      res.json({
        ok: true,
        receipt,
        my_status: statusOf(receipt),
        counts,
        // 单独再给一份扁平计数，前端两种取法都行
        confirmed: counts.confirmed,
        roster: counts.roster
      })
    })
  )

  /** 追问：敏感五类只走 guard.guardAsk，本文件不写任何拒绝文案 */
  r.post(
    '/student/notice/:id/ask',
    wrap(async (req, res) => {
      const notice = repo.getNotice(req.params.id)
      if (!notice) return fail(res, 404, 'NOTICE_NOT_FOUND', '没有这份通知')

      const question = str(req.body?.question).trim()
      if (!question) return fail(res, 400, 'INVALID_BODY', 'question 不能为空')
      const lang = str(req.body?.lang) || 'zh'
      const studentId = str(req.body?.student_id).trim() || null

      let result
      try {
        result = await guardAsk({
          question,
          lang,
          structured: notice.structured || {},
          notice
        })
      } catch (e) {
        // 拦截层自己挂了也绝不能由 api 层「顺手回答」——直接把问题记下来并让前端转人工
        console.error('[ask] guardAsk 异常：', e?.message || e)
        repo.addRefusal(notice.id, studentId, question, 'guard_error')
        repo.addEvent(notice.id, studentId, 'refusal', { reason_code: 'guard_error' })
        return res.status(503).json({
          error: {
            code: 'GUARD_UNAVAILABLE',
            message: '敏感问题拦截服务暂时不可用，请稍后再试，或直接联系辅导员。'
          }
        })
      }

      if (result?.allowed) {
        repo.addEvent(notice.id, studentId, 'answer', { lang })
        return res.json({ allowed: true, answer: str(result.answer) })
      }

      const refusal = result?.refusal || null
      repo.addRefusal(notice.id, studentId, question, refusal?.reason_code || 'out_of_scope')
      repo.addEvent(notice.id, studentId, 'refusal', {
        reason_code: refusal?.reason_code || 'out_of_scope'
      })
      res.json({ allowed: false, refusal })
    })
  )

  /* ---------------- 未匹配的 /api 路径 ---------------- */

  r.use((req, res) => {
    res
      .status(404)
      .json({ error: { code: 'NOT_FOUND', message: `接口不存在：${req.method} ${req.originalUrl}` } })
  })

  return r
}

/* =========================================================================
   AI 催办文案的兜底模板（AI 失败时才用）
   ========================================================================= */

/* 催办文案的确定性收口：截止时间、可点链接必须出现。
   AI 偶尔只写「提醒你带护照」不写截止，这在一份 48h 要被回执的通知上是硬伤，
   所以在返回前无条件校验一次，缺了就补在开头（文案其余部分不动）。 */
const DEADLINE_LABEL = {
  zh: '截止：',
  en: 'Deadline: ',
  ru: 'Срок: ',
  vi: 'Hạn chót: ',
  th: 'กำหนด: ',
  id: 'Tenggat: '
}
const DEADLINE_RE = /(deadline|due\b|before|by the|截止|срок|дедлайн|hạn|กำหนด|tenggat|期限)/i

function ensureNudgeEssentials(text, notice, lang, link) {
  let out = str(text).trim()
  const s = notice?.structured || {}

  if (!DEADLINE_RE.test(out)) {
    const tr = notice?.translations?.[lang] || {}
    let when = str(tr.deadline_text) || str(s?.deadline?.raw)
    if (!when && s?.deadline?.iso) when = str(s.deadline.iso).slice(0, 16).replace('T', ' ')
    if (when) out = `${DEADLINE_LABEL[lang] || DEADLINE_LABEL.en}${when}\n\n${out}`
  }

  if (link && !out.includes(link)) out = `${out}\n${link}`
  return out
}

function fallbackNudgeText({ notice, targets, lang, tone, tier, link }) {
  const title = str(notice?.title_zh) || '通知'
  const n = targets.length
  const deadline = str(notice?.structured?.deadline?.raw)
  const h = hoursLeft(notice?.deadline_at)
  const names = targets
    .slice(0, 10)
    .map((t) => t.name)
    .filter(Boolean)
  const at = names.length && n <= 10 ? `（@${names.join('、@')}）` : ''
  const firm = tone === 'firm'
  const hello = firm ? '请注意' : '温馨提示'

  if (lang === 'en') {
    const head = firm ? 'Reminder' : 'Gentle reminder'
    return [
      `${head}: ${n} students have not confirmed "${title}".${at}`,
      deadline ? `Deadline: ${deadline}${h !== null ? ` (${h} hours left)` : ''}.` : '',
      `Open the card and confirm in 30 seconds: ${link}`
    ]
      .filter(Boolean)
      .join(' ')
  }
  if (lang === 'ru') {
    return [
      `${firm ? 'Напоминание' : 'Дружеское напоминание'}: ${n} студентов ещё не подтвердили «${title}».${at}`,
      deadline ? `Срок: ${deadline}${h !== null ? ` (осталось ${h} ч.)` : ''}.` : '',
      `Откройте карточку и подтвердите за 30 секунд: ${link}`
    ]
      .filter(Boolean)
      .join(' ')
  }

  const tail =
    tier === 'help'
      ? '他们说有困难，需要你单独联系。'
      : firm
        ? '请于截止前完成，逾期后果自负。'
        : '请抽 30 秒看一下并点确认。'
  return [
    `【${hello}】《${title}》还有 ${n} 位同学没有确认。${at}`,
    deadline ? `截止：${deadline}${h !== null ? `（还剩约 ${h} 小时）` : ''}。` : '',
    tail,
    `点开卡片，30 秒看完并确认：${link}`
  ]
    .filter(Boolean)
    .join('')
}
