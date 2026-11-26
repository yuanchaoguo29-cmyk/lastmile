/* 学号解析：把 8 位学号拆成「学历 + 年级」。
 *
 * 规则（学校教务口径，冻结）：
 *   d1      → 学历：1 = 博士 / 2 = 硕士 / 5 = 本科
 *   d2 d3   → 年级：20{d2d3} 级，例如 23 → 2023级
 *   d4-d8   → 流水号，与学历/年级无关，忽略
 *
 * 例：
 *   52300001 → { degree: '本科', grade: '2023级' }
 *   22400015 → { degree: '硕士', grade: '2024级' }
 *   12600030 → { degree: '博士', grade: '2026级' }
 *   20260007 → { degree: '硕士', grade: '2020级' }（老示例学号，格式仍是 8 位数字，按规则解析）
 *   1234567  → null（不是 8 位）
 *   32300001 → null（第 1 位不是 1/2/5）
 *
 * 只做「格式 + 首尾规则」判断，不查库；调用方拿它补字段、做「手填 vs 学号推断」对比。
 * 解析不出来一律返回 null，由调用方决定提示什么（不要在这里抛错）。
 */

/** 第 1 位数字 → 学历 */
const DEGREE_BY_FIRST_DIGIT = {
  1: '博士',
  2: '硕士',
  5: '本科'
}

/** 8 位纯数字 */
export const STUDENT_ID_RE = /^\d{8}$/

/** 从学号推断学历与年级；格式不合规返回 null */
export function parseStudentId(id) {
  const s = String(id ?? '').trim()
  if (!STUDENT_ID_RE.test(s)) return null
  const degree = DEGREE_BY_FIRST_DIGIT[s[0]]
  if (!degree) return null
  return { degree, grade: `20${s.slice(1, 3)}级` }
}

/** 反向用：学历 → 学号第 1 位（生成示例名单时用） */
export const ID_DIGIT_OF_DEGREE = {
  博士: '1',
  硕士: '2',
  本科: '5'
}

export default parseStudentId
