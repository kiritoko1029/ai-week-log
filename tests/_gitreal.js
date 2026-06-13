'use strict'
/* 真实 git 采集验证：对一个真实的 git 仓库调用 collectRepo，确认 git log 解析在真实环境工作。 */
const G = require('../src/main/git')
const { isoDate } = require('../src/main/utils')

const repoPath = process.argv[2]
if (!repoPath) { console.log('用法: node _gitreal.js <git仓库路径>'); process.exit(2) }

const d = new Date()
const cs = G.collectRepo({ path: repoPath, name: '测试项目' }, { from: isoDate(d), to: isoDate(d) }, { mergeCommits: 'exclude' })

console.log('真实采集 commits:', cs.length)
cs.forEach((c) => console.log('  -', c.localDate, '|', c.project, '|', c.subject, '| by', c.authorName, '|', c.shortHash))

const pass = cs.length > 0 && cs.every((c) => c.project === '测试项目' && c.hash && c.subject)
console.log(pass ? 'RESULT: PASS' : 'RESULT: FAIL')
process.exit(pass ? 0 : 1)
