/* LastMile 种子数据 —— 归属 A（后端）。
   三份真实通知（正文照抄 docs/seed-notices.md，一个字都不改）+ 114 人名单 + 通知 1 的演示回执。
   - 首次启动：createApiRouter() 里调 seedIfEmpty()，notices 非空就什么都不做。
   - 手工执行：node server/seed.js          → 只在空库时灌数据
                node server/seed.js --reset  → 清空 receipts / quiz_attempts / refusals / events，
                                              保留 notices 与 students（用于真实的 48h 实测） */

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getDb, tx, uid } from './db.js'

/* =========================================================================
   一、三份通知正文（冻结，照抄 docs/seed-notices.md）
   ========================================================================= */

const RAW_1 = `关于2026级国际学生办理居留许可延期的通知

2026级全体国际学生：

根据成都市公安局出入境管理局要求，我校国际学生居留许可即将集中到期。现将统一办理延期事宜通知如下：

一、办理对象：2026级全体国际学生（含本科生、硕士研究生），共114人。
二、办理时间：2026年11月25日（周三）17:00前，工作日上午9:00-11:30、下午14:00-17:00。
三、办理地点：柳林校区通博楼A座204办公室（国际学生事务中心）。
四、所需材料：
  1. 护照原件及复印件1份（照片页、签证页、入境章页）；
  2. 学生证原件；
  3. 填写完整的《外国人签证证件申请表》（现场领取）；
  4. 近期免冠白底照片2张（2寸）。
五、注意事项：须本人到场办理，不接受代办。逾期未办理者，居留许可过期将按非法居留处理，后果自负。
六、联系人：张老师，028-87092233；李老师，028-87092234。

西南财经大学经济与管理研究院 学生工作办公室
2026年11月18日`

const RAW_2 = `关于2026-2027学年第一学期国际学生期中考试安排的通知

各位国际学生：

本学期期中考试定于第12教学周进行，现将有关事项通知如下：

一、考试时间：2026年11月24日（周二）至11月28日（周六），具体场次及座位号见附件《期中考试安排表》。
二、考试地点：柳林校区经世楼B座3楼（B301-B308教室），请提前15分钟入场。
三、须携带：学生证、护照；两证缺一不得入场。
四、缓考申请：因病因事不能参加考试者，须于11月21日17:00前向学院教务办公室提交书面缓考申请及证明材料，逾期不予受理。
五、考试纪律：严禁携带手机、智能手表等电子设备进入考场，违纪按《西南财经大学学生考试违纪处理办法》处理。

特此通知。

经济与管理研究院 教务办公室
2026年11月14日`

const RAW_3 = `关于开展2026级国际学生入学体检及健康证明补交工作的通知

2026级国际学生：

根据《中华人民共和国出境入境管理法》及学校卫生防疫要求，现将入学体检及健康证明补交工作通知如下：

一、体检时间：2026年11月26日（周四）至11月27日（周五），每日8:00-11:00，须空腹。
二、体检地点：成都市青羊区妇幼保健院体检中心（地铁4号线中坝站B口步行约600米）。
三、体检项目：常规检查、胸部X光、肝功能、艾滋病及梅毒血清学检测（法定项目）。
四、须携带：护照、2寸照片1张、体检费约280元（现金或微信支付）。
五、已持有6个月内有效《外国人体格检查记录》者，可于11月25日前将复印件交至通博楼A座204，免于重复体检。
六、体检结果异常的，须按疾控部门要求复查；涉及医疗、签证的具体问题请咨询国际学生事务中心，勿自行处理。

经济与管理研究院 学生工作办公室
2026年11月17日`

/* =========================================================================
   二、手写的 StructuredNotice（严格按 docs/api.md §2.1）
   spans 一律是正文里的原文子串，前端「点回去看原文」靠它高亮
   ========================================================================= */

const STRUCTURED_1 = {
  title_zh: '关于2026级国际学生办理居留许可延期的通知',
  kind: 'residence_permit',
  one_line: '11月25日17:00前，本人带护照原件到通博楼A座204办公室办居留许可延期，不接受代办',
  who: '2026级全体国际学生（含本科生、硕士研究生），共114人',
  what: '根据成都市公安局出入境管理局要求，学校统一组织2026级国际学生办理居留许可延期，须本人到现场提交材料。',
  actions: [
    {
      order: 1,
      zh: '备齐材料：护照原件及复印件1份（照片页、签证页、入境章页）、学生证原件、2张2寸白底免冠照片',
      en: 'Prepare your passport (original + 1 copy of the photo, visa and entry-stamp pages), your student ID card, and 2 white-background 2-inch photos'
    },
    {
      order: 2,
      zh: '11月25日17:00前，本人到柳林校区通博楼A座204办公室（国际学生事务中心）现场领取并填写《外国人签证证件申请表》',
      en: 'Before 25 Nov 17:00, go in person to Room 204, Tongbo Building A (International Student Affairs Center) and fill in the visa application form on site'
    },
    {
      order: 3,
      zh: '本人到场提交材料并确认受理（不接受代办）',
      en: 'Submit the documents in person and confirm they are accepted (no agents allowed)'
    },
    {
      order: 4,
      zh: '有问题打张老师 028-87092233 / 李老师 028-87092234（工作日 9:00-11:30、14:00-17:00）',
      en: 'Questions: Ms Zhang 028-87092233 / Ms Li 028-87092234 (workdays 9:00-11:30, 14:00-17:00)'
    }
  ],
  deadline: {
    raw: '2026年11月25日（周三）17:00前',
    iso: '2026-11-25T17:00:00+08:00',
    confidence: 'high',
    basis: '原文写明绝对日期 + 时间，且写明工作日受理时段'
  },
  materials: [
    '护照原件及复印件1份（照片页、签证页、入境章页）',
    '学生证原件',
    '《外国人签证证件申请表》（现场领取并填写）',
    '近期免冠白底照片2张（2寸）'
  ],
  place: {
    raw: '柳林校区通博楼A座204办公室（国际学生事务中心）',
    note: '受理时间：工作日上午9:00-11:30、下午14:00-17:00'
  },
  consequence: '逾期未办理者，居留许可过期将按非法居留处理，后果自负。',
  // 官方链接只用真实可访问的页面（居留许可 / 签证两类敏感问题的固定出口）
  official_links: [
    {
      label: '国际教育学院 · 签证及居留许可',
      url: 'http://international.swufe.edu.cn/xyshyfw1/qzjjlxk.htm'
    },
    { label: '国家移民管理局', url: 'https://www.nia.gov.cn/' }
  ],
  contacts: [
    { name: '张老师', phone: '028-87092233', note: '工作日 9:00-17:00' },
    { name: '李老师', phone: '028-87092234', note: '工作日 9:00-17:00' }
  ],
  risk_flags: ['residence_permit'],
  spans: {
    deadline: '2026年11月25日（周三）17:00前',
    place: '柳林校区通博楼A座204办公室（国际学生事务中心）',
    actions: [
      '护照原件及复印件1份（照片页、签证页、入境章页）',
      '学生证原件',
      '填写完整的《外国人签证证件申请表》（现场领取）',
      '近期免冠白底照片2张（2寸）'
    ]
  },
  warnings: [
    '「逾期未办理将按非法居留处理」涉及居留许可，学生追问一律转官方渠道，不自行解释',
    '受理时间只在工作日：11月25日是周三，注意上午 9:00-11:30 / 下午 14:00-17:00 两个时段'
  ]
}

