/* #/c/:id —— 单份通知：确认 / 看板 / 催办三个 tab。
   路由是 hash，id 由 main.jsx 传进来；#/c/draft 表示「刚解析完、还没落库」。 */

import React, { useEffect, useMemo, useState } from 'react'
import { createNotice, getNotice, patchNotice, translateNotice } from '../lib/api.js'
import {
  NOTICE_STATUS,
  errText,
  fmtDateTime,
  isAuthError,
  leftText,
  normalizeStructured,
  studentLink
} from './helpers.js'
import { Empty, ErrBar, Eyebrow, Skel } from './ui.jsx'
import ConfirmTab, { PublishedPanel } from './ConfirmTab.jsx'
import DashboardTab from './DashboardTab.jsx'
import NudgeTab from './NudgeTab.jsx'

const TABS = [
  { key: 'confirm', zh: '确认', en: 'CONFIRM' },
  { key: 'board', zh: '看板', en: 'BOARD' },
  { key: 'nudge', zh: '催办', en: 'NUDGE' }
]

/* GET /api/notices/:id 的返回可能包一层，取里面的通知对象 */
function extractNotice(res) {
  if (!res || typeof res !== 'object') return null
  const n = res.notice && typeof res.notice === 'object' ? res.notice : res
  return n && (n.id || n.structured || n.title_zh) ? n : null
}

