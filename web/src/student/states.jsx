/* 学生端整体状态画面：加载、错误、完成态、身份输入层。
   这几个画面存在的意义：任何情况下都不出现白屏。 */

import React, { useEffect, useRef, useState } from 'react'
import { CalendarButton, OriginalFold, Progress } from './parts.jsx'
import { deadlineLabel, formatWhen } from './format.js'
import { normalizeActions } from './cards.jsx'
import { IconAlert, IconBigCheck, IconPerson } from './Icons.jsx'

export function LoadingScreen({ tr }) {
  return (
    <div className="lm-student__skeleton" role="status" aria-live="polite">
      <span className="lm-student__sr">{tr('loading')}</span>
      <div className="lm-student__sk-line lm-student__sk-line--xs" />
      <div className="lm-student__sk-line lm-student__sk-line--lg" />
      <div className="lm-student__sk-line lm-student__sk-line--xl" />
      <div className="lm-student__sk-line" />
      <div className="lm-student__sk-card" />
      <div className="lm-student__sk-line" />
      <div className="lm-student__sk-line lm-student__sk-line--sm" />
    </div>
  )
}

export function ErrorScreen({ error, tr, onRetry }) {
  const kind = (error && error.kind) || 'generic'
  const title =
    kind === 'net'
      ? tr('errNetTitle')
      : kind === 'notfound'
        ? tr('errNotFoundTitle')
        : tr('errGenericTitle')
  const body =
    kind === 'net' ? tr('errNetBody') : kind === 'notfound' ? tr('errNotFoundBody') : tr('errGenericBody')
  return (
    <div className="lm-student__card lm-student__card--error" role="alert">
      <span className="lm-student__err-icon" aria-hidden="true">
        <IconAlert size={26} />
      </span>
      <h1 className="lm-student__h2 lm-student__h2--big">{title}</h1>
      <p className="lm-student__err-body">{body}</p>
      {error && error.detail ? <p className="lm-student__err-detail">{error.detail}</p> : null}
      <button type="button" className="lm-student__btn lm-student__btn--primary" onClick={onRetry}>
        {tr('retry')}
      </button>
    </div>
  )
}

/* 极端兜底：渲染期崩了也不许白屏（React 错误边界）。没有任何依赖，纯静态文案。 */
export class CrashBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { crashed: false }
  }

  static getDerivedStateFromError() {
    return { crashed: true }
  }

  componentDidCatch() {
    /* 不打印堆栈给用户，只保证有画面可点 */
  }

  render() {
    if (!this.state.crashed) return this.props.children
    return (
      <div className="lm-student__page">
        <div className="lm-student__card lm-student__card--error" role="alert">
          <h1 className="lm-student__h2 lm-student__h2--big">Something went wrong · 出了点问题</h1>
          <p className="lm-student__err-body">
            Reload this page. 请刷新这一页；如果一直失败，请联系老师。
          </p>
          <button
            type="button"
            className="lm-student__btn lm-student__btn--primary"
            onClick={() => {
              try {
                location.reload()
              } catch {
                /* 忽略 */
              }
            }}
          >
            Reload · 刷新
          </button>
        </div>
      </div>
    )
  }
}

/* ---------- 完成态 ---------- */
export function DoneScreen({ kind, at, counts, notice, tr, lang, onConfirmAgain, onBack }) {
  const isHelp = kind === 'help'
  const confirmed = Number(counts && counts.confirmed) || 0
  const roster = Number(counts && counts.roster) || 0
  const when = formatWhen(at, lang)
  const actions = normalizeActions(notice && notice.actions)
  const due = deadlineLabel(notice && notice.deadline, lang)

  return (
    <div className="lm-student__done">
      <div className="lm-student__done-hero">
        <span className="lm-student__done-icon" aria-hidden="true">
          {isHelp ? <IconPerson size={44} /> : <IconBigCheck size={76} />}
        </span>
        <h1 className="lm-student__done-title">{isHelp ? tr('helpDoneTitle') : tr('confirmedTitle')}</h1>
        <p className="lm-student__done-body">{isHelp ? tr('helpDoneBody') : tr('confirmedBody')}</p>
        {when ? (
          <p className="lm-student__done-time">
            <span className="lm-student__eyebrow">{tr('submittedAt')}</span>
            <span>{when}</span>
          </p>
        ) : null}
      </div>

      {/* 完成之后把「做什么 + 什么时候」再钉一遍，这是要能被记住的两件事 */}
      {actions.length || due ? (
        <section className="lm-student__card lm-student__card--recap">
          {actions.length ? (
            <>
              <p className="lm-student__eyebrow">{tr('do')}</p>
              <ol className="lm-student__recap-list">
                {actions.map((item, i) => (
                  <li className="lm-student__recap-item" key={item.order + '-' + i}>
                    <span className="lm-student__recap-num" aria-hidden="true">
                      {item.order || i + 1}
                    </span>
                    <span>{item.text}</span>
                  </li>
                ))}
              </ol>
            </>
          ) : null}
          {due ? (
            <p className="lm-student__recap-when">
              <span className="lm-student__eyebrow">{tr('deadline')}</span>
              <strong>{due}</strong>
            </p>
          ) : null}
        </section>
      ) : null}

      <section className="lm-student__card">
        <Progress
          confirmed={confirmed}
          roster={roster}
          label={tr('classProgress')}
          ariaLabel={tr('progressAria', { c: confirmed, r: roster })}
        />
        <div className="lm-student__done-actions">
          <CalendarButton notice={notice} tr={tr} lang={lang} tone="ghost" />
          {isHelp ? (
            <button type="button" className="lm-student__btn lm-student__btn--primary" onClick={onConfirmAgain}>
              {tr('understand')}
            </button>
          ) : null}
          {isHelp ? <p className="lm-student__hint">{tr('helpKeep')}</p> : null}
        </div>
      </section>

      <OriginalFold text={String((notice && notice.original_zh) || '')} tr={tr} />

      {onBack ? (
        <button type="button" className="lm-student__btn lm-student__btn--text" onClick={onBack}>
          {tr('seeNotice')}
        </button>
      ) : null}
    </div>
  )
}

