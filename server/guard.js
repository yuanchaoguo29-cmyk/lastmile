/* ============================================================================
 * LastMile · 敏感问题守门员（归属 B）
 *
 * 红线：签证、居留许可、看病体检、心理、安全 五类问题，产品不自己回答，
 *       只给官方链接和「该找谁」。
 * 但是：如果通知本身就是关于居留许可的，**忠实转述该通知的内容是允许的**。
 *       只有「超出通知范围的咨询和个性化建议」必须拒绝。这条边界是本文件的核心。
 *
 * 结构：
 *   0 规则层（确定性、快、零 token）：六语关键词表 + 求建议/求判断 + 个人异常状态
 *   1 模型层：把问题 + 结构化通知 + 规则命中一起给模型，判定 in_notice / out_of_scope / sensitive_advice
 *   2 出口：allowed → 回答只能来自 answerFromNotice（再过一道措辞后置检查）
 *           refused → 返回固定 Refusal（六语查表，不调模型）
 *   3 fail-closed：模型层超时/解析失败 → 退回规则层；两层都拿不准 → 默认拒绝。
 *   本文件对外只有一个出口 guardAsk，永不抛错。
 * ==========================================================================*/

import { PROMPTS, RISK_CODES, normalizeLang } from './prompts.js'

/* ---------------------------------------------------------------------------
 * 0. 规则层：六语关键词表（单一来源，ai.js 的 classifyRisk 也 import 这里）
 * -------------------------------------------------------------------------*/
export const RISK_KEYWORDS = {
  residence_permit: [
    // zh
    '居留', '居留许可', '居留证', '居留卡', '临时居留', '住宿登记', '暂住',
    // en
    'residence permit', 'residence card', 'residence registration', 'stay permit',
    'temporary residence', 'resident permit', 'rp card',
    // ru
    'вид на жительство', 'внж', 'разрешение на пребывание', 'регистрац',
    // vi
    'cư trú', 'thẻ cư trú', 'giấy phép cư trú', 'tạm trú', 'đăng ký tạm trú',
    // th
    'ถิ่นที่อยู่', 'ใบอนุญาตพำนัก', 'การพำนัก', 'ทะเบียนที่พัก',
    // id
    'izin tinggal', 'kitas', 'izin domisili', 'tinggal tetap'
  ],
  visa: [
    // zh
    '签证', '续签', '入境章', '入境', '出境', '出入境', '护照签证', '逾期停留',
    // en
    'visa', 'entry stamp', 'entry permit', 'overstay', 'immigration', 'exit-entry',
    // ru
    'виза', 'визу', 'визой', 'визе', 'въезд', 'выезд', 'миграцион',
    // vi
    'thị thực', 'visa', 'nhập cảnh', 'xuất cảnh', 'quá hạn thị thực',
    // th
    'วีซ่า', 'ตรวจคนเข้าเมือง', 'เข้าเมือง', 'ต่อวีซ่า',
    // id
    'visa', 'izin masuk', 'imigrasi', 'overstay'
  ],
  medical: [
    // zh
    '体检', '看病', '医院', '医疗', '医生', '疫苗', '血清', '肝功能', '复查',
    '化验', 'x光', '胸片', '病历', '药', '保健',
    // en
    'medical', 'health check', 'physical exam', 'hospital', 'doctor', 'clinic',
    'vaccine', 'vaccination', 'treatment', 'blood test', 'x-ray',
    // ru
    'медосмотр', 'медицин', 'больниц', 'врач', 'здоров', 'прививк', 'клиник', 'анализ',
    // vi
    'khám', 'y tế', 'bệnh viện', 'bác sĩ', 'sức khỏe', 'tiêm', 'xét nghiệm',
    // th
    'ตรวจสุขภาพ', 'การแพทย์', 'โรงพยาบาล', 'สุขภาพ', 'หมอ', 'วัคซีน', 'ตรวจเลือด',
    // id
    'medis', 'kesehatan', 'rumah sakit', 'dokter', 'pemeriksaan', 'vaksin', 'klinik'
  ],
  mental: [
    // zh —— 心情/压力这类口语说法必须收进来：模型挂掉时规则层是唯一防线
    '心理', '抑郁', '焦虑', '自杀', '情绪', '精神', '咨询师', '睡不着', '失眠',
    '心情', '压力', '崩溃', '想不开', '轻生', '绝望', '难受得',
    // en
    'mental', 'depress', 'anxiety', 'anxious', 'suicid', 'therapy', 'therapist',
    'psycholog', 'panic', 'stress', 'counsel',
    // ru
    'психолог', 'психи', 'депресс', 'тревож', 'суицид', 'паник', 'стресс',
    // vi
    'tâm lý', 'trầm cảm', 'lo âu', 'tự tử', 'tham vấn', 'căng thẳng',
    // th
    'จิตใจ', 'จิตวิทยา', 'ซึมเศร้า', 'วิตกกังวล', 'ฆ่าตัวตาย', 'เครียด',
    // id
    'mental', 'psikolog', 'depresi', 'cemas', 'bunuh diri', 'stres', 'konseling'
  ],
  safety: [
    // zh
    '安全', '报警', '诈骗', '被骗', '被盗', '盗', '抢', '火警', '事故', '受伤',
    '打架', '骚扰', '侵害', '丢了钱包', '110',
    // en
    'safety', 'unsafe', 'police', 'scam', 'fraud', 'theft', 'stolen', 'robbed',
    'emergency', 'danger', 'dangerous', 'harass', 'assault', 'accident',
    // ru
    'безопасн', 'полици', 'мошен', 'украл', 'опасн', 'напад', 'авари',
    // vi
    'an toàn', 'cảnh sát', 'lừa đảo', 'mất trộm', 'nguy hiểm', 'cấp cứu', 'tai nạn',
    // th
    'ปลอดภัย', 'ตำรวจ', 'หลอกลวง', 'ถูกขโมย', 'อันตราย', 'ฉุกเฉิน', 'อุบัติเหตุ',
    // id
    'aman', 'polisi', 'penipuan', 'dicuri', 'bahaya', 'darurat', 'kecelakaan'
  ]
}

