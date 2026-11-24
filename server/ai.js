/* ============================================================================
 * LastMile · AI 管线（归属 B）
 *
 * 设计原则：
 *   1. 这里只做「编排 + 校验」：prompt 全部来自 prompts.js，规则关键词表来自 guard.js。
 *   2. 解析失败一律抛错，由上层降级（api.js 会用原文兜底），**绝不自己编数据**。
 *   3. 所有输出都过一遍 normalize：类型校正、数组去空、spans 逐字校验、URL/电话反编造。
 *   4. 日志只打 [ai] <fn> <ms>ms tokens=<n>，绝不打印 API key / Authorization 头。
 * ==========================================================================*/

import {
  PROMPTS,
  LANG_NAMES,
  LANGS,
  RISK_CODES,
  KIND_CODES,
  normalizeLang
} from './prompts.js'
import { scanSensitive } from './guard.js'

const DEFAULT_BASE = 'https://api.deepseek.com'
const DEFAULT_MODEL = 'deepseek-chat'
const RETRY_WAIT_MS = 1200

/* ---------------------------------------------------------------------------
 * 0. 基础工具
 * -------------------------------------------------------------------------*/
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const asStr = (v, max = 2000) => {
  if (typeof v === 'string') return v.trim().slice(0, max)
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  return ''
}
const asArr = (v) => (Array.isArray(v) ? v : [])
const asObj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {})
const digitsOf = (v) => String(v || '').replace(/\D/g, '')
const squash = (v) => String(v || '').replace(/\s+/g, '')

/** 从 sentAtIso 里取时区偏移（默认 +08:00），并算出「2026年11月18日（周三）10:00」这种人话 */
function sentContext(sentAtIso) {
  const raw = String(sentAtIso || '').trim()
  const offset = (/[+-]\d{2}:\d{2}$/.exec(raw) || [])[0] || '+08:00'
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(raw)
  let y
  let mo
  let d
  let hh = '00'
  let mm = '00'
  if (m) {
    y = m[1]
    mo = m[2]
    d = m[3]
    hh = m[4] || '00'
    mm = m[5] || '00'
  } else {
    const now = nowIsoOffset(offset)
    y = now.slice(0, 4)
    mo = now.slice(5, 7)
    d = now.slice(8, 10)
    hh = now.slice(11, 13)
    mm = now.slice(14, 16)
  }
  const weekday = '日一二三四五六'[new Date(Date.UTC(+y, +mo - 1, +d)).getUTCDay()]
  const sentAt = `${y}-${mo}-${d}T${hh}:${mm}:00${offset}`
  return {
    sentAt,
    offset,
    sentHuman: `${+y}年${+mo}月${+d}日（周${weekday}）${hh}:${mm}`
  }
}

/** 当前时间按指定偏移格式化成带偏移的 ISO */
function nowIsoOffset(offset = '+08:00') {
  const sign = offset.startsWith('-') ? -1 : 1
  const [hh, mm] = offset.slice(1).split(':').map(Number)
  const shifted = new Date(Date.now() + sign * (hh * 60 + mm) * 60000)
  return shifted.toISOString().replace(/\.\d{3}Z$/, '') + offset
}

/**
 * 在原文里定位一个「逐字子串」。
 * 精确找不到时按去掉空白后的文本定位，再把原文那一段（含原有空格）切回来，
 * 保证返回的永远是原文的真子串 —— 前端要靠它高亮。
 */
function locateVerbatim(raw, span) {
  const text = asStr(span, 600)
  if (!text || !raw) return ''
  if (raw.includes(text)) return text
  let compact = ''
  const map = []
  for (let i = 0; i < raw.length; i++) {
    if (!/\s/.test(raw[i])) {
      compact += raw[i]
      map.push(i)
    }
  }
  const target = squash(text)
  if (target.length < 2) return ''
  const p = compact.indexOf(target)
  if (p < 0) return ''
  return raw.slice(map[p], map[p + target.length - 1] + 1)
}

/* ---------------------------------------------------------------------------
 * 1. 唯一的 HTTP 出口：chatJSON
 *    - 60s 超时（AbortController）
 *    - 429 / 5xx / 网络错误 重试 1 次（指数退避）
 *    - 先 JSON.parse，失败则剥 ```json 围栏 / 抓第一个 { 到最后一个 }
 *    - 仍失败 → 抛 Error，由上层降级
 * -------------------------------------------------------------------------*/
