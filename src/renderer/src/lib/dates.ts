/**
 * 渲染层日期工具（从原 app.js 迁移）。
 * 注意：避免 strftime 跨平台差异，手动拼接。
 */

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/** Date → YYYY-MM-DD（本地时区） */
export function isoDate(d: Date | string): string {
  const x = new Date(d)
  return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`
}

/** Date → YYYY/M/D（月日无前导零，与周报输出格式一致） */
export function fmtDateNoZero(d: Date | string): string {
  const x = new Date(d)
  return `${x.getFullYear()}/${x.getMonth() + 1}/${x.getDate()}`
}

/** 今天的 ISO 日期 */
export function todayISO(): string {
  return isoDate(new Date())
}

/** N 天前的 ISO 日期 */
export function daysAgoISO(n: number): string {
  return isoDate(new Date(Date.now() - n * 86400000))
}
