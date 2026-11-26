/* 看板 tab：四个大数字 + 进度 + 语言分布 + 24 小时时间线 + 学生表 + 拒绝日志。
   时间线是 24 个 div 竖条画的，没有图表库。
   DashboardTab 负责取数，BoardBody 只负责把数据画出来（空数据也不会白屏）。 */

import React, { useEffect, useMemo, useState } from 'react'
import { downloadReceiptsCsv, getDashboard, getMe } from '../lib/api.js'
import {
  LANG_FULL,
  STATUS_META,
  errText,
  fmtClock,
  fmtDateTime,
  fmtRel,
  isAuthError,
  normStatus
} from './helpers.js'
import { Bar, Btn, Card, Empty, ErrBar, Eyebrow, Skel } from './ui.jsx'

const FILTERS = [
  { value: 'all', label: '全部' },
  { value: 'confirmed', label: '已确认' },
  { value: 'seen', label: '已读未回执' },
  { value: 'unread', label: '未读' },
  { value: 'help', label: '有困难' }
]

const STATUS_ORDER = { help: 0, unread: 1, seen: 2, confirmed: 3 }

/* 数字优先信服务端的 counts（聚合值），缺失时再退回学生表里数出来的 */
function numOrNull(v) {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function StatCard({ tag, label, value, note, noteTone }) {
  return (
    <div className="lm-counselor-stat">
      <Eyebrow>{tag}</Eyebrow>
      <div className="lm-counselor-stat-num">{value}</div>
      <div className="lm-counselor-stat-label">{label}</div>
      {note ? <div className={`lm-counselor-stat-note is-${noteTone || 'muted'}`}>{note}</div> : null}
    </div>
  )
}

function Timeline({ series, roster }) {
  const max = Math.max(1, series.reduce((m, v) => Math.max(m, v), 0))
  const last = series.length ? series[series.length - 1] : 0
  return (
    <div className="lm-counselor-timeline">
      <div className="lm-counselor-tl-bars">
        {series.map((v, i) => (
          <div className="lm-counselor-tl-slot" key={i} title={`${i}:00 · 累计 ${v} 人确认`}>
            <div
              className={`lm-counselor-tl-bar${v > 0 ? ' is-on' : ''}${i === 23 ? ' is-last' : ''}`}
              style={{ height: `${v > 0 ? Math.max(3, Math.round((v / max) * 100)) : 2}%` }}
            />
          </div>
        ))}
      </div>
      <div className="lm-counselor-tl-axis">
        {['0h', '6h', '12h', '18h', '24h'].map((t) => (
          <span key={t}>{t}</span>
        ))}
      </div>
      <div className="lm-counselor-tl-foot">
        24 小时内累计 {last} 人确认{roster ? ` · 名单 ${roster} 人` : ''}
      </div>
    </div>
  )
}

export function BoardBody({ data, id, onGoNudge, canExport }) {
  const [filter, setFilter] = useState('all')
  const [exporting, setExporting] = useState(false)
  const [exportErr, setExportErr] = useState('')

  /* 导出走 fetch + Blob（密码在请求头里，不进 URL）；越权时服务端一律回 404，翻译成人话 */
  async function onExport() {
    if (exporting) return
    setExporting(true)
    setExportErr('')
    try {
      await downloadReceiptsCsv(id)
    } catch (e) {
      if (Number(e?.status) === 404 || e?.code === 'NOTICE_NOT_FOUND') {
        setExportErr('这份通知不在你名下')
      } else {
        setExportErr(errText(e))
      }
    } finally {
      setExporting(false)
    }
  }

  const students = useMemo(
    () => (Array.isArray(data && data.students) ? data.students.filter((s) => s && s.student_id) : []),
    [data]
  )
  const counts = data && data.counts && typeof data.counts === 'object' ? data.counts : {}
  const roster = Number(counts.roster) || students.length || 0

  const byStatus = useMemo(() => {
    const derived = { confirmed: 0, seen: 0, unread: 0, help: 0 }
    students.forEach((s) => {
      derived[normStatus(s.status)] += 1
    })
    const confirmed = numOrNull(counts.confirmed)
    const help = numOrNull(counts.help)
    const unread = numOrNull(counts.unread)
    const seenRaw = numOrNull(counts.seen)
    const finalConfirmed = confirmed === null ? derived.confirmed : confirmed
    const finalHelp = help === null ? derived.help : help
    return {
      confirmed: finalConfirmed,
      help: finalHelp,
      unread: unread === null ? derived.unread : unread,
      /* 「已读未回执」没有对应的 counts 字段：有学生表就按状态数，没有就用 seen 减掉已确认和求助 */
      seen: students.length
        ? derived.seen
        : seenRaw === null
          ? 0
          : Math.max(0, seenRaw - finalConfirmed - finalHelp)
    }
  }, [students, counts])

  const series = useMemo(() => {
    const arr = new Array(24).fill(0)
    const src = Array.isArray(data && data.timeline) ? data.timeline : []
    src.forEach((t) => {
      const h = Number(t && t.hour)
      const v = Number(t && t.confirmed)
      if (!Number.isFinite(h) || !Number.isFinite(v)) return
      const idx = Math.max(0, Math.min(23, Math.round(h)))
      arr[idx] = v
    })
    return arr
  }, [data])

  const langRows = useMemo(() => {
    const by = data && data.by_lang && typeof data.by_lang === 'object' ? data.by_lang : null
    let rows = []
    if (by && Object.keys(by).length) {
      rows = Object.keys(by).map((k) => [k, Number(by[k]) || 0])
    } else {
      const m = new Map()
      students.forEach((s) => {
        const k = s.lang || 'other'
        m.set(k, (m.get(k) || 0) + 1)
      })
      rows = Array.from(m.entries())
    }
    return rows.filter((r) => r[1] > 0).sort((a, b) => b[1] - a[1])
  }, [data, students])

  const langMax = langRows.reduce((m, r) => Math.max(m, r[1]), 1)

  const visible = useMemo(() => {
    const list =
      filter === 'all' ? students.slice() : students.filter((s) => normStatus(s.status) === filter)
    list.sort((a, b) => {
      const sa = STATUS_ORDER[normStatus(a.status)]
      const sb = STATUS_ORDER[normStatus(b.status)]
      if (sa !== sb) return sa - sb
      return String(a.student_id).localeCompare(String(b.student_id))
    })
    return list
  }, [students, filter])

  const refusals = Array.isArray(data && data.refusals) ? data.refusals : []

  return (
    <div className="lm-counselor-board">
      <div className="lm-counselor-stats">
        <StatCard tag="CONFIRMED" label="已确认" value={byStatus.confirmed} note="点了「我已知晓」" />
        <StatCard tag="SEEN · NO RECEIPT" label="已读未回执" value={byStatus.seen} note="打开了但没点确认" />
        <StatCard
          tag="UNREAD"
          label="未读"
          value={byStatus.unread}
          note={byStatus.unread > 0 ? `这 ${byStatus.unread} 人得催` : '全看过了'}
          noteTone={byStatus.unread > 0 ? 'red' : 'mint'}
        />
        <StatCard
          tag="NEEDS HELP"
          label="有困难"
          value={byStatus.help}
          note={byStatus.help > 0 ? '点过「我有困难」' : '暂时没人举手'}
          noteTone={byStatus.help > 0 ? 'amber' : 'muted'}
        />
      </div>

      <Card label="PROGRESS" title="总进度">
        <div className="lm-counselor-progressline">
          <Bar value={byStatus.confirmed} total={roster} height={8} />
          <div className="lm-counselor-progressline-meta">
            <span className="lm-counselor-progressline-num">
              {byStatus.confirmed} <span className="is-dim">/ {roster || '—'}</span>
            </span>
            <span className="lm-counselor-eyebrow">
              已确认 · {roster ? Math.round((byStatus.confirmed / roster) * 100) : 0}%
            </span>
          </div>
        </div>
      </Card>

      <div className="lm-counselor-board-grid">
        <Card label="LANGUAGE MIX" title="语言分布">
          {langRows.length === 0 ? (
            <p className="lm-counselor-side-hint">还没有语言数据。学生第一次打开后这里会按语言分桶。</p>
          ) : (
            <div className="lm-counselor-langrows">
              {langRows.map(([lang, n]) => (
                <div className="lm-counselor-langrow" key={lang}>
                  <span className="lm-counselor-langrow-k">{LANG_FULL[lang] || lang}</span>
                  <span className="lm-counselor-langrow-bar">
                    <span
                      className="lm-counselor-langrow-fill"
                      style={{ width: `${Math.max(2, Math.round((n / langMax) * 100))}%` }}
                    />
                  </span>
                  <span className="lm-counselor-langrow-n">{n}</span>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card label="TIMELINE" title="确认到达时间线">
          <Timeline series={series} roster={roster} />
        </Card>
      </div>

      <Card
        label={`ROSTER · ${students.length} 人`}
        title="学生名单"
        actions={
          canExport ? (
            <button
              type="button"
              className="lm-counselor-btn is-ghost is-sm"
              onClick={onExport}
              disabled={exporting}
            >
              {exporting ? '正在导出…' : '导出回执 CSV'}
            </button>
          ) : null
        }
      >
        {exportErr ? (
          <p className="lm-counselor-side-hint is-err" role="alert">
            {exportErr}
          </p>
        ) : null}

        <div className="lm-counselor-filters">
          {FILTERS.map((f) => {
            const n = f.value === 'all' ? students.length : byStatus[f.value]
            return (
              <button
                type="button"
                key={f.value}
                className={`lm-counselor-chip${filter === f.value ? ' is-on' : ''}${
                  f.value === 'unread' ? ' is-unread' : ''
                }`}
                onClick={() => setFilter(f.value)}
              >
                {f.value !== 'all' ? (
                  <span
                    className="lm-counselor-chip-dot"
                    style={{ background: STATUS_META[f.value] ? STATUS_META[f.value].color : 'var(--muted)' }}
                  />
                ) : null}
                {f.label}
                <span className="lm-counselor-chip-n">{n}</span>
              </button>
            )
          })}
          {filter === 'unread' && byStatus.unread > 0 ? (
            <button type="button" className="lm-counselor-chip is-cta" onClick={() => onGoNudge('unread')}>
              复制一段话催这 {byStatus.unread} 人 →
            </button>
          ) : null}
        </div>

        {students.length === 0 ? (
          <p className="lm-counselor-side-hint">
            还没有学生打开过。把链接发到群里，这里会一个人一个人地亮起来。
          </p>
        ) : (
          <div className="lm-counselor-table-wrap">
            <table className="lm-counselor-table">
              <thead>
                <tr>
                  <th>学号</th>
                  <th>姓名</th>
                  <th>语言</th>
                  <th>状态</th>
                  <th className="lm-counselor-col-sm">首次打开</th>
                  <th>回执时间</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {visible.map((s) => {
                  const st = normStatus(s.status)
                  const meta = STATUS_META[st]
                  return (
                    <tr key={s.student_id} className={st === 'unread' ? 'is-unread' : undefined}>
                      <td className="lm-counselor-mono">{s.student_id}</td>
                      <td>{s.name || '—'}</td>
                      <td className="lm-counselor-mono is-dim">{String(s.lang || '—').toUpperCase()}</td>
                      <td>
                        <span className="lm-counselor-status">
                          <span className="lm-counselor-status-dot" style={{ background: meta.color }} />
                          {meta.label}
                        </span>
                      </td>
                      <td className="lm-counselor-col-sm lm-counselor-mono is-dim">
                        {s.first_seen_at ? `${fmtClock(s.first_seen_at)} · ${fmtRel(s.first_seen_at)}` : '—'}
                      </td>
                      <td className="lm-counselor-mono">
                        {s.confirmed_at ? fmtDateTime(s.confirmed_at) : '—'}
                      </td>
                      <td>
                        {st === 'unread' || st === 'help' ? (
                          <button
                            type="button"
                            className="lm-counselor-rowbtn"
                            title="去催办 tab"
                            onClick={() => onGoNudge(st === 'help' ? 'help' : 'unread')}
                          >
                            催
                          </button>
                        ) : null}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
        {students.length > 0 ? (
          <div className="lm-counselor-table-foot">
            显示 {visible.length} / {students.length} 人
            {filter !== 'all' ? `（筛选：${FILTERS.find((f) => f.value === filter)?.label || filter}）` : ''}
          </div>
        ) : null}
      </Card>

      <Card label="REFUSALS · 合规证据" title="AI 主动拒绝并转人工的记录">
        {refusals.length === 0 ? (
          <p className="lm-counselor-side-hint">
            还没有拒绝记录——说明还没有学生问到签证 / 居留 / 医疗这类敏感问题。一旦问到，产品会拒绝回答、只给官方渠道，并在这里留一条。
          </p>
        ) : (
          <ul className="lm-counselor-refusals">
            {refusals.map((r, i) => (
              <li key={i} className="lm-counselor-refusal">
                <span className="lm-counselor-refusal-code">{r.reason_code || 'out_of_scope'}</span>
                <span className="lm-counselor-refusal-q">{r.question || '（未记录问题）'}</span>
                <span className="lm-counselor-refusal-t">{fmtRel(r.created_at)}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  )
}

export default function DashboardTab({ id, published, token, onGoConfirm, onGoNudge, onAuthError }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(!!published)
  const [err, setErr] = useState('')
  /* 导出按钮只给 owner。身份问不出来（401/断网/老后端）就按无权处理——不渲染按钮，不给越权留口子 */
  const [role, setRole] = useState('')

  useEffect(() => {
    let alive = true
    getMe()
      .then((m) => {
        if (alive) setRole(String((m && (m.role || (m.staff && m.staff.role))) || ''))
      })
      .catch(() => {
        if (alive) setRole('')
      })
    return () => {
      alive = false
    }
  }, [token])

  useEffect(() => {
    if (!published) {
      setLoading(false)
      return undefined
    }
    let alive = true
    setLoading(true)
    getDashboard(id)
      .then((d) => {
        if (!alive) return
        setData(d && typeof d === 'object' ? d : {})
        setErr('')
      })
      .catch((e) => {
        if (!alive) return
        if (isAuthError(e)) onAuthError(errText(e))
        setErr(errText(e))
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [id, published, token])

  if (!published) {
    return (
      <Empty
        label="NO DATA YET"
        title="还没发布，这里还没有回执"
        hint="先回「确认」核一遍字段、点发布，学生打开链接之后看板才开始长数字。"
        action={
          <Btn variant="primary" onClick={onGoConfirm}>
            去确认并发布
          </Btn>
        }
      />
    )
  }

  if (loading && !data) {
    return (
      <div className="lm-counselor-board">
        <div className="lm-counselor-stats">
          {[0, 1, 2, 3].map((i) => (
            <div className="lm-counselor-stat" key={i}>
              <Skel rows={2} />
            </div>
          ))}
        </div>
        <Card>
          <Skel rows={6} />
        </Card>
      </div>
    )
  }

  return (
    <>
      {err ? (
        <div className="lm-counselor-loaderr">
          <ErrBar message={err} />
        </div>
      ) : null}
      <BoardBody data={data} id={id} canExport={role === 'owner'} onGoNudge={onGoNudge} />
    </>
  )
}
