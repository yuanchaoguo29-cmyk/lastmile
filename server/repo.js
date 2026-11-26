/* LastMile 数据访问层 —— 归属 A（后端）。
   契约见 docs/modules.md。
   约定：
     - 全部走 prepared statement（按 SQL 文本缓存，进程内复用）；
     - JSON.parse 只在「读出时」，JSON.stringify 只在「写入时」；
     - notices 行对象的 structured / quiz / translations / risk_flags 返回已解析对象；
     - 时间一律 ISO8601 字符串，由调用方给，repo 不自己编时间（除非没传）。 */

import { getDb, nowIso, uid } from './db.js'

const NOTICE_COLS =
  'id, created_at, published_at, status, owner, owner_staff_id, target_ids, raw_text, sent_at, kind, title_zh, deadline_at, structured, quiz, translations, risk_flags'

/* ---------- prepared statement 缓存 ---------- */

const stmtCache = new Map()

/** 取（或首次准备）一条 SQL 的 statement */
function q(text) {
  let s = stmtCache.get(text)
  if (!s) {
    s = getDb().prepare(text)
    stmtCache.set(text, s)
  }
  return s
}

/* ---------- 类型边界工具 ---------- */

/** 读出时的 JSON 解析（容忍 null / 空串 / 已经是对象） */
function parseJson(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback
  if (typeof value === 'object') return value
  try {
    const out = JSON.parse(value)
    return out === null || out === undefined ? fallback : out
  } catch {
    return fallback
  }
}

/** 写入时的 JSON 序列化（字符串原样写、null/undefined 写 null） */
function toJson(value) {
  if (value === null || value === undefined) return null
  return typeof value === 'string' ? value : JSON.stringify(value)
}

/** 对象化：既接受对象，也接受 JSON 字符串 */
function toObj(value, fallback) {
  if (value && typeof value === 'object') return value
  if (typeof value === 'string') return parseJson(value, fallback)
  return fallback
}

/** node:sqlite 不接受 undefined 作为绑定参数 */
const nn = (v) => (v === undefined ? null : v)

/** 目标学号列表：NULL / [] 都表示「名下全部」，返回去重后的字符串数组或 null */
function parseTargetIds(raw) {
  const arr = parseJson(raw, null)
  if (!Array.isArray(arr)) return null
  const ids = [...new Set(arr.map((v) => String(v ?? '').trim()).filter(Boolean))]
  return ids.length ? ids : null
}

/** 可见范围条件：scope = null（owner，全部）或 staff id（只看该账号名下的学生）。
    作用在 students 表的列上，用于拼进 WHERE。 */
function scopeConds(scope, targets, alias = '') {
  const p = alias ? `${alias}.` : ''
  const conds = []
  const vals = []
  if (targets && targets.length) {
    conds.push(`${p}student_id IN (${targets.map(() => '?').join(',')})`)
    vals.push(...targets)
  }
  if (scope !== null && scope !== undefined) {
    conds.push(`${p}owner_staff_id = ?`)
    vals.push(String(scope))
  }
  return { conds, vals }
}

/** 同上，但转成「student_id 落在可见学生里」的子查询，用于 receipts 这类只有 student_id 的表 */
function visibleStudentSubquery(scope, targets) {
  const { conds, vals } = scopeConds(scope, targets)
  if (!conds.length) return { sql: '', vals: [] }
  return { sql: ` AND student_id IN (SELECT student_id FROM students WHERE ${conds.join(' AND ')})`, vals }
}

/** 把 sqlite 的 null-prototype 行对象变成普通对象，方便 JSON 序列化 / 展开 */
const plain = (row) => (row ? { ...row } : null)
const plainAll = (rows) => (rows || []).map((r) => ({ ...r }))

/* ---------- 行映射 ---------- */

/** notices 行 → Notice（JSON 字段已解析；target_ids 是数组或 null） */
function mapNotice(row) {
  if (!row) return null
  const n = { ...row }
  n.structured = parseJson(n.structured, {})
  n.quiz = parseJson(n.quiz, null)
  n.translations = parseJson(n.translations, {})
  n.risk_flags = parseJson(n.risk_flags, [])
  n.target_ids = parseTargetIds(n.target_ids)
  return n
}

/* ---------- notices ---------- */

