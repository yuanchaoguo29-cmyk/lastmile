/* 花名册面板：把 Excel 花名册导进来，也能一键清空 / 恢复示例学生。
   名单是所有计数（已确认 x/y、未读）的分母，所以面板第一件事先把当前人数说清楚。
   数据只走 lib/api.js，不自己 fetch；错误留在面板里，除了清理操作的 window.confirm 之外不弹窗。 */

import React, { useEffect, useMemo, useRef, useState } from 'react'
import { clearRoster, getRoster, importRoster, restoreDemoRoster } from '../lib/api.js'
import { errText } from './helpers.js'
import { Btn, ErrBar, Eyebrow, Skel } from './ui.jsx'

const EMPTY_MSG = { tone: '', text: '' }
const PREVIEW_ROWS = 8
const DEMO_FALLBACK = 114

/* ---------- 1. 字段与表头别名 ---------- */

const FIELD_LABEL = {
  student_id: '学号',
  name: '姓名',
  name_en: '英文名',
  lang: '语言',
  class_no: '班级'
}

const FIELD_ORDER = ['student_id', 'name', 'name_en', 'lang', 'class_no']

/* 表头别名。键一律是「归一化」后的写法：小写、去空格 / 下划线 / 点号 / 斜杠。 */
const HEADER_ALIAS = {
  学号: 'student_id',
  学生学号: 'student_id',
  学号编号: 'student_id',
  studentid: 'student_id',
  studentnumber: 'student_id',
  id: 'student_id',
  number: 'student_id',
  编号: 'student_id',

  姓名: 'name',
  名字: 'name',
  学生姓名: 'name',
  中文名: 'name',
  name: 'name',
  studentname: 'name',

  英文名: 'name_en',
  nameen: 'name_en',
  english: 'name_en',
  englishname: 'name_en',
  英文姓名: 'name_en',
  拼音: 'name_en',
  pinyin: 'name_en',

  语言: 'lang',
  lang: 'lang',
  language: 'lang',
  母语: 'lang',
  语种: 'lang',

  班级: 'class_no',
  班号: 'class_no',
  班级号: 'class_no',
  行政班: 'class_no',
  class: 'class_no',
  classno: 'class_no',
  classnumber: 'class_no'
}

/* 表头单元格 → 归一化键：去掉 BOM、大小写、空格、括号注解、「必填」这类后缀 */
function normHeader(cell) {
  let k = String(cell === null || cell === undefined ? '' : cell)
    .replace(/^\uFEFF/, '')
    .trim()
    .toLowerCase()
  if (!k) return ''
  k = k.replace(/[（(][^）)]*[）)]/g, '')
  k = k.replace(/[\s_\-.:：/\\|]+/g, '')
  k = k.replace(/(必填|选填|可选|required|optional)+$/g, '')
  return k
}

function fieldOfHeader(cell) {
  const k = normHeader(cell)
  if (!k) return ''
  return HEADER_ALIAS[k] || ''
}

/* ---------- 2. 语言归一化 ---------- */

const LANG_ALIAS = {
  ru: ['ru', 'ru-ru', 'ru-rus', 'rus', 'russian', '俄语', '俄文', 'русский'],
  en: ['en', 'en-us', 'en-gb', 'eng', 'english', '英语', '英文'],
  vi: ['vi', 'vi-vn', 'vie', 'vietnamese', '越南语', '越南文', 'tiếng việt', 'tieng viet'],
  th: ['th', 'th-th', 'tha', 'thai', '泰语', '泰文', 'ไทย'],
  id: ['id', 'id-id', 'ind', 'indonesian', '印尼语', '印尼文', '印度尼西亚语', 'bahasa indonesia', 'bahasa'],
  zh: ['zh', 'zh-cn', 'zh-hans', 'zho', 'chi', 'chinese', '中文', '汉语', '中文简体', '简体中文']
}

const LANG_TEXT = {
  zh: '中文',
  en: '英语',
  ru: '俄语',
  vi: '越南语',
  th: '泰语',
  id: '印尼语'
}

const LANG_LOOKUP = (() => {
  const map = new Map()
  Object.keys(LANG_ALIAS).forEach((code) => {
    LANG_ALIAS[code].forEach((alias) => {
      const key = String(alias).trim().toLowerCase().replace(/[\s_]+/g, '')
      if (key && !map.has(key)) map.set(key, code)
    })
  })
  return map
})()

