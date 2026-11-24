/* 辅导员端根组件：门禁 → 顶栏 → 路由分发。
   #/c → 列表 / 新建；#/c/:id → 单份通知；#/c/draft → 刚解析完、还没落库的确认态。
   进入即拦：没有通过校验的访问密码，看不到任何学生数据。 */

import React, { useEffect, useRef, useState } from 'react'
import { getCounselorKey, setCounselorKey, listNotices, getMe } from '../lib/api.js'
import NoticeList from './NoticeList.jsx'
import NoticeDetail from './NoticeDetail.jsx'
import SettingsPanel from './SettingsPanel.jsx'
import RosterPanel from './RosterPanel.jsx'
import { Btn, Eyebrow } from './ui.jsx'

function isAuthError(e) {
  return /401|unauthor|密钥|未授权|key|密码/i.test(String(e?.message || ''))
}

function GearIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="7.4" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="12" cy="12" r="2.9" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M12 2.2v2.4M12 19.4v2.4M2.2 12h2.4M19.4 12h2.4M5.1 5.1l1.7 1.7M17.2 17.2l1.7 1.7M18.9 5.1l-1.7 1.7M6.8 17.2l-1.7 1.7"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  )
}

function RosterIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="9" cy="8" r="3.2" stroke="currentColor" strokeWidth="1.5" />
      <path d="M3.4 19.2c.5-3 2.7-4.6 5.6-4.6s5.1 1.6 5.6 4.6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M16 5.4a3 3 0 0 1 0 5.6M17.2 14.9c2 .4 3.2 1.9 3.5 4.3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

function LockScreen({ busy, message, onSubmit }) {
  const [v, setV] = useState('')
  const ref = useRef(null)

  useEffect(() => {
    ref.current?.focus()
  }, [])

  return (
    <div className="lm-root lm-counselor lm-lock">
      <form
        className="lm-lock-card"
        onSubmit={(e) => {
          e.preventDefault()
          onSubmit(v)
        }}
      >
        <div className="lm-lock-brand">
          <span className="lm-lock-mark" aria-hidden="true">
            ✓
          </span>
          <span className="lm-lock-brand-text">
            <span className="lm-lock-name">最后一公里 · LastMile</span>
            <span className="lm-lock-sub">COUNSELOR CONSOLE</span>
          </span>
        </div>

        <h1 className="lm-lock-title">辅导员工作台</h1>
        <p className="lm-lock-desc">
          这份工作台能看到 114 名学生的姓名、回执与求助记录。输入访问密码后进入。
        </p>

        <label className="lm-lock-label" htmlFor="lm-lock-pw">
          ACCESS · 访问密码
        </label>
        <input
          id="lm-lock-pw"
          ref={ref}
          className="lm-lock-input"
          type="password"
          value={v}
          autoComplete="current-password"
          placeholder="••••••••"
          disabled={busy}
          onChange={(e) => setV(e.target.value)}
        />

        {message ? (
          <p className="lm-lock-err" role="alert">
            {message}
          </p>
        ) : null}

        <button className="lm-lock-btn" type="submit" disabled={busy}>
          {busy ? '验证中…' : '进入工作台'}
        </button>

        <p className="lm-lock-note">密码只保存在这台设备的浏览器里，不会上传。</p>
      </form>
    </div>
  )
}

