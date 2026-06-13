'use strict'
/* WeekLog 渲染层逻辑：通过 window.weeklog（preload 桥）调用主进程能力。 */
;(function () {
  const $ = (id) => document.getElementById(id)
  const val = (id) => {
    const e = $(id)
    if (!e) return undefined
    return e.type === 'checkbox' ? e.checked : e.value
  }
  const setVal = (id, v) => {
    const e = $(id)
    if (!e) return
    if (e.type === 'checkbox') e.checked = !!v
    else e.value = v == null ? '' : v
  }
  const W = window.weeklog

  let cfg = null
  let genMode = 'weekly'

  // ── 日期工具（渲染层自实现，避免时区坑）──
  function pad(n) { return String(n).padStart(2, '0') }
  function isoDate(d) { const x = new Date(d); return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}` }
  function fmtDateNoZero(d) { const x = new Date(d); return `${x.getFullYear()}/${x.getMonth() + 1}/${x.getDate()}` }
  function todayISO() { return isoDate(new Date()) }

  function projectNames() { return (cfg && cfg.repos ? cfg.repos : []).map((r) => r.name).filter(Boolean) }

  function fillProjects() {
    ;['#dashNoteProject', '#noteProject'].forEach((sel) => {
      const el = $(sel)
      if (!el) return
      const cur = el.value
      el.innerHTML = '<option value="">日常工作（通用）</option>'
      ;(cfg && cfg.repos ? cfg.repos : []).forEach((r) => {
        if (!r.name) return
        const o = document.createElement('option')
        o.value = r.name
        o.textContent = r.alias || r.name
        el.appendChild(o)
      })
      if ([...el.options].some((o) => o.value === cur)) el.value = cur
    })
  }

  function toast(elId, text, ms = 2500) {
    const el = $(elId)
    if (!el) return
    el.textContent = text
    el.style.display = 'block'
    setTimeout(() => { el.style.display = 'none' }, ms)
  }

  // ── 页面切换 ──
  function switchPage(id) {
    document.querySelectorAll('.page').forEach((p) => p.classList.remove('active'))
    document.querySelectorAll('.nav-item[data-page]').forEach((n) => n.classList.remove('active'))
    const pg = $('page-' + id)
    const nv = document.querySelector(`.nav-item[data-page="${id}"]`)
    if (pg) pg.classList.add('active')
    if (nv) nv.classList.add('active')
  }

  // ── 状态栏 ──
  async function refreshStatus() {
    const gitOk = await W.env.gitOk()
    const keyOk = await W.env.apiKeyStatus()
    const dot = $('statusDot')
    dot.className = 'status-dot ' + (gitOk ? 'ok' : 'err')
    $('statusText').textContent = gitOk ? `${cfg.repos.length} 个仓库 · git 就绪` : 'git 不可用（请安装 git）'
    const prov = cfg.ai.provider
    $('statusRight').textContent = `${prov} · ${cfg.ai[prov].model} · ${keyOk ? 'Key 已配置' : 'Key 未配置'}`
    const badge = $('apiKeyBadge')
    badge.className = 'badge ' + (keyOk ? 'badge-success' : 'badge-warn')
    badge.textContent = keyOk ? 'Key 已配置' : 'Key 未配置'
    const ready = $('readyBadge')
    ready.className = 'badge ' + (gitOk && keyOk ? 'badge-success' : 'badge-warn')
    ready.textContent = gitOk && keyOk ? '就绪' : '未就绪'
    const sn = $('statusNotes')
    if (cfg.notes.enabled) { sn.style.display = 'inline-flex'; sn.textContent = `笔记已开启` } else { sn.style.display = 'none' }
  }

  // ── 仪表盘统计 ──
  async function loadDashStats() {
    try {
      const res = await W.collect({ rangeOpts: {}, options: {} })
      const s = res.stats
      setVal('statCommits', s.commitCount)
      setVal('statNotes', s.noteCount)
      setVal('statBuckets', s.bucketCount)
      setVal('statTokens', '~' + (s.estTokens || 0).toLocaleString())
      $('statCommitsDelta').textContent = `${s.days} 个工作日`
      $('statNotesDelta').textContent = `${s.noteProjectCount} 项目级 + ${s.noteMiscCount} 通用`
      $('statBucketsDelta').textContent = s.notesOnlyCount ? `含 ${s.notesOnlyCount} 个纯笔记段` : '全部含 commit'
      $('navNotesBadge').textContent = s.noteCount
    } catch (e) {
      $('statCommitsDelta').textContent = '采集失败：' + e.message
    }
  }

  async function addDashNote() {
    const content = val('dashNoteInput').trim()
    if (!content) return $('dashNoteInput').focus()
    const project = val('dashNoteProject')
    const r = await W.notes.add({ date: todayISO(), project, content })
    toast('dashNoteToast', `✓ 已写入 ${r.file} · ${project ? '## ' + project : '## 日常工作'}`)
    setVal('dashNoteInput', '')
    loadDashStats()
  }

  // ── 生成：周报范围构造 ──
  function buildWeeklyRange() {
    const chip = document.querySelector('#rangeChips .filter-chip.active')
    const range = chip ? chip.dataset.range : 'thisweek'
    if (range === 'lastweek') return { week: 'last' }
    if (range === 'custom') return { from: val('genFrom'), to: val('genTo') }
    return {} // 本周
  }

  function setGenMode(mode) {
    genMode = mode
    $('modeWeekly').classList.toggle('active', mode === 'weekly')
    $('modeDaily').classList.toggle('active', mode === 'daily')
    $('weeklyRangePanel').style.display = mode === 'weekly' ? 'block' : 'none'
    $('dailyOptions').style.display = mode === 'daily' ? 'block' : 'none'
  }

  async function refreshFusion() {
    const rangeOpts = genMode === 'daily' ? { mode: 'daily', date: val('dailyDate') } : buildWeeklyRange()
    try {
      const res = await W.collect({ rangeOpts, options: { author: val('genAuthor').trim(), merge: val('genMerge'), weekStart: cfg.weekStart } })
      const s = res.stats
      setVal('fusionCommits', s.commitCount)
      setVal('fusionNotes', s.noteCount)
      $('fusionCommitsDesc').textContent = `来自 ${cfg.repos.length} 个仓库，按（日期×项目）分桶`
      $('fusionNotesDesc').textContent = `${s.noteProjectCount} 项目级 + ${s.noteMiscCount} 通用（注入全部桶 + 日常工作段）`
    } catch (e) {
      $('fusionCommitsDesc').textContent = '采集失败：' + e.message
    }
  }

  function setGenBtn(btnId, busy, busyText) {
    const btn = $(btnId)
    if (!btn) return
    btn.disabled = busy
    if (busy) {
      btn.dataset.html = btn.innerHTML
      btn.innerHTML = `<svg class="spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18"><circle cx="12" cy="12" r="10" stroke-dasharray="42" stroke-dashoffset="14"/></svg> ${busyText || '处理中…'}`
    } else {
      btn.innerHTML = btn.dataset.html || btn.innerHTML
    }
  }

  async function doGenerate(rangeOpts, options, statusId, previewId, btnId) {
    setGenBtn(btnId, true, '生成中…')
    const status = $(statusId)
    status.textContent = '采集 commit + 加载笔记…'
    const off = W.onProgress((m) => { status.textContent = `AI 融合生成中… ${m.done}/${m.total}（${m.project}）` })
    try {
      const report = await W.generate({ rangeOpts, options })
      off()
      if (report.error) {
        status.innerHTML = `<span style="color:var(--danger)">✗ ${report.error}</span>`
        return
      }
      $(previewId).textContent = report.text || '（无内容）'
      const m = report.meta || {}
      status.innerHTML = `<span style="color:var(--success)">✓ 完成</span> · ${m.commitCount || 0} commits + ${m.noteCount || 0} 笔记 → ${m.bucketCount || 0} 段 · ${((m.durationMs || 0) / 1000).toFixed(1)}s${report.failedUnits.length ? ' · ' + report.failedUnits.length + ' 次降级' : ''}`
      await W.history.save({
        type: rangeOpts.mode === 'daily' ? '日报' : '周报',
        rangeStart: report.rangeStart ? isoDate(new Date(report.rangeStart)) : '',
        rangeEnd: report.rangeEnd ? isoDate(new Date(report.rangeEnd)) : '',
        text: report.text,
        meta: m,
      })
      loadHistory()
    } catch (e) {
      off()
      status.innerHTML = `<span style="color:var(--danger)">✗ ${e.message}</span>`
    } finally {
      setGenBtn(btnId, false)
    }
  }

  function generateFlow() {
    const rangeOpts = genMode === 'daily' ? { mode: 'daily', date: val('dailyDate') } : buildWeeklyRange()
    const options = {
      noNotes: !val('notesToggle'),
      format: val('genFormat'),
      author: val('genAuthor').trim(),
      merge: val('genMerge'),
      weekStart: cfg.weekStart,
    }
    doGenerate(rangeOpts, options, 'genStatus', 'reportPreview', 'generateBtn')
  }

  function dailyGenerate() {
    const rangeOpts = { mode: 'daily', date: val('dailyPageDate') }
    const options = { format: val('dailyFormat'), weekStart: cfg.weekStart }
    doGenerate(rangeOpts, options, 'dailyStatus', 'dailyPreview', 'dailyGenBtn')
  }

  async function copyReport() {
    const t = $('reportPreview').textContent
    try { await navigator.clipboard.writeText(t) } catch {}
    const b = $('copyBtn')
    const o = b.innerHTML
    b.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><polyline points="20 6 9 17 4 12"/></svg> 已复制'
    setTimeout(() => { b.innerHTML = o }, 1500)
  }

  // ── Dry-Run ──
  async function showDryRun() {
    const rangeOpts = genMode === 'daily' ? { mode: 'daily', date: val('dailyDate') } : buildWeeklyRange()
    $('dryDetail').textContent = '采集中…'
    setVal('dryBuckets', '—'); setVal('dryTokens', '—')
    $('dryRunModal').classList.add('show')
    try {
      const res = await W.collect({ rangeOpts, options: { author: val('genAuthor').trim(), merge: val('genMerge'), weekStart: cfg.weekStart } })
      const s = res.stats
      setVal('dryBuckets', s.bucketCount)
      setVal('dryTokens', '~' + (s.estTokens || 0).toLocaleString())
      $('dryBucketsDelta').textContent = `${s.days} 天 · ${s.notesOnlyCount} 纯笔记段`
      $('dryTokensDelta').textContent = `${s.commitCount} commits + ${s.noteCount} 笔记`
      const errs = s.repoErrors.length ? `\n⚠ 采集失败仓库：${s.repoErrors.map((e) => e.repo).join('、')}` : ''
      $('dryDetail').textContent = `时间范围：${res.range.from} ~ ${res.range.to}\n仓库：${cfg.repos.length} 个\n采集 commit：${s.commitCount} 条\n加载笔记：${s.noteCount} 条（${s.noteProjectCount} 项目级 + ${s.noteMiscCount} 通用）\n预计 AI 调用：${s.bucketCount} 次（并发 ${cfg.ai.concurrency}）${errs}`
    } catch (e) {
      $('dryDetail').textContent = '采集失败：' + e.message
    }
  }

  // ── 笔记 ──
  async function loadNotesTimeline() {
    const from = val('noteFrom') || isoDate(new Date(Date.now() - 13 * 86400000))
    const to = val('noteTo') || todayISO()
    const notesList = await W.notes.list({ from, to })
    renderNotesTimeline(notesList)
    $('navNotesBadge').textContent = notesList.length
  }

  function renderNotesTimeline(notesList) {
    const filter = document.querySelector('.filter-chip[data-notefilter].active')
    const type = filter ? filter.dataset.notefilter : 'all'
    const filtered = notesList.filter((n) => type === 'all' || (type === 'project' ? n.project : !n.project))
    const wrap = $('notesTimeline')
    if (!filtered.length) { wrap.className = 'empty'; wrap.textContent = '该范围内暂无笔记'; return }
    wrap.className = ''
    const byDay = new Map()
    filtered.forEach((n) => { if (!byDay.has(n.date)) byDay.set(n.date, []); byDay.get(n.date).push(n) })
    wrap.innerHTML = ''
    ;[...byDay.keys()].sort().reverse().forEach((date) => {
      const day = document.createElement('div')
      day.className = 'note-day'
      const header = document.createElement('div')
      header.className = 'note-day-header'
      const isToday = date === todayISO()
      header.innerHTML = `<span class="note-day-date">${fmtDateNoZero(date)}${isToday ? ' · 今天' : ''}</span><span class="note-day-count">${byDay.get(date).length} 条</span>`
      day.appendChild(header)
      byDay.get(date).forEach((n) => day.appendChild(noteCard(n)))
      wrap.appendChild(day)
    })
  }

  function noteCard(n) {
    const card = document.createElement('div')
    card.className = 'note-card ' + (n.project ? 'project' : '')
    const misc = cfg.notes.miscProject || '日常工作'
    card.innerHTML =
      '<div class="note-card-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg></div>' +
      '<div class="note-card-body"><div class="note-card-meta"></div><div class="note-card-content"></div></div>'
    const meta = card.querySelector('.note-card-meta')
    const tag = document.createElement('span')
    tag.className = 'tag' + (n.project ? '' : ' tag-notes')
    tag.textContent = n.project || misc
    meta.appendChild(tag)
    card.querySelector('.note-card-content').textContent = n.content
    return card
  }

  async function addNote() {
    const content = val('noteInput').trim()
    if (!content) return $('noteInput').focus()
    const project = val('noteProject')
    const date = val('noteDate') || todayISO()
    const r = await W.notes.add({ date, project, content })
    setVal('noteInput', '')
    await loadNotesTimeline()
    await refreshNoteRaw(date)
  }

  async function openNoteEditor(date) {
    setVal('editorDate', date || todayISO())
    await loadEditorText()
    $('noteEditorModal').classList.add('show')
  }

  async function loadEditorText() {
    const date = val('editorDate')
    const text = await W.notes.getText(date)
    setVal('editorText', text || `## ${cfg.notes.miscProject || '日常工作'}\n`)
    $('editorFile').textContent = `notes/${date}.md`
  }

  async function saveNoteEditor() {
    const date = val('editorDate')
    await W.notes.saveText({ date, text: val('editorText') })
    $('noteEditorModal').classList.remove('show')
    await loadNotesTimeline()
    await refreshNoteRaw(date)
  }

  async function refreshNoteRaw(date) {
    const d = date || val('noteDate') || todayISO()
    const text = await W.notes.getText(d)
    $('noteFileBadge').textContent = `notes/${d}.md`
    $('noteRawPreview').textContent = text || '（当天无笔记）'
  }

  // ── 仓库 ──
  function renderRepoList() {
    const list = $('repoList')
    list.innerHTML = ''
    $('repoCount').textContent = `${cfg.repos.length} 个已注册仓库`
    $('navRepoBadge').textContent = cfg.repos.length
    if (!cfg.repos.length) {
      const empty = document.createElement('div')
      empty.className = 'empty'
      empty.textContent = '暂无仓库，点击「添加仓库」注册本地 Git 仓库'
      list.appendChild(empty)
      return
    }
    cfg.repos.forEach((r) => {
      const item = document.createElement('div')
      item.className = 'repo-item'
      item.innerHTML =
        '<div class="repo-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.4 5.4 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65S8.93 17.38 9 18v4"/></svg></div>' +
        '<div class="repo-info"><div class="repo-name"></div><div class="repo-path"></div></div>' +
        '<div class="repo-meta" style="flex-direction:column;align-items:flex-end;gap:6px">' +
          '<div style="display:flex;align-items:center;gap:6px"><span class="tag"></span><span class="badge badge-success">在线</span><button class="btn btn-ghost btn-sm">移除</button></div>' +
          '<div style="display:flex;align-items:center;gap:4px"><span style="font-size:11px;color:var(--muted);white-space:nowrap">别名</span><input class="input alias-input" style="width:150px;padding:4px 8px;font-size:12px" placeholder="日报显示名（留空用项目名）" /></div>' +
        '</div>'
      item.querySelector('.repo-name').textContent = r.name
      item.querySelector('.repo-path').textContent = r.path
      item.querySelector('.tag').textContent = r.branch || 'main'
      const aliasInput = item.querySelector('.alias-input')
      aliasInput.value = r.alias || ''
      aliasInput.addEventListener('change', async () => { await W.repo.update(r.id, { alias: aliasInput.value.trim() }); cfg = await W.config.get(); fillProjects() })
      item.querySelector('.btn').addEventListener('click', async () => { await W.repo.remove(r.id); cfg = await W.config.get(); renderRepoList(); fillProjects() })
      list.appendChild(item)
    })
  }

  async function repoBrowse() {
    const p = await W.dialog.pickRepo()
    if (p) {
      setVal('repoPathInput', p)
      const v = await W.repo.validate(p)
      const hint = $('repoValidateHint')
      if (v.ok) { hint.innerHTML = `<span style="color:var(--success)">✓ 有效 Git 仓库 · 当前分支 ${v.branch || '—'}</span>`; if (!val('repoNameInput')) setVal('repoNameInput', p.replace(/[/\\]+$/, '').split(/[/\\]/).pop()); if (val('repoBranchInput') === 'main') setVal('repoBranchInput', v.branch || 'main') }
      else hint.innerHTML = `<span style="color:var(--danger)">✗ 不是有效的 Git 仓库</span>`
    }
  }

  async function confirmAddRepo() {
    const path = val('repoPathInput').trim()
    if (!path) return $('repoPathInput').focus()
    const r = await W.repo.add({ path, name: val('repoNameInput'), branch: val('repoBranchInput'), alias: val('repoAliasInput') })
    if (r.error) { $('repoValidateHint').innerHTML = `<span style="color:var(--danger)">✗ ${r.error}</span>`; return }
    $('addRepoModal').classList.remove('show')
    setVal('repoPathInput', ''); setVal('repoNameInput', ''); setVal('repoAliasInput', ''); setVal('repoBranchInput', 'main')
    cfg = await W.config.get()
    renderRepoList(); fillProjects()
  }

  // ── 历史 ──
  async function loadHistory() {
    const list = await W.history.list()
    const body = $('historyBody')
    body.innerHTML = ''
    if (!list.length) { body.innerHTML = '<tr><td colspan="8" style="text-align:center;color:var(--muted)">暂无历史记录</td></tr>'; return }
    list.forEach((h) => {
      const tr = document.createElement('tr')
      const time = new Date(h.createdAt)
      const m = h.meta || {}
      tr.innerHTML =
        `<td class="mono">${time.getMonth() + 1}/${time.getDate()} ${pad(time.getHours())}:${pad(time.getMinutes())}</td>` +
        `<td><span class="badge ${h.type === '日报' ? 'badge-notes' : 'badge-accent'}">${h.type}</span></td>` +
        `<td class="mono">${h.rangeStart || '—'}${h.rangeEnd ? '~' + h.rangeEnd.slice(5) : ''}</td>` +
        `<td class="mono">${m.bucketCount || '—'}</td>` +
        `<td class="mono">${m.noteCount || 0}</td>` +
        `<td class="mono">${m.commitCount || 0}</td>` +
        `<td><span class="badge ${((h.text || '').includes('降级') || (m.failedUnits && m.failedUnits.length)) ? 'badge-warn">含降级' : 'badge-success">完成'}</span></td>` +
        '<td><button class="btn btn-ghost btn-sm">查看</button></td>'
      tr.querySelector('button').addEventListener('click', () => {
        navigator.clipboard && navigator.clipboard.writeText(h.text || '')
        alert(h.text || '（无内容）')
      })
      body.appendChild(tr)
    })
  }

  // ── 设置 ──
  function selectProvider(p) {
    cfg.ai.provider = p
    document.querySelectorAll('.provider-card').forEach((c) => c.classList.toggle('selected', c.dataset.provider === p))
    const sub = cfg.ai[p]
    setVal('setModel', sub.model)
    setVal('setBaseUrl', sub.baseUrl || '')
    loadApiKey(p)
  }

  async function loadApiKey(provider) {
    const r = await W.secrets.get(provider)
    setVal('setApiKey', r.key || '')
    const envName = provider === 'openai' ? 'OPENAI_API_KEY（或 WEEKLOG_OPENAI_KEY）' : 'ANTHROPIC_API_KEY（或 WEEKLOG_ANTHROPIC_KEY）'
    const envEl = $('keyEnvHint')
    if (envEl) envEl.textContent = envName
    const hint = $('keyHint')
    const availTxt = r.available ? '' : '（当前环境不支持系统加密，将以明文存储）'
    if (hint) hint.textContent = (r.key ? '✓ 已填写（加密存储）' : '未填写，将使用环境变量') + availTxt
  }

  function loadSettingsForm() {
    setVal('setNotesEnabled', cfg.notes.enabled)
    setVal('setMiscProject', cfg.notes.miscProject)
    setVal('setFormat', cfg.output.format)
    setVal('setNewline', cfg.output.newline)
    setVal('setWithCommits', cfg.output.withCommits)
    setVal('setMaxIn', cfg.ai.maxInputTokens)
    setVal('setConcurrency', cfg.ai.concurrency)
    setVal('setRetries', cfg.ai.retries)
    setVal('setTimeout', cfg.ai.timeoutSeconds)
    setVal('genWeekStart', cfg.weekStart)
    selectProvider(cfg.ai.provider)
    const sub = cfg.ai[cfg.ai.provider]
    setVal('setTemp', Math.round((sub.temperature ?? 0.3) * 100))
    setVal('tempVal', (sub.temperature ?? 0.3).toFixed(1))
    setVal('setMaxOut', sub.maxTokens)
    W.config.notesDir().then((d) => { $('curNotesDir').textContent = d })
  }

  async function saveSettings() {
    const provider = cfg.ai.provider
    const temp = Number(val('setTemp')) / 100
    cfg.notes.enabled = val('setNotesEnabled')
    cfg.notes.miscProject = val('setMiscProject') || '日常工作'
    cfg.notes.dir = val('setNotesDir') || undefined
    cfg.output.format = val('setFormat')
    cfg.output.newline = val('setNewline')
    cfg.output.withCommits = val('setWithCommits')
    cfg.ai.maxInputTokens = Number(val('setMaxIn')) || 6000
    cfg.ai.concurrency = Number(val('setConcurrency')) || 3
    cfg.ai.retries = Number(val('setRetries')) || 3
    cfg.ai.timeoutSeconds = Number(val('setTimeout')) || 60
    cfg.ai[provider].model = val('setModel')
    cfg.ai[provider].baseUrl = val('setBaseUrl')
    cfg.ai[provider].temperature = temp
    cfg.ai[provider].maxTokens = Number(val('setMaxOut')) || 800
    cfg.weekStart = val('genWeekStart')
    // API Key：软件内填写，加密存储（与当前存储不同才写入）
    const keyInput = val('setApiKey') || ''
    const curKey = (await W.secrets.get(provider)).key || ''
    if (keyInput !== curKey) await W.secrets.set(provider, keyInput)
    cfg = await W.config.save(cfg)
    await refreshStatus()
    fillProjects()
    toast('settingsToast', '✓ 设置已保存', 2000)
  }

  // ── 事件绑定 ──
  function bindEvents() {
    document.querySelectorAll('.nav-item[data-page]').forEach((b) => b.addEventListener('click', () => switchPage(b.dataset.page)))

    $('dashNoteBtn').addEventListener('click', addDashNote)
    $('dashNoteInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') addDashNote() })
    $('goGen').addEventListener('click', () => switchPage('generate'))
    $('goDaily').addEventListener('click', () => switchPage('daily'))
    $('goDryRun').addEventListener('click', () => { switchPage('generate'); showDryRun() })

    $('modeWeekly').addEventListener('click', () => setGenMode('weekly'))
    $('modeDaily').addEventListener('click', () => setGenMode('daily'))
    document.querySelectorAll('#rangeChips .filter-chip').forEach((c) => c.addEventListener('click', () => {
      document.querySelectorAll('#rangeChips .filter-chip').forEach((x) => x.classList.remove('active'))
      c.classList.add('active')
    }))
    $('refreshFusion').addEventListener('click', refreshFusion)
    $('generateBtn').addEventListener('click', generateFlow)
    $('dryRunBtn').addEventListener('click', showDryRun)
    $('copyBtn').addEventListener('click', copyReport)
    $('exportBtn').addEventListener('click', copyReport)

    $('dailyGenBtn').addEventListener('click', dailyGenerate)
    $('dailyGoNote').addEventListener('click', () => switchPage('notes'))

    $('noteAddBtn').addEventListener('click', addNote)
    $('noteInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') addNote() })
    $('noteEditorBtn').addEventListener('click', () => openNoteEditor(todayISO()))
    $('noteRefresh').addEventListener('click', loadNotesTimeline)
    document.querySelectorAll('.filter-chip[data-notefilter]').forEach((c) => c.addEventListener('click', () => {
      document.querySelectorAll('.filter-chip[data-notefilter]').forEach((x) => x.classList.remove('active'))
      c.classList.add('active')
      loadNotesTimeline()
    }))
    $('noteDate').addEventListener('change', () => refreshNoteRaw())
    $('editorDate').addEventListener('change', loadEditorText)
    $('saveNoteEditor').addEventListener('click', saveNoteEditor)
    $('cancelNoteEditor').addEventListener('click', () => $('noteEditorModal').classList.remove('show'))
    $('closeNoteEditor').addEventListener('click', () => $('noteEditorModal').classList.remove('show'))

    $('addRepoBtn').addEventListener('click', () => { $('repoValidateHint').textContent = '本地 Git 仓库绝对路径'; setVal('repoPathInput', ''); setVal('repoNameInput', ''); setVal('repoAliasInput', ''); setVal('repoBranchInput', 'main'); $('addRepoModal').classList.add('show') })
    $('repoBrowse').addEventListener('click', repoBrowse)
    $('confirmAddRepo').addEventListener('click', confirmAddRepo)
    $('cancelAddRepo').addEventListener('click', () => $('addRepoModal').classList.remove('show'))
    $('closeAddRepo').addEventListener('click', () => $('addRepoModal').classList.remove('show'))

    $('closeDryRun').addEventListener('click', () => $('dryRunModal').classList.remove('show'))
    $('closeDryRun2').addEventListener('click', () => $('dryRunModal').classList.remove('show'))
    $('dryConfirm').addEventListener('click', () => { $('dryRunModal').classList.remove('show'); generateFlow() })

    document.querySelectorAll('.provider-card').forEach((c) => c.addEventListener('click', () => selectProvider(c.dataset.provider)))
    $('toggleKeyVisibility').addEventListener('click', () => {
      const i = $('setApiKey')
      const b = $('toggleKeyVisibility')
      if (i.type === 'password') { i.type = 'text'; b.textContent = '隐藏' } else { i.type = 'password'; b.textContent = '显示' }
    })
    $('clearApiKeyBtn').addEventListener('click', async () => {
      const p = cfg.ai.provider
      await W.secrets.clear(p)
      await loadApiKey(p)
      await refreshStatus()
      toast('settingsToast', '✓ API Key 已清除', 2000)
    })
    $('pickNotesDir').addEventListener('click', async () => { const p = await W.dialog.pickFolder(); if (p) setVal('setNotesDir', p) })
    $('setTemp').addEventListener('input', (e) => { $('tempVal').textContent = (Number(e.target.value) / 100).toFixed(1) })
    $('saveSettingsBtn').addEventListener('click', saveSettings)

    document.querySelectorAll('.modal-overlay').forEach((o) => o.addEventListener('click', (e) => { if (e.target === o) o.classList.remove('show') }))
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') document.querySelectorAll('.modal-overlay.show').forEach((m) => m.classList.remove('show')) })
  }

  // ── 初始化 ──
  async function init() {
    cfg = await W.config.get()
    fillProjects()
    loadSettingsForm()
    setVal('noteDate', todayISO())
    setVal('editorDate', todayISO())
    setVal('genTo', todayISO())
    setVal('noteTo', todayISO())
    setVal('noteFrom', isoDate(new Date(Date.now() - 13 * 86400000)))
    bindEvents()
    await refreshStatus()
    await loadDashStats()
    renderRepoList()
    loadHistory()
    loadNotesTimeline()
    refreshNoteRaw(todayISO())
    switchPage('dashboard')
  }

  init().catch((e) => { document.body.insertAdjacentHTML('afterbegin', `<div style="padding:16px;background:#fee;color:#b00">初始化失败：${e.message}</div>`) })
})()