const STRUCTURED_2 = {
  title_zh: '关于2026-2027学年第一学期国际学生期中考试安排的通知',
  kind: 'exam',
  one_line: '期中考11月24-28日，考场经世楼B座3楼B301-B308；不能参加须在11月21日17:00前书面申请缓考',
  who: '2026-2027学年第一学期全体国际学生',
  what: '本学期期中考试在第12教学周（11月24日至28日）进行，考场设在柳林校区经世楼B座3楼B301-B308，须提前15分钟入场，学生证与护照缺一不得入场。',
  actions: [
    {
      order: 1,
      zh: '查收附件《期中考试安排表》，确认自己的场次和座位号',
      en: 'Check the attached exam schedule to find your session and seat number'
    },
    {
      order: 2,
      zh: '11月24日-28日，带学生证 + 护照，提前15分钟到经世楼B座3楼对应教室（B301-B308）',
      en: 'Between 24 and 28 Nov, bring your student ID and passport and arrive 15 minutes early at your room in Building B (3F, B301-B308)'
    },
    {
      order: 3,
      zh: '因病因事不能参加：11月21日17:00前，向学院教务办公室提交书面缓考申请 + 证明材料',
      en: 'If you cannot attend: submit a written deferral application with supporting documents to the teaching office before 21 Nov 17:00'
    },
    {
      order: 4,
      zh: '手机、智能手表等电子设备一律不带入考场',
      en: 'Do not bring phones, smart watches or other electronic devices into the exam room'
    }
  ],
  deadline: {
    raw: '11月21日17:00前（缓考申请截止）',
    iso: '2026-11-21T17:00:00+08:00',
    confidence: 'high',
    basis: '原文有两个时间点：考试 11月24-28日、缓考申请 11月21日17:00 前；主截止取更早的缓考申请'
  },
  materials: ['学生证', '护照', '书面缓考申请及证明材料（仅申请缓考者需要）'],
  place: {
    raw: '柳林校区经世楼B座3楼（B301-B308教室）',
    note: '具体场次与座位号见附件《期中考试安排表》；提前15分钟入场'
  },
  consequence: '两证缺一不得入场；违纪按《西南财经大学学生考试违纪处理办法》处理；缓考逾期不予受理。',
  official_links: [{ label: '西南财经大学教务处', url: 'https://jwc.swufe.edu.cn/' }],
  contacts: [
    { name: '学院教务办公室', phone: '', note: '缓考申请、考场与座位号咨询' },
    {
      name: '学校本科教务咨询中心',
      phone: '028-87092237',
      note: '缓考/考试安排咨询（教务处官网公布）'
    }
  ],
  risk_flags: [],
  spans: {
    deadline: '须于11月21日17:00前向学院教务办公室提交书面缓考申请及证明材料',
    place: '柳林校区经世楼B座3楼（B301-B308教室）',
    actions: [
      '具体场次及座位号见附件《期中考试安排表》',
      '学生证、护照；两证缺一不得入场',
      '请提前15分钟入场'
    ]
  },
  warnings: [
    '原文含两个时间点：考试 11月24-28日、缓考申请截止 11月21日17:00。卡片主截止取缓考申请截止，考试区间在「这件事是什么」里单独写明',
    '「具体场次及座位号见附件《期中考试安排表》」，附件未随通知提供，需人工补充或向教务办公室索取'
  ]
}

const STRUCTURED_3 = {
  title_zh: '关于开展2026级国际学生入学体检及健康证明补交工作的通知',
  kind: 'medical',
  one_line: '11月26日或27日上午8:00-11:00空腹到青羊区妇幼保健院体检中心体检；已有6个月内体检记录的11月25日前交复印件到通博楼A座204可免检',
  who: '2026级全体国际学生',
  what: '按《中华人民共和国出境入境管理法》及学校卫生防疫要求，学院组织入学体检并补交健康证明，法定项目含胸部X光、肝功能、艾滋病及梅毒血清学检测。',
  actions: [
    {
      order: 1,
      zh: '11月26日或27日上午8:00-11:00 空腹前往体检中心（当天早上不要吃东西）',
      en: 'Go to the medical examination center on 26 or 27 Nov between 08:00 and 11:00, fasting (do not eat that morning)'
    },
    {
      order: 2,
      zh: '携带护照、2寸照片1张、体检费约280元（现金或微信支付）',
      en: 'Bring your passport, one 2-inch photo, and about CNY 280 (cash or WeChat Pay)'
    },
    {
      order: 3,
      zh: '已持有6个月内有效《外国人体格检查记录》的：11月25日前把复印件交到通博楼A座204，可免于重复体检',
      en: 'If you already have a valid Physical Examination Record for Foreigners within 6 months: hand a copy to Room 204, Tongbo Building A before 25 Nov to skip the exam'
    },
    {
      order: 4,
      zh: '体检结果异常的，按疾控部门要求复查；医疗、签证的具体问题咨询国际学生事务中心，不要自行处理',
      en: 'If a result is abnormal, follow the CDC re-examination notice; ask the International Student Affairs Center about medical or visa issues, do not handle it yourself'
    }
  ],
  deadline: {
    raw: '11月25日前（免检材料提交）；11月26-27日 8:00-11:00（体检）',
    iso: '2026-11-25T17:00:00+08:00',
    confidence: 'low',
    basis: '原文有两个时间点且「11月25日前」没写具体时刻，按当日 17:00 估算，需人工确认'
  },
  materials: [
    '护照',
    '2寸照片1张',
    '体检费约280元（现金或微信支付）',
    '6个月内有效《外国人体格检查记录》复印件（仅免检者）'
  ],
  place: {
    raw: '成都市青羊区妇幼保健院体检中心',
    note: '地铁4号线中坝站B口步行约600米；体检当日须空腹'
  },
  consequence: '体检结果异常的，须按疾控部门要求复查，具体以疾控部门通知为准。',
  official_links: [
    { label: '西南财经大学校医院 · 医疗服务', url: 'https://houqin.swufe.edu.cn/fwjj/ylfw.htm' },
    { label: '国际教育学院 · 校园服务', url: 'http://international.swufe.edu.cn/' }
  ],
  contacts: [
    {
      name: '国际学生事务中心（张老师）',
      phone: '028-87092233',
      note: '办公地点：通博楼A座204；医疗、签证问题请咨询这里'
    },
    {
      name: '校医院（柳林校区）急诊',
      phone: '028-87092120',
      note: '校医院 24 小时急诊；医院办公室 028-87081869（校医院官网公布）'
    }
  ],
  risk_flags: ['medical'],
  spans: {
    deadline: '11月25日前将复印件交至通博楼A座204',
    place: '成都市青羊区妇幼保健院体检中心（地铁4号线中坝站B口步行约600米）',
    actions: [
      '每日8:00-11:00，须空腹',
      '护照、2寸照片1张、体检费约280元（现金或微信支付）',
      '可于11月25日前将复印件交至通博楼A座204，免于重复体检'
    ]
  },
  warnings: [
    '涉及体检与健康证明（医疗类敏感），学生追问结果、复查、签证影响一律转官方渠道',
    '「11月25日前」没有具体时刻，卡片按当日 17:00 估算并标注 low 置信度，请辅导员确认',
    '体检费 280 元为原文金额，实际以医院收费为准'
  ]
}

