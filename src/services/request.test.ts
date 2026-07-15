import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  isTauri: vi.fn(),
  nativeFetch: vi.fn(),
  getToken: vi.fn(),
}))

vi.mock('@tauri-apps/api/core', () => ({
  isTauri: mocks.isTauri,
}))

vi.mock('@tauri-apps/plugin-http', () => ({
  fetch: mocks.nativeFetch,
}))

vi.mock('../utils/env', () => ({
  env: {
    apiBaseUrl: 'http://hlai.hlmc.cn:5900/backendApi',
    mockToken: '',
  },
}))

vi.mock('../utils/storage', () => ({
  storage: { getToken: mocks.getToken },
}))

import { DesktopRequestError, request } from './request'

describe('desktop request', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.isTauri.mockReturnValue(true)
    mocks.getToken.mockReturnValue('desktop-token')
  })

  it('uses the native HTTP client for intranet requests', async () => {
    mocks.nativeFetch.mockResolvedValue(
      new Response(JSON.stringify({ code: 200, data: { rows: [{ id: 1 }] } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )

    await expect(
      request.get('/sys-message/page', { params: { pageNum: 1, msgStatus: 0 } }),
    ).resolves.toEqual({ rows: [{ id: 1 }] })

    const [url, init] = mocks.nativeFetch.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('http://hlai.hlmc.cn:5900/backendApi/sys-message/page?pageNum=1&msgStatus=0')
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer desktop-token')
    expect(init).toMatchObject({ method: 'GET', connectTimeout: 12_000 })
  })

  it('surfaces backend business errors', async () => {
    mocks.nativeFetch.mockResolvedValue(
      new Response(JSON.stringify({ code: 500, msg: '消息服务不可用' }), { status: 200 }),
    )

    await expect(request.get('/sys-message/page')).rejects.toEqual(
      expect.objectContaining<Partial<DesktopRequestError>>({
        name: 'DesktopRequestError',
        message: '消息服务不可用',
        code: 500,
      }),
    )
  })
})