/** 求建议 / 求判断 / 求结论的措辞（不是单纯提到某个词） */
export const ADVICE_MARKERS = [
  // zh
  '能不能', '能否', '可不可以', '可以吗', '会不会', '该不该', '要不要', '行不行',
  '有没有办法', '怎么办', '怎么才能', '是否可以', '需不需要', '能不能不', '可以不办',
  '可以不去', '不办行不行', '我不想去', '我不想办', '怎么办才好', '是否要',
  // en
  'can i', 'can we', 'could i', 'should i', 'am i', 'will i', 'do i need to',
  'do i have to', 'is it possible', 'what happens if', 'is it ok', 'is it okay',
  'advise', 'advice', 'what would you', 'will they',
  // ru
  'могу ли', 'можно ли', 'стоит ли', 'нужно ли', 'что будет если', 'обязан ли',
  'посоветуй', 'как мне',
  // vi
  'có thể', 'có được', 'có nên', 'tôi có', 'liệu', 'nếu không', 'có bị', 'tôi nên',
  // th
  'ได้ไหม', 'ควร', 'ต้องไหม', 'จะเป็นอย่างไร', 'ถ้าไม่', 'ฉันควร', 'ผมควร',
  // id
  'apakah', 'bisakah', 'bolehkah', 'apakah saya', 'kalau tidak', 'apa yang terjadi',
  'sebaiknya', 'haruskah'
]

/** 学生自己的异常状态（证件过期/丢失/被拒/没办…）：一旦出现，问题就不再是「通知要求什么」 */
export const PERSONAL_STATE = [
  // zh
  '过期', '到期了', '丢了', '丢失', '弄丢', '被拒', '拒签', '忘了', '还没办', '没办',
  '没交', '没去', '离职', '被学校', '已经逾期', '来不及', '错过',
  // en
  'expired', 'expires', 'lost', 'rejected', 'refused', 'forgot', 'missed',
  'have not', 'haven t', 'not yet', 'too late', 'stolen',
  // ru
  'истек', 'просроч', 'потерял', 'потеря', 'отказ', 'забыл', 'опоздал', 'не успел',
  // vi
  'hết hạn', 'quá hạn', 'mất', 'bị từ chối', 'quên', 'chưa', 'trễ', 'không kịp',
  // th
  'หมดอายุ', 'หาย', 'ถูกปฏิเสธ', 'ลืม', 'สาย', 'ไม่ทัน', 'ยังไม่ได้',
  // id
  'kadaluarsa', 'kedaluwarsa', 'hilang', 'ditolak', 'lupa', 'terlambat',
  'belum', 'tidak sempat'
]

/** 明确在问「通知原文怎么写的」，这类问题要交给模型层判 in_notice，不能被下面的硬规则误杀 */
const NOTICE_QUOTE =
  /通知(里|中|上|里面)?(写|说|提到|有没有|怎么)|原文|according to the notice|in the notice|the notice says|в объявлении|thông báo (ghi|nói)|ประกาศ(เขียน|บอก)|pengumuman (menyebutkan|mengatakan)/i