/* =========================================================================
   三、中文母版 Quiz（每份 1 题，考「要做什么 + 什么时候截止」，答案只在服务端）
   source_span 必须是正文里的原文子串
   ========================================================================= */

const QUIZ_1 = {
  question: '这份通知要求你做什么？什么时候截止？',
  options: [
    '11月25日17:00前，本人带护照原件等材料到通博楼A座204办公室办居留许可延期',
    '在宿舍等老师上门收护照，学校统一代办',
    '在网上提交申请表，把护照复印件交给班长就行',
    '11月25日之后的工作日去也可以，不影响居留许可'
  ],
  answer_index: 0,
  source_span: '须本人到场办理，不接受代办',
  explain: '通知写明：2026年11月25日（周三）17:00前，本人携带护照原件等材料到通博楼A座204办公室办理，不接受代办。'
}

const QUIZ_2 = {
  question: '如果因病因事不能参加11月24-28日的期中考试，你必须做什么？',
  options: [
    '11月21日17:00前，向学院教务办公室提交书面缓考申请及证明材料',
    '考试当天给任课老师发个微信说明一下就可以',
    '先不参加考试，考完试再补交请假条',
    '直接缺考，等下学期跟班重修'
  ],
  answer_index: 0,
  source_span: '须于11月21日17:00前向学院教务办公室提交书面缓考申请及证明材料，逾期不予受理',
  explain: '缓考必须提前书面申请：11月21日17:00前把书面申请和证明材料交到学院教务办公室，逾期不予受理。'
}

const QUIZ_3 = {
  question: '这份通知要求你做什么？什么时候截止？',
  options: [
    '11月26日或27日上午8:00-11:00空腹去青羊区妇幼保健院体检中心体检；已有6个月内体检记录的，11月25日前把复印件交到通博楼A座204免检',
    '随便哪天上午去体检中心都可以，不用空腹',
    '把280元体检费交给辅导员，由学校统一代检',
    '先在校医院做完全部项目，再去体检中心复查'
  ],
  answer_index: 0,
  source_span: '一、体检时间：2026年11月26日（周四）至11月27日（周五），每日8:00-11:00，须空腹。',
  explain: '体检只在11月26-27日每天8:00-11:00，且须空腹；已有6个月内有效《外国人体格检查记录》的，11月25日前把复印件交到通博楼A座204可免检。'
}

/* =========================================================================
   四、通知 1 的三语翻译（en / ru / vi）。通知 2、3 故意不写，
   留给现场演示点「生成翻译」出真 AI 结果。
   quiz.answer_index 与中文母版保持一致（0）
   ========================================================================= */

const T1_EN = {
  lang: 'en',
  title: 'Residence Permit Extension for 2026 International Students',
  one_line:
    'Before 25 Nov 2026, 17:00, bring your passport in person to Room 204, Tongbo Building A, to extend your residence permit.',
  what: 'At the request of the Chengdu Public Security Bureau Exit-Entry Administration, the residence permits of our international students are about to expire. The university will handle all extensions in one batch. You must appear in person.',
  who: 'All 2026-cohort international students (114 in total, undergraduate and master’s).',
  actions: [
    {
      order: 1,
      text: 'Prepare your passport (original + 1 copy of the photo page, visa page and entry-stamp page), your student ID card, and 2 recent 2-inch white-background photos.'
    },
    {
      order: 2,
      text: 'Before 25 Nov 2026, 17:00, go in person to Room 204, Tongbo Building A (International Student Affairs Center), and fill in the Foreigner Visa Application Form on site.'
    },
    {
      order: 3,
      text: 'Submit the documents in person and confirm they are accepted. No agents or proxies are allowed.'
    },
    {
      order: 4,
      text: 'Questions: Ms Zhang 028-87092233 / Ms Li 028-87092234 (workdays 9:00-11:30, 14:00-17:00).'
    }
  ],
  deadline_text: '25 Nov 2026 (Wed), 17:00',
  place_text: 'Room 204, Tongbo Building A, Liulin Campus (International Student Affairs Center)',
  materials: [
    'Passport: original + 1 copy (photo page, visa page, entry-stamp page)',
    'Student ID card (original)',
    'Foreigner Visa Application Form (collect and fill in on site)',
    '2 recent 2-inch white-background photos'
  ],
  consequence:
    'If you do not apply in time, your expired residence permit will be treated as illegal residence, and you bear the consequences.',
  quiz: {
    question: 'What does this notice ask you to do, and by when?',
    options: [
      'Before 25 Nov 17:00, bring my passport and other documents in person to Room 204, Tongbo Building A, to extend my residence permit',
      'Stay in my dorm and wait for a teacher to collect my passport, the university handles it for me',
      'Submit an online form and give a copy of my passport to the class monitor',
      'Any workday after 25 Nov is fine, it does not affect my residence permit'
    ],
    answer_index: 0,
    source_span: '须本人到场办理，不接受代办',
    explain:
      'The notice says you must come in person (no agents) with your passport and other documents, before 25 Nov 2026, 17:00, to Room 204, Tongbo Building A.'
  }
}

