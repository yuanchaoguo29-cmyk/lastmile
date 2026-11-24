/* 真机宽度截图工具（CDP）。
   headless Edge 的窗口宽度有 ~480px 下限，用它验不了手机宽度；
   这里直接用 CDP 覆盖视口尺寸，能拍到真正的 390px 布局，还能在拍之前点几下。

   用法：
     node scripts/shot.mjs --url "http://localhost:3000/#/s/x?lang=en" --out shots/a.png
     node scripts/shot.mjs --url "..." --out shots/b.png --w 390 --h 1600 --mobile
     node scripts/shot.mjs --url "..." --out shots/c.png --click ".lm-student__option:nth-child(2)" --wait 1200
   --click 可重复，按顺序点。 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const argv = process.argv.slice(2)
function arg(name, def) {
  const i = argv.indexOf('--' + name)
  return i >= 0 ? argv[i + 1] : def
}
function flag(name) {
  return argv.includes('--' + name)
}

const URL_ = arg('url', 'http://localhost:3000/#/c')
const OUT = arg('out', 'shots/shot.png')
const W = Number(arg('w', '1440'))
const H = Number(arg('h', '900'))
const MOBILE = flag('mobile')
const WAIT = Number(arg('wait', '1500'))
const PORT = Number(arg('port', '9333'))

const clicks = []
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--click') clicks.push({ type: 'sel', value: argv[i + 1] })
  if (argv[i] === '--clicktext') clicks.push({ type: 'text', value: argv[i + 1] })
  if (argv[i] === '--type') clicks.push({ type: 'type', value: argv[i + 1] })
}

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function findBrowser() {
  for (const p of EDGE_CANDIDATES) if (fs.existsSync(p)) return p
  throw new Error('找不到 Chrome/Edge')
}

class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl)
    this.id = 0
    this.pending = new Map()
    this.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)
      }
    })
  }
  ready() {
    return new Promise((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve())
      this.ws.addEventListener('error', (e) => reject(new Error('WS 连接失败')))
    })
  }
  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error('CDP 超时: ' + method))
        }
      }, 30000)
    })
  }
}

async function main() {
  const browser = findBrowser()
  const profile = path.resolve('data', 'shot-profile')
  fs.mkdirSync(profile, { recursive: true })
  fs.mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true })

  const proc = spawn(
    browser,
    [
      '--headless=new',
      ...(flag('sw') ? ['--disable-gpu'] : []),
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${profile}`,
      'about:blank'
    ],
    { stdio: 'ignore' }
  )

  let target = null
  for (let i = 0; i < 40; i++) {
    await sleep(250)
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      const list = await res.json()
      target = list.find((t) => t.type === 'page')
      if (target?.webSocketDebuggerUrl) break
    } catch {}
  }
  if (!target) {
    proc.kill()
    throw new Error('无法连上 CDP')
  }

  const cdp = new CDP(target.webSocketDebuggerUrl)
  await cdp.ready()
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')

  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: W,
    height: H,
    deviceScaleFactor: 1,
    mobile: MOBILE,
    screenWidth: W,
    screenHeight: H
  })
  if (MOBILE) {
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
    await cdp.send('Emulation.setUserAgentOverride', {
      userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
    })
  }

  await cdp.send('Page.navigate', { url: URL_ })
  await sleep(WAIT)

  for (const c of clicks) {
    const expr =
      c.type === 'sel'
        ? `(() => {
            const el = document.querySelector(${JSON.stringify(c.value)});
            if (!el) return 'MISS';
            el.scrollIntoView({block:'center'});
            el.click();
            return 'OK';
          })()`
        : c.type === 'type'
          ? `(() => {
              const raw = ${JSON.stringify(c.value)};
              const i = raw.indexOf('::');
              const sel = raw.slice(0, i), text = raw.slice(i + 2);
              const el = document.querySelector(sel);
              if (!el) return 'MISS';
              const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
              setter.call(el, text);
              el.dispatchEvent(new Event('input', { bubbles: true }));
              return 'OK';
            })()`
          : `(() => {
              const t = ${JSON.stringify(c.value)};
              const nodes = [...document.querySelectorAll('button,a,summary,[role=tab],div,span')];
              const el = nodes.find(n => n.textContent.trim() === t)
                      || nodes.find(n => n.textContent.trim().includes(t));
              if (!el) return 'MISS';
              el.scrollIntoView({block:'center'});
              el.click();
              return 'OK';
            })()`
    const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true })
    console.log(`  ${c.type} ${c.value} → ${r.result.value}`)
    await sleep(c.type === 'text' && /解析|催办|翻译|生成/.test(c.value) ? 9000 : 1200)
  }

  const after = Number(arg('after', '0'))
  if (after) {
    console.log(`  等待 ${after}ms …`)
    await sleep(after)
  }

  const evalJs = arg('eval', '')
  if (evalJs) {
    const r = await cdp.send('Runtime.evaluate', { expression: evalJs, returnByValue: true, awaitPromise: true })
    console.log('  eval →', JSON.stringify(r.result.value, null, 1).slice(0, 3000))
    if (flag('evalonly')) {
      cdp.ws.close()
      proc.kill()
      await sleep(300)
      process.exit(0)
    }
  }

  // 量一下有没有横向溢出，顺便把关键尺寸打出来
  const metrics = await cdp.send('Runtime.evaluate', {
    expression: `JSON.stringify({
      scrollW: document.documentElement.scrollWidth,
      innerW: window.innerWidth,
      overflow: document.documentElement.scrollWidth > window.innerWidth + 1
    })`,
    returnByValue: true
  })
  console.log('  viewport', metrics.result.value)

  const shot = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: !flag('vp'),
    fromSurface: true
  })
  fs.writeFileSync(path.resolve(OUT), Buffer.from(shot.data, 'base64'))
  console.log(`  saved ${OUT} (${(fs.statSync(path.resolve(OUT)).size / 1024).toFixed(0)} KB)`)

  cdp.ws.close()
  proc.kill()
  await sleep(300)
  process.exit(0)
}

main().catch((e) => {
  console.error('截图失败:', e.message)
  process.exit(1)
})
