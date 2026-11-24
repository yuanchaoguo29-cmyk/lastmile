/* #/c —— 辅导员工作台首页：粘贴新建 + 通知列表。
   解析是「三段式打勾」，不是转圈；失败给兜底建单，绝不把人卡死。 */

import React, { useEffect, useMemo, useRef, useState } from 'react'
import { createNotice, deleteNotice, listNotices, parseNotice, patchNotice } from '../lib/api.js'
import {
  LANG_LABEL,
  NOTICE_STATUS,
  dateToSentAt,
  errText,
  fmtDateTime,
  isAuthError,
  minimalDraft,
  todayInput
} from './helpers.js'
import { Bar, Btn, Card, Empty, ErrBar, Eyebrow, Skel } from './ui.jsx'

const STAGE_TEXT = ['正在抽取要素', '正在生成小测', '正在准备多语言']
const STAGE_NOTE = ['标题 / 截止 / 地点 / 材料 / 联系人', '1 道题，答案只在服务端', '英 / 俄 / 越，各自一道题']

const SAMPLE_NOTICE = `关于2026级国际学生办理居留许可延期的通知

2026级全体国际学生：

根据成都市公安局出入境管理局要求，我校国际学生居留许可即将集中到期。现将统一办理延期事宜通知如下：

一、办理对象：2026级全体国际学生（含本科生、硕士研究生），共114人。
二、办理时间：2026年11月25日（周三）17:00前，工作日上午9:00-11:30、下午14:00-17:00。
三、办理地点：柳林校区通博楼A座204办公室（国际学生事务中心）。
四、所需材料：
  1. 护照原件及复印件1份（照片页、签证页、入境章页）；
  2. 学生证原件；
  3. 填写完整的《外国人签证证件申请表》（现场领取）；
  4. 近期免冠白底照片2张（2寸）。
五、注意事项：须本人到场办理，不接受代办。逾期未办理者，居留许可过期将按非法居留处理，后果自负。
六、联系人：张老师，028-87092233；李老师，028-87092234。

西南财经大学经济与管理研究院 学生工作办公室
2026年11月18日`

function ProgressBar({ stage }) {
  const w = stage <= 0 ? 28 : stage === 1 ? 58 : stage === 2 ? 86 : 100
  return (
    <div className="lm-counselor-progress-track">
      <div className="lm-counselor-progress-fill" style={{ width: `${w}%` }} />
    </div>
  )
}

function ParseProgress({ stage, slow, onCancel }) {
  return (
    <div className="lm-counselor-progress" role="status" aria-live="polite">
      <Eyebrow>PARSING · 不要关页面</Eyebrow>
      <div className="lm-counselor-stages">
        {STAGE_TEXT.map((text, i) => {
          const done = stage > i
          const active = stage === i
          return (
            <div
              key={text}
              className={`lm-counselor-stage${done ? ' is-done' : ''}${active ? ' is-active' : ''}`}
            >
              <span className="lm-counselor-stage-tick">{done ? '✓' : active ? '●' : '·'}</span>
              <span className="lm-counselor-stage-text">{text}</span>
              <span className="lm-counselor-stage-note">{STAGE_NOTE[i]}</span>
            </div>
          )
        })}
      </div>
      <ProgressBar stage={stage} />
      {slow ? (
        <div className="lm-counselor-slow">
          后端超过 20 秒还没返回，可以继续等，也可以取消这次解析。
          <button type="button" className="lm-counselor-linkbtn" onClick={onCancel}>
            取消
          </button>
        </div>
      ) : null}
    </div>
  )
}

function NoticeCard({ n, onDelete, deleting }) {
  const counts = n.counts && typeof n.counts === 'object' ? n.counts : {}
  const roster = Number(counts.roster) || 0
  const confirmed = Number(counts.confirmed) || 0
  const meta = NOTICE_STATUS[n.status] || NOTICE_STATUS.draft
  const langs = Array.isArray(n.langs) ? n.langs : []
  return (
    <div className="lm-counselor-ncardwrap">
      <a className="lm-counselor-ncard" href={`#/c/${n.id}`}>
      <div className="lm-counselor-ncard-top">
        <span className="lm-counselor-ncard-dot" style={{ background: meta.color }} />
        <span className="lm-counselor-ncard-title">{n.title_zh || '未命名通知'}</span>
      </div>
      <div className="lm-counselor-ncard-meta">
        <span className="lm-counselor-ncard-status">{meta.label}</span>
        <span className="lm-counselor-mono is-dim">
          {n.deadline_at ? `截止 ${fmtDateTime(n.deadline_at)}` : '无截止时间'}
        </span>
      </div>
      <Bar value={confirmed} total={roster} />
      <div className="lm-counselor-ncard-foot">
        <span className="lm-counselor-ncard-count">
          <b>{confirmed}</b> / {roster || '—'} 已确认
        </span>
        <span className="lm-counselor-langs">
          {langs.slice(0, 6).map((l) => (
            <span key={l} className="lm-counselor-lang">
              {LANG_LABEL[l] || String(l).toUpperCase()}
            </span>
          ))}
        </span>
      </div>
      </a>
      <button
        type="button"
        className="lm-counselor-ndel"
        title="删除这份通知"
        aria-label={`删除通知 ${n.title_zh || '未命名通知'}`}
        disabled={Boolean(deleting)}
        onClick={(e) => {
          e.preventDefault()
          e.stopPropagation()
          if (onDelete) onDelete(n)
        }}
      >
        {deleting ? '…' : '×'}
      </button>
    </div>
  )
}