/** 建通知。input 可含 id / created_at / status / published_at / owner / owner_staff_id /
    raw_text / sent_at / kind / title_zh / deadline_at / structured / quiz / translations /
    risk_flags / target_ids（数组，空数组或 null = 发给名下全部学生） */
function createNotice(input = {}) {
  const s = toObj(input.structured, {})
  const id = input.id || uid('ntc')
  const createdAt = input.created_at || nowIso()
  const status = input.status || 'draft'
  const rawText = String(
    nn(input.raw_text) ?? nn(input.rawText) ?? s.raw_text ?? s.what ?? s.title_zh ?? ''
  )
  const kind = input.kind || s.kind || 'general'
  const titleZh = input.title_zh || s.title_zh || ''
  const deadlineAt =
    input.deadline_at !== undefined ? input.deadline_at : s?.deadline?.iso || null
  const riskFlags = input.risk_flags !== undefined ? input.risk_flags : s.risk_flags || []
  const publishedAt =
    input.published_at !== undefined ? input.published_at : status === 'published' ? createdAt : null
  const targets = parseTargetIds(input.target_ids)

  q(
    `INSERT INTO notices (${NOTICE_COLS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    id,
    createdAt,
    nn(publishedAt),
    status,
    nn(input.owner),
    nn(input.owner_staff_id),
    targets ? JSON.stringify(targets) : null,
    rawText,
    nn(input.sent_at),
    kind,
    titleZh,
    nn(deadlineAt),
    toJson(s) || '{}',
    toJson(input.quiz),
    toJson(input.translations === undefined ? {} : input.translations),
    toJson(riskFlags || [])
  )
  return getNotice(id)
}

/** 局部更新通知。只写 patch 里出现的字段（hasOwnProperty 判断），其 JSON 字段自动序列化。 */
function updateNotice(id, patch = {}) {
  const has = (k) => Object.prototype.hasOwnProperty.call(patch, k)
  const sets = []
  const vals = []

  // 普通文本字段
  for (const col of [
    'status',
    'owner',
    'owner_staff_id',
    'raw_text',
    'sent_at',
    'kind',
    'title_zh',
    'published_at'
  ]) {
    if (has(col)) {
      sets.push(`${col} = ?`)
      vals.push(nn(patch[col]))
    }
  }
  // 目标学号：null / [] 都写 NULL（= 名下全部）
  if (has('target_ids')) {
    sets.push('target_ids = ?')
    const ids = parseTargetIds(patch.target_ids)
    vals.push(ids ? JSON.stringify(ids) : null)
  }
  // 可空时间
  if (has('deadline_at')) {
    sets.push('deadline_at = ?')
    vals.push(nn(patch.deadline_at))
  }
  // JSON 字段
  if (has('structured')) {
    sets.push('structured = ?')
    vals.push(toJson(patch.structured) || '{}')
    // structured 变了，顺带同步 headline 字段（除非显式覆盖）
    if (!has('title_zh') && patch.structured?.title_zh !== undefined) {
      sets.push('title_zh = ?')
      vals.push(patch.structured.title_zh)
    }
    if (!has('kind') && patch.structured?.kind) {
      sets.push('kind = ?')
      vals.push(patch.structured.kind)
    }
    if (!has('deadline_at')) {
      sets.push('deadline_at = ?')
      vals.push(nn(patch.structured?.deadline?.iso ?? null))
    }
    if (!has('risk_flags') && Array.isArray(patch.structured?.risk_flags)) {
      sets.push('risk_flags = ?')
      vals.push(toJson(patch.structured.risk_flags))
    }
  }
  if (has('quiz')) {
    sets.push('quiz = ?')
    vals.push(toJson(patch.quiz))
  }
  if (has('translations')) {
    sets.push('translations = ?')
    vals.push(toJson(patch.translations) || '{}')
  }
  if (has('risk_flags')) {
    sets.push('risk_flags = ?')
    vals.push(toJson(patch.risk_flags) || '[]')
  }

  if (sets.length) {
    vals.push(id)
    q(`UPDATE notices SET ${sets.join(', ')} WHERE id = ?`).run(...vals)
  }
  return getNotice(id)
}

/** 读一份通知；不存在返回 null */
function getNotice(id) {
  if (!id) return null
  return mapNotice(plain(q(`SELECT ${NOTICE_COLS} FROM notices WHERE id = ?`).get(String(id))))
}

/** 通知列表，新的在前。scope = null（owner）看全部；否则只看该账号名下发布的 */
function listNotices(scope = null) {
  if (scope === null || scope === undefined) {
    return q(`SELECT ${NOTICE_COLS} FROM notices ORDER BY created_at DESC`).all().map(mapNotice)
  }
  return q(`SELECT ${NOTICE_COLS} FROM notices WHERE owner_staff_id = ? ORDER BY created_at DESC`)
    .all(String(scope))
    .map(mapNotice)
}

/** 删一份通知：回执、小测记录、拒绝日志、事件一并清掉（一个事务里做完） */
function deleteNotice(id) {
  const nid = String(id || '')
  if (!nid) return null
  const existed = q('SELECT 1 AS x FROM notices WHERE id = ?').get(nid)
  if (!existed) return null

  const before = {
    receipts: Number(q('SELECT COUNT(*) AS c FROM receipts WHERE notice_id = ?').get(nid)?.c || 0),
    events: Number(q('SELECT COUNT(*) AS c FROM events WHERE notice_id = ?').get(nid)?.c || 0),
    refusals: Number(q('SELECT COUNT(*) AS c FROM refusals WHERE notice_id = ?').get(nid)?.c || 0)
  }

  const d = getDb()
  d.exec('BEGIN')
  try {
    q('DELETE FROM receipts WHERE notice_id = ?').run(nid)
    q('DELETE FROM quiz_attempts WHERE notice_id = ?').run(nid)
    q('DELETE FROM refusals WHERE notice_id = ?').run(nid)
    q('DELETE FROM events WHERE notice_id = ?').run(nid)
    q('DELETE FROM notices WHERE id = ?').run(nid)
    d.exec('COMMIT')
  } catch (e) {
    try {
      d.exec('ROLLBACK')
    } catch {}
    throw e
  }
  return before
}

/* ---------- receipts ---------- */

/** 只填 patch 里给的字段；已有值绝不因 null 被覆盖（first_seen_at 保持第一次） */
function upsertReceipt(noticeId, studentId, patch = {}) {
  const p = patch || {}
  const id = uid('rcp')
  q(
    `INSERT INTO receipts
       (id, notice_id, student_id, name, lang, first_seen_at, quiz_passed_at, confirmed_at, help_at, help_message, ua, ip)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(notice_id, student_id) DO UPDATE SET
       name           = COALESCE(excluded.name, receipts.name),
       lang           = COALESCE(excluded.lang, receipts.lang),
       first_seen_at  = COALESCE(receipts.first_seen_at, excluded.first_seen_at),
       quiz_passed_at = COALESCE(excluded.quiz_passed_at, receipts.quiz_passed_at),
       confirmed_at   = COALESCE(excluded.confirmed_at, receipts.confirmed_at),
       help_at        = COALESCE(excluded.help_at, receipts.help_at),
       help_message   = COALESCE(excluded.help_message, receipts.help_message),
       ua             = COALESCE(excluded.ua, receipts.ua),
       ip             = COALESCE(excluded.ip, receipts.ip)`
  ).run(
    id,
    String(noticeId),
    String(studentId),
    nn(p.name),
    nn(p.lang),
    nn(p.first_seen_at),
    nn(p.quiz_passed_at),
    nn(p.confirmed_at),
    nn(p.help_at),
    nn(p.help_message),
    nn(p.ua),
    nn(p.ip)
  )
  return getReceipt(noticeId, studentId)
}

function getReceipt(noticeId, studentId) {
  if (!noticeId || !studentId) return null
  return plain(
    q('SELECT * FROM receipts WHERE notice_id = ? AND student_id = ?').get(
      String(noticeId),
      String(studentId)
    )
  )
}

function listReceipts(noticeId) {
  return plainAll(
    q(
      `SELECT * FROM receipts WHERE notice_id = ?
       ORDER BY COALESCE(confirmed_at, help_at, first_seen_at) ASC, student_id ASC`
    ).all(String(noticeId))
  )
}

/** 看板计数：roster 取「目标学生数」（target_ids 为空 = 可见学生数），
    其余从 receipts 派生，unread = roster - seen。
    scope 与通知的目标一起决定分母，保证看板不会出现 confirmed > roster。 */
function counts(noticeId, scope = null) {
  const nid = String(noticeId)
  const row = q('SELECT target_ids FROM notices WHERE id = ?').get(nid)
  const targets = parseTargetIds(row?.target_ids)
  const roster = countStudents(scope, targets)

  const sub = visibleStudentSubquery(scope, targets)
  const r =
    q(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN first_seen_at  IS NOT NULL THEN 1 ELSE 0 END) AS seen,
         SUM(CASE WHEN quiz_passed_at IS NOT NULL THEN 1 ELSE 0 END) AS quiz_passed,
         SUM(CASE WHEN confirmed_at   IS NOT NULL THEN 1 ELSE 0 END) AS confirmed,
         SUM(CASE WHEN help_at        IS NOT NULL THEN 1 ELSE 0 END) AS help
       FROM receipts WHERE notice_id = ?${sub.sql}`
    ).get(nid, ...sub.vals) || {}

  const seen = Number(r.seen || 0)
  return {
    roster,
    seen,
    quiz_passed: Number(r.quiz_passed || 0),
    confirmed: Number(r.confirmed || 0),
    help: Number(r.help || 0),
    unread: Math.max(0, roster - seen)
  }
}

