import React, { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/tokens.css'
import './styles/app.css'
import './styles/student.css'
import './styles/counselor.css'
import './styles/lock.css'
import './styles/roster-panel.css'
import './styles/target-picker.css'
import './styles/staff-panel.css'
import './styles/account-panel.css'
import './styles/mail-dialog.css'
import CounselorApp from './counselor/CounselorApp.jsx'
import StudentApp from './student/StudentApp.jsx'

const LAST_KEY = 'lm.lastNotice'

/* 从主屏幕图标打开（manifest 的 start_url 是 /?pwa=1）时，
   直接回到学生上次看的那份通知，而不是一个空白入口。 */
function bootRedirect() {
  try {
    const u = new URL(location.href)
    if (u.searchParams.get('pwa') !== '1') return
    const h = location.hash
    if (h && h !== '#/' && h !== '#') return
    const last = localStorage.getItem(LAST_KEY)
    if (last) {
      history.replaceState(null, '', `${u.pathname}#/s/${last}`)
      window.dispatchEvent(new HashChangeEvent('hashchange'))
    }
  } catch {
    /* 隐私模式下 localStorage 会抛，忽略 */
  }
}
bootRedirect()

function useRoute() {
  const [hash, setHash] = useState(() => location.hash || '#/c')
  useEffect(() => {
    const on = () => setHash(location.hash || '#/c')
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  return hash
}

function App() {
  const hash = useRoute()
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean)
  const isStudent = parts[0] === 's' && Boolean(parts[1])

  /* 记住学生最近看的那份通知，给「添加到主屏幕」用 */
  useEffect(() => {
    if (!isStudent) return
    try {
      localStorage.setItem(LAST_KEY, parts[1])
    } catch {}
  }, [isStudent, parts[1]])

  if (isStudent) {
    return <StudentApp id={parts[1]} sub={parts[2] || null} />
  }
  return <CounselorApp id={parts[1] || null} />
}

createRoot(document.getElementById('root')).render(<App />)

/* PWA：只在生产构建里注册，开发时（vite dev）不注册以免缓存干扰 */
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {})
  })
}