export default function NoticeList({ token, onHandoff, onCreated, onAuthError }) {
  const [notices, setNotices] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const [raw, setRaw] = useState('')
  const [date, setDate] = useState(todayInput)
  const [phase, setPhase] = useState('idle')
  const [stage, setStage] = useState(0)
  const [slow, setSlow] = useState(false)
  const [parseErr, setParseErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [deletingId, setDeletingId] = useState('')

  const runRef = useRef({ cancelled: true, timers: [] })

  function clearTimers() {
    runRef.current.timers.forEach((t) => clearTimeout(t))
    runRef.current.timers = []
  }

  function arm(fn, ms) {
    const t = setTimeout(fn, ms)
    runRef.current.timers.push(t)
    return t
  }

  useEffect(() => () => {
    runRef.current.cancelled = true
    clearTimers()
  }, [])

  const load = () => {
    let alive = true
    setLoading(true)
    listNotices()
      .then((d) => {
        if (!alive) return
        const list = Array.isArray(d && d.notices) ? d.notices : []
        list.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))
        setNotices(list)
        setError('')
      })
      .catch((e) => {
        if (!alive) return
        if (isAuthError(e)) onAuthError(errText(e))
        setError(errText(e))
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }

  useEffect(load, [token])

  /* 删除一份通知：先确认，成功后就地把这张卡拿掉，不整页刷新 */
  async function removeNotice(n) {
    const title = n.title_zh || '未命名通知'
    const ok = window.confirm(
      `删除「${title}」？\n\n这份通知的回执、小测记录、拒绝日志会一起删掉，不可恢复。`
    )
    if (!ok) return
    setDeletingId(n.id)
    setError('')
    try {
      await deleteNotice(n.id)
      setNotices((prev) => prev.filter((x) => x.id !== n.id))
    } catch (e) {
      if (isAuthError(e)) onAuthError(errText(e))
      setError(errText(e))
    } finally {
      setDeletingId('')
    }
  }

  const sentAt = useMemo(() => dateToSentAt(date), [date])

  async function startParse() {
    const text = raw.trim()
    if (!text) {
      setPhase('error')
      setParseErr('先把中文通知原文粘进上面的框里')
      return
    }
    const run = { cancelled: false, timers: [] }
    runRef.current = run
    setPhase('parsing')
    setStage(0)
    setSlow(false)
    setParseErr('')
    const t0 = Date.now()
    arm(() => {
      if (!run.cancelled) setStage(1)
    }, 1500)
    arm(() => {
      if (!run.cancelled) setStage(2)
    }, 3000)
    arm(() => {
      if (!run.cancelled) setSlow(true)
    }, 20000)

    try {
      const res = await parseNotice(text, sentAt)
      if (run.cancelled) return
      /* 每一段至少露脸 1.5 秒，总共不少于 4.5 秒：让人看清在干什么，而不是闪一下 */
      const wait = Math.max(0, 4500 - (Date.now() - t0))
      if (wait > 0) {
        await new Promise((resolve) => {
          arm(resolve, wait)
        })
      }
      if (run.cancelled) return
      clearTimers()
      const draft = res && res.draft
      if (!draft || typeof draft !== 'object') {
        throw new Error('后端没有返回结构化结果，可以点「仍然用原文创建」继续')
      }
      setStage(3)
      setSlow(false)
      await new Promise((resolve) => setTimeout(resolve, 240))
      onHandoff({ draft, raw_text: text, sent_at: sentAt, meta: res.meta || null })
    } catch (e) {
      if (run.cancelled) return
      clearTimers()
      setSlow(false)
      setPhase('error')
      if (isAuthError(e)) {
        onAuthError(errText(e))
        setParseErr('密钥可能不对，先在右上角齿轮里填一下')
      } else {
        setParseErr(errText(e))
      }
    }
  }

  function cancelParse() {
    runRef.current.cancelled = true
    clearTimers()
    setSlow(false)
    setStage(0)
    setPhase('idle')
  }

  async function createFromRaw() {
    const text = raw.trim()
    if (!text) {
      setPhase('error')
      setParseErr('先把中文通知原文粘进上面的框里')
      return
    }
    setBusy(true)
    setParseErr('')
    const structured = minimalDraft(text)
    try {
      const res = await createNotice({ raw_text: text, structured, sent_at: sentAt })
      const nid = res && res.notice && res.notice.id
      if (!nid) throw new Error('后端没有返回通知 id，没法继续')
      /* 兜底建单是为了进确认页补字段——尽力把状态落回草稿，别让半成品直接发给学生 */
      try {
        await patchNotice(nid, { status: 'draft' })
      } catch {
        /* 后端若不支持改回草稿，就带着草稿态进确认页，人工确认后再发布 */
      }
      onCreated({ draft: structured, raw_text: text, sent_at: sentAt, id: nid })
    } catch (e) {
      if (isAuthError(e)) onAuthError(errText(e))
      setParseErr(errText(e))
    } finally {
      setBusy(false)
    }
  }

  const parsing = phase === 'parsing'

  return (
    <div className="lm-counselor-wrap">
      <section className="lm-counselor-compose">
        <div className="lm-counselor-compose-head">
          <Eyebrow>PASTE · PARSE · PUBLISH</Eyebrow>
          <h2 className="lm-counselor-h2">粘一条中文通知，剩下交给它</h2>
          <p className="lm-counselor-lead">
            抽要素 → 你核一遍 → 自动出小测和多语言 → 一个链接发群里，谁确认了自动记账。
          </p>
        </div>

        <textarea
          className="lm-counselor-textarea is-raw"
          rows={9}
          value={raw}
          spellCheck={false}
          placeholder="关于2026级国际学生办理居留许可延期的通知"
          onChange={(e) => {
            setRaw(e.target.value)
            if (phase === 'error') {
              setPhase('idle')
              setParseErr('')
            }
          }}
        />

        <div className="lm-counselor-compose-foot">
          <label className="lm-counselor-inline-field">
            <span className="lm-counselor-eyebrow">通知发出日期</span>
            <input
              type="date"
              className="lm-counselor-input is-date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
            <span className="lm-counselor-hint">用来推算「下周三」这类相对时间</span>
          </label>
          <div className="lm-counselor-compose-actions">
            <button
              type="button"
              className="lm-counselor-linkbtn"
              onClick={() => {
                setRaw(SAMPLE_NOTICE)
                setPhase('idle')
                setParseErr('')
              }}
            >
              填入示例通知
            </button>
            <Btn variant="primary" size="lg" onClick={startParse} disabled={parsing}>
              {parsing ? '解析中…' : '开始解析'}
            </Btn>
          </div>
        </div>

        {parsing ? <ParseProgress stage={stage} slow={slow} onCancel={cancelParse} /> : null}

        {phase === 'error' && !parsing ? (
          <div className="lm-counselor-parsefail">
            <ErrBar message={parseErr} onRetry={startParse} retryLabel="再试一次" />
            <div className="lm-counselor-fallback">
              <span className="lm-counselor-fallback-t">
                解析不出来也能往下走：用原文建单，字段在确认页手工补。
              </span>
              <Btn variant="amber" onClick={createFromRaw} disabled={busy || !raw.trim()}>
                {busy ? '正在建单…' : '仍然用原文创建'}
              </Btn>
            </div>
          </div>
        ) : null}
      </section>

      <section className="lm-counselor-list">
        <header className="lm-counselor-list-head">
          <div>
            <Eyebrow>NOTICES · {notices.length} 份</Eyebrow>
            <h2 className="lm-counselor-h3">通知列表</h2>
          </div>
          <Btn size="sm" onClick={load} disabled={loading}>
            {loading ? '刷新中…' : '刷新'}
          </Btn>
        </header>

        {error ? <ErrBar message={error} onRetry={load} /> : null}

        {loading && notices.length === 0 ? (
          <div className="lm-counselor-cards">
            {[0, 1, 2].map((i) => (
              <Card key={i}>
                <Skel rows={3} />
              </Card>
            ))}
          </div>
        ) : notices.length === 0 ? (
          <Empty
            label="EMPTY"
            title="还没有通知"
            hint="把上面那条中文通知粘进去，点「开始解析」，30 秒后这里会多一张卡片。"
          />
        ) : (
          <div className="lm-counselor-cards">
            {notices.map((n) => (              <NoticeCard
                key={n.id}
                n={n}
                deleting={deletingId === n.id}
                onDelete={removeNotice}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
