/* 学生端共用零件：小标签、语言切换、朗读、字号、进度条、高亮块、
   官方渠道块、中文原文折叠、加入日历。所有文案走 tr()，不硬编码中文。 */

import React, { useState } from 'react'
import { LANGS, LANG_LABEL } from '../lib/i18n.js'
import { buildIcs, downloadIcs, icsFilename } from './format.js'
import { speechText, LANG_LABEL_EXTRA } from './strings.js'
import { useSpeech } from './speech.js'
import {
  IconCalendar,
  IconChevron,
  IconLink,
  IconPhone,
  IconSpeaker,
  IconStop
} from './Icons.jsx'

const langName = (code) => LANG_LABEL[code] || LANG_LABEL_EXTRA[code] || String(code || '').toUpperCase()

/* 英文小标签：11px / letter-spacing .12em / 全大写 / --s-muted */
export function Eyebrow({ children, id }) {
  return (
    <p className="lm-student__eyebrow" id={id}>
      {children}
    </p>
  )
}

/* 三色图例：颜色 = 段落类型。放在第一张卡上面，帮学生建立「往下滑会换颜色」的预期。
   没有小测卡时不列「答题」，免得学生去找一个不存在的蓝卡。
   圆点纯装饰（aria-hidden），语义全在文字上；字号 11.5px / --s-muted，不抢正文。 */
export function Legend({ tr, showQuiz = true }) {
  return (
    <p className="lm-student__legend">
      <span className="lm-student__legend-item">
        <span className="lm-student__legend-dot lm-student__legend-dot--notice" aria-hidden="true" />
        <span>{tr('legendNotice')}</span>
      </span>
      {showQuiz ? (
        <span className="lm-student__legend-item">
          <span className="lm-student__legend-dot lm-student__legend-dot--quiz" aria-hidden="true" />
          <span>{tr('legendQuiz')}</span>
        </span>
      ) : null}
      <span className="lm-student__legend-item">
        <span className="lm-student__legend-dot lm-student__legend-dot--action" aria-hidden="true" />
        <span>{tr('legendAction')}</span>
      </span>
    </p>
  )
}

/* 语言切换：6 个语种永远都在（LANGS 全量），不等服务端凑够两种才出现。
   未生成的语种照样可点——点了由服务端当场翻译并缓存，这段时间该 chip 显示
   spinner、下面固定一行「翻译中…」；翻译不出来时换成琥珀色一句说明，
   选中态退回真正显示的语言。readyLangs 只影响字重/颜色，不做禁用：
   禁用会让 88% 不懂中文的学生彻底无路可走。 */
export function LangSwitch({ value, readyLangs, pending, fallback, onChange, tr }) {
  const pendingCode = pending || ''
  const activeCode = pendingCode || value || ''
  const ready = Array.isArray(readyLangs) ? readyLangs : []
  const list = LANGS.slice()
  /* 服务端返回 LANGS 之外的语言时也让它露出来，不吞掉 */
  for (const code of [value, pendingCode]) {
    if (code && list.indexOf(code) < 0) list.push(code)
  }
  const note = pendingCode ? tr('langPending') : fallback ? tr('langUnavailable') : ''
  const noteClass = 'lm-student__langnote' + (note ? (pendingCode ? ' is-pending' : ' is-warn') : '')
  return (
    <div className="lm-student__langbox">
      <div className="lm-student__langs" role="group" aria-label={tr('langLabel')}>
        {list.map((code) => {
          const name = langName(code)
          const active = code === activeCode
          const isPending = code === pendingCode
          let cls = 'lm-student__lang'
          if (ready.indexOf(code) >= 0) cls += ' is-ready'
          if (active) cls += ' is-active'
          if (isPending) cls += ' is-pending'
          return (
            <button
              key={code}
              type="button"
              className={cls}
              aria-pressed={active}
              aria-busy={isPending ? 'true' : undefined}
              aria-label={isPending ? name + ' · ' + tr('langPending') : name}
              onClick={() => onChange(code)}
            >
              {isPending ? <span className="lm-student__spin" aria-hidden="true" /> : null}
              <span className="lm-student__lang-name">{name}</span>
            </button>
          )
        })}
      </div>
      {/* 固定 22px 高的一行：内容出现/消失都不顶动下面的标题，避免布局跳动 */}
      <p className={noteClass} role="status" aria-live="polite">
        {note}
      </p>
    </div>
  )
}

/* 朗读按钮：念 one_line + 所有 actions，再点一次停。引擎不支持就整个不渲染。 */
export function SpeakButton({ lang, notice, tr }) {
  const { supported, speaking, speak } = useSpeech(lang)
  if (!supported) return null
  const text = speechText(notice)
  if (!text) return null
  return (
    <button
      type="button"
      className={'lm-student__chip' + (speaking ? ' is-on' : '')}
      aria-label={speaking ? tr('stop') : tr('listen')}
      aria-pressed={speaking}
      onClick={() => speak(text)}
    >
      {speaking ? <IconStop size={18} /> : <IconSpeaker size={18} />}
      <span>{speaking ? tr('stop') : tr('listen')}</span>
    </button>
  )
}