/* ---------- 身份输入层：只在提交回执那一步弹出 ---------- */
export function IdGate({ open, tr, initialId, initialName, pending, error, onSubmit, onCancel, onSkip }) {
  const [sid, setSid] = useState(initialId || '')
  const [name, setName] = useState(initialName || '')
  const [localError, setLocalError] = useState('')
  const inputRef = useRef(null)

  useEffect(() => {
    if (!open) return
    setSid(initialId || '')
    setName(initialName || '')
    setLocalError('')
    const timer = setTimeout(() => {
      if (inputRef.current) inputRef.current.focus()
    }, 80)
    return () => clearTimeout(timer)
  }, [open, initialId, initialName])

  useEffect(() => {
    if (!open) return undefined
    const onKey = (e) => {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onCancel])

  if (!open) return null

  const submit = (e) => {
    if (e) e.preventDefault()
    const value = sid.replace(/\s+/g, '')
    if (!/^\d{8}$/.test(value)) {
      setLocalError(tr('idInvalid'))
      if (inputRef.current) inputRef.current.focus()
      return
    }
    setLocalError('')
    onSubmit(value, name.trim())
  }

  const shown = localError || error || ''

  return (
    <div className="lm-student__sheet-wrap" role="presentation">
      <div className="lm-student__sheet-mask" onClick={onCancel} aria-hidden="true" />
      <div
        className="lm-student__sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="lm-id-title"
        aria-describedby="lm-id-hint"
      >
        <h2 className="lm-student__h2" id="lm-id-title">
          {tr('idTitle')}
        </h2>
        <p className="lm-student__hint" id="lm-id-hint">
          {tr('idHint')}
        </p>
        <form onSubmit={submit}>
          <label className="lm-student__label" htmlFor="lm-id-input">
            {tr('yourId')}
          </label>
          <input
            id="lm-id-input"
            ref={inputRef}
            className="lm-student__input"
            type="text"
            inputMode="numeric"
            autoComplete="off"
            maxLength={8}
            value={sid}
            placeholder="20260001"
            aria-invalid={shown ? 'true' : 'false'}
            aria-describedby={shown ? 'lm-id-error' : undefined}
            onChange={(e) => {
              setSid(e.target.value.replace(/[^\d]/g, '').slice(0, 8))
              if (localError) setLocalError('')
            }}
          />
          <label className="lm-student__label" htmlFor="lm-name-input">
            {tr('yourName')}
          </label>
          <input
            id="lm-name-input"
            className="lm-student__input"
            type="text"
            autoComplete="name"
            maxLength={40}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          {shown ? (
            <p className="lm-student__inline-error" id="lm-id-error" role="alert">
              {shown}
            </p>
          ) : null}
          <button type="submit" className="lm-student__btn lm-student__btn--primary" disabled={pending}>
            {pending ? tr('idChecking') : tr('idContinue')}
          </button>
        </form>
        <button type="button" className="lm-student__btn lm-student__btn--text" onClick={onCancel}>
          {tr('idCancel')}
        </button>
        {/* 只有在核对失败时才给这条退路，正常流程不给「跳过」的诱惑 */}
        {shown ? (
          <button type="button" className="lm-student__btn lm-student__btn--text lm-student__btn--faint" onClick={onSkip}>
            {tr('idSkip')}
          </button>
        ) : null}
      </div>
    </div>
  )
}
