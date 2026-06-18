'use strict'
/* ZCode hook pending-note pool tests: storage, write, and AI summarization. */
const fs = require('fs')
const os = require('os')
const path = require('path')
const P = require('../src/main/zcode-pending-notes')
const N = require('../src/main/notes')

let pass = 0
let fail = 0

function ok(name, cond, extra) {
  if (cond) {
    pass++
    console.log('  ✓ ' + name)
  } else {
    fail++
    console.log('  ✗ ' + name + (extra ? '  → ' + extra : ''))
  }
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wl-zcode-pending-'))
}

function cfg() {
  return {
    notes: { miscProject: '日常工作' },
    repos: [
      { path: '/Users/me/apps/weeklog', name: 'WeekLog', alias: '周报工具' },
      { path: '/Users/me/apps/remote-control', name: 'RemoteControl' },
    ],
  }
}

async function main() {
  console.log('\n[1] pending note storage')
  {
    const dir = tmpDir()
    try {
      const saved = P.addPendingNote(dir, {
        source: 'zcode',
        cwd: '/Users/me/apps/weeklog',
        summary: '完成 ZCode hook 待处理小记池。',
        branch: 'zcode/hook-notes',
        changedFiles: ['src/main/ipc.js', 12, ''],
        finishedAt: '2026-06-18T08:00:00.000Z',
      }, cfg())
      ok('保存候选项返回 id', /^zpn_/.test(saved.id), saved.id)
      ok('候选项来源为 zcode', saved.source === 'zcode', saved.source)
      ok('根据 cwd 匹配项目名', saved.project === 'WeekLog', saved.project)
      ok('使用 finishedAt 作为 createdAt', saved.createdAt === '2026-06-18T08:00:00.000Z', saved.createdAt)
      ok('清理 changedFiles 非字符串项', saved.changedFiles.length === 1 && saved.changedFiles[0] === 'src/main/ipc.js')
      const list = P.listPendingNotes(dir)
      ok('列表只返回 pending 候选项', list.length === 1 && list[0].id === saved.id)
      let emptyRejected = false
      try {
        P.addPendingNote(dir, {
          cwd: '/Users/me/apps/weeklog',
          summary: '   ',
        }, cfg())
      } catch {
        emptyRejected = true
      }
      ok('空任务摘要不会进入待处理池', emptyRejected && P.listPendingNotes(dir).length === 1)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }

  console.log('\n[2] delete and write')
  {
    const dir = tmpDir()
    const notesDir = path.join(dir, 'notes')
    try {
      const a = P.addPendingNote(dir, {
        cwd: '/Users/me/apps/weeklog',
        summary: '完成待处理池 UI。',
        finishedAt: '2026-06-18T09:10:00.000Z',
      }, cfg())
      const b = P.addPendingNote(dir, {
        cwd: '/Users/me/apps/remote-control',
        summary: '修复远控连接状态。',
        finishedAt: '2026-06-17T09:10:00.000Z',
      }, cfg())
      const del = P.deletePendingNotes(dir, [b.id])
      ok('删除候选项会标记 deleted', del.deleted === 1, JSON.stringify(del))
      ok('删除后默认列表不包含该项', P.listPendingNotes(dir).length === 1)
      const result = P.writePendingNotes(dir, {
        ids: [a.id],
        notesDir,
        miscProject: '日常工作',
      })
      ok('写入返回数量', result.written === 1, JSON.stringify(result))
      const text = N.getNoteText(notesDir, '2026-06-18')
      ok('写入到候选项日期的项目段', /## WeekLog\n完成待处理池 UI。/.test(text), text)
      ok('已写入项不再出现在 pending 列表', P.listPendingNotes(dir).length === 0)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }

  console.log('\n[2b] normalize captured summary (strip ZCode metadata)')
  {
    const dir = tmpDir()
    try {
      const saved = P.addPendingNote(dir, {
        cwd: '/Users/me/apps/weeklog',
        summary: [
          '修复了 ZCode Hook 摘要清洗逻辑。',
          '',
          '<system-reminder>',
          'some injected context',
          '</system-reminder>',
        ].join('\n'),
      }, cfg())
      ok('入池时移除 system-reminder 元信息', saved.summary === '修复了 ZCode Hook 摘要清洗逻辑。', saved.summary)
      const legacy = {
        schemaVersion: 1,
        items: [
          {
            id: 'legacy-reminder',
            source: 'zcode',
            status: 'pending',
            cwd: '/Users/me/apps/weeklog',
            project: 'WeekLog',
            summary: [
              '旧候选项里带有系统提醒。',
              '',
              '<system-reminder>',
              'injected',
              '</system-reminder>',
            ].join('\n'),
            changedFiles: [],
            createdAt: '2026-06-18T09:00:00.000Z',
          },
        ],
      }
      P.writeStore(dir, legacy)
      const listed = P.listPendingNotes(dir)
      ok('读取旧候选项时也清理元信息', listed.length === 1 && listed[0].summary === '旧候选项里带有系统提醒。', JSON.stringify(listed))
      const notesDir = path.join(dir, 'notes')
      P.writePendingNotes(dir, {
        ids: ['legacy-reminder'],
        notesDir,
        miscProject: '日常工作',
      })
      const text = N.getNoteText(notesDir, '2026-06-18')
      ok('写入旧候选项时不带元信息', text.includes('旧候选项里带有系统提醒。') && !text.includes('<system-reminder>'), text)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }

  console.log('\n[3] summarize selected notes')
  {
    const dir = tmpDir()
    try {
      const a = P.addPendingNote(dir, {
        cwd: '/Users/me/apps/weeklog',
        summary: '完成本地 HTTP 接口和 token 校验。',
        changedFiles: ['src/main/zcode-hook-server.js'],
      }, cfg())
      const b = P.addPendingNote(dir, {
        cwd: '/Users/me/apps/weeklog',
        summary: '补充批量写入待处理小记的界面。',
        changedFiles: ['src/renderer/src/pages/NotesPage.tsx'],
      }, cfg())
      let seenSystem = ''
      let seenUser = ''
      const provider = {
        summarize: async (system, user) => {
          seenSystem = system
          seenUser = user
          return { text: '完成 ZCode hook 小记待处理池，包含安全接入和批量处理界面。', model: 'fake' }
        },
      }
      const r = await P.summarizePendingNotes(dir, { ids: [a.id, b.id], provider })
      ok('返回模型总结文本', r.text.includes('ZCode hook 小记待处理池'), r.text)
      ok('系统提示要求只输出笔记内容', /直接输出/.test(seenSystem), seenSystem)
      ok('用户提示包含两条候选摘要', seenUser.includes('本地 HTTP 接口') && seenUser.includes('批量写入'), seenUser)
      ok('AI 总结不改变 pending 状态', P.listPendingNotes(dir).length === 2)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }

  console.log('\n[4] write AI summary once for selected notes')
  {
    const dir = tmpDir()
    const notesDir = path.join(dir, 'notes')
    try {
      const a = P.addPendingNote(dir, {
        cwd: '/Users/me/apps/weeklog',
        summary: '完成本地 HTTP 接口。',
        finishedAt: '2026-06-18T09:00:00.000Z',
      }, cfg())
      const b = P.addPendingNote(dir, {
        cwd: '/Users/me/apps/weeklog',
        summary: '完成待处理池界面。',
        finishedAt: '2026-06-18T10:00:00.000Z',
      }, cfg())
      const result = P.writePendingNotes(dir, {
        ids: [a.id, b.id],
        notesDir,
        miscProject: '日常工作',
        project: 'WeekLog',
        content: '完成 ZCode hook 小记待处理池，支持安全接入、批量确认和 AI 汇总录入。',
      })
      const text = N.getNoteText(notesDir, '2026-06-18')
      const occurrences = (text.match(/完成 ZCode hook 小记待处理池/g) || []).length
      ok('总结内容只写入一次', occurrences === 1, text)
      ok('两个候选项都标记已写入', result.written === 2 && P.listPendingNotes(dir).length === 0, JSON.stringify(result))
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }

  console.log(`\n结果：${pass} 通过，${fail} 失败\n`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
