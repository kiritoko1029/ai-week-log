'use strict'
// @ts-check
/**
 * 聚合：把 commit 与笔记按 (日期, 项目) 分桶，并执行笔记融合分配。
 *  - 项目级笔记 → 对应项目桶
 *  - 通用笔记（project=null）→ 注入当天所有桶的 sharedNotes + 兜底【miscProject】独立段
 */
const { parseDateInput } = require('./utils')

/**
 * @param {object[]} commits
 * @param {object[]} notes
 * @param {string} miscProject
 * @param {string[]} repoOrder - 仓库配置中的项目名顺序（用于排序），miscProject 恒排末尾
 * @returns {object[]} buckets[] —— 已按日期升序、项目顺序排序
 */
function aggregate(commits, notes, miscProject = '日常工作', repos = []) {
  const orderIndex = new Map()
  const aliasToName = new Map()
  const nameToDisplay = new Map()
  repos.forEach((r, i) => {
    if (r.name) {
      orderIndex.set(r.name, i)
      nameToDisplay.set(r.name, r.alias || r.name)
    }
    if (r.alias) aliasToName.set(r.alias, r.name)
  })
  const displayOf = (proj) => nameToDisplay.get(proj) || proj
  const normalizeProject = (p) => aliasToName.get(p) || p

  const dayMap = new Map() // dayStr -> Map(project -> bucket)

  const ensureBucket = (dayStr, project) => {
    if (!dayMap.has(dayStr)) dayMap.set(dayStr, new Map())
    const pm = dayMap.get(dayStr)
    if (!pm.has(project)) {
      pm.set(project, {
        day: parseDateInput(dayStr),
        dayStr,
        project,
        displayName: displayOf(project),
        commits: [],
        notes: [],
        sharedNotes: [],
        isNotesOnly: true,
      })
    }
    return pm.get(project)
  }

  // 1) commit 入桶
  for (const c of commits) {
    const proj = c.project || miscProject
    const b = ensureBucket(c.localDate, proj)
    b.commits.push(c)
    b.isNotesOnly = false
  }

  // 2) 笔记入桶 + 通用笔记融合
  for (const n of notes) {
    if (n.project) {
      // 项目级笔记：归对应项目桶（支持别名映射）；即便该桶无 commit，也形成 notes 桶
      const b = ensureBucket(n.date, normalizeProject(n.project))
      b.notes.push(n)
    } else {
      // 通用笔记：注入当天所有已存在桶的 sharedNotes
      const pm = dayMap.get(n.date)
      if (pm && pm.size) {
        for (const b of pm.values()) b.sharedNotes.push(n)
      }
      // 同时作为【miscProject】独立段落兜底（覆盖纯非代码工作）
      const mb = ensureBucket(n.date, miscProject)
      mb.notes.push(n)
    }
  }

  // 3) 展平 + 排序（日期升序；同日内 miscProject 排末尾，其余按 repoOrder）
  const cmpProject = (a, b) => {
    if (a === miscProject && b !== miscProject) return 1
    if (b === miscProject && a !== miscProject) return -1
    const ia = orderIndex.has(a) ? orderIndex.get(a) : 9999
    const ib = orderIndex.has(b) ? orderIndex.get(b) : 9999
    if (ia !== ib) return ia - ib
    return a.localeCompare(b)
  }

  const buckets = []
  for (const dayStr of [...dayMap.keys()].sort()) {
    const pm = dayMap.get(dayStr)
    for (const project of [...pm.keys()].sort(cmpProject)) {
      buckets.push(pm.get(project))
    }
  }
  return buckets
}

module.exports = { aggregate }
