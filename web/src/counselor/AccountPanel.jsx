/* 账号管理面板：顶栏的独立入口用（与 SettingsPanel 分开，设置面板里那一段是同一套权限的另一处入口）。
   覆盖式面板，外壳与设置面板一致；成员表 / 添加 / 一次性密码在这里独立实现，
   不从 SettingsPanel 导出内部组件。
   权限：owner 管辅导员，counselor 管自己的助理，assistant 只读（can_create 为空就没有添加入口）。
   所有错误只在面板里显示成红字：不 alert、不白屏、不把用户踢回门口（confirm 除外）。 */

import React, { useEffect, useRef, useState } from 'react'
import { createStaff, deleteStaff, getMe, listStaff, updateStaff } from '../lib/api.js'
import { errText, fmtDateTime, fmtRel } from './helpers.js'
import { Btn, CopyBtn, ErrBar, Eyebrow, Skel } from './ui.jsx'

const EMPTY_MSG = { tone: '', text: '' }

const ROLE_LABEL = { owner: '总管', counselor: '辅导员', assistant: '助理' }
const ROLE_CODE = { owner: 'OWNER', counselor: 'COUNSELOR', assistant: 'ASSISTANT' }

const COPY = {
  owner: {
    memberEyebrow: 'MEMBERS · 辅导员',
    memberDesc: '辅导员用各自的密码登录同一套工作台，学生、通知、回执都只在自己名下。',
    emptyTitle: '还没有辅导员。辅导员能自己导入学生、发通知，只能看到自己名下的。',
    emptyHint: '建好后会显示一次密码，复制发给本人；之后这里只看得到掩码。',
    addLabel: '添加辅导员',
    adding: '添加中…',
    nameLabel: '辅导员姓名',
    inputId: 'lm-account-name-owner',
    placeholder: '例如：李辅导员',
    countUnit: '位辅导员',
    nameTip: '辅导员',
    subKey: '助理',
    delAsk: (n) => `删除辅导员「${n}」？删掉后这把密码立刻失效，他名下的学生和通知记录会留在系统里。`
  },
  counselor: {
    memberEyebrow: 'MEMBERS · 助理',
    memberDesc: '助理用各自的密码登录同一套工作台，发通知和催办会记在各自名下。',
    emptyTitle: '还没有助理。助理能发通知、催办、导出回执，但改不了设置。',
    emptyHint: '建好后会显示一次密码，复制发给本人；之后这里只看得到掩码。',
    addLabel: '添加助理',
    adding: '添加中…',
    nameLabel: '姓名',
    inputId: 'lm-account-name-staff',
    placeholder: '例如：王助理',
    countUnit: '人',
    nameTip: '助理',
    subKey: '',
    delAsk: (n) => `删除助理「${n}」？删掉后这把密码立刻失效，他发过的通知记录会留在系统里。`
  },
  assistant: {
    memberEyebrow: 'MEMBERS · 成员',
    memberDesc: '助理不管理账号：辅导员账号和助理账号都由你的辅导员创建、停用和维护。',
    emptyTitle: '',
    emptyHint: '',
    addLabel: '',
    adding: '',
    nameLabel: '',
    inputId: 'lm-account-name-none',
    placeholder: '',
    countUnit: '人',
    nameTip: '成员',
    subKey: '',
    delAsk: (n) => `删除「${n}」？`
  }
}

/* ---------- 小工具 ---------- */

/* 服务端一般给 key_masked；万一没给，本地兜一个，别把明文塞进列表 */
function maskKey(key) {
  const s = String(key || '')
  if (!s) return ''
  if (s.length <= 4) return '••••'
  return `${s.slice(0, 4)}…${s.slice(-4)}`
}

/* active 在库里是 1/0（SQLite 没有布尔），接口也可能给 true/false */
function isActive(v) {
  return v === true || Number(v) === 1
}

