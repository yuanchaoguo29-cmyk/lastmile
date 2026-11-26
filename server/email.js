/* 邮件通道 —— SMTP（学校服务器）与 Resend（HTTP API）。
 *
 * 目标部署环境是学校自己的服务器，学校邮件网关只认 SMTP，所以默认通道是 smtp。
 * Railway 封禁出站 25/465/587，部署在 Railway 时只能用 resend：
 *   provider = 'smtp'   → nodemailer，config = { host, port, secure, user, pass }，连接超时 20 秒；
 *   provider = 'resend' → POST https://api.resend.com/emails，Bearer 鉴权，20 秒超时；
 *   其它                → 抛错，由 api 层收进 errors，不中断整批。
 *
 * 没有 log 通道：「不发真信」不该被当成发送成功，本地联调请用一封真信或 Resend 测试域。
 *
 * 统一约定：成功返回 { ok, provider, id }；任何失败一律 throw，错误信息可直接回给前端
 * （密码/授权码在这里统一抹掉，不会出现在错误文案与日志里）。
 */

import { createTransport } from 'nodemailer'

const RESEND_ENDPOINT = 'https://api.resend.com/emails'
const TIMEOUT_MS = 20000

/** 收件人脱敏：zhangsan@example.com → z***@example.com（日志里不留完整地址） */
export function maskAddress(addr) {
  const s = String(addr || '').trim()
  const at = s.lastIndexOf('@')
  if (at <= 0) return s ? '***' : ''
  const name = s.slice(0, at)
  const domain = s.slice(at)
  return `${name.slice(0, 1)}***${domain}`
}

/** 错误文案里抹掉密码：nodemailer 的 response 一般不含密码，但这里不能赌 */
function scrub(text, secret) {
  let s = String(text ?? '')
  const p = String(secret ?? '')
  if (p.length >= 3) s = s.split(p).join('***')
  return s.slice(0, 300)
}

/* nodemailer 的错误码 → 一句人话，方便辅导员直接看懂该改哪里 */
function smtpHint(e) {
  const code = String(e?.code || '').trim()
  const msg = String(e?.message || '')
  if (code === 'EAUTH') return 'SMTP 认证失败（用户名 / 密码或授权码不对）'
  if (code === 'EENVELOPE') return 'SMTP 拒收（发件人或收件人地址不被接受）'
  if (code === 'EMESSAGE') return 'SMTP 拒收（邮件内容被拒绝）'
  if (code === 'EDNS' || /ENOTFOUND|EAI_AGAIN/.test(msg)) return 'SMTP 主机名解析失败'
  if (/ECONNREFUSED/.test(msg)) return '连不上 SMTP 服务器（地址或端口不对，或服务没开）'
  if (code === 'ETIMEDOUT' || /timed?\s?out/i.test(msg)) return '连接 SMTP 超时'
  if (code === 'ECONNECTION' || code === 'ESOCKET') return '连不上 SMTP 服务器'
  return 'SMTP 发送失败'
}

/** SMTP 通道：每次新建 transport（不池化），发完立刻关掉，避免进程被 socket 挂住 */
async function sendSmtp({ config, from, to, subject, text, html }) {
  const c = config && typeof config === 'object' ? config : {}
  const host = String(c.host || '').trim()
  if (!host) throw new Error('smtp 通道缺少 SMTP 主机（例如 smtp.university.edu.cn）')

  const port = Number(c.port) || (Number(c.secure) ? 465 : 587)
  // 加密方式由端口决定：465 直连 TLS，其余（587/25）先明文再 STARTTLS
  const secure = port === 465
  const user = String(c.user || '').trim()
  const pass = String(c.pass ?? '')
  if (user && !pass) throw new Error('smtp 通道缺少密码或授权码')

  const transporter = createTransport({
    host,
    port,
    secure,
    connectionTimeout: TIMEOUT_MS,
    greetingTimeout: TIMEOUT_MS,
    socketTimeout: TIMEOUT_MS,
    ...(user ? { auth: { user, pass } } : {})
  })

  try {
    const info = await transporter.sendMail({
      from,
      to,
      subject,
      text,
      ...(html ? { html } : {})
    })
    return { ok: true, provider: 'smtp', id: info?.messageId || null }
  } catch (e) {
    const code = String(e?.code || '').trim()
    const detail = scrub(e?.response || e?.message || e, pass)
    throw new Error(`${smtpHint(e)}（${host}:${port}${code ? ' · ' + code : ''}）：${detail || '无更多信息'}`)
  } finally {
    try {
      transporter.close()
    } catch {}
  }
}

/** Resend 通道：HTTP API，Bearer 鉴权 */
async function sendResend({ apiKey, from, to, subject, text, html }) {
  if (!apiKey) throw new Error('resend 通道缺少 API Key（请在后台重新填写）')

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from,
        to: [to],
        subject,
        text,
        ...(html ? { html } : {})
      }),
      signal: ctrl.signal
    })

    const raw = await res.text()
    if (!res.ok) {
      let detail = raw.slice(0, 200)
      try {
        detail = JSON.parse(raw)?.message || JSON.parse(raw)?.error || detail
      } catch {}
      throw new Error(`Resend HTTP ${res.status}：${String(detail).slice(0, 200)}`)
    }

    let id = null
    try {
      id = JSON.parse(raw)?.id || null
    } catch {}
    return { ok: true, provider: 'resend', id }
  } catch (e) {
    if (e?.name === 'AbortError') throw new Error(`发送超时（${TIMEOUT_MS / 1000} 秒）`)
    throw e
  } finally {
    clearTimeout(timer)
  }
}

/** 发一封邮件。失败抛错（上层逐个学生 try/catch，收集成 errors 后继续发下一个）。
 *  config 只给 smtp 用；resend 既接 apiKey，也兼容 config.resendKey（账号配置统一存在一处）。 */
export async function sendMail({ provider, config, apiKey, from, to, subject, text, html } = {}) {
  const channel = String(provider || '').trim().toLowerCase()
  if (!channel) throw new Error('没有配置邮件通道（provider 只能是 smtp 或 resend）')

  const to_ = String(to || '').trim()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to_)) throw new Error(`收件人邮箱不可用：${to_ || '(空)'}`)

  const from_ = String(from || '').trim()
  if (!from_) throw new Error('缺少发件人地址')

  const mail = {
    from: from_,
    to: to_,
    subject: String(subject || ''),
    text: String(text || ''),
    html: html ? String(html) : ''
  }

  if (channel === 'smtp') return sendSmtp({ config, ...mail })
  if (channel === 'resend') {
    return sendResend({ apiKey: apiKey || config?.resendKey, ...mail })
  }
  throw new Error(`不支持的邮件通道：${provider}（只支持 smtp / resend）`)
}

export default { sendMail, maskAddress }
