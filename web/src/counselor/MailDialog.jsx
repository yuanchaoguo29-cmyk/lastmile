/* 一键发邮件：选收件人 → 逐人发。
   发件邮箱取当前账号绑定的那个；没绑就整块不可发（主按钮 disabled，点了也没反应）。
   收件人只在这里勾：快捷筛选（学历 / 年级，全部从当前花名册实时推导）+ 手动名单，
   只有有邮箱的人能勾，没邮箱的行置灰。发完只更新弹窗里的汇总，不刷新整页。 */

import React, { useEffect, useMemo, useRef, useState } from 'react'
import { getMyEmail, getRoster, sendNoticeEmail } from '../lib/api.js'
import { errText } from './helpers.js'
import { Btn, ErrBar, Eyebrow, Skel } from './ui.jsx'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
/* 学历只定顺序，不定成员：花名册里有哪些学历就显示哪些（见 groupBy） */
const DEGREE_ORDER = ['博士', '硕士', '本科']

const str = (v) => String(v ?? '').trim()
const idOf = (s) => str(s && s.student_id)
const emailOf = (s) => str(s && s.email)
const hasEmail = (s) => EMAIL_RE.test(emailOf(s))
/* 手填的学历/年级优先，没有就用学号推断值（/api/roster 额外带 id_degree / id_grade） */
const degreeOf = (s) => str(s && (s.degree || s.id_degree))
const gradeOf = (s) => str(s && (s.grade || s.id_grade))

/* 一组人按某个维度归并：total = 该组人数，count = 其中能发的（有邮箱），ids = 能发的学号。
   chip 上的数字就是 count，所以「点一下选中几个」和 chip 显示的人数永远对得上；
   没有邮箱的人留在手动名单里置灰，不参与快捷筛选。 */
function groupBy(students, pick) {
  const map = new Map()
  for (const s of students) {
    const key = pick(s)
    if (!key) continue
    const g = map.get(key) || { value: key, total: 0, count: 0, ids: [] }
    g.total += 1
    if (hasEmail(s)) {
      g.count += 1
      g.ids.push(idOf(s))
    }
    map.set(key, g)
  }
  return [...map.values()]
}

/* 学历：博士 → 硕士 → 本科，没见过的值（比如「预科」）排最后 */
function orderDegrees(groups) {
  const rank = (v) => {
    const i = DEGREE_ORDER.indexOf(v)
    return i < 0 ? DEGREE_ORDER.length : i
  }
  return groups
    .slice()
    .sort((a, b) => rank(a.value) - rank(b.value) || a.value.localeCompare(b.value, 'zh'))
}

/* 年级：能解析出 4 位数的按数字降序（2026级 在前），解析不出数字的排后面 */
function orderGrades(groups) {
  const year = (v) => {
    const m = /(\d{4})/.exec(v)
    return m ? Number(m[1]) : -Infinity
  }
  return groups
    .slice()
    .sort((a, b) => year(b.value) - year(a.value) || a.value.localeCompare(b.value, 'zh'))
}

/* 快捷筛选的一个 chip：全选 = 激活，只选了这组一部分 = 半选（· 标记） */
function GroupChip({ group, selected, onToggle }) {
  const all = group.ids.length > 0 && group.ids.every((id) => selected.has(id))
  const some = !all && group.ids.some((id) => selected.has(id))
  const empty = group.ids.length === 0
  const title = empty
    ? `这一组共 ${group.total} 人，还没有人填邮箱`
    : `共 ${group.total} 人，其中 ${group.count} 人有邮箱${some ? '；已选一部分' : all ? '；已全选' : ''}`
  return (
    <button
      type="button"
      className={`lm-mail-chip${all ? ' is-on' : ''}${some ? ' is-part' : ''}`}
      onClick={() => {
        if (empty) return
        onToggle(group, !all)
      }}
      disabled={empty}
      aria-pressed={all}
      title={title}
    >
      <span className="lm-mail-chip-t">{group.value}</span>
      {some ? (
        <span className="lm-mail-chip-mark" aria-hidden="true">
          ·
        </span>
      ) : null}
      <span className="lm-mail-chip-n">{group.count}</span>
    </button>
  )
}

