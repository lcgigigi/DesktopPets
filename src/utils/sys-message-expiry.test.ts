import { describe, expect, it } from 'vitest'
import {
  SYS_MESSAGE_EXPIRY_MS,
  isSysMessageExpired,
  resolveSysMessageExpiresAt,
} from './sys-message-expiry'

describe('system message expiry', () => {
  const receivedAt = new Date('2026-08-24T10:00:00').getTime()

  it('expires a valid server message 30 minutes after it was created', () => {
    expect(resolveSysMessageExpiresAt('2026-08-24 09:45:00', receivedAt)).toBe(
      new Date('2026-08-24T10:15:00').getTime(),
    )
  })

  it('rejects a message that was already older than 30 minutes on arrival', () => {
    const expiresAt = resolveSysMessageExpiresAt('2026-08-24 09:29:59', receivedAt)
    expect(isSysMessageExpired(expiresAt, receivedAt)).toBe(true)
  })

  it('uses arrival time for a missing or malformed server timestamp', () => {
    expect(resolveSysMessageExpiresAt(undefined, receivedAt)).toBe(
      receivedAt + SYS_MESSAGE_EXPIRY_MS,
    )
    expect(resolveSysMessageExpiresAt('not-a-date', receivedAt)).toBe(
      receivedAt + SYS_MESSAGE_EXPIRY_MS,
    )
  })

  it('caps future server timestamps at 30 minutes after arrival', () => {
    expect(resolveSysMessageExpiresAt('2026-08-25 10:00:00', receivedAt)).toBe(
      receivedAt + SYS_MESSAGE_EXPIRY_MS,
    )
  })
})
