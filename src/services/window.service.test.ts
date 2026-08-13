import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  openUrl: vi.fn(),
  windowOpen: vi.fn(),
  emitTo: vi.fn(),
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))
vi.mock('@tauri-apps/api/event', () => ({ emitTo: mocks.emitTo }))
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: mocks.openUrl }))
vi.mock('../utils/env', () => ({
  env: {
    webBaseUrl: 'https://workbench.example.com',
    desktopUserId: '',
    enableMock: false,
    mockUserId: '',
  },
}))
vi.mock('../utils/storage', () => ({
  storage: { getUserInfo: vi.fn(() => null) },
}))

import {
  PANEL_REVEAL_EVENT,
  openExternal,
  showNotificationWindow,
  showPanelWindow,
  togglePanelWindow,
} from './window.service'

describe('external window opening', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('window', {
      open: mocks.windowOpen,
      dispatchEvent: vi.fn(),
    })
  })

  it('returns true when native code reuses an existing browser tab', async () => {
    mocks.invoke.mockResolvedValue(true)

    await expect(openExternal('https://workbench.example.com/calendar')).resolves.toBe(true)
    expect(mocks.openUrl).not.toHaveBeenCalled()
  })

  it('returns true when the opener launches a new browser tab', async () => {
    mocks.invoke.mockResolvedValue(false)
    mocks.openUrl.mockResolvedValue(undefined)

    await expect(openExternal('https://workbench.example.com/calendar')).resolves.toBe(true)
  })

  it('returns false when native reuse, opener, and browser fallback all fail', async () => {
    mocks.invoke.mockRejectedValue(new Error('not in Tauri'))
    mocks.openUrl.mockRejectedValue(new Error('no opener'))
    mocks.windowOpen.mockReturnValue(null)

    await expect(openExternal('https://workbench.example.com/calendar')).resolves.toBe(false)
  })

  it('returns true and removes opener access when the browser fallback opens', async () => {
    const openedWindow = { opener: {} }
    mocks.invoke.mockRejectedValue(new Error('not in Tauri'))
    mocks.openUrl.mockRejectedValue(new Error('no opener'))
    mocks.windowOpen.mockReturnValue(openedWindow)

    await expect(openExternal('https://workbench.example.com/calendar')).resolves.toBe(true)
    expect(openedWindow.opener).toBeNull()
  })
})

describe('background task panel reveal', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns false and does not emit a reveal when native positioning fails', async () => {
    mocks.invoke.mockResolvedValue(false)
    await expect(showPanelWindow({ focus: false })).resolves.toBe(false)
    expect(mocks.emitTo).not.toHaveBeenCalled()
  })

  it('requests non-activating display for pushed tasks', async () => {
    mocks.invoke.mockResolvedValue(true)
    await expect(showPanelWindow({ focus: false })).resolves.toBe(true)
    expect(mocks.invoke).toHaveBeenCalledWith('show_panel_window', { focus: false })
    expect(mocks.emitTo).toHaveBeenCalledWith('panel', PANEL_REVEAL_EVENT, {
      focus: false,
    })
  })

  it('marks a deliberate mascot toggle as focus-eligible', async () => {
    mocks.invoke.mockResolvedValue(true)
    await expect(togglePanelWindow()).resolves.toBe(true)
    expect(mocks.emitTo).toHaveBeenCalledWith('panel', PANEL_REVEAL_EVENT, { focus: true })
  })

  it('returns the native non-activating reminder show result', async () => {
    mocks.invoke.mockResolvedValue(false)
    await expect(showNotificationWindow()).resolves.toBe(false)
    expect(mocks.invoke).toHaveBeenCalledWith('show_notification_window')
  })
})
