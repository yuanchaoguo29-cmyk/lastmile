-- LastMile · 最后一公里 · SQLite schema (node:sqlite DatabaseSync)
-- 冻结版 v2。任何改动必须先改本文件与 docs/api.md。

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS notices (
  id             TEXT PRIMARY KEY,
  created_at     TEXT NOT NULL,                  -- ISO8601
  published_at   TEXT,
  status         TEXT NOT NULL DEFAULT 'draft',  -- draft | published | closed
  owner          TEXT,                           -- 谁发通知谁维护（显示名）
  owner_staff_id TEXT,                           -- 归属账号（数据隔离）
  target_ids     TEXT,                           -- JSON 数组：本次发给哪些学号；NULL = 名下全部
  raw_text       TEXT NOT NULL,
  sent_at        TEXT,                           -- 原通知发出日期，用于解析「下周三」
  kind           TEXT,                           -- residence_permit|visa|medical|exam|scholarship|safety|general
  title_zh       TEXT,
  deadline_at    TEXT,
  structured     TEXT NOT NULL,                  -- JSON: StructuredNotice
  quiz           TEXT,                           -- JSON: Quiz（含 answer_index，只在服务端）
  translations   TEXT,                           -- JSON: { lang: Translation }
  risk_flags     TEXT                            -- JSON array
);

CREATE TABLE IF NOT EXISTS students (
  student_id     TEXT PRIMARY KEY,
  name           TEXT,
  name_en        TEXT,
  lang           TEXT DEFAULT 'en',              -- 母语偏好
  class_no       TEXT,
  cohort         TEXT,                           -- 2026
  is_demo        INTEGER NOT NULL DEFAULT 0,     -- 1 = 内置示例学生
  nationality    TEXT,                           -- 国籍
  email          TEXT,                           -- 收通知的邮箱
  degree         TEXT,                           -- 本科 / 硕士 / 博士
  grade          TEXT,                           -- 年级，如 2026 级
  owner_staff_id TEXT                            -- 哪个辅导员/助理导入并负责
);

-- owner = 总管（密码来自 COUNSELOR_KEY）
-- counselor = 辅导员（只看自己名下的学生与通知）
-- assistant = 助理（与所属辅导员同权，但只能由辅导员创建/删除）
CREATE TABLE IF NOT EXISTS staff (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  access_key     TEXT NOT NULL,
  role           TEXT NOT NULL DEFAULT 'assistant',
  active         INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT NOT NULL,
  last_seen_at   TEXT,
  parent_id      TEXT,                           -- 助理所属的辅导员
  email          TEXT,                           -- 绑定邮箱（发通知用）
  email_from     TEXT,                           -- 发件人显示名
  email_provider TEXT,                           -- resend | log
  email_api_key  TEXT                            -- 加密存储
);

CREATE TABLE IF NOT EXISTS receipts (
  id             TEXT PRIMARY KEY,
  notice_id      TEXT NOT NULL REFERENCES notices(id) ON DELETE CASCADE,
  student_id     TEXT NOT NULL,
  name           TEXT,
  lang           TEXT,
  first_seen_at  TEXT,
  quiz_passed_at TEXT,
  confirmed_at   TEXT,
  help_at        TEXT,
  help_message   TEXT,
  ua             TEXT,
  ip             TEXT,
  UNIQUE(notice_id, student_id)
);

CREATE TABLE IF NOT EXISTS quiz_attempts (
  id          TEXT PRIMARY KEY,
  notice_id   TEXT NOT NULL,
  student_id  TEXT,
  choice      INTEGER,
  correct     INTEGER,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS refusals (
  id          TEXT PRIMARY KEY,
  notice_id   TEXT,
  student_id  TEXT,
  question    TEXT,
  reason_code TEXT,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id          TEXT PRIMARY KEY,
  notice_id   TEXT,
  student_id  TEXT,
  type        TEXT,
  payload     TEXT,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  k          TEXT PRIMARY KEY,
  v          TEXT,
  updated_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_receipts_notice ON receipts(notice_id);
CREATE INDEX IF NOT EXISTS idx_events_notice   ON events(notice_id);
CREATE INDEX IF NOT EXISTS idx_refusals_notice ON refusals(notice_id);
CREATE INDEX IF NOT EXISTS idx_notices_status  ON notices(status, created_at);
CREATE INDEX IF NOT EXISTS idx_students_owner  ON students(owner_staff_id);
CREATE INDEX IF NOT EXISTS idx_staff_parent    ON staff(parent_id);
