/* 学生端入口 —— 状态机在这里落地。
   unread/seen → 读卡片；quiz 可无限重试；confirm/help → 完成态。
   任何一步失败都渲染人话卡片，绝不白屏。 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  getLang,
  getStudentId,
  getStudentName,
  getStudentNotice,
  markSeen,
  setLang as saveLang,
  setStudentId as saveStudentId,
  setStudentName as saveStudentName,
  submitQuiz,
  submitReceipt,
  whoAmI
} from '../lib/api.js'
import { makeTr } from './strings.js'
import { deadlineLabel, describeError, readEntry, scrollBehavior, withTimeout } from './format.js'
import { ConfirmCard, DeadlineCard, DoCard, QuizCard, WhatCard, normalizeActions } from './cards.jsx'
import { CrashBoundary, DoneScreen, ErrorScreen, IdGate, LoadingScreen } from './states.jsx'
import { Legend, OfficialBlock, OriginalFold, Progress } from './parts.jsx'

const FS_KEY = 'lm.student.fs'

function readFontLevel() {
  try {
    const raw = localStorage.getItem(FS_KEY)
    const n = Number(raw)
    return n === 0 || n === 1 || n === 2 ? n : 1
  } catch {
    return 1
  }
}

function writeFontLevel(level) {
  try {
    localStorage.setItem(FS_KEY, String(level))
  } catch {
    /* 隐私模式下写不进去，不影响使用 */
  }
}

const ID_RE = /^\d{8}$/

/* 服务端翻译一个还没生成的语种最长约 20 秒，这里再留 5 秒余量。
   超过就按「这个语言没准备好」处理，页面留在原来的语言上，不无限转圈。 */
const LANG_TIMEOUT_MS = 25000

export default function StudentApp({ id, sub }) {
  return (
    <CrashBoundary>
      <StudentInner id={id} sub={sub} />
    </CrashBoundary>
  )
}

