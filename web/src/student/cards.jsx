/* 学生端五张卡：这是什么 / 你要做什么 / 截止·地点·材料 / 小测 / 确认。
   每张卡视觉独立，字段缺失时整块消失，不渲染 undefined。 */

import React, { useRef, useState } from 'react'
import { countdownText, deadlineLabel, hoursFromDeadline } from './format.js'
import { CalendarButton, Eyebrow, FontControls, Highlight, LangSwitch, SpeakButton } from './parts.jsx'
import { IconCheck, IconQuestion } from './Icons.jsx'

/* actions 兼容 [{order,text}] / [{order,zh}] / ["字符串"]，并稳定排序。 */
export function normalizeActions(actions) {
  if (!Array.isArray(actions)) return []
  return actions
    .map((a, i) => {
      if (typeof a === 'string') return { order: i + 1, text: a }
      if (!a || typeof a !== 'object') return null
      const text = String(a.text || a.en || a.zh || '').trim()
      if (!text) return null
      return { order: Number(a.order) || i + 1, text }
    })
    .filter(Boolean)
    .sort((x, y) => x.order - y.order)
}

export function normalizeMaterials(materials) {
  if (!Array.isArray(materials)) return []
  return materials
    .map((m) => (typeof m === 'string' ? m : m && (m.text || m.zh || m.en)))
    .map((m) => String(m || '').trim())
    .filter(Boolean)
}

/* ---------- 卡片 1：这是什么 ---------- */
export function WhatCard({ notice, tr, lang, readyLangs, pending, fallback, onLang, fontLevel, onFont, titleId }) {
  const title = String((notice && notice.title) || '').trim()
  const oneLine = String((notice && notice.one_line) || '').trim()
  const what = String((notice && notice.what) || '').trim()
  if (!title && !oneLine && !what) return null
  return (
    <section className="lm-student__card lm-student__card--what" aria-labelledby={titleId}>
      <div className="lm-student__card-top">
        <Eyebrow>{tr('what')}</Eyebrow>
        <div className="lm-student__tools">
          <SpeakButton lang={lang} notice={notice} tr={tr} />
          <FontControls level={fontLevel} onChange={onFont} tr={tr} />
        </div>
      </div>

      <LangSwitch
        value={lang}
        readyLangs={readyLangs}
        pending={pending}
        fallback={fallback}
        onChange={onLang}
        tr={tr}
      />

      {title ? (
        <h1 className="lm-student__title" id={titleId}>
          {title}
        </h1>
      ) : null}
      {oneLine ? <p className="lm-student__oneline">{oneLine}</p> : null}
      {what ? <p className="lm-student__what">{what}</p> : null}
      {notice && notice.who ? <p className="lm-student__who">{notice.who}</p> : null}
    </section>
  )
}

/* ---------- 卡片 2：你要做什么（全页视觉重心） ---------- */
export function DoCard({ actions, tr }) {
  const list = normalizeActions(actions)
  if (!list.length) return null
  return (
    <section className="lm-student__card lm-student__card--do" aria-labelledby="lm-do-title">
      <Eyebrow>{tr('do')}</Eyebrow>
      {/* 视觉上由小标签承担标题，这里只给读屏一个结构锚点，避免同一句话印两遍 */}
      <h2 className="lm-student__sr" id="lm-do-title">
        {tr('do')}
      </h2>
      <ol className="lm-student__actions">
        {list.map((item, i) => (
          <li className="lm-student__action" key={item.order + '-' + i}>
            <span className="lm-student__action-num" aria-hidden="true">
              {item.order || i + 1}
            </span>
            <span className="lm-student__action-text">{item.text}</span>
          </li>
        ))}
      </ol>
    </section>
  )
}

