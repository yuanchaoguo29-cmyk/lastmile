/* LastMile 数据访问层 —— 归属 A（后端）。
   契约见 docs/modules.md。
   约定：
     - 全部走 prepared statement（按 SQL 文本缓存，进程内复用）；
     - JSON.parse 只在「读出时」，JSON.stringify 只在「写入时」；
     - notices 行对象的 structured / quiz / translations / risk_flags 返回已解析对象；
     - 时间一律 ISO8601 字符串，由调用方给，repo 不自己编时间（除非没传）。 */

import { getDb, nowIso, uid } from './db.js'

const NOTICE_COLS =
  'id, created_at, published_at, status, owner, raw_text, sent_at, kind, title_zh, deadline_at, structured, quiz, translations, risk_flags'

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

/** 把 sqlite 的 null-prototype 行对象变成普通对象，方便 JSON 序列化 / 展开 */
const plain = (row) => (row ? { ...row } : null)
const plainAll = (rows) => (rows || []).map((r) => ({ ...r }))

/* ---------- 行映射 ---------- */

/** notices 行 → Notice（JSON 字段已解析） */
function mapNotice(row) {
  if (!row) return null
  const n = { ...row }
  n.structured = parseJson(n.structured, {})
  n.quiz = parseJson(n.quiz, null)
  n.translations = parseJson(n.translations, {})
  n.risk_flags = parseJson(n.risk_flags, [])
  return n
}

/* ---------- notices ---------- */

/** 建通知。input 可含 id / created_at / status / published_at / owner / raw_text / sent_at /
    kind / title_zh / deadline_at / structured / quiz / translations / risk_flags */
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

  q(
    `INSERT INTO notices (${NOTICE_COLS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    id,
    createdAt,
    nn(publishedAt),
    status,
    nn(input.owner),
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

/** 全部通知，新的在前 */
function listNotices() {
  return q(`SELECT ${NOTICE_COLS} FROM notices ORDER BY created_at DESC`).all().map(mapNotice)
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

/** 看板计数：roster 取 students 总人数，其余从 receipts 派生，unread = roster - seen */
function counts(noticeId) {
  const rosterRow = q('SELECT COUNT(*) AS c FROM students').get()
  const roster = Number(rosterRow?.c || 0)
  const r =
    q(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN first_seen_at  IS NOT NULL THEN 1 ELSE 0 END) AS seen,
         SUM(CASE WHEN quiz_passed_at IS NOT NULL THEN 1 ELSE 0 END) AS quiz_passed,
         SUM(CASE WHEN confirmed_at   IS NOT NULL THEN 1 ELSE 0 END) AS confirmed,
         SUM(CASE WHEN help_at        IS NOT NULL THEN 1 ELSE 0 END) AS help
       FROM receipts WHERE notice_id = ?`
    ).get(String(noticeId)) || {}

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

function listStudents() {
  return plainAll(q('SELECT * FROM students ORDER BY student_id ASC').all())
}

function getStudent(studentId) {
  if (!studentId) return null
  return plain(q('SELECT * FROM students WHERE student_id = ?').get(String(studentId)))
}

/** 名单 LEFT JOIN 回执，看板用（status 由这里算，保证「已确认 / 求助 / 只看到 / 未读」四态一致） */
function rosterWithReceipts(noticeId) {
  const rows = plainAll(
    q(
      `SELECT s.student_id, s.name, s.name_en, s.lang, s.class_no, s.cohort,
              r.first_seen_at, r.quiz_passed_at, r.confirmed_at, r.help_at, r.help_message,
              r.lang AS receipt_lang,
              (SELECT COUNT(*) FROM quiz_attempts qa
                WHERE qa.notice_id = ? AND qa.student_id = s.student_id AND qa.correct = 1) AS quiz_correct
       FROM students s
       LEFT JOIN receipts r ON r.notice_id = ? AND r.student_id = s.student_id
       ORDER BY s.student_id ASC`
    ).all(String(noticeId), String(noticeId))
  )
  return rows.map((r) => ({
    ...r,
    status: r.confirmed_at ? 'confirmed' : r.help_at ? 'help' : r.first_seen_at ? 'seen' : 'unread',
    quiz_ok: Boolean(r.quiz_passed_at || Number(r.quiz_correct || 0) > 0)
  }))
}

/* ---------- staff（辅导员 + 助理账号） ---------- */