const T1_RU = {
  lang: 'ru',
  title: 'Продление вида на жительство для иностранных студентов набора 2026 года',
  one_line:
    'До 25 ноября 2026 г., 17:00, лично принесите паспорт в каб. 204, корп. Тунбо A, чтобы продлить вид на жительство.',
  what: 'По требованию Управления по делам въезда и выезда УВД г. Чэнду срок действия вида на жительство иностранных студентов заканчивается. Университет оформляет продление централизованно. Явиться нужно лично.',
  who: 'Все иностранные студенты набора 2026 года (114 человек, бакалавры и магистранты).',
  actions: [
    {
      order: 1,
      text: 'Подготовьте паспорт (оригинал + 1 копия страницы с фото, визы и штампа о въезде), студенческий билет и 2 фотографии 2 дюйма на белом фоне.'
    },
    {
      order: 2,
      text: 'До 25.11.2026, 17:00, лично придите в каб. 204, корп. Тунбо A (Центр по работе с иностранными студентами) и заполните бланк заявления на визу на месте.'
    },
    { order: 3, text: 'Сдайте документы лично и убедитесь, что их приняли. Через посредников нельзя.' },
    {
      order: 4,
      text: 'Вопросы: г-жа Чжан 028-87092233 / г-жа Ли 028-87092234 (рабочие дни 9:00-11:30, 14:00-17:00).'
    }
  ],
  deadline_text: '25 ноября 2026 (среда), 17:00',
  place_text: 'каб. 204, корп. Тунбо A, кампус Люлинь (Центр по работе с иностранными студентами)',
  materials: [
    'Паспорт: оригинал + 1 копия (страница с фото, виза, штамп о въезде)',
    'Студенческий билет (оригинал)',
    'Бланк заявления на визу (получить и заполнить на месте)',
    '2 фотографии 2 дюйма на белом фоне'
  ],
  consequence:
    'Если не оформить вовремя, просроченный вид на жительство будет считаться незаконным пребыванием; ответственность несёте вы.',
  quiz: {
    question: 'Что нужно сделать и до какого срока?',
    options: [
      'До 25 ноября 17:00 лично принести паспорт и другие документы в каб. 204, корп. Тунбо A, для продления вида на жительство',
      'Ждать в общежитии, преподаватель сам придёт и заберёт паспорт',
      'Заполнить форму в интернете и отдать копию паспорта старосте группы',
      'Можно прийти в любой рабочий день после 25 ноября, на вид на жительство это не влияет'
    ],
    answer_index: 0,
    source_span: '须本人到场办理，不接受代办',
    explain:
      'В объявлении сказано: до 25.11.2026, 17:00, лично, с паспортом и остальными документами, в каб. 204, корп. Тунбо A. Через посредников нельзя.'
  }
}

const T1_VI = {
  lang: 'vi',
  title: 'Gia hạn giấy phép cư trú cho sinh viên quốc tế khóa 2026',
  one_line:
    'Trước 17:00 ngày 25/11/2026, đích thân mang hộ chiếu đến phòng 204, tòa nhà Thông Bác A để gia hạn giấy phép cư trú.',
  what: 'Theo yêu cầu của Cục Quản lý xuất nhập cảnh Công an TP. Thành Đô, giấy phép cư trú của sinh viên quốc tế sắp hết hạn. Nhà trường tổ chức gia hạn tập trung, sinh viên phải trực tiếp đến nộp.',
  who: 'Toàn bộ sinh viên quốc tế khóa 2026 (114 người, gồm đại học và thạc sĩ).',
  actions: [
    {
      order: 1,
      text: 'Chuẩn bị hộ chiếu (bản gốc + 1 bản photo trang ảnh, trang visa, trang dấu nhập cảnh), thẻ sinh viên và 2 ảnh 2 tấc nền trắng.'
    },
    {
      order: 2,
      text: 'Trước 17:00 ngày 25/11/2026, đích thân đến phòng 204, tòa nhà Thông Bác A (Trung tâm Công tác Sinh viên Quốc tế) nhận và điền tờ khai xin thị thực tại chỗ.'
    },
    { order: 3, text: 'Trực tiếp nộp hồ sơ và xác nhận đã được tiếp nhận, không được nhờ người làm thay.' },
    {
      order: 4,
      text: 'Có thắc mắc: cô Trương 028-87092233 / cô Lý 028-87092234 (ngày làm việc 9:00-11:30, 14:00-17:00).'
    }
  ],
  deadline_text: '17:00 ngày 25/11/2026 (thứ Tư)',
  place_text: 'Phòng 204, tòa nhà Thông Bác A, cơ sở Liễu Lâm (Trung tâm Công tác Sinh viên Quốc tế)',
  materials: [
    'Hộ chiếu: bản gốc + 1 bản photo (trang ảnh, trang visa, trang dấu nhập cảnh)',
    'Thẻ sinh viên (bản gốc)',
    'Tờ khai xin thị thực (nhận và điền tại chỗ)',
    '2 ảnh 2 tấc nền trắng'
  ],
  consequence:
    'Nếu không làm đúng hạn, giấy phép cư trú hết hạn sẽ bị coi là cư trú bất hợp pháp, bạn tự chịu trách nhiệm.',
  quiz: {
    question: 'Thông báo yêu cầu bạn làm gì và hạn chót là khi nào?',
    options: [
      'Trước 17:00 ngày 25/11, đích thân mang hộ chiếu và giấy tờ đến phòng 204, tòa nhà Thông Bác A để gia hạn giấy phép cư trú',
      'Ở ký túc xá chờ giáo viên đến lấy hộ chiếu, nhà trường làm thay',
      'Điền form trên mạng rồi đưa bản photo hộ chiếu cho lớp trưởng',
      'Đi vào bất kỳ ngày làm việc nào sau 25/11 cũng được, không ảnh hưởng giấy phép cư trú'
    ],
    answer_index: 0,
    source_span: '须本人到场办理，不接受代办',
    explain:
      'Thông báo ghi: trước 17:00 ngày 25/11/2026, đích thân mang hộ chiếu và giấy tờ đến phòng 204, tòa nhà Thông Bác A; không được nhờ người làm thay.'
  }
}

const TRANSLATIONS_1 = { en: T1_EN, ru: T1_RU, vi: T1_VI }

/* =========================================================================
   五、114 人名单
   语言分布：ru 34 / vi 20 / th 15 / id 15 / en 30；学号 20260001-20260114
   班级：2026-A / B / C 各 38 人；两个主角学生必须落在指定学号与班级
   ========================================================================= */

const COHORT = '2026'
const CLASSES = ['2026-A', '2026-B', '2026-C']

// 两位主角：seed-notices.md 指定
const PROTAGONISTS = {
  vi: { index: 7, name: 'NGUYEN Van Anh', name_en: 'Nguyen Van Anh' }, // 20260007 / vi / 2026-A
  ru: { index: 12, name: 'Иванова Дарья', name_en: 'Daria Ivanova' } // 20260012 / ru / 2026-A
}