/* ru-RU / Русский / 俄语 → ru；认不出来留空，交给后端默认 en */
function normLang(value) {
  const raw = String(value === null || value === undefined ? '' : value)
    .trim()
    .toLowerCase()
  if (!raw) return ''
  const compact = raw.replace(/[\s_]+/g, '')
  const tries = [
    compact,
    compact.split('-')[0],
    compact.split('/')[0],
    compact.replace(/[()（）·,，.。:：]/g, '')
  ]
  for (let i = 0; i < tries.length; i += 1) {
    const hit = LANG_LOOKUP.get(tries[i])
    if (hit) return hit
  }
  return ''
}

/* ---------- 3. 文本解码：UTF-8 严格 → GBK 兜底 ---------- */

function stripBom(s) {
  return String(s || '').replace(/^\uFEFF/, '')
}

function decodeBytes(buffer) {
  const bytes = buffer instanceof ArrayBuffer ? buffer : new ArrayBuffer(0)
  const head = new Uint8Array(bytes)
  /* Excel 的「Unicode 文本」是带 BOM 的 UTF-16，先认 BOM */
  if (head.length >= 2 && head[0] === 0xff && head[1] === 0xfe) {
    return stripBom(new TextDecoder('utf-16le').decode(bytes))
  }
  if (head.length >= 2 && head[0] === 0xfe && head[1] === 0xff) {
    return stripBom(new TextDecoder('utf-16be').decode(bytes))
  }
  try {
    return stripBom(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    /* Windows 导出的 CSV 常是 GBK：严格 UTF-8 解不开就退回 GBK */
  }
  try {
    return stripBom(new TextDecoder('gbk').decode(bytes))
  } catch {
    return stripBom(new TextDecoder('utf-8').decode(bytes))
  }
}

/* FileReader 读成 ArrayBuffer（不用 file.text()，否则拿不到原始字节、GBK 就没法救） */
function readFileBuffer(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = () => reject(new Error('浏览器读不了这个文件，换一个试试'))
    reader.onabort = () => reject(new Error('读取被中断了'))
    reader.readAsArrayBuffer(file)
  })
}

/* 一眼认出 Excel 本体（.xlsx 是 zip，.xls 是老 OLE），别把二进制当 CSV 解析 */
function binaryKind(buffer) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 4) return ''
  const h = new Uint8Array(buffer, 0, 4)
  if (h[0] === 0x50 && h[1] === 0x4b) return 'xlsx'
  if (h[0] === 0xd0 && h[1] === 0xcf && h[2] === 0x11 && h[3] === 0xe0) return 'xls'
  return ''
}

/* ---------- 4. 分隔符判断与 CSV 解析 ---------- */

const DELIM_TEXT = { '\t': 'Tab', ',': '逗号', ';': '分号' }

/* 看第一行（跳过纯空行）里 Tab / 逗号 / 分号哪个出现最多；引号里的不算 */
function detectDelimiter(text) {
  const firstLine = String(text).split(/\r\n|\n|\r/).find((line) => line.trim()) || ''
  const counts = { '\t': 0, ',': 0, ';': 0 }
  let quoted = false
  for (let i = 0; i < firstLine.length; i += 1) {
    const ch = firstLine[i]
    if (ch === '"') {
      if (quoted && firstLine[i + 1] === '"') {
        i += 1
        continue
      }
      quoted = !quoted
      continue
    }
    if (!quoted && counts[ch] !== undefined) counts[ch] += 1
  }
  let best = ','
  let max = 0
  /* 平手时按 Tab → 逗号 → 分号的顺序取，Tab 在 Excel 粘贴里更可信 */
  ;['\t', ',', ';'].forEach((d) => {
    if (counts[d] > max) {
      max = counts[d]
      best = d
    }
  })
  return { delim: max > 0 ? best : ',', counts }
}

/* 逐字符扫描的 CSV 解析：支持引号包裹、"" 转义、字段内换行、CRLF / CR / LF */
function parseCsv(text, delim) {
  const rows = []
  let row = []
  let cell = ''
  let quoted = false

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"'
          i += 1
        } else {
          quoted = false
        }
      } else {
        cell += ch
      }
      continue
    }
    if (ch === '"' && cell === '') {
      quoted = true
      continue
    }
    if (ch === delim) {
      row.push(cell)
      cell = ''
      continue
    }
    if (ch === '\n' || ch === '\r') {
      /* \r\n 只算一次换行 */
      if (ch === '\r' && text[i + 1] === '\n') i += 1
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
      continue
    }
    cell += ch
  }
  row.push(cell)
  rows.push(row)
  return rows
}

/* ---------- 5. 表格分析：表头、列映射、问题行 ---------- */

const EMPTY_PARSE = {
  ok: false,
  err: '',
  grid: [],
  colCount: 0,
  delimLabel: '',
  hasHeader: false,
  headerCells: [],
  autoMapping: [],
  skipFirstRow: false
}

