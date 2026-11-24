/* 催办 tab：选范围 + 选语气 + 选语言 → 一段可直接粘到群里的文案。
   这是「挨个点名」变成「复制一段话」的地方，所以按钮只有两个：生成、复制。 */

import React, { useEffect, useMemo, useState } from 'react'
import { buildNudge } from '../lib/api.js'
import { errText, isAuthError, studentLink } from './helpers.js'
import {
  Btn,
  Card,
  CopyBtn,
  Empty,
  ErrBar,
  QrBox,
  Skel
} from './ui.jsx'

const TIERS = [
  { value: 'unread', label: '未读', hint: '还没点开链接的人' },
  { value: 'all', label: '全部未确认', hint: '读了没回执 + 还没读' },
  { value: 'help', label: '有困难', hint: '点过「我有困难」的人' }
]

const TONES = [
  { value: 'gentle', label: '温和', hint: '第一次提醒' },
  { value: 'firm', label: '明确', hint: '第二次，写截止' },
  { value: 'final', label: '最后', hint: '第三次，写后果' }
]

const NUDGE_LANGS = [
  { value: 'en', label: 'EN' },
  { value: 'zh', label: '中文' },
  { value: 'ru', label: 'RU' },
  { value: 'vi', label: 'VI' },
  { value: 'th', label: 'TH' },
  { value: 'id', label: 'ID' }
]

