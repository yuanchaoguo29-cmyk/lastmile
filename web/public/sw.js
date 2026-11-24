/* LastMile Service Worker
   目标只有一个：让「添加到主屏幕」在 Android/Chrome 上成立（可安装 PWA 需要有 SW + fetch 处理）。
   策略保守：
     - /api/** 一律走网络，绝不缓存（回执、看板必须实时，缓存会出人命）
     - 页面导航：网络优先，断网才回退缓存的 index（这样发版后不会卡在旧页面）
     - /assets/**（带内容哈希）：缓存优先，命中直接用
   发版要强制刷新就改 CACHE 版本号。 */

const CACHE = 'lastmile-v1'
const SHELL = ['/', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png']

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(SHELL).catch(() => undefined))
      .then(() => self.skipWaiting())
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return

  let url
  try {
    url = new URL(req.url)
  } catch {
    return
  }
  if (url.origin !== self.location.origin) return
  if (url.pathname.startsWith('/api/')) return

  // 导航请求：网络优先
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone()
          caches.open(CACHE).then((c) => c.put('/', copy)).catch(() => {})
          return res
        })
        .catch(() => caches.match('/').then((hit) => hit || Response.error()))
    )
    return
  }

  // 带哈希的静态资源：缓存优先
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            const copy = res.clone()
            caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {})
            return res
          })
      )
    )
  }
})
