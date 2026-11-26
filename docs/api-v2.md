# v2 契约：角色分级 / 花名册升级 / 邮件通知

> 冻结版。改字段先改这里。表结构已在 `docs/schema.sql`（v2）与 `server/db.js` 的迁移里就绪。

## 1. 角色与数据隔离

`req.staff = { id, name, role, parent_id }`

| 角色 | 怎么来 | 能看什么 | 能管谁 |
|---|---|---|---|
| `owner`（总管） | 环境变量 `COUNSELOR_KEY` 的密码（默认 `12345678`） | **全部**学生与通知 | 创建/删除/停用 **辅导员** |
| `counselor`（辅导员） | 总管在后台创建 | **只**自己名下的学生与通知（`owner_staff_id = 自己`） | 创建/删除/停用 **自己的助理** |
| `assistant`（助理） | 辅导员创建 | 与所属辅导员**完全同权**（`owner_staff_id = parent_id`） | 无 |

- 可见范围：`owner` → 全部；`counselor` → `[self.id]`；`assistant` → `[self.parent_id]`
- 所有列表/看板/导入都必须按这个范围过滤，**越权一律当"不存在"**（404 或空列表）
- 学生端（`/api/student/**`）不受影响，仍然公开

## 2. 接口（全部要 `x-counselor-key`）

### 身份
```
GET  /api/me
→ { id, name, role, parent_id, can_create: "counselor"|"assistant"|null,
    email: { bound: bool, address: "a***@x.com", provider: "resend"|"log"|null } }
```

### 账号管理
```
GET    /api/staff
→ owner:   { members: [ {id,name,role,active,created_at,last_seen_at,key_masked,parent_id,assistant_count} ] }
→ counselor:{ members: [ 自己的助理 ] }

POST   /api/staff   { name }                       // 角色由调用者决定
→ owner 创建 counselor（parent_id = null）
→ counselor 创建 assistant（parent_id = 自己）
→ { ok, member, access_key }                        // 明文只返回这一次

PATCH  /api/staff/:id   { name?, active?, regenerate? }
→ { ok, member, access_key? }                       // 只能改自己有权的账号

DELETE /api/staff/:id
→ { ok }
```
权限：
- owner 只能管 counselor；counselor 只能管 `parent_id = self` 的 assistant
- 不能停用/删除自己；不能跨级

### 自己的发件邮箱
```
GET   /api/staff/me/email
→ { bound, address_masked, provider, from }

PUT   /api/staff/me/email   { email, provider: "resend"|"log", api_key?, from? }
→ { ok, email: {...} }                              // api_key 用 crypto.js 加密存 staff.email_api_key

DELETE /api/staff/me/email
→ { ok }
```
- `email` 是发件人地址；`provider=log` 时不发真信，只写日志（本地联调用）
- `provider=resend` 需要 `api_key`

### 花名册（字段升级）
学生对象新增：`nationality`（国籍）、`email`、`degree`（本科/硕士/博士）、`grade`（如 `2026级`）

```
GET  /api/roster?q=&degree=&grade=&lang=&class_no=
→ { total, demo_count, students: [ {student_id,name,name_en,lang,nationality,email,degree,grade,class_no,is_demo} ] }

POST /api/roster/import  { rows: [{student_id,name,name_en,lang,nationality,email,degree,grade,class_no}], mode, keep_demo }
→ { ok, added, updated, skipped, total, demo_count }   // owner_staff_id = 当前账号的 scope id

POST /api/roster/check
→ { hints: [ { student_id, name, field, level: "warn"|"info", message } ], scanned }
```
`/api/roster/check` 的检查项（确定性规则，不需要模型）：
- 缺 `email` / 缺 `degree` / 缺 `grade` / 缺 `nationality`
- `degree` 不在白名单（本科/硕士/博士）
- `grade` 不是 `20xx级` 形式
- `email` 格式不对 / 同学号重复邮箱
- 每条 hint 一句话人话，例如 `Jensen 的年级信息缺失`

### 通知的目标学生
```
POST /api/notices  { raw_text, structured, sent_at, owner?, target_ids?: string[] }
→ target_ids 省略或 null = 名下全部学生；给了数组则只发给这些学号（服务端要校验它们确实在调用者可见范围内）
```
- `notices.target_ids` 存 JSON 数组
- `counts(noticeId)` 的 `roster` = 目标人数（target_ids 为空则=可见学生数）
- 看板只列目标学生

### 邮件发送
```
POST /api/notices/:id/email
→ { ok, provider, sent, failed, skipped, errors: [{student_id, reason}] }
```
- 收件人 = 该通知的目标学生中有 `email` 的人
- 发件人 = 调用者绑定的邮箱；没绑 → 400 `EMAIL_NOT_BOUND`
- 正文用该通知的结构化内容 + 学生链接（`PUBLIC_BASE_URL` 或请求 host）
- 每人独立发送，失败的收集起来不中断

## 3. 邮件通道（`server/email.js`）

```js
export async function sendMail({ provider, apiKey, from, to, subject, text, html })
// provider = 'resend' → POST https://api.resend.com/emails  Bearer
//          = 'log'    → 只 console.log 一行（脱敏），返回 sent
// 其它 → 抛错
```
- **不支持 SMTP**：Railway 封禁出站 25/465/587，所以只走 HTTP API
- 超时 20s，失败抛错由上层收集

## 4. 迁移与兼容

- `students.owner_staff_id` 为空的老数据（示例学生）视为**总管可见**：owner 看全部；counselor 看不到
- 首次启动若 `staff` 表里没有 counselor，只有 owner 能登录，属正常
- 冒烟脚本 `scripts/smoke.mjs` 必须继续全绿（它用 owner 密码）
