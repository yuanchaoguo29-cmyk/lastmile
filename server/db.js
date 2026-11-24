/* SQLite 连接 + 建表 —— 冻结。
   用 Node 24 内置的 node:sqlite，零原生依赖。 */

import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

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
  db.exec(schema)
  migrate(db)
  console.log(`[db] ${DB_PATH}`)
  return db
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
  } catch (e) {
    console.error('[db] 迁移失败（继续）：', e?.message || e)
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
