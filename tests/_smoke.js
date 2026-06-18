'use strict'
/* 核心逻辑冒烟测试：验证 git 解析 / 笔记解析 / 聚合融合 / Prompt 组装 / 渲染，不依赖 electron。 */
const U = require('../src/main/utils')
const G = require('../src/main/git')
const N = require('../src/main/notes')
const A = require('../src/main/aggregator')
const L = require('../src/main/llm')
const R = require('../src/main/render')

const RS = '\x1e'
const US = '\x1f'
let pass = 0
let fail = 0

function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name) }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')) }
}

console.log('\n[1] utils 日期/范围')
ok('formatDateNoZero 无前导零', U.formatDateNoZero(new Date(2026, 5, 15)) === '2026/6/15', U.formatDateNoZero(new Date(2026, 5, 15)))
ok('isoDate 补零', U.isoDate(new Date(2026, 5, 9)) === '2026-06-09')
{
  const r = U.resolveRange({ mode: 'daily', date: '2026-06-15' })
  ok('daily 范围 from==to', U.isoDate(r.from) === '2026-06-15' && U.isoDate(r.to) === '2026-06-15')
}
{
  const r = U.resolveRange({ from: '2026-06-01', to: '2026-06-13' })
  ok('自定义范围', U.isoDate(r.from) === '2026-06-01' && U.isoDate(r.to) === '2026-06-13')
}
ok('estimateTokens 中文', U.estimateTokens('你好世界') >= 4)

console.log('\n[2] git log 解析（0x1e/0x1f 分隔）')
const raw = [
  RS + 'abc123' + US + '张三' + US + 'z@corp.com' + US + '2026-06-09 10:00:00' + US + 'feat: 新功能 A' + US + '实现细节' + US,
  '12\t3\tsrc/a.py',
  '8\t1\tsrc/b.py',
  RS + 'def456' + US + '张三' + US + 'z@corp.com' + US + '2026-06-10 11:00:00' + US + 'fix: 修复 B' + US + US,
  '3\t5\tsrc/c.py',
].join('\n')
const commits = G.parseGitLog(raw, '/repo', '前端')
ok('解析出 2 条 commit', commits.length === 2, 'got ' + commits.length)
ok('commit0 字段正确', commits[0].hash === 'abc123' && commits[0].subject === 'feat: 新功能 A' && commits[0].project === '前端', JSON.stringify(commits[0]))
ok('commit0 文件数 2', commits[0].files.length === 2 && commits[0].insertions === 20, 'ins=' + commits[0].insertions)
ok('commit0 localDate', commits[0].localDate === '2026-06-09')
ok('commit1 body 为空', commits[1].body === '' && commits[1].files.length === 1)

