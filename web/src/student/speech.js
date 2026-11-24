/* 朗读：speechSynthesis 封装。
   页面语言映射到语音区域；不支持时 supported=false，让上层把按钮藏起来而不是报错。 */

import { useCallback, useEffect, useRef, useState } from 'react'

const VOICE_LANG = {
  zh: 'zh-CN',
  en: 'en-US',
  ru: 'ru-RU',
  vi: 'vi-VN',
  th: 'th-TH',
  id: 'id-ID',
  my: 'my-MM',
  fr: 'fr-FR'
}

export function speechSupported() {
  try {
    return (
      typeof window !== 'undefined' &&
      'speechSynthesis' in window &&
      typeof window.SpeechSynthesisUtterance === 'function'
    )
  } catch {
    return false
  }
}

/* 从系统语音列表里挑一个最贴合的：先精确匹配区域，再退到同语种。 */
function pickVoice(voices, lang) {
  const list = Array.isArray(voices) ? voices : []
  const want = VOICE_LANG[lang] || ''
  if (!list.length) return null
  const lower = (v) => String((v && v.lang) || '').toLowerCase()
  if (want) {
    const exact = list.find((v) => lower(v) === want.toLowerCase())
    if (exact) return exact
  }
  if (lang) {
    const same = list.find((v) => lower(v).startsWith(String(lang).toLowerCase()))
    if (same) return same
  }
  const anyZh = list.find((v) => lower(v).startsWith('zh'))
  return anyZh || null
}

export function useSpeech(lang) {
  const supported = useRef(speechSupported()).current
  const [speaking, setSpeaking] = useState(false)
  const speakingRef = useRef(false)
  const aliveRef = useRef(true)

  const stop = useCallback(() => {
    speakingRef.current = false
    setSpeaking(false)
    try {
      if (supported) window.speechSynthesis.cancel()
    } catch {
      /* 部分安卓 WebView 会抛，忽略即可 */
    }
  }, [supported])

  const speak = useCallback(
    (text) => {
      if (!supported) return false
      const body = String(text || '').trim()
      if (!body) return false
      if (speakingRef.current) {
        stop()
        return true
      }
      try {
        const synth = window.speechSynthesis
        synth.cancel()
        const utter = new SpeechSynthesisUtterance(body)
        const want = VOICE_LANG[lang]
        if (want) utter.lang = want
        const voice = pickVoice(synth.getVoices ? synth.getVoices() : [], lang)
        if (voice) utter.voice = voice
        utter.rate = 0.92
        utter.pitch = 1
        utter.onend = () => {
          speakingRef.current = false
          if (aliveRef.current) setSpeaking(false)
        }
        utter.onerror = () => {
          speakingRef.current = false
          if (aliveRef.current) setSpeaking(false)
        }
        speakingRef.current = true
        setSpeaking(true)
        synth.speak(utter)
        return true
      } catch {
        speakingRef.current = false
        setSpeaking(false)
        return false
      }
    },
    [supported, lang, stop]
  )

  /* 切换语言或卸载时，别让上一段语音继续念。 */
  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
      try {
        if (supported) window.speechSynthesis.cancel()
      } catch {
        /* 忽略 */
      }
    }
  }, [supported])

  useEffect(() => {
    stop()
  }, [lang, stop])

  return { supported, speaking, speak, stop }
}