export default function MailDialog({ open, noticeId, defaultIds, hint, onClose }) {
  const [loading, setLoading] = useState(false)
  const [email, setEmail] = useState(null)
  const [rows, setRows] = useState([])
  const [selected, setSelected] = useState(() => new Set())
  const [q, setQ] = useState('')
  const [sending, setSending] = useState(false)
  const [result, setResult] = useState(null)
  const [err, setErr] = useState('')
  const [reload, setReload] = useState(0)

  const panelRef = useRef(null)
  const closeRef = useRef(null)

  /* 每次打开（或换了一份通知）都重来：并行拉发件邮箱 + 花名册，再按 defaultIds 预选。
     defaultIds 给了就取交集（催办那一档的目标学生），没给默认全选有邮箱的人。 */
  useEffect(() => {
    if (!open) return undefined
    let alive = true
    setLoading(true)
    setErr('')
    setResult(null)
    setQ('')
    setSelected(new Set())
    setEmail(null)
    setRows([])

    ;(async () => {
      try {
        const [mail, rosterRes] = await Promise.all([getMyEmail(), getRoster()])
        if (!alive) return
        setEmail(mail && typeof mail === 'object' ? mail : null)
        const list = Array.isArray(rosterRes && rosterRes.students)
          ? rosterRes.students
          : Array.isArray(rosterRes && rosterRes.roster)
            ? rosterRes.roster
            : []
        const clean = list.filter((s) => s && idOf(s))
        setRows(clean)

        const preset = new Set(
          (Array.isArray(defaultIds) ? defaultIds : []).map((v) => str(v)).filter(Boolean)
        )
        const next = new Set()
        for (const s of clean) {
          if (!hasEmail(s)) continue
          if (preset.size === 0 || preset.has(idOf(s))) next.add(idOf(s))
        }
        setSelected(next)
      } catch (e) {
        if (!alive) return
        setRows([])
        setErr(errText(e))
      } finally {
        if (alive) setLoading(false)
      }
    })()

    return () => {
      alive = false
    }
  }, [open, noticeId, reload])

  /* 发送中不许关：这时候关掉，用户看不到结果，也撤不回已经发出去的信 */
  useEffect(() => {
    if (!open) return undefined
    function onKey(e) {
      if (e.key !== 'Escape') return
      e.preventDefault()
      if (!sending && onClose) onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose, sending])

  /* 弹窗打开时背后的工作台别跟着滚 */
  useEffect(() => {
    if (!open) return undefined
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [open])

  /* 初始焦点给关闭按钮，键盘用户不至于从弹窗最后一行开始 Tab */
  useEffect(() => {
    if (!open) return undefined
    const t = setTimeout(() => {
      if (closeRef.current) closeRef.current.focus()
    }, 40)
    return () => clearTimeout(t)
  }, [open])

  const degrees = useMemo(() => orderDegrees(groupBy(rows, degreeOf)), [rows])
  const grades = useMemo(() => orderGrades(groupBy(rows, gradeOf)), [rows])
  const sendable = useMemo(() => rows.filter(hasEmail), [rows])

  const kw = q.trim().toLowerCase()
  const visible = useMemo(() => {
    if (!kw) return rows
    return rows.filter((s) => {
      const hay = [idOf(s), str(s.name), str(s.name_en)].join(' ').toLowerCase()
      return hay.includes(kw)
    })
  }, [rows, kw])

  const bound = Boolean(email && email.bound)
  const count = selected.size
  const canSend = bound && count > 0 && !loading && !sending

  function toggleGroup(group, on) {
    setSelected((prev) => {
      const next = new Set(prev)
      for (const id of group.ids) {
        if (on) next.add(id)
        else next.delete(id)
      }
      return next
    })
  }

  function toggleOne(id) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function requestClose() {
    if (sending) return
    if (onClose) onClose()
  }

  async function send() {
    if (!canSend) return
    const ids = [...selected]
    setSending(true)
    setErr('')
    setResult(null)
    try {
      const res = await sendNoticeEmail(noticeId, ids)
      setResult(
        res && typeof res === 'object'
          ? res
          : { sent: 0, failed: 0, skipped: 0, errors: [] }
      )
    } catch (e) {
      /* 没绑邮箱 / 越权 / 连不上：都只在这块里显示，不动背后的页面 */
      setErr(errText(e))
    } finally {
      setSending(false)
    }
  }

  /* 轻量 Tab 圈：焦点别跑到弹窗背后 */
  function onPanelKeyDown(e) {
    if (e.key !== 'Tab' || !panelRef.current) return
    const all = panelRef.current.querySelectorAll('button, input, textarea, select, a[href]')
    const list = Array.prototype.filter.call(all, (n) => !n.disabled && n.offsetParent !== null)
    if (!list.length) return
    const first = list[0]
    const last = list[list.length - 1]
    if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault()
      first.focus()
    } else if (e.shiftKey && document.activeElement === first) {
      e.preventDefault()
      last.focus()
    }
  }

  if (!open) return null

  const sent = Number(result && result.sent) || 0
  const failed = Number(result && result.failed) || 0
  const skipped = Number(result && result.skipped) || 0
  const errors = Array.isArray(result && result.errors) ? result.errors : []

  return (
    <div
      className="lm-mail-overlay"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) requestClose()
      }}
    >
      <div
        className="lm-mail-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="lm-mail-title"
        ref={panelRef}
        tabIndex={-1}
        onKeyDown={onPanelKeyDown}
      >
        <header className="lm-mail-head">
          <div className="lm-mail-headtext">
            <Eyebrow>MAIL · 一键发邮件</Eyebrow>
            <h2 className="lm-mail-title" id="lm-mail-title">
              发给谁
            </h2>
          </div>
          <button
            type="button"
            className="lm-mail-x"
            ref={closeRef}
            onClick={requestClose}
            disabled={sending}
            title="关闭"
            aria-label="关闭发邮件弹窗"
          >
            ×
          </button>
        </header>

        <div className="lm-mail-body">
          {hint ? <p className="lm-mail-hint">{hint}</p> : null}

          {err ? <ErrBar message={err} onRetry={() => setReload((n) => n + 1)} retryLabel="重试" /> : null}

          {loading ? (
            <div className="lm-mail-loading">
              <Eyebrow>READING · 读发件邮箱与花名册…</Eyebrow>
              <Skel rows={4} />
            </div>
          ) : (
            <>
              {/* ---------- 发件邮箱 ---------- */}
              {bound ? (
                <div className="lm-mail-from">
                  <span className="lm-mail-dot" aria-hidden="true" />
                  <span className="lm-mail-from-k">发件邮箱</span>
                  <code className="lm-mail-from-addr">{str(email.address) || '已绑定'}</code>
                  <span className="lm-mail-sep" aria-hidden="true">
                    ·
                  </span>
                  <span className="lm-mail-from-provider">{str(email.provider)}</span>
                </div>
              ) : (
                <div className="lm-mail-amber" role="status">
                  <span className="lm-mail-amber-mark" aria-hidden="true">
                    !
                  </span>
                  <span>还没有配置发件邮箱，去设置 → 发件邮箱绑定后才能发送</span>
                </div>
              )}

              {/* ---------- 快捷筛选：两行 chip，全部按当前花名册推导 ---------- */}
              {degrees.length > 0 ? (
                <section className="lm-mail-sec" aria-label="按学历快速选人">
                  <div className="lm-mail-sec-head">
                    <Eyebrow>学历</Eyebrow>
                    <span className="lm-mail-sec-note">点一下 = 选中 / 取消这一组全部</span>
                  </div>
                  <div className="lm-mail-chips">
                    {degrees.map((g) => (
                      <GroupChip key={g.value} group={g} selected={selected} onToggle={toggleGroup} />
                    ))}
                  </div>
                </section>
              ) : null}

              {grades.length > 0 ? (
                <section className="lm-mail-sec" aria-label="按年级快速选人">
                  <div className="lm-mail-sec-head">
                    <Eyebrow>年级</Eyebrow>
                    <span className="lm-mail-sec-note">数字是这一组里能发的人（有邮箱）</span>
                  </div>
                  <div className="lm-mail-chips">
                    {grades.map((g) => (
                      <GroupChip key={g.value} group={g} selected={selected} onToggle={toggleGroup} />
                    ))}
                  </div>
                </section>
              ) : null}

              {/* ---------- 手动名单 ---------- */}
              <section className="lm-mail-sec" aria-label="手动选人">
                <div className="lm-mail-listhead">
                  <input
                    className="lm-mail-search"
                    type="search"
                    value={q}
                    placeholder="搜学号 / 姓名"
                    aria-label="搜索学号或姓名"
                    onChange={(e) => setQ(e.target.value)}
                  />
                  <span className="lm-mail-count">
                    已选 <b>{count}</b> 人
                  </span>
                  <div className="lm-mail-quickops">
                    <button
                      type="button"
                      className="lm-mail-linkbtn"
                      onClick={() => setSelected(new Set(sendable.map(idOf)))}
                      disabled={!sendable.length}
                    >
                      全选
                    </button>
                    <button
                      type="button"
                      className="lm-mail-linkbtn"
                      onClick={() => setSelected(new Set())}
                      disabled={!count}
                    >
                      清空
                    </button>
                  </div>
                </div>

                {rows.length === 0 ? (
                  <p className="lm-mail-empty">名单里还没有学生：先去花名册导入，或恢复示例名单。</p>
                ) : sendable.length === 0 ? (
                  <p className="lm-mail-empty">
                    名单里还没有人填邮箱。去花名册补上邮箱再发——现在发出去，一个收件人都没有。
                  </p>
                ) : null}

                <div className="lm-mail-list" role="group" aria-label="收件人名单">
                  {visible.map((s) => {
                    const sid = idOf(s)
                    const ok = hasEmail(s)
                    const on = ok && selected.has(sid)
                    const meta = [degreeOf(s), gradeOf(s)].filter(Boolean).join(' · ')
                    return (
                      <label
                        key={sid}
                        className={`lm-mail-row${ok ? '' : ' is-off'}${on ? ' is-on' : ''}`}
                        title={ok ? emailOf(s) : '这位同学还没有邮箱，发不了'}
                      >
                        <input
                          type="checkbox"
                          className="lm-mail-check"
                          checked={on}
                          disabled={!ok}
                          onChange={() => {
                            if (ok) toggleOne(sid)
                          }}
                        />
                        <span className="lm-mail-row-main">
                          <span className="lm-mail-row-name">{str(s.name || s.name_en) || sid}</span>
                          <span className="lm-mail-row-id">{sid}</span>
                        </span>
                        {meta ? <span className="lm-mail-row-meta">{meta}</span> : null}
                        {ok ? (
                          <span className="lm-mail-row-mail">{emailOf(s)}</span>
                        ) : (
                          <span className="lm-mail-nomail">无邮箱</span>
                        )}
                      </label>
                    )
                  })}
                  {visible.length === 0 && rows.length > 0 ? (
                    <p className="lm-mail-empty">这个搜索词下没有学生，换个学号或姓名试试。</p>
                  ) : null}
                </div>
              </section>

              {/* ---------- 发完的汇总：一句话 + 前 3 条失败原因 ---------- */}
              {result ? (
                <div className={`lm-mail-result${failed > 0 ? ' is-bad' : ''}`} role="status">
                  <div className="lm-mail-result-line">
                    已发送 <b>{sent}</b> · 跳过 <b>{skipped}</b>（无邮箱）· 失败 <b>{failed}</b>
                  </div>
                  {errors.length > 0 ? (
                    <ul className="lm-mail-errors">
                      {errors.slice(0, 3).map((e, i) => (
                        <li key={`${(e && e.student_id) || i}`}>
                          <span className="lm-mail-errors-id">{str(e && e.student_id) || '—'}</span>
                          <span className="lm-mail-errors-reason">{str(e && e.reason) || '发送失败'}</span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {errors.length > 3 ? (
                    <p className="lm-mail-errors-more">只列前 3 条，另外 {errors.length - 3} 条在服务端日志里。</p>
                  ) : null}
                </div>
              ) : null}
            </>
          )}
        </div>

        <footer className="lm-mail-foot">
          <span className="lm-mail-foot-hint">
            {!bound
              ? '绑定发件邮箱之前，这个按钮是灰的'
              : count === 0
                ? '先在上面勾人，或者点一下学历 / 年级 chip'
                : '逐人发送；失败的会列出来，不影响其他人'}
          </span>
          <div className="lm-mail-foot-btns">
            <Btn size="md" onClick={requestClose} disabled={sending}>
              关闭
            </Btn>
            <Btn variant="primary" size="md" onClick={send} disabled={!canSend}>
              {sending
                ? '发送中…'
                : result
                  ? `再发一次（${count} 人）`
                  : `发送给 ${count} 人`}
            </Btn>
          </div>
        </footer>
      </div>
    </div>
  )
}
