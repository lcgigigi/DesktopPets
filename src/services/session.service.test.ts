import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ get: vi.fn() }))

vi.mock('./request', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./request')>()
  return {
    ...actual,
    request: { get: mocks.get },
  }
})

import { DesktopRequestError } from './request'
import { validateDesktopSession } from './session.service'

describe('validateDesktopSession', () => {
  beforeEach(() => {
    mocks.get.mockReset()
  })

  it('accepts the persisted user when the token resolves to the same account', async () => {
    mocks.get.mockResolvedValue({
      user: {
        userName: '10001',
        nickName: '王小明',
        deptName: '产品部',
      },
    })

    await expect(validateDesktopSession('10001')).resolves.toEqual({
      status: 'valid',
      userInfo: {
        userId: '10001',
        userName: '王小明',
        department: '产品部',
      },
    })
  })

  it('prefers the real userId over userName when validating the desktop session', async () => {
    mocks.get.mockResolvedValue({
      user: {
        userId: 'u-10001',
        userName: '10001',
        nickName: '王小明',
      },
    })

    await expect(validateDesktopSession('u-10001')).resolves.toEqual({
      status: 'valid',
      userInfo: {
        userId: 'u-10001',
        userName: '王小明',
        department: undefined,
      },
    })
  })

  it('keeps the callback userId when getInfo uses a different internal userId but the userName matches', async () => {
    mocks.get.mockResolvedValue({
      user: {
        userId: 'internal-42',
        userName: '10001',
        nickName: '王小明',
      },
    })

    await expect(validateDesktopSession('10001')).resolves.toEqual({
      status: 'valid',
      userInfo: {
        userId: '10001',
        userName: '王小明',
        department: undefined,
      },
    })
  })

  it('treats an account mismatch or an unauthorized response as an expired desktop session', async () => {
    mocks.get.mockResolvedValue({ user: { userName: '10002', nickName: '李华' } })
    await expect(validateDesktopSession('10001')).resolves.toEqual({ status: 'unauthorized' })

    mocks.get.mockRejectedValue(new DesktopRequestError('登录状态已过期', { status: 401 }))
    await expect(validateDesktopSession('10001')).resolves.toEqual({ status: 'unauthorized' })
  })

  it('keeps the desktop session on a temporary network failure', async () => {
    mocks.get.mockRejectedValue(new Error('Network Error'))

    await expect(validateDesktopSession('10001')).resolves.toEqual({ status: 'unavailable' })
  })
})