/** 后果预测 / 明显越界：无条件拒绝 */
const CONSEQUENCE_PATTERNS = [
  {
    re: /遣返|驱逐出境|遣送|黑户|非法居留|坐牢|拘留|会被抓|被罚款|deport|deported|repatriat|illegal stay|blacklist|выдвор|депорт|trục xuất|cư trú bất hợp pháp|ส่งกลับ|ผิดกฎหมาย|dipulangkan|ilegal/i,
    code: 'visa'
  },
  {
    re: /(不办|不去|不交|不上交|不参加|不体检|不申请|不填|没去|没办|逾期|过期).{0,10}(会怎样|怎么样|行不行|可以吗|有什么后果|什么后果|会不会|严重吗|要紧吗|会怎么样)/,
    code: ''
  },
  { re: /能不能不(办|去|交|参加|体检|申请)|可以不(办|去|交|参加|体检)/, code: '' },
  {
    re: /(后果|处罚|处分|罚).{0,8}(会怎样|严重吗|要紧吗|会不会|有多严重)/,
    code: ''
  }
]

const lower = (s) => String(s || '').toLowerCase()

/**
 * 规则层扫描（确定性，不调模型）
 * @param {string} text
 * @returns {{flags:string[], matched:Record<string,string[]>, advice:boolean, adviceHits:string[], personalState:boolean, stateHits:string[], consequence:boolean}}
 */
export function scanSensitive(text) {
  const low = lower(text)
  const flags = []
  const matched = {}
  for (const code of RISK_CODES) {
    const hits = (RISK_KEYWORDS[code] || []).filter((w) => low.includes(lower(w)))
    if (hits.length) {
      flags.push(code)
      matched[code] = hits.slice(0, 4)
    }
  }
  const adviceHits = ADVICE_MARKERS.filter((w) => low.includes(lower(w)))
  const stateHits = PERSONAL_STATE.filter((w) => low.includes(lower(w)))
  const consequence = CONSEQUENCE_PATTERNS.some((p) => p.re.test(text))
  return {
    flags,
    matched,
    advice: adviceHits.length > 0,
    adviceHits: adviceHits.slice(0, 4),
    personalState: stateHits.length > 0,
    stateHits: stateHits.slice(0, 4),
    consequence
  }
}

/** 规则层是否给出「确定性拒绝」的结论；返回 reason_code 或 '' */
function ruleRefusalCode(question, rule) {
  if (NOTICE_QUOTE.test(question)) return '' // 明确在问通知原文，交给模型层
  if (rule.consequence) {
    const hit = CONSEQUENCE_PATTERNS.find((p) => p.re.test(question))
    return rule.flags[0] || (hit && hit.code) || 'visa'
  }
  // 五类 + （求建议/求判断 或 个人异常状态）→ 一定转人工
  if (rule.flags.length && (rule.advice || rule.personalState)) return rule.flags[0]
  return ''
}

/* ---------------------------------------------------------------------------
 * 1. 拒绝结构（六语查表，绝不临时调模型）
 * -------------------------------------------------------------------------*/
const asArr = (v) => (Array.isArray(v) ? v : [])

/* 反幻觉过滤会丢掉原文里找不到的 URL，所以真实通知解析出来后 official_links 常常为空。
   这里按原因码兜底到已核验（HTTP 200）的官方入口，保证拒绝卡永远有「该找谁」。
   —— 改动说明：lead 补，解决 A/B 双方都指出的「拒绝卡可能没有官方链接」缺口。 */
const SWUFE_INTL = 'https://international.swufe.edu.cn'
const DEFAULT_CHANNELS = {
  residence_permit: [
    { label: '国际教育学院 · 签证及居留许可', url: 'https://international.swufe.edu.cn/xyshyfw1/qzjjlxk.htm' },
    { label: '国家移民管理局', url: 'https://www.nia.gov.cn' }
  ],
  visa: [
    { label: '国家移民管理局', url: 'https://www.nia.gov.cn' },
    { label: '国际教育学院 · 签证及居留许可', url: 'https://international.swufe.edu.cn/xyshyfw1/qzjjlxk.htm' }
  ],
  medical: [{ label: '西南财经大学校医院', url: 'https://houqin.swufe.edu.cn/fwjj/ylfw.htm' }],
  mental: [{ label: '国际学生事务 · 官方入口', url: SWUFE_INTL }],
  safety: [{ label: '国际学生事务 · 官方入口', url: SWUFE_INTL }],
  out_of_scope: [{ label: '国际学生事务 · 官方入口', url: SWUFE_INTL }]
}