/* v2 花名册字段：只给几个学生补全 国籍 / 邮箱 / 学历 / 年级，
   其余留空，好让「花名册检查」和「邮件通知」两条链路一演示就有真实缺口可看。
   学号与姓名由 buildRoster 的确定性排布决定（20260001 泰国 / 20260002 俄罗斯 …），
   这里的国籍与邮箱必须和「同一条记录」对得上，别把 A 的邮箱挂到 B 身上。 */
const DEMO_PROFILES = {
  '20260001': { nationality: '泰国', email: 'somchai.wattanakul@example.edu', degree: '本科', grade: '2026级' },
  '20260002': { nationality: '俄罗斯', email: 'aleksei.petrov@example.edu', degree: '硕士', grade: '2026级' },
  '20260003': { nationality: '美国', email: 'michael.johnson@example.edu', degree: '本科', grade: '2026级' },
  '20260007': { nationality: '越南', email: 'nguyen.van.anh@example.edu', degree: '硕士', grade: '2026级' },
  '20260012': { nationality: '俄罗斯', email: 'daria.ivanova@example.edu', degree: '硕士', grade: '2026级' },
  '20260030': { nationality: '越南', email: 'le.van.minh@example.edu', degree: '本科', grade: '2026级' }
}

// 每个语言的姓名池，数量与配额完全一致（主角算在池里）
const NAME_POOLS = {
  ru: [
    { name: 'Иванова Дарья', name_en: 'Daria Ivanova', protagonist: 'ru' },
    { name: 'Петров Алексей', name_en: 'Aleksei Petrov' },
    { name: 'Смирнова Анна', name_en: 'Anna Smirnova' },
    { name: 'Кузнецов Иван', name_en: 'Ivan Kuznetsov' },
    { name: 'Соколова Мария', name_en: 'Maria Sokolova' },
    { name: 'Попов Дмитрий', name_en: 'Dmitrii Popov' },
    { name: 'Лебедева Екатерина', name_en: 'Ekaterina Lebedeva' },
    { name: 'Козлов Сергей', name_en: 'Sergei Kozlov' },
    { name: 'Новикова Ольга', name_en: 'Olga Novikova' },
    { name: 'Морозов Никита', name_en: 'Nikita Morozov' },
    { name: 'Волкова Татьяна', name_en: 'Tatiana Volkova' },
    { name: 'Соловьёв Андрей', name_en: 'Andrei Solovev' },
    { name: 'Васильева Елена', name_en: 'Elena Vasileva' },
    { name: 'Зайцев Михаил', name_en: 'Mikhail Zaitsev' },
    { name: 'Павлова Ксения', name_en: 'Kseniia Pavlova' },
    { name: 'Семёнов Артём', name_en: 'Artem Semenov' },
    { name: 'Голубева Ирина', name_en: 'Irina Golubeva' },
    { name: 'Виноградов Павел', name_en: 'Pavel Vinogradov' },
    { name: 'Богданова Юлия', name_en: 'Iuliia Bogdanova' },
    { name: 'Воробьёв Максим', name_en: 'Maksim Vorobev' },
    { name: 'Фёдорова Алина', name_en: 'Alina Fedorova' },
    { name: 'Михайлов Роман', name_en: 'Roman Mikhailov' },
    { name: 'Белова Софья', name_en: 'Sofia Belova' },
    { name: 'Тарасов Егор', name_en: 'Egor Tarasov' },
    { name: 'Комаров Виктор', name_en: 'Viktor Komarov' },
    { name: 'Орлова Наталья', name_en: 'Natalia Orlova' },
    { name: 'Киселёв Денис', name_en: 'Denis Kiselev' },
    { name: 'Макарова Вера', name_en: 'Vera Makarova' },
    { name: 'Андреев Глеб', name_en: 'Gleb Andreev' },
    { name: 'Ковалёв Руслан', name_en: 'Ruslan Kovalev' },
    { name: 'Гусева Полина', name_en: 'Polina Guseva' },
    { name: 'Титов Владимир', name_en: 'Vladimir Titov' },
    { name: 'Ермакова Олеся', name_en: 'Olesia Ermakova' },
    { name: 'Никитин Тимур', name_en: 'Timur Nikitin' }
  ],
  vi: [
    { name: 'NGUYEN Van Anh', name_en: 'Nguyen Van Anh', protagonist: 'vi' },
    { name: 'TRAN Thi Lan', name_en: 'Tran Thi Lan' },
    { name: 'LE Van Minh', name_en: 'Le Van Minh' },
    { name: 'PHAM Thi Mai', name_en: 'Pham Thi Mai' },
    { name: 'HOANG Quang Huy', name_en: 'Hoang Quang Huy' },
    { name: 'VU Thi Thu Ha', name_en: 'Vu Thi Thu Ha' },
    { name: 'DANG Van Nam', name_en: 'Dang Van Nam' },
    { name: 'BUI Thi Hoa', name_en: 'Bui Thi Hoa' },
    { name: 'DO Van Long', name_en: 'Do Van Long' },
    { name: 'NGO Thi Kim Ngan', name_en: 'Ngo Thi Kim Ngan' },
    { name: 'DINH Van Duc', name_en: 'Dinh Van Duc' },
    { name: 'TRUONG Thi Huong', name_en: 'Truong Thi Huong' },
    { name: 'PHAN Van Son', name_en: 'Phan Van Son' },
    { name: 'HUYNH Thi Ngoc', name_en: 'Huynh Thi Ngoc' },
    { name: 'VO Van Tai', name_en: 'Vo Van Tai' },
    { name: 'CAO Thi Bich', name_en: 'Cao Thi Bich' },
    { name: 'LUONG Van Phuc', name_en: 'Luong Van Phuc' },
    { name: 'MAI Thi Hang', name_en: 'Mai Thi Hang' },
    { name: 'TA Van Khoa', name_en: 'Ta Van Khoa' },
    { name: 'CHU Thi Linh', name_en: 'Chu Thi Linh' }
  ],
  th: [
    { name: 'สมชาย วัฒนกุล', name_en: 'Somchai Wattanakul' },
    { name: 'ปิยะดา ศรีสุวรรณ', name_en: 'Piyada Srisuwan' },
    { name: 'ณัฐพล ใจดี', name_en: 'Nattaphon Jaidee' },
    { name: 'อรุณี ทองคำ', name_en: 'Arunee Thongkham' },
    { name: 'ธีรภัทร พงษ์ไพร', name_en: 'Teeraphat Phongphrai' },
    { name: 'กัญญา วิจิตร', name_en: 'Kanya Wichit' },
    { name: 'วรพล บุญมี', name_en: 'Woraphon Boonmee' },
    { name: 'สุดารัตน์ แก้วมณี', name_en: 'Sudarat Kaewmanee' },
    { name: 'ชัยวัฒน์ ธรรมโชติ', name_en: 'Chaiwat Thammachot' },
    { name: 'ปรียา สุขสมบูรณ์', name_en: 'Preeya Suksomboon' },
    { name: 'อนุชา รัตนโชติ', name_en: 'Anucha Rattachot' },
    { name: 'นภาพร ศิริวัฒน์', name_en: 'Napaporn Siriwat' },
    { name: 'กิตติศักดิ์ พูลสวัสดิ์', name_en: 'Kittisak Phoonsawat' },
    { name: 'มาลี จันทร์เพ็ญ', name_en: 'Malee Chanphen' },
    { name: 'ภาณุพงศ์ อินทรีย์', name_en: 'Panupong Intri' }
  ],
  id: [
    { name: 'Ahmad Fauzi', name_en: 'Ahmad Fauzi' },
    { name: 'Siti Nurhaliza', name_en: 'Siti Nurhaliza' },
    { name: 'Budi Santoso', name_en: 'Budi Santoso' },
    { name: 'Dewi Lestari', name_en: 'Dewi Lestari' },
    { name: 'Rizky Pratama', name_en: 'Rizky Pratama' },
    { name: 'Nur Aisyah', name_en: 'Nur Aisyah' },
    { name: 'Agus Setiawan', name_en: 'Agus Setiawan' },
    { name: 'Putri Maharani', name_en: 'Putri Maharani' },
    { name: 'Hendra Wijaya', name_en: 'Hendra Wijaya' },
    { name: 'Fitri Handayani', name_en: 'Fitri Handayani' },
    { name: 'Bayu Nugroho', name_en: 'Bayu Nugroho' },
    { name: 'Intan Permata', name_en: 'Intan Permata' },
    { name: 'Dimas Saputra', name_en: 'Dimas Saputra' },
    { name: 'Rina Kartika', name_en: 'Rina Kartika' },
    { name: 'Yusuf Ramadhan', name_en: 'Yusuf Ramadhan' }
  ],
  en: [
    { name: 'Michael Johnson', name_en: 'Michael Johnson' },
    { name: 'Emily Carter', name_en: 'Emily Carter' },
    { name: 'Daniel Smith', name_en: 'Daniel Smith' },
    { name: 'Sarah Williams', name_en: 'Sarah Williams' },
    { name: 'James Brown', name_en: 'James Brown' },
    { name: 'Olivia Davis', name_en: 'Olivia Davis' },
    { name: 'David Miller', name_en: 'David Miller' },
    { name: 'Sophie Wilson', name_en: 'Sophie Wilson' },
    { name: 'Thomas Moore', name_en: 'Thomas Moore' },
    { name: 'Chloe Taylor', name_en: 'Chloe Taylor' },
    { name: 'Daniel Anderson', name_en: 'Daniel Anderson' },
    { name: 'Grace Thomas', name_en: 'Grace Thomas' },
    { name: 'Samuel Jackson', name_en: 'Samuel Jackson' },
    { name: 'Alice White', name_en: 'Alice White' },
    { name: 'Joshua Harris', name_en: 'Joshua Harris' },
    { name: 'Hannah Martin', name_en: 'Hannah Martin' },
    { name: 'Benjamin Clark', name_en: 'Benjamin Clark' },
    { name: 'Lucy Lewis', name_en: 'Lucy Lewis' },
    { name: 'Christopher Walker', name_en: 'Christopher Walker' },
    { name: 'Emma Hall', name_en: 'Emma Hall' },
    { name: 'Andrew Young', name_en: 'Andrew Young' },
    { name: 'Rachel King', name_en: 'Rachel King' },
    { name: 'Patrick Wright', name_en: 'Patrick Wright' },
    { name: 'Natalie Scott', name_en: 'Natalie Scott' },
    { name: 'Kevin Green', name_en: 'Kevin Green' },
    { name: 'Victoria Baker', name_en: 'Victoria Baker' },
    { name: 'Brian Adams', name_en: 'Brian Adams' },
    { name: 'Melissa Nelson', name_en: 'Melissa Nelson' },
    { name: 'Jonathan Hill', name_en: 'Jonathan Hill' },
    { name: 'Rebecca Campbell', name_en: 'Rebecca Campbell' }
  ]
}