/* 一行长得像不像表头：没有数字（学号必带数字），且下一行有数字 */
function looksLikeHeaderRow(row, nextRow) {
  const cells = (row || []).map((c) => String(c === null || c === undefined ? '' : c).trim()).filter(Boolean)
  if (!cells.length) return false
  if (cells.some((c) => /\d/.test(c))) return false
  if (!nextRow) return false
  return nextRow.some((c) => /\d/.test(String(c === null || c === undefined ? '' : c)))
}

function analyzeSheet(rawText) {
  const text = stripBom(rawText)
  if (!text.trim()) return EMPTY_PARSE

  const { delim } = detectDelimiter(text)
  const grid = parseCsv(text, delim).filter((row) =>
    row.some((cell) => String(cell === null || cell === undefined ? '' : cell).trim() !== '')
  )
  if (!grid.length) {
    return {
      ...EMPTY_PARSE,
      err: '这个文件里没读到任何内容（全是空行？）——换一份，或直接把表格内容粘到上面的输入框。'
    }
  }

  const colCount = grid.reduce((n, row) => Math.max(n, row.length), 0)
  const headerCells = Array.from({ length: colCount }, (_, i) => {
    const v = grid[0][i]
    return v === null || v === undefined ? '' : String(v).trim()
  })

  /* 表头：至少两列能认出来才敢当表头（单列命中更可能是数据里恰好有个英文单词） */
  const headerFields = headerCells.map(fieldOfHeader)
  const recognized = headerFields.filter(Boolean).length
  const hasHeader = recognized >= 2

  const autoMapping = Array.from({ length: colCount }, () => '')
  if (hasHeader) {
    const used = []
    headerFields.forEach((field, i) => {
      if (field && used.indexOf(field) === -1) {
        used.push(field)
        autoMapping[i] = field
      }
    })
  } else {
    /* 没有表头：按列位置兜底，第 1 列学号、第 2 列姓名 */
    if (colCount > 0) autoMapping[0] = 'student_id'
    if (colCount > 1) autoMapping[1] = 'name'
  }

  return {
    ok: true,
    err: '',
    grid,
    colCount,
    delimLabel: DELIM_TEXT[delim] || '逗号',
    hasHeader,
    headerCells,
    autoMapping,
    skipFirstRow: hasHeader || looksLikeHeaderRow(grid[0], grid[1])
  }
}

/* 用列映射把行翻成学生记录，并给问题行打标（学号空 / 重复） */
function buildRows(records, mapping) {
  const colOf = {}
  mapping.forEach((field, i) => {
    if (field && colOf[field] === undefined) colOf[field] = i
  })
  const seen = new Set()
  const rows = []
  let emptyId = 0
  let dup = 0

  records.forEach((cells, index) => {
    const cell = (field) => {
      const i = colOf[field]
      if (i === undefined) return ''
      const v = cells[i]
      return v === null || v === undefined ? '' : String(v).trim()
    }
    /* 学号里的空格一律抹掉：Excel 复制经常带不可见空白 */
    const studentId = cell('student_id').replace(/\s+/g, '')
    const rawLang = cell('lang')
    let issue = ''
    if (!studentId) {
      issue = 'empty-id'
      emptyId += 1
    } else if (seen.has(studentId)) {
      issue = 'dup'
      dup += 1
    } else {
      seen.add(studentId)
    }
    rows.push({
      key: index,
      student_id: studentId,
      name: cell('name'),
      name_en: cell('name_en'),
      lang: normLang(rawLang),
      langRaw: rawLang,
      class_no: cell('class_no'),
      issue
    })
  })

  const ready = rows
    .filter((r) => !r.issue)
    .map((r) => ({
      student_id: r.student_id,
      name: r.name,
      name_en: r.name_en,
      lang: r.lang,
      class_no: r.class_no
    }))

  return { rows, ready, emptyId, dup }
}

/* ---------- 6. 小工具 ---------- */