function buildRefusal(lang, code, structured) {
  const L = normalizeLang(lang)
  const c = PROMPTS.REFUSAL_MESSAGES[code] ? code : 'out_of_scope'
  const table = PROMPTS.REFUSAL_MESSAGES[c] || PROMPTS.REFUSAL_MESSAGES.out_of_scope
  const own = asArr(structured?.official_links).filter((l) => l && l.url)
  return {
    allowed: false,
    refusal: {
      reason_code: c,
      message: table[L] || table.en || table.zh,
      // 官方链接与联系人原样透传，方便学生一键找人；通知里没有就回落到已核验的官方入口
      links: own.length ? own : DEFAULT_CHANNELS[c] || DEFAULT_CHANNELS.out_of_scope,
      contacts: asArr(structured?.contacts),
      cta: '转人工'
    }
  }
}

/** 兼容旧占位实现的导出（(code, structured) → Refusal），api.js 若有引用不会挂 */
export function makeRefusal(code = 'out_of_scope', structured = {}) {
  return buildRefusal('zh', code, structured).refusal
}

/** 兼容旧占位实现的导出：只做规则层分类 */
export function guardFallback(text = '') {
  const rule = scanSensitive(text)
  const code = ruleRefusalCode(String(text || ''), rule) || (rule.flags[0] || 'out_of_scope')
  return { flags: rule.flags, allow: !rule.flags.length, reason_code: code }
}

/* ---------------------------------------------------------------------------
 * 2. 本地复述（模型不可用时的安全兜底：只搬通知里的字段，绝不生成建议）
 * -------------------------------------------------------------------------*/
const FIELD_HINTS = {
  materials: [
    '材料', '带', '携带', '准备', '证件', 'document', 'bring', 'need', 'material',
    'документ', 'принести', 'nên mang', 'tài liệu', 'giấy tờ', 'mang', 'เอกสาร', 'นำ',
    'dokumen', 'bawa'
  ],
  deadline: [
    '时间', '截止', '什么时候', '几号', '几点', '期限', 'deadline', 'when', 'until',
    'by when', 'срок', 'когда', 'дедлайн', 'hạn', 'khi nào', 'กำหนด', 'เมื่อไหร่',
    'tenggat', 'kapan', 'jam'
  ],
  place: [
    '地点', '在哪', '哪里', '哪儿', '楼', '办公室', 'where', 'place', 'где', 'куда',
    'ở đâu', 'địa điểm', 'ที่ไหน', 'สถานที่', 'di mana', 'tempat', 'lokasi'
  ],
  actions: [
    '做什么', '怎么办', '流程', '步骤', '怎么弄', '如何', 'what do i', 'what should',
    'steps', 'что делать', 'как', 'làm gì', 'thủ tục', 'ยังไง', 'ต้องทำอะไร',
    'apa yang harus', 'bagaimana'
  ],
  contacts: [
    '谁', '联系人', '联系', '电话', '找谁', '咨询', 'contact', 'who', 'phone', 'call',
    'кто', 'кому', 'телефон', 'liên hệ', 'ai', 'điện thoại', 'ติดต่อ', 'ใคร', 'เบอร์',
    'siapa', 'kontak', 'telepon'
  ],
  consequence: [
    '后果', '逾期', '处罚', '罚', 'consequence', 'late', 'penalty', 'последств',
    'просроч', 'hậu quả', 'quá hạn', 'ผล', 'เกินกำหนด', 'konsekuensi', 'terlambat'
  ]
}

function pickFields(question) {
  const low = lower(question)
  const hit = {}
  for (const [field, words] of Object.entries(FIELD_HINTS)) {
    hit[field] = words.some((w) => low.includes(lower(w)))
  }
  return hit
}

function contactsText(structured, _lang) {
  return asArr(structured?.contacts)
    .map((c) => [c?.name, c?.phone].filter(Boolean).join(' '))
    .filter(Boolean)
    .join(' / ')
}

/**
 * 纯本地复述：把通知里和问题相关的字段原样搬出来。
 * 不解释、不建议、不推测 —— 所以模型挂了也能安全回答。
 * @returns {string} 空字符串表示通知里没有可复述的内容
 */
