# UI 契约 + 文件归属（冻结版 v1）

## 0. 跑法

- 开发：`npm run dev`（vite 5173，`/api` 代理到 3000）
- 交付：`npm run build && npm start` → 单进程 Express 托管 `public/` + `/api`，**只开 3000 一个端口**

## 1. 路由（hash，无 react-router）

| 路由 | 页面 |
|---|---|
| `#/c` | 辅导员工作台：通知列表 + 粘贴新建 |
| `#/c/:id` | 单份通知：确认页 + 看板 |
| `#/s/:id` | 学生卡片页（手机） |
| `#/s/:id/done` | 回执完成页 |

## 2. 文件归属（**只准改自己名下的文件**）

| 归属 | 路径 |
|---|---|
| 已冻结（只读） | `docs/*`、`web/src/main.jsx`、`web/src/lib/*`、`web/src/styles/tokens.css`、`web/src/styles/app.css`、`vite.config.js`、`server/index.js` 的挂载顺序 |
| **A 后端** | `server/db.js`、`server/repo.js`、`server/api.js`、`server/seed.js` |
| **B AI** | `server/ai.js`、`server/prompts.js`、`server/guard.js` |
| **C 学生端** | `web/src/student/**`、`web/src/styles/student.css` |
| **D 辅导员端** | `web/src/counselor/**`、`web/src/styles/counselor.css` |
| **E 单文件兜底** | `demo.html`（根目录） |

公共组件放自己目录内，**不要**新建 `web/src/components/`。

## 3. 设计令牌（已写进 tokens.css，直接用变量）

### 3.1 辅导员端：深色监控台（呼应赛题海报）

```
--navy-900:#070D17  --navy-800:#0B1220  --navy-700:#111C2E  --navy-600:#18263D
--line:#22304A      --mint:#3DDC97      --mint-2:#25B77D
--ink:#E8EEF7       --muted:#8FA3BF     --amber:#F5B547  --red:#FF6B6B  --blue:#5B9DFF
```
- 标题 20-28px 700，正文 14px，英文小标签用 `--font-mono` + 11px + letter-spacing .12em + 大写 + `--muted`
- 卡片：`background:var(--navy-700); border:1px solid var(--line); border-radius:14px`
- 数据数字用 `--font-mono`，36-48px，`--mint`
- 进度条：4px 圆角，底色 `--navy-600`，填充 `--mint`

### 3.2 学生端：浅色、大字、高对比（低识字率优先）

```
--s-bg:#FFFFFF  --s-surface:#F4F7FA  --s-line:#E2E8F0
--s-ink:#0B1220 --s-muted:#5A6B82   --s-accent:#0E9F6E  --s-warn:#D97706  --s-danger:#DC2626
```
- **正文基准 18px，行动项 20px/1.5，标题 30-34px/1.25**，行高宽松
- 一屏只讲一件事；行动项必须带序号大圆点
- 主按钮高度 ≥ 56px，圆角 16px，全宽
- 截止时间用 `--s-accent` 大号显示 + 倒计时「还剩 4 天 8 小时」
- 不许出现英文技术词；所有 UI chrome 文案走 `lib/i18n.js`

### 3.3 通用
- 移动优先，最大宽度 480px 居中（学生端）；辅导员端最大 1180px
- 无外部字体、无 CDN、无图片资源（图标用 inline SVG 或 Unicode）
- 所有可点区域 ≥ 44px

## 4. 学生端状态机（**验收重点**）

```
unread ──打开──> seen ──答题(可重试)──> quiz_passed ──点「我已知晓」──> confirmed
                    └──────点「我有困难」───> help（仍可回到答题/回执）
```

| 状态 | 界面 |
|---|---|
| 未打开 | 卡片 1：什么事（标题 + one_line + 语言切换 + 朗读） |
| 已打开 | 卡片 2：你要做什么（有序 actions）+ 卡片 3：截止/地点/材料 |
| 已打开 | 卡片 4：1 道小测。答错 → **高亮 `source_span` 原文片段** + 可重试，不阻塞回执 |
| 已打开 | 卡片 5：确认。大按钮「我已知晓，会按时完成」+ 次要「我有困难」 |
| confirmed | 完成页：显示时间戳 + 「本班 18/114 已确认」+ 日历按钮 |
| help | 完成页变体：已把你的困难记下来，老师会联系你 |

关键交互：
- **加日历**：前端生成 `.ics`，`deadline.iso` 写入 `DTSTART`，标题用 `one_line`
- **朗读**：`speechSynthesis`，按 `lang` 选 voice，念 `one_line` + actions
- **语言切换**：只列 `available_langs`，切了立刻重渲染（不刷新）
- **5 类风险**：`risk_flag !== "none"` 时，卡片 3 下方固定一块「此类问题请找官方渠道」，列 `official_links` + `contacts`，不允许出现产品自己给的建议

## 5. 辅导员端页面

**#/c**
- 顶部：产品名 + `#/c` 当前时间 + 「新通知」大按钮
- 粘贴框（大 textarea，placeholder 是真实通知示例）+ 发送日期选择 + 「开始解析」
- 解析中：进度文案（抽取 → 生成小测 → 翻译三语），要让人感觉 10 秒内有反馈
- 解析完跳 `#/c/:id` 的确认态
- 通知列表：标题 / 状态 / 截止 / 迷你进度条 / `18/114 已确认`

**#/c/:id** 三个 tab：`确认` / `看板` / `催办`
- **确认**：每个字段可编辑，字段下方灰字显示 `spans` 原文片段；`warnings` 黄条；`risk_flags` 红条；底部「确认并发布」
- **看板**：大数字（已确认/已读未回执/未读/有困难）+ 进度条 + 语言分布 + 学生表（可按状态筛）+ 拒绝日志 + 时间线
- **催办**：选 tier（未读 / 全部未确认 / 有困难）+ 语气 + 语言 → 生成文案，一键复制 + 二维码 + 目标名单

## 6. 文案要求

- 中文为主、英文小标签点缀（呼应赛题海报风格）
- 报错写人话，不要堆栈
- 空状态要写「下一步该点哪」
