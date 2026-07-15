import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  put: vi.fn(),
}))

vi.mock('./request', () => ({
  request: { get: mocks.get, put: mocks.put },
}))

vi.mock('../utils/env', () => ({
  env: {
    enableMock: false,
    sysMessageWsBaseUrl: 'http://hlai.hlmc.cn:5900',
  },
}))

class FakeWebSocket {
  static CONNECTING = 0
  static OPEN = 1

  readonly url: string
  readyState = FakeWebSocket.OPEN
  private listeners = new Map<string, Array<(event: Event) => void>>()

  constructor(url: string) {
    this.url = url
  }

  addEventListener(type: string, listener: (event: Event) => void) {
    const listeners = this.listeners.get(type) ?? []
    listeners.push(listener)
    this.listeners.set(type, listeners)
  }

  close() {
    this.readyState = 3
    this.listeners.get('close')?.forEach((listener) => listener(new Event('close')))
  }
}

import { sysMessageService } from './sys-message.service'

describe('sysMessageService', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('window', {
      location: { protocol: 'http:', host: 'tauri.localhost' },
      setInterval: globalThis.setInterval,
      clearInterval: globalThis.clearInterval,
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
    })
    vi.stubGlobal('WebSocket', FakeWebSocket)
    mocks.get.mockReset()
    mocks.put.mockReset()
  })

  afterEach(() => {
    sysMessageService.disconnect()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('使用未读消息轮询作为 WebSocket 的提醒兜底', async () => {
    mocks.get.mockResolvedValue({
      rows: [
        {
          id: 101,
          msgSubject: '新待办提醒',
          msgContent: '你有一条新待办',
          msgStatus: 0,
          msgType: 1,
          bizType: 1,
          bizId: 42,
          createTime: '2026-07-14 10:00:00',
        },
      ],
    })
    const listener = vi.fn()
    const removeListener = sysMessageService.onMessage(listener)

    sysMessageService.connect('10002')
    await Promise.resolve()
    await Promise.resolve()

    expect(mocks.get).toHaveBeenCalledWith('/sys-message/page', {
      params: {
        pageNum: 1,
        pageSize: 20,
        msgStatus: 0,
      },
    })
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        id: '101',
        rawId: 101,
        msgSubject: '新待办提醒',
        bizId: '42',
      }),
    )

    removeListener()
  })

  it('marks the selected message as read in the backend', async () => {
    mocks.get.mockResolvedValue({ rows: [] })
    mocks.put.mockResolvedValue(true)
    const message = {
      id: '101',
      rawId: 101,
      dedupeKey: '101',
      msgSubject: '新待办提醒',
      msgContent: '你有一条新待办',
      msgStatus: 0 as const,
      msgType: 1,
    }

    await expect(sysMessageService.markRead(message)).resolves.toBe(true)

    expect(mocks.put).toHaveBeenCalledWith('/sys-message/read', { ids: [101] })
    expect(message.msgStatus).toBe(1)
  })
})