function listStaff() {
  return plainAll(
    q(
      'SELECT id, name, role, active, created_at, last_seen_at, access_key FROM staff ORDER BY created_at ASC'
    ).all()
  )
}

function getStaff(id) {
  return plain(q('SELECT * FROM staff WHERE id = ?').get(String(id)))
}

function getStaffByKey(key) {
  if (!key) return null
  return plain(q('SELECT * FROM staff WHERE access_key = ? AND active = 1').get(String(key)))
}

function createStaffRow(row) {
  const id = row.id || uid('stf')
  q(
    `INSERT INTO staff (id, name, access_key, role, active, created_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL)`
  ).run(id, String(row.name), String(row.access_key), row.role || 'assistant', 1, row.created_at || nowIso())
  return getStaff(id)
}

function updateStaffRow(id, patch = {}) {
  const sets = []
  const vals = []
  if (patch.name !== undefined) {
    sets.push('name = ?')
    vals.push(String(patch.name))
  }
  if (patch.access_key !== undefined) {
    sets.push('access_key = ?')
    vals.push(String(patch.access_key))
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

function deleteStaffRow(id) {
  q('DELETE FROM staff WHERE id = ?').run(String(id))
}

/* ---------- roster 导入 ---------- */

function countStudents() {
  const r = q('SELECT COUNT(*) AS c FROM students').get()
  return Number(r?.c || 0)
}

function countDemoStudents() {
  const r = q('SELECT COUNT(*) AS c FROM students WHERE is_demo = 1').get()
  return Number(r?.c || 0)
}

/** 返回 'added' | 'updated' */
function upsertStudent(s) {
  const sid = String(s.student_id || '').trim()
  if (!sid) return 'skipped'
  const existed = q('SELECT 1 AS x FROM students WHERE student_id = ?').get(sid)
  q(
    `INSERT INTO students (student_id, name, name_en, lang, class_no, cohort, is_demo)
     VALUES (?, ?, ?, ?, ?, ?, 0)
     ON CONFLICT(student_id) DO UPDATE SET
       name      = COALESCE(NULLIF(excluded.name, ''), students.name),
       name_en   = COALESCE(NULLIF(excluded.name_en, ''), students.name_en),
       lang      = COALESCE(NULLIF(excluded.lang, ''), students.lang),
       class_no  = COALESCE(NULLIF(excluded.class_no, ''), students.class_no),
       cohort    = COALESCE(NULLIF(excluded.cohort, ''), students.cohort),
       is_demo   = 0`
  ).run(sid, s.name ?? null, s.name_en ?? null, s.lang ?? null, s.class_no ?? null, s.cohort ?? null)
  return existed ? 'updated' : 'added'
}

function deleteAllStudents() {
  const before = countStudents()
  q('DELETE FROM students').run()
  return before
}

function deleteDemoStudents() {
  const before = countStudents()
  q('DELETE FROM students WHERE is_demo = 1').run()
  return before - countStudents()
}

/** 只删导入进来的真实学生，示例学生留着 */
function deleteImportedStudents() {
  const before = countStudents()
  q('DELETE FROM students WHERE is_demo = 0').run()
  return before - countStudents()
}

function insertStudentsBulk(rows) {
  let added = 0
  let updated = 0
  let skipped = 0
  for (const s of rows) {
    const r = upsertStudent(s)
    if (r === 'added') added++
    else if (r === 'updated') updated++
    else skipped++
  }
  return { added, updated, skipped }
}

/** 恢复内置示例名单（is_demo = 1，不会被当成真实学生） */
function insertDemoStudents(rows) {
  let n = 0
  for (const s of rows) {
    const sid = String(s.student_id || '').trim()
    if (!sid) continue
    q(
      `INSERT INTO students (student_id, name, name_en, lang, class_no, cohort, is_demo)
       VALUES (?, ?, ?, ?, ?, ?, 1)
       ON CONFLICT(student_id) DO UPDATE SET is_demo = 1`
    ).run(sid, s.name ?? null, s.name_en ?? null, s.lang ?? null, s.class_no ?? null, s.cohort ?? null)
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
  getStaffByKey,
  createStaff: createStaffRow,
  updateStaff: updateStaffRow,
  deleteStaff: deleteStaffRow,
  // 扩展（看板用，不属于冻结契约但同样只在 repo 里写 SQL）
  rosterWithReceipts
}

export default repo