/* ---------- 卡片 3：截止 / 地点 / 材料 ---------- */
export function DeadlineCard({ notice, tr, lang }) {
  const deadline = (notice && notice.deadline) || {}
  const deadlineIso = deadline.iso || null
  const deadlineText = deadlineLabel(deadline, lang)
  const hoursLeft = hoursFromDeadline(deadline)
  const remain = countdownText(tr, hoursLeft)
  const place = String((notice && notice.place) || '').trim()
  const materials = normalizeMaterials(notice && notice.materials)
  const consequence = String((notice && notice.consequence) || '').trim()

  const hasDeadline = !!(deadlineText || deadlineIso)
  if (!hasDeadline && !place && !materials.length && !consequence) return null

  return (
    <section className="lm-student__card lm-student__card--deadline" aria-labelledby="lm-deadline-title">
      <Eyebrow>{tr('deadline')}</Eyebrow>
      {/* 同上：标题交给小标签，读屏仍有一个 h2 */}
      <h2 className="lm-student__sr" id="lm-deadline-title">
        {tr('deadline')}
      </h2>

      {hasDeadline ? (
        <div className="lm-student__when">
          <p className="lm-student__when-time">{deadlineText || tr('deadline')}</p>
          {remain ? (
            <p
              className={
                'lm-student__countdown' +
                (remain.tone === 'warn' ? ' is-warn' : '') +
                (remain.tone === 'over' ? ' is-over' : '')
              }
            >
              {remain.text}
            </p>
          ) : null}
          {remain && remain.tone === 'over' ? (
            <p className="lm-student__overdue-note">{tr('overdueNote')}</p>
          ) : null}
        </div>
      ) : null}

      <CalendarButton notice={notice} tr={tr} lang={lang} tone="ghost" />

      <dl className="lm-student__facts">
        {place ? (
          <div className="lm-student__fact">
            <dt>{tr('place')}</dt>
            <dd>{place}</dd>
          </div>
        ) : null}
        {materials.length ? (
          <div className="lm-student__fact">
            <dt>{tr('bring')}</dt>
            <dd>
              <ul className="lm-student__materials">
                {materials.map((m, i) => (
                  <li key={i}>{m}</li>
                ))}
              </ul>
            </dd>
          </div>
        ) : null}
      </dl>

      {consequence ? <p className="lm-student__consequence">{consequence}</p> : null}
    </section>
  )
}

/* ---------- 卡片 4：一道小测 ---------- */
export function QuizCard({ quiz, tr, state, onChoose }) {
  const question = String((quiz && quiz.question) || '').trim()
  const options = Array.isArray(quiz && quiz.options) ? quiz.options.filter((o) => String(o || '').trim()) : []
  if (!question || options.length < 2) return null

  const result = state && state.result
  const pending = !!(state && state.pending)
  const chosen = state && state.chosen != null ? state.chosen : null
  const solved = !!(result && result.correct)
  const wrong = !!(result && !result.correct)
  const correctIndex =
    result && (result.correct_index != null ? Number(result.correct_index) : null)

  return (
    <section className="lm-student__card lm-student__card--quiz" aria-labelledby="lm-quiz-title">
      <Eyebrow>{tr('quizTitle')}</Eyebrow>
      {/* 问号图标走 currentColor（蓝色），题干仍保持深色：提示「轮到你答题」，不改字号层级 */}
      <h2 className="lm-student__h2 lm-student__quiz-title" id="lm-quiz-title">
        <span className="lm-student__quiz-badge" aria-hidden="true">
          <IconQuestion size={22} />
        </span>
        <span className="lm-student__quiz-qtext">{question}</span>
      </h2>
      <p className="lm-student__hint">{tr('quizPick')}</p>

      <div className="lm-student__options" role="group" aria-labelledby="lm-quiz-title">
        {options.map((opt, i) => {
          const picked = chosen === i
          const isRight = correctIndex === i
          const isWrongPick = wrong && picked && !isRight
          let cls = 'lm-student__option'
          if (solved && isRight) cls += ' is-right'
          if (isWrongPick) cls += ' is-wrong'
          if (picked && !solved) cls += ' is-picked'
          return (
            <button
              key={i}
              type="button"
              className={cls}
              aria-label={tr('quizAria', { n: i + 1 }) + ': ' + String(opt)}
              aria-pressed={picked}
              disabled={pending || solved}
              onClick={() => onChoose(i)}
            >
              <span className="lm-student__option-letter" aria-hidden="true">
                {String.fromCharCode(65 + i)}
              </span>
              <span className="lm-student__option-text">{String(opt)}</span>
              {solved && isRight ? (
                <span className="lm-student__option-tick" aria-hidden="true">
                  <IconCheck size={20} />
                </span>
              ) : null}
            </button>
          )
        })}
      </div>

      {solved ? (
        <p className="lm-student__quiz-ok" role="status">
          <IconCheck size={22} />
          <span>{tr('quizCorrect')}</span>
        </p>
      ) : null}

      {wrong ? (
        <div className="lm-student__quiz-wrong" role="status">
          <p className="lm-student__quiz-wrong-title">{tr('quizWrong')}</p>
          {/* 高亮块只放原文，标题已经说明「再看一遍原文」，不重复印文案 */}
          <Highlight text={String(result.source_span || '')} />
          {result.explain ? <p className="lm-student__explain">{String(result.explain)}</p> : null}
          <button type="button" className="lm-student__btn lm-student__btn--ghost" onClick={() => onChoose(-1)}>
            <span>{tr('quizRetry')}</span>
          </button>
        </div>
      ) : null}

      {state && state.error ? (
        <p className="lm-student__inline-error" role="alert">
          {tr('submitError')}
        </p>
      ) : null}
    </section>
  )
}

