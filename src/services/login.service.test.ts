import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  post: vi.fn(),
  loadDesktopCurrentUser: vi.fn(),
  setToken: vi.fn(),
  clearToken: vi.fn(),
}))

vi.mock('./request', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./request')>()
  return {
    ...actual,
    request: { post: mocks.post },
  }
})

vi.mock('./session.service', () => ({
  loadDesktopCurrentUser: mocks.loadDesktopCurrentUser,
}))

vi.mock('../utils/storage', () => ({
  storage: {
    setToken: mocks.setToken,
    clearToken: mocks.clearToken,
  },
}))

import { loginDesktop } from './login.service'

describe('loginDesktop', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('登录成功后使用 token 获取当前用户', async () => {
    mocks.post.mockResolvedValue({ token: 'desktop-token' })
    mocks.loadDesktopCurrentUser.mockResolvedValue({
      userId: 'u-10001',
      userName: '王小明',
      department: '产品部',
    })

    await expect(loginDesktop({ username: ' 10001 ', password: 'secret' })).resolves.toEqual({
      token: 'desktop-token',
      userInfo: {
        userId: 'u-10001',
        userName: '王小明',
        department: '产品部',
      },
    })
    expect(mocks.post).toHaveBeenCalledWith('/login', {
      username: '10001',
      password: 'secret',
    })
    expect(mocks.setToken).toHaveBeenCalledWith('desktop-token')
  })

  it('获取用户信息失败时清除临时 token', async () => {
    mocks.post.mockResolvedValue({ token: 'desktop-token' })
    mocks.loadDesktopCurrentUser.mockRejectedValue(new Error('用户信息请求失败'))

    await expect(loginDesktop({ username: '10001', password: 'secret' })).rejects.toThrow(
      '用户信息请求失败',
    )
    expect(mocks.clearToken).toHaveBeenCalledOnce()
  })

  it('后台没有返回 token 时不保存登录态', async () => {
    mocks.post.mockResolvedValue({})

    await expect(loginDesktop({ username: '10001', password: 'secret' })).rejects.toThrow(
      '登录成功，但后台未返回 token',
    )
    expect(mocks.setToken).not.toHaveBeenCalled()
  })
})