const LANG_QUOTA = [
  { lang: 'ru', count: 34, phase: 0.5 },
  { lang: 'en', count: 30, phase: 0.5 },
  { lang: 'vi', count: 20, phase: 0.29 },
  { lang: 'th', count: 15, phase: 0.13 },
  { lang: 'id', count: 15, phase: 0.78 }
]

const ROSTER_SIZE = LANG_QUOTA.reduce((n, x) => n + x.count, 0) // 114
const CLASS_SIZE = ROSTER_SIZE / CLASSES.length // 38

/** 把每种语言按配额均匀铺到 114 个槽位上（确定性，无随机） */
function planLangSlots() {
  const slots = new Array(ROSTER_SIZE).fill(null)
  const overflow = []
  for (const { lang, count, phase } of LANG_QUOTA) {
    for (let k = 0; k < count; k++) {
      let pos = Math.floor(((k + phase) * ROSTER_SIZE) / count)
      if (pos >= ROSTER_SIZE) pos = ROSTER_SIZE - 1
      if (slots[pos] === null) slots[pos] = lang
      else overflow.push(lang) // 相位撞车：先记下，最后填进空位，保证总数不差
    }
  }
  let oi = 0
  for (let i = 0; i < ROSTER_SIZE && oi < overflow.length; i++) {
    if (slots[i] === null) slots[i] = overflow[oi++]
  }
  for (let i = 0; i < ROSTER_SIZE; i++) if (slots[i] === null) slots[i] = 'en'
  return slots
}

/** 把某个槽位强制改成目标语言（与同语言的另一个槽位交换，配额不变） */
function forceSlotLang(slots, index, lang) {
  if (slots[index] === lang) return
  for (let i = 0; i < slots.length; i++) {
    if (i !== index && slots[i] === lang) {
      slots[i] = slots[index]
      slots[index] = lang
      return
    }
  }
}

