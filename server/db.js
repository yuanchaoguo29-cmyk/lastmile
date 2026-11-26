/* SQLite 连接 + 建表 —— 冻结。
   用 Node 24 内置的 node:sqlite，零原生依赖。 */

import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { hashPassword, DEFAULT_STAFF_PASSWORD } from './crypto.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const DATA_DIR = path.join(ROOT, 'data')
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'lastmile.db')
const SCHEMA_PATH = path.join(ROOT, 'docs', 'schema.sql')

export let db = null

export function initDb() {
  if (db) return db
  fs.mkdirSync(DATA_DIR, { recursive: true })
  db = new DatabaseSync(DB_PATH)
  const schema = fs.readFileSync(SCHEMA_PATH, 'utf8')
  try {
    db.exec(schema)
  } catch (e) {
    // 老库：schema 末尾的索引引用了新列，先补列再重跑一次（CREATE ... IF NOT EXISTS 可重入）
    console.warn('[db] schema 首次执行失败，补列后重试：', e?.message || e)
    migrate(db)
    db.exec(schema)
  }
  migrate(db)
  console.log(`[db] ${DB_PATH}`)
  return db
}

/** v2 新增列：老库缺什么补什么（ALTER TABLE 只加列，不丢数据） */
const ADDED_COLUMNS = {
  students: {
    nationality: 'TEXT',
    email: 'TEXT',
    degree: 'TEXT',
    grade: 'TEXT',
    owner_staff_id: 'TEXT'
  },
  notices: {
    owner_staff_id: 'TEXT',
    target_ids: 'TEXT'
  },
  staff: {
    parent_id: 'TEXT',
    email: 'TEXT',
    email_from: 'TEXT',
    email_provider: 'TEXT',
    email_api_key: 'TEXT',
    username: 'TEXT',
    pwd_hash: 'TEXT',
    pwd_salt: 'TEXT'
  }
}

/** 增量迁移：老库没有的列在这里补，补完不丢数据 */
function migrate(d) {
  try {
    const cols = d.prepare('PRAGMA table_info(students)').all().map((c) => String(c.name))
    if (!cols.includes('is_demo')) {
      d.exec('ALTER TABLE students ADD COLUMN is_demo INTEGER NOT NULL DEFAULT 0')
      // 加列之前存在名单里的，只可能是内置的示例学生
      d.exec('UPDATE students SET is_demo = 1')
      console.log('[db] migrated: students.is_demo（历史名单已标记为示例学生）')
    }

    for (const [table, columns] of Object.entries(ADDED_COLUMNS)) {
      const have = new Set(d.prepare(`PRAGMA table_info(${table})`).all().map((c) => String(c.name)))
      for (const [name, type] of Object.entries(columns)) {
        if (have.has(name)) continue
        d.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`)
        console.log(`[db] migrated: ${table}.${name}`)
      }
    }

    backfillStaffLogin(d)
  } catch (e) {
    console.error('[db] 迁移失败（继续）：', e?.message || e)
  }
}

/** 老库里的辅导员/助理只有 access_key、没有账号名和密码：
    补一个「账号名 = 姓名」+ 默认密码，免得升级后这些人直接登不进来。
    账号名撞车就加 -2/-3 后缀；owner 的隐藏配置行（id='owner'）不参与。 */
function backfillStaffLogin(d) {
  try {
    const rows = d
      .prepare("SELECT id, name FROM staff WHERE role <> 'owner' AND (username IS NULL OR username = '')")
      .all()
    if (!rows.length) return
    const taken = new Set(
      d
        .prepare('SELECT username FROM staff WHERE username IS NOT NULL AND username <> \'\'')
        .all()
        .map((r) => String(r.username))
    )
    const setUsername = d.prepare('UPDATE staff SET username = ? WHERE id = ?')
    const setPwd = d.prepare('UPDATE staff SET pwd_hash = ?, pwd_salt = ? WHERE id = ?')
    let n = 0
    for (const row of rows) {
      const base = String(row.name || '').trim().slice(0, 24) || `staff_${String(row.id).slice(-6)}`
      let username = base
      for (let k = 2; taken.has(username); k++) username = `${base}-${k}`
      taken.add(username)
      const { hash, salt } = hashPassword(DEFAULT_STAFF_PASSWORD)
      setUsername.run(username, row.id)
      setPwd.run(hash, salt, row.id)
      n++
    }
    if (n) {
      console.log(
        `[db] migrated: ${n} 个旧账号补了 username（= 姓名）与默认密码 ${DEFAULT_STAFF_PASSWORD}，请提醒本人登录后修改`
      )
    }
  } catch (e) {
    console.error('[db] 旧账号补 username 失败（继续）：', e?.message || e)
  }
}

export function getDb() {
  if (!db) initDb()
  return db
}

/** 事务包装：fn 抛错自动回滚 */
export function tx(fn) {
  const d = getDb()
  d.exec('BEGIN')
  try {
    const out = fn(d)
    d.exec('COMMIT')
    return out
  } catch (e) {
    try {
      d.exec('ROLLBACK')
    } catch {}
    throw e
  }
}

export const nowIso = () => new Date().toISOString()
export const uid = (p = 'id') => `${p}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`