function parseJsonLoose(content) {
  const s = String(content || '').replace(/^\uFEFF/, '').trim()
  if (!s) throw new Error('AI 返回空内容')
  const tryParse = (t) => {
    try {
      return { ok: true, value: JSON.parse(t) }
    } catch {
      return { ok: false }
    }
  }
  let r = tryParse(s)
  if (r.ok) return r.value

  // 剥 markdown 围栏
  const fence = s.match(/```(?:json|JSON)?\s*([\s\S]*?)```/)
  if (fence) {
    r = tryParse(fence[1].trim())
    if (r.ok) return r.value
  }
  // 第一个 { 到最后一个 }
  const a = s.indexOf('{')
  const b = s.lastIndexOf('}')
  if (a >= 0 && b > a) {
    r = tryParse(s.slice(a, b + 1))
    if (r.ok) return r.value
  }
  // 少数情况返回数组
  const c = s.indexOf('[')
  const d = s.lastIndexOf(']')
  if (c >= 0 && d > c) {
    r = tryParse(s.slice(c, d + 1))
    if (r.ok) return r.value
  }
  const err = new Error(`AI 返回内容无法解析为 JSON（前 80 字：${s.slice(0, 80)}）`)
  err.code = 'AI_BAD_JSON'
  throw err
}

function classifyFetchError(e, ac) {
  if (ac.signal.aborted) {
    const err = new Error('AI 请求超时')
    err.code = 'AI_TIMEOUT'
    err.retryable = true
    return err
  }
  const msg = String(e?.message || e)
  const err = new Error(msg)
  err.code = e?.code || 'AI_FETCH_ERROR'
  const retryable =
    e?.retryable === true ||
    e?.name === 'TypeError' ||
    /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|network|aborted/i.test(
      msg
    )
  err.retryable = retryable
  return err
}

/**
 * @param {string} system
 * @param {string} user
 * @param {{maxTokens?:number, temperature?:number, timeoutMs?:number, label?:string}} opts
 * @returns {Promise<{json:any, usage:object|null, ms:number, model:string}>}
 */
