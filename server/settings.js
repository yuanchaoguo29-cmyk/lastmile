/* 运行时可改的配置。
   优先级：数据库（界面里改的）> 环境变量 > 内置默认。
   写库的同时把值镜像进 process.env —— ai.js 和 api.js 都是「调用时读 env」，
   所以界面上一保存就立即生效，不需要重启。

   安全：deepseek_api_key 落库前用 AES-256-GCM 加密（见 crypto.js），
   数据库被拷走也拿不到明文；环境变量里始终是明文，只存在于进程内存。 */

import { getDb, nowIso } from './db.js'
import { encryptSecret, decryptSecret, fingerprint, isEncrypted, redact } from './crypto.js'

export const AI_DEFAULTS = {
  base_url: 'https://api.deepseek.com',
  model: 'deepseek-chat'
}

/** 设置项 key → 环境变量名 */
const ENV_OF = {
  counselor_key: 'COUNSELOR_KEY',
  deepseek_api_key: 'DEEPSEEK_API_KEY',
  deepseek_base_url: 'DEEPSEEK_BASE_URL',
  deepseek_model: 'DEEPSEEK_MODEL'
}

/** 需要加密落库的项 */
const SENSITIVE = new Set(['deepseek_api_key'])

const KEYS = Object.keys(ENV_OF)

/** 上次解密是否失败（密钥换过 / 数据目录被重建） */
let brokenKeys = new Set()

export function brokenKeyList() {
  return [...brokenKeys]
}

export function loadSettingsIntoEnv() {
  const db = getDb()
  brokenKeys = new Set()

  for (const k of KEYS) {
    try {
      const row = db.prepare('SELECT v FROM settings WHERE k = ?').get(k)
      if (!row || row.v === null || row.v === undefined || row.v === '') continue

      let value = row.v
      if (SENSITIVE.has(k)) {
        if (!isEncrypted(row.v)) {
          // 老版本遗留的明文：读出来重新加密存回去，顺手完成一次就地迁移
          const plain = String(row.v)
          try {
            setSetting(k, plain, { skipEnv: true })
            console.log(`[settings] ${k} 已从明文迁移为密文`)
          } catch (e) {
            console.error('[settings] 明文转密文失败（保持可用）：', redact(e?.message || e))
          }
          value = plain
        } else {
          const plain = decryptSecret(row.v)
          if (plain === null) {
            brokenKeys.add(k)
            delete process.env[ENV_OF[k]]
            console.warn(
              `[settings] ${k} 解密失败：SECRET_KEY 变了或数据目录被重置。请在后台重新填写 API Key`
            )
            continue
          }
          value = plain
        }
      }

      process.env[ENV_OF[k]] = value
    } catch (e) {
      console.error('[settings] 读取失败', k, redact(e?.message || e))
    }
  }

  // 环境里也没有就给默认，保证 AI 客户端永远拿得到 base_url / model
  if (!process.env.DEEPSEEK_BASE_URL) process.env.DEEPSEEK_BASE_URL = AI_DEFAULTS.base_url
  if (!process.env.DEEPSEEK_MODEL) process.env.DEEPSEEK_MODEL = AI_DEFAULTS.model
  if (!process.env.COUNSELOR_KEY) process.env.COUNSELOR_KEY = '123456'
}

/** 直接读库里的原始值（敏感项是密文）。绝大多数场景请用 env 或 resolve() */
export function getSetting(key) {
  const db = getDb()
  const row = db.prepare('SELECT v FROM settings WHERE k = ?').get(key)
  return row ? row.v : null
}

/** 读出来并解密（敏感项）；非敏感项原样返回 */
export function resolve(key) {
  const raw = getSetting(key)
  if (raw === null || raw === undefined) return null
  if (SENSITIVE.has(key)) return isEncrypted(raw) ? decryptSecret(raw) : String(raw)
  return String(raw)
}

export function setSetting(key, value, { skipEnv = false } = {}) {
  const db = getDb()
  const store = SENSITIVE.has(key) ? encryptSecret(value) : value
  db.prepare(
    `INSERT INTO settings (k, v, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at`
  ).run(key, store, nowIso())
  if (!skipEnv && ENV_OF[key]) process.env[ENV_OF[key]] = value
}

export function deleteSetting(key) {
  const db = getDb()
  db.prepare('DELETE FROM settings WHERE k = ?').run(key)
  if (ENV_OF[key]) delete process.env[ENV_OF[key]]
  brokenKeys.delete(key)
}

/** sk-abcdefghijklmnop → sk-a…mnop */
export function maskKey(v) {
  const s = String(v || '')
  if (!s) return ''
  if (s.length <= 10) return '••••••'
  return `${s.slice(0, 4)}…${s.slice(-4)}`
}

/** 当前生效的 key 只给出「掩码 + 指纹」，不给明文 */
export function keyStatus() {
  const key = process.env.DEEPSEEK_API_KEY || ''
  return {
    api_key_set: Boolean(key),
    api_key_masked: maskKey(key),
    api_key_fingerprint: fingerprint(key),
    api_key_broken: brokenKeys.has('deepseek_api_key'),
    api_key_from: resolve('deepseek_api_key') ? 'database' : key ? 'environment' : 'none'
  }
}

/** 用当前配置真打一次模型，给「测试连接」用 */
export async function testAi() {
  const key = process.env.DEEPSEEK_API_KEY || ''
  const base = (process.env.DEEPSEEK_BASE_URL || AI_DEFAULTS.base_url).replace(/\/+$/, '')
  const model = process.env.DEEPSEEK_MODEL || AI_DEFAULTS.model
  if (!key) return { ok: false, error: '还没有配置 API Key' }

  const t0 = Date.now()
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 25000)
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'Reply with exactly: pong' }],
        max_tokens: 8,
        stream: false
      }),
      signal: ctrl.signal
    })
    const text = await res.text()
    if (!res.ok) {
      let detail = text.slice(0, 180)
      try {
        detail = JSON.parse(text)?.error?.message || detail
      } catch {}
      return { ok: false, error: redact(`HTTP ${res.status}：${detail}`) }
    }
    let reply = ''
    let realModel = model
    try {
      const j = JSON.parse(text)
      reply = j?.choices?.[0]?.message?.content || ''
      realModel = j?.model || model
    } catch {}
    return { ok: true, model: realModel, ms: Date.now() - t0, reply: String(reply).trim().slice(0, 40) }
  } catch (e) {
    if (e?.name === 'AbortError') return { ok: false, error: '连接超时（25 秒）' }
    return { ok: false, error: redact(String(e?.message || e)) }
  } finally {
    clearTimeout(timer)
  }
}
