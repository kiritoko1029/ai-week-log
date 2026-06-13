'use strict'
/* 防闪烁：在 React 之前同步设置 dark class（shadcn class-based 深色模式）。
 * 来源优先级：localStorage 缓存 > 系统偏好。后续 ThemeProvider 会用 config 校正。
 * 注意：此文件由 <script> 同步加载，不能用 import/export，必须为 IIFE。 */
;(function () {
  var THEME_KEY = 'weeklog:theme'
  function resolveDark(t) {
    if (t === 'dark') return true
    if (t === 'light') return false
    return window.matchMedia('(prefers-color-scheme: dark)').matches
  }
  try {
    var t = localStorage.getItem(THEME_KEY) || 'auto'
    if (resolveDark(t)) document.documentElement.classList.add('dark')
    else document.documentElement.classList.remove('dark')
  } catch (e) {
    document.documentElement.classList.remove('dark')
  }
})()
