/* 确认 tab：AI 抽出来的每个字段都能改，每个字段下面都挂着原文片段（↵）。
   这是「AI 不是黑箱」的视觉：老师说得出这句话是从通知里哪一段来的。 */

import React from 'react'
import {
  KIND_LABEL,
  LANG_LABEL,
  NOTICE_STATUS,
  RISK_LABEL,
  fmtDateTime,
  fromLocalInput,
  groupMessage,
  leftText,
  toLocalInput
} from './helpers.js'
import { Btn, Card, CopyBtn, Eyebrow, LangTag, QrBox } from './ui.jsx'

function spanText(v) {
  if (!v) return ''
  if (Array.isArray(v)) return v.filter((x) => typeof x === 'string' && x).join(' / ')
  if (typeof v === 'string') return v
  return ''
}

function Field({ tag, label, span, hint, hideSpan, children }) {
  return (
    <div className="lm-counselor-field">
      <div className="lm-counselor-field-head">
        <span className="lm-counselor-eyebrow">{tag}</span>
        <span className="lm-counselor-field-label">{label}</span>
      </div>
      {children}
      {hint ? <div className="lm-counselor-field-hint">{hint}</div> : null}
      {hideSpan ? null : (
        <div className={`lm-counselor-span${span ? '' : ' is-none'}`}>
          <span className="lm-counselor-span-mark">↵</span>
          <span className="lm-counselor-span-text">{span || '原文里没定位到这一段'}</span>
        </div>
      )}
    </div>
  )
}

function reindex(list) {
  return list.map((a, i) => ({ ...a, order: i + 1 }))
}

/* 行动项：有序、动词开头。可增、可删、可上下挪——顺序就是学生看到的一二三。 */
function ActionsEditor({ items, spans, onChange }) {
  const actSpans = Array.isArray(spans.actions) ? spans.actions : null

  function update(i, patch) {
    onChange(items.map((a, idx) => (idx === i ? { ...a, ...patch } : a)))
  }
  function remove(i) {
    onChange(reindex(items.filter((_, idx) => idx !== i)))
  }
  function move(i, dir) {
    const j = i + dir
    if (j < 0 || j >= items.length) return
    const next = items.slice()
    const tmp = next[i]
    next[i] = next[j]
    next[j] = tmp
    onChange(reindex(next))
  }
  function add() {
    onChange(reindex(items.concat([{ order: items.length + 1, zh: '', en: '' }])))
  }

  return (
    <div className="lm-counselor-actions">
      {items.length === 0 ? (
        <div className="lm-counselor-actions-empty">还没有行动项——点下面「加一条」写第一条。</div>
      ) : null}
      {items.map((a, i) => (
        <div className="lm-counselor-actionrow" key={`act-${i}`}>
          <span className="lm-counselor-actionrow-no">{i + 1}</span>
          <div className="lm-counselor-actionrow-body">
            <input
              className="lm-counselor-input"
              value={a.zh}
              placeholder="带上护照原件（动词开头，一条一件事）"
              onChange={(e) => update(i, { zh: e.target.value })}
            />
            <input
              className="lm-counselor-input is-sub"
              value={a.en}
              placeholder="Bring your passport (original) — 学生端的英文对照"
              onChange={(e) => update(i, { en: e.target.value })}
            />
            <div className={`lm-counselor-span${actSpans && actSpans[i] ? '' : ' is-none'}`}>
              <span className="lm-counselor-span-mark">↵</span>
              <span className="lm-counselor-span-text">
                {(actSpans && actSpans[i]) || '这一条是补写的，原文没有对应句子'}
              </span>
            </div>
          </div>
          <div className="lm-counselor-actionrow-tools">
            <button
              type="button"
              className="lm-counselor-iconbtn is-mini"
              title="上移"
              onClick={() => move(i, -1)}
              disabled={i === 0}
            >
              ↑
            </button>
            <button
              type="button"
              className="lm-counselor-iconbtn is-mini"
              title="下移"
              onClick={() => move(i, 1)}
              disabled={i === items.length - 1}
            >
              ↓
            </button>
            <button
              type="button"
              className="lm-counselor-iconbtn is-mini is-danger"
              title="删掉这一条"
              onClick={() => remove(i)}
            >
              ×
            </button>
          </div>
        </div>
      ))}
      <Btn size="sm" onClick={add}>
        + 加一条行动
      </Btn>
    </div>
  )
}

function MaterialsEditor({ items, onChange }) {
  return (
    <div className="lm-counselor-actions">
      {items.map((m, i) => (
        <div className="lm-counselor-onerow" key={`mat-${i}`}>
          <input
            className="lm-counselor-input"
            value={m}
            placeholder="护照原件"
            onChange={(e) => onChange(items.map((v, idx) => (idx === i ? e.target.value : v)))}
          />
          <button
            type="button"
            className="lm-counselor-iconbtn is-mini is-danger"
            title="删掉这一项"
            onClick={() => onChange(items.filter((_, idx) => idx !== i))}
          >
            ×
          </button>
        </div>
      ))}
      <Btn size="sm" onClick={() => onChange(items.concat(['']))}>
        + 加一项材料
      </Btn>
    </div>
  )
}