export function restateFromNotice(question, structured, lang) {
  const L = normalizeLang(lang)
  const s = structured || {}
  const labels = PROMPTS.RESTATE_LABELS[L] || PROMPTS.RESTATE_LABELS.en
  const h = pickFields(question)
  const lines = []

  if (h.materials && asArr(s.materials).length) {
    lines.push(`${labels.materials}: ${asArr(s.materials).filter(Boolean).join(' / ')}`)
  }
  if (h.deadline && (s.deadline?.raw || s.deadline?.iso)) {
    lines.push(`${labels.deadline}: ${s.deadline.raw || s.deadline.iso}`)
  }
  if (h.place && s.place?.raw) {
    lines.push(`${labels.place}: ${s.place.raw}${s.place.note ? ` (${s.place.note})` : ''}`)
  }
  if (h.actions && asArr(s.actions).length) {
    const steps = asArr(s.actions)
      .map((a) => a?.zh)
      .filter(Boolean)
    if (steps.length) lines.push(`${labels.actions}: ${steps.join(' → ')}`)
  }
  if (h.consequence && s.consequence) {
    lines.push(`${labels.consequence}: ${s.consequence}`)
  }
  if (h.contacts) {
    const c = contactsText(s, L)
    if (c) lines.push(`${labels.contacts}: ${c}`)
  }

  if (!lines.length) {
    // 没有明显命中字段 → 给通知的结论行（仍然只是复述）
    const fallback = []
    if (s.one_line) fallback.push(s.one_line)
    if (s.deadline?.raw || s.deadline?.iso) {
      fallback.push(`${labels.deadline}: ${s.deadline.raw || s.deadline.iso}`)
    }
    const first = asArr(s.actions).map((a) => a?.zh).filter(Boolean)[0]
    if (first) fallback.push(`${labels.actions}: ${first}`)
    if (!fallback.length) return ''
    const c = contactsText(s, L)
    if (c) fallback.push(`${labels.contacts}: ${c}`)
    return fallback.join('\n')
  }

  const c = contactsText(s, L)
  if (c && !h.contacts) lines.push(`${labels.contacts}: ${c}`)
  return lines.join('\n')
}

/* ---------------------------------------------------------------------------
 * 3. 后置检查：允许回答里不允许出现建议性措辞
 * -------------------------------------------------------------------------*/
const ADVICE_IN_ANSWER = [
  /建议/, /应该/, /应当/, /最好你/, /你可以考虑/, /(可以|我)帮你/, /我可以帮/,
  /我推荐/, /推荐你/, /不妨/, /不妨你/,
  /\byou should\b/i, /\byou'd better\b/i, /\byou had better\b/i, /\bI recommend\b/i,
  /\bI suggest\b/i, /\bI advise\b/i, /\bin my (opinion|view)\b/i, /\bif I were you\b/i,
  /\byou can also\b/i, /\bmy advice\b/i,
  /рекомендую/i, /советую/i, /вам лучше/i, /следует вам/i, /по моему мнению/i,
  /khuyên bạn/i, /bạn nên/i, /tôi nghĩ/i, /theo tôi/i, /tốt hơn là/i,
  /แนะนำให้/i, /คุณควร/i, /(ผม|ฉัน)คิดว่า/i, /น่าจะดีกว่า/i,
  /sebaiknya/i, /saya sarankan/i, /menurut saya/i, /lebih baik anda/i
]

/** 回答里出现建议性措辞就要重写成复述 */
export function containsAdvice(text) {
  const t = String(text || '')
  return ADVICE_IN_ANSWER.some((re) => re.test(t))
}

/* ---------------------------------------------------------------------------
 * 4. 模型层
 * -------------------------------------------------------------------------*/
function normalizeVerdict(json) {
  const o = json && typeof json === 'object' && !Array.isArray(json) ? json : {}
  const scope = ['in_notice', 'out_of_scope', 'sensitive_advice'].includes(o.scope) ? o.scope : ''
  if (!scope) return null
  const allowedCodes = [...RISK_CODES, 'out_of_scope', 'sensitive_advice', 'in_notice']
  const raw = String(o.reason_code || '').trim()
  return {
    scope,
    reason_code: allowedCodes.includes(raw) ? raw : '',
    basis: String(o.basis || '').slice(0, 160)
  }
}

/** 延迟导入 ai.js：避免与 ai.js 形成静态循环依赖（ai.js 静态 import 了本文件的规则层） */
let aiMod = null
async function ai() {
  if (!aiMod) aiMod = await import('./ai.js')
  return aiMod
}