export async function chatJSON(system, user, opts = {}) {
  const {
    maxTokens = 2000,
    temperature = 0.2,
    timeoutMs = 60000,
    label = 'chatJSON'
  } = opts

  const key = process.env.DEEPSEEK_API_KEY
  if (!key) throw new Error('未配置 DEEPSEEK_API_KEY，无法调用 AI')
  const base = String(process.env.DEEPSEEK_BASE_URL || DEFAULT_BASE).replace(/\/+$/, '')
  const url = `${base}/chat/completions`
  const model = process.env.DEEPSEEK_MODEL || DEFAULT_MODEL
  const body = JSON.stringify({
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ],
    temperature,
    max_tokens: maxTokens,
    response_format: { type: 'json_object' },
    stream: false
  })

  const t0 = Date.now()
  let lastErr = null

  for (let attempt = 0; attempt <= 1; attempt++) {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), timeoutMs)
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${key}` // 绝不写进日志
        },
        body,
        signal: ac.signal
      })
      const text = await res.text()
      if (!res.ok) {
        const err = new Error(`DeepSeek HTTP ${res.status}: ${text.slice(0, 160)}`)
        err.code = `AI_HTTP_${res.status}`
        err.retryable = res.status === 429 || res.status >= 500
        throw err
      }
      let data
      try {
        data = JSON.parse(text)
      } catch {
        const err = new Error('DeepSeek 返回的不是 JSON 响应')
        err.code = 'AI_BAD_RESPONSE'
        throw err
      }
      const choice = asArr(data?.choices)[0]
      const content = choice?.message?.content
      if (!content || !String(content).trim()) {
        const err = new Error(
          choice?.finish_reason === 'length' ? 'AI 输出被截断（max_tokens 不够）' : 'AI 返回空内容'
        )
        err.code = choice?.finish_reason === 'length' ? 'AI_TRUNCATED' : 'AI_EMPTY'
        throw err
      }
      let parsed
      try {
        parsed = parseJsonLoose(content)
      } catch (e) {
        if (choice?.finish_reason === 'length') {
          const err = new Error('AI 输出被截断，JSON 不完整（max_tokens 不够）')
          err.code = 'AI_TRUNCATED'
          throw err
        }
        throw e
      }
      const usage = asObj(data?.usage)
      const total = Number(usage.total_tokens ?? (usage.prompt_tokens || 0) + (usage.completion_tokens || 0))
      console.log(`[ai] ${label} ${Date.now() - t0}ms tokens=${Number.isFinite(total) ? total : 0}`)
      return { json: parsed, usage, ms: Date.now() - t0, model: data?.model || model }
    } catch (e) {
      const err = e?.code ? e : classifyFetchError(e, ac)
      lastErr = err
      const retryable = err.retryable === true
      if (attempt === 0 && retryable) {
        const wait = RETRY_WAIT_MS + Math.floor(Math.random() * 400)
        console.warn(`[ai] ${label} 第 1 次失败（${err.code || 'ERR'}），${wait}ms 后重试`)
        await sleep(wait)
        continue
      }
      break
    } finally {
      clearTimeout(timer)
    }
  }

  console.error(`[ai] ${label} ${Date.now() - t0}ms 失败: ${lastErr?.message || lastErr}`)
  throw lastErr || new Error('AI 调用失败')
}

/* ---------------------------------------------------------------------------
 * 2. parseNotice
 * -------------------------------------------------------------------------*/
/** 把「2026-11-25」「2026-11-25T17:00」「…Z」统一成 2026-11-25T17:00:00+08:00 */
function normIso(v, offset, warnings) {
  if (typeof v !== 'string') return null
  const t = v.trim()
  if (!t || /^(null|none|undefined|unknown|n\/?a|-+)$/i.test(t)) return null
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i.exec(t)
  if (!m) return null
  const [, y, mo, d, hh, mm, ss, zone] = m
  const probe = new Date(`${y}-${mo}-${d}T00:00:00Z`)
  if (Number.isNaN(probe.getTime())) return null
  if (
    probe.getUTCFullYear() !== +y ||
    probe.getUTCMonth() + 1 !== +mo ||
    probe.getUTCDate() !== +d
  ) {
    return null
  }
  let time = '23:59:00'
  if (hh) {
    time = `${hh}:${mm}:${ss || '00'}`
  } else {
    warnings.push('原文/模型只给了日期，绝对时间按当天 23:59 处理')
  }
  let useZone = offset
  if (zone && /^[+-]/.test(zone)) {
    useZone = zone.replace(/^([+-]\d{2})(\d{2})$/, '$1:$2')
  } else if (zone && /^z$/i.test(zone)) {
    warnings.push('模型给出的时间带 UTC 的 Z，已按通知时区处理，请核对')
    useZone = offset
  }
  return `${y}-${mo}-${d}T${time}${useZone}`
}

function normalizeStructured(input, rawText, ctx) {
  const src = asObj(input)
  const j = asObj(src.structured).title_zh ? asObj(src.structured) : src
  const warnings = []

  const titleZh =
    asStr(j.title_zh, 200) ||
    asStr(
      rawText
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find((l) => l && !/^[-—=*#\s]+$/.test(l)),
      200
    )
  if (!asStr(j.title_zh, 200)) warnings.push('模型未给出标题，已用原文首行兜底')

  const kind = KIND_CODES.includes(asStr(j.kind, 40)) ? asStr(j.kind, 40) : 'general'
  if (asStr(j.kind, 40) && !KIND_CODES.includes(asStr(j.kind, 40))) {
    warnings.push(`模型给的 kind（${asStr(j.kind, 40)}）不在枚举里，已归为 general`)
  }

  // actions
  const actions = asArr(j.actions)
    .map((a, i) => {
      const o = asObj(a)
      return {
        order: Number.isFinite(Number(o.order)) ? Number(o.order) : i + 1,
        zh: asStr(o.zh, 300),
        en: asStr(o.en, 300)
      }
    })
    .filter((a) => a.zh)
    .sort((x, y) => x.order - y.order)
    .map((a, i) => ({ order: i + 1, zh: a.zh, en: a.en }))
  if (!asArr(j.actions).length) warnings.push('未抽取到可执行动作（actions），请人工补')

  // deadline
  const dSrc = asObj(j.deadline)
  const deadline = {
    raw: asStr(dSrc.raw, 200),
    iso: normIso(dSrc.iso, ctx.offset, warnings),
    confidence: dSrc.confidence === 'high' ? 'high' : 'low',
    basis: asStr(dSrc.basis, 300)
  }
  if (!deadline.iso) {
    deadline.confidence = 'low'
    if (deadline.raw) warnings.push(`未能解析出绝对截止时间（原文：${deadline.raw}），请人工确认`)
  }

  // materials
  const materials = asArr(j.materials)
    .map((m) => asStr(m, 200))
    .filter(Boolean)
  if (!materials.length) warnings.push('未抽取到材料清单，请人工确认')

  // place
  const pSrc = asObj(j.place)
  const place = {
    raw: typeof j.place === 'string' ? asStr(j.place, 300) : asStr(pSrc.raw, 300),
    note: asStr(pSrc.note, 300)
  }

  // official_links：url 必须在原文里出现，否则一律丢弃（禁止编 URL）
  const links = []
  let droppedLinks = 0
  for (const l of asArr(j.official_links)) {
    const o = asObj(l)
    const url = asStr(o.url, 500)
    if (!/^https?:\/\//i.test(url) || !squash(rawText).toLowerCase().includes(squash(url).toLowerCase())) {
      droppedLinks++
      continue
    }
    if (links.some((x) => x.url === url)) continue
    links.push({ label: asStr(o.label, 100) || url, url })
  }
  if (droppedLinks) warnings.push(`模型给出 ${droppedLinks} 条官方链接在原文中找不到依据，已丢弃`)

  // contacts：电话/姓名必须在原文出现
  const contacts = []
  let droppedContacts = 0
  for (const c of asArr(j.contacts)) {
    const o = asObj(c)
    const name = asStr(o.name, 60)
    const phone = asStr(o.phone, 40)
    const note = asStr(o.note, 120)
    const nameOk = !!name && rawText.includes(name)
    const phoneRaw = digitsOf(phone)
    const phoneOk = !!phoneRaw && digitsOf(rawText).includes(phoneRaw)
    if (!nameOk && !phoneOk) {
      droppedContacts++
      continue
    }
    if (contacts.some((x) => x.name === (nameOk ? name : '') && x.phone === (phoneOk ? phone : ''))) continue
    contacts.push({ name: nameOk ? name : '', phone: phoneOk ? phone : '', note })
  }
  if (droppedContacts) warnings.push(`模型给出 ${droppedContacts} 位联系人在原文中找不到依据，已丢弃`)
  if (!contacts.length) warnings.push('未抽取到联系人，学生遇到问题可能无人可找')

  // risk_flags
  const risk = [...new Set(asArr(j.risk_flags).map((x) => asStr(x, 40)).filter((x) => RISK_CODES.includes(x)))]
  if (RISK_CODES.includes(kind) && !risk.includes(kind)) risk.push(kind)

  // spans：每一个都必须是原文逐字子串
  const sSrc = asObj(j.spans)
  const spans = { deadline: '', place: '', actions: [] }
  spans.deadline = locateVerbatim(rawText, sSrc.deadline) || locateVerbatim(rawText, deadline.raw)
  spans.place = locateVerbatim(rawText, sSrc.place) || locateVerbatim(rawText, place.raw)
  const actionSpans = asArr(sSrc.actions)
  spans.actions = actions
    .map((a, i) => locateVerbatim(rawText, actionSpans[i]) || locateVerbatim(rawText, a.zh))
    .filter(Boolean)
  if (actions.length && spans.actions.length < actions.length) {
    warnings.push('部分动作未能在原文中定位，卡片高亮可能缺项')
  }

  const consequence = asStr(j.consequence, 500)
  const oneLine = asStr(j.one_line, 200)
  if (!oneLine) warnings.push('缺少一句话结论（one_line），请人工补写')
  if (!consequence) warnings.push('原文未见明确后果条款（consequence 为空）')

  // 合并模型自己给的 warnings 与 normalize 补的 warnings，同主题的只留模型那条
  const WARN_TOPICS = [
    /联系人|联系|电话|contact/i,
    /链接|网址|url|official_links/i,
    /附件/,
    /后果|处罚|consequence|penalty/i,
    /材料|material/i
  ]
  const sameTopic = (a, b) => WARN_TOPICS.some((re) => re.test(a) && re.test(b))
  const outWarnings = asArr(j.warnings)
    .map((w) => asStr(w, 300))
    .filter(Boolean)
  for (const w of warnings) {
    if (outWarnings.some((x) => sameTopic(x, w))) continue
    outWarnings.push(w)
  }

  return {
    title_zh: titleZh,
    kind,
    one_line: oneLine,
    who: asStr(j.who, 300),
    what: asStr(j.what, 1200),
    actions,
    deadline,
    materials,
    place,
    consequence,
    official_links: links,
    contacts,
    risk_flags: risk,
    spans,
    warnings: [...new Set(outWarnings)].slice(0, 12)
  }
}

/**
 * 通知原文 → StructuredNotice
 * @param {string} rawText
 * @param {string} sentAtIso 通知落款/发送时间，用于推算相对时间
 */
export async function parseNotice(rawText, sentAtIso) {
  const raw = String(rawText || '').trim()
  if (!raw) throw new Error('通知原文为空，无法解析')
  const ctx = sentContext(sentAtIso)
  const { json } = await chatJSON(PROMPTS.parseSystem, PROMPTS.buildParseUser(raw, ctx), {
    maxTokens: 3200,
    temperature: 0.1,
    label: 'parseNotice'
  })
  const structured = normalizeStructured(json, raw, ctx)
  if (!structured.one_line && !structured.what && !structured.actions.length) {
    throw new Error('AI 未能从通知中抽取到有效内容（one_line / what / actions 全空）')
  }
  return structured
}

/* ---------------------------------------------------------------------------
 * 3. buildQuiz
 * -------------------------------------------------------------------------*/
function findSpan(cands, v) {
  const t = asStr(v, 400)
  if (!t) return ''
  if (cands.includes(t)) return t
  const c = squash(t)
  const exact = cands.find((x) => squash(x) === c)
  if (exact) return exact
  const near = cands.find((x) => {
    const s = squash(x)
    return s.includes(c) || c.includes(s)
  })
  return near || ''
}

function fallbackQuiz(s) {
  const dRaw = asStr(s?.deadline?.raw, 120)
  const place = asStr(s?.place?.raw, 120)
  const a1 = asStr(s?.actions?.[0]?.zh, 120)
  const lead = [a1 || asStr(s?.one_line, 120) || '按通知要求办理']
  if (dRaw) lead.push(`时间：${dRaw}`)
  if (place) lead.push(`地点：${place}`)
  const options = [
    lead.join('；'),
    '等老师在群里点名之后再说',
    '在线上系统提交，不用本人到场',
    place ? `到${place}，但没有截止时间` : '这学期结束前办完就可以'
  ]
  const cands = PROMPTS.quizSpanCandidates(s)
  const source = cands[0] || dRaw || place || ''
  return {
    question: '按这份通知，你需要做什么？',
    options,
    answer_index: 0,
    source_span: source,
    explain: source ? `通知原文：${source}` : '按通知要求完成即可。'
  }
}

function normalizeQuiz(input, structured) {
  const src = asObj(input)
  const obj = asObj(src.quiz).question ? asObj(src.quiz) : src
  const cands = PROMPTS.quizSpanCandidates(structured)
  const question = asStr(obj.question, 160)
  const rawOptions = asArr(obj.options)
    .map((o) => asStr(o, 200))
    .filter(Boolean)
  if (!question || rawOptions.length < 3) return null
  const ai = Number(obj.answer_index)
  if (!Number.isInteger(ai) || ai < 0 || ai >= rawOptions.length) return null
  const correctKey = squash(rawOptions[ai])

  // 去重（保留首次出现顺序），同时修正 answer_index
  let options = []
  for (const o of rawOptions) {
    if (!options.some((x) => squash(x) === squash(o))) options.push(o)
  }
  let answer = options.findIndex((x) => squash(x) === correctKey)
  if (answer < 0) return null
  if (options.length < 3) return null

  if (options.length > 4) {
    const others = options.filter((_, i) => i !== answer).slice(0, 3)
    const correct = options[answer]
    const rotate = question.length % 4
    const shell = new Array(4).fill('')
    shell[rotate] = correct
    let k = 0
    for (let i = 0; i < 4; i++) if (i !== rotate) shell[i] = others[k++]
    options = shell
    answer = rotate
  }

  let sourceSpan = findSpan(cands, obj.source_span)
  if (!sourceSpan) {
    // 模型给的片段在原文里定位不到 → 回退到第一个可信片段，绝不自己编原文
    sourceSpan = cands[0] || ''
    if (sourceSpan) console.warn('[ai] buildQuiz source_span 未命中，已回退到通知原文片段')
  }
  const explain = asStr(obj.explain, 300) || (sourceSpan ? `通知原文：${sourceSpan}` : options[answer])

  return {
    question,
    options,
    answer_index: answer,
    source_span: sourceSpan,
    explain
  }
}

/**
 * 生成回执小测（1 题，四选一，考「做什么 + 什么时候前」）
 * @param {object} structured
 */
export async function buildQuiz(structured) {
  const s = structured || {}
  try {
    const { json } = await chatJSON(PROMPTS.quizSystem, PROMPTS.buildQuizUser(s), {
      maxTokens: 900,
      temperature: 0.3,
      label: 'buildQuiz'
    })
    const quiz = normalizeQuiz(json, s)
    if (quiz) {
      if (!quiz.source_span) console.warn('[ai] buildQuiz 未能定位 source_span，前端将无法高亮原文')
      return quiz
    }
    console.warn('[ai] buildQuiz 模型输出未通过校验，改用本地兜底题')
  } catch (e) {
    console.warn(`[ai] buildQuiz 模型调用失败，改用本地兜底题：${e.message}`)
  }
  return fallbackQuiz(s)
}

/* ---------------------------------------------------------------------------
 * 4. translateNotice
 * -------------------------------------------------------------------------*/
function normalizeTranslatedQuiz(tq, quiz) {
  const o = asObj(tq)
  const question = asStr(o.question, 200)
  if (!question) return null
  const want = asArr(quiz.options)
  const opts = asArr(o.options)
    .map((x) => asStr(x, 200))
    .filter(Boolean)
  if (!want.length) return null
  if (opts.length !== want.length) {
    console.warn(`[ai] 翻译后的 quiz.options 数量（${opts.length}）与母版（${want.length}）不一致，已对齐`)
    if (opts.length > want.length) opts.length = want.length
    while (opts.length < want.length) opts.push(want[opts.length]) // 缺的用母版占位，保证 answer_index 不错位
  }
  let answer = Number(quiz.answer_index)
  if (!Number.isInteger(answer) || answer < 0 || answer >= opts.length) answer = 0
  return {
    question,
    options: opts,
    answer_index: answer, // 原样保留母版答案，绝不按翻译重算
    source_span: asStr(o.source_span, 400) || asStr(quiz.source_span, 400),
    explain: asStr(o.explain, 300) || asStr(quiz.explain, 300)
  }
}

function normalizeTranslation(input, lang, structured, quiz) {
  const o = asObj(input)
  if (!Object.keys(o).length) return null
  const title = asStr(o.title, 300)
  const oneLine = asStr(o.one_line, 400)
  if (!title || !oneLine) return null
  const actions = asArr(o.actions)
    .map((a, i) => {
      const x = asObj(a)
      const order = Number(x.order)
      return { order: Number.isFinite(order) ? order : i + 1, text: asStr(x.text ?? x.zh, 300) }
    })
    .filter((a) => a.text)
    .sort((x, y) => x.order - y.order)
    .map((a, i) => ({ order: i + 1, text: a.text }))
  if (!actions.length && asArr(structured?.actions).length) return null
  const tQuiz = normalizeTranslatedQuiz(o.quiz, quiz)
  if (!tQuiz) return null
  return {
    lang,
    title,
    one_line: oneLine,
    what: asStr(o.what, 1200),
    who: asStr(o.who, 300),
    actions,
    deadline_text: asStr(o.deadline_text, 200),
    place_text: asStr(o.place_text, 300),
    materials: asArr(o.materials)
      .map((m) => asStr(m, 200))
      .filter(Boolean),
    consequence: asStr(o.consequence, 400),
    quiz: tQuiz
  }
}

/**
 * 一次请求翻译所有语言（省 token），单语言缺失/不完整时单独重试；
 * 全部失败才抛错，让上层降级到中文兜底。
 */
export async function translateNotice(structured, quiz, langs) {
  const s = structured || {}
  const q = quiz && asArr(quiz.options).length ? quiz : fallbackQuiz(s)
  const want = [...new Set(asArr(langs).map((l) => normalizeLang(l)))]
    .filter((l) => l !== 'zh' && LANGS.includes(l))
  if (!want.length) throw new Error('translateNotice 需要至少一个目标语言（en/ru/vi/th/id）')

  const out = {}
  let missing = want.slice()

  try {
    const { json } = await chatJSON(
      PROMPTS.translateSystem,
      PROMPTS.buildTranslateUser(s, q, want),
      { maxTokens: 8000, temperature: 0.2, label: 'translateNotice' }
    )
    const bundle = asObj(json.translations)
    for (const l of want) {
      const t = normalizeTranslation(bundle[l] ?? json[l], l, s, q)
      if (t) out[l] = t
    }
    missing = want.filter((l) => !out[l])
  } catch (e) {
    console.warn(`[ai] translateNotice 批量失败，改为逐语言重试：${e.message}`)
  }

  for (const l of missing) {
    try {
      const { json } = await chatJSON(
        PROMPTS.translateSystem,
        PROMPTS.buildTranslateOneUser(s, q, l),
        { maxTokens: 3200, temperature: 0.2, label: `translateNotice:${l}` }
      )
      const t = normalizeTranslation(json.translations?.[l] ?? json, l, s, q)
      if (t) {
        out[l] = t
      } else {
        console.warn(`[ai] translateNotice ${l} 单语言重试结果不完整，已跳过`)
      }
    } catch (e) {
      console.warn(`[ai] translateNotice ${l} 单语言重试失败：${e.message}`)
    }
  }

  const got = Object.keys(out)
  if (!got.length) throw new Error('AI 翻译整体失败（所有语言都没拿到可用结果）')
  if (got.length < want.length) {
    console.warn(`[ai] translateNotice 缺失语言：${want.filter((l) => !out[l]).join(',')}`)
  }
  return out
}

/* ---------------------------------------------------------------------------
 * 5. nudgeText
 * -------------------------------------------------------------------------*/
function deadlineTextOf(structured, lang) {
  const d = structured?.deadline || {}
  if (d.iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(d.iso)
    if (m) {
      const [, y, mo, dd, hh, mi] = m
      // 原文只给日期（parseNotice 兜底成 23:59 且 confidence=low）时，群里只说日期，别把 23:59 当真的截止时刻
      const dateOnly = hh === '23' && mi === '59' && d.confidence === 'low'
      const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][+mo - 1]
      if (lang === 'zh') return dateOnly ? `${+y}年${+mo}月${+dd}日` : `${+y}年${+mo}月${+dd}日 ${hh}:${mi}`
      if (lang === 'ru') {
        const mru = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'][+mo - 1]
        return dateOnly ? `${+dd} ${mru} ${y}` : `${+dd} ${mru} ${y}, ${hh}:${mi}`
      }
      if (lang === 'vi') return dateOnly ? `${dd}/${mo}/${y}` : `${dd}/${mo}/${y} ${hh}:${mi}`
      return dateOnly ? `${+dd} ${mon} ${y}` : `${+dd} ${mon} ${y}, ${hh}:${mi}`
    }
    return d.iso
  }
  return d.raw || ''
}

function trimToCap(text, cap) {
  if (text.length <= cap) return text
  const cut = text.slice(0, cap)
  const at = Math.max(
    cut.lastIndexOf('。'),
    cut.lastIndexOf('！'),
    cut.lastIndexOf('？'),
    cut.lastIndexOf('\n'),
    cut.lastIndexOf('. '),
    cut.lastIndexOf('! '),
    cut.lastIndexOf('? ')
  )
  let head
  if (at > cap * 0.5) {
    head = cut.slice(0, at + 1)
  } else {
    // 没有句末标点就退到最近的词边界，避免把 "Тон…" / "корп.…" 这种半截词留在群消息里
    const sp = Math.max(cut.lastIndexOf(' '), cut.lastIndexOf('、'), cut.lastIndexOf('，'), cut.lastIndexOf(', '))
    head = sp > cap * 0.6 ? cut.slice(0, sp) : cut
  }
  return head.trimEnd().replace(/[,，、;；:：]$/, '') + '…'
}

/**
 * 压到目标长度：姓名行和链接行是硬要求（必须保留），只裁正文，
 * 这样中文群消息能稳在 200 字附近，又不会把「还没确认：张三、李四」和链接裁掉。
 */
function fitNudge(body, cap, url, shown) {
  if (body.length <= cap) return body
  const lines = body.split('\n')
  const must = []
  const prose = []
  for (const l of lines) {
    if ((url && l.includes(url)) || shown.some((n) => n && l.includes(n))) must.push(l)
    else prose.push(l)
  }
  const mustLen = must.join('\n').length + (must.length ? 1 : 0)
  const budget = Math.max(60, cap - mustLen)
  const head = trimToCap(prose.join('\n'), budget)
  return [head, ...must].filter(Boolean).join('\n')
}

/**
 * 生成可直接粘进微信群的催办文案
 * @param {{notice?:object, targets?:Array, lang?:string, tone?:string, tier?:string, link?:string}} args
 */
export async function nudgeText({ notice, targets, lang, tone, tier, link } = {}) {
  const L = normalizeLang(lang || 'zh')
  const s = notice?.structured || notice || {}
  // 已经生成过多语言的话直接复用（repo 给的 Notice 行里 translations 是解析好的对象）
  const tr = (notice?.translations && notice.translations[L]) || null
  const names = asArr(targets)
    .map((t) => asStr(t?.name, 60))
    .filter(Boolean)
  const shown = names.slice(0, 10)
  const overflow = Math.max(0, names.length - shown.length)
  const url = asStr(link, 500) || asStr(notice?.link, 500) || (notice?.id ? `/#/s/${notice.id}` : '')
  const deadlineText = asStr(tr?.deadline_text, 120) || deadlineTextOf(s, L)
  const oneLine = asStr(tr?.one_line, 300) || asStr(s.one_line, 300)
  const title = asStr(tr?.title, 200) || asStr(s.title_zh, 200)
  const placeText = asStr(tr?.place_text, 200) || asStr(s.place?.raw, 200)
  const cap = L === 'zh' ? 200 : 400
  const tierText = tier === 'help' ? 'help' : 'nudge'
  const toneText = ['gentle', 'firm', 'final'].includes(tone) ? tone : 'firm'
  const labels = PROMPTS.NUDGE_LABEL[L] || PROMPTS.NUDGE_LABEL.en

  let body = ''
  try {
    const { json } = await chatJSON(
      PROMPTS.nudgeSystem,
      PROMPTS.buildNudgeUser({
        lang: L,
        langName: LANG_NAMES[L] || L,
        tone: toneText,
        tier: tierText,
        title,
        oneLine,
        deadlineText,
        placeText,
        names: shown,
        overflow,
        link: url,
        helpMessage: asStr(notice?.help_message, 300)
      }),
      { maxTokens: 900, temperature: 0.6, label: 'nudgeText' }
    )
    body = asStr(json.text ?? json.nudge ?? json.message, 2000)
    if (body.startsWith('```')) body = body.replace(/^```[a-z]*\s*/i, '').replace(/```$/, '')
  } catch (e) {
    console.warn(`[ai] nudgeText 模型失败，使用本地模板：${e.message}`)
  }

  // 模型不可用 → 本地模板（保证老师永远拿得到能发的话）
  if (!body.trim()) {
    const who =
      shown.length
        ? shown.join(L === 'zh' ? '、' : ', ') +
          (overflow > 0 ? ` ${labels.more.replace('{n}', overflow)}` : '')
        : ''
    const head = tierText === 'help' ? `${labels.help}：` : ''
    const lines = [head + (oneLine || title || '')]
    if (deadlineText) lines.push(`${labels.deadline}: ${deadlineText}`)
    if (who) lines.push(`${labels.pending}: ${who}`)
    if (url) lines.push(`${labels.link}: ${url}`)
    return fitNudge(lines.filter(Boolean).join('\n'), cap, url, shown)
  }

  // 后置修补：姓名、链接必须出现在文本里
  body = body.replace(/^#{1,6}\s*/gm, '').trim()
  const needNames = shown.filter((n) => !body.includes(n))
  if (needNames.length) {
    const who =
      needNames.join(L === 'zh' ? '、' : ', ') +
      (overflow > 0 ? ` ${labels.more.replace('{n}', overflow)}` : '')
    body += `\n${labels.pending}: ${who}`
  }
  if (url && !body.includes(url)) body += `\n${labels.link}: ${url}`

  return fitNudge(body, cap, url, shown)
}