function ContactsEditor({ items, onChange }) {
  return (
    <div className="lm-counselor-actions">
      {items.map((c, i) => (
        <div className="lm-counselor-tworow" key={`ct-${i}`}>
          <input
            className="lm-counselor-input"
            value={c.name}
            placeholder="张老师"
            onChange={(e) =>
              onChange(items.map((v, idx) => (idx === i ? { ...v, name: e.target.value } : v)))
            }
          />
          <input
            className="lm-counselor-input"
            value={c.phone}
            placeholder="028-87092233"
            onChange={(e) =>
              onChange(items.map((v, idx) => (idx === i ? { ...v, phone: e.target.value } : v)))
            }
          />
          <input
            className="lm-counselor-input is-sub"
            value={c.note}
            placeholder="工作日 9:00-17:00"
            onChange={(e) =>
              onChange(items.map((v, idx) => (idx === i ? { ...v, note: e.target.value } : v)))
            }
          />
          <button
            type="button"
            className="lm-counselor-iconbtn is-mini is-danger"
            title="删掉这位联系人"
            onClick={() => onChange(items.filter((_, idx) => idx !== i))}
          >
            ×
          </button>
        </div>
      ))}
      <Btn size="sm" onClick={() => onChange(items.concat([{ name: '', phone: '', note: '' }]))}>
        + 加一位联系人
      </Btn>
    </div>
  )
}

function LinksEditor({ items, onChange }) {
  return (
    <div className="lm-counselor-actions">
      {items.map((l, i) => (
        <div className="lm-counselor-tworow" key={`lk-${i}`}>
          <input
            className="lm-counselor-input"
            value={l.label}
            placeholder="国际交流处"
            onChange={(e) =>
              onChange(items.map((v, idx) => (idx === i ? { ...v, label: e.target.value } : v)))
            }
          />
          <input
            className="lm-counselor-input is-mono"
            value={l.url}
            placeholder="https://…"
            onChange={(e) =>
              onChange(items.map((v, idx) => (idx === i ? { ...v, url: e.target.value } : v)))
            }
          />
          <button
            type="button"
            className="lm-counselor-iconbtn is-mini is-danger"
            title="删掉这个链接"
            onClick={() => onChange(items.filter((_, idx) => idx !== i))}
          >
            ×
          </button>
        </div>
      ))}
      <Btn size="sm" onClick={() => onChange(items.concat([{ label: '', url: '' }]))}>
        + 加一个官方链接
      </Btn>
    </div>
  )
}