export default function NudgeTab({ id, published, token, seed, onAuthError, onGoConfirm }) {
  const [tier, setTier] = useState(null)
  const [tone, setTone] = useState('gentle')
  const [lang, setLang] = useState('en')
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')
  const [result, setResult] = useState(null)
  const [showAll, setShowAll] = useState(false)

  /* 从看板点「催」跳过来时，直接把范围选好 */
  useEffect(() => {
    if (seed && seed.tier) {
      setTier(seed.tier)
      setResult(null)
      setErr('')
      setShowAll(false)
    }
  }, [seed])

  const tierMeta = TIERS.find((t) => t.value === tier) || null
  const toneMeta = TONES.find((t) => t.value === tone) || TONES[0]
  const langMeta = NUDGE_LANGS.find((l) => l.value === lang) || NUDGE_LANGS[0]

  const link = (result && result.link) || studentLink(id)
  const targets = useMemo(
    () => (Array.isArray(result && result.targets) ? result.targets : []),
    [result]
  )
  const listed = showAll ? targets : targets.slice(0, 10)

  async function generate() {
    if (!tier || !published) return
    setLoading(true)
    setErr('')
    try {
      const res = await buildNudge(id, { tier, tone, lang })
      setResult(res && typeof res === 'object' ? res : { text: '', targets: [] })
      setShowAll(false)
    } catch (e) {
      if (isAuthError(e)) onAuthError(errText(e))
      setErr(errText(e))
      setResult(null)
    } finally {
      setLoading(false)
    }
  }

  if (!published) {
    return (
      <Empty
        label="NOT PUBLISHED"
        title="还没发布，没人可催"
        hint="发布之后才有「谁没读」这个名单。先去确认 tab 核完字段点发布。"
        action={
          <Btn variant="primary" onClick={onGoConfirm}>
            去确认并发布
          </Btn>
        }
      />
    )
  }

  return (
    <div className="lm-counselor-nudge">
      <div className="lm-counselor-nudge-choices">
        <Card label="TARGET · 发给谁" title="先选一个范围">
          <div className="lm-counselor-choices">
            {TIERS.map((t) => (
              <button
                type="button"
                key={t.value}
                className={`lm-counselor-choice${tier === t.value ? ' is-on' : ''}`}
                onClick={() => {
                  setTier(t.value)
                  setResult(null)
                  setErr('')
                }}
              >
                <span className="lm-counselor-choice-t">{t.label}</span>
                <span className="lm-counselor-choice-h">{t.hint}</span>
              </button>
            ))}
          </div>
        </Card>

        <Card label="TONE · 语气" title="第几轮催">
          <div className="lm-counselor-choices is-row">
            {TONES.map((t) => (
              <button
                type="button"
                key={t.value}
                className={`lm-counselor-choice is-compact${tone === t.value ? ' is-on' : ''}`}
                onClick={() => setTone(t.value)}
              >
                <span className="lm-counselor-choice-t">{t.label}</span>
                <span className="lm-counselor-choice-h">{t.hint}</span>
              </button>
            ))}
          </div>
        </Card>

        <Card label="LANGUAGE · 语言" title="这一轮用哪种语言发">
          <div className="lm-counselor-langpick">
            {NUDGE_LANGS.map((l) => (
              <button
                type="button"
                key={l.value}
                className={`lm-counselor-langbtn${lang === l.value ? ' is-on' : ''}`}
                onClick={() => setLang(l.value)}
              >
                {l.label}
              </button>
            ))}
          </div>
          <p className="lm-counselor-side-hint">
            同一条通知可能要发三轮、三种语言。文案由服务端按通知内容生成，不会新编事实。
          </p>
        </Card>

        <Btn
          variant="primary"
          size="lg"
          block
          onClick={generate}
          disabled={!tier || loading}
        >
          {loading ? '正在生成…' : '生成催办文案'}
        </Btn>
        {!tier ? (
          <p className="lm-counselor-side-hint is-center">缺一步：先在上面选一个范围</p>
        ) : null}
      </div>

      <div className="lm-counselor-nudge-out">
        {err ? <ErrBar message={err} onRetry={generate} /> : null}

        {loading ? (
          <Card>
            <Skel rows={5} />
          </Card>
        ) : result ? (
          <>
            <Card
              label={`NUDGE · ${tierMeta ? tierMeta.label : ''} · ${toneMeta.label} · ${langMeta.label}`}
              title="这段可以直接粘到群里"
              actions={<CopyBtn text={result.text} label="复制文案" variant="primary" size="md" />}
            >
              <textarea
                className="lm-counselor-nudge-text"
                readOnly
                rows={Math.min(18, Math.max(6, String(result.text || '').split('\n').length + 2))}
                value={result.text || ''}
              />
              <div className="lm-counselor-nudge-foot">
                <span className="lm-counselor-eyebrow">
                  TARGETS · {targets.length} 人
                </span>
                <span className="lm-counselor-hint">复制 → 粘到班级群，不用挨个 @</span>
              </div>
              {targets.length > 0 ? (
                <>
                  <ul className="lm-counselor-targets">
                    {listed.map((t) => (
                      <li key={t.student_id || t.name}>
                        <span className="lm-counselor-target-name">{t.name || '—'}</span>
                        <span className="lm-counselor-mono is-dim">{t.student_id || ''}</span>
                      </li>
                    ))}
                  </ul>
                  {targets.length > 10 ? (
                    <button
                      type="button"
                      className="lm-counselor-linkbtn"
                      onClick={() => setShowAll((v) => !v)}
                    >
                      {showAll ? '收起' : `展开全部 ${targets.length} 人`}
                    </button>
                  ) : null}
                </>
              ) : (
                <p className="lm-counselor-side-hint">这一档现在是空的——说明这个范围里没人需要催。</p>
              )}
            </Card>

            <Card label="LINK · QR" title="学生点这个链接">
              <div className="lm-counselor-nudge-link">
                <div className="lm-counselor-linkbox is-small">
                  <code>{link}</code>
                </div>
                <CopyBtn text={link} label="复制链接" size="sm" />
              </div>
              <div className="lm-counselor-nudge-qr">
                <QrBox url={link} dataUrl={result.qr_data_url} size={150} />
              </div>
            </Card>
          </>
        ) : !tier ? (
          <Empty
            label="NO TARGET"
            title="还没选目标——先选一个范围"
            hint="左边三个按钮：未读 / 全部未确认 / 有困难。选完再点「生成催办文案」。"
          />
        ) : (
          <Empty
            label="READY"
            title="范围选好了，点「生成催办文案」"
            hint={`${tierMeta ? tierMeta.label : ''} · ${toneMeta.label} · ${langMeta.label}。生成后可以一键复制，也可以扫二维码让学生直接开。`}
          />
        )}
      </div>
    </div>
  )
}
