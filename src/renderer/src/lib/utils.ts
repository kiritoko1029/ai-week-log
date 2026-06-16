import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/** shadcn 标配：合并 Tailwind class，处理冲突 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * 暗色终端风「代码/报告」展示面板的统一视觉。
 * 仅含字体、字号、行高、配色与圆角描边；padding 与尺寸（min-h / resize / focus）按场景在 cn() 后叠加，
 * 保证报告预览、编辑器、笔记原文、历史正文四处排版完全一致。
 */
export const codeSurface =
  'rounded-md border bg-zinc-950 font-mono text-sm leading-[1.8] text-slate-200'