/* ---------- quiz attempts ---------- */

function addQuizAttempt(noticeId, studentId, choice, correct) {
  q(
    `INSERT INTO quiz_attempts (id, notice_id, student_id, choice, correct, created_at)
     VALUES (?,?,?,?,?,?)`
  ).run(
    uid('qat'),
    String(noticeId),
    nn(studentId === undefined || studentId === '' ? null : studentId),
    choice === null || choice === undefined ? null : Number(choice),
    correct ? 1 : 0,
    nowIso()
  )
}

/** 某学生对某通知的答题次数（studentId 为 null 时统计匿名次数） */
function quizAttemptCount(noticeId, studentId) {
  const row = q(
    'SELECT COUNT(*) AS c FROM quiz_attempts WHERE notice_id = ? AND student_id IS ?'
  ).get(String(noticeId), nn(studentId === '' ? null : studentId))
  return Number(row?.c || 0)
}

/* ---------- refusals ---------- */

function addRefusal(noticeId, studentId, question, reasonCode) {
  q(
    `INSERT INTO refusals (id, notice_id, student_id, question, reason_code, created_at)
     VALUES (?,?,?,?,?,?)`
  ).run(
    uid('rfs'),
    nn(noticeId),
    nn(studentId === '' ? null : studentId),
    nn(question),
    nn(reasonCode || 'out_of_scope'),
    nowIso()
  )
}