/* v2 用 members / member，老后端用 staff，两边都认 */
function rowsOf(d) {
  if (Array.isArray(d && d.members)) return d.members
  if (Array.isArray(d && d.staff)) return d.staff
  return []
}

function memberOf(r) {
  if (r && r.member && typeof r.member === 'object') return r.member
  if (r && r.staff && typeof r.staff === 'object') return r.staff
  return null
}

/* can_create 是服务端给的能力：owner → counselor，counselor → assistant，assistant → null */
function canCreateOf(me) {
  if (!me) return false
  return me.can_create === 'counselor' || me.can_create === 'assistant'
}

/* 名下学生数：/api/me 现在没有这个字段，拿不到就不显示这一格 */
function studentCountOf(me) {
  if (!me) return null
  const keys = ['student_count', 'students', 'roster_count', 'student_total']
  for (const k of keys) {
    const v = me[k]
    if (v === null || v === undefined || v === '') continue
    const n = Number(v)
    if (Number.isFinite(n)) return n
  }
  return null
}

/* 401/403 不踢人：翻成一句人话，留在面板里 */
function opErrorText(e, fallback) {
  const m = errText(e)
  if (!m) return fallback || '出错了，请重试一次'
  if (/401|403|unauthor|forbidden|未授权|口令|访问密码|密钥/i.test(m)) {
    return `访问密码可能已变化，或这个账号没有这个权限（${m}）。关掉面板重新进入可以再试一次。`
  }
  return m
}

/* ---------- 面板 ---------- */