function num(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

function isDemoRow(row) {
  const v = row && row.is_demo
  return v === true || v === 1 || v === '1' || v === 'true'
}

/* ---------- 7. 面板 ---------- */

export default function RosterPanel({ open, onClose }) {
  /* 远端名单 */
  const [roster, setRoster] = useState(null)
  const [loading, setLoading] = useState(false)
  const [loadErr, setLoadErr] = useState('')

  /* 解析区 */
  const [text, setText] = useState('')
  const [fileName, setFileName] = useState('')
  const [mapOpen, setMapOpen] = useState(false)
  const [mappingOverride, setMappingOverride] = useState(null)
  const [skipFirstOverride, setSkipFirstOverride] = useState(null)

  /* 导入选项 */
  const [mode, setMode] = useState('append')
  const [keepDemo, setKeepDemo] = useState(true)
  const [busy, setBusy] = useState('')
  const [importMsg, setImportMsg] = useState(EMPTY_MSG)
  const [cleanMsg, setCleanMsg] = useState(EMPTY_MSG)

  const seq = useRef(0)
  const panelRef = useRef(null)
  const closeRef = useRef(null)

  const parsed = useMemo(() => analyzeSheet(text), [text])
  const mapping = mappingOverride || parsed.autoMapping
  const skipFirst = parsed.hasHeader
    ? true
    : skipFirstOverride === null
      ? parsed.skipFirstRow
      : skipFirstOverride
  const dataRows = useMemo(
    () => (skipFirst ? parsed.grid.slice(1) : parsed.grid),
    [parsed, skipFirst]
  )
  const built = useMemo(() => buildRows(dataRows, mapping), [dataRows, mapping])

  const total = roster ? roster.total : 0
  const demo = roster ? roster.demo : 0
  const imported = roster ? roster.imported : 0
  const demoLabel = !roster
    ? `保留示例学生（${DEMO_FALLBACK} 个）`
    : demo > 0
      ? `保留示例学生（${demo} 个）`
      : '保留示例学生（已清空）'

  /* 拉一次人数；连点时旧请求回来不覆盖新结果 */
  async function load() {
    const my = ++seq.current
    setLoading(true)
    setLoadErr('')
    try {
      const data = await getRoster()
      if (my !== seq.current) return
      const list = Array.isArray(data && data.roster)
        ? data.roster
        : Array.isArray(data && data.students)
          ? data.students
          : []
      const demoFromList = list.filter(isDemoRow).length
      const totalNum = Number(data && data.total)
      const demoNum = Number(data && data.demo_count)
      const totalSafe = Number.isFinite(totalNum) ? totalNum : list.length
      /* 后端没给 demo_count 时按 is_demo 自己数，别把「导入学生」算成负数 */
      const demoSafe =
        data && data.demo_count !== undefined && Number.isFinite(demoNum) ? demoNum : demoFromList
      const summary = {
        total: totalSafe,
        demo: demoSafe,
        imported: Math.max(0, totalSafe - demoSafe)
      }
      setRoster(summary)
      return summary
    } catch (e) {
      if (my !== seq.current) return null
      setLoadErr(errText(e))
      return null
    } finally {
      if (my === seq.current) setLoading(false)
    }
  }

  /* 每次打开都重置面板，并刷新一次人数 */
  useEffect(() => {
    if (!open) return undefined
    setRoster(null)
    setLoadErr('')
    setText('')
    setFileName('')
    setMapOpen(false)
    setMappingOverride(null)
    setSkipFirstOverride(null)
    setMode('append')
    setKeepDemo(true)
    setBusy('')
    setImportMsg(EMPTY_MSG)
    setCleanMsg(EMPTY_MSG)
    load()
    return () => {
      /* 关掉面板：把这次读取作废 */
      seq.current += 1
    }
  }, [open])

  /* 换了内容就丢掉旧的列映射覆盖，回到自动判断 */
  useEffect(() => {
    setMappingOverride(null)
    setSkipFirstOverride(null)
  }, [text])

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

  /* 面板打开时别让背后的工作台跟着滚 */
  useEffect(() => {
    if (!open) return undefined
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [open])

  /* 初始焦点给关闭按钮，键盘用户不至于从面板第一行开始 Tab */
  useEffect(() => {
    if (!open) return undefined
    const t = setTimeout(() => {
      if (closeRef.current) closeRef.current.focus()
    }, 40)
    return () => clearTimeout(t)
  }, [open])

  /* 轻量 Tab 圈：焦点别跑到面板背后的工作台 */
  function onPanelKeyDown(e) {
    if (e.key !== 'Tab' || !panelRef.current) return
    const all = panelRef.current.querySelectorAll('button, input, textarea, select, a[href]')
    const list = Array.prototype.filter.call(
      all,
      (n) => !n.disabled && n.offsetParent !== null
    )
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

  function onOverlayDown(e) {
    if (e.target === e.currentTarget && onClose) onClose()
  }

  /* 选文件：FileReader 读字节 → 解码 → 进同一条解析管线 */
  async function onPickFile(e) {
    const input = e.target
    const file = input.files && input.files[0]
    if (!file) return
    setImportMsg(EMPTY_MSG)
    try {
      const buffer = await readFileBuffer(file)
      const kind = binaryKind(buffer)
      if (kind) {
        setImportMsg({
          tone: 'err',
          text:
            kind === 'xlsx'
              ? '这是 .xlsx 文件，这里读不了：在 Excel 里「另存为 → CSV UTF-8」，或直接把选中的单元格粘到上面的框里。'
              : '这是老的 .xls 文件（二进制格式），这边读不了：另存为 CSV，或直接复制粘贴。'
        })
        return
      }
      const decoded = decodeBytes(buffer)
      if (!decoded.trim()) {
        setImportMsg({
          tone: 'err',
          text: '这个文件里没有可读的文字（空文件？）：换一份，或直接把表格内容粘到上面的框里。'
        })
        return
      }
      if (decoded.indexOf('\u0000') !== -1) {
        setImportMsg({
          tone: 'err',
          text: '这个文件看起来不是纯文本：另存为 CSV，或直接把表格内容粘到上面的框里。'
        })
        return
      }
      setText(decoded)
      setFileName(file.name || '')
    } catch (err) {
      setImportMsg({ tone: 'err', text: '读文件失败：' + errText(err) })
    } finally {
      /* 允许再次选同一个文件 */
      input.value = ''
    }
  }

  function clearSource() {
    if (busy) return
    setText('')
    setFileName('')
    setMappingOverride(null)
    setSkipFirstOverride(null)
    setMapOpen(false)
  }

  /* 手动指定某一列是什么字段；同一个字段只留给一列 */
  function setColField(index, field) {
    const next = (mappingOverride || parsed.autoMapping).slice()
    while (next.length < parsed.colCount) next.push('')
    if (field) {
      for (let i = 0; i < next.length; i += 1) {
        if (next[i] === field && i !== index) next[i] = ''
      }
    }
    next[index] = field
    setMappingOverride(next)
  }

  async function doImport() {
    if (busy) return
    if (!built.ready.length) {
      setImportMsg({
        tone: 'err',
        text: '没有可导入的行：先确认「学号」那一列对上了，再点导入。'
      })
      return
    }
    setBusy('import')
    setImportMsg(EMPTY_MSG)
    try {
      const res = await importRoster(built.ready, mode, keepDemo)
      const added = num(res && res.added)
      const updated = num(res && res.updated)
      const skipped = num(res && res.skipped)
      const now = num(res && res.total)
      setImportMsg({
        tone: 'ok',
        text: `新增 ${added} · 更新 ${updated} · 跳过 ${skipped}，当前共 ${now} 人`
      })
      /* 导入成功就把这块内容清掉，避免手一抖又导一遍 */
      setText('')
      setFileName('')
      setMappingOverride(null)
      setSkipFirstOverride(null)
      setMapOpen(false)
      await load()
    } catch (e) {
      setImportMsg({ tone: 'err', text: errText(e) })
    } finally {
      setBusy('')
    }
  }

  async function doClearAll() {
    if (busy) return
    const ok = window.confirm(
      `清空全部名单（含示例学生，当前 ${total} 人）？\n\n所有通知的「已确认 x/y」分母会变成 0。这个操作不能撤销。`
    )
    if (!ok) return
    setBusy('clear')
    setCleanMsg(EMPTY_MSG)
    try {
      const res = await clearRoster(false)
      setCleanMsg({
        tone: 'ok',
        text: `已清空 ${num(res && res.removed)} 人，当前共 ${num(res && res.total)} 人`
      })
      await load()
    } catch (e) {
      setCleanMsg({ tone: 'err', text: errText(e) })
    } finally {
      setBusy('')
    }
  }

  async function doRestoreDemo() {
    if (busy) return
    const ok = window.confirm(
      '恢复内置示例学生（114 个）？\n\n已有的示例学生不会重复添加；导入的学生不受影响。'
    )
    if (!ok) return
    const before = total
    setBusy('restore')
    setCleanMsg(EMPTY_MSG)
    try {
      const res = await restoreDemoRoster()
      /* 服务端的 added 是「处理了几条」，这里按人数差算真正补回来的数量 */
      const summary = await load()
      const now = summary ? summary.total : num(res && res.total)
      const added = Math.max(0, now - before)
      setCleanMsg({
        tone: 'ok',
        text:
          added > 0
            ? `已恢复 ${added} 个示例学生，当前共 ${now} 人`
            : `示例学生本来就在，当前共 ${now} 人`
      })
    } catch (e) {
      setCleanMsg({ tone: 'err', text: errText(e) })
    } finally {
      setBusy('')
    }
  }

  if (!open) return null

  const busyAny = Boolean(busy)
  const showMap = parsed.ok && (mapOpen || !parsed.hasHeader)
  const skipped = built.emptyId + built.dup
  const preview = built.rows.slice(0, PREVIEW_ROWS)
  const noHeaderHint = parsed.ok && !parsed.hasHeader

  return (
    <div className="lm-roster-overlay" role="presentation" onMouseDown={onOverlayDown}>
      <div
        className="lm-roster-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="lm-roster-title"
        ref={panelRef}
        tabIndex={-1}
        onKeyDown={onPanelKeyDown}
      >
        <header className="lm-roster-head">
          <div className="lm-roster-headtext">
            <Eyebrow>ROSTER · 花名册</Eyebrow>
            <h2 className="lm-roster-title" id="lm-roster-title">
              花名册
            </h2>
          </div>
          <button
            type="button"
            className="lm-roster-x"
            ref={closeRef}
            onClick={() => onClose && onClose()}
            title="关闭"
            aria-label="关闭花名册"
          >
            ×
          </button>
        </header>

        <div className="lm-roster-body">
          {/* ---------- A. 现在有多少人 ---------- */}
          <section className="lm-roster-sec">
            {!roster && !loadErr ? (
              <div className="lm-roster-loading">
                <Eyebrow>READING · 读取名单…</Eyebrow>
                <div className="lm-roster-skel">
                  <Skel rows={2} />
                </div>
              </div>
            ) : null}

            {loadErr ? <ErrBar message={loadErr} onRetry={load} retryLabel="重试" /> : null}

            {roster ? (
              <>
                <div className="lm-roster-stats">
                  <div className="lm-roster-stat">
                    <div className="lm-roster-stat-num is-total">{total}</div>
                    <div className="lm-roster-stat-label">总人数</div>
                  </div>
                  <div className="lm-roster-stat">
                    <div className="lm-roster-stat-num">{demo}</div>
                    <div className="lm-roster-stat-label">示例学生</div>
                  </div>
                  <div className="lm-roster-stat">
                    <div className="lm-roster-stat-num">{imported}</div>
                    <div className="lm-roster-stat-label">导入学生</div>
                  </div>
                </div>

                <p className="lm-roster-note">
                  所有计数（已确认 x/y、未读）的分母都取这里的总人数。
                </p>

                {total === 0 ? (
                  <p className="lm-roster-hint is-warn">
                    名单现在是空的：先导入下面的花名册，或者点最下面的「恢复示例学生」。
                  </p>
                ) : null}

                {loading ? <p className="lm-roster-hint">刷新中…</p> : null}
              </>
            ) : null}
          </section>

          {/* ---------- B. 导入 ---------- */}
          <section className="lm-roster-sec">
            <div className="lm-roster-sec-head">
              <Eyebrow>IMPORT · 导入</Eyebrow>
              <span className="lm-roster-sec-tag">CSV / TSV / 从 Excel 直接粘贴</span>
            </div>

            <input
              className="lm-roster-file"
              type="file"
              accept=".csv,.txt,text/csv"
              disabled={busyAny}
              onChange={onPickFile}
            />
            <p className="lm-roster-hint">
              支持 UTF-8 和 GBK（Windows 导出的 CSV 多半是 GBK）；表头中文英文都认。
            </p>

            <div className="lm-roster-paste">
              <div className="lm-roster-paste-head">
                <span className="lm-roster-paste-label">或者：把 Excel 里选中的整块内容粘进来</span>
                {fileName ? <span className="lm-roster-filetag">{fileName}</span> : null}
                {text ? (
                  <button
                    type="button"
                    className="lm-roster-textbtn"
                    onClick={clearSource}
                    disabled={busyAny}
                  >
                    清空
                  </button>
                ) : null}
              </div>
              <textarea
                className="lm-roster-ta"
                rows={5}
                wrap="off"
                spellCheck={false}
                value={text}
                disabled={busyAny}
                onChange={(e) => {
                  setText(e.target.value)
                  setFileName('')
                }}
                placeholder={'学号\t姓名\t班级\n20230101\t张三\t计算机2301\n20230102\tLi Ming\t计算机2301'}
              />
            </div>

            {parsed.err ? <p className="lm-roster-hint is-err">{parsed.err}</p> : null}

            {parsed.ok ? (
              <>
                <p className="lm-roster-parse">
                  <span className="lm-roster-parse-item">分隔符 {parsed.delimLabel}</span>
                  <span className="lm-roster-parse-item">{parsed.colCount} 列</span>
                  <span className="lm-roster-parse-item">
                    {parsed.hasHeader
                      ? '首行按表头处理'
                      : skipFirst
                        ? '首行当表头跳过（没认出表头名）'
                        : '没识别到表头，按第 1 列学号、第 2 列姓名'}
                  </span>
                </p>

                <div className="lm-roster-mapwrap">
                  <button
                    type="button"
                    className="lm-roster-maptoggle"
                    onClick={() => setMapOpen((v) => !v)}
                    disabled={busyAny}
                  >
                    {showMap ? '收起列映射' : '列对不上？手动指定列'}
                  </button>

                  {showMap ? (
                    <div className="lm-roster-map">
                      {Array.from({ length: parsed.colCount }).map((_, i) => (
                        <label className="lm-roster-map-col" key={i}>
                          <span className="lm-roster-map-head">
                            {parsed.hasHeader && parsed.headerCells[i]
                              ? parsed.headerCells[i]
                              : `第 ${i + 1} 列`}
                          </span>
                          <select
                            className="lm-roster-select"
                            value={mapping[i] || ''}
                            disabled={busyAny}
                            onChange={(e) => setColField(i, e.target.value)}
                          >
                            <option value="">忽略</option>
                            {FIELD_ORDER.map((field) => (
                              <option key={field} value={field}>
                                {FIELD_LABEL[field]}
                              </option>
                            ))}
                          </select>
                        </label>
                      ))}
                    </div>
                  ) : null}

                  {noHeaderHint ? (
                    <label className="lm-roster-check is-inline">
                      <input
                        type="checkbox"
                        checked={skipFirst}
                        disabled={busyAny}
                        onChange={(e) => setSkipFirstOverride(e.target.checked)}
                      />
                      <span>第一行是表头，导入时跳过</span>
                    </label>
                  ) : null}
                </div>

                {built.rows.length ? (
                  <>
                    <div className="lm-roster-counts">
                      <span className="lm-roster-count">
                        共 <b>{built.rows.length}</b> 行
                      </span>
                      <span className="lm-roster-count">
                        可导入 <b className="is-ok">{built.ready.length}</b> 行
                      </span>
                      {skipped > 0 ? (
                        <span className="lm-roster-count">
                          将跳过 <b className="is-bad">{skipped}</b> 行
                          {built.emptyId ? `（学号空 ${built.emptyId}` : ''}
                          {built.emptyId && built.dup ? '，' : ''}
                          {built.dup ? `重复学号 ${built.dup}` : ''}
                          {built.emptyId || built.dup ? '）' : ''}
                        </span>
                      ) : null}
                    </div>

                    <div className="lm-roster-tablewrap">
                      <table className="lm-roster-table">
                        <thead>
                          <tr>
                            <th>学号</th>
                            <th>姓名</th>
                            <th>英文名</th>
                            <th>语言</th>
                            <th>班级</th>
                          </tr>
                        </thead>
                        <tbody>
                          {preview.map((r) => (
                            <tr
                              key={r.key}
                              className={
                                r.issue === 'empty-id'
                                  ? 'lm-roster-tr is-bad'
                                  : r.issue === 'dup'
                                    ? 'lm-roster-tr is-dup'
                                    : 'lm-roster-tr'
                              }
                            >
                              <td className="lm-roster-td-id">
                                {r.student_id ? (
                                  <span className="lm-roster-id">{r.student_id}</span>
                                ) : (
                                  <span className="lm-roster-cell-empty">（空）</span>
                                )}
                                {r.issue === 'empty-id' ? (
                                  <span className="lm-roster-badge is-bad">将跳过</span>
                                ) : null}
                                {r.issue === 'dup' ? (
                                  <span className="lm-roster-badge is-dup">重复 · 只留第一条</span>
                                ) : null}
                              </td>
                              <td>{r.name || <span className="lm-roster-cell-empty">—</span>}</td>
                              <td>{r.name_en || <span className="lm-roster-cell-empty">—</span>}</td>
                              <td>
                                {r.lang ? (
                                  <>
                                    <span className="lm-roster-lang-code">{r.lang}</span>
                                    <span className="lm-roster-lang-text">
                                      {LANG_TEXT[r.lang] || ''}
                                    </span>
                                  </>
                                ) : (
                                  <span className="lm-roster-cell-empty">未填 · 按 en</span>
                                )}
                              </td>
                              <td>{r.class_no || <span className="lm-roster-cell-empty">—</span>}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>

                    {built.rows.length > PREVIEW_ROWS ? (
                      <p className="lm-roster-hint">
                        只预览前 {PREVIEW_ROWS} 行；导入时按全部 {built.rows.length} 行处理。
                      </p>
                    ) : null}

                    {built.ready.length === 0 ? (
                      <p className="lm-roster-hint is-warn">
                        这些行还没有可导入的学号：看看上面「列映射」里「学号」选的是哪一列。
                      </p>
                    ) : null}
                  </>
                ) : (
                  <p className="lm-roster-hint is-warn">
                    只有表头、没有数据行——检查是不是把表头也一起粘进来了。
                  </p>
                )}
              </>
            ) : null}

            <div className="lm-roster-opts">
              <div className="lm-roster-optgroup">
                <div className="lm-roster-optlabel">导入方式</div>
                <label className="lm-roster-radio">
                  <input
                    type="radio"
                    name="lm-roster-mode"
                    checked={mode === 'append'}
                    disabled={busyAny}
                    onChange={() => setMode('append')}
                  />
                  <span className="lm-roster-radio-main">
                    追加
                    <span className="lm-roster-radio-sub">保留现有名单，同学号按新数据更新</span>
                  </span>
                </label>
                <label className="lm-roster-radio">
                  <input
                    type="radio"
                    name="lm-roster-mode"
                    checked={mode === 'replace'}
                    disabled={busyAny}
                    onChange={() => setMode('replace')}
                  />
                  <span className="lm-roster-radio-main">
                    替换
                    <span className="lm-roster-radio-sub">
                      清空后导入，示例学生按下面的开关决定留不留
                    </span>
                  </span>
                </label>
              </div>

              <label className="lm-roster-check">
                <input
                  type="checkbox"
                  checked={keepDemo}
                  disabled={busyAny}
                  onChange={(e) => setKeepDemo(e.target.checked)}
                />
                <span>{demoLabel}</span>
              </label>
              {mode === 'append' ? (
                <p className="lm-roster-hint">
                  追加模式不动已有学生，这个开关只在「替换」时起作用。
                </p>
              ) : !keepDemo ? (
                <p className="lm-roster-hint is-warn">
                  替换 + 不保留示例：导入后名单里只剩这一次的 {built.ready.length} 条。
                </p>
              ) : null}

              <div className="lm-roster-actions">
                <Btn
                  variant="primary"
                  size="lg"
                  block
                  onClick={doImport}
                  disabled={busyAny || !built.ready.length}
                >
                  {busy === 'import'
                    ? '导入中…'
                    : built.ready.length
                      ? `导入 ${built.ready.length} 条`
                      : '导入 0 条'}
                </Btn>
              </div>

              {importMsg.text ? (
                <p
                  className={
                    importMsg.tone === 'ok' ? 'lm-roster-msg is-ok' : 'lm-roster-msg is-err'
                  }
                  role={importMsg.tone === 'err' ? 'alert' : 'status'}
                >
                  {importMsg.text}
                </p>
              ) : null}
            </div>
          </section>

          {/* ---------- C. 清理 ---------- */}
          <section className="lm-roster-sec is-danger">
            <div className="lm-roster-sec-head">
              <Eyebrow>CLEANUP · 清理</Eyebrow>
              <span className="lm-roster-sec-tag">不可撤销，会二次确认</span>
            </div>

            <div className="lm-roster-danger-row">
              <Btn
                variant="amber"
                onClick={doClearAll}
                disabled={busyAny || !roster}
                className="lm-roster-danger-btn"
              >
                {busy === 'clear' ? '清空中…' : '清空全部名单（含示例）'}
              </Btn>
              <Btn
                onClick={doRestoreDemo}
                disabled={busyAny || !roster}
                className="lm-roster-danger-btn"
              >
                {busy === 'restore' ? '恢复中…' : '恢复示例学生'}
              </Btn>
            </div>

            {cleanMsg.text ? (
              <p
                className={cleanMsg.tone === 'ok' ? 'lm-roster-msg is-ok' : 'lm-roster-msg is-err'}
                role={cleanMsg.tone === 'err' ? 'alert' : 'status'}
              >
                {cleanMsg.text}
              </p>
            ) : null}

            <p className="lm-roster-hint">
              要只删示例学生，用「清空全部名单」再点「恢复示例学生」。
            </p>
            <p className="lm-roster-hint">
              说清楚点：清空会把示例和导入的学生一起删掉，恢复只把示例学生加回来——两步连着做，
              等于只删掉导入的学生。
            </p>
          </section>
        </div>

        <footer className="lm-roster-foot">
          <span className="lm-roster-foot-note">
            {roster ? `当前 ${total} 人 · 分母就是它` : '名单读取中…'}
          </span>
          <Btn onClick={() => onClose && onClose()}>完成</Btn>
        </footer>
      </div>
    </div>
  )
}
