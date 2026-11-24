# LastMile API 契约（冻结版 v1）

Base: `/api`。全部 `application/json; charset=utf-8`。
服务端为**单进程** Express 4，同时托管 `public/` 静态前端。
**前端与后端只通过本文件通信。改字段 = 先改本文件。**

## 0. 约定

- 时间一律 ISO8601 带偏移，例：`2026-11-25T17:00:00+08:00`
- 失败统一：HTTP 400/404/500 + `{ "error": { "code": "STRING", "message": "人话" } }`
- 辅导员接口需要 `x-counselor-key: <COUNSELOR_KEY>` 头（默认 `lastmile`）。
  前端把它存 localStorage，首次进来问一次。
- 学生接口不需要登录。身份 = 提交时带 `student_id` + `name`（对着 roster 校验）。

## 1. 语言

`LANGS = ["zh","en","ru","vi","th","id"]`
先做精 `en` / `ru` / `vi`，其余按需生成。前端 `web/src/lib/i18n.js` 已覆盖这 6 种，加语言只需同时加一个对象。

## 2. 核心数据结构

### 2.1 StructuredNotice（AI 抽取结果）

```jsonc
{
  "title_zh": "关于2026级留学生办理居留许可延期的通知",
  "kind": "residence_permit",          // residence_permit|visa|medical|exam|scholarship|safety|general
  "one_line": "11月25日17:00前，带护照原件到通博楼A座204办居留许可延期",  // 一句话结论
  "who": "2026级全体留学生（114人）",
  "what": "学院统一组织居留许可延期办理，需本人到现场提交材料。",
  "actions": [                          // 必须可执行、动词开头、有序
    { "order": 1, "zh": "带上护照原件", "en": "Bring your passport (original)" }
  ],
  "deadline": {
    "raw": "11月25日17:00前",
    "iso": "2026-11-25T17:00:00+08:00", // 解析不出则 null
    "confidence": "high",               // high | low
    "basis": "原文写明绝对日期 + 时间"
  },
  "materials": ["护照原件"],
  "place": { "raw": "柳林校区通博楼A座204办公室", "note": "" },
  "consequence": "逾期后果自负",
  "official_links": [{ "label": "国际交流处", "url": "https://…" }],
  "contacts": [{ "name": "张老师", "phone": "028-87092233", "note": "工作日 9:00-17:00" }],
  "risk_flags": ["residence_permit"],   // 命中五类敏感才有值
  "spans": {                            // 字段级溯源，用于「点回去看原文」
    "deadline": "于11月25日17:00前",
    "place": "柳林校区通博楼A座204办公室",
    "actions": ["携带护照原件"]
  },
  "warnings": ["deadline 由相对时间推算，请确认"]  // 给辅导员看的待确认项
}
```

### 2.2 Quiz（中文母版，答案只在服务端）

```jsonc
{
  "question": "你需要做什么？",
  "options": ["11月25日前带护照去通博楼204办延期", "在宿舍等老师上门", "在网上提交申请表"],
  "answer_index": 0,
  "source_span": "请于11月25日17:00前，携带护照原件到…办理居留许可延期",
  "explain": "通知要求本人带护照原件到 204 办公室办理。"
}
```

### 2.3 Translation（每种语言一份）

```jsonc
{
  "lang": "en",
  "title": "Notice on Residence Permit Extension for 2026 International Students",
  "one_line": "Bring your passport to Room 204, Tongbo Bldg A, before 25 Nov 17:00.",
  "what": "…", "who": "…",
  "actions": [{ "order": 1, "text": "Bring your passport (original)" }],
  "deadline_text": "25 Nov 2026, 17:00",
  "place_text": "Room 204, Tongbo Bldg A, Liulin Campus",
  "materials": ["Passport (original)"],
  "consequence": "Late applications are at your own risk.",
  "quiz": { "question": "…", "options": ["…"], "answer_index": 0, "source_span": "…", "explain": "…" }
}
```

## 3. 辅导员接口

| Method | Path | 说明 |
|---|---|---|
| POST | `/api/notices/parse` | 解析通知，**不落库** |
| POST | `/api/notices` | 落库并发布 |
| GET | `/api/notices` | 列表 + 计数 |
| GET | `/api/notices/:id` | 详情 |
| PATCH | `/api/notices/:id` | 改结构化字段 / 换状态 |
| POST | `/api/notices/:id/translate` | 生成/补齐多语言 + 各自的 quiz |
| GET | `/api/notices/:id/dashboard` | 看板数据 |
| POST | `/api/notices/:id/nudge` | 生成催办文案 + 目标名单 |
| GET | `/api/notices/:id/export.csv` | 回执存证导出 |
| GET | `/api/roster` | 名单（114 人） |

