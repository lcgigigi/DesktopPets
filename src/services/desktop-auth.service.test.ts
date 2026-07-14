import { beforeEach, describe, expect, it, vi } from 'vitest'
import { parseDesktopAuthCallback } from './desktop-auth.service'
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
})