function listRefusals(noticeId, limit = 50) {
  return plainAll(
    q(
      `SELECT * FROM refusals WHERE notice_id = ?
       ORDER BY created_at DESC LIMIT ?`
    ).all(String(noticeId), Number(limit) || 50)
  )
}

/* ---------- events ---------- */

function addEvent(noticeId, studentId, type, payload) {
  q(
    `INSERT INTO events (id, notice_id, student_id, type, payload, created_at)
     VALUES (?,?,?,?,?,?)`
  ).run(
    uid('evt'),
    nn(noticeId),
    nn(studentId === undefined || studentId === '' ? null : studentId),
    nn(type),
    payload === undefined ? null : toJson(payload),
    nowIso()
  )
}

function listEvents(noticeId, limit = 100) {
  const rows = plainAll(
    q(
      `SELECT * FROM events WHERE notice_id = ?
       ORDER BY created_at DESC LIMIT ?`
    ).all(String(noticeId), Number(limit) || 100)
  )
  return rows.map((e) => ({ ...e, payload: parseJson(e.payload, null) }))
}

/* ---------- roster ---------- */

/** 转义 LIKE 里的通配符，避免搜「100%」把整张表都搜出来 */
const likeArg = (s) => `%${String(s).replace(/[\\%_]/g, (m) => '\\' + m)}%`

/** 名单查询。opts: { scope, q, degree, grade, lang, class_no }
    scope = null（owner）看全部，否则只看 owner_staff_id = scope 的学生 */
function listStudents(opts = {}) {
  const { scope = null, q: kw, degree, grade, lang, class_no } = opts || {}
  const { conds, vals } = scopeConds(scope, null)
  const text = String(kw ?? '').trim()
  if (text) {
    conds.push(`(student_id LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\' OR name_en LIKE ? ESCAPE '\\')`)
    const like = likeArg(text)
    vals.push(like, like, like)
  }
  for (const [col, value] of [
    ['degree', degree],
    ['grade', grade],
    ['lang', lang],
    ['class_no', class_no]
  ]) {
    const v = String(value ?? '').trim()
    if (!v) continue
    conds.push(`${col} = ?`)
    vals.push(v)
  }
  const where = conds.length ? ` WHERE ${conds.join(' AND ')}` : ''
  return plainAll(q(`SELECT * FROM students${where} ORDER BY student_id ASC`).all(...vals))
}

