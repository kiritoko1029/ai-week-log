'use strict'
// @ts-check
/**
 * Git 日志采集：用 child_process 直调 git log，按 PLAN 的 0x1e(记录)/0x1f(字段)
 * 分隔方案输出，编码可控、无第三方依赖。
 */
const { spawnSync } = require('child_process')
const { isoDate } = require('./utils')

const FIELD_SEP = '\x1f'
const REC_SEP = '\x1e'

/** 检测系统 git 是否可用 */
function checkGit() {
  try {
    const r = spawnSync('git', ['--version'], { encoding: 'utf8', windowsHide: true })
    return r.status === 0
  } catch {
    return false
  }
}

/** 是否为有效 Git 仓库 */
function isGitRepo(p) {
  try {
    const r = spawnSync('git', ['-C', p, 'rev-parse', '--is-inside-work-tree'], {
      encoding: 'utf8',
      windowsHide: true,
    })
    return r.status === 0 && String(r.stdout).trim() === 'true'
  } catch {
    return false
  }
}

/** 当前分支名 */
function currentBranch(p) {
  try {
    const r = spawnSync('git', ['-C', p, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf8',
      windowsHide: true,
    })
    return r.status === 0 ? String(r.stdout).trim() : ''
  } catch {
    return ''
  }
}

/**
 * 执行 git log，返回原始 stdout 字符串。
 * @param {string} repoPath
 * @param {object} opts - { since, until (YYYY-MM-DD), author, mergeMode:'exclude|include|only' }
 */
function runGitLog(repoPath, opts = {}) {
  const args = ['-C', repoPath, '-c', 'i18n.logOutputEncoding=UTF-8', 'log']
  if (opts.since) args.push(`--since=${opts.since} 00:00:00`)
  if (opts.until) args.push(`--until=${opts.until} 23:59:59`)
  if (opts.author) args.push(`--author=${opts.author}`)
  if (opts.mergeMode === 'exclude') args.push('--no-merges')
  else if (opts.mergeMode === 'only') args.push('--merges')
  args.push('--date=format-local:%Y-%m-%d %H:%M:%S')
  // 末尾 %n 让 header 独占一行，numstat 行紧随其后，干净切分
  args.push(`--pretty=format:${REC_SEP}%H${FIELD_SEP}%an${FIELD_SEP}%ae${FIELD_SEP}%ad${FIELD_SEP}%s${FIELD_SEP}%b${FIELD_SEP}%n`)
  args.push('--numstat')

  const r = spawnSync('git', args, {
    cwd: repoPath,
    encoding: 'utf8',
    maxBuffer: 80 * 1024 * 1024,
    windowsHide: true,
  })
  if (r.error) throw r.error
  if (r.status !== 0) {
    const stderr = String(r.stderr || '').trim()
    // 无提交 / 空仓库不算错误，返回空
    if (/does not have any commits|no commits yet|unknown revision/i.test(stderr)) return ''
    throw new Error(`git log 失败：${stderr || ('exit ' + r.status)}`)
  }
  return String(r.stdout || '')
}

/** 解析 numstat 中的 rename/花括号路径：a/{b => c}.js → a/c.js */
function normalizeNumstatPath(p) {
  if (p.includes('=>')) {
    // 形如 old => new 或 prefix/{old => new}suffix
    const m = /^(.*)([{]?)([^{}]*)\s*=>\s*([^{}]*)([}]?)(.*)$/.exec(p)
    if (m) {
      const prefix = m[1] || ''
      const newName = m[4] || ''
      return (prefix + newName).trim()
    }
  }
  return p
}

function parseLocalDateTime(ad) {
  // ad = "2026-06-09 10:22:00"（本地时区，由 --date=format-local 保证）
  return new Date(ad.replace(' ', 'T'))
}

/**
 * 解析 git log 原始输出为 Commit[]。
 * @param {string} raw
 * @param {string} repoPath
 * @param {string} projectName
 */
