/* 目标学生选择器：说清楚「这份通知发给谁」。
   受控组件：value = { mode: 'all' | 'filter' | 'pick', ids: string[] }，
   任何改动都通过 onChange 回传；mode === 'all' 时 ids 一定是 []（服务端把空/省略当成「名下全部」）。
   三种选法：
     all    → 全部学生，ids 恒为 []
     filter → 学历 / 年级 / 班级 / 国籍 四个下拉，选出来的值以 chip 形式叠加；
              四个维度之间是「同时满足」，同一个维度里多个值是「任意一个」
     pick   → 搜索 + 勾选，勾到谁就是谁
   组件自己不算「最终名单」以外的任何东西：名单来自 roster（花名册），这里只负责选。 */

import React, { useEffect, useMemo, useState } from 'react'

/* 超过这个数就只渲染前 N 条，让人用搜索收窄，别把 400 人的列表全塞进 DOM */
const PICK_LIMIT = 50

const MODES = [
  { key: 'all', label: '全部', hint: '名下所有学生' },
  { key: 'filter', label: '按条件', hint: '学历 / 年级 / 班级 / 国籍' },
  { key: 'pick', label: '手选', hint: '一个一个勾' }
]

const FIELDS = [
  { key: 'degree', label: '学历', fallback: ['本科', '硕士', '博士'] },
  { key: 'grade', label: '年级', fallback: [] },
  { key: 'class_no', label: '班级', fallback: [] },
  { key: 'nationality', label: '国籍', fallback: [] }
]

const EMPTY_FILTERS = { degree: [], grade: [], class_no: [], nationality: [] }
const EMPTY_IDS = []

function text(v) {
  return String(v === null || v === undefined ? '' : v).trim()
}

/* roster 可以是数组，也可以是 getRoster() 的原样返回（有 students 字段） */
function normalizeRoster(roster) {
  if (Array.isArray(roster)) return roster.filter((s) => s && text(s.student_id))
  if (roster && Array.isArray(roster.students)) {
    return roster.students.filter((s) => s && text(s.student_id))
  }
  return []
}

function sortValues(list) {
  return list.slice().sort((a, b) => a.localeCompare(b, 'zh-Hans-CN', { numeric: true }))
}

/* 某个维度可选的值 = 名单里真实出现过的值（白名单里的常见值补在后面，方便空名单时也能选） */
function optionsOf(students, field) {
  const seen = []
  students.forEach((s) => {
    const v = text(s[field.key])
    if (v && seen.indexOf(v) === -1) seen.push(v)
  })
  field.fallback.forEach((v) => {
    if (seen.indexOf(v) === -1) seen.push(v)
  })
  return sortValues(seen)
}

/* 四个维度之间是 AND，同一维度里多个值是 OR */
function matches(student, filters) {
  for (let i = 0; i < FIELDS.length; i += 1) {
    const f = FIELDS[i]
    const chosen = filters[f.key] || []
    if (!chosen.length) continue
    const v = text(student[f.key])
    if (!v) return false
    const low = v.toLowerCase()
    let hit = false
    for (let j = 0; j < chosen.length; j += 1) {
      if (chosen[j].toLowerCase() === low) {
        hit = true
        break
      }
    }
    if (!hit) return false
  }
  return true
}

function nameOf(s) {
  return text(s.name) || text(s.name_en) || '—'
}

