/* 辅导员端公共零件：卡片、按钮、进度条、骨架屏、错误条、复制按钮、二维码、密钥层。
   全部选择器都在 counselor.css 里以 .lm-counselor 开头。 */

import React, { useEffect, useRef, useState } from 'react'
import { copyText, LANG_LABEL } from './helpers.js'

export function Eyebrow({ children, className = '' }) {
  return <div className={`lm-counselor-eyebrow ${className}`.trim()}>{children}</div>
}

export function Card({ children, className = '', label, title, actions, flat }) {
  return (
    <section className={`lm-counselor-card${flat ? ' is-flat' : ''} ${className}`.trim()}>
      {label || title || actions ? (
        <header className="lm-counselor-card-head">
          <div className="lm-counselor-card-headtext">
            {label ? <Eyebrow>{label}</Eyebrow> : null}
            {title ? <h3 className="lm-counselor-card-title">{title}</h3> : null}
          </div>
          {actions ? <div className="lm-counselor-card-actions">{actions}</div> : null}
        </header>
      ) : null}
      {children}
    </section>
  )
}

export function Btn({
  children,
  variant = 'ghost',
  size = 'md',
  block = false,
  className = '',
  ...rest
}) {
  return (
    <button
      type="button"
      className={`lm-counselor-btn is-${variant} is-${size}${block ? ' is-block' : ''} ${className}`.trim()}
      {...rest}
    >
      {children}
    </button>
  )
}

export function Bar({ value = 0, total = 0, tone = 'mint', height = 4, className = '' }) {
  const p = total > 0 ? Math.max(0, Math.min(100, Math.round((Number(value) / Number(total)) * 100))) : 0
  return (
    <div className={`lm-counselor-bar ${className}`.trim()} style={{ height }}>
      <div className={`lm-counselor-bar-fill is-${tone}`} style={{ width: `${p}%` }} />
    </div>
  )
}

export function LangTag({ lang }) {
  return (
    <span className={`lm-counselor-lang is-${lang || 'other'}`}>
      {LANG_LABEL[lang] || String(lang || '').toUpperCase()}
    </span>
  )
}

export function ErrBar({ message, onRetry, onClose, retryLabel = '重试' }) {
  if (!message) return null
  return (
    <div className="lm-counselor-errdbar" role="alert">
      <span className="lm-counselor-errdbar-mark">!</span>
      <span className="lm-counselor-errdbar-text">{message}</span>
      {onRetry ? (
        <Btn size="sm" onClick={onRetry}>
          {retryLabel}
        </Btn>
      ) : null}
      {onClose ? (
        <button type="button" className="lm-counselor-errdbar-x" onClick={onClose} aria-label="关闭">
          ×
        </button>
      ) : null}
    </div>
  )
}

export function Skel({ rows = 3, className = '' }) {
  return (
    <div className={`lm-counselor-skel ${className}`.trim()} aria-hidden="true">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="lm-counselor-skel-line" style={{ width: `${92 - (i % 3) * 14}%` }} />
      ))}
    </div>
  )
}

export function Empty({ label, title, hint, action }) {
  return (
    <div className="lm-counselor-empty">
      {label ? <Eyebrow>{label}</Eyebrow> : null}
      <div className="lm-counselor-empty-t">{title}</div>
      {hint ? <div className="lm-counselor-empty-h">{hint}</div> : null}
      {action ? <div className="lm-counselor-empty-a">{action}</div> : null}
    </div>
  )
}

/* 复制按钮：成功后文字变「已复制」两秒 */
export function CopyBtn({
  text,
  label = '复制',
  variant = 'ghost',
  size = 'sm',
  block = false,
  className = ''
}) {
  const [state, setState] = useState('idle')
  const timer = useRef(null)

  useEffect(() => () => clearTimeout(timer.current), [])

  async function onClick() {
    const ok = await copyText(text)
    setState(ok ? 'ok' : 'fail')
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setState('idle'), 2000)
  }

  return (
    <Btn
      variant={state === 'ok' ? 'primary' : variant}
      size={size}
      block={block}
      className={`lm-counselor-copybtn ${className}`.trim()}
      onClick={onClick}
      disabled={!text}
    >
      {state === 'ok' ? '已复制' : state === 'fail' ? '复制失败' : label}
    </Btn>
  )
}

export function QrBox({ url, dataUrl, size = 168 }) {
  const src = dataUrl || (url ? `/api/qr?url=${encodeURIComponent(url)}` : '')
  const [broken, setBroken] = useState(false)

  useEffect(() => {
    setBroken(false)
  }, [src])

  if (!src) return null
  if (broken) {
    return (
      <div className="lm-counselor-qr is-broken" style={{ width: size, height: size }}>
        <span>二维码没生成出来</span>
        <span className="lm-counselor-qr-sub">用旁边的链接一样可以</span>
      </div>
    )
  }
  return (
    <div className="lm-counselor-qr" style={{ width: size, height: size }}>
      <img
        src={src}
        alt="学生链接二维码"
        width={size}
        height={size}
        onError={() => setBroken(true)}
      />
    </div>
  )
}

/* 密钥输入层：401 时弹出，不白屏 */
export function KeyDialog({ open, value, message, onSave, onClose }) {
  const [v, setV] = useState(value || '')

  useEffect(() => {
    if (open) setV(value || '')
  }, [open, value])

  if (!open) return null

  return (
    <div className="lm-counselor-modal" role="dialog" aria-modal="true" aria-label="辅导员密钥">
      <div className="lm-counselor-modal-box">
        <Eyebrow>ACCESS · COUNSELOR KEY</Eyebrow>
        <h3 className="lm-counselor-modal-title">填一下辅导员密钥</h3>
        <p className="lm-counselor-modal-hint">
          默认是 <code>lastmile</code>，存在这台电脑的 localStorage 里，不会上传。
        </p>
        {message ? <div className="lm-counselor-modal-err">{message}</div> : null}
        <input
          className="lm-counselor-input"
          type="password"
          value={v}
          autoFocus
          placeholder="COUNSELOR_KEY"
          onChange={(e) => setV(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onSave(v)
            if (e.key === 'Escape' && onClose) onClose()
          }}
        />
        <div className="lm-counselor-modal-actions">
          {onClose ? (
            <Btn onClick={onClose} size="md">
              先不用
            </Btn>
          ) : null}
          <Btn variant="primary" size="md" onClick={() => onSave(v)}>
            保存并重试
          </Btn>
        </div>
      </div>
    </div>
  )
}