/** 生成 114 条名单（纯函数，方便断言） */
export function buildRoster() {
  const slots = planLangSlots()
  forceSlotLang(slots, PROTAGONISTS.vi.index - 1, 'vi')
  forceSlotLang(slots, PROTAGONISTS.ru.index - 1, 'ru')

  // 主角之外的姓名队列（主角单独按索引插入，保证学号对得上）
  const queues = {}
  for (const [lang, pool] of Object.entries(NAME_POOLS)) {
    queues[lang] = pool.filter((p) => !p.protagonist)
  }
  const forced = new Map()
  for (const [lang, p] of Object.entries(PROTAGONISTS)) {
    forced.set(p.index - 1, { ...p, lang })
  }

  const roster = []
  for (let i = 0; i < ROSTER_SIZE; i++) {
    const lang = slots[i]
    const studentId = `${COHORT}${String(i + 1).padStart(4, '0')}` // 20260001-20260114
    let person = forced.get(i)
    if (!person) {
      person = queues[lang].shift()
      if (!person) person = { name: `Student ${studentId}`, name_en: `Student ${studentId}` }
    }
    const profile = DEMO_PROFILES[studentId] || {}
    roster.push({
      student_id: studentId,
      name: person.name,
      name_en: person.name_en,
      lang,
      class_no: CLASSES[Math.floor(i / CLASS_SIZE)] || CLASSES[CLASSES.length - 1],
      cohort: COHORT,
      // 示例学生不属于任何辅导员：owner_staff_id = NULL，只有总管看得见
      owner_staff_id: null,
      nationality: profile.nationality ?? null,
      email: profile.email ?? null,
      degree: profile.degree ?? null,
      grade: profile.grade ?? null
    })
  }
  return roster
}

/* =========================================================================
   六、通知 1 的演示回执（12 条：10 confirmed / 1 help / 1 只 seen）
   时间从发布后 0.5h 到 20h 分布，让看板一开始就是活的
   ========================================================================= */

const DEMO_CONFIRMED = [
  { student_id: '20260001', hour: 0.5 },
  { student_id: '20260002', hour: 1.2 },
  { student_id: '20260003', hour: 2.0 },
  { student_id: '20260004', hour: 3.5 },
  { student_id: '20260005', hour: 5.0 },
  { student_id: '20260006', hour: 7.0 },
  { student_id: '20260008', hour: 9.5 },
  { student_id: '20260009', hour: 12.0 },
  { student_id: '20260010', hour: 15.0 },
  { student_id: '20260011', hour: 20.0 }
]

const DEMO_HELP = {
  student_id: '20260007',
  hour: 2.5,
  message: 'Hộ chiếu của tôi đang được cấp lại, chưa có bản gốc. / 我的护照正在补办，暂时没有原件。'
}

const DEMO_SEEN_ONLY = { student_id: '20260012', hour: 4.2 }

const DEMO_REFUSALS = [
  {
    student_id: '20260007',
    hour: 3.1,
    question: 'My visa expires next month too. Can I stay in China if I only extend the residence permit?',
    reason_code: 'visa'
  },
  {
    student_id: '20260012',
    hour: 6.4,
    question: '体检说我肝功能异常，需要去哪个医院复查？会不会影响我的居留许可？',
    reason_code: 'medical'
  }
]

// 发布时刻：比「现在」早 26 小时，20h 的回执也在过去，看板时间轴自然
const PUBLISH_AGE_HOURS = 26

/** 把小时偏移换成 ISO 时间戳（相对发布时刻） */
function makeClock(publishedMs) {
  return (hours, extraMinutes = 0) =>
    new Date(publishedMs + hours * 3600 * 1000 + extraMinutes * 60 * 1000).toISOString()
}

/* =========================================================================
   七、写库
   ========================================================================= */

function insertStudents(db) {
  const roster = buildRoster()
  const ins = db.prepare(
    `INSERT INTO students
       (student_id, name, name_en, lang, class_no, cohort, is_demo,
        nationality, email, degree, grade, owner_staff_id)
     VALUES (?,?,?,?,?,?,1,?,?,?,?,NULL)
     ON CONFLICT(student_id) DO UPDATE SET
       name = excluded.name, name_en = excluded.name_en, lang = excluded.lang,
       class_no = excluded.class_no, cohort = excluded.cohort, is_demo = 1,
       nationality = COALESCE(excluded.nationality, students.nationality),
       email = COALESCE(excluded.email, students.email),
       degree = COALESCE(excluded.degree, students.degree),
       grade = COALESCE(excluded.grade, students.grade)`
  )
  for (const s of roster) {
    ins.run(
      s.student_id,
      s.name,
      s.name_en,
      s.lang,
      s.class_no,
      s.cohort,
      s.nationality ?? null,
      s.email ?? null,
      s.degree ?? null,
      s.grade ?? null
    )
  }
  return roster.length
}

function insertNotice(db, notice) {
  db.prepare(
    `INSERT INTO notices
       (id, created_at, published_at, status, owner, raw_text, sent_at, kind, title_zh,
        deadline_at, structured, quiz, translations, risk_flags)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    notice.id,
    notice.created_at,
    notice.published_at,
    notice.status,
    notice.owner,
    notice.raw_text,
    notice.sent_at,
    notice.kind,
    notice.title_zh,
    notice.deadline_at,
    JSON.stringify(notice.structured),
    notice.quiz ? JSON.stringify(notice.quiz) : null,
    JSON.stringify(notice.translations || {}),
    JSON.stringify(notice.risk_flags || [])
  )
}

function insertDemoReceipts(db, noticeId, publishedMs, rosterById) {
  const at = makeClock(publishedMs)
  const insReceipt = db.prepare(
    `INSERT INTO receipts
       (id, notice_id, student_id, name, lang, first_seen_at, quiz_passed_at, confirmed_at,
        help_at, help_message, ua, ip)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  )
  const insEvent = db.prepare(
    `INSERT INTO events (id, notice_id, student_id, type, payload, created_at)
     VALUES (?,?,?,?,?,?)`
  )

  const who = (sid) => rosterById.get(sid) || { name: null, lang: null }

  // 发布事件
  insEvent.run(
    uid('evt'),
    noticeId,
    null,
    'publish',
    JSON.stringify({ seeded: true }),
    at(0)
  )

  for (const item of DEMO_CONFIRMED) {
    const s = who(item.student_id)
    insReceipt.run(
      uid('rcp'),
      noticeId,
      item.student_id,
      s.name,
      s.lang,
      at(item.hour, -4), // 先打开卡片
      at(item.hour, -2), // 再看懂小测
      at(item.hour), // 最后回执
      null,
      null,
      'seed',
      null
    )
    insEvent.run(
      uid('evt'),
      noticeId,
      item.student_id,
      'receipt',
      JSON.stringify({ kind: 'confirm' }),
      at(item.hour)
    )
  }

  // 1 条求助
  {
    const s = who(DEMO_HELP.student_id)
    insReceipt.run(
      uid('rcp'),
      noticeId,
      DEMO_HELP.student_id,
      s.name,
      s.lang,
      at(DEMO_HELP.hour, -6),
      null,
      null,
      at(DEMO_HELP.hour),
      DEMO_HELP.message,
      'seed',
      null
    )
    insEvent.run(
      uid('evt'),
      noticeId,
      DEMO_HELP.student_id,
      'help',
      JSON.stringify({ message: DEMO_HELP.message }),
      at(DEMO_HELP.hour)
    )
  }

  // 1 条只看过
  {
    const s = who(DEMO_SEEN_ONLY.student_id)
    insReceipt.run(
      uid('rcp'),
      noticeId,
      DEMO_SEEN_ONLY.student_id,
      s.name,
      s.lang,
      at(DEMO_SEEN_ONLY.hour),
      null,
      null,
      null,
      null,
      'seed',
      null
    )
    insEvent.run(
      uid('evt'),
      noticeId,
      DEMO_SEEN_ONLY.student_id,
      'view',
      JSON.stringify({ seeded: true }),
      at(DEMO_SEEN_ONLY.hour)
    )
  }

  return DEMO_CONFIRMED.length + 2
}

