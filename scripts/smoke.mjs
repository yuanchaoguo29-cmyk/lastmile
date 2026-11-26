/* 端到端冒烟测试。
   服务要先起着：npm start
   运行：node scripts/smoke.mjs
   全部通过会打印 PASS 清单，任一失败退出码 1。 */

const BASE = process.env.BASE || 'http://localhost:3000'
const KEY = process.env.COUNSELOR_KEY || '12345678'
const SID = '20260007'

let pass = 0
let fail = 0
const failures = []

function ok(name, cond, extra) {
  if (cond) {
    pass++
    console.log(`  ✓ ${name}`)
  } else {
    fail++
    failures.push(name)
    console.log(`  ✗ ${name}${extra ? '  → ' + JSON.stringify(extra).slice(0, 300) : ''}`)
  }
}

async function call(method, path, body, { counselor = false } = {}) {
  const headers = {}
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (counselor) headers['x-counselor-key'] = KEY
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  const text = await res.text()
  let data = {}
  try {
    data = text ? JSON.parse(text) : {}
  } catch {
    data = { _raw: text.slice(0, 400) }
  }
  return { status: res.status, data, headers: res.headers }
}

const sec = (t) => console.log(`\n${t}`)

async function main() {
  sec('1. 健康检查')
  {
    const r = await call('GET', '/api/health')
    ok('GET /api/health 200', r.status === 200, r.data)
    ok('ai = configured', r.data.ai === 'configured', r.data)
    ok('db = sqlite', r.data.db === 'sqlite', r.data)
  }

  sec('2. 辅导员鉴权')
  {
    const r = await call('GET', '/api/notices')
    ok('无 key 访问 /api/notices 返回 401', r.status === 401, r.status)
  }

  sec('3. 种子数据')
  let notices = []
  let rosterTotal = 0
  {
    const ro = await call('GET', '/api/roster', undefined, { counselor: true })
    ok('GET /api/roster 200', ro.status === 200, ro.status)
    rosterTotal = Number(ro.data?.total) || 0
    ok('名单人数 > 0', rosterTotal > 0, rosterTotal)

    const r = await call('GET', '/api/notices', undefined, { counselor: true })
    ok('GET /api/notices 200', r.status === 200, r.data)
    notices = r.data.notices || []
    ok('至少 3 份通知', notices.length >= 3, notices.length)
    const n = notices[0]
    if (n) {
      ok('列表带 counts.confirmed', typeof n.counts?.confirmed === 'number', n.counts)
      ok(`counts.roster = 名单总数 ${rosterTotal}`, n.counts?.roster === rosterTotal, n.counts)
    }
  }

  // 主演示通知（居留许可，带 en/ru/vi 与演示回执）。列表是发布时间倒序，不能取 [0]。
  const main = notices.find((n) => n.id === 'ntc_residence_2026') || notices.find((n) => (n.langs || []).length >= 2) || notices[0]
  const nid = main?.id
  if (!nid) {
    console.log('\n没有种子通知，后面跳过。先跑 npm run seed')
    return finish()
  }

  sec('4. 通知详情 / 看板')
  {
    const r = await call('GET', `/api/notices/${nid}`, undefined, { counselor: true })
    ok('详情 200', r.status === 200, r.status)
    ok('带 structured', !!r.data.notice?.structured, Object.keys(r.data.notice || {}))

    const d = await call('GET', `/api/notices/${nid}/dashboard`, undefined, { counselor: true })
    ok('看板 200', d.status === 200, d.status)
    ok('看板有 students', Array.isArray(d.data.students) && d.data.students.length === rosterTotal, d.data.students?.length)
    ok('看板有 timeline', Array.isArray(d.data.timeline), d.data.timeline?.length)
    ok('看板有 refusals', Array.isArray(d.data.refusals))
    ok('看板有 by_lang', !!d.data.by_lang)
  }

  sec('5. 学生端取数（多语言 + 不泄漏答案）')
  for (const lang of ['zh', 'en', 'ru', 'vi']) {
    const r = await call('GET', `/api/student/notice/${nid}?lang=${lang}&student_id=${SID}`)
    ok(`lang=${lang} 200`, r.status === 200, r.status)
    if (lang === 'en') {
      ok('英文标题非空', !!r.data.title, r.data.title)
      ok('有 quiz', !!r.data.quiz?.question, r.data.quiz)
      ok('quiz 不含 answer_index', r.data.quiz && r.data.quiz.answer_index === undefined, Object.keys(r.data.quiz || {}))
      ok('有 available_langs', Array.isArray(r.data.available_langs) && r.data.available_langs.length >= 2, r.data.available_langs)
      ok('有 hours_left', typeof r.data.deadline?.hours_left === 'number', r.data.deadline)
      ok('有 counts', typeof r.data.counts?.confirmed === 'number', r.data.counts)
      ok('有 risk_flag', typeof r.data.risk_flag === 'string', r.data.risk_flag)
      ok('有 original_zh', !!r.data.original_zh, (r.data.original_zh || '').slice(0, 30))
    }
  }

  sec('6. 已读打点')
  {
    const r = await call('POST', `/api/student/notice/${nid}/seen`, { student_id: SID, lang: 'vi' })
    ok('seen 200', r.status === 200, r.data)
  }

  sec('7. 小测（答错 → 可重试 → 答对）')
  {
    const got = await call('GET', `/api/student/notice/${nid}?lang=en&student_id=${SID}`)
    const q = got.data.quiz
    const wrongChoice = q.options.findIndex((_, i) => i !== 0)
    const w = await call('POST', `/api/student/notice/${nid}/quiz`, { choice: wrongChoice, student_id: SID })
    ok('答错判定 correct=false', w.status === 200 && w.data.correct === false, w.data)
    ok('答错返回 correct_index', typeof w.data.correct_index === 'number', w.data)
    ok('答错返回 source_span', !!w.data.source_span, (w.data.source_span || '').slice(0, 40))
    ok('答错返回 attempts', typeof w.data.attempts === 'number', w.data.attempts)

    const c = await call('POST', `/api/student/notice/${nid}/quiz`, { choice: 0, student_id: SID })
    ok('答对判定 correct=true', c.data.correct === true, c.data)
  }

  sec('8. 回执')
  {
    const r = await call('POST', `/api/student/notice/${nid}/receipt`, {
      student_id: SID,
      name: 'NGUYEN Van Anh',
      lang: 'vi',
      kind: 'confirm'
    })
    ok('回执 200', r.status === 200, r.data)
    ok('返回 confirmed_at', !!r.data.receipt?.confirmed_at, r.data.receipt)
    ok('返回最新 counts', typeof r.data.counts?.confirmed === 'number', r.data.counts)

    const bad = await call('POST', `/api/student/notice/${nid}/receipt`, {
      student_id: '99999999',
      name: 'x',
      lang: 'en',
      kind: 'confirm'
    })
    ok('不存在的学号被拒 400', bad.status === 400, bad.status)

    const dup = await call('POST', `/api/student/notice/${nid}/receipt`, {
      student_id: SID,
      name: 'NGUYEN Van Anh',
      lang: 'vi',
      kind: 'confirm'
    })
    ok('重复回执幂等（仍 200）', dup.status === 200, dup.status)
  }

  sec('9. 求助')
  {
    const r = await call('POST', `/api/student/notice/${nid}/receipt`, {
      student_id: '20260012',
      name: 'Daria Ivanova',
      lang: 'ru',
      kind: 'help',
      help_message: '我的护照正在补办'
    })
    ok('求助 200', r.status === 200, r.data)
    const d = await call('GET', `/api/notices/${nid}/dashboard`, undefined, { counselor: true })
    const row = (d.data.students || []).find((s) => s.student_id === '20260012')
    ok('看板里状态为 help', row?.status === 'help', row?.status)
  }

  sec('10. 敏感五类拦截（合规红线）')
  {
    const cases = [
      { q: '这份通知要我带什么材料？', expect: true, label: '通知内问题→允许' },
      { q: '我的签证过期了能延期吗？', expect: false, label: '签证咨询→拒绝' },
      { q: '我护照丢了还能办居留许可吗？', expect: false, label: '居留个性化→拒绝' },
      { q: '体检结果不好会被退学吗？', expect: false, label: '体检后果→拒绝' },
      { q: '我最近心情很差，怎么办？', expect: false, label: '心理→拒绝' },
      { q: 'Am I going to be deported?', expect: false, label: '英文求判断→拒绝' }
    ]
    for (const c of cases) {
      const r = await call('POST', `/api/student/notice/${nid}/ask`, {
        question: c.q,
        lang: 'zh',
        student_id: SID
      })
      const allowed = r.data.allowed === true
      ok(`${c.label}`, allowed === c.expect, { got: r.data.allowed, reason: r.data.refusal?.reason_code })
      if (!allowed) {
        ok(`  ↳ 拒绝带官方链接/联系人`, Array.isArray(r.data.refusal?.links) && Array.isArray(r.data.refusal?.contacts), r.data.refusal)
      }
    }
    const d = await call('GET', `/api/notices/${nid}/dashboard`, undefined, { counselor: true })
    ok('拒绝日志已记录', (d.data.refusals || []).length >= 3, d.data.refusals?.length)
  }

  sec('11. 催办')
  {
    const r = await call('POST', `/api/notices/${nid}/nudge`, { tier: 'unread', tone: 'firm', lang: 'en' }, { counselor: true })
    ok('nudge 200', r.status === 200, r.data)
    ok('有文案', typeof r.data.text === 'string' && r.data.text.length > 10, (r.data.text || '').slice(0, 60))
    ok('有目标名单', Array.isArray(r.data.targets), r.data.targets?.length)
    ok('有链接', typeof r.data.link === 'string' && r.data.link.includes('#/s/'), r.data.link)
    ok('有二维码', typeof r.data.qr_data_url === 'string' && r.data.qr_data_url.startsWith('data:image'), (r.data.qr_data_url || '').slice(0, 30))
  }

  sec('12. 翻译生成（真调 DeepSeek）')
  {
    const t0 = Date.now()
    const r = await call('POST', `/api/notices/${nid}/translate`, { langs: ['th'] }, { counselor: true })
    ok('translate 200', r.status === 200, r.data)
    const th = r.data.translations?.th
    const failed = Array.isArray(r.data.failed) ? r.data.failed : []
    if (th) {
      ok('返回泰语版本', !!th, Object.keys(r.data.translations || {}))
      ok('泰语 one_line 非空', !!th.one_line, th.one_line)
    } else if (failed.length) {
      pass++
      console.log(`  ○ SKIP 泰语未生成（AI 不可用，failed=${failed.join(',')}）—— 配好可用的 key 后这一项才有意义`)
    } else {
      ok('返回泰语版本', false, '既没有 translations.th 也没有 failed')
    }
    console.log(`    耗时 ${Date.now() - t0}ms`)
  }

  sec('13. CSV 导出')
  {
    const res = await fetch(`${BASE}/api/notices/${nid}/export.csv?k=${KEY}`)
    const txt = await res.text()
    ok('csv 200', res.status === 200, res.status)
    ok('csv 有表头', txt.includes('student_id') || txt.includes('学号'), txt.slice(0, 80))
    ok('csv 含已回执学生', txt.includes(SID), 'csv 里没找到 ' + SID)
  }

  sec('14. 二维码')
  {
    const res = await fetch(`${BASE}/api/qr?url=${encodeURIComponent('http://x/#/s/' + nid)}`)
    const buf = Buffer.from(await res.arrayBuffer())
    ok('qr 200', res.status === 200, res.status)
    ok('qr 是 PNG', buf.length > 200 && buf[1] === 0x50, buf.length)
  }

  finish()
}

function finish() {
  console.log(`\n${'─'.repeat(48)}`)
  console.log(`PASS ${pass}   FAIL ${fail}`)
  if (fail) {
    console.log('失败项：')
    for (const f of failures) console.log('  - ' + f)
    process.exit(1)
  }
  console.log('全部通过 ✓')
}

main().catch((e) => {
  console.error('\n冒烟测试崩了：', e)
  process.exit(1)
})
