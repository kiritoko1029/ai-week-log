'use strict'
// @ts-check
/**
 * 基础工具函数：日期解析/格式化、时间范围、token 估算。
 * 跨平台（Windows/macOS），不依赖任何第三方库。
 */

/** 无前导零日期，匹配周报格式：2026/6/15 */
function formatDateNoZero(d) {
  const dt = d instanceof Date ? d : new Date(d)
  return `${dt.getFullYear()}/${dt.getMonth() + 1}/${dt.getDate()}`
}

/** ISO 日期串：2026-06-15 */
function isoDate(d) {
  const dt = d instanceof Date ? d : new Date(d)
  const y = dt.getFullYear()
  const m = String(dt.getMonth() + 1).padStart(2, '0')
  const day = String(dt.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** 解析日期输入：today / yesterday / YYYY-MM-DD / Date */
function parseDateInput(input) {
  if (input instanceof Date) return input
  if (!input || input === 'today') return today()
  if (input === 'yesterday') {
    const d = today()
    d.setDate(d.getDate() - 1)
    return d
  }
  const d = new Date(`${input}T00:00:00`) // 按本地时区解释
  if (Number.isNaN(d.getTime())) throw new Error(`非法日期：${input}`)
  return d
}

/** 当天 00:00（本地） */
function today() {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d
}

/**
 * 解析时间范围为 [from, to]（闭区间，均为本地 00:00 的 Date）。
 * @param {object} opts - { mode:'weekly'|'daily', week, from, to, days, date, weekStart }
 */
function resolveRange(opts = {}, weekStart = 'monday') {
  const mode = opts.mode || 'weekly'
  if (mode === 'daily') {
    const d = parseDateInput(opts.date || 'today')
    return { from: d, to: d }
  }
  if (opts.from || opts.to) {
    const to = parseDateInput(opts.to || 'today')
    const from = opts.from ? parseDateInput(opts.from) : weekStartOf(to, weekStart)
    return { from, to }
  }
  if (opts.days) {
    const to = today()
    const from = today()
    from.setDate(from.getDate() - (Number(opts.days) - 1))
    return { from, to }
  }
  if (opts.week === 'last') {
    const ref = today()
    ref.setDate(ref.getDate() - 7)
    return weekRange(ref, weekStart)
  }
  if (typeof opts.week === 'string' && /^\d{4}-W\d{2}$/.test(opts.week)) {
    return isoWeekRange(opts.week, weekStart)
  }
  // 默认：本周（周起始日至今）
  const from = weekStartOf(today(), weekStart)
  return { from, to: today() }
}

/** 某日所在周的周起始日（00:00） */
function weekStartOf(d, weekStart = 'monday') {
  const dt = new Date(d)
  dt.setHours(0, 0, 0, 0)
  const dow = dt.getDay() // 0=周日..6=周六
  const offset = weekStart === 'sunday' ? dow : (dow + 6) % 7 // 周一起始时把周日(0)映射为6
  dt.setDate(dt.getDate() - offset)
  return dt
}

/** 某日所在周的 [起始, 结束]（结束为周日 00:00，闭区间取到周六） */
function weekRange(ref, weekStart = 'monday') {
  const from = weekStartOf(ref, weekStart)
  const to = new Date(from)
  to.setDate(to.getDate() + 6)
  return { from, to }
}

/** 解析 ISO 周（如 2026-W23）为该周 [from, to]（周一为起始） */
function isoWeekRange(isoWeek, weekStart = 'monday') {
  const m = /^(\d{4})-W(\d{2})$/.exec(isoWeek)
  if (!m) throw new Error(`非法 ISO 周：${isoWeek}`)
  const year = Number(m[1])
  const week = Number(m[2])
  // ISO 周：该年第一个周四所在周为 W01
  const jan4 = new Date(year, 0, 4)
  const w1mon = weekStartOf(jan4, 'monday')
  const from = new Date(w1mon)
  from.setDate(from.getDate() + (week - 1) * 7)
  const to = new Date(from)
  to.setDate(to.getDate() + 6)
  if (weekStart === 'sunday') {
    from.setDate(from.getDate() - 1)
    to.setDate(to.getDate() - 1)
  }
  return { from, to }
}

/** 日期包含判断（按本地日历日，忽略时分秒） */
function inRange(d, from, to) {
  const t = new Date(d)
  t.setHours(0, 0, 0, 0)
  const f = new Date(from); f.setHours(0, 0, 0, 0)
  const e = new Date(to); e.setHours(0, 0, 0, 0)
  return t >= f && t <= e
}

/** 按日期升序排序辅助 */
function byDateAsc(a, b) {
  return new Date(a) - new Date(b)
}

/** 粗略 token 估算：中文 ≈ 1 token/字，其余 ≈ 1 token/4 字符 */
function estimateTokens(text) {
  if (!text) return 0
  const str = String(text)
  let cn = 0
  for (const ch of str) {
    if (/[一-鿿]/.test(ch)) cn++
  }
  const other = str.length - cn
  return cn + Math.ceil(other / 4)
}

/** 统计中文句数（按 。！？ 切分，过滤空句） */
function countSentences(text) {
  if (!text) return 0
  const parts = String(text).split(/[。！？!?]/).filter((s) => s.trim().length > 0)
  return parts.length
}

module.exports = {
  formatDateNoZero,
  isoDate,
  parseDateInput,
  today,
  resolveRange,
  weekStartOf,
  weekRange,
  isoWeekRange,
  inRange,
  byDateAsc,
  estimateTokens,
  countSentences,
}
