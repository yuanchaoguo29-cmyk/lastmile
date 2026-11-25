/* 敏感配置的加密与脱敏。
 *
 * 设计取舍：
 *  - API Key 落库前用 AES-256-GCM 加密，数据库被拷走也拿不到明文；
 *  - 密钥来源有两种：环境变量 SECRET_KEY（推荐，部署时注入），
 *    或 data/.secret 自动生成的随机文件（本地开发方便，但文件写文件和库放一起意义有限）；
 *  - 解密失败一律「当作没有配置」而不是崩掉——密钥换了/数据目录重建了，用户重填即可；
 *  - 对外只暴露「后 4 位掩码」和「指纹」（sha256 前 8 位，不可逆），日志与错误信息统一脱敏。
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

const AAD = 'lastmile.settings.v1'
const PREFIX = 'v1'

let cachedKey = null
let cachedSource = null

function secretFilePath() {
  if (process.env.SECRET_FILE) return process.env.SECRET_FILE
  // 优先和数据库放同一个卷，这样备份/迁移是「一个目录」
  if (process.env.DB_PATH) return path.join(path.dirname(process.env.DB_PATH), '.secret')
  return path.join(ROOT, 'data', '.secret')
}

function readOrCreateFileSecret() {
  const file = secretFilePath()
  try {
    if (fs.existsSync(file)) {
      const t = fs.readFileSync(file, 'utf8').trim()
      if (t.length >= 32) return t
    }
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const fresh = crypto.randomBytes(32).toString('hex')
    fs.writeFileSync(file, fresh, { mode: 0o600 })
    console.warn(`[crypto] 已生成随机密钥文件 ${file}（生产环境建议改用环境变量 SECRET_KEY）`)
    return fresh
  } catch (e) {
    console.error('[crypto] 读写密钥文件失败：', e?.message || e)
    return null
  }
}

/** 32 字节主密钥；HKDF 从 SECRET_KEY / 文件密钥派生，避免直接把原值当密钥用 */
function getKey() {
  if (cachedKey) return cachedKey
  let raw = String(process.env.SECRET_KEY || '').trim()
  cachedSource = 'env'
  if (!raw) {
    raw = readOrCreateFileSecret()
    cachedSource = raw ? 'file' : 'none'
  }
  if (!raw) return null
  cachedKey = Buffer.from(
    crypto.hkdfSync('sha256', Buffer.from(raw, 'utf8'), Buffer.from('lastmile.hkdf'), Buffer.from(AAD), 32)
  )
  return cachedKey
}

export function secretSource() {
  if (!cachedSource) getKey()
  return cachedSource || 'none'
}

const b64 = (buf) => Buffer.from(buf).toString('base64url')
const unb64 = (s) => Buffer.from(String(s), 'base64url')

/** 加密：v1.<iv>.<tag>.<ciphertext>，每字段独立随机 IV */
export function encryptSecret(plain) {
  if (plain === null || plain === undefined || plain === '') return null
  const key = getKey()
  if (!key) throw new Error('没有可用的加密密钥（请设置 SECRET_KEY）')
  const iv = crypto.randomBytes(12)
  const c = crypto.createCipheriv('aes-256-gcm', key, iv)
  c.setAAD(Buffer.from(AAD))
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()])
  return [PREFIX, b64(iv), b64(c.getAuthTag()), b64(ct)].join('.')
}

/** 解密；任何异常（密钥换过、密文损坏、格式不对）都返回 null，调用方按「未配置」处理 */
export function decryptSecret(blob) {
  if (!blob) return null
  const parts = String(blob).split('.')
  if (parts.length !== 4 || parts[0] !== PREFIX) return null
  const key = getKey()
  if (!key) return null
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', key, unb64(parts[1]))
    d.setAAD(Buffer.from(AAD))
    d.setAuthTag(unb64(parts[2]))
    return Buffer.concat([d.update(unb64(parts[3])), d.final()]).toString('utf8')
  } catch {
    return null
  }
}

export function isEncrypted(v) {
  return typeof v === 'string' && v.startsWith(PREFIX + '.') && v.split('.').length === 4
}

/** 不可逆指纹：用来确认「当前加载的是哪一把 key」，不泄露内容 */
export function fingerprint(v) {
  const s = String(v || '')
  if (!s) return ''
  return crypto.createHash('sha256').update(s).digest('hex').slice(0, 8)
}

/** 日志脱敏：任何形如 sk-xxxxx 的串都替换掉 */
export function redact(text) {
  return String(text ?? '').replace(/\b(sk|pk|ghp|xoxb)-[A-Za-z0-9_-]{8,}/g, (m) => m.slice(0, 3) + '***')
}

/** 常量时间字符串比较（先各自 sha256 成等长，避免长度泄露） */
export function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a ?? '')).digest()
  const hb = crypto.createHash('sha256').update(String(b ?? '')).digest()
  return crypto.timingSafeEqual(ha, hb)
}
