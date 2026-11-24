-- LastMile 最后一公里 · SQLite schema (node:sqlite DatabaseSync)
-- 冻结版 v1。任何改动必须先改本文件与 docs/api.md。

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS notices (
  id            TEXT PRIMARY KEY,
  created_at    TEXT NOT NULL,              -- ISO8601 +08:00
  published_at  TEXT,
  status        TEXT NOT NULL DEFAULT 'draft',   -- draft | published | closed
  owner         TEXT,                        -- 谁发通知谁维护
  raw_text      TEXT NOT NULL,
  sent_at       TEXT,                        -- 原通知发出日期，用于解析「下周三」
  kind          TEXT,                        -- residence_permit|visa|medical|exam|scholarship|safety|general
  title_zh      TEXT,
  deadline_at   TEXT,                        -- ISO8601，可空
  structured    TEXT NOT NULL,               -- JSON: StructuredNotice
  quiz          TEXT,                        -- JSON: Quiz (中文版，含 answer_index)
  translations  TEXT,                        -- JSON: { "en": Translation, "ru": ... }
  risk_flags    TEXT                         -- JSON array
);

CREATE TABLE IF NOT EXISTS students (
  student_id  TEXT PRIMARY KEY,
  name        TEXT,
  name_en     TEXT,
  lang        TEXT DEFAULT 'en',             -- 母语偏好
  class_no    TEXT,
  cohort      TEXT,                          -- 2026
  is_demo     INTEGER NOT NULL DEFAULT 0     -- 1 = 内置示例学生（导入真实花名册后可一键删掉）
);

/* 工作人员：owner 就是 COUNSELOR_KEY 那把主密码；assistant 是助理账号（各人一把，便于留痕） */
CREATE TABLE IF NOT EXISTS staff (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  access_key   TEXT NOT NULL,
  role         TEXT NOT NULL DEFAULT 'assistant',   -- owner | assistant
  active       INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL,
  last_seen_at TEXT
);

CREATE TABLE IF NOT EXISTS receipts (
  id             TEXT PRIMARY KEY,
  notice_id      TEXT NOT NULL REFERENCES notices(id) ON DELETE CASCADE,
  student_id     TEXT NOT NULL,
  name           TEXT,
  lang           TEXT,
  first_seen_at  TEXT,                       -- 第一次打开卡片页
  quiz_passed_at TEXT,
  confirmed_at   TEXT,                       -- 回执时间（判分依据）
  help_at        TEXT,                       -- 点了「我有困难」
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
  correct     INTEGER,                       -- 1/0
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS refusals (
  id          TEXT PRIMARY KEY,
  notice_id   TEXT,
  student_id  TEXT,
  question    TEXT,
  reason_code TEXT,                          -- visa|residence_permit|medical|mental|safety|out_of_scope
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id          TEXT PRIMARY KEY,
  notice_id   TEXT,
  student_id  TEXT,
  type        TEXT,                          -- view|quiz|receipt|help|nudge|publish|refusal
  payload     TEXT,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  k          TEXT PRIMARY KEY,              -- counselor_key | deepseek_api_key | deepseek_base_url | deepseek_model
  v          TEXT,
  updated_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_receipts_notice ON receipts(notice_id);
CREATE INDEX IF NOT EXISTS idx_events_notice   ON events(notice_id);
CREATE INDEX IF NOT EXISTS idx_refusals_notice ON refusals(notice_id);
CREATE INDEX IF NOT EXISTS idx_notices_status  ON notices(status, created_at);