/* 字号三档：存在 localStorage，只影响学生端。文字按钮比图标更直白，也不再出现两个「A」。 */
export function FontControls({ level, onChange, tr }) {
  return (
    <div className="lm-student__fontctl" role="group" aria-label={tr('fontDown') + ' / ' + tr('fontUp')}>
      <button
        type="button"
        className="lm-student__chip lm-student__chip--txt"
        aria-label={tr('fontDown')}
        disabled={level <= 0}
        onClick={() => onChange(Math.max(0, level - 1))}
      >
        <span aria-hidden="true">A−</span>
      </button>
      <button
        type="button"
        className="lm-student__chip lm-student__chip--txt"
        aria-label={tr('fontUp')}
        disabled={level >= 2}
        onClick={() => onChange(Math.min(2, level + 1))}
      >
        <span aria-hidden="true">A+</span>
      </button>
    </div>
  )
}

/* 本班进度条 */
export function Progress({ confirmed, roster, label, ariaLabel }) {
  const total = Number(roster) || 0
  const done = Math.max(0, Number(confirmed) || 0)
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0
  return (
    <div className="lm-student__progress">
      <div className="lm-student__progress-top">
        <span className="lm-student__progress-num">
          {total > 0 ? `${done}/${total}` : String(done)}
        </span>
        <span className="lm-student__progress-label">{label}</span>
      </div>
      <div
        className="lm-student__bar"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={total || 100}
        aria-valuenow={total > 0 ? done : 0}
        aria-label={ariaLabel}
      >
        <span className="lm-student__bar-fill" style={{ width: pct + '%' }} />
      </div>
    </div>
  )
}

/* 答错时的原文高亮：左侧 4px 竖线 + 浅绿底，role=note 供读屏识别 */
export function Highlight({ text, label }) {
  if (!text) return null
  return (
    <div className="lm-student__hl" role="note">
      {label ? <span className="lm-student__hl-label">{label}</span> : null}
      <p className="lm-student__hl-text">{text}</p>
    </div>
  )
}

/* 加入日历：前端生成 .ics，不发请求。缺 deadline.iso 就不渲染。 */
export function CalendarButton({ notice, tr, lang, tone }) {
  const [msg, setMsg] = useState('')
  const iso = notice && notice.deadline ? notice.deadline.iso : null
  if (!iso) return null

  const onClick = () => {
    const text = buildIcs({
      noticeId: notice && notice.notice_id,
      oneLine: notice && notice.one_line,
      actions: notice && notice.actions,
      startIso: iso,
      location: (notice && notice.place) || '',
      lang
    })
    const ok = text ? downloadIcs(icsFilename(notice && notice.notice_id), text) : false
    setMsg(ok ? tr('calReady') : tr('errGenericTitle'))
  }

  return (
    <div className="lm-student__cal">
      <button
        type="button"
        className={
          'lm-student__btn ' + (tone === 'primary' ? 'lm-student__btn--primary' : 'lm-student__btn--ghost')
        }
        aria-label={tr('addCalendar')}
        onClick={onClick}
      >
        <IconCalendar size={20} />
        <span>{tr('addCalendar')}</span>
      </button>
      <span className="lm-student__cal-msg" role="status" aria-live="polite">
        {msg}
      </span>
    </div>
  )
}

/* 官方渠道块：risk_flag !== none 时固定出现，只放官方信息 + 免责说明。 */
export function OfficialBlock({ links, contacts, tr }) {
  const linkList = Array.isArray(links) ? links.filter((l) => l && (l.url || l.label)) : []
  const contactList = Array.isArray(contacts) ? contacts.filter((c) => c && (c.name || c.phone)) : []
  if (!linkList.length && !contactList.length) return null
  return (
    <section className="lm-student__official" aria-labelledby="lm-official-title">
      <h2 className="lm-student__official-title" id="lm-official-title">
        {tr('officialTitle')}
      </h2>
      {linkList.length ? (
        <div className="lm-student__official-group">
          <span className="lm-student__eyebrow">{tr('officialLinks')}</span>
          <ul className="lm-student__official-list">
            {linkList.map((link, i) => (
              <li key={'l' + i}>
                <a
                  className="lm-student__official-link"
                  href={link.url || '#'}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <IconLink size={18} />
                  <span>{link.label || link.url}</span>
                </a>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {contactList.length ? (
        <div className="lm-student__official-group">
          <span className="lm-student__eyebrow">{tr('officialContacts')}</span>
          <ul className="lm-student__official-list">
            {contactList.map((c, i) => (
              <li key={'c' + i} className="lm-student__contact">
                <span className="lm-student__contact-name">{c.name || ''}</span>
                {c.phone ? (
                  <a className="lm-student__official-link" href={'tel:' + String(c.phone).replace(/\s+/g, '')}>
                    <IconPhone size={18} />
                    <span>{c.phone}</span>
                  </a>
                ) : null}
                {c.note ? <span className="lm-student__contact-note">{c.note}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <p className="lm-student__official-note">{tr('officialNote')}</p>
    </section>
  )
}

/* 中文原文折叠区。 */
export function OriginalFold({ text, tr, defaultOpen }) {
  const [open, setOpen] = useState(!!defaultOpen)
  if (!text) return null
  return (
    <section className="lm-student__original">
      <button
        type="button"
        className="lm-student__fold"
        aria-expanded={open}
        aria-controls="lm-original-body"
        onClick={() => setOpen((v) => !v)}
      >
        <span>{open ? tr('hideNotice') : tr('seeOriginal')}</span>
        <IconChevron size={20} open={open} />
      </button>
      {open ? (
        <div className="lm-student__original-body" id="lm-original-body">
          {text}
        </div>
      ) : null}
    </section>
  )
}