function getStudent(studentId) {
  if (!studentId) return null
  return plain(q('SELECT * FROM students WHERE student_id = ?').get(String(studentId)))
}

/** 按学号批量取，且必须落在可见范围内（发通知时校验 target_ids 用） */
function getStudentsByIds(ids, scope = null) {
  const list = [...new Set((Array.isArray(ids) ? ids : []).map((v) => String(v ?? '').trim()).filter(Boolean))]
  if (!list.length) return []
  const { conds, vals } = scopeConds(scope, list)
  return plainAll(
    q(`SELECT * FROM students WHERE ${conds.join(' AND ')} ORDER BY student_id ASC`).all(...vals)
  )
}

/** 名单 LEFT JOIN 回执，看板用（status 由这里算，保证「已确认 / 求助 / 只看到 / 未读」四态一致）。
    只返回通知的目标学生（target_ids 为空 = 范围内全部学生）。 */
function rosterWithReceipts(noticeId, scope = null) {
  const nid = String(noticeId)
  const row = q('SELECT target_ids FROM notices WHERE id = ?').get(nid)
  const targets = parseTargetIds(row?.target_ids)
  const { conds, vals } = scopeConds(scope, targets, 's')
  const where = conds.length ? ` WHERE ${conds.join(' AND ')}` : ''
  const rows = plainAll(
    q(
      `SELECT s.student_id, s.name, s.name_en, s.lang, s.class_no, s.cohort,
              s.nationality, s.email, s.degree, s.grade,
              r.first_seen_at, r.quiz_passed_at, r.confirmed_at, r.help_at, r.help_message,
              r.lang AS receipt_lang,
              (SELECT COUNT(*) FROM quiz_attempts qa
                WHERE qa.notice_id = ? AND qa.student_id = s.student_id AND qa.correct = 1) AS quiz_correct
       FROM students s
       LEFT JOIN receipts r ON r.notice_id = ? AND r.student_id = s.student_id${where}
       ORDER BY s.student_id ASC`
    ).all(nid, nid, ...vals)
  )
  return rows.map((r) => ({
    ...r,
    status: r.confirmed_at ? 'confirmed' : r.help_at ? 'help' : r.first_seen_at ? 'seen' : 'unread',
    quiz_ok: Boolean(r.quiz_passed_at || Number(r.quiz_correct || 0) > 0)
  }))
}

/* ---------- staff（辅导员 + 助理账号） ---------- */

/** 全部账号（含 parent_id / 邮箱绑定信息）。给 owner 账号用的隐藏行也在这里返回，
    权限过滤由 api 层按角色做（SQL 不该知道 HTTP 语义）。
    注意：不返回 pwd_hash / pwd_salt —— 列表接口没有任何理由碰密码派生值。 */
function listStaff() {
  return plainAll(
    q(
      `SELECT id, name, username, role, active, created_at, last_seen_at, access_key,
              parent_id, email, email_from, email_provider, email_api_key
         FROM staff ORDER BY created_at ASC`
    ).all()
  )
}

function getStaff(id) {
  if (!id) return null
  return plain(q('SELECT * FROM staff WHERE id = ?').get(String(id)))
}

/** 按账号名取（含未启用的行：调用方自行判断 active，建号时也用它查重） */
function getStaffByUsername(username) {
  const u = String(username ?? '').trim()
  if (!u) return null
  return plain(q('SELECT * FROM staff WHERE username = ?').get(u))
}

/** 建账号。row 可含 id / name / username / pwd_hash / pwd_salt / access_key / role / active /
    created_at / parent_id / email / email_from / email_provider / email_api_key
    access_key 只为兼容旧库的 NOT NULL 约束，默认写空串，不参与登录。 */