/* ---------- 卡片 5：确认回执 ---------- */
export function ConfirmCard({ tr, submit, onSubmit, cardRef, onFixId, when }) {
  const [helpOpen, setHelpOpen] = useState(false)
  const [helpText, setHelpText] = useState('')
  const [hint, setHint] = useState('')
  const areaRef = useRef(null)
  const pending = submit && submit.state === 'pending'
  const pendingKind = pending ? submit.kind : null
  const failed = submit && submit.state === 'error'

  const sendHelp = () => {
    const value = helpText.trim()
    if (value.length < 2) {
      setHint(tr('helpEmpty'))
      if (areaRef.current) areaRef.current.focus()
      return
    }
    setHint('')
    onSubmit('help', value)
  }

  return (
    <section className="lm-student__card lm-student__card--confirm" ref={cardRef} aria-labelledby="lm-confirm-title">
      {/* 按下去之前再看一眼「什么时候」——这是要被记住的两件事之一 */}
      {when ? (
        <p className="lm-student__cta-when" id="lm-confirm-title">
          <span className="lm-student__eyebrow">{tr('deadline')}</span>
          <strong>{when}</strong>
        </p>
      ) : (
        <h2 className="lm-student__sr" id="lm-confirm-title">
          {tr('understand')}
        </h2>
      )}
      {failed ? (
        <p className="lm-student__inline-error" role="alert">
          {tr('submitError')}
          {submit.error && submit.error.detail ? <span className="lm-student__err-detail">{submit.error.detail}</span> : null}
        </p>
      ) : null}

      {failed && onFixId ? (
        <button type="button" className="lm-student__btn lm-student__btn--text lm-student__btn--faint" onClick={onFixId}>
          {tr('fixId')}
        </button>
      ) : null}

      <button
        type="button"
        className="lm-student__btn lm-student__btn--primary lm-student__btn--cta"
        onClick={() => onSubmit('confirm')}
        disabled={pending}
      >
        {pendingKind === 'confirm' ? tr('submitting') : tr('understand')}
      </button>

      {!helpOpen ? (
        <button
          type="button"
          className="lm-student__btn lm-student__btn--text"
          onClick={() => {
            setHelpOpen(true)
            setTimeout(() => {
              if (areaRef.current) areaRef.current.focus()
            }, 60)
          }}
        >
          {tr('needHelp')}
        </button>
      ) : (
        <div className="lm-student__help">
          <label className="lm-student__label" htmlFor="lm-help-text">
            {tr('helpTitle')}
          </label>
          <textarea
            id="lm-help-text"
            ref={areaRef}
            className="lm-student__textarea"
            value={helpText}
            rows={3}
            maxLength={400}
            placeholder={tr('helpPlaceholder')}
            aria-describedby={hint ? 'lm-help-hint' : undefined}
            onChange={(e) => {
              setHelpText(e.target.value)
              if (hint) setHint('')
            }}
          />
          {hint ? (
            <p className="lm-student__hint lm-student__hint--error" id="lm-help-hint" role="alert">
              {hint}
            </p>
          ) : null}
          <button
            type="button"
            className="lm-student__btn lm-student__btn--secondary"
            onClick={sendHelp}
            disabled={pending}
          >
            {pendingKind === 'help' ? tr('submitting') : tr('helpSend')}
          </button>
          <button
            type="button"
            className="lm-student__btn lm-student__btn--text"
            onClick={() => {
              setHelpOpen(false)
              setHint('')
            }}
          >
            {tr('idCancel')}
          </button>
        </div>
      )}
    </section>
  )
}

/* 官方渠道块在页面的位置由 StudentApp 决定（紧跟截止卡之后）。 */
