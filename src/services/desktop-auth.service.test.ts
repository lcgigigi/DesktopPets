import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DESKTOP_AUTH_ATTEMPT_MAX_AGE,
  getOrCreateDesktopAuthState,
  parseDesktopAuthCallback,
} from './desktop-auth.service'
import desktopAuthServiceSource from './desktop-auth.service.ts?raw'
import { storage } from '../utils/storage'

function createLocalStorage() {
  const values = new Map<string, string>()

  return {
    getItem(key: string) {
      return values.get(key) ?? null
    },
    setItem(key: string, value: string) {
      values.set(key, value)
    },
    removeItem(key: string) {
      values.delete(key)
    },
    clear() {
      values.clear()
    },
    key(index: number) {
      return [...values.keys()][index] ?? null
    },
    get length() {
      return values.size
    },
  } satisfies Storage
}

describe('desktop auth callback', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', createLocalStorage())
    storage.setDesktopAuthState('expected-state')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('accepts a complete callback with the expected state', () => {
    expect(
      parseDesktopAuthCallback(
        'huali-ai-mascot://auth-callback?token=token-1&userId=10002&userName=Tester&state=expected-state',
      ),
    ).toEqual({
      token: 'token-1',
      userInfo: {
        userId: '10002',
        userName: 'Tester',
      },
    })
  })

  it('accepts Windows protocol callbacks whose custom-scheme host casing changed', () => {
    expect(
      parseDesktopAuthCallback(
        'HUALI-AI-MASCOT://AUTH-CALLBACK?token=token-1&userId=10002&state=expected-state',
      ),
    ).toEqual({
      token: 'token-1',
      userInfo: {
        userId: '10002',
        userName: '10002',
      },
    })
  })

  it('deduplicates only recognized callbacks so redundant native delivery remains useful', () => {
    const handleUrlsStart = desktopAuthServiceSource.indexOf('async function handleUrls')
    const handleUrlsEnd = desktopAuthServiceSource.indexOf(
      'export async function prepareDesktopReleaseSmokeState',
      handleUrlsStart,
    )
    const handleUrls = desktopAuthServiceSource.slice(handleUrlsStart, handleUrlsEnd)
    const parsedAt = handleUrls.indexOf('const result = parseDesktopAuthCallbackResult(url)')
    const ignoredAt = handleUrls.indexOf("if (result.status === 'ignored') return")
    const rememberedAt = handleUrls.indexOf('handledUrls.add(url)', ignoredAt)

    expect(handleUrlsStart).toBeGreaterThanOrEqual(0)
    expect(handleUrlsEnd).toBeGreaterThan(handleUrlsStart)
    expect(parsedAt).toBeGreaterThanOrEqual(0)
    expect(ignoredAt).toBeGreaterThan(parsedAt)
    expect(rememberedAt).toBeGreaterThan(ignoredAt)
  })

  it('rejects a callback with a mismatched state', () => {
    expect(
      parseDesktopAuthCallback(
        'huali-ai-mascot://auth-callback?token=token-1&userId=10002&state=other-state',
      ),
    ).toBeNull()
  })

  it('rejects a callback without an identity', () => {
    expect(
      parseDesktopAuthCallback(
        'huali-ai-mascot://auth-callback?state=expected-state',
      ),
    ).toBeNull()
  })

  it('reuses one active state when the confirmation page is reopened', () => {
    storage.setDesktopAuthState('active-state', 10_000)

    expect(getOrCreateDesktopAuthState(20_000)).toBe('active-state')
    expect(storage.getDesktopAuthAttempt()).toEqual({
      state: 'active-state',
      createdAt: 10_000,
    })
  })

  it('renews an expired state instead of accepting an old browser tab forever', () => {
    storage.setDesktopAuthState('expired-state', 10_000)
    vi.stubGlobal('crypto', {
      randomUUID: () => 'renewed-state',
    })

    expect(
      getOrCreateDesktopAuthState(10_000 + DESKTOP_AUTH_ATTEMPT_MAX_AGE),
    ).toBe('renewed-state')
    expect(storage.getDesktopAuthAttempt()).toEqual({
      state: 'renewed-state',
      createdAt: 10_000 + DESKTOP_AUTH_ATTEMPT_MAX_AGE,
    })
  })

  it('migrates a v1.0.45 raw state without breaking an open confirmation page', () => {
    localStorage.setItem('huali_ai_desktop_auth_state', 'legacy-state')

    expect(storage.getDesktopAuthState()).toBe('legacy-state')
    expect(storage.getDesktopAuthAttempt()?.createdAt).toEqual(expect.any(Number))
  })
})