**POST /api/notices/parse**
```json
{ "raw_text": "…", "sent_at": "2026-11-20T10:00:00+08:00" }
→ { "draft": StructuredNotice, "meta": { "model": "deepseek-flash", "ms": 4200 } }
```

**POST /api/notices**
```json
{ "raw_text": "…", "structured": StructuredNotice, "sent_at": "…", "owner": "张老师" }
→ { "notice": { "id": "ntc_xxx", "status": "published", "quiz": Quiz, "translations": {...} } }
```
服务端在发布时自动生成中文 quiz（若未提供）。

**GET /api/notices** →
```json
{ "notices": [{ "id":"ntc_x","title_zh":"…","status":"published","created_at":"…",
  "deadline_at":"…","risk_flags":[],
  "counts": { "roster":114,"seen":20,"quiz_passed":18,"confirmed":18,"help":1,"unread":94 },
  "langs": ["en","ru","vi"] }] }
```

**GET /api/notices/:id/dashboard** →
```json
{ "notice_id":"…","counts":{...},"by_lang":{"en":8,"ru":6},
  "students":[{"student_id":"…","name":"…","lang":"en","status":"confirmed",
               "first_seen_at":"…","confirmed_at":"…","quiz_ok":true,"help_message":null}],
  "timeline":[{"hour":0,"confirmed":0},{"hour":1,"confirmed":7}],
  "refusals":[{"question":"…","reason_code":"visa","created_at":"…"}],
  "recent_events":[{"type":"receipt","student_id":"…","created_at":"…"}] }
```
`status ∈ confirmed | help | seen | unread`

**POST /api/notices/:id/nudge**
```json
{ "tier": "unread", "tone": "firm", "lang": "en" }
→ { "text": "…可直接粘贴到群里的话…", "targets": [{"student_id":"…","name":"…"}],
    "link": "http://host/#/s/ntc_x", "qr_data_url": "data:image/png;base64,…" }
```

## 4. 学生接口（公开）

| Method | Path | 说明 |
|---|---|---|
| GET | `/api/student/notice/:id?lang=en&student_id=` | 卡片页全部数据（**无答案**） |
| GET | `/api/student/me?student_id=` | 校验学号，回姓名/语言 |
| POST | `/api/student/notice/:id/seen` | 已读打点 |
| POST | `/api/student/notice/:id/quiz` | 交答案，回正误 + 原文片段 |
| POST | `/api/student/notice/:id/receipt` | 回执 / 求助 |
| POST | `/api/student/notice/:id/ask` | 追问（敏感五类在这里拦截） |

**GET /api/student/notice/:id** →
```json
{ "notice_id":"ntc_x","lang":"en","available_langs":["zh","en","ru","vi"],
  "title":"…","one_line":"…","what":"…","who":"…",
  "actions":[{"order":1,"text":"…"}],
  "deadline":{"iso":"2026-11-25T17:00:00+08:00","text":"25 Nov 2026, 17:00","hours_left":96},
  "place":"…","materials":["…"],"consequence":"…",
  "official_links":[…],"contacts":[…],"risk_flag":"residence_permit",
  "original_zh":"…","quiz":{"question":"…","options":["…"],"answer_index":null},
  "my_status":"unread","counts":{"confirmed":3,"roster":114} }
```

**POST /api/student/notice/:id/quiz**
```json
{ "choice": 1, "student_id": "2026xxxx" }
→ { "correct": false, "correct_index": 0, "source_span": "…", "explain": "…", "attempts": 2 }
```

**POST /api/student/notice/:id/receipt**
```json
{ "student_id":"…","name":"…","lang":"en","kind":"confirm" }
或 { "kind":"help","help_message":"我护照在补办" }
→ { "ok":true,"receipt":{"confirmed_at":"…"},"counts":{"confirmed":19,"roster":114} }
```

**POST /api/student/notice/:id/ask**
```json
{ "question":"My visa expires soon, can I extend it?","lang":"en","student_id":"…" }
→ 允许：{ "allowed":true, "answer":"…（只能引用通知原文/官方链接，不许给个性化建议）" }
→ 拦截：{ "allowed":false,
   "refusal":{ "reason_code":"visa",
     "message":"This question is about visas. I can't advise on your case.",
     "links":[{"label":"International Office","url":"…"}],
     "contacts":[{"name":"张老师","phone":"028-87092233"}],
     "cta":"转人工" } }
```

## 5. 其他

- `GET /api/health` → `{ "ok":true,"db":"sqlite","ai":"configured","version":"0.1.0" }`
- `GET /api/qr?url=…` → `image/png`

## 6. 前端路由（hash）

- `#/c` 辅导员工作台
- `#/c/:id` 单份通知看板
- `#/s/:id` 学生卡片页
- `#/s/:id/done` 回执完成