console.log('\n[3] 笔记解析与追加')
const notesParsed = N.parseNoteText('## 前端\n工作 A\n\n## 日常工作\n通用 B', '2026-06-09', '日常工作', 'notes/x.md')
ok('解析 2 条笔记', notesParsed.length === 2, 'got ' + notesParsed.length)
ok('项目笔记 project=前端', notesParsed[0].project === '前端' && notesParsed[0].content === '工作 A')
ok('通用笔记 project=null', notesParsed[1].project === null && notesParsed[1].content === '通用 B')
{
  const seg = N.appendSegment('## 前端\n工作 A\n', '前端', '工作 B')
  ok('追加到已有段', seg.includes('工作 A') && seg.includes('工作 B'), seg)
}
{
  const seg = N.appendSegment('## 前端\n工作 A\n', '后端', '工作 C')
  ok('新建段追加', /## 后端\n工作 C/.test(seg), seg)
}

console.log('\n[4] 聚合 + 笔记融合 + 别名')
const testCommits = G.parseGitLog(raw, '/repo', '前端')
const testNotes = [
  { date: '2026-06-09', project: '前端', content: '项目笔记 X' },
  { date: '2026-06-09', project: '前端别名', content: '别名笔记 Z' },
  { date: '2026-06-09', project: null, content: '通用 Y' },
]
const buckets = A.aggregate(testCommits, testNotes, '日常工作', [{ name: '前端', alias: '前端别名' }])
ok('生成 3 个桶', buckets.length === 3, 'got ' + buckets.length + ': ' + buckets.map((b) => b.dayStr + '/' + b.project).join(', '))
const b0 = buckets.find((b) => b.dayStr === '2026-06-09' && b.project === '前端')
ok('前端桶有 1 commit', b0 && b0.commits.length === 1)
ok('前端桶 displayName=别名', b0 && b0.displayName === '前端别名', b0 && b0.displayName)
ok('别名笔记归入前端桶（alias→name 映射）', b0 && b0.notes.length === 2, 'notes=' + (b0 && b0.notes.length))
ok('通用笔记注入 sharedNotes', b0 && b0.sharedNotes.length === 1 && b0.sharedNotes[0].content === '通用 Y')
const misc = buckets.find((b) => b.project === '日常工作')
ok('日常工作桶为纯笔记段', misc && misc.isNotesOnly === true && misc.notes.length === 1)

console.log('\n[5] Prompt 融合组装')
const prompt = L.buildUserPrompt(b0)
ok('含【代码提交】段', prompt.includes('【代码提交】'))
ok('含 commit subject', prompt.includes('feat: 新功能 A'))
ok('含【人工笔记】段', prompt.includes('【人工笔记】'))
ok('含项目笔记内容', prompt.includes('项目笔记 X'))
ok('含通用笔记内容', prompt.includes('通用 Y'))

console.log('\n[6] 渲染 text 格式')
const report = {
  rangeStart: new Date(2026, 5, 9), rangeEnd: new Date(2026, 5, 13),
  days: [{ day: new Date(2026, 5, 9), dayStr: '2026-06-09', paragraphs: [{ project: '前端', text: '总结内容。', degraded: false }] }],
  failedUnits: [],
}
const text = R.renderText(report)
ok('日期无前导零', text.includes('2026/6/9'), text)
ok('项目行格式', /【前端】：总结内容。/.test(text), text)

console.log('\n[7] LLM 异常体系')
const { LLMAuthError, LLMRateLimited } = require('../src/main/llm/base')
ok('异常类可实例化', new LLMAuthError('x') instanceof Error && new LLMRateLimited('y') instanceof Error)

console.log('\n[8] 渲染 compact 格式')
{
  const report2 = {
    rangeStart: new Date(2026, 5, 9), rangeEnd: new Date(2026, 5, 13),
    days: [
      { day: new Date(2026, 5, 9), paragraphs: [{ project: '前端', text: '总结A。' }, { project: '后端', text: '总结B。' }] },
      { day: new Date(2026, 5, 10), paragraphs: [{ project: '前端', text: '总结C。' }] },
    ],
    failedUnits: [],
  }
  const compact = R.renderCompact(report2)
  ok('每天一行', compact.split('\n').length === 2, 'lines=' + compact.split('\n').length + ' :: ' + compact)
  ok('同日段落连排', /2026\/6\/9 【前端】：总结A。【后端】：总结B。/.test(compact), compact)
  ok('次日照常换行', compact.includes('2026/6/10 【前端】：总结C。'), compact)
}

console.log('\n[9] 三格式互转 convertFormat')
{
  const report3 = {
    rangeStart: new Date(2026, 5, 9), rangeEnd: new Date(2026, 5, 13),
    days: [
      { day: new Date(2026, 5, 9), paragraphs: [{ project: '前端', text: '总结A。' }, { project: '后端', text: '总结B。' }] },
      { day: new Date(2026, 5, 10), paragraphs: [{ project: '前端', text: '总结C。' }] },
    ],
    failedUnits: [],
  }
  const text = R.renderText(report3)
  const compact = R.renderCompact(report3)
  const md = R.renderMarkdown(report3)

  // text → compact
  const t2c = R.convertFormat(text, { from: 'text', to: 'compact' })
  ok('text→compact 每天一行', t2c.split('\n').length === 2, t2c)
  ok('text→compact 连排正确', t2c.includes('2026/6/9 【前端】：总结A。【后端】：总结B。'), t2c)

  // compact → text
  const c2t = R.convertFormat(compact, { from: 'compact', to: 'text' })
  ok('compact→text 日期块独立行', /2026\/6\/9\n【前端】：总结A。\n【后端】：总结B。/.test(c2t), c2t)

  // md → text
  const m2t = R.convertFormat(md, { from: 'md', to: 'text' })
  ok('md→text 去除标记', m2t.includes('2026/6/9') && /【前端】：总结A。/.test(m2t) && !m2t.includes('**'), m2t)

  // text → md
  const t2m = R.convertFormat(text, { from: 'text', to: 'md' })
  ok('text→md 含标题', /# 工作周报/.test(t2m), t2m)
  ok('text→md 标题无 NaN（range 缺失兜底）', !t2m.includes('NaN'), t2m)
  ok('text→md 标题用首尾日期兜底', t2m.includes('工作周报 (2026/6/9 - 2026/6/10)'), t2m)
  ok('text→md 段落标记', t2m.includes('- **【前端】**：总结A。'), t2m)

  // 任意两两转换后回到 compact 应等价（往返保真）
  const c2m2c = R.convertFormat(R.convertFormat(compact, { from: 'compact', to: 'md' }), { from: 'md', to: 'compact' })
  ok('compact→md→compact 往返', c2m2c === compact, 'got: ' + JSON.stringify(c2m2c) + '\nexp: ' + JSON.stringify(compact))

  const t2c2t = R.convertFormat(R.convertFormat(text, { from: 'text', to: 'compact' }), { from: 'compact', to: 'text' })
  ok('text→compact→text 往返', t2c2t === text, 'got: ' + JSON.stringify(t2c2t) + '\nexp: ' + JSON.stringify(text))
}

console.log('\n[10] convertFormat 容错')
{
  // 无法解析的内容回退原文本
  const garbage = '这是一段无法解析的随机文本\n没有日期也没有项目'
  ok('无法解析回退原文', R.convertFormat(garbage, { from: 'text', to: 'compact' }) === garbage)
  ok('空文本安全', R.convertFormat('', { from: 'text', to: 'md' }) === '')
  ok('同格式原样返回', R.convertFormat('abc', { from: 'text', to: 'text' }) === 'abc')
}

console.log(`\n结果：${pass} 通过，${fail} 失败\n`)
process.exit(fail ? 1 : 0)