/* ---------------------------------------------------------------------------
 * 5. 唯一出口
 * -------------------------------------------------------------------------*/
/**
 * 敏感问题守门员。永不抛错（fail-closed）。
 * @param {{question:string, lang?:string, structured?:object, notice?:object}} args
 * @returns {Promise<{allowed:boolean, answer?:string, refusal?:object}>}
 */
export async function guardAsk({ question, lang, structured, notice } = {}) {
  const L = normalizeLang(lang)
  const s = structured || notice?.structured || {}
  const t0 = Date.now()

  try {
    const q = String(question ?? '').trim().slice(0, 500)
    if (!q) return buildRefusal(L, 'out_of_scope', s)

    // ---- 第 1 层：规则层（确定性） ----
    const rule = scanSensitive(q)
    const hard = ruleRefusalCode(q, rule)
    if (hard) {
      console.log(
        `[guard] rule-deny ${hard} ${Date.now() - t0}ms flags=${rule.flags.join('|')} advice=${rule.advice} state=${rule.personalState}`
      )
      return buildRefusal(L, hard, s)
    }

    // ---- 第 2 层：模型层 ----
    let verdict = null
    try {
      const { chatJSON } = await ai()
      const { json } = await chatJSON(
        PROMPTS.scopeSystem,
        PROMPTS.buildScopeUser({ question: q, structured: s, ruleHits: rule }),
        { maxTokens: 300, temperature: 0, timeoutMs: 15000, label: 'guardAsk' }
      )
      verdict = normalizeVerdict(json)
      if (!verdict) console.warn('[guard] 模型层输出不合格（scope 缺失），退回规则层')
    } catch (e) {
      console.warn(`[guard] 模型层不可用（${e.message}），退回规则层`)
    }

    if (!verdict) {
      // 退回规则层：五类有命中就拒绝；否则只允许「纯复述」
      if (rule.flags.length) {
        console.log(`[guard] fallback-deny ${rule.flags[0]} ${Date.now() - t0}ms`)
        return buildRefusal(L, rule.flags[0], s)
      }
      const local = restateFromNotice(q, s, L)
      if (local) {
        console.log(`[guard] fallback-restate ${Date.now() - t0}ms`)
        return { allowed: true, answer: local }
      }
      console.log(`[guard] fallback-deny out_of_scope ${Date.now() - t0}ms（无可复述内容）`)
      return buildRefusal(L, 'out_of_scope', s)
    }

    if (verdict.scope === 'in_notice') {
      // 双保险：规则层判定「五类 + 求建议/个人异常状态」时不因模型放行而开口子
      if (rule.flags.length && (rule.advice || rule.personalState) && !NOTICE_QUOTE.test(q)) {
        console.log(`[guard] override-deny ${rule.flags[0]} ${Date.now() - t0}ms（规则层否决模型的 in_notice）`)
        return buildRefusal(L, rule.flags[0], s)
      }
      // 允许回答，但回答只能来自 answerFromNotice，并在返回前做措辞后置检查
      let answer = ''
      try {
        const { answerFromNotice } = await ai()
        answer = await answerFromNotice(q, s, L)
      } catch (e) {
        console.warn(`[guard] answerFromNotice 失败，改用本地复述：${e.message}`)
        answer = ''
      }
      if (!answer.trim()) answer = restateFromNotice(q, s, L)
      if (answer && containsAdvice(answer)) {
        console.warn('[guard] 回答里出现建议性措辞，已重写为复述')
        answer = restateFromNotice(q, s, L) || PROMPTS.notFoundText(s, L)
      }
      if (!answer.trim()) return buildRefusal(L, 'out_of_scope', s)
      console.log(`[guard] allow ${Date.now() - t0}ms`)
      return { allowed: true, answer }
    }

    // out_of_scope / sensitive_advice → 拒绝
    const code =
      verdict.reason_code && verdict.reason_code !== 'in_notice'
        ? verdict.reason_code
        : rule.flags[0] ||
          (verdict.scope === 'sensitive_advice' ? 'sensitive_advice' : 'out_of_scope')
    console.log(`[guard] model-deny ${code} ${Date.now() - t0}ms scope=${verdict.scope}`)
    return buildRefusal(L, code, s)
  } catch (e) {
    // fail-closed：任何意外都按拒绝处理，且拒绝结构永远是完整的
    console.error(`[guard] guardAsk 异常，按拒绝处理：${e?.message || e}`)
    return buildRefusal(L, 'out_of_scope', s)
  }
}

export default guardAsk