function createStaffRow(row = {}) {
  const id = row.id || uid('stf')
  q(
    `INSERT INTO staff
       (id, name, username, pwd_hash, pwd_salt, access_key, role, active, created_at, parent_id,
        email, email_from, email_provider, email_api_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    String(row.name),
    nn(row.username),
    nn(row.pwd_hash),
    nn(row.pwd_salt),
    String(row.access_key ?? ''),
    row.role || 'assistant',
    row.active === undefined ? 1 : row.active ? 1 : 0,
    row.created_at || nowIso(),
    nn(row.parent_id),
    nn(row.email),
    nn(row.email_from),
    nn(row.email_provider),
    nn(row.email_api_key)
  )
  return getStaff(id)
}

function updateStaffRow(id, patch = {}) {
  const sets = []
  const vals = []
  // 文本字段：null 表示清空（邮箱解绑），undefined 表示不动
  for (const col of [
    'name',
    'username',
    'pwd_hash',
    'pwd_salt',
    'access_key',
    'parent_id',
    'email',
    'email_from',
    'email_provider',
    'email_api_key'
  ]) {
    if (patch[col] === undefined) continue
    sets.push(`${col} = ?`)
    vals.push(patch[col] === null ? null : String(patch[col]))
  }
  if (patch.active !== undefined) {
    sets.push('active = ?')
    vals.push(patch.active ? 1 : 0)
  }
  if (patch.last_seen_at !== undefined) {
    sets.push('last_seen_at = ?')
    vals.push(patch.last_seen_at)
  }
  if (!sets.length) return getStaff(id)
  vals.push(String(id))
  q(`UPDATE staff SET ${sets.join(', ')} WHERE id = ?`).run(...vals)
  return getStaff(id)
}

/** 删账号：助理跟着所属辅导员一起删；他名下的学生回到「未分配」（只有总管能看见）。 */
function deleteStaffRow(id) {
  const sid = String(id)
  const d = getDb()
  let assistants = 0
  let students = 0
  d.exec('BEGIN')
  try {
    assistants = Number(q('SELECT COUNT(*) AS c FROM staff WHERE parent_id = ?').get(sid)?.c || 0)
    students = Number(q('SELECT COUNT(*) AS c FROM students WHERE owner_staff_id = ?').get(sid)?.c || 0)
    q('DELETE FROM staff WHERE parent_id = ?').run(sid)
    q('UPDATE students SET owner_staff_id = NULL WHERE owner_staff_id = ?').run(sid)
    q('DELETE FROM staff WHERE id = ?').run(sid)
    d.exec('COMMIT')
  } catch (e) {
    try {
      d.exec('ROLLBACK')
    } catch {}
    throw e
  }
  return { assistants, students }
}

/* ---------- roster 导入 ---------- */

/** 人数统计（scope = null 统计全部；给了 targets 再按学号收窄） */
function countStudents(scope = null, targets = null) {
  const { conds, vals } = scopeConds(scope, targets)
  const where = conds.length ? ` WHERE ${conds.join(' AND ')}` : ''
  const r = q(`SELECT COUNT(*) AS c FROM students${where}`).get(...vals)
  return Number(r?.c || 0)
}

function countDemoStudents(scope = null) {
  const { conds, vals } = scopeConds(scope, null)
  conds.push('is_demo = 1')
  const r = q(`SELECT COUNT(*) AS c FROM students WHERE ${conds.join(' AND ')}`).get(...vals)
  return Number(r?.c || 0)
}

/** 返回 'added' | 'updated'。
    owner 导入记 NULL（只有总管可见）；辅导员/助理导入记自己的 scope。
    已归属某个辅导员的学生不会被 owner 的一次导入「收回」，也不会被另一个辅导员抢走。 */
function upsertStudent(s, ownerStaffId = null) {
  const sid = String(s.student_id || '').trim()
  if (!sid) return 'skipped'
  const existed = q('SELECT 1 AS x FROM students WHERE student_id = ?').get(sid)
  q(
    `INSERT INTO students
       (student_id, name, name_en, lang, class_no, cohort, is_demo,
        nationality, email, degree, grade, owner_staff_id)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)
     ON CONFLICT(student_id) DO UPDATE SET
       name         = COALESCE(NULLIF(excluded.name, ''), students.name),
       name_en      = COALESCE(NULLIF(excluded.name_en, ''), students.name_en),
       lang         = COALESCE(NULLIF(excluded.lang, ''), students.lang),
       class_no     = COALESCE(NULLIF(excluded.class_no, ''), students.class_no),
       cohort       = COALESCE(NULLIF(excluded.cohort, ''), students.cohort),
       nationality  = COALESCE(NULLIF(excluded.nationality, ''), students.nationality),
       email        = COALESCE(NULLIF(excluded.email, ''), students.email),
       degree       = COALESCE(NULLIF(excluded.degree, ''), students.degree),
       grade        = COALESCE(NULLIF(excluded.grade, ''), students.grade),
       owner_staff_id = COALESCE(students.owner_staff_id, excluded.owner_staff_id),
       is_demo      = 0`
  ).run(
    sid,
    s.name ?? null,
    s.name_en ?? null,
    s.lang ?? null,
    s.class_no ?? null,
    s.cohort ?? null,
    s.nationality ?? null,
    s.email ?? null,
    s.degree ?? null,
    s.grade ?? null,
    ownerStaffId === null || ownerStaffId === undefined ? null : String(ownerStaffId)
  )
  return existed ? 'updated' : 'added'
}

/** 清空名单：owner（scope = null）清全部，辅导员只清自己名下的 */
function deleteAllStudents(scope = null) {
  const before = countStudents(scope)
  const { conds, vals } = scopeConds(scope, null)
  const where = conds.length ? ` WHERE ${conds.join(' AND ')}` : ''
  q(`DELETE FROM students${where}`).run(...vals)
  return before
}

function deleteDemoStudents(scope = null) {
  const before = countStudents(scope)
  const { conds, vals } = scopeConds(scope, null)
  conds.push('is_demo = 1')
  q(`DELETE FROM students WHERE ${conds.join(' AND ')}`).run(...vals)
  return before - countStudents(scope)
}

/** 只删导入进来的真实学生，示例学生留着 */
function deleteImportedStudents(scope = null) {
  const before = countStudents(scope)
  const { conds, vals } = scopeConds(scope, null)
  conds.push('is_demo = 0')
  q(`DELETE FROM students WHERE ${conds.join(' AND ')}`).run(...vals)
  return before - countStudents(scope)
}

function insertStudentsBulk(rows, ownerStaffId = null) {
  let added = 0
  let updated = 0
  let skipped = 0
  for (const s of rows) {
    const r = upsertStudent(s, ownerStaffId)
    if (r === 'added') added++
    else if (r === 'updated') updated++
    else skipped++
  }
  return { added, updated, skipped }
}

/** 恢复内置示例名单（is_demo = 1，owner_staff_id 一律 NULL —— 只有总管看得见） */
function insertDemoStudents(rows) {
  let n = 0
  for (const s of rows) {
    const sid = String(s.student_id || '').trim()
    if (!sid) continue
    q(
      `INSERT INTO students
         (student_id, name, name_en, lang, class_no, cohort, is_demo,
          nationality, email, degree, grade, owner_staff_id)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, NULL)
       ON CONFLICT(student_id) DO UPDATE SET
         is_demo     = 1,
         nationality = COALESCE(NULLIF(excluded.nationality, ''), students.nationality),
         email       = COALESCE(NULLIF(excluded.email, ''), students.email),
         degree      = COALESCE(NULLIF(excluded.degree, ''), students.degree),
         grade       = COALESCE(NULLIF(excluded.grade, ''), students.grade)`
    ).run(
      sid,
      s.name ?? null,
      s.name_en ?? null,
      s.lang ?? null,
      s.class_no ?? null,
      s.cohort ?? null,
      s.nationality ?? null,
      s.email ?? null,
      s.degree ?? null,
      s.grade ?? null
    )
    n++
  }
  return n
}

export const repo = {
  // notices
  createNotice,
  updateNotice,
  getNotice,
  listNotices,
  deleteNotice,
  // receipts
  upsertReceipt,
  getReceipt,
  listReceipts,
  counts,
  // quiz
  addQuizAttempt,
  quizAttemptCount,
  // refusals / events
  addRefusal,
  listRefusals,
  addEvent,
  listEvents,
  // roster
  listStudents,
  getStudent,
  getStudentsByIds,
  countStudents,
  countDemoStudents,
  upsertStudent,
  insertStudentsBulk,
  insertDemoStudents,
  deleteAllStudents,
  deleteDemoStudents,
  deleteImportedStudents,
  // staff
  listStaff,
  getStaff,
  getStaffByUsername,
  createStaff: createStaffRow,
  updateStaff: updateStaffRow,
  deleteStaff: deleteStaffRow,
  // 扩展（看板用，不属于冻结契约但同样只在 repo 里写 SQL）
  rosterWithReceipts
}

export default repo
