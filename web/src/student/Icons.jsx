/* 内联 SVG 图标集（无图片资源、无 CDN）。全部 aria-hidden，语义交给按钮。 */

import React from 'react'

const base = (size) => ({
  width: size,
  height: size,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': 'true',
  focusable: 'false'
})

export function IconCheck({ size = 20 }) {
  return (
    <svg {...base(size)}>
      <path d="M4 12.5l5 5L20 6.5" />
    </svg>
  )
}

/* 小测标题前的问号：只做提示，语义由标题文字承担，所以一并 aria-hidden */
export function IconQuestion({ size = 22 }) {
  return (
    <svg {...base(size)}>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.5 9.3a2.7 2.7 0 0 1 5.2.9c0 1.8-2.6 2.1-2.6 3.6" />
      <path d="M12 17v.1" />
    </svg>
  )
}

export function IconSpeaker({ size = 20 }) {
  return (
    <svg {...base(size)}>
      <path d="M4 9.5h3.2L12 6v12l-4.8-3.5H4z" />
      <path d="M16 9a4.2 4.2 0 0 1 0 6" />
      <path d="M18.6 6.4a7.6 7.6 0 0 1 0 11.2" />
    </svg>
  )
}

export function IconStop({ size = 20 }) {
  return (
    <svg {...base(size)}>
      <rect x="6.5" y="6.5" width="11" height="11" rx="2" fill="currentColor" stroke="none" />
    </svg>
  )
}

export function IconCalendar({ size = 20 }) {
  return (
    <svg {...base(size)}>
      <rect x="3.5" y="5" width="17" height="15.5" rx="3" />
      <path d="M3.5 10h17M8 3.5v3M16 3.5v3" />
      <path d="M12 13v4M10 15h4" />
    </svg>
  )
}

export function IconChevron({ size = 20, open = false }) {
  return (
    <svg
      {...base(size)}
      style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform .18s ease' }}
    >
      <path d="M6 9.5l6 6 6-6" />
    </svg>
  )
}

export function IconPhone({ size = 18 }) {
  return (
    <svg {...base(size)}>
      <path d="M5 4.5h3l1.6 4-2 1.4a11 11 0 0 0 5.5 5.5l1.4-2 4 1.6v3a2 2 0 0 1-2.2 2A16.5 16.5 0 0 1 3 6.7 2 2 0 0 1 5 4.5z" />
    </svg>
  )
}

export function IconLink({ size = 18 }) {
  return (
    <svg {...base(size)}>
      <path d="M10.5 13.5a4 4 0 0 0 5.7 0l2.6-2.6a4 4 0 1 0-5.7-5.7L11.9 6.4" />
      <path d="M13.5 10.5a4 4 0 0 0-5.7 0l-2.6 2.6a4 4 0 1 0 5.7 5.7l1.2-1.2" />
    </svg>
  )
}

export function IconAlert({ size = 22 }) {
  return (
    <svg {...base(size)}>
      <path d="M12 4.5l8.5 15H3.5z" />
      <path d="M12 10v4.2M12 17.2v.1" />
    </svg>
  )
}

export function IconPerson({ size = 22 }) {
  return (
    <svg {...base(size)}>
      <circle cx="12" cy="8.5" r="3.8" />
      <path d="M4.5 20c1.2-3.7 4.1-5.6 7.5-5.6s6.3 1.9 7.5 5.6" />
    </svg>
  )
}

export function IconBigCheck({ size = 72 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 96 96" aria-hidden="true" focusable="false">
      <circle cx="48" cy="48" r="44" fill="var(--s-accent)" />
      <path
        d="M29 49.5l13.5 13L68 35.5"
        fill="none"
        stroke="var(--s-bg)"
        strokeWidth="7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
