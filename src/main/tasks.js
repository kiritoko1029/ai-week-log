'use strict'
// @ts-check
/**
 * 后台任务系统：
 * - 在主进程维护任务注册表（跨页面持久，不随渲染进程状态丢失）
 * - 任务有生命周期：running → done | error | cancelled
 * - 通过 IPC 向渲染进程推送 'task:update' 事件（增量）
 * - 渲染进程任何时候都能 list / subscribe 拿到全部任务
 *
 * 任务类型：
 *  - generate   AI 报告生成
 *  - memory     AI 记忆生成/重建
 *  - model_dl   模型下载（embedding）
 *  - webdav     WebDAV 同步
 *  - custom     其它
 */

let _tasks = new Map() // id → task object
let _sender = null      // 推送函数：({type, task}) => void
let _seq = 0

function newId() {
  _seq++
  return `task_${Date.now().toString(36)}_${_seq}`
}

/** 注入推送函数（由 ipc.js 注册时注入，转发到渲染进程） */
function setSender(fn) {
  _sender = fn
}

function emit(task) {
  if (_sender) {
    try { _sender({ type: 'update', task: snapshot(task) }) } catch {}
  }
}

/** 生成对外快照（去掉内部字段） */
function snapshot(task) {
  return {
    id: task.id,
    kind: task.kind,
    title: task.title,
    status: task.status, // running | done | error | cancelled
    progress: task.progress, // { done, total, label }
    detail: task.detail,
    error: task.error,
    result: task.result,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  }
}

/**
 * 创建一个任务，返回 { id, update, done, error }
 * 调用方在异步流程中用 update/done/error 推进状态。
 */
function create(kind, title, opts = {}) {
  const id = newId()
  const task = {
    id,
    kind, // generate | memory | model_dl | webdav | custom
    title,
    status: 'running',
    progress: opts.progress || null, // { done, total, label }
    detail: opts.detail || '',
    error: null,
    result: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  _tasks.set(id, task)
  // 限制最近 50 条，避免无限增长
  if (_tasks.size > 50) {
    const oldest = _tasks.keys().next().value
    _tasks.delete(oldest)
  }
  emit(task)
  return id
}

/** 更新任务进度 */
function update(id, patch) {
  const task = _tasks.get(id)
  if (!task) return
  if (patch.progress !== undefined) task.progress = patch.progress
  if (patch.detail !== undefined) task.detail = patch.detail
  if (patch.title !== undefined) task.title = patch.title
  task.updatedAt = Date.now()
  emit(task)
}

/** 标记任务完成 */
function done(id, result) {
  const task = _tasks.get(id)
  if (!task) return
  task.status = 'done'
  task.result = result || null
  task.updatedAt = Date.now()
  emit(task)
}

/** 标记任务失败 */
function error(id, errorMsg) {
  const task = _tasks.get(id)
  if (!task) return
  task.status = 'error'
  task.error = errorMsg || '未知错误'
  task.updatedAt = Date.now()
  emit(task)
}

/** 取消（标记为 cancelled，不强制中断） */
function cancel(id) {
  const task = _tasks.get(id)
  if (!task) return
  task.status = 'cancelled'
  task.updatedAt = Date.now()
  emit(task)
}

/** 删除一条任务记录 */
function remove(id) {
  _tasks.delete(id)
  if (_sender) { try { _sender({ type: 'remove', id }) } catch {} }
}

/** 清除已完成/失败的任务 */
function clearFinished() {
  const toRemove = []
  for (const [id, task] of _tasks) {
    if (task.status !== 'running') toRemove.push(id)
  }
  toRemove.forEach((id) => _tasks.delete(id))
  if (_sender) { try { _sender({ type: 'clear' }) } catch {} }
}

/** 获取所有任务快照（按创建时间倒序） */
function list() {
  return [..._tasks.values()]
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(snapshot)
}

/** 当前是否有运行中的任务 */
function hasRunning() {
  for (const task of _tasks.values()) {
    if (task.status === 'running') return true
  }
  return false
}

module.exports = {
  setSender,
  create,
  update,
  done,
  error,
  cancel,
  remove,
  clearFinished,
  list,
  hasRunning,
}