function insertDemoRefusals(db, noticeId, publishedMs) {
  const at = makeClock(publishedMs)
  const insRefusal = db.prepare(
    `INSERT INTO refusals (id, notice_id, student_id, question, reason_code, created_at)
     VALUES (?,?,?,?,?,?)`
  )
  const insEvent = db.prepare(
    `INSERT INTO events (id, notice_id, student_id, type, payload, created_at)
     VALUES (?,?,?,?,?,?)`
  )
  for (const r of DEMO_REFUSALS) {
    insRefusal.run(uid('rfs'), noticeId, r.student_id, r.question, r.reason_code, at(r.hour))
    insEvent.run(
      uid('evt'),
      noticeId,
      r.student_id,
      'refusal',
      JSON.stringify({ reason_code: r.reason_code }),
      at(r.hour)
    )
  }
  return DEMO_REFUSALS.length
}

/** 只在 notices 为空时灌数据；已有数据直接跳过（首次启动由 api.js 调一次） */
export function seedIfEmpty() {
  const db = getDb()
  const existed = db.prepare('SELECT COUNT(*) AS c FROM notices').get()
  if (Number(existed?.c || 0) > 0) return { seeded: false }

  const nowMs = Date.now()
  const publishedMs = nowMs - PUBLISH_AGE_HOURS * 3600 * 1000
  const publishedAt = new Date(publishedMs).toISOString()
  const nowIso = new Date(nowMs).toISOString()

  const result = tx(() => {
    const students = insertStudents(db)
    const rosterById = new Map(buildRoster().map((s) => [s.student_id, s]))

    const notice1 = {
      id: 'ntc_residence_2026',
      created_at: publishedAt,
      published_at: publishedAt,
      status: 'published',
      owner: '张老师',
      raw_text: RAW_1,
      sent_at: '2026-11-18T09:00:00+08:00',
      kind: 'residence_permit',
      title_zh: STRUCTURED_1.title_zh,
      deadline_at: STRUCTURED_1.deadline.iso,
      structured: STRUCTURED_1,
      quiz: QUIZ_1,
      translations: TRANSLATIONS_1,
      risk_flags: STRUCTURED_1.risk_flags
    }
    const notice2 = {
      id: 'ntc_exam_2026',
      created_at: new Date(nowMs - 3 * 3600 * 1000).toISOString(),
      published_at: new Date(nowMs - 3 * 3600 * 1000).toISOString(),
      status: 'published',
      owner: '张老师',
      raw_text: RAW_2,
      sent_at: '2026-11-14T09:00:00+08:00',
      kind: 'exam',
      title_zh: STRUCTURED_2.title_zh,
      deadline_at: STRUCTURED_2.deadline.iso,
      structured: STRUCTURED_2,
      quiz: QUIZ_2,
      translations: {}, // 故意留空：现场演示点「生成翻译」
      risk_flags: STRUCTURED_2.risk_flags
    }
    const notice3 = {
      id: 'ntc_medical_2026',
      created_at: new Date(nowMs - 2 * 3600 * 1000).toISOString(),
      published_at: new Date(nowMs - 2 * 3600 * 1000).toISOString(),
      status: 'published',
      owner: '张老师',
      raw_text: RAW_3,
      sent_at: '2026-11-17T09:00:00+08:00',
      kind: 'medical',
      title_zh: STRUCTURED_3.title_zh,
      deadline_at: STRUCTURED_3.deadline.iso,
      structured: STRUCTURED_3,
      quiz: QUIZ_3,
      translations: {}, // 同上
      risk_flags: STRUCTURED_3.risk_flags
    }

    for (const n of [notice1, notice2, notice3]) insertNotice(db, n)

    const receipts = insertDemoReceipts(db, notice1.id, publishedMs, rosterById)
    const refusals = insertDemoRefusals(db, notice1.id, publishedMs)

    return {
      seeded: true,
      notices: 3,
      students,
      receipts,
      refusals,
      published_at: publishedAt,
      now: nowIso
    }
  })

  return result
}

/** 清空回执类数据，保留 notices 与 students（真实的 48 小时实测用这个） */
export function resetDemoData() {
  const db = getDb()
  return tx(() => {
    const before = {
      receipts: Number(db.prepare('SELECT COUNT(*) AS c FROM receipts').get()?.c || 0),
      quiz_attempts: Number(db.prepare('SELECT COUNT(*) AS c FROM quiz_attempts').get()?.c || 0),
      refusals: Number(db.prepare('SELECT COUNT(*) AS c FROM refusals').get()?.c || 0),
      events: Number(db.prepare('SELECT COUNT(*) AS c FROM events').get()?.c || 0)
    }
    db.exec('DELETE FROM receipts')
    db.exec('DELETE FROM quiz_attempts')
    db.exec('DELETE FROM refusals')
    db.exec('DELETE FROM events')
    return {
      reset: true,
      cleared: before,
      kept: {
        notices: Number(db.prepare('SELECT COUNT(*) AS c FROM notices').get()?.c || 0),
        students: Number(db.prepare('SELECT COUNT(*) AS c FROM students').get()?.c || 0)
      }
    }
  })
}

/* =========================================================================
   八、直接运行：node server/seed.js[ --reset]
   ========================================================================= */

const isDirectRun = (() => {
  try {
    const self = fileURLToPath(import.meta.url)
    const entry = process.argv[1] ? path.resolve(process.argv[1]) : ''
    return entry && path.resolve(self) === entry
  } catch {
    return false
  }
})()

if (isDirectRun) {
  const args = process.argv.slice(2)
  if (args.includes('--reset')) {
    const out = resetDemoData()
    console.log('[seed] 已清空回执类数据（notices / students 保留）')
    console.log(JSON.stringify(out, null, 2))
  } else {
    const out = seedIfEmpty()
    if (out.seeded) {
      console.log('[seed] 已灌入种子数据')
      console.log(
        `[seed] 通知 ${out.notices} 份 / 名单 ${out.students} 人 / 演示回执 ${out.receipts} 条 / 敏感拒绝 ${out.refusals} 条`
      )
    } else {
      console.log('[seed] notices 表非空，跳过。要清空回执请运行：node server/seed.js --reset')
    }
  }
}
