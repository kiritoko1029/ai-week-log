import type { ReportFormat } from '@/types/weeklog'

/**
 * 启发式检测历史/已有报告文本的格式。
 * - md：含 `# 工作周报` 标题或 `## YYYY/M/D` 日期标题
 * - compact：每行日期开头（YYYY/M/D 后跟空格），行内含【项目】段
 * - text：默认（含日期块间空行 + 每项目一行）
 */
export function detectFormat(text: string): ReportFormat {
  if (!text) return 'text'
  if (/^#\s+工作周报/m.test(text) || /^##\s+\d{4}\/\d/.test(text)) return 'md'
  // 紧凑：每行含日期+多段落连排（行内多个【…】）
  const lines = text.split(/\r?\n/).filter((l) => /^\d{4}\/\d{1,2}\/\d{1,2}\s/.test(l))
  if (lines.length && lines.every((l) => (l.match(/【[^】]+】/g) || []).length >= 1)) return 'compact'
  return 'text'
}