export default function NoticeDetail({
  id,
  pending,
  token,
  onAuthError,
  onPublished,
  onDraftSaved
}) {
  const isDraftRoute = id === 'draft'
  const pendingForMe = useMemo(() => {
    if (!pending) return null
    if (isDraftRoute) return pending
    if (pending.sourceId === id || pending.publishedId === id) return pending
    return null
  }, [pending, id, isDraftRoute])

  const isDraftFlow = isDraftRoute || !!(pendingForMe && pendingForMe.sourceId === id && !pendingForMe.publishedId)
  const justPublished = !!(pendingForMe && pendingForMe.publishedId === id)

  const [notice, setNotice] = useState(null)
  const [loading, setLoading] = useState(!isDraftRoute)
  const [loadErr, setLoadErr] = useState('')
  const [reload, setReload] = useState(0)
  const [tab, setTab] = useState('confirm')
  const [form, setForm] = useState(() => normalizeStructured(pendingForMe && pendingForMe.draft))
  const [busy, setBusy] = useState('')
  const [actionErr, setActionErr] = useState('')
  const [actionNote, setActionNote] = useState('')
  const [published, setPublished] = useState(false)
  const [noticeId, setNoticeId] = useState(isDraftRoute ? null : id)
  const [nudgeSeed, setNudgeSeed] = useState(null)

  useEffect(() => {
    if (isDraftRoute) {
      setLoading(false)
      return undefined
    }
    let alive = true
    setLoading(true)
    getNotice(id)
      .then((res) => {
        if (!alive) return
        const n = extractNotice(res)
        if (!n) throw new Error('后端没有返回这份通知，可能 id 不对')
        setNotice(n)
        setLoadErr('')
        /* 从兜底建单进来的，页面里已经有更可信的草稿，不用服务端的覆盖 */
        if (!isDraftFlow) setForm(normalizeStructured(n.structured || n.draft || {}))
      })
      .catch((e) => {
        if (!alive) return
        if (isAuthError(e)) onAuthError(errText(e))
        setLoadErr(errText(e))
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [id, token, reload])

  const serverStatus = String((notice && notice.status) || '')
  const showPublished = published || justPublished || (!isDraftFlow && (serverStatus === 'published' || serverStatus === 'closed'))
  const rawText = (pendingForMe && pendingForMe.raw_text) || (notice && notice.raw_text) || ''
  const meta = NOTICE_STATUS[showPublished ? 'published' : serverStatus] || NOTICE_STATUS.draft
  const counts = (notice && notice.counts) || null
  const title = form.title_zh || (notice && notice.title_zh) || '未命名通知'

  function fillLangs(nid) {
    translateNotice(nid, ['en', 'ru', 'vi'])
      .then(() => setActionNote('多语言已补齐：英 / 俄 / 越，每一种都有独立小测。'))
      .catch(() => setActionNote('链接已经能用了；多语言暂时没补齐，可稍后在确认页重试。'))
  }

  async function publish() {
    setBusy('publish')
    setActionErr('')
    setActionNote('')
    const sentAt = (pendingForMe && pendingForMe.sent_at) || (notice && notice.sent_at) || null
    try {
      let nid = noticeId
      if (!nid) {
        if (!rawText) {
          throw new Error('这份草稿的原文不在这台浏览器里了，回列表重新粘一次更快')
        }
        const res = await createNotice({ raw_text: rawText, structured: form, sent_at: sentAt })
        nid = res && res.notice && res.notice.id
        if (!nid) throw new Error('后端没有返回通知 id，发布没成功')
        setNoticeId(nid)
        setNotice(res.notice || null)
      } else {
        const res = await patchNotice(nid, { structured: form, status: 'published' })
        const n = res && (res.notice || res)
        if (n && typeof n === 'object' && n.id) {
          setNotice((prev) => ({ ...(prev || {}), ...n }))
        }
      }
      setPublished(true)
      setActionNote('已发布。把链接发到班级群，回执会自动回到看板。')
      onPublished(nid, { draft: form, raw_text: rawText, sent_at: sentAt })
      fillLangs(nid)
    } catch (e) {
      if (isAuthError(e)) onAuthError(errText(e))
      setActionErr(errText(e))
    } finally {
      setBusy('')
    }
  }

  async function saveDraft() {
    setBusy('draft')
    setActionErr('')
    setActionNote('')
    const sentAt = (pendingForMe && pendingForMe.sent_at) || (notice && notice.sent_at) || null
    try {
      if (noticeId) {
        await patchNotice(noticeId, { structured: form })
        setActionNote(showPublished ? '已保存。学生端会同步看到修改。' : '已保存草稿。学生看不到，发布后才生效。')
        onDraftSaved(noticeId, { draft: form, raw_text: rawText, sent_at: sentAt })
      } else {
        if (!rawText) throw new Error('原文不在这台浏览器里了，回列表重新粘一次')
        const res = await createNotice({ raw_text: rawText, structured: form, sent_at: sentAt })
        const nid = res && res.notice && res.notice.id
        if (!nid) throw new Error('后端没有返回通知 id，草稿没存上')
        /* 尽力落成草稿态，别让半成品直接出现在学生端 */
        try {
          await patchNotice(nid, { status: 'draft' })
        } catch {
          /* 后端不支持改回草稿也不挡流程：确认页会继续停在这里让人核 */
        }
        setNoticeId(nid)
        setNotice(res.notice || null)
        setActionNote('草稿已存。链接还不会发给学生。')
        onDraftSaved(nid, { draft: form, raw_text: rawText, sent_at: sentAt })
      }
    } catch (e) {
      if (isAuthError(e)) onAuthError(errText(e))
      setActionErr(errText(e))
    } finally {
      setBusy('')
    }
  }

  function goNudge(tier) {
    setNudgeSeed({ tier, n: Date.now() })
    setTab('nudge')
  }

  /* #/c/draft 刷新后：这次解析只活在内存里，得说清楚怎么办 */
  if (isDraftRoute && !pendingForMe) {
    return (
      <div className="lm-counselor-wrap">
        <div className="lm-counselor-detail-head">
          <a className="lm-counselor-back" href="#/c">
            ← 全部通知
          </a>
        </div>
        <Empty
          label="DRAFT LOST"
          title="这次解析的草稿没保存下来"
          hint="刚解析完的草稿只活在这个页面里，一刷新就没了。回列表重新粘一次原文，30 秒就好。"
          action={
            <a className="lm-counselor-btn is-primary is-md" href="#/c">
              回列表重新创建
            </a>
          }
        />
      </div>
    )
  }

  return (
    <div className="lm-counselor-wrap">
      <div className="lm-counselor-detail-head">
        <a className="lm-counselor-back" href="#/c">
          ← 全部通知
        </a>
        <div className="lm-counselor-detail-title">
          <Eyebrow>
            NOTICE · {meta.label}
            {form.kind ? ` · ${String(form.kind).toUpperCase()}` : ''}
          </Eyebrow>
          <h2 className="lm-counselor-h2 is-detail">{title}</h2>
          <div className="lm-counselor-detail-meta">
            <span className={`lm-counselor-status${showPublished ? ' is-live' : ''}`}>
              <span className="lm-counselor-status-dot" style={{ background: meta.color }} />
              {meta.label}
            </span>
            <span className="lm-counselor-mono is-dim">
              {form.deadline.iso ? `截止 ${fmtDateTime(form.deadline.iso)} · ${leftText(form.deadline.iso)}` : '截止时间待填'}
            </span>
            {counts && counts.roster ? (
              <span className="lm-counselor-mono is-dim">
                {Number(counts.confirmed) || 0} / {counts.roster} 已确认
              </span>
            ) : null}
          </div>
        </div>
        <div className="lm-counselor-detail-acts">
          {showPublished && noticeId ? (
            <a
              className="lm-counselor-btn is-ghost is-sm"
              href={`#/s/${noticeId}`}
              target="_blank"
              rel="noreferrer"
            >
              打开学生页
            </a>
          ) : null}
        </div>
      </div>

      <div className="lm-counselor-tabs" role="tablist">
        {TABS.map((t) => (
          <button
            type="button"
            key={t.key}
            role="tab"
            aria-selected={tab === t.key}
            className={`lm-counselor-tab${tab === t.key ? ' is-on' : ''}`}
            onClick={() => setTab(t.key)}
          >
            <span className="lm-counselor-tab-en">{t.en}</span>
            <span className="lm-counselor-tab-zh">{t.zh}</span>
            {t.key === 'board' && showPublished && counts && counts.roster ? (
              <span className="lm-counselor-tab-n">
                {Number(counts.confirmed) || 0}/{counts.roster}
              </span>
            ) : null}
          </button>
        ))}
      </div>

      {loadErr ? (
        <div className="lm-counselor-loaderr">
          <ErrBar message={loadErr} onRetry={() => setReload((n) => n + 1)} />
        </div>
      ) : null}

      {loading && !notice && !form.title_zh ? (
        <div className="lm-counselor-loading">
          <Skel rows={8} />
        </div>
      ) : null}

      {tab === 'confirm' ? (
        showPublished ? (
          <PublishedPanel
            form={form}
            noticeId={noticeId || id}
            rawLink={studentLink(noticeId || id)}
            qrDataUrl={(notice && notice.qr_data_url) || null}
          />
        ) : (
          <ConfirmTab
            form={form}
            onChange={setForm}
            status={serverStatus || 'draft'}
            quiz={notice && notice.quiz ? notice.quiz : null}
            translations={notice && notice.translations ? notice.translations : null}
            counts={counts}
            rawText={rawText}
            busy={busy}
            err={actionErr}
            note={actionNote}
            onPublish={publish}
            onSaveDraft={saveDraft}
          />
        )
      ) : null}

      {tab === 'board' ? (
        <DashboardTab
          id={noticeId || id}
          published={showPublished}
          token={token}
          onGoConfirm={() => setTab('confirm')}
          onGoNudge={goNudge}
          onAuthError={onAuthError}
        />
      ) : null}

      {tab === 'nudge' ? (
        <NudgeTab
          id={noticeId || id}
          published={showPublished}
          seed={nudgeSeed}
          onGoConfirm={() => setTab('confirm')}
          onAuthError={onAuthError}
        />
      ) : null}
    </div>
  )
}