export default function ConfirmTab({
  form,
  onChange,
  status,
  quiz,
  translations,
  counts,
  rawText,
  busy,
  err,
  note,
  onPublish,
  onSaveDraft
}) {
  const spans = form.spans || {}
  const warnings = form.warnings || []
  const risk = form.risk_flags || []
  const riskLabels = risk.map((f) => RISK_LABEL[f] || f)
  const stMeta = NOTICE_STATUS[status] || NOTICE_STATUS.draft
  const transLangs = translations && typeof translations === 'object' ? Object.keys(translations) : []
  const roster = Number(counts && counts.roster) || 0

  const set = (patch) => onChange({ ...form, ...patch })
  const setDeadline = (patch) => onChange({ ...form, deadline: { ...form.deadline, ...patch } })
  const setPlace = (patch) => onChange({ ...form, place: { ...form.place, ...patch } })

  return (
    <div className="lm-counselor-confirm">
      {risk.length > 0 || warnings.length > 0 ? (
        <div className="lm-counselor-alerts">
          {risk.length > 0 ? (
            <div className="lm-counselor-riskbar">
              <span className="lm-counselor-riskbar-mark">!</span>
              <span>
                本通知涉及 <b>{riskLabels.join('、')}</b>，产品只转述、不提供建议；学生问到这一类问题会转人工并留档。
              </span>
            </div>
          ) : null}
          {warnings.map((w, i) => (
            <div className="lm-counselor-warnbar" key={`w-${i}`}>
              <span className="lm-counselor-warnbar-mark">!</span>
              <span>{w}</span>
            </div>
          ))}
        </div>
      ) : null}

      <div className="lm-counselor-confirm-grid">
        <div className="lm-counselor-form">
          <Field tag="TITLE" label="标题（中文原文）" span={spans.title_zh}>
            <textarea
              className="lm-counselor-input is-title"
              rows={2}
              value={form.title_zh}
              onChange={(e) => set({ title_zh: e.target.value })}
            />
          </Field>

          <Field tag="ONE LINE" label="一句话结论" span={spans.one_line} hint="学生只看这一句也能知道要干嘛">
            <textarea
              className="lm-counselor-input"
              rows={2}
              value={form.one_line}
              onChange={(e) => set({ one_line: e.target.value })}
            />
          </Field>

          <Field tag="WHO" label="谁要办" span={spans.who}>
            <input
              className="lm-counselor-input"
              value={form.who}
              placeholder="2026级全体国际学生（114人）"
              onChange={(e) => set({ who: e.target.value })}
            />
          </Field>

          <Field tag="WHAT" label="要办什么事" span={spans.what}>
            <textarea
              className="lm-counselor-input"
              rows={3}
              value={form.what}
              onChange={(e) => set({ what: e.target.value })}
            />
          </Field>

          <Field
            tag="ACTIONS"
            label="学生要做的几步"
            hideSpan
            hint="写动作，不写背景。学生端会按这个顺序编号展示；每条下面的 ↵ 是它在原文里的出处。"
          >
            <ActionsEditor items={form.actions} spans={spans} onChange={(v) => set({ actions: v })} />
          </Field>

          <Field
            tag="DEADLINE"
            label="截止时间"
            span={spans.deadline}
            hint={
              form.deadline.confidence === 'high'
                ? form.deadline.basis || '原文写明绝对日期 + 时间'
                : `由相对时间推算${form.deadline.basis ? `：${form.deadline.basis}` : ''}，务必核对`
            }
          >
            <div className="lm-counselor-deadline">
              <input
                type="datetime-local"
                className="lm-counselor-input is-date"
                value={toLocalInput(form.deadline.iso)}
                onChange={(e) => setDeadline({ iso: fromLocalInput(e.target.value) })}
              />
              <span className="lm-counselor-deadline-left">{leftText(form.deadline.iso)}</span>
              {form.deadline.raw ? (
                <span className="lm-counselor-deadline-raw">原文写的是「{form.deadline.raw}」</span>
              ) : null}
            </div>
          </Field>

          <Field tag="WHERE" label="地点" span={spans.place}>
            <input
              className="lm-counselor-input"
              value={form.place.raw}
              placeholder="柳林校区通博楼A座204办公室"
              onChange={(e) => setPlace({ raw: e.target.value })}
            />
          </Field>

          <Field tag="MATERIALS" label="要带的材料" span={spanText(spans.materials)}>
            <MaterialsEditor items={form.materials} onChange={(v) => set({ materials: v })} />
          </Field>

          <Field tag="OR ELSE" label="逾期 / 不办的后果" span={spans.consequence}>
            <textarea
              className="lm-counselor-input"
              rows={2}
              value={form.consequence}
              placeholder="逾期未办理者，居留许可过期将按非法居留处理，后果自负。"
              onChange={(e) => set({ consequence: e.target.value })}
            />
          </Field>

          <Field tag="CONTACTS" label="找谁" span={spanText(spans.contacts)}>
            <ContactsEditor items={form.contacts} onChange={(v) => set({ contacts: v })} />
          </Field>

          <Field tag="OFFICIAL LINKS" label="官方链接" span={spanText(spans.official_links)}>
            <LinksEditor items={form.official_links} onChange={(v) => set({ official_links: v })} />
          </Field>
        </div>

        <aside className="lm-counselor-side">
          <Card label="STATUS" title="这份通知现在是什么状态">
            <div className="lm-counselor-kv">
              <span className="lm-counselor-kv-k">状态</span>
              <span className="lm-counselor-kv-v">
                <span className="lm-counselor-status-dot" style={{ background: stMeta.color }} />
                {stMeta.label}
              </span>
            </div>
            <div className="lm-counselor-kv">
              <span className="lm-counselor-kv-k">类型</span>
              <span className="lm-counselor-kv-v">{KIND_LABEL[form.kind] || form.kind || '一般通知'}</span>
            </div>
            <div className="lm-counselor-kv">
              <span className="lm-counselor-kv-k">对象</span>
              <span className="lm-counselor-kv-v">{form.who || '—'}</span>
            </div>
            <div className="lm-counselor-kv">
              <span className="lm-counselor-kv-k">截止</span>
              <span className="lm-counselor-kv-v">
                {form.deadline.iso ? fmtDateTime(form.deadline.iso) : '未解析'}
              </span>
            </div>
            <div className="lm-counselor-kv">
              <span className="lm-counselor-kv-k">名单</span>
              <span className="lm-counselor-kv-v">{roster ? `${roster} 人` : '—'}</span>
            </div>
            {rawText ? (
              <details className="lm-counselor-raw">
                <summary>看原文（AI 只转述，原文在这里）</summary>
                <pre>{rawText}</pre>
              </details>
            ) : null}
          </Card>

          <Card label="QUIZ" title="学生要答的那一道题">
            {quiz && quiz.question ? (
              <>
                <div className="lm-counselor-quiz-q">{quiz.question}</div>
                <ol className="lm-counselor-quiz-opts">
                  {(Array.isArray(quiz.options) ? quiz.options : []).map((o, i) => (
                    <li
                      key={i}
                      className={Number(quiz.answer_index) === i ? 'is-answer' : undefined}
                    >
                      {o}
                      {Number(quiz.answer_index) === i ? (
                        <span className="lm-counselor-quiz-tag">正确答案</span>
                      ) : null}
                    </li>
                  ))}
                </ol>
                <p className="lm-counselor-side-hint">
                  答错会给学生看 <code>source_span</code> 原文片段，可重试，不挡回执。
                </p>
              </>
            ) : (
              <p className="lm-counselor-side-hint">
                发布时服务端会自动生成中文小测（答案只在服务端），学生答错看到的是原文片段。
              </p>
            )}
          </Card>

          <Card label="LANGUAGES" title="学生能选的语言">
            <div className="lm-counselor-langs is-wrap">
              {transLangs.length ? (
                transLangs.map((l) => <LangTag key={l} lang={l} />)
              ) : (
                <span className="lm-counselor-lang is-pending">待生成</span>
              )}
            </div>
            <p className="lm-counselor-side-hint">
              {transLangs.length
                ? `已生成 ${transLangs.length} 种：${transLangs.map((l) => LANG_LABEL[l] || l).join(' / ')}`
                : '发布后自动补齐英 / 俄 / 越，每种语言各有一道自己的小测。'}
            </p>
          </Card>
        </aside>
      </div>

      <div className="lm-counselor-confirm-foot">
        <div className="lm-counselor-foot-text">
          {err ? <span className="lm-counselor-foot-err">{err}</span> : null}
          {!err && note ? <span className="lm-counselor-foot-note">{note}</span> : null}
          {!err && !note ? (
            <span className="lm-counselor-foot-note">
              核完点右边发布：链接 + 二维码 + 群发文案会一起出来。
            </span>
          ) : null}
        </div>
        <div className="lm-counselor-foot-btns">
          <Btn size="md" onClick={onSaveDraft} disabled={!!busy}>
            {busy === 'draft' ? '保存中…' : '保存草稿'}
          </Btn>
          <Btn variant="primary" size="lg" onClick={onPublish} disabled={!!busy}>
            {busy === 'publish' ? '发布中…' : '确认并发布'}
          </Btn>
        </div>
      </div>
    </div>
  )
}

