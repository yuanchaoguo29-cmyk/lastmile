/* 邮件通道 —— 只走 HTTP API，绝不碰 SMTP。
 *
 * 为什么不上 nodemailer：Railway 封禁出站 25/465/587，SMTP 连接一定超时，
 * 客户端只会把「发不出去」拖成 20 秒的黑洞。契约（docs/api-v2.md §3）因此
 * 只定义两个通道，且不引任何新依赖：
 *   provider = 'resend' → POST https://api.resend.com/emails，Bearer 鉴权，20 秒超时；
 *   provider = 'log'    → 只打一行日志（收件人脱敏），直接算发送成功（本地联调）；
 *   其它                → 抛错，由 api 层收进 errors，不中断整批。
 *
 * 统一约定：成功返回 { ok, provider, id }；任何失败一律 throw，错误信息可直接回给前端。
 */

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

/** 发一封邮件。失败抛错（上层逐个学生 try/catch，收集成 errors 后继续发下一个）。 */
export async function sendMail({ provider, apiKey, from, to, subject, text, html } = {}) {
  const channel = String(provider || '').trim().toLowerCase()
  if (!channel) throw new Error('没有配置邮件通道（provider 只能是 resend 或 log）')

  const to_ = String(to || '').trim()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to_)) throw new Error(`收件人邮箱不可用：${to_ || '(空)'}`)

  // 本地联调通道：不联网，只留一行脱敏日志
  if (channel === 'log') {
    console.log(
      `[email] log 通道 ▸ to=${maskAddress(to_)} subject=${String(subject || '').slice(0, 60)} bytes=${String(text || html || '').length}`
    )
    return { ok: true, provider: 'log', id: null }
  }

  if (channel !== 'resend') {
    throw new Error(`不支持的邮件通道：${provider}（只支持 resend / log）`)
  }
  if (!apiKey) throw new Error('resend 通道缺少 API Key（请在后台重新填写）')
  const from_ = String(from || '').trim()
  if (!from_) throw new Error('resend 通道缺少发件人地址')

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
        from: from_,
        to: [to_],
        subject: String(subject || ''),
        text: String(text || ''),
        ...(html ? { html: String(html) } : {})
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

export default { sendMail, maskAddress }
