/* 开发模式：同时起后端(3000) 与 vite(5173)，Ctrl+C 一起退。
   交付/演示不用这个，用 npm run build && npm start 单进程。 */

import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const isWin = process.platform === 'win32'
const npx = isWin ? 'npx.cmd' : 'npx'
const node = process.execPath

const children = []

function run(label, cmd, args, color) {
  const p = spawn(cmd, args, { cwd: ROOT, stdio: 'inherit', shell: false, env: process.env })
  p.on('exit', (code) => {
    console.log(`\n[${label}] 退出 code=${code}`)
    shutdown()
  })
  children.push(p)
  return p
}

function shutdown() {
  for (const c of children) {
    try {
      c.kill()
    } catch {}
  }
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

run('api', node, ['--env-file-if-exists=.env', 'server/index.js'])
run('web', npx, ['vite'])