/* 发布之后主区域换成的样子：链接 + 二维码 + 群发文案 */
export function PublishedPanel({ form, noticeId, rawLink, qrDataUrl }) {
  const link = rawLink
  const msg = groupMessage(form, link)
  return (
    <div className="lm-counselor-pub">
      <div className="lm-counselor-pub-head">
        <span className="lm-counselor-pub-badge">
          <span className="lm-counselor-status-dot" style={{ background: 'var(--mint)' }} />
          已发布
        </span>
        <span className="lm-counselor-eyebrow">SHARE · 下一步：把这个链接发到班级群</span>
      </div>

      <div className="lm-counselor-pub-grid">
        <div className="lm-counselor-pub-left">
          <Eyebrow>STUDENT LINK</Eyebrow>
          <div className="lm-counselor-linkbox">
            <code>{link}</code>
          </div>
          <div className="lm-counselor-pub-btns">
            <CopyBtn text={link} label="复制学生链接" variant="primary" size="md" />
            <a
              className="lm-counselor-btn is-ghost is-md"
              href={link}
              target="_blank"
              rel="noreferrer"
            >
              自己也看一眼
            </a>
          </div>
          <p className="lm-counselor-pub-tip">
            学生打开不用登录：选语言 → 看卡片 → 答一道题 → 点「我已知晓」。回执自动回到看板。
          </p>

          <div className="lm-counselor-msgwrap">
            <div className="lm-counselor-msgwrap-head">
              <Eyebrow>GROUP MESSAGE · 复制到班级群</Eyebrow>
              <CopyBtn text={msg} label="复制群发文案" size="sm" />
            </div>
            <textarea className="lm-counselor-msgbox" readOnly rows={10} value={msg} />
          </div>
        </div>

        <div className="lm-counselor-pub-right">
          <Eyebrow>QR</Eyebrow>
          <QrBox url={link} dataUrl={qrDataUrl} size={188} />
          <p className="lm-counselor-pub-tip is-center">教室投影、群里发图都能扫</p>
          <div className="lm-counselor-pub-id">
            <span className="lm-counselor-eyebrow">NOTICE ID</span>
            <code>{noticeId}</code>
          </div>
        </div>
      </div>
    </div>
  )
}