/* ---------------------------------------------------------------------------
 * 6. answerFromNotice（只许复述）
 * -------------------------------------------------------------------------*/
/**
 * @param {string} question
 * @param {object} structured
 * @param {string} lang
 */
export async function answerFromNotice(question, structured, lang) {
  const L = normalizeLang(lang)
  const s = structured || {}
  const q = asStr(question, 500)
  if (!q) return PROMPTS.notFoundText(s, L)
  const { json } = await chatJSON(PROMPTS.answerSystem, PROMPTS.buildAnswerUser(q, s, L), {
    maxTokens: 700,
    temperature: 0.2,
    label: 'answerFromNotice'
  })
  const text = asStr(json.answer ?? json.text ?? json.message ?? json.reply, 900)
  if (!text) throw new Error('AI 未返回可用回答')
  return text
}

/* ---------------------------------------------------------------------------
 * 7. classifyRisk（底层分类，给 guard.js 用）
 * -------------------------------------------------------------------------*/
/**
 * @param {string} text
 * @returns {Promise<{flags:string[], allow:boolean, reason_code:string}>}
 */
export async function classifyRisk(text) {
  const t = asStr(text, 1000)
  const rule = scanSensitive(t)
  if (rule.flags.length) {
    return { flags: rule.flags, allow: false, reason_code: rule.flags[0] }
  }
  if (!t) return { flags: [], allow: true, reason_code: 'clean' }
  // 规则层没命中时，用模型兜一次「换个说法绕过关键词」的情况
  try {
    const { json } = await chatJSON(PROMPTS.classifySystem, PROMPTS.buildClassifyUser(t), {
      maxTokens: 200,
      temperature: 0,
      timeoutMs: 15000,
      label: 'classifyRisk'
    })
    const flags = [
      ...new Set(
        asArr(json.flags)
          .map((f) => asStr(f, 40))
          .filter((f) => RISK_CODES.includes(f))
      )
    ]
    return {
      flags,
      allow: flags.length === 0,
      reason_code: flags[0] || asStr(json.reason_code, 40) || 'clean'
    }
  } catch (e) {
    console.warn(`[ai] classifyRisk 模型层不可用，仅用规则层：${e.message}`)
    return { flags: [], allow: true, reason_code: 'clean' }
  }
}