export default function TargetPicker({ value, onChange, roster, disabled = false }) {
  const students = useMemo(() => normalizeRoster(roster), [roster])

  /* 外部值：认不出来的 mode 一律退回 all，ids 只留非空字符串 */
  const mode = value && (value.mode === 'filter' || value.mode === 'pick') ? value.mode : 'all'
  const ids = useMemo(() => {
    const raw = value && Array.isArray(value.ids) ? value.ids : EMPTY_IDS
    const out = []
    raw.forEach((id) => {
      const v = text(id)
      if (v && out.indexOf(v) === -1) out.push(v)
    })
    return out
  }, [value])

  /* 条件模式里的四个维度；只活在组件里，不往外传 */
  const [filters, setFilters] = useState(EMPTY_FILTERS)
  /* 用户动过条件没有：没动过时，按草稿里存的 ids 走，别一进页面就把范围改掉 */
  const [touched, setTouched] = useState(false)
  const [q, setQ] = useState('')

  const rosterIds = useMemo(() => students.map((s) => text(s.student_id)), [students])
  const idIndex = useMemo(() => new Set(rosterIds), [rosterIds])

  const options = useMemo(() => {
    const out = {}
    FIELDS.forEach((f) => {
      out[f.key] = optionsOf(students, f)
    })
    return out
  }, [students])

  const matched = useMemo(() => students.filter((s) => matches(s, filters)), [students, filters])
  const matchedIds = useMemo(() => matched.map((s) => text(s.student_id)), [matched])

  /* 手选里可能留着已经不在名单里的学号：按名单过一遍，避免「说发 5 人其实只有 3 人」 */
  const pickedIds = useMemo(() => {
    if (!rosterIds.length) return ids
    return ids.filter((id) => idIndex.has(id))
  }, [ids, rosterIds, idIndex])

  const chosenAny = FIELDS.some((f) => (filters[f.key] || []).length > 0)

  /* 条件没动过、但草稿里已经存了 ids：先按存下来的算，动条件才重算 */
  const keptByDraft = mode === 'filter' && !touched && ids.length > 0

  const resolvedIds =
    mode === 'all'
      ? EMPTY_IDS
      : mode === 'filter'
        ? touched
          ? matchedIds
          : ids
        : pickedIds

  const count = mode === 'all' ? students.length : resolvedIds.length
  const signature = mode + '|' + resolvedIds.join(',')
  const valueSignature = mode + '|' + ids.join(',')

  /* 算出来的 ids 跟外面存的不一样就回传一次；一样就什么都不做，避免死循环 */
  useEffect(() => {
    if (signature === valueSignature) return
    onChange({ mode, ids: mode === 'all' ? [] : resolvedIds })
  }, [signature, valueSignature])

  const searched = useMemo(() => {
    const needle = q.trim().toLowerCase()
    if (!needle) return students
    return students.filter((s) => {
      const hay = [s.student_id, s.name, s.name_en, s.email, s.nationality, s.degree, s.grade, s.class_no]
        .map(text)
        .join(' ')
        .toLowerCase()
      return hay.indexOf(needle) !== -1
    })
  }, [students, q])

  const visible = searched.slice(0, PICK_LIMIT)

  function chooseMode(next) {
    if (disabled || next === mode) return
    if (next === 'all') {
      onChange({ mode: 'all', ids: [] })
      return
    }
    if (next === 'filter') {
      setTouched(false)
      onChange({ mode: 'filter', ids: matchedIds })
      return
    }
    /* 切到手选：把当前的范围直接变成勾选，省得从头再点一遍 */
    const seed = mode === 'filter' ? resolvedIds : ids
    onChange({ mode: 'pick', ids: seed })
  }

  function addFilter(key, v) {
    if (!v || disabled) return
    setTouched(true)
    setFilters((prev) => {
      const list = prev[key] || []
      if (list.indexOf(v) !== -1) return prev
      return { ...prev, [key]: list.concat([v]) }
    })
  }

  function removeFilter(key, v) {
    if (disabled) return
    setTouched(true)
    setFilters((prev) => {
      const list = prev[key] || []
      return { ...prev, [key]: list.filter((x) => x !== v) }
    })
  }

  function clearFilters() {
    if (disabled) return
    setTouched(true)
    setFilters(EMPTY_FILTERS)
  }

  function setPicked(nextIds) {
    /* 按名单顺序存，看板里的人顺序才稳定 */
    const set = new Set(nextIds)
    onChange({ mode: 'pick', ids: rosterIds.filter((id) => set.has(id)) })
  }

  function togglePick(id) {
    if (disabled) return
    const set = new Set(pickedIds)
    if (set.has(id)) set.delete(id)
    else set.add(id)
    setPicked(Array.from(set))
  }

  function selectVisible() {
    if (disabled) return
    const set = new Set(pickedIds)
    visible.forEach((s) => set.add(text(s.student_id)))
    setPicked(Array.from(set))
  }

  return (
    <div className={`lm-target${disabled ? ' is-disabled' : ''}`}>
      <div className="lm-target-bar">
        <div className="lm-target-modes" role="group" aria-label="选择发给谁">
          {MODES.map((m) => (
            <button
              key={m.key}
              type="button"
              className={`lm-target-mode${mode === m.key ? ' is-on' : ''}`}
              aria-pressed={mode === m.key}
              disabled={disabled}
              onClick={() => chooseMode(m.key)}
            >
              <span className="lm-target-mode-label">{m.label}</span>
              <span className="lm-target-mode-hint">{m.hint}</span>
            </button>
          ))}
        </div>
        <div className="lm-target-count" role="status" aria-live="polite">
          {mode === 'all' && !students.length ? (
            '将发给全部学生'
          ) : (
            <>
              将发给 <b>{count}</b> 人
            </>
          )}
        </div>
      </div>

      {!students.length ? (
        <p className="lm-target-note is-warn">
          没读到学生名单：先去花名册（顶栏那个人形图标）导入；如果是刚加载失败，点上面的重试。
        </p>
      ) : null}

      {mode === 'all' ? (
        <p className="lm-target-note">
          {students.length
            ? `名下全部 ${students.length} 人都会收到。以后新导入的学生也自动算在「全部」里。`
            : '按「名下全部学生」发，具体人数由服务端按当前名单算。'}
        </p>
      ) : null}

      {mode === 'filter' ? (
        <div className="lm-target-filters">
          {FIELDS.map((f) => {
            const chosen = filters[f.key] || []
            const opts = options[f.key] || []
            const selectId = `lm-target-f-${f.key}`
            return (
              <div className="lm-target-filter" key={f.key}>
                <label className="lm-target-flabel" htmlFor={selectId}>
                  {f.label}
                </label>
                <select
                  id={selectId}
                  className="lm-target-select"
                  value=""
                  disabled={disabled || !opts.length}
                  onChange={(e) => {
                    const v = e.target.value
                    addFilter(f.key, v)
                    /* 选完立刻回到「不限」：条件以 chip 展示，下拉本身不留选中态 */
                    e.target.value = ''
                  }}
                >
                  <option value="">{opts.length ? '不限 / 加条件' : '名单里没有这一项'}</option>
                  {opts.map((v) => (
                    <option key={v} value={v} disabled={chosen.indexOf(v) !== -1}>
                      {v}
                    </option>
                  ))}
                </select>
                <div className="lm-target-chips">
                  {chosen.length ? (
                    chosen.map((v) => (
                      <button
                        key={v}
                        type="button"
                        className="lm-target-chip"
                        disabled={disabled}
                        title="点掉这个条件"
                        onClick={() => removeFilter(f.key, v)}
                      >
                        {v}
                        <span className="lm-target-chip-x" aria-hidden="true">
                          ×
                        </span>
                      </button>
                    ))
                  ) : (
                    <span className="lm-target-chip-empty">不限</span>
                  )}
                </div>
              </div>
            )
          })}

          <p className="lm-target-note">
            四个条件同时满足才算命中；同一个格子里选两个，是「任意一个」。
            {chosenAny ? ` 现在命中 ${matched.length} 人。` : ' 现在没加条件，等于全部。'}
          </p>

          {keptByDraft ? (
            <p className="lm-target-note">
              这份草稿已经存了 {ids.length} 人的范围（条件还在生效）。
              动上面的条件会按新条件重算，没动就保持原样。
            </p>
          ) : null}

          {chosenAny ? (
            <div className="lm-target-filtactions">
              <button type="button" className="lm-target-mini" disabled={disabled} onClick={clearFilters}>
                清空条件
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      {mode === 'pick' ? (
        <div className="lm-target-pick">
          <div className="lm-target-searchrow">
            <input
              className="lm-target-search"
              type="search"
              value={q}
              disabled={disabled}
              placeholder="搜学号 / 姓名 / 邮箱 / 国籍 / 年级"
              aria-label="搜索学生"
              onChange={(e) => setQ(e.target.value)}
            />
            <span className="lm-target-picked">
              已选 <b>{pickedIds.length}</b> 人
            </span>
            <button
              type="button"
              className="lm-target-mini"
              disabled={disabled || !visible.length}
              onClick={selectVisible}
            >
              全选列表
            </button>
            <button
              type="button"
              className="lm-target-mini"
              disabled={disabled || !pickedIds.length}
              onClick={() => setPicked([])}
            >
              清空已选
            </button>
          </div>

          {visible.length ? (
            <ul className="lm-target-list">
              {visible.map((s) => {
                const sid = text(s.student_id)
                const on = pickedIds.indexOf(sid) !== -1
                const meta = [s.nationality, s.degree, s.grade, s.class_no]
                  .map(text)
                  .filter(Boolean)
                  .join(' · ')
                return (
                  <li className={`lm-target-item${on ? ' is-on' : ''}`} key={sid}>
                    <label className="lm-target-itemlabel">
                      <input
                        type="checkbox"
                        checked={on}
                        disabled={disabled}
                        onChange={() => togglePick(sid)}
                      />
                      <span className="lm-target-itemmain">
                        <span className="lm-target-id">{sid}</span>
                        <span className="lm-target-name">{nameOf(s)}</span>
                        <span className="lm-target-meta">{meta || '国籍 / 学历 / 年级待补'}</span>
                        {text(s.email) ? (
                          <span className="lm-target-mail">{text(s.email)}</span>
                        ) : (
                          <span className="lm-target-mail is-bad">没邮箱 · 邮件发不到</span>
                        )}
                      </span>
                    </label>
                  </li>
                )
              })}
            </ul>
          ) : (
            <p className="lm-target-note is-warn">
              {students.length
                ? '没搜到人：换个关键词，或者清掉搜索框。'
                : '还没读到学生：先去花名册导入；如果是刚加载失败，点上面的重试。'}
            </p>
          )}

          {searched.length > PICK_LIMIT ? (
            <p className="lm-target-note is-warn">
              列表只显示前 {PICK_LIMIT} 条（共 {searched.length} 条），用上面的搜索收窄；
              已经勾上的人不在当前列表里也算数。
            </p>
          ) : null}
        </div>
      ) : null}

      {mode === 'all' && !students.length ? (
        <p className="lm-target-foot">
          名单还没读到，这一份按「名下全部学生」发，具体人数以服务端为准。
        </p>
      ) : count === 0 ? (
        <p className="lm-target-note is-warn">
          还没选到人：
          {mode === 'filter'
            ? chosenAny
              ? '条件太窄了，放宽一点或清空条件。'
              : '加一个条件，或者切到「全部」。'
            : '至少勾一个人，否则没人能收到。'}
        </p>
      ) : (
        <p className="lm-target-foot">
          {mode === 'all'
            ? '看板、催办、导出都按全部学生算。'
            : `看板、催办、导出邮件都只按这 ${count} 人算。`}
        </p>
      )}
    </div>
  )
}
