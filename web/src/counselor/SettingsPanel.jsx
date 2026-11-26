/* 设置面板：访问密码 + DeepSeek API 配置 + 发件邮箱 + 账号管理（按角色），仅本机生效。
   覆盖式模态；数据全部走 lib/api.js，页面不自己 fetch。
   所有错误只在面板里显示成红字：不 alert、不白屏、不掉线（confirm 除外）。
   账号段按 /api/me 的 role 分三种：owner 管辅导员、counselor 管自己的助理、assistant 整段不显示。 */

import React, { useEffect, useRef, useState } from 'react'
import {
  changeCounselorKey,
  clearMyEmail,
  createStaff,
  deleteStaff,
  getMe,
  getMyEmail,
  getSettings,
  listStaff,
  setMyEmail,
  testAiConnection,
  updateSettings,
  updateStaff
} from '../lib/api.js'
import { errText, fmtDateTime, fmtRel } from './helpers.js'
import { Btn, CopyBtn, ErrBar, Eyebrow, Skel } from './ui.jsx'

const PW_MIN = 6
const EMPTY_MSG = { tone: '', text: '' }
/* 401 时先让人读完面板里的提示，再回门口；想改成一检测到就锁，把这个值调成 0 即可 */
const AUTH_LOCK_DELAY_MS = 900

/* 判断「本机存的账号密码已经不管用」：先看 api.js 抛出的状态码，只有文案时才看词。
   AI 侧的报错里常出现 Key / api_key / model，先排掉这些词，
   免得把「API Key 无效」误判成「访问密码失效」把人踢回门口。 */
const AI_WORDS = /api[ _-]?key|deepseek|base\s*url|模型|网络|超时/i
const AUTH_WORDS = /401|403|unauthoriz|forbidden|访问密码|未授权|口令|counselor/i

function isSessionAuthError(e) {
  /* 新接口的 401/403 只带一句中文（「账号或密码不对」），先看状态码 */
  const status = Number(e && e.status)
  if (status === 401 || status === 403) return true
  const m = String((e && e.message) || '')
  if (!m) return false
  if (AI_WORDS.test(m)) return false
  return AUTH_WORDS.test(m)
}

/* 测试连接的回复可能有几百字，面板里只露前一小段，别把卡片撑爆 */
function shortReply(reply) {
  const s = reply === null || reply === undefined ? '' : String(reply).replace(/\s+/g, ' ').trim()
  if (!s) return '（空回复）'
  return s.length > 120 ? `${s.slice(0, 120)}…` : s
}