export default function CounselorApp({ id }) {
  const [now, setNow] = useState(() => new Date())
  const [locked, setLocked] = useState(true)
  const [busy, setBusy] = useState(() => Boolean(getCounselorKey()))
  const [lockMsg, setLockMsg] = useState('')
  const [token, setToken] = useState(0)
  const [pending, setPending] = useState(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [rosterOpen, setRosterOpen] = useState(false)
  const [accountOpen, setAccountOpen] = useState(false)
  const [me, setMe] = useState(null)

  /* 解锁后问一次「我是谁」：owner 才能看到设置入口 */
  useEffect(() => {
    if (locked) return
    let alive = true
    getMe()
      .then((m) => {
        if (alive) setMe(m)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [locked])

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(t)
  }, [])

  /* 回到这一页时，已存过密码就静默验一次，别让人每次重输；验不过就留在门口。 */
  useEffect(() => {
    let alive = true
    const stored = getCounselorKey()
    if (!stored) {
      setBusy(false)
      return
    }
    ;(async () => {
      try {
        await listNotices()
        if (alive) setLocked(false)
      } catch (e) {
        if (!alive) return
        if (isAuthError(e)) {
          setCounselorKey('')
          setLockMsg('')
        } else {
          setLockMsg(String(e?.message || '校验失败'))
        }
      } finally {
        if (alive) setBusy(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  async function submit(v) {
    const clean = String(v || '').trim()
    if (!clean) {
      setLockMsg('请输入密码')
      return
    }
    setBusy(true)
    setLockMsg('')
    setCounselorKey(clean)
    try {
      await listNotices()
      setLocked(false)
      setToken((n) => n + 1)
    } catch (e) {
      setCounselorKey('')
      setLockMsg(isAuthError(e) ? '密码不对，再试一次' : String(e?.message || '校验失败'))
    } finally {
      setBusy(false)
    }
  }

  /* 会话里数据请求 401 → 回到门口，而不是白屏 */
  function needKey(message) {
    setSettingsOpen(false)
    setLockMsg(message || '密码已失效，请重新输入')
    setLocked(true)
  }

  /* 设置面板里的「锁定工作台」：收起面板再回门口 */
  function lockConsole() {
    setSettingsOpen(false)
    setLockMsg('')
    setLocked(true)
  }

  /* 解析完 → 带着草稿进 #/c/draft，让辅导员先核字段 */
  function handleHandoff(payload) {
    setPending({ ...payload, sourceId: null, publishedId: null })
    if (location.hash !== '#/c/draft') location.hash = '#/c/draft'
  }

  /* 兜底建单（解析失败时用原文建）→ 拿到 id 后进确认页补字段 */
  function handleCreated(payload) {
    setPending({ ...payload, sourceId: payload.id, publishedId: null })
    const h = `#/c/${payload.id}`
    if (location.hash !== h) location.hash = h
  }

  function handlePublished(nid, payload) {
    setPending((prev) => ({ ...(prev || {}), ...payload, sourceId: nid, publishedId: nid }))
    const h = `#/c/${nid}`
    if (location.hash !== h) location.replace(h)
  }

  function handleDraftSaved(nid, payload) {
    setPending((prev) => ({ ...(prev || {}), ...payload, sourceId: nid }))
    const h = `#/c/${nid}`
    if (location.hash !== h) location.replace(h)
  }

  if (locked) return <LockScreen busy={busy} message={lockMsg} onSubmit={submit} />

  const clock = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(
    now.getSeconds()
  ).padStart(2, '0')}`

  return (
    <div className="lm-root lm-counselor">
      <header className="lm-counselor-top">
        <div className="lm-counselor-top-in">
          <a className="lm-counselor-brand" href="#/c">
            <span className="lm-counselor-brand-mark" aria-hidden="true">
              ✓
            </span>
            <span className="lm-counselor-brand-text">
              <span className="lm-counselor-brand-name">最后一公里 · LastMile</span>
              <span className="lm-counselor-brand-sub">COUNSELOR CONSOLE</span>
            </span>
          </a>

          <div className="lm-counselor-top-right">
            <span className="lm-counselor-clock" title="本机时间">
              {clock}
            </span>
            <span
              className="lm-counselor-keydot"
              title={me ? `${me.name} · ${me.role === 'owner' ? '主账号' : '助理'}` : '已通过访问密码校验'}
            >
              {me ? (me.role === 'owner' ? 'OWNER' : me.name) : 'KEY'}
            </span>
            <button
              type="button"
              className="lm-counselor-iconbtn"
              onClick={() => setRosterOpen(true)}
              title="花名册"
              aria-label="花名册"
            >
              <RosterIcon />
            </button>
            <button
              type="button"
              className="lm-counselor-iconbtn"
              onClick={() => {
                if (me && me.role !== 'owner') setAccountOpen(true)
                else setSettingsOpen(true)
              }}
              title={me && me.role !== 'owner' ? '我的账号' : '设置'}
              aria-label={me && me.role !== 'owner' ? '我的账号' : '设置'}
            >
              <GearIcon />
            </button>
          </div>
        </div>
      </header>

      {id ? (
        <NoticeDetail
          key={id}
          id={id}
          pending={pending}
          token={token}
          onAuthError={needKey}
          onPublished={handlePublished}
          onDraftSaved={handleDraftSaved}
        />
      ) : (
        <NoticeList
          token={token}
          onHandoff={handleHandoff}
          onCreated={handleCreated}
          onAuthError={needKey}
        />
      )}

      <SettingsPanel open={settingsOpen} onClose={() => setSettingsOpen(false)} onLock={lockConsole} />

      <RosterPanel open={rosterOpen} onClose={() => setRosterOpen(false)} />

      {accountOpen ? (
        <div className="lm-counselor-modal" role="dialog" aria-modal="true" aria-label="我的账号">
          <div className="lm-counselor-modal-box">
            <Eyebrow>ACCOUNT · 助理账号</Eyebrow>
            <h3 className="lm-counselor-modal-title">{me?.name || '助理'}</h3>
            <p className="lm-counselor-modal-hint">
              你以助理身份登录：能建通知、看板、催办、导出回执。访问密码和 API 配置只有辅导员主账号能改。
            </p>
            <div className="lm-counselor-modal-actions">
              <Btn onClick={() => setAccountOpen(false)}>关闭</Btn>
              <Btn
                variant="primary"
                onClick={() => {
                  setAccountOpen(false)
                  lockConsole()
                }}
              >
                锁定工作台
              </Btn>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
