import { describe, expect, it } from 'vitest'
import {
  DESKTOP_UNAUTHORIZED_CONFIRMATION_WINDOW_MS,
  recordConfirmedDesktopUnauthorized,
} from './session-recovery.service'

describe('desktop session unauthorized evidence', () => {
  it('keeps the session after one confirmed 401', () => {
    const confirmation = recordConfirmedDesktopUnauthorized(undefined, 'token-1', 10_000)

    expect(confirmation).toMatchObject({
      shouldExpire: false,
      evidence: {
        token: 'token-1',
        confirmations: 1,
        firstConfirmedAt: 10_000,
        lastConfirmedAt: 10_000,
      },
    })
  })

  it('expires only after a second confirmation for the same token in the evidence window', () => {
    const first = recordConfirmedDesktopUnauthorized(undefined, 'token-1', 10_000)
    const second = recordConfirmedDesktopUnauthorized(first.evidence, 'token-1', 20_000)

    expect(second.shouldExpire).toBe(true)
    expect(second.evidence.confirmations).toBe(2)
  })

  it('starts fresh for a newer login token', () => {
    const first = recordConfirmedDesktopUnauthorized(undefined, 'old-token', 10_000)
    const nextSession = recordConfirmedDesktopUnauthorized(first.evidence, 'new-token', 20_000)

    expect(nextSession.shouldExpire).toBe(false)
    expect(nextSession.evidence).toMatchObject({ token: 'new-token', confirmations: 1 })
  })

  it('does not accumulate isolated failures forever', () => {
    const first = recordConfirmedDesktopUnauthorized(undefined, 'token-1', 10_000)
    const later = recordConfirmedDesktopUnauthorized(
      first.evidence,
      'token-1',
      10_000 + DESKTOP_UNAUTHORIZED_CONFIRMATION_WINDOW_MS + 1,
    )

    expect(later.shouldExpire).toBe(false)
    expect(later.evidence.confirmations).toBe(1)
  })
})