function StudentInner({ id, sub }) {
  const entry = useMemo(() => readEntry(id), [id])

  /* 二维码带 ?sid= ：进入即写入，用户不用手打学号。 */
  const [studentId, setStudentIdState] = useState(() => {
    const fromUrl = String(entry.sid || '').replace(/\s+/g, '')
    if (ID_RE.test(fromUrl)) {
      saveStudentId(fromUrl)
      return fromUrl
    }
    return getStudentId() || ''
  })

  const [requestedLang, setRequestedLang] = useState(() => entry.lang || getLang() || '')
  /* 同一个语种再点一次也算重试（回退/失败后 requestedLang 没变，靠这个 tick 触发） */
  const [langTick, setLangTick] = useState(0)
  /* 正在等服务端翻译的语种（'' = 空闲）。选中态先给它，内容暂留在原语言。 */
  const [pendingLang, setPendingLang] = useState('')
  /* 服务端明确说 lang_ready=false 时记下请求的语种，用来显示琥珀色说明 */
  const [fallbackLang, setFallbackLang] = useState('')
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [view, setView] = useState('read') // read | confirmed | help
  const [quiz, setQuiz] = useState({ chosen: null, result: null, pending: false, error: null })
  const [submit, setSubmit] = useState({ state: 'idle', kind: null, error: null })
  const [gate, setGate] = useState({ open: false, pending: false, error: '' })
  const [receiptAt, setReceiptAt] = useState('')
  const [receiptCounts, setReceiptCounts] = useState(null)
  const [fontLevel, setFontLevel] = useState(readFontLevel)
  const [confirmInView, setConfirmInView] = useState(true)

  const studentIdRef = useRef(studentId)
  const seqRef = useRef(0)
  const hasDataRef = useRef(false)
  const seenRef = useRef(false)
  const submittedRef = useRef(false)
  const resolveRef = useRef(null)
  const submitLockRef = useRef(false)
  const pendingScrollRef = useRef(null)
  const confirmRef = useRef(null)
  const confirmInViewRef = useRef(true)

  useEffect(() => {
    studentIdRef.current = studentId
  }, [studentId])

  useEffect(() => {
    confirmInViewRef.current = confirmInView
  }, [confirmInView])

  /* ---------- 语言 ---------- */
  /* uiLang = 页面上真正显示的语言（服务端说 lang_ready=false 时它是回退语言）；
     pendingLang = 用户刚点、还在等服务端翻译的语言。两者不同时内容先淡着等。 */
  const uiLang = (data && data.lang) || requestedLang || entry.lang || getLang() || 'en'
  const tr = useMemo(() => makeTr(uiLang), [uiLang])
  const translating = !!pendingLang
  const readyLangs = useMemo(() => {
    const list = data && Array.isArray(data.available_langs) ? data.available_langs.filter(Boolean) : []
    if (list.length) return list
    return data && data.lang ? [data.lang] : []
  }, [data])

  /* ---------- 拉数据 ---------- */
  const load = useCallback(
    async (langOverride) => {
      if (!entry.id) {
        setLoading(false)
        setError({ kind: 'notfound', detail: '' })
        return
      }
      const target = String(langOverride || '')
      /* 请求序号：快速连点三个语种时，只有最后一次的结果允许落地 */
      const seq = ++seqRef.current
      setError(null)
      if (hasDataRef.current) setPendingLang(target)
      else setLoading(true)
      try {
        const next = await withTimeout(
          getStudentNotice(entry.id, target || undefined, studentIdRef.current || undefined),
          LANG_TIMEOUT_MS
        )
        if (seq !== seqRef.current) return
        hasDataRef.current = true
        const actual = String((next && next.lang) || target || '')
        setData(next || {})
        setError(null)
        setLoading(false)
        setPendingLang('')
        /* lang_ready=false：这个语言没生成出来，内容是回退语言。
           服务端没给 lang_ready 但返回的语言也不是我们要的，同样按回退处理
           （否则会静悄悄显示中文，正是这次要修的那个坑）。
           选中态会自动跟着 data.lang 退回，这里只负责留一条说明。 */
        const fellBack = !!(target && next) && (next.lang_ready === false || (!!actual && actual !== target))
        if (fellBack) {
          setFallbackLang(target)
          /* 记住真正看得懂的那个版本，下次打开别再白等一次翻译 */
          if (actual) saveLang(actual)
        } else {
          setFallbackLang('')
        }
        /* 服务端状态决定读视图/完成视图；刚提交过就听本地的，避免闪回。 */
        if (!submittedRef.current) {
          const status = next && next.my_status
          if (status === 'confirmed') setView('confirmed')
          else if (status === 'help') setView('help')
          else setView('read')
        }
      } catch (e) {
        if (seq !== seqRef.current) return
        setLoading(false)
        setPendingLang('')
        /* 失败时 data 不动：原语言内容原样留着，上面出一条可重试的提示 */
        pendingScrollRef.current = null
        setError(describeError(e))
      }
    },
    [entry.id]
  )

  useEffect(() => {
    load(requestedLang)
    return () => {
      seqRef.current += 1
    }
  }, [load, requestedLang, langTick])

  /* 切换语言后把滚动位置放回去，别让用户丢上下文。 */
  useEffect(() => {
    if (pendingScrollRef.current == null || !data) return
    const y = pendingScrollRef.current
    pendingScrollRef.current = null
    const raf =
      typeof requestAnimationFrame === 'function'
        ? requestAnimationFrame(() => {
            try {
              window.scrollTo(0, y)
            } catch {
              /* 忽略 */
            }
          })
        : null
    if (!raf) {
      try {
        window.scrollTo(0, y)
      } catch {
        /* 忽略 */
      }
    }
    return () => {
      if (raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf)
    }
  }, [data])

  /* 打开即打点 seen（失败静默，不拦用户）。 */
  useEffect(() => {
    if (!data || seenRef.current) return
    seenRef.current = true
    try {
      const p = markSeen(entry.id, studentIdRef.current || undefined)
      if (p && typeof p.catch === 'function') p.catch(() => {})
    } catch {
      /* 忽略 */
    }
  }, [data, entry.id])

  /* 二维码只带了 ?sid= 时，后台悄悄补一次姓名（回执要带 name 对花名册）。
     不阻塞任何操作，失败就算了。 */
  useEffect(() => {
    if (!ID_RE.test(studentId) || getStudentName()) return undefined
    let alive = true
    whoAmI(studentId)
      .then((me) => {
        if (!alive) return
        const realName = String((me && (me.name || me.student_name)) || '').trim()
        if (realName) saveStudentName(realName)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [studentId])

  /* ---------- 完成卡的可见性：决定要不要吸底按钮 ---------- */
  useEffect(() => {
    if (view !== 'read') return undefined
    const el = confirmRef.current
    if (!el || typeof IntersectionObserver !== 'function') return undefined
    const io = new IntersectionObserver(
      (entries) => {
        for (const en of entries) setConfirmInView(!!en.isIntersecting)
      },
      { threshold: 0.2 }
    )
    io.observe(el)
    return () => io.disconnect()
  }, [view, data])

  /* ---------- 语言切换 ---------- */
  /* 点下去的瞬间就换选中态（不等请求回来），滚动位置记下来，回执小测状态清掉。
     连续快速点多个语种由 load() 里的请求序号兜住：只有最后一次落地。 */
  const switchLang = useCallback(
    (code) => {
      if (!code) return
      if (code === pendingLang) return
      if (code === uiLang && !pendingLang) return
      pendingScrollRef.current = typeof window !== 'undefined' ? window.scrollY || 0 : 0
      saveLang(code)
      /* 先本地置 pending，点下去当帧 chip 就变选中态，不等 effect 里的请求 */
      setPendingLang(code)
      setFallbackLang('')
      setError(null)
      setQuiz({ chosen: null, result: null, pending: false, error: null })
      /* 同一个语种再点一次（回退/超时之后）也要重发，靠 tick 触发 effect */
      if (code === requestedLang) setLangTick((n) => n + 1)
      else setRequestedLang(code)
    },
    [pendingLang, requestedLang, uiLang]
  )

  /* ---------- 小测 ---------- */
  const choose = useCallback(
    async (choice) => {
      if (choice < 0) {
        setQuiz({ chosen: null, result: null, pending: false, error: null })
        return
      }
      if (quiz.pending) return
      setQuiz((q) => ({ ...q, chosen: choice, pending: true, error: null }))
      try {
        const res = await submitQuiz(entry.id, choice, studentIdRef.current || undefined)
        setQuiz({ chosen: choice, result: res || {}, pending: false, error: null })
      } catch (e) {
        setQuiz((q) => ({ ...q, pending: false, error: describeError(e) }))
      }
    },
    [entry.id, quiz.pending]
  )

  /* 答对后轻轻滚到确认卡（已看见就不动），不挡回执。 */
  useEffect(() => {
    if (!quiz.result || !quiz.result.correct) return undefined
    const timer = setTimeout(() => {
      if (confirmInViewRef.current) return
      const el = confirmRef.current
      if (el && typeof el.scrollIntoView === 'function') {
        el.scrollIntoView({ behavior: scrollBehavior(), block: 'center' })
      }
    }, 900)
    return () => clearTimeout(timer)
  }, [quiz.result])

  /* ---------- 身份：只在提交那一刻问 ---------- */
  const askIdentity = useCallback(() => {
    return new Promise((resolve) => {
      resolveRef.current = resolve
      setGate({ open: true, pending: false, error: '' })
    })
  }, [])

  const closeGate = useCallback((value) => {
    setGate({ open: false, pending: false, error: '' })
    const resolve = resolveRef.current
    resolveRef.current = null
    if (resolve) resolve(value)
  }, [])

  const gateSubmit = useCallback(
    async (sid, name) => {
      setGate((g) => ({ ...g, pending: true, error: '' }))
      try {
        const me = await whoAmI(sid)
        const realName = String((me && (me.name || me.student_name)) || name || getStudentName() || '').trim()
        saveStudentId(sid)
        saveStudentName(realName)
        setStudentIdState(sid)
        closeGate({ student_id: sid, name: realName })
      } catch (e) {
        const d = describeError(e)
        const message =
          d.kind === 'notfound' ? tr('idUnknown') : d.kind === 'net' ? tr('errNetBody') : tr('idUnknown')
        setGate((g) => ({ ...g, pending: false, error: message }))
      }
    },
    [closeGate, tr]
  )

  /* ---------- 提交回执 ---------- */
  const doReceipt = useCallback(
    async (kind, helpMessage) => {
      if (submitLockRef.current) return
      submitLockRef.current = true
      setSubmit({ state: 'pending', kind, error: null })
      try {
        let ident
        if (ID_RE.test(studentIdRef.current)) {
          ident = { student_id: studentIdRef.current, name: getStudentName() }
        } else {
          ident = await askIdentity()
        }
        if (!ident) {
          setSubmit({ state: 'idle', kind: null, error: null })
          return
        }
        const payload = {
          student_id: ident.student_id,
          name: ident.name || '',
          lang: uiLang,
          kind
        }
        if (kind === 'help') payload.help_message = String(helpMessage || '')
        const res = await submitReceipt(entry.id, payload)
        submittedRef.current = true
        const at = (res && res.receipt && res.receipt.confirmed_at) || new Date().toISOString()
        setReceiptAt(at)
        if (res && res.counts) setReceiptCounts(res.counts)
        setSubmit({ state: 'idle', kind: null, error: null })
        setView(kind === 'help' ? 'help' : 'confirmed')
        try {
          window.scrollTo({ top: 0, behavior: scrollBehavior() })
        } catch {
          /* 忽略 */
        }
      } catch (e) {
        setSubmit({ state: 'error', kind, error: describeError(e) })
      } finally {
        submitLockRef.current = false
      }
    },
    [askIdentity, entry.id, uiLang]
  )

  const changeFont = useCallback((level) => {
    setFontLevel(level)
    writeFontLevel(level)
  }, [])

  /* 回执失败时给一条退路：学号存错了也能改，不至于彻底卡死。 */
  const fixIdentity = useCallback(() => {
    saveStudentId('')
    saveStudentName('')
    setStudentIdState('')
    setSubmit({ state: 'idle', kind: null, error: null })
    setGate({ open: true, pending: false, error: '' })
  }, [])

  /* ---------- 渲染 ---------- */
  const rootClass =
    'lm-root lm-student lm-student--fs' +
    fontLevel +
    (!confirmInView && view === 'read' ? ' lm-student--sticky' : '')

  if (loading && !data) {
    return (
      <div className={rootClass} data-sub={sub || ''}>
        <main className="lm-student__page">
          <Brand tr={tr} />
          <LoadingScreen tr={tr} />
        </main>
      </div>
    )
  }

  if (error && !data) {
    return (
      <div className={rootClass} data-sub={sub || ''}>
        <main className="lm-student__page">
          <Brand tr={tr} />
          <ErrorScreen error={error} tr={tr} onRetry={() => load(requestedLang)} />
        </main>
      </div>
    )
  }

  const notice = data || {}
  const counts = receiptCounts || notice.counts || {}
  const kind = notice.risk_flag && notice.risk_flag !== 'none' ? notice.risk_flag : null
  const actions = normalizeActions(notice.actions)
  const due = deadlineLabel(notice.deadline, uiLang)
  const showSticky = view === 'read' && !confirmInView && !gate.open
  const pendingKind = submit.state === 'pending' ? submit.kind : null
  /* 图例里要不要列「答题」：和 QuizCard 的渲染条件保持一致（没有题就不印蓝色） */
  const hasQuiz = !!(
    notice.quiz &&
    String(notice.quiz.question || '').trim() &&
    Array.isArray(notice.quiz.options) &&
    notice.quiz.options.filter((o) => String(o || '').trim()).length >= 2
  )

  let body
  if (view === 'confirmed' || view === 'help') {
    body = (
      <DoneScreen
        kind={view}
        at={receiptAt}
        counts={counts}
        notice={notice}
        tr={tr}
        lang={uiLang}
        onConfirmAgain={() => doReceipt('confirm')}
      />
    )
  } else {
    body = (
      <>
        <Legend tr={tr} showQuiz={hasQuiz} />

        <WhatCard
          notice={notice}
          tr={tr}
          lang={uiLang}
          readyLangs={readyLangs}
          pending={pendingLang}
          fallback={fallbackLang}
          onLang={switchLang}
          fontLevel={fontLevel}
          onFont={changeFont}
          titleId="lm-title"
        />

        <DoCard actions={actions} tr={tr} />

        <DeadlineCard notice={notice} tr={tr} lang={uiLang} />

        {kind ? (
          <OfficialBlock links={notice.official_links} contacts={notice.contacts} tr={tr} />
        ) : null}

        <QuizCard quiz={notice.quiz} tr={tr} state={quiz} onChoose={choose} />

        <div className="lm-student__social">
          {Number(counts.roster) > 0 || Number(counts.confirmed) > 0 ? (
            <Progress
              confirmed={counts.confirmed}
              roster={counts.roster}
              label={tr('classProgress')}
              ariaLabel={tr('progressAria', { c: Number(counts.confirmed) || 0, r: Number(counts.roster) || 0 })}
            />
          ) : null}
        </div>

        <ConfirmCard
          tr={tr}
          submit={submit}
          onSubmit={doReceipt}
          cardRef={confirmRef}
          onFixId={fixIdentity}
          when={due}
        />

        <OriginalFold text={String(notice.original_zh || '')} tr={tr} />
      </>
    )
  }

  /* 切换语言失败/超时：保留原语言内容，顶部一条能重试的人话提示 */
  const errKind = error && error.kind
  const bannerTitle =
    errKind === 'timeout'
      ? tr('langSlowTitle')
      : errKind === 'notfound'
        ? tr('errNotFoundTitle')
        : errKind === 'net'
          ? tr('errNetTitle')
          : tr('errGenericTitle')
  const bannerBody =
    errKind === 'timeout'
      ? tr('langSlowBody')
      : errKind === 'notfound'
        ? ''
        : errKind === 'net'
          ? tr('errNetBody')
          : tr('errGenericBody')

  return (
    <div className={rootClass} data-sub={sub || ''} aria-busy={translating ? 'true' : 'false'}>
      {/* 翻译中：顶部一条 3px 细进度条，固定定位，不占布局也不顶动内容 */}
      {translating ? (
        <div className="lm-student__transtop" role="progressbar" aria-label={tr('langPending')} />
      ) : null}
      <main className={'lm-student__page' + (translating ? ' is-translating' : '')}>
        <Brand tr={tr} />
        {error && data ? (
          <div className="lm-student__banner" role="alert">
            <span className="lm-student__banner-text">
              <span className="lm-student__banner-title">{bannerTitle}</span>
              {bannerBody ? <span className="lm-student__banner-body">{bannerBody}</span> : null}
            </span>
            <button type="button" className="lm-student__banner-btn" onClick={() => load(requestedLang)}>
              {tr('retry')}
            </button>
          </div>
        ) : null}
        {body}
        <p className="lm-student__footer">{tr('tagline')}</p>
      </main>

      {showSticky ? (
        <div className="lm-student__sticky">
          <button
            type="button"
            className="lm-student__btn lm-student__btn--primary lm-student__btn--cta"
            disabled={submit.state === 'pending'}
            onClick={() => doReceipt('confirm')}
          >
            {pendingKind === 'confirm' ? tr('submitting') : tr('understand')}
          </button>
        </div>
      ) : null}

      <IdGate
        open={gate.open}
        tr={tr}
        initialId={studentId}
        initialName={getStudentName()}
        pending={gate.pending}
        error={gate.error}
        onSubmit={gateSubmit}
        onCancel={() => closeGate(null)}
        onSkip={() => closeGate({ student_id: '', name: getStudentName() })}
      />
    </div>
  )
}

function Brand({ tr }) {
  return (
    <div className="lm-student__brand">
      <span className="lm-student__brand-name">{tr('appName')}</span>
      <span className="lm-student__brand-tag">{tr('tagline')}</span>
    </div>
  )
}
