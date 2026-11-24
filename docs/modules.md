# 服务端内部模块契约（A/B 两个 agent 必须严格遵守）

## `server/db.js`（已冻结，勿改）
```js
import { getDb, tx, nowIso, uid } from './db.js'
getDb()      // → DatabaseSync
tx(fn)       // 同步事务，fn 内抛错回滚
nowIso()     // → '2026-11-20T12:00:00.000Z'
uid('ntc')   // → 'ntc_ab12cd34ef56'
```

## `server/repo.js`（归属 A，归属 B 可读不可写）

```js
export const repo = {
  // notices
  createNotice(input): Notice
  updateNotice(id, patch): Notice
  getNotice(id): Notice | null
  listNotices(): Notice[]
  // receipts
  upsertReceipt(noticeId, studentId, patch): Receipt
  getReceipt(noticeId, studentId): Receipt | null
  listReceipts(noticeId): Receipt[]
  counts(noticeId): { roster, seen, quiz_passed, confirmed, help, unread }
  // quiz
  addQuizAttempt(noticeId, studentId, choice, correct): void
  quizAttemptCount(noticeId, studentId): number
  // refusals / events
  addRefusal(noticeId, studentId, question, reasonCode): void
  listRefusals(noticeId): Refusal[]
  addEvent(noticeId, studentId, type, payload): void
  listEvents(noticeId, limit): Event[]
  // roster
  listStudents(): Student[]
  getStudent(studentId): Student | null
}
```
`Notice` 的行对象：`{ id, created_at, published_at, status, owner, raw_text, sent_at,
kind, title_zh, deadline_at, structured, quiz, translations, risk_flags }`，
其中 `structured` / `quiz` / `translations` / `risk_flags` 是**已 JSON.parse 的对象**（repo 负责解析）。

## `server/ai.js`（归属 B）

```js
export async function parseNotice(rawText, sentAtIso): Promise<StructuredNotice>
export async function buildQuiz(structured): Promise<Quiz>
export async function translateNotice(structured, quiz, langs): Promise<Record<lang, Translation>>
export async function nudgeText({ notice, targets, lang, tone, tier }): Promise<string>
export async function answerFromNotice(question, structured, lang): Promise<string>  // 只允许复述原文
export async function classifyRisk(text): Promise<{ flags: string[], allow: boolean, reason_code: string }>
```

## `server/guard.js`（归属 B）

```js
// 唯一的敏感问题出口。api.js 只调用这一个函数。
export async function guardAsk({ question, lang, structured, notice }):
  Promise<{ allowed: boolean, answer?: string, refusal?: Refusal }>
```
`Refusal = { reason_code, message, links: [{label,url}], contacts: [{name,phone}], cta }`

## 归属 A 必须遵守
- 所有 AI 调用都 try/catch：AI 失败时**仍要能发布通知**（用 `structured` 原文兜底，`warnings` 加一条「AI 解析失败，请人工补」）
- 敏感问题一律走 `guardAsk`，禁止自己拼拒绝文案
- 学生接口返回的数据里**绝对不能出现 `answer_index`**
- 所有时间用 ISO8601；`deadline_at` 可空
