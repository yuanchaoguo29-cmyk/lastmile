/* LastMile 单体服务入口 —— 冻结。
   运行：npm start  → 单进程同时提供 /api 与 public/ 静态前端，只占用 3000 一个端口。 */

import express from 'express'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { initDb } from './db.js'
import { createApiRouter } from './api.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const PUBLIC = path.join(ROOT, 'public')
const PORT = Number(process.env.PORT || 3000)

initDb()

const app = express()
app.disable('x-powered-by')
app.set('trust proxy', true)
app.use(express.json({ limit: '4mb' }))

// 轻量访问日志，方便演示时看谁在点
app.use((req, res, next) => {
  if (req.path.startsWith('/api')) {
    const t0 = Date.now()
    res.on('finish', () => {
      console.log(
        `${new Date().toISOString().slice(11, 19)} ${req.method} ${req.path} ${res.statusCode} ${Date.now() - t0}ms`
      )
    })
  }
  next()
})

app.use('/api', createApiRouter())

/* Android TWA（把 PWA 包成 APK）要在域名下放这个文件来证明「这个域名属于我这个 App」。
   没配 ANDROID_SHA256 就返回 404，不影响正常使用。 */
app.get('/.well-known/assetlinks.json', (req, res) => {
  const fingerprints = String(process.env.ANDROID_SHA256 || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (!fingerprints.length) {
    return res.status(404).json({ error: 'not configured' })
  }
  res.type('application/json').send(
    JSON.stringify(
      [
        {
          relation: ['delegate_permission/common.handle_all_urls'],
          target: {
            namespace: 'android_app',
            package_name: process.env.ANDROID_PACKAGE || 'cn.edu.swufe.lastmile',
            sha256_cert_fingerprints: fingerprints
          }
        }
      ],
      null,
      2
    )
  )
})

app.use(
  express.static(PUBLIC, {
    index: 'index.html',
    setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache')
  })
)

// SPA 回退：任何非 /api 的 GET 都交给前端路由
app.get(/^\/(?!api\/).*/, (req, res) => {
  const index = path.join(PUBLIC, 'index.html')
  if (!fs.existsSync(index)) {
    res
      .status(503)
      .type('text/plain; charset=utf-8')
      .send('前端还没构建。先运行：npm run build')
    return
  }
  res.sendFile(index)
})

// 统一错误出口
app.use((err, req, res, _next) => {
  console.error('[error]', err?.stack || err)
  if (res.headersSent) return
  res.status(err?.status || 500).json({
    error: { code: err?.code || 'INTERNAL', message: err?.message || '服务器内部错误' }
  })
})

app.listen(PORT, '0.0.0.0', () => {
  console.log('')
  console.log('  最后一公里 · LastMile')
  console.log(`  本机      http://localhost:${PORT}/#/c`)
  console.log(`  局域网    http://<你的IP>:${PORT}/#/c`)
  console.log(`  AI        ${process.env.DEEPSEEK_API_KEY ? '已配置' : '未配置 DEEPSEEK_API_KEY'}`)
  console.log('')
})