export default function SettingsPanel({ open, onClose, onLock }) {
  /* 远端配置：{ counselor_key_custom, ai, defaults } */
  const [meta, setMeta] = useState(null)
  const [loading, setLoading] = useState(false)
  const [loadErr, setLoadErr] = useState('')
  /* 密码被改过（401）时的提示：先让人看见，再回门口 */
  const [authMsg, setAuthMsg] = useState('')

  /* 访问密码 */
  const [cur, setCur] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [pwBusy, setPwBusy] = useState(false)
  const [pwMsg, setPwMsg] = useState(EMPTY_MSG)

  /* DeepSeek 配置 */
  const [apiKey, setApiKey] = useState('')
  const [clearKey, setClearKey] = useState(false)
  const [baseUrl, setBaseUrl] = useState('')
  const [model, setModel] = useState('')
  const [aiBusy, setAiBusy] = useState('') /* '' | 'test' | 'save' */
  const [aiMsg, setAiMsg] = useState(EMPTY_MSG)

  /* 当前账号：role 决定「账号」段是管辅导员还是管助理 */
  const [me, setMe] = useState(null)
  const [meLoading, setMeLoading] = useState(false)
  const [meErr, setMeErr] = useState('')

  /* owner 改的是「访问密码」（总管密码），其它角色改的是自己账号的登录密码。
     me 还没读回来时按 owner 处理：能打开这个面板的本来就是总管。 */
  const pwOwner = !me || me.role === 'owner'

  const panelRef = useRef(null)
  const closeRef = useRef(null)
  const lockTimer = useRef(null)
  /* 每次读取递增：旧请求晚回来时不覆盖新结果（快速开关面板时会遇到） */
  const reqSeq = useRef(0)
  const meSeq = useRef(0)

  useEffect(() => () => clearTimeout(lockTimer.current), [])

  /* 401：面板里留一句人话，稍后回门口。别立刻 onLock，否则提示一闪就没了。 */
  function lockSoon() {
    setAuthMsg('访问密码已变化，请重新进入')
    clearTimeout(lockTimer.current)
    lockTimer.current = setTimeout(() => {
      if (onLock) onLock()
    }, AUTH_LOCK_DELAY_MS)
  }

  /* 用服务端返回刷新本地展示：掩码 Key、回落后的 base_url / model 都以服务端为准 */
  function applySettings(d) {
    const p = meta || {}
    const ai = (d && d.ai) || p.ai || {}
    const defaults = (d && d.defaults) || p.defaults || {}
    const custom =
      d && typeof d.counselor_key_custom === 'boolean'
        ? d.counselor_key_custom
        : Boolean(p.counselorKeyCustom)
    // security 也要带上，否则「加密状态」那行永远不显示
    const security = (d && d.security) || p.security || null
    setMeta({ ai, defaults, counselorKeyCustom: custom, security })
    setBaseUrl(ai.base_url || '')
    setModel(ai.model || '')
    setApiKey('')
    setClearKey(false)
  }

  /* 拉一次最新配置；手动「重试」也走这里 */
  async function fetchSettings() {
    const seq = ++reqSeq.current
    setLoading(true)
    setLoadErr('')
    try {
      const d = await getSettings()
      if (seq !== reqSeq.current) return
      applySettings(d)
    } catch (e) {
      if (seq !== reqSeq.current) return
      if (isSessionAuthError(e)) lockSoon()
      else setLoadErr(errText(e))
    } finally {
      if (seq === reqSeq.current) setLoading(false)
    }
  }

  /* 问一次「我是谁」：拿到 role 才能决定账号段的标题和权限范围 */
  async function fetchMe() {
    const seq = ++meSeq.current
    setMeLoading(true)
    setMeErr('')
    try {
      const d = await getMe()
      if (seq !== meSeq.current) return
      setMe(d && typeof d === 'object' ? d : null)
    } catch (e) {
      if (seq !== meSeq.current) return
      if (isSessionAuthError(e)) lockSoon()
      else setMeErr(errText(e))
    } finally {
      if (seq === meSeq.current) setMeLoading(false)
    }
  }

  /* 每次打开都重置成本地干净状态，再拉一次最新配置 */
  useEffect(() => {
    if (!open) return undefined

    setMeta(null)
    setLoading(true)
    setLoadErr('')
    setAuthMsg('')
    setCur('')
    setNext('')
    setConfirm('')
    setPwBusy(false)
    setPwMsg(EMPTY_MSG)
    setApiKey('')
    setClearKey(false)
    setBaseUrl('')
    setModel('')
    setAiBusy('')
    setAiMsg(EMPTY_MSG)
    setMe(null)
    setMeLoading(true)
    setMeErr('')
    clearTimeout(lockTimer.current)

    fetchSettings()
    fetchMe()

    return () => {
      /* 关掉/卸载时把这次读取作废，回来的结果不再落到面板上 */
      reqSeq.current += 1
      meSeq.current += 1
      clearTimeout(lockTimer.current)
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

  /* 初始焦点放在关闭按钮上，键盘用户不至于从页脚开始 Tab */
  useEffect(() => {
    if (!open) return undefined
    const t = setTimeout(() => closeRef.current?.focus(), 40)
    return () => clearTimeout(t)
  }, [open])

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

  /* 点遮罩关闭：只认遮罩本身，点面板内部不关 */
  function onOverlayDown(e) {
    if (e.target === e.currentTarget && onClose) onClose()
  }

  /* ---------- 访问密码 ---------- */

  const tooShort = next.length > 0 && next.length < PW_MIN
  const mismatch = confirm.length > 0 && next !== confirm
  const sameAsOld = next.length > 0 && next === cur
  const pwReady =
    cur.length > 0 &&
    next.length > 0 &&
    confirm.length > 0 &&
    !tooShort &&
    !mismatch &&
    !sameAsOld &&
    !pwBusy

  async function submitPassword() {
    if (!pwReady) return
    setPwBusy(true)
    setPwMsg(EMPTY_MSG)
    try {
      /* 总管走 /api/auth/change-key，其它账号走 PATCH /api/staff/me/password；
         api.js 按这个布尔值分流，不传时由它按本机用户名兜底 */
      await changeCounselorKey(cur, next, pwOwner)
      setPwMsg({ tone: 'ok', text: '已修改。下次登录请用新密码。' })
      setCur('')
      setNext('')
      setConfirm('')
      if (pwOwner) setMeta((m) => (m ? { ...m, counselorKeyCustom: true } : m))
      /* 本机那份密码由 api.js 的 changeCounselorKey 自己换成新的，所以不会掉线；
         这里不碰 localStorage，也不 onLock。 */
    } catch (e) {
      setPwMsg({ tone: 'err', text: errText(e) })
    } finally {
      setPwBusy(false)
    }
  }

  /* ---------- DeepSeek 配置 ---------- */

  async function runTest() {
    if (aiBusy) return
    setAiBusy('test')
    setAiMsg(EMPTY_MSG)
    try {
      const r = await testAiConnection()
      if (!r || r.ok === false) {
        setAiMsg({ tone: 'err', text: (r && r.error) || '连接失败，检查 Key、Base URL 和网络' })
        return
      }
      const ms = Number(r.ms) || 0
      setAiMsg({
        tone: 'ok',
        text: `连接正常 · ${r.model || '未知模型'} · ${ms}ms · 回复：${shortReply(r.reply)}`
      })
    } catch (e) {
      if (isSessionAuthError(e)) {
        lockSoon()
        return
      }
      setAiMsg({ tone: 'err', text: errText(e) })
    } finally {
      setAiBusy('')
    }
  }

  async function saveAi() {
    if (aiBusy) return
    /* 留空 = 不修改 Key；要清空必须显式点「清除」。Base URL / Model 留空传空串，服务端回落默认。 */
    const patch = { base_url: baseUrl.trim(), model: model.trim() }
    if (apiKey.trim()) patch.api_key = apiKey.trim()
    else if (clearKey) patch.api_key = ''

    setAiBusy('save')
    setAiMsg(EMPTY_MSG)
    try {
      const r = await updateSettings(patch)
      if (r && r.ok === false) {
        setAiMsg({ tone: 'err', text: r.error || '保存失败，再试一次' })
        return
      }
      applySettings(r)
      setAiMsg({ tone: 'ok', text: '已保存并生效' })
    } catch (e) {
      if (isSessionAuthError(e)) {
        lockSoon()
        return
      }
      setAiMsg({ tone: 'err', text: errText(e) })
    } finally {
      setAiBusy('')
    }
  }

  if (!open) return null

  const ai = (meta && meta.ai) || {}
  const defaults = (meta && meta.defaults) || {}
  const keySet = Boolean(ai.api_key_set)
  const masked = ai.api_key_masked ? String(ai.api_key_masked) : ''
  const custom = Boolean(meta && meta.counselorKeyCustom)
  const keyPlaceholder = clearKey ? '保存后清空，先不填' : keySet ? masked || '••••••••' : '还没配置'
  // 加密状态：让人能一眼确认「Key 是密文存的、主密钥来自哪里」
  const sec = (meta && meta.security) || null
  const secSource =
    sec?.secret_source === 'env' ? '环境变量（推荐）' : sec?.secret_source === 'file' ? '本地文件 data/.secret' : '未配置'
  const secBroken = Array.isArray(sec?.broken) && sec.broken.length > 0

  return (
    <div className="lm-counselor-set-overlay" role="presentation" onMouseDown={onOverlayDown}>
      <div
        className="lm-counselor-set-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="lm-set-title"
        ref={panelRef}
        tabIndex={-1}
        onKeyDown={onPanelKeyDown}
      >
        <header className="lm-counselor-set-head">
          <div className="lm-counselor-set-headtext">
            <Eyebrow>SETTINGS · 仅本机生效</Eyebrow>
            <h2 className="lm-counselor-set-title" id="lm-set-title">
              设置
            </h2>
          </div>
          <button
            type="button"
            className="lm-counselor-set-x"
            ref={closeRef}
            onClick={() => onClose && onClose()}
            title="关闭"
            aria-label="关闭设置"
          >
            ×
          </button>
        </header>

        <div className="lm-counselor-set-body">
          {authMsg ? (
            <p className="lm-counselor-set-msg is-err is-top" role="alert">
              {authMsg}
            </p>
          ) : null}

          {!loadErr && (loading || !meta) ? (
            <div className="lm-counselor-set-loading">
              <Eyebrow>READING · 读取中…</Eyebrow>
              <Skel rows={4} />
            </div>
          ) : null}

          {loadErr ? <ErrBar message={loadErr} onRetry={fetchSettings} retryLabel="重试" /> : null}

          {meta ? (
            <>
              {/* ---------- 1. 密码 ---------- */}
              <section className="lm-counselor-set-sec">
                <div className="lm-counselor-set-sec-head">
                  <Eyebrow>{pwOwner ? 'ACCESS · 访问密码' : 'ACCESS · 登录密码'}</Eyebrow>
                  {pwOwner ? (
                    <span className={`lm-counselor-set-badge${custom ? ' is-on' : ''}`}>
                      {custom ? '已自定义' : '默认密码'}
                    </span>
                  ) : null}
                </div>
                <p className="lm-counselor-set-desc">
                  {pwOwner
                    ? '总管密码，改完立即生效。已经打开的页面，下一次请求会要求重新输入。'
                    : '改的是你自己账号的登录密码，改完立即生效，下次登录用新密码。'}
                </p>

                <div className="lm-counselor-set-field">
                  <div className="lm-counselor-set-labelrow">
                    <label className="lm-counselor-set-label" htmlFor="lm-set-pw-cur">
                      当前密码
                    </label>
                  </div>
                  <input
                    id="lm-set-pw-cur"
                    className="lm-counselor-set-input"
                    type="password"
                    value={cur}
                    autoComplete="current-password"
                    placeholder="••••••••"
                    disabled={pwBusy}
                    onChange={(e) => setCur(e.target.value)}
                  />
                </div>

                <div className="lm-counselor-set-field">
                  <div className="lm-counselor-set-labelrow">
                    <label className="lm-counselor-set-label" htmlFor="lm-set-pw-new">
                      新密码
                    </label>
                    <span className="lm-counselor-set-mini">≥ {PW_MIN} 位</span>
                  </div>
                  <input
                    id="lm-set-pw-new"
                    className="lm-counselor-set-input"
                    type="password"
                    value={next}
                    autoComplete="new-password"
                    placeholder={`至少 ${PW_MIN} 位`}
                    disabled={pwBusy}
                    onChange={(e) => setNext(e.target.value)}
                  />
                </div>

                <div className="lm-counselor-set-field">
                  <div className="lm-counselor-set-labelrow">
                    <label className="lm-counselor-set-label" htmlFor="lm-set-pw-confirm">
                      再输一次
                    </label>
                  </div>
                  <input
                    id="lm-set-pw-confirm"
                    className="lm-counselor-set-input"
                    type="password"
                    value={confirm}
                    autoComplete="new-password"
                    placeholder="再输一次新密码"
                    disabled={pwBusy}
                    onChange={(e) => setConfirm(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && pwReady) submitPassword()
                    }}
                  />
                </div>

                {mismatch ? (
                  <p className="lm-counselor-set-hint is-err">两次输入不一致</p>
                ) : tooShort ? (
                  <p className="lm-counselor-set-hint is-err">至少 {PW_MIN} 位</p>
                ) : sameAsOld ? (
                  <p className="lm-counselor-set-hint is-err">新密码不能和当前密码一样</p>
                ) : null}

                {pwMsg.text ? (
                  <p
                    className={`lm-counselor-set-msg is-${pwMsg.tone}`}
                    role={pwMsg.tone === 'err' ? 'alert' : 'status'}
                  >
                    {pwMsg.text}
                  </p>
                ) : null}

                <div className="lm-counselor-set-actions">
                  <Btn
                    variant="primary"
                    onClick={submitPassword}
                    disabled={!pwReady}
                    className="lm-counselor-set-btn"
                  >
                    {pwBusy ? '正在修改…' : pwOwner ? '修改访问密码' : '修改我的密码'}
                  </Btn>
                </div>
              </section>

              {/* ---------- 2. DeepSeek API ---------- */}
              <section className="lm-counselor-set-sec">
                <Eyebrow>DEEPSEEK · API 配置</Eyebrow>
                <p className="lm-counselor-set-desc">
                  解析与多语言翻译都走这个 Key。Key 只存服务端，这里只看到掩码。
                </p>

                {!keySet ? (
                  <div className="lm-counselor-set-warn">
                    <span className="lm-counselor-set-warn-mark">!</span>
                    <span>没配 API Key，AI 解析和翻译会降级成规则兜底</span>
                  </div>
                ) : null}

                <div className="lm-counselor-set-field">
                  <div className="lm-counselor-set-labelrow">
                    <label className="lm-counselor-set-label" htmlFor="lm-set-ak">
                      API Key
                    </label>
                    {keySet ? (
                      <button
                        type="button"
                        className="lm-counselor-set-clear"
                        onClick={() => setClearKey((v) => !v)}
                      >
                        {clearKey ? '撤销' : '清除'}
                      </button>
                    ) : null}
                  </div>
                  <input
                    id="lm-set-ak"
                    className="lm-counselor-set-input is-mono"
                    type="password"
                    value={apiKey}
                    autoComplete="off"
                    spellCheck="false"
                    placeholder={keyPlaceholder}
                    disabled={aiBusy === 'save'}
                    onChange={(e) => setApiKey(e.target.value)}
                  />
                  {clearKey ? (
                    <p className="lm-counselor-set-hint is-warn">保存后会清空已存的 Key（AI 会降级）</p>
                  ) : (
                    <p className="lm-counselor-set-hint">留空表示不改；要换 Key 直接填新的。</p>
                  )}
                  {sec ? (
                    <p className={`lm-counselor-set-hint${secBroken ? ' is-warn' : ''}`}>
                      {secBroken
                        ? '已加密的 Key 无法解密（SECRET_KEY 变了或数据目录被重置），请重新填写。'
                        : `${sec.encryption} 加密存储 · 主密钥来自${secSource}`}
                    </p>
                  ) : null}
                </div>

                <div className="lm-counselor-set-field">
                  <div className="lm-counselor-set-labelrow">
                    <label className="lm-counselor-set-label" htmlFor="lm-set-base">
                      Base URL
                    </label>
                  </div>
                  <input
                    id="lm-set-base"
                    className="lm-counselor-set-input is-mono"
                    type="text"
                    value={baseUrl}
                    autoComplete="off"
                    spellCheck="false"
                    placeholder={defaults.base_url || 'https://api.deepseek.com'}
                    disabled={aiBusy === 'save'}
                    onChange={(e) => setBaseUrl(e.target.value)}
                  />
                </div>

                <div className="lm-counselor-set-field">
                  <div className="lm-counselor-set-labelrow">
                    <label className="lm-counselor-set-label" htmlFor="lm-set-model">
                      Model
                    </label>
                  </div>
                  <input
                    id="lm-set-model"
                    className="lm-counselor-set-input is-mono"
                    type="text"
                    value={model}
                    autoComplete="off"
                    spellCheck="false"
                    placeholder={defaults.model || 'deepseek-chat'}
                    disabled={aiBusy === 'save'}
                    onChange={(e) => setModel(e.target.value)}
                  />
                  <p className="lm-counselor-set-hint">Base URL / Model 留空就用默认值。</p>
                </div>

                {aiMsg.text ? (
                  <p
                    className={`lm-counselor-set-msg is-${aiMsg.tone}`}
                    role={aiMsg.tone === 'err' ? 'alert' : 'status'}
                  >
                    {aiMsg.text}
                  </p>
                ) : null}

                <div className="lm-counselor-set-actions">
                  <Btn
                    onClick={runTest}
                    disabled={Boolean(aiBusy)}
                    className="lm-counselor-set-btn"
                  >
                    {aiBusy === 'test' ? '测试中…' : '测试连接'}
                  </Btn>
                  <Btn
                    variant="primary"
                    onClick={saveAi}
                    disabled={Boolean(aiBusy)}
                    className="lm-counselor-set-btn"
                  >
                    {aiBusy === 'save' ? '保存中…' : '保存'}
                  </Btn>
                </div>
                <p className="lm-counselor-set-hint">测试用的是已保存的配置：改完先保存，再测。</p>
              </section>

              {/* ---------- 3. 发件邮箱（所有角色都能绑自己的） ---------- */}
              <SenderSection open={open} onAuthError={lockSoon} />

              {/* ---------- 4. 账号管理：owner 管辅导员 / counselor 管助理 / assistant 整段隐藏 ---------- */}
              {meErr ? (
                <section className="lm-counselor-set-sec lm-staff-norole">
                  <Eyebrow>ACCOUNTS · 账号管理</Eyebrow>
                  <p className="lm-counselor-set-desc">没读到当前账号的角色，账号管理先不可用。</p>
                  <p className="lm-counselor-set-msg is-err" role="alert">
                    {meErr}
                  </p>
                  <div className="lm-counselor-set-actions">
                    <Btn onClick={fetchMe} disabled={meLoading} className="lm-counselor-set-btn">
                      {meLoading ? '重试中…' : '重试'}
                    </Btn>
                  </div>
                </section>
              ) : !me ? (
                <section className="lm-counselor-set-sec lm-staff-norole">
                  <Eyebrow>ACCOUNTS · 账号管理</Eyebrow>
                  <Skel rows={3} />
                </section>
              ) : me.role === 'owner' || me.role === 'counselor' ? (
                <StaffSection open={open} role={me.role} onAuthError={lockSoon} />
              ) : null /* assistant 或角色不明：没有管账号的权限，整段不显示 */}
            </>
          ) : null}
        </div>

        <footer className="lm-counselor-set-foot">
          <Btn onClick={() => onLock && onLock()} className="lm-counselor-set-btn">
            锁定工作台
          </Btn>
          <Btn variant="primary" onClick={() => onClose && onClose()} className="lm-counselor-set-btn">
            完成
          </Btn>
        </footer>
      </div>
    </div>
  )
}

/* ---------- 发件邮箱段（settings 面板里的第三段） ----------
   每个账号绑自己的发件邮箱：通知详情页的一键发信就用它。
   Key 只存服务端（加密），这一侧只看到掩码；留空表示不改。 */

const SENDER_PROVIDERS = [
  { id: 'smtp', label: 'SMTP', note: '学校服务器，465 / 587' },
  { id: 'resend', label: 'Resend', note: 'HTTP API，Railway 上用' }
]

/* 端口决定加密方式（服务端同样按端口判定）：465 直连 SSL，587 先明文再 STARTTLS */
const SMTP_PORT_SSL = 465
const SMTP_PORT_STARTTLS = 587

/* 服务端一般回掩码（a***@x.com）；万一回明文，本地也先掩一道再显示 */
function maskEmail(v) {
  const s = String(v || '').trim()
  if (!s) return ''
  if (s.includes('*')) return s
  const at = s.lastIndexOf('@')
  if (at <= 0) return s
  return `${s.slice(0, 1)}***${s.slice(at)}`
}

/* 只做「看着不对」的提示；真校验留给服务端，别在前端拦掉合法地址 */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function SenderSection({ open, onAuthError }) {
  /* 当前绑定：{ bound, address, provider, from } */
  const [cur, setCur] = useState(null)
  const [loading, setLoading] = useState(false)
  const [loadErr, setLoadErr] = useState('')

  const [email, setEmail] = useState('')
  const [provider, setProvider] = useState('smtp')
  const [apiKey, setApiKey] = useState('')
  /* SMTP 配置：主机 / 端口 / 加密方式 / 用户名 / 密码或授权码 */
  const [smtpHost, setSmtpHost] = useState('')
  const [smtpPort, setSmtpPort] = useState(String(SMTP_PORT_SSL))
  const [smtpSecure, setSmtpSecure] = useState(true)
  const [smtpUser, setSmtpUser] = useState('')
  const [smtpPass, setSmtpPass] = useState('')
  const [busy, setBusy] = useState('') /* '' | 'save' | 'clear' */
  const [msg, setMsg] = useState(EMPTY_MSG)

  /* 每次读取递增：关掉面板后晚回来的结果不落到表单上 */
  const seqRef = useRef(0)

  /* 服务端回来的绑定状态统一在这儿落地：表单跟着新状态重置。
     SMTP 只回掩码（主机/端口/加密方式/掩码用户名），密码永远读不回来。 */
  function applyEmail(d) {
    const e = d && typeof d === 'object' ? d : {}
    const s = e.smtp && typeof e.smtp === 'object' ? e.smtp : null
    const next = {
      bound: Boolean(e.bound),
      address: String(e.address || e.address_masked || ''),
      provider: e.provider ? String(e.provider) : '',
      from: e.from ? String(e.from) : '',
      smtp: s
        ? {
            host: String(s.host || ''),
            port: s.port ? String(s.port) : '',
            secure: Boolean(s.secure),
            user_masked: String(s.user_masked || '')
          }
        : null
    }
    setCur(next)
    setEmail('')
    setApiKey('')
    setProvider(next.provider === 'resend' ? 'resend' : 'smtp')
    setSmtpHost(next.smtp ? next.smtp.host : '')
    setSmtpPort(next.smtp && next.smtp.port ? next.smtp.port : String(SMTP_PORT_SSL))
    setSmtpSecure(next.smtp ? Boolean(next.smtp.secure) : true)
    setSmtpUser('')
    setSmtpPass('')
    return next
  }

  async function fetchEmail() {
    const seq = ++seqRef.current
    setLoading(true)
    setLoadErr('')
    setMsg(EMPTY_MSG)
    try {
      const d = await getMyEmail()
      if (seq !== seqRef.current) return
      applyEmail(d)
    } catch (e) {
      if (seq !== seqRef.current) return
      if (isSessionAuthError(e)) onAuthError()
      else setLoadErr(errText(e))
    } finally {
      if (seq === seqRef.current) setLoading(false)
    }
  }

  useEffect(() => {
    if (!open) return undefined
    setCur(null)
    setEmail('')
    setApiKey('')
    setProvider('smtp')
    setSmtpHost('')
    setSmtpPort(String(SMTP_PORT_SSL))
    setSmtpSecure(true)
    setSmtpUser('')
    setSmtpPass('')
    setBusy('')
    setMsg(EMPTY_MSG)
    fetchEmail()
    return () => {
      seqRef.current += 1
    }
  }, [open])

  const bound = Boolean(cur && cur.bound)
  const curProvider = bound ? cur.provider || '' : ''
  const curSmtp = bound && curProvider === 'smtp' ? (cur && cur.smtp) || null : null
  /* 已绑 SMTP 时，密码/用户名留空＝沿用已保存的那份；首次绑定必须填全 */
  const smtpFirstBind = provider === 'smtp' && !(bound && curProvider === 'smtp')
  const smtpHostOk = Boolean(smtpHost.trim())
  const smtpPortNum = Number(smtpPort)
  const smtpPortOk = Number.isInteger(smtpPortNum) && smtpPortNum >= 1 && smtpPortNum <= 65535
  const smtpUserMissing = smtpFirstBind && !smtpUser.trim()
  const smtpPassMissing = smtpFirstBind && !smtpPass
  const smtpBad = provider === 'smtp' && (!smtpHostOk || !smtpPortOk || smtpUserMissing || smtpPassMissing)
  /* 一开始不要满屏黄字：动过表单再提示缺什么 */
  const smtpDirty = Boolean(email.trim() || smtpHost.trim() || smtpUser.trim() || smtpPass)

  const addr = email.trim()
  const emailOk = EMAIL_RE.test(addr)
  const emailBad = Boolean(addr) && !emailOk
  /* 换地址 / 换通道都要重填一次：服务端只存掩码，读不回明文 */
  const keyNeeded = provider === 'resend' && !(bound && curProvider === 'resend')
  const keyMissing = keyNeeded && !apiKey.trim()
  const formBusy = Boolean(busy)
  const canSave = emailOk && !keyMissing && !smtpBad && !formBusy

  /* 选 SSL / STARTTLS 时同时把端口改过去；手改端口也同步加密方式 */
  function pickTls(secure) {
    setSmtpSecure(secure)
    setSmtpPort(String(secure ? SMTP_PORT_SSL : SMTP_PORT_STARTTLS))
  }

  function onPortChange(v) {
    const t = String(v || '').trim()
    setSmtpPort(t)
    if (Number(t) === SMTP_PORT_SSL) setSmtpSecure(true)
    else if (Number(t) === SMTP_PORT_STARTTLS) setSmtpSecure(false)
  }

  async function save() {
    if (!canSave) return
    setBusy('save')
    setMsg(EMPTY_MSG)
    try {
      const body = { email: addr, provider }
      if (provider === 'resend') {
        if (apiKey.trim()) body.api_key = apiKey.trim()
      } else {
        body.smtp = {
          host: smtpHost.trim(),
          port: smtpPortNum,
          secure: smtpSecure,
          user: smtpUser.trim()
        }
        // 留空＝不改已保存的密码；首次绑定前面已经拦下来了
        if (smtpPass) body.smtp.pass = smtpPass
      }
      if (cur && cur.from) body.from = cur.from
      const r = await setMyEmail(body)
      if (r && r.ok === false) {
        setMsg({ tone: 'err', text: r.error || '保存失败，再试一次' })
        return
      }
      const srv = r && r.email && typeof r.email === 'object' ? r.email : {}
      const keptSmtp = provider === 'smtp' ? (srv.smtp || cur?.smtp || null) : null
      applyEmail({
        bound: srv.bound === undefined ? true : srv.bound,
        address: srv.address || srv.address_masked || maskEmail(addr),
        provider: srv.provider || provider,
        from: srv.from || (cur && cur.from) || '',
        smtp: keptSmtp
      })
      setMsg({
        tone: 'ok',
        text:
          provider === 'smtp'
            ? '已保存，通知详情页可以一键发到学生邮箱（SMTP）'
            : '已保存，通知详情页可以一键发到学生邮箱（Resend）'
      })
    } catch (e) {
      if (isSessionAuthError(e)) {
        onAuthError()
        return
      }
      setMsg({ tone: 'err', text: errText(e) })
    } finally {
      setBusy('')
    }
  }

  async function clear() {
    if (formBusy || !bound) return
    if (!window.confirm('清除发件邮箱？之后一键发信会先要求重新绑定。')) return
    setBusy('clear')
    setMsg(EMPTY_MSG)
    try {
      const r = await clearMyEmail()
      if (r && r.ok === false) {
        setMsg({ tone: 'err', text: r.error || '清除失败，再试一次' })
        return
      }
      applyEmail({ bound: false })
      setMsg({ tone: 'ok', text: '已清除发件邮箱' })
    } catch (e) {
      if (isSessionAuthError(e)) {
        onAuthError()
        return
      }
      setMsg({ tone: 'err', text: errText(e) })
    } finally {
      setBusy('')
    }
  }

  const shown = bound
    ? `${maskEmail(cur.address) || '已绑定'}${curProvider ? ` · ${curProvider === 'smtp' ? 'SMTP' : 'Resend'}` : ''}`
    : '未绑定'

  return (
    <section className="lm-counselor-set-sec lm-sender" aria-label="发件邮箱">
      <div className="lm-counselor-set-sec-head">
        <Eyebrow>SENDER · 发件邮箱</Eyebrow>
        <span className={`lm-counselor-set-badge${bound ? ' is-on' : ''}`}>
          {bound ? '已绑定' : '未绑定'}
        </span>
      </div>
      <p className="lm-counselor-set-desc">
        同一份通知可以一键发到学生邮箱。学校服务器用 SMTP；Railway 封禁出站 SMTP，那边只能用 Resend。
      </p>

      <div className="lm-sender-cur">
        <span className={`lm-sender-dot${bound ? ' is-on' : ''}`} aria-hidden="true" />
        <code className={`lm-sender-addr${bound ? '' : ' is-dim'}`}>{shown}</code>
      </div>

      {loadErr ? (
        <div className="lm-sender-loaderr">
          <p className="lm-counselor-set-msg is-err" role="alert">
            {loadErr}
          </p>
          <Btn size="sm" onClick={fetchEmail} disabled={loading}>
            {loading ? '重试中…' : '重试'}
          </Btn>
        </div>
      ) : null}

      {!loadErr && !cur && loading ? <Skel rows={3} /> : null}

      {cur ? (
        <>
          <div className="lm-counselor-set-field">
            <div className="lm-counselor-set-labelrow">
              <label className="lm-counselor-set-label" htmlFor="lm-set-sender-email">
                发件邮箱
              </label>
              {bound ? <span className="lm-counselor-set-mini">要改就重填一次</span> : null}
            </div>
            <input
              id="lm-set-sender-email"
              className="lm-counselor-set-input is-mono"
              type="email"
              value={email}
              autoComplete="off"
              spellCheck="false"
              placeholder={bound ? '换地址或换通道时填一次' : 'you@example.com'}
              disabled={formBusy}
              onChange={(e) => setEmail(e.target.value)}
            />
            {emailBad ? <p className="lm-counselor-set-hint is-err">邮箱格式看着不对</p> : null}
          </div>

          <div className="lm-counselor-set-field">
            <div className="lm-counselor-set-labelrow">
              <span className="lm-counselor-set-label">通道</span>
            </div>
            <div className="lm-sender-opts" role="radiogroup" aria-label="发信通道">
              {SENDER_PROVIDERS.map((p) => {
                const on = provider === p.id
                return (
                  <button
                    key={p.id}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    className={`lm-sender-opt${on ? ' is-on' : ''}`}
                    disabled={formBusy}
                    onClick={() => setProvider(p.id)}
                  >
                    <span className="lm-sender-opt-k">{p.label}</span>
                    <span className="lm-sender-opt-n">{p.note}</span>
                  </button>
                )
              })}
            </div>
          </div>

          {provider === 'smtp' ? (
            <>
              <div className="lm-counselor-set-field">
                <div className="lm-smtp-grid">
                  <div className="lm-counselor-set-field">
                    <div className="lm-counselor-set-labelrow">
                      <label className="lm-counselor-set-label" htmlFor="lm-set-smtp-host">
                        SMTP 主机
                      </label>
                    </div>
                    <input
                      id="lm-set-smtp-host"
                      className="lm-counselor-set-input is-mono"
                      value={smtpHost}
                      autoComplete="off"
                      spellCheck="false"
                      placeholder="smtp.university.edu.cn"
                      disabled={formBusy}
                      onChange={(e) => setSmtpHost(e.target.value)}
                    />
                  </div>
                  <div className="lm-counselor-set-field">
                    <div className="lm-counselor-set-labelrow">
                      <label className="lm-counselor-set-label" htmlFor="lm-set-smtp-port">
                        端口
                      </label>
                    </div>
                    <input
                      id="lm-set-smtp-port"
                      className="lm-counselor-set-input is-mono"
                      inputMode="numeric"
                      value={smtpPort}
                      autoComplete="off"
                      spellCheck="false"
                      placeholder="465"
                      disabled={formBusy}
                      onChange={(e) => onPortChange(e.target.value)}
                    />
                  </div>
                </div>
                {provider === 'smtp' && !smtpPortOk ? (
                  <p className="lm-counselor-set-hint is-err">端口要是 1–65535 之间的数字</p>
                ) : null}
              </div>

              <div className="lm-counselor-set-field">
                <div className="lm-counselor-set-labelrow">
                  <span className="lm-counselor-set-label">加密方式</span>
                </div>
                <div className="lm-sender-opts" role="radiogroup" aria-label="SMTP 加密方式">
                  <button
                    type="button"
                    role="radio"
                    aria-checked={smtpSecure}
                    className={`lm-sender-opt${smtpSecure ? ' is-on' : ''}`}
                    disabled={formBusy}
                    onClick={() => pickTls(true)}
                  >
                    <span className="lm-sender-opt-k">465 · SSL</span>
                    <span className="lm-sender-opt-n">直连加密，选它自动填 465</span>
                  </button>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={!smtpSecure}
                    className={`lm-sender-opt${!smtpSecure ? ' is-on' : ''}`}
                    disabled={formBusy}
                    onClick={() => pickTls(false)}
                  >
                    <span className="lm-sender-opt-k">587 · STARTTLS</span>
                    <span className="lm-sender-opt-n">先明文再升级，选它自动填 587</span>
                  </button>
                </div>
              </div>

              <div className="lm-counselor-set-field">
                <div className="lm-counselor-set-labelrow">
                  <label className="lm-counselor-set-label" htmlFor="lm-set-smtp-user">
                    用户名
                  </label>
                  {curSmtp ? <span className="lm-counselor-set-mini">已保存，留空=不改</span> : null}
                </div>
                <input
                  id="lm-set-smtp-user"
                  className="lm-counselor-set-input is-mono"
                  value={smtpUser}
                  autoComplete="off"
                  spellCheck="false"
                  placeholder={curSmtp?.user_masked ? `留空沿用 ${curSmtp.user_masked}` : 'notice@university.edu.cn'}
                  disabled={formBusy}
                  onChange={(e) => setSmtpUser(e.target.value)}
                />
                {smtpUserMissing && smtpDirty ? (
                  <p className="lm-counselor-set-hint is-warn">第一次配 SMTP 要填用户名</p>
                ) : null}
              </div>

              <div className="lm-counselor-set-field">
                <div className="lm-counselor-set-labelrow">
                  <label className="lm-counselor-set-label" htmlFor="lm-set-smtp-pass">
                    密码或授权码
                  </label>
                  {curSmtp ? <span className="lm-counselor-set-mini">已保存，留空=不改</span> : null}
                </div>
                <input
                  id="lm-set-smtp-pass"
                  className="lm-counselor-set-input is-mono"
                  type="password"
                  value={smtpPass}
                  autoComplete="new-password"
                  spellCheck="false"
                  placeholder={curSmtp ? '留空不改' : '学校邮箱的 SMTP 授权码'}
                  disabled={formBusy}
                  onChange={(e) => setSmtpPass(e.target.value)}
                />
                <p className="lm-counselor-set-hint">
                  密码只存服务端（加密），这里看不到明文；留空表示不改。很多学校邮箱要用「授权码」而不是登录密码。
                </p>
                {smtpPassMissing && smtpDirty ? (
                  <p className="lm-counselor-set-hint is-warn">第一次配 SMTP 要填密码或授权码</p>
                ) : null}
              </div>
            </>
          ) : (
            <div className="lm-counselor-set-field">
              <div className="lm-counselor-set-labelrow">
                <label className="lm-counselor-set-label" htmlFor="lm-set-sender-key">
                  API Key
                </label>
                {bound && curProvider === 'resend' ? (
                  <span className="lm-counselor-set-mini">已保存，留空=不改</span>
                ) : null}
              </div>
              <input
                id="lm-set-sender-key"
                className="lm-counselor-set-input is-mono"
                type="password"
                value={apiKey}
                autoComplete="off"
                spellCheck="false"
                placeholder={bound && curProvider === 'resend' ? '留空不改' : 're_…'}
                disabled={formBusy}
                onChange={(e) => setApiKey(e.target.value)}
              />
              <p className="lm-counselor-set-hint">Key 只存服务端（加密），这里看不到明文；留空表示不改。</p>
              {keyMissing ? (
                <p className="lm-counselor-set-hint is-warn">走 Resend 要先填 API Key</p>
              ) : null}
            </div>
          )}

          {msg.text ? (
            <p
              className={`lm-counselor-set-msg is-${msg.tone}`}
              role={msg.tone === 'err' ? 'alert' : 'status'}
            >
              {msg.text}
            </p>
          ) : null}

          <div className="lm-counselor-set-actions">
            <Btn
              variant="primary"
              onClick={save}
              disabled={!canSave}
              className="lm-counselor-set-btn"
            >
              {busy === 'save' ? '保存中…' : '保存'}
            </Btn>
            <Btn
              onClick={clear}
              disabled={formBusy || !bound}
              className="lm-counselor-set-btn lm-sender-clear"
            >
              {busy === 'clear' ? '清除中…' : '清除'}
            </Btn>
          </div>

          <p className="lm-counselor-set-hint">
            {bound
              ? `已绑定 ${maskEmail(cur.address) || '这个账号'}；换地址或换通道要把发件邮箱重填一次。`
              : '填好发件邮箱和通道后保存，就能在通知详情页一键发信。'}
          </p>
        </>
      ) : null}
    </section>
  )
}

/* ---------- 账号段（settings 面板里的第四段，按角色变形） ----------
   owner 管辅导员、counselor 管自己的助理、assistant 整段不显示（由父组件拦）。
   一个账号 = 用户名 + 密码：发通知、催办按这个账号记在各自名下。
   新建时用户名由这里填、初始密码由服务端固定发 123456；重置密码仍由服务端随机生成，
   明文只在新建 / 重置时返回一次，之后列表里只有掩码，
   所以拿到就立刻摆进琥珀色框里让人复制，点「我已记下」才收起。 */

const STAFF_EMPTY = '还没有助理。助理能发通知、催办、导出回执，但改不了设置。'
const COUNSELOR_EMPTY = '还没有辅导员。辅导员能自己导入学生、发通知，只能看到自己名下的。'

/* 新建账号的初始密码：服务端固定发这个，前端只负责告诉人，不让填 */
const INITIAL_PASSWORD = '123456'

const ACCOUNT_CFG = {
  owner: {
    eyebrow: 'COUNSELORS · 辅导员账号',
    desc: '辅导员用自己的用户名和密码登录同一套工作台，学生、通知、回执都只在自己名下。总管能建、停用、重置和删除他们。',
    empty: COUNSELOR_EMPTY,
    addLabel: '添加辅导员',
    adding: '添加中…',
    usernameLabel: '用户名',
    inputId: 'lm-set-counselor-name',
    placeholder: '例如：李辅导员',
    countSuffix: '位辅导员',
    nameTip: '辅导员',
    subKey: '助理',
    delAsk: (n) => `删除辅导员「${n}」？删掉后这个账号立刻失效，他名下的学生和通知记录会留在系统里。`,
    hint: `用户名就是登录账号，可以用中文，最长 24 个字；初始密码固定 ${INITIAL_PASSWORD}，让对方首次登录后自己改。`,
    aria: '辅导员账号'
  },
  counselor: {
    eyebrow: 'STAFF · 助理账号',
    desc: '助理用自己的用户名和密码登录同一套工作台，发通知和催办会记在各自名下。他们看不到这一页的设置。',
    empty: STAFF_EMPTY,
    addLabel: '添加助理',
    adding: '添加中…',
    usernameLabel: '用户名',
    inputId: 'lm-set-staff-name',
    placeholder: '例如：王助理',
    countSuffix: '人',
    nameTip: '助理',
    subKey: '',
    delAsk: (n) => `删除助理「${n}」？删掉后这个账号立刻失效，他发过的通知记录会留在系统里。`,
    hint: `用户名就是登录账号，可以用中文，最长 24 个字；初始密码固定 ${INITIAL_PASSWORD}，让对方首次登录后自己改。`,
    aria: '助理账号'
  }
}

/* 服务端一般会给 key_masked；万一没给，本地按同一套规则兜一个，别把明文塞进列表。
   初始密码 123456 这类短密码一律显示成圆点，跟服务端 maskStaffKey 的规则对齐 */
function maskKey(key) {
  const s = String(key || '')
  if (!s) return ''
  if (s.length <= 6) return '••••••'
  return `${s.slice(0, 4)}…${s.slice(-4)}`
}

/* staff.active 在库里是 1/0（SQLite 没有布尔），接口也可能给 true/false */
function isActive(v) {
  return v === true || Number(v) === 1
}

/* 列表/新建/重置的返回体：v2 用 members / member，老后端用 staff，两边都认 */
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

function StaffSection({ open, role, onAuthError }) {
  const cfg = role === 'owner' ? ACCOUNT_CFG.owner : ACCOUNT_CFG.counselor
  const [rows, setRows] = useState([])
  const [loaded, setLoaded] = useState(false)
  const [loading, setLoading] = useState(false)
  const [loadErr, setLoadErr] = useState('')

  /* 新建 */
  const [username, setUsername] = useState('')
  const [creating, setCreating] = useState(false)

  /* 行内操作防重：{ id, kind: 'toggle' | 'regen' | 'del' } */
  const [busy, setBusy] = useState(null)
  const [opErr, setOpErr] = useState('')
  const [opOk, setOpOk] = useState('')

  /* 一次性账号信息：{ id, username, password } */
  const [secret, setSecret] = useState(null)

  /* 每次读取递增：关掉面板后晚回来的请求不落到列表上 */
  const seqRef = useRef(0)
  const secretRef = useRef(null)

  /* 拉一次列表；重试、新建异常兜底也走这里 */
  async function fetchStaff() {
    const seq = ++seqRef.current
    setLoading(true)
    setLoadErr('')
    try {
      const d = await listStaff()
      if (seq !== seqRef.current) return
      setRows(rowsOf(d))
      setLoaded(true)
    } catch (e) {
      if (seq !== seqRef.current) return
      if (isSessionAuthError(e)) onAuthError()
      else setLoadErr(errText(e))
    } finally {
      if (seq === seqRef.current) setLoading(false)
    }
  }

  /* 每次 open 变 true 都重新拉一次：名下成员可能在别的窗口里被加过、停用过。
     role 也进依赖：换账号（owner ↔ counselor）后列表要跟着换一份。 */
  useEffect(() => {
    if (!open) return undefined
    setRows([])
    setLoaded(false)
    setSecret(null)
    setOpErr('')
    setOpOk('')
    fetchStaff()
    return () => {
      seqRef.current += 1
    }
  }, [open, role])

  /* 新密码出现时把它滚进视野（滚动容器是面板的 body） */
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

  const blocked = creating || Boolean(busy)
  const canCreate = username.trim().length > 0 && !blocked

  /* 就地更新一行，不整页重拉 */
  function mergeRow(id, patch) {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...(patch || {}) } : r)))
  }

  /* 服务端把明文密码放在顶层 access_key，不在 staff 里。
     明文在手时掩码以明文为准：重置后列表不会残留旧掩码。 */
  function rowFrom(st, plainKey, fallbackName) {
    const row = { ...(st || {}) }
    if (plainKey) row.key_masked = maskKey(plainKey)
    if (fallbackName) {
      if (!row.name) row.name = fallbackName
      if (!row.username) row.username = fallbackName
    }
    return row
  }

  async function submitCreate() {
    const um = username.trim()
    if (!um || blocked) return
    setCreating(true)
    setOpErr('')
    setOpOk('')
    try {
      const r = await createStaff(um)
      const st = memberOf(r)
      /* 服务端把这一次的初始密码放在顶层 access_key；没回就按固定的 123456 展示 */
      const initial = String((r && r.access_key) || '') || INITIAL_PASSWORD
      if (!st || !st.id) {
        /* 建好了却没回成员对象：先刷新让人看到这一行，别让用户重复添加 */
        setOpErr(`服务端没返回账号信息，${cfg.nameTip}可能已经建好：列表已刷新，请核对`)
        setUsername('')
        await fetchStaff()
        return
      }
      const row = rowFrom(st, initial, um)
      const account = row.username || row.name || um
      /* 先剔掉同 id 的旧行，避免万一列表里已经有他时撞 key */
      setRows((prev) => [...prev.filter((x) => x.id !== row.id), row])
      setLoaded(true)
      setSecret({ id: row.id, username: account, password: initial })
      setOpOk(`账号已创建：${account}，初始密码 ${initial}，请让对方首次登录后自行修改`)
      setUsername('')
    } catch (e) {
      if (isSessionAuthError(e)) {
        onAuthError()
        return
      }
      setOpErr(errText(e))
    } finally {
      setCreating(false)
    }
  }

  async function toggleActive(row) {
    if (blocked) return
    const active = isActive(row.active)
    setBusy({ id: row.id, kind: 'toggle' })
    setOpErr('')
    setOpOk('')
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
    } catch (e) {
      if (isSessionAuthError(e)) {
        onAuthError()
        return
      }
      setOpErr(errText(e))
    } finally {
      setBusy(null)
    }
  }

  async function resetKey(row) {
    if (blocked) return
    if (!window.confirm(`重置「${row.name}」的密码？旧密码立刻失效，他正在用的页面会被登出。`)) return
    setBusy({ id: row.id, kind: 'regen' })
    setOpErr('')
    setOpOk('')
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
        const account = (st && (st.username || st.name)) || row.username || row.name
        setSecret({ id: row.id, username: account, password: key })
      } else {
        /* 密码已换但没有明文：不能让人以为旧密码还能用 */
        setOpErr('密码已重置，但服务端没回明文：再点一次「重置密码」拿新密码')
      }
    } catch (e) {
      if (isSessionAuthError(e)) {
        onAuthError()
        return
      }
      setOpErr(errText(e))
    } finally {
      setBusy(null)
    }
  }

  async function removeRow(row) {
    if (blocked) return
    if (!window.confirm(cfg.delAsk(row.name))) return
    setBusy({ id: row.id, kind: 'del' })
    setOpErr('')
    setOpOk('')
    try {
      const r = await deleteStaff(row.id)
      if (r && r.ok === false) {
        setOpErr(r.error || '删除失败，再试一次')
        return
      }
      setRows((prev) => prev.filter((x) => x.id !== row.id))
      setSecret((s) => (s && s.id === row.id ? null : s))
    } catch (e) {
      if (isSessionAuthError(e)) {
        onAuthError()
        return
      }
      setOpErr(errText(e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="lm-staff" aria-label={cfg.aria}>
      <div className="lm-staff-head">
        <Eyebrow>{cfg.eyebrow}</Eyebrow>
        {loaded ? (
          <span className="lm-staff-count">
            {rows.length} {cfg.countSuffix}
          </span>
        ) : null}
      </div>
      <p className="lm-staff-desc">{cfg.desc}</p>

      {loadErr ? (
        <div className="lm-staff-loaderr">
          <p className="lm-staff-msg is-err" role="alert">
            {loadErr}
          </p>
          <Btn size="sm" onClick={fetchStaff} disabled={loading}>
            {loading ? '重试中…' : '重试'}
          </Btn>
        </div>
      ) : null}

      {!loadErr && !loaded ? <Skel rows={3} /> : null}

      {!loadErr && loaded && !rows.length ? <p className="lm-staff-empty">{cfg.empty}</p> : null}

      {rows.length ? (
        <>
          <div className="lm-staff-lhead" aria-hidden="true">
            <span>成员</span>
            <span>操作</span>
          </div>
          <div className="lm-staff-list" role="list">
            {rows.map((row) => {
              const active = isActive(row.active)
              const kind = busy && busy.id === row.id ? busy.kind : ''
              const seen = row.last_seen_at ? fmtRel(row.last_seen_at) : ''
              const seenText = seen && seen !== '—' ? seen : '还没登录'
              /* owner 看到的是辅导员，多带一个「助理 N 人」 */
              const subCount = cfg.subKey ? Number(row.assistant_count) || 0 : null
              return (
                <div
                  className={`lm-staff-row${active ? '' : ' is-off'}`}
                  role="listitem"
                  key={row.id}
                >
                  <div className="lm-staff-main">
                    <span className="lm-staff-name" title={row.name || row.username || ''}>
                      {row.name || row.username || '—'}
                    </span>
                    <span className={`lm-staff-state${active ? ' is-on' : ''}`}>
                      <span className="lm-staff-dot" aria-hidden="true" />
                      {active ? '启用' : '已停用'}
                    </span>
                    {subCount !== null ? (
                      <span className="lm-staff-sub">
                        {cfg.subKey} {subCount} 人
                      </span>
                    ) : null}
                  </div>

                  <div className="lm-staff-acts">
                    <Btn
                      size="sm"
                      className="lm-staff-act"
                      onClick={() => toggleActive(row)}
                      disabled={blocked}
                    >
                      {kind === 'toggle' ? '处理中…' : active ? '停用' : '启用'}
                    </Btn>
                    <Btn
                      size="sm"
                      className="lm-staff-act"
                      onClick={() => resetKey(row)}
                      disabled={blocked}
                    >
                      {kind === 'regen' ? '处理中…' : '重置密码'}
                    </Btn>
                    <Btn
                      size="sm"
                      className="lm-staff-act is-danger"
                      onClick={() => removeRow(row)}
                      disabled={blocked}
                    >
                      {kind === 'del' ? '处理中…' : '删除'}
                    </Btn>
                  </div>

                  <div className="lm-staff-meta">
                    <span className="lm-staff-meta-k">用户名</span>
                    <code className="lm-staff-meta-v is-mono">{row.username || row.name || '—'}</code>
                    <span className="lm-staff-meta-dot" aria-hidden="true">
                      ·
                    </span>
                    <span className="lm-staff-meta-k">密码</span>
                    <code className={`lm-staff-meta-v is-mono${row.key_masked ? '' : ' is-dim'}`}>
                      {row.key_masked || '—'}
                    </code>
                    <span className="lm-staff-meta-dot" aria-hidden="true">
                      ·
                    </span>
                    <span className="lm-staff-meta-k">最近登录</span>
                    <span
                      className={`lm-staff-meta-v${row.last_seen_at ? '' : ' is-dim'}`}
                      title={row.last_seen_at ? fmtDateTime(row.last_seen_at) : `这个${cfg.nameTip}还没登录过`}
                    >
                      {seenText}
                    </span>
                  </div>
                </div>
              )
            })}
          </div>
        </>
      ) : null}

      {secret ? (
        <div className="lm-staff-secret" ref={secretRef} role="status">
          <div className="lm-staff-secret-head">
            <Eyebrow>ACCOUNT · 账号信息</Eyebrow>
            <span className="lm-staff-secret-name">{secret.username}</span>
          </div>
          <p className="lm-staff-secret-tip">
            {`把下面这组账号发给 ${secret.username}，初始密码请让对方首次登录后自行修改`}
          </p>
          <div className="lm-staff-secret-row">
            <span className="lm-staff-meta-k">账号</span>
            <code className="lm-staff-secret-key">{secret.username}</code>
            <CopyBtn text={secret.username} label="复制" />
          </div>
          <div className="lm-staff-secret-row">
            <span className="lm-staff-meta-k">初始密码</span>
            <code className="lm-staff-secret-key">{secret.password}</code>
            <CopyBtn text={secret.password} label="复制" />
          </div>
          <div className="lm-staff-secret-foot">
            <Btn variant="amber" size="sm" onClick={() => setSecret(null)}>
              我已记下
            </Btn>
          </div>
        </div>
      ) : null}

      {opErr ? (
        <p className="lm-staff-msg is-err" role="alert">
          {opErr}
        </p>
      ) : null}

      {opOk ? (
        <p className="lm-counselor-set-msg is-ok" role="status">
          {opOk}
        </p>
      ) : null}

      <div className="lm-staff-add">
        <div className="lm-staff-field">
          <label className="lm-staff-label" htmlFor={cfg.inputId}>
            {cfg.usernameLabel}
          </label>
          <input
            id={cfg.inputId}
            className="lm-staff-input"
            type="text"
            value={username}
            autoComplete="off"
            spellCheck="false"
            maxLength={24}
            placeholder={cfg.placeholder}
            disabled={creating}
            onChange={(e) => setUsername(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && canCreate) submitCreate()
            }}
          />
        </div>
        <Btn variant="primary" className="lm-staff-addbtn" onClick={submitCreate} disabled={!canCreate}>
          {creating ? cfg.adding : cfg.addLabel}
        </Btn>
      </div>
      <p className="lm-staff-hint">{cfg.hint}</p>
    </section>
  )
}