function parseGitLog(raw, repoPath, projectName) {
  const commits = []
  if (!raw) return commits
  const blocks = raw.split(REC_SEP)
  for (const block of blocks) {
    const trimmed = block.replace(/^\n+/, '')
    if (!trimmed.trim()) continue
    const nl = trimmed.indexOf('\n')
    const headLine = nl >= 0 ? trimmed.slice(0, nl) : trimmed
    const rest = nl >= 0 ? trimmed.slice(nl + 1) : ''
    const fields = headLine.split(FIELD_SEP)
    const padded = fields.concat(Array(6).fill(''))
    const [hash, an, ae, ad, subject, body] = padded.slice(0, 6)

    const files = []
    let insertions = 0
    let deletions = 0
    for (const line of rest.split('\n')) {
      if (!line.trim()) continue
      const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line)
      if (!m) continue
      const ins = m[1] === '-' ? 0 : Number(m[1])
      const del = m[2] === '-' ? 0 : Number(m[2])
      insertions += ins
      deletions += del
      files.push({
        status: ins === 0 && del > 0 ? 'D' : ins > 0 && del === 0 ? 'A' : 'M',
        path: normalizeNumstatPath(m[3]),
        insertions: ins,
        deletions: del,
      })
    }

    const dateObj = parseLocalDateTime(ad || '1970-01-01 00:00:00')
    commits.push({
      hash: hash || '',
      shortHash: (hash || '').slice(0, 7),
      authorName: an || '',
      authorEmail: ae || '',
      date: dateObj.toISOString(),
      localDate: isoDate(dateObj),
      subject: (subject || '').trim(),
      body: (body || '').trim(),
      files,
      insertions,
      deletions,
      filesChanged: files.length,
      repo: repoPath,
      project: projectName || '',
      isMerge: false, // 默认 --no-merges 已排除；include 时由调用方按需标记
    })
  }
  return commits
}

/**
 * 采集单个仓库在区间内的 commit。
 * @param {object} repo - { path, name, author, ... }
 * @param {{from:string, to:string}} range - YYYY-MM-DD
 * @param {object} filters - { mergeCommits, author }
 */
function collectRepo(repo, range, filters = {}) {
  const projectName = repo.name || require('path').basename(repo.path || '')
  const author = repo.author || (filters.author && filters.author.length ? filters.author.join('|') : '')
  const raw = runGitLog(repo.path, {
    since: range.from,
    until: range.to,
    author,
    mergeMode: filters.mergeCommits || 'exclude',
  })
  return parseGitLog(raw, repo.path, projectName)
}

// ── 扫描目录下的 Git 仓库 ──
const fs = require('fs')
const path = require('path')

/** 应跳过的目录名（不递归进入） */
const SCAN_SKIP_DIRS = new Set(['node_modules', '.git', '.svn', 'build', 'dist', 'target', '.next', '__pycache__'])

/**
 * 扫描 rootDir 下所有 Git 仓库，最大深度 maxDepth（rootDir 的直接子级算第 1 层）。
 * - 命中 .git 的目录即视为一个仓库，不再向其内部下钻（避免把 submodule 算成独立仓库）
 * - 跳过 node_modules、隐藏目录、常见构建产物目录
 * 返回 [{ path, name, branch }]，path 去重、按字典序排列
 *
 * 用 .git 存在性判断而非每层 spawn git（大目录树下快几个数量级）。
 */
function scanGitRepos(rootDir, maxDepth = 3) {
  const results = []
  const seen = new Set()
  // 队列项：{ dir, depth }，rootDir 自身算 depth 0，其直接子目录是 depth 1
  const queue = [{ dir: rootDir, depth: 0 }]

  while (queue.length) {
    const { dir, depth } = queue.shift()
    if (depth > maxDepth) continue
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue // 无权限或非目录
    }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue
      const name = ent.name
      // 跳过隐藏目录（. 开头）与黑名单
      if (name.startsWith('.') || SCAN_SKIP_DIRS.has(name)) continue
      const full = path.join(dir, name)
      // 软链可能成环，跳过
      if (ent.isSymbolicLink()) continue
      // 命中 .git → 这是一个仓库
      const gitDir = path.join(full, '.git')
      if (fs.existsSync(gitDir)) {
        if (!seen.has(full)) {
          seen.add(full)
          results.push({ path: full, name, branch: currentBranch(full) })
        }
        // 仓库内部不再下钻
        continue
      }
      // 非仓库目录：未达深度上限则继续探索
      if (depth + 1 <= maxDepth) {
        queue.push({ dir: full, depth: depth + 1 })
      }
    }
  }

  results.sort((a, b) => a.path.localeCompare(b.path))
  return results
}

module.exports = {
  FIELD_SEP,
  REC_SEP,
  checkGit,
  isGitRepo,
  currentBranch,
  runGitLog,
  parseGitLog,
  collectRepo,
  normalizeNumstatPath,
  scanGitRepos,
}
