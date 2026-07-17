import { describe, expect, it } from 'vitest'
import { formatSysMessageDisplayTime, normalizeSysMessageDateTime } from './sys-message-display'

describe('formatSysMessageDisplayTime', () => {
  const now = new Date(2026, 6, 16, 12, 0)

  it('uses a friendly fallback when no time is available', () => {
    expect(formatSysMessageDisplayTime(undefined, now)).toBe('刚刚')
  })

  it('keeps an unrecognized server value readable', () => {
    expect(formatSysMessageDisplayTime('2026/invalid/server-time', now)).toBe('2026/invalid/ser')
  })

  it('formats midnight with hour 00 instead of hour 24', () => {
    expect(formatSysMessageDisplayTime('2026-07-16 00:05', now)).toBe('今天 00:05')
  })

  it('includes the month and day for an earlier date', () => {
    expect(formatSysMessageDisplayTime('2026-07-15 09:03', now)).toBe('7月15日 09:03')
  })

  it('normalizes a backend timestamp for the time element', () => {
    expect(normalizeSysMessageDateTime('2026-07-16 19:10')).toBe('2026-07-16T19:10')
    expect(normalizeSysMessageDateTime('invalid')).toBeUndefined()
  })
})
