/* 辅导员端根组件：门禁 → 顶栏 → 路由分发。
   #/c → 列表 / 新建；#/c/:id → 单份通知；#/c/draft → 刚解析完、还没落库的确认态。
   进入即拦：没有通过校验的访问密码，看不到任何学生数据。 */

import React, { useEffect, useRef, useState } from 'react'
import {
  changeCounselorKey,
  getCounselorKey,
  getCounselorUser,
  setCounselorKey,
  setCounselorUser,
  listNotices,
  login,
  getMe
} from '../lib/api.js'
import NoticeList from './NoticeList.jsx'
import NoticeDetail from './NoticeDetail.jsx'
import SettingsPanel from './SettingsPanel.jsx'
import RosterPanel from './RosterPanel.jsx'
import AccountPanel from './AccountPanel.jsx'
import { Btn, Eyebrow } from './ui.jsx'

/* 登录态失效：优先看 HTTP 状态码（401/403），老服务端只给文案时才退回正则 */
function isAuthError(e) {
  const status = Number(e?.status)
  if (status === 401 || status === 403) return true
  return /401|unauthor|密钥|未授权|key|密码|账号/i.test(String(e?.message || ''))
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
  /* 账号与密码都留在本组件里：验证失败时输入原样保留，只多一行红字 */
  const [user, setUser] = useState('')
  const [pw, setPw] = useState('')
  const userRef = useRef(null)

  useEffect(() => {
    userRef.current?.focus()
  }, [])

  return (
    <div className="lm-root lm-counselor lm-lock">
      <form
        className="lm-lock-card"
        onSubmit={(e) => {
          e.preventDefault()
          onSubmit(user, pw)
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
          这份工作台能看到 114 名学生的姓名、回执与求助记录。用账号和密码进入。
        </p>

        <div className="lm-lock-field">
          <label className="lm-lock-label" htmlFor="lm-lock-user">
            ACCOUNT · 账号
          </label>
          <input
            id="lm-lock-user"
            ref={userRef}
            className="lm-lock-input lm-lock-user"
            type="text"
            value={user}
            autoComplete="username"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck="false"
            placeholder="owner"
            disabled={busy}
            onChange={(e) => setUser(e.target.value)}
          />
        </div>

        <div className="lm-lock-field">
          <label className="lm-lock-label" htmlFor="lm-lock-pw">
            ACCESS · 密码
          </label>
          <input
            id="lm-lock-pw"
            className="lm-lock-input"
            type="password"
            value={pw}
            autoComplete="current-password"
            placeholder="••••••••"
            disabled={busy}
            onChange={(e) => setPw(e.target.value)}
          />
        </div>

        {message ? (
          <p className="lm-lock-err" role="alert">
            {message}
          </p>
        ) : null}

        <button className="lm-lock-btn" type="submit" disabled={busy}>
          {busy ? '验证中…' : '进入工作台'}
        </button>
      </form>
    </div>
  )
}

export default function CounselorApp({ id }) {
  const [now, setNow] = useState(() => new Date())
  const [locked, setLocked] = useState(true)
  const [busy, setBusy] = useState(() => Boolean(getCounselorKey() && getCounselorUser()))
  const [lockMsg, setLockMsg] = useState('')
  const [token, setToken] = useState(0)
  const [pending, setPending] = useState(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [rosterOpen, setRosterOpen] = useState(false)
  const [accountOpen2, setAccountOpen2] = useState(false)
  const [accountOpen, setAccountOpen] = useState(false)
  const [me, setMe] = useState(null)

  /* 「我的账号」里改自己的登录密码（非 owner 才有这一块） */
  const [pwCur, setPwCur] = useState('')
  const [pwNext, setPwNext] = useState('')
  const [pwConfirm, setPwConfirm] = useState('')
  const [pwBusy, setPwBusy] = useState(false)
  const [pwMsg, setPwMsg] = useState(null) /* { tone, text } | null */

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

  /* 回到这一页时，已存过账号 + 密码就静默验一次，别让人每次重输；验不过就留在门口。
     只存了老版本的密码、没有账号的会话不再自动放行（新登录必须带账号）。 */
  useEffect(() => {
    let alive = true
    const stored = getCounselorKey()
    const storedUser = getCounselorUser()
    if (!stored || !storedUser) {
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
          setCounselorUser('')
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

  /* 登录：先调 /api/auth/login 验账号 + 密码，通过了才把这两个值落到本机 */
  async function submit(rawUser, rawPw) {
    const user = String(rawUser || '').trim()
    const pw = String(rawPw ?? '')
    if (!user) {
      setLockMsg('请输入账号')
      return
    }
    if (!pw) {
      setLockMsg('请输入密码')
      return
    }
    setBusy(true)
    setLockMsg('')
    /* 换人登录时先丢掉上一位的身份，避免顶栏短暂显示旧账号 */
    setMe(null)
    try {
      const out = await login(user, pw)
      setCounselorUser(user)
      setCounselorKey(pw)
      if (out && out.me && typeof out.me === 'object') setMe(out.me)
      setLocked(false)
      setToken((n) => n + 1)
    } catch (e) {
      /* 没登进去就不留半份凭据，免得下一次请求带着错的身份出去 */
      setCounselorKey('')
      setCounselorUser('')
      const status = Number(e?.status)
      if (status === 429) {
        /* 限速不是密码错：原样告诉人还要等多久 */
        setLockMsg(String(e?.message || '尝试次数太多，请稍后再试'))
      } else {
        setLockMsg(isAuthError(e) ? '账号或密码不对' : String(e?.message || '校验失败'))
      }
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

  /* 打开「我的账号」：每次进来都清掉上一次输的密码 */
  function openMyAccount() {
    setPwCur('')
    setPwNext('')
    setPwConfirm('')
    setPwBusy(false)
    setPwMsg(null)
    setAccountOpen(true)
  }

  /* 改自己的登录密码：非 owner 由 api.js 分流到 PATCH /api/staff/me/password（body { current, next }） */
  async function submitMyPassword() {
    if (!pwReady) return
    setPwBusy(true)
    setPwMsg(null)
    try {
      await changeCounselorKey(pwCur, pwNext, false)
      setPwMsg({ tone: 'ok', text: '已修改，下次登录用新密码' })
      setPwCur('')
      setPwNext('')
      setPwConfirm('')
    } catch (err) {
      setPwMsg({ tone: 'err', text: String(err?.message || '修改失败，再试一次') })
    } finally {
      setPwBusy(false)
    }
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

  /* 「我的账号」改密表单的即时校验 */
  const pwTooShort = pwNext.length > 0 && pwNext.length < 6
  const pwMismatch = pwConfirm.length > 0 && pwNext !== pwConfirm
  const pwSame = pwNext.length > 0 && pwNext === pwCur
  const pwReady = pwCur.length > 0 && pwNext.length >= 6 && pwNext === pwConfirm && !pwSame && !pwBusy

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
              title={
                me
                  ? `${me.username || me.name} · ${
                      me.role === 'owner' ? '总管' : me.role === 'counselor' ? '辅导员' : '助理'
                    }`
                  : '已通过账号密码校验'
              }
            >
              {me ? (me.role === 'owner' ? 'OWNER' : me.username || me.name) : 'KEY'}
            </span>
            <button
              type="button"
              className="lm-counselor-iconbtn"
              onClick={() => setAccountOpen2(true)}
              title="账号管理"
              aria-label="账号管理"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <circle cx="12" cy="8" r="3.4" stroke="currentColor" strokeWidth="1.5" />
                <path d="M4.8 20c.6-3.4 3.4-5.2 7.2-5.2s6.6 1.8 7.2 5.2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </button>
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
                if (me && me.role !== 'owner') openMyAccount()
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

      <AccountPanel open={accountOpen2} onClose={() => setAccountOpen2(false)} />

      {accountOpen ? (
        <div className="lm-counselor-modal" role="dialog" aria-modal="true" aria-label="我的账号">
          <div className="lm-counselor-modal-box lm-myaccount-box">
            <Eyebrow>ACCOUNT · 我的账号</Eyebrow>
            <h3 className="lm-counselor-modal-title">{me?.username || me?.name || '助理'}</h3>
            <p className="lm-counselor-modal-hint">
              当前账号：{me?.username || me?.name || '—'}。你能建通知、看板、催办、导出回执；总管密码和 API
              配置只有主账号能改。
            </p>

            <div className="lm-myaccount-pw">
              <Eyebrow>PASSWORD · 修改我的密码</Eyebrow>
              <p className="lm-counselor-modal-hint">
                初始密码 123456 只用来第一次登录，请改成只有你知道的。
              </p>

              <div className="lm-counselor-set-field">
                <div className="lm-counselor-set-labelrow">
                  <label className="lm-counselor-set-label" htmlFor="lm-my-pw-cur">
                    当前密码
                  </label>
                </div>
                <input
                  id="lm-my-pw-cur"
                  className="lm-counselor-set-input"
                  type="password"
                  value={pwCur}
                  autoComplete="current-password"
                  placeholder="••••••••"
                  disabled={pwBusy}
                  onChange={(e) => setPwCur(e.target.value)}
                />
              </div>

              <div className="lm-counselor-set-field">
                <div className="lm-counselor-set-labelrow">
                  <label className="lm-counselor-set-label" htmlFor="lm-my-pw-next">
                    新密码
                  </label>
                  <span className="lm-counselor-set-mini">≥ 6 位</span>
                </div>
                <input
                  id="lm-my-pw-next"
                  className="lm-counselor-set-input"
                  type="password"
                  value={pwNext}
                  autoComplete="new-password"
                  placeholder="至少 6 位"
                  disabled={pwBusy}
                  onChange={(e) => setPwNext(e.target.value)}
                />
              </div>

              <div className="lm-counselor-set-field">
                <div className="lm-counselor-set-labelrow">
                  <label className="lm-counselor-set-label" htmlFor="lm-my-pw-confirm">
                    再输一次
                  </label>
                </div>
                <input
                  id="lm-my-pw-confirm"
                  className="lm-counselor-set-input"
                  type="password"
                  value={pwConfirm}
                  autoComplete="new-password"
                  placeholder="再输一次新密码"
                  disabled={pwBusy}
                  onChange={(e) => setPwConfirm(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && pwReady) submitMyPassword()
                  }}
                />
              </div>

              {pwSame ? (
                <p className="lm-counselor-set-hint is-err">新密码不能和当前密码一样</p>
              ) : pwMismatch ? (
                <p className="lm-counselor-set-hint is-err">两次输入不一致</p>
              ) : pwTooShort ? (
                <p className="lm-counselor-set-hint is-err">至少 6 位</p>
              ) : null}

              {pwMsg && pwMsg.tone === 'err' ? (
                <p className="lm-counselor-modal-err" role="alert">
                  {pwMsg.text}
                </p>
              ) : null}
              {pwMsg && pwMsg.tone === 'ok' ? (
                <p className="lm-counselor-set-msg is-ok" role="status">
                  {pwMsg.text}
                </p>
              ) : null}

              <div className="lm-counselor-modal-actions">
                <Btn variant="primary" onClick={submitMyPassword} disabled={!pwReady}>
                  {pwBusy ? '正在修改…' : '修改我的密码'}
                </Btn>
              </div>
            </div>

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