export default function AccountPanel({ open, onClose }) {
  const [me, setMe] = useState(null)
  const [meErr, setMeErr] = useState('')
  const [loading, setLoading] = useState(false)

  const [rows, setRows] = useState([])
  const [loaded, setLoaded] = useState(false)
  const [rowsErr, setRowsErr] = useState('')
  const [rowsLoading, setRowsLoading] = useState(false)

  /* 新建 */
  const [name, setName] = useState('')
  const [creating, setCreating] = useState(false)

  /* 行内操作防重：{ id, kind: 'toggle' | 'regen' | 'del' } */
  const [busy, setBusy] = useState(null)
  const [opErr, setOpErr] = useState('')
  const [opOk, setOpOk] = useState(EMPTY_MSG)

  /* 一次性明文密码：{ id, name, key, role } */
  const [secret, setSecret] = useState(null)

  const panelRef = useRef(null)
  const closeRef = useRef(null)
  const secretRef = useRef(null)
  /* 每次读取递增：关掉面板后晚回来的响应不落到面板上 */
  const seqRef = useRef(0)

  const role = me && me.role ? me.role : ''
  /* 角色不明时按「只读」显示：宁可少给入口，也别摆出一个建不了号的按钮 */
  const cfg = COPY[role] || COPY.assistant
  const canCreate = canCreateOf(me)
  const students = studentCountOf(me)
  const blocked = creating || Boolean(busy)
  const nm = name.trim()
  const canAdd = canCreate && nm.length > 0 && !blocked

  /* ---------- 读数据 ---------- */

  async function load() {
    const seq = ++seqRef.current
    setLoading(true)
    setMeErr('')
    setRowsErr('')
    /* 不在这里清 opErr / opOk：新建失败后回填列表时，那句提示要留在面板上 */

    let identity = null
    try {
      identity = await getMe()
    } catch (e) {
      if (seq !== seqRef.current) return
      setLoading(false)
      setRowsLoading(false)
      setMeErr(opErrorText(e, '读不到当前账号'))
      return
    }
    if (seq !== seqRef.current) return
    setMe(identity && typeof identity === 'object' ? identity : null)

    if (!canCreateOf(identity)) {
      setRows([])
      setLoaded(false)
      setLoading(false)
      setRowsLoading(false)
      return
    }

    setRowsLoading(true)
    try {
      const d = await listStaff()
      if (seq !== seqRef.current) return
      setRows(rowsOf(d))
      setLoaded(true)
    } catch (e) {
      if (seq !== seqRef.current) return
      setRowsErr(opErrorText(e, '读不到成员列表'))
    } finally {
      if (seq === seqRef.current) {
        setLoading(false)
        setRowsLoading(false)
      }
    }
  }

  /* 每次打开都重置成本地干净状态，再拉一次最新数据 */
  useEffect(() => {
    if (!open) return undefined

    setMe(null)
    setMeErr('')
    setLoading(true)
    setRows([])
    setLoaded(false)
    setRowsErr('')
    setRowsLoading(false)
    setName('')
    setCreating(false)
    setBusy(null)
    setOpErr('')
    setOpOk(EMPTY_MSG)
    setSecret(null)

    load()

    return () => {
      seqRef.current += 1
    }
  }, [open])

  /* Esc 关闭 */
  useEffect(() => {
    if (!open) return undefined
    function onKey(e) {
      if (e.key !== 'Escape') return
      e.preventDefault()
      if (onClose) onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  /* 面板打开时别让背后的监控台跟着滚 */
  useEffect(() => {
    if (!open) return undefined
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [open])

  /* 初始焦点放在关闭按钮上 */
  useEffect(() => {
    if (!open) return undefined
    const t = setTimeout(() => closeRef.current?.focus(), 40)
    return () => clearTimeout(t)
  }, [open])

  /* 新密码出现时滚进视野（滚动容器是面板 body） */
  useEffect(() => {
    if (!secret) return undefined
    const t = setTimeout(() => {
      const el = secretRef.current
      if (el && typeof el.scrollIntoView === 'function') {
        el.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
      }
    }, 40)
    return () => clearTimeout(t)
  }, [secret])

  /* 轻量 Tab 圈：焦点别跑到面板背后的工作台里 */
  function onPanelKeyDown(e) {
    if (e.key !== 'Tab' || !panelRef.current) return
    const all = panelRef.current.querySelectorAll('button, input, textarea, select, a[href]')
    const list = Array.prototype.filter.call(all, (n) => !n.disabled && n.offsetParent !== null)
    if (!list.length) return
    const first = list[0]
    const last = list[list.length - 1]
    if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault()
      first.focus()
    } else if (e.shiftKey && document.activeElement === first) {
      e.preventDefault()
      last.focus()
    }
  }

  /* 点遮罩关闭：只认遮罩本身 */
  function onOverlayDown(e) {
    if (e.target === e.currentTarget && onClose) onClose()
  }

  /* ---------- 操作 ---------- */

  /* 就地更新一行，不整页重拉 */
  function mergeRow(id, patch) {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...(patch || {}) } : r)))
  }

  /* 明文密码放在顶层 access_key，不在成员对象里。
     明文在手时掩码以明文为准：重置后列表不会残留旧掩码。 */
  function rowFrom(st, plainKey, fallbackName) {
    const row = { ...(st || {}) }
    if (plainKey) row.key_masked = maskKey(plainKey)
    if (fallbackName && !row.name) row.name = fallbackName
    return row
  }

  function flashOk(text) {
    setOpErr('')
    setOpOk({ tone: 'ok', text })
  }

  async function submitCreate() {
    if (!canAdd) return
    setCreating(true)
    setOpErr('')
    setOpOk(EMPTY_MSG)
    try {
      const r = await createStaff(nm)
      const st = memberOf(r)
      const key = String((r && r.access_key) || '')
      if (!st || !st.id || !key) {
        /* 建好了却没回密码：先刷新让人看到这一行，别让用户重复添加 */
        setOpErr(`服务端没返回密码，${cfg.nameTip}可能已经建好：列表已刷新，请对他点一次「重置密码」`)
        setName('')
        await load()
        return
      }
      const row = rowFrom(st, key, nm)
      /* 先剔掉同 id 的旧行，避免列表里已经有他时撞 key */
      setRows((prev) => [...prev.filter((x) => x.id !== row.id), row])
      setLoaded(true)
      setSecret({ id: row.id, name: row.name, key })
      setName('')
      flashOk(`已添加${cfg.nameTip}：${row.name}`)
    } catch (e) {
      setOpErr(opErrorText(e, '添加失败，再试一次'))
    } finally {
      setCreating(false)
    }
  }

  async function toggleActive(row) {
    if (blocked) return
    const active = isActive(row.active)
    setBusy({ id: row.id, kind: 'toggle' })
    setOpErr('')
    setOpOk(EMPTY_MSG)
    try {
      const r = await updateStaff(row.id, { active: !active })
      if (r && r.ok === false) {
        setOpErr(r.error || '操作失败，再试一次')
        return
      }
      const st = memberOf(r)
      mergeRow(row.id, {
        ...(st || {}),
        active: st && st.active !== undefined ? st.active : active ? 0 : 1
      })
      flashOk(`${row.name} 已${active ? '停用' : '启用'}`)
    } catch (e) {
      setOpErr(opErrorText(e, '操作失败，再试一次'))
    } finally {
      setBusy(null)
    }
  }

  async function resetKey(row) {
    if (blocked) return
    if (!window.confirm(`重置「${row.name}」的密码？旧密码立刻失效，他正在用的页面会被登出。`)) return
    setBusy({ id: row.id, kind: 'regen' })
    setOpErr('')
    setOpOk(EMPTY_MSG)
    try {
      const r = await updateStaff(row.id, { regenerate: true })
      if (r && r.ok === false) {
        setOpErr(r.error || '重置失败，再试一次')
        return
      }
      const st = memberOf(r)
      const key = String((r && r.access_key) || '')
      mergeRow(row.id, rowFrom(st, key, row.name))
      if (key) {
        setSecret({ id: row.id, name: (st && st.name) || row.name, key })
      } else {
        /* 密码已换但没有明文：不能让人以为旧密码还能用 */
        setOpErr('密码已重置，但服务端没回明文：再点一次「重置密码」拿新密码')
      }
    } catch (e) {
      setOpErr(opErrorText(e, '重置失败，再试一次'))
    } finally {
      setBusy(null)
    }
  }

  async function removeRow(row) {
    if (blocked) return
    if (!window.confirm(cfg.delAsk(row.name))) return
    setBusy({ id: row.id, kind: 'del' })
    setOpErr('')
    setOpOk(EMPTY_MSG)
    try {
      const r = await deleteStaff(row.id)
      if (r && r.ok === false) {
        setOpErr(r.error || '删除失败，再试一次')
        return
      }
      setRows((prev) => prev.filter((x) => x.id !== row.id))
      setSecret((s) => (s && s.id === row.id ? null : s))
      flashOk(`已删除：${row.name}`)
    } catch (e) {
      setOpErr(opErrorText(e, '删除失败，再试一次'))
    } finally {
      setBusy(null)
    }
  }

  if (!open) return null

  return (
    <div className="lm-counselor-set-overlay" role="presentation" onMouseDown={onOverlayDown}>
      <div
        className="lm-counselor-set-panel lm-account-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="lm-account-title"
        ref={panelRef}
        tabIndex={-1}
        onKeyDown={onPanelKeyDown}
      >
        <header className="lm-counselor-set-head">
          <div className="lm-counselor-set-headtext">
            <Eyebrow>ACCOUNT · 账号管理</Eyebrow>
            <h2 className="lm-counselor-set-title" id="lm-account-title">
              {me && me.name ? me.name : '账号'}
            </h2>
          </div>
          <button
            type="button"
            className="lm-counselor-set-x"
            ref={closeRef}
            onClick={() => onClose && onClose()}
            title="关闭"
            aria-label="关闭账号管理"
          >
            ×
          </button>
        </header>

        <div className="lm-counselor-set-body lm-account-body">
          {meErr ? <ErrBar message={meErr} onRetry={load} retryLabel="重试" /> : null}

          {!meErr && !me ? (
            <div className="lm-counselor-set-loading">
              <Eyebrow>READING · 读取中…</Eyebrow>
              <Skel rows={4} />
            </div>
          ) : null}

          {me ? (
            <>
              {/* ---------- 1. 三个数字 ---------- */}
              <div className="lm-account-stats">
                <div className="lm-account-stat">
                  <span className="lm-account-stat-k">本账号角色</span>
                  <span className="lm-account-stat-v">{ROLE_LABEL[role] || '未知'}</span>
                  <span className="lm-account-stat-s">{ROLE_CODE[role] || ''}</span>
                </div>
                <div className="lm-account-stat">
                  <span className="lm-account-stat-k">名下成员</span>
                  <span className="lm-account-stat-v">
                    {canCreate ? (loaded ? rows.length : loading || rowsLoading ? '—' : 0) : '—'}
                  </span>
                  <span className="lm-account-stat-s">{cfg.countUnit}</span>
                </div>
                {students !== null ? (
                  <div className="lm-account-stat">
                    <span className="lm-account-stat-k">名下学生</span>
                    <span className="lm-account-stat-v">{students}</span>
                    <span className="lm-account-stat-s">人</span>
                  </div>
                ) : null}
              </div>

              {/* ---------- 2. 成员 ---------- */}
              <section className="lm-account-sec" aria-label={cfg.memberEyebrow}>
                <div className="lm-account-sec-head">
                  <Eyebrow>{cfg.memberEyebrow}</Eyebrow>
                  {canCreate && loaded ? (
                    <span className="lm-account-badge">
                      {rows.length} {cfg.countUnit}
                    </span>
                  ) : null}
                </div>
                <p className="lm-account-desc">{cfg.memberDesc}</p>

                {!canCreate ? (
                  <p className="lm-account-note">
                    你的账号没有建号权限：账号由所属辅导员创建和维护，找他要一个自己的密码就行。
                  </p>
                ) : null}

                {canCreate && rowsErr ? (
                  <div className="lm-account-loaderr">
                    <p className="lm-account-msg is-err" role="alert">
                      {rowsErr}
                    </p>
                    <Btn size="sm" onClick={load} disabled={rowsLoading}>
                      {rowsLoading ? '重试中…' : '重试'}
                    </Btn>
                  </div>
                ) : null}

                {canCreate && !rowsErr && !loaded ? <Skel rows={3} /> : null}

                {canCreate && !rowsErr && loaded && !rows.length ? (
                  <div className="lm-account-empty">
                    <p className="lm-account-empty-t">{cfg.emptyTitle}</p>
                    {cfg.emptyHint ? <p className="lm-account-empty-h">{cfg.emptyHint}</p> : null}
                  </div>
                ) : null}

                {canCreate && rows.length ? (
                  <div className="lm-account-list" role="list">
                    {rows.map((row) => {
                      const active = isActive(row.active)
                      const kind = busy && busy.id === row.id ? busy.kind : ''
                      const seen = row.last_seen_at ? fmtRel(row.last_seen_at) : ''
                      const seenText = seen && seen !== '—' ? seen : '还没登录'
                      /* owner 看到的是辅导员，多带一个「助理 N 人」 */
                      const subCount = cfg.subKey ? Number(row.assistant_count) || 0 : null
                      return (
                        <div
                          className={`lm-account-row${active ? '' : ' is-off'}`}
                          role="listitem"
                          key={row.id}
                        >
                          <div className="lm-account-main">
                            <span className="lm-account-name" title={row.name}>
                              {row.name}
                            </span>
                            <span className={`lm-account-state${active ? ' is-on' : ''}`}>
                              <span className="lm-account-dot" aria-hidden="true" />
                              {active ? '启用' : '已停用'}
                            </span>
                            {subCount !== null ? (
                              <span className="lm-account-sub">
                                {cfg.subKey} {subCount} 人
                              </span>
                            ) : null}
                          </div>

                          <div className="lm-account-acts">
                            <Btn
                              size="sm"
                              className="lm-account-act"
                              onClick={() => toggleActive(row)}
                              disabled={blocked}
                            >
                              {kind === 'toggle' ? '处理中…' : active ? '停用' : '启用'}
                            </Btn>
                            <Btn
                              size="sm"
                              className="lm-account-act"
                              onClick={() => resetKey(row)}
                              disabled={blocked}
                            >
                              {kind === 'regen' ? '处理中…' : '重置密码'}
                            </Btn>
                            <Btn
                              size="sm"
                              className="lm-account-act is-danger"
                              onClick={() => removeRow(row)}
                              disabled={blocked}
                            >
                              {kind === 'del' ? '处理中…' : '删除'}
                            </Btn>
                          </div>

                          <div className="lm-account-meta">
                            <span className="lm-account-meta-k">密码</span>
                            <code className={`lm-account-meta-v is-mono${row.key_masked ? '' : ' is-dim'}`}>
                              {row.key_masked || '—'}
                            </code>
                            <span className="lm-account-meta-dot" aria-hidden="true">
                              ·
                            </span>
                            <span className="lm-account-meta-k">最近登录</span>
                            <span
                              className={`lm-account-meta-v${row.last_seen_at ? '' : ' is-dim'}`}
                              title={
                                row.last_seen_at ? fmtDateTime(row.last_seen_at) : `这个${cfg.nameTip}还没登录过`
                              }
                            >
                              {seenText}
                            </span>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                ) : null}

                {secret ? (
                  <div className="lm-account-secret" ref={secretRef} role="status">
                    <div className="lm-account-secret-head">
                      <Eyebrow>NEW KEY · 只显示这一次</Eyebrow>
                      <span className="lm-account-secret-name">{secret.name}</span>
                    </div>
                    <p className="lm-account-secret-tip">{`把下面这串密码发给${secret.name}，只显示这一次`}</p>
                    <div className="lm-account-secret-row">
                      <code className="lm-account-secret-key">{secret.key}</code>
                      <CopyBtn text={secret.key} label="复制" />
                    </div>
                    <div className="lm-account-secret-foot">
                      <Btn variant="amber" size="sm" onClick={() => setSecret(null)}>
                        我已记下
                      </Btn>
                    </div>
                  </div>
                ) : null}

                {opErr ? (
                  <p className="lm-account-msg is-err" role="alert">
                    {opErr}
                  </p>
                ) : null}

                {opOk.text ? (
                  <p className="lm-account-msg is-ok" role="status">
                    {opOk.text}
                  </p>
                ) : null}

                {canCreate ? (
                  <>
                    <div className="lm-account-add">
                      <div className="lm-account-field">
                        <label className="lm-account-label" htmlFor={cfg.inputId}>
                          {cfg.nameLabel}
                        </label>
                        <input
                          id={cfg.inputId}
                          className="lm-account-input"
                          type="text"
                          value={name}
                          autoComplete="off"
                          spellCheck="false"
                          maxLength={24}
                          placeholder={cfg.placeholder}
                          disabled={creating}
                          onChange={(e) => setName(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && canAdd) submitCreate()
                          }}
                        />
                      </div>
                      <Btn
                        variant="primary"
                        className="lm-account-addbtn"
                        onClick={submitCreate}
                        disabled={!canAdd}
                      >
                        {creating ? cfg.adding : cfg.addLabel}
                      </Btn>
                    </div>
                    <p className="lm-account-hint">
                      添加后会显示一次密码，复制发给本人；之后这里只看得到掩码。
                    </p>
                  </>
                ) : null}
              </section>
            </>
          ) : null}
        </div>

        <footer className="lm-counselor-set-foot">
          <Btn onClick={() => onClose && onClose()} className="lm-counselor-set-btn">
            关闭
          </Btn>
        </footer>
      </div>
    </div>
  )
}
