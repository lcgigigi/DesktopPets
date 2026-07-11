import { openUrl } from '@tauri-apps/plugin-opener'
import { invoke } from '@tauri-apps/api/core'
import { DESKTOP_AUTH_SCHEME } from './desktop-auth.service'
import type { SysMessageNotification } from '../types/sys-message'
import { env } from '../utils/env'
import { storage } from '../utils/storage'

function getWebBaseUrl() {
  return env.webBaseUrl.replace(/\/$/, '')
}

function buildUrl(path: string) {
  return `${getWebBaseUrl()}${path}`
}

function buildQuery(params: Record<string, string | undefined>) {
  const search = new URLSearchParams()
  Object.entries(params).forEach(([key, value]) => {
    if (value) search.set(key, value)
  })

  const query = search.toString()
  return query ? `?${query}` : ''
}

function getDesktopUserId() {
  return storage.getUserInfo()?.userId || env.desktopUserId || (env.enableMock ? env.mockUserId : '')
}

function getDesktopLinkParams() {
  const desktopUserId = getDesktopUserId()
  return {
    from: 'desktop',
    desktopClient: 'huali-ai-mascot',
    desktopUserId: desktopUserId || undefined
  }
}

async function openExternal(url: string) {
  try {
    const reused = await invoke<boolean>('open_or_focus_web_url', {
      url,
      matchUrl: getWebBaseUrl()
    })

    if (reused) return
  } catch {
    // Browser tab reuse is only available inside the macOS desktop shell.
  }

  try {
    await openUrl(url)
  } catch {
    window.open(url, '_blank', 'noopener,noreferrer')
  }
}

export function openWorkbench(options: { draftId?: string; todoText?: string } = {}) {
  const query = buildQuery({
    ...getDesktopLinkParams(),
    todoDraftId: options.draftId,
    desktopTodoText: options.todoText
  })
  return openExternal(buildUrl(`/workbench${query}`))
}

export function openDesktopLogin(state: string) {
  const query = buildQuery({
    from: 'desktop',
    desktopCallback: `${DESKTOP_AUTH_SCHEME}://auth-callback`,
    state
  })

  return openExternal(buildUrl(`/login${query}`))
}

export function openCalendar(taskId?: string) {
  const query = buildQuery({
    ...getDesktopLinkParams(),
    taskId
  })
  return openExternal(buildUrl(`/calendar${query}`))
}

export function openSysMessageDetail(message: SysMessageNotification) {
  const detailId = message.bizId || message.id
  const query = buildQuery({
    ...getDesktopLinkParams(),
    desktopTodoId: detailId,
    desktopMessageId: message.id,
    desktopBizType: message.bizType === undefined ? undefined : String(message.bizType)
  })

  return openExternal(buildUrl(`/calendar${query}`))
}

export function openAgents() {
  const query = buildQuery(getDesktopLinkParams())
  return openExternal(buildUrl(`/agents${query}`))
}

export async function hideAssistant() {
  try {
    await invoke('hide_panel_window')
    await invoke('show_main_window')
  } catch {
    document.body.classList.add('is-hidden-preview')
  }
}

export async function showAssistant() {
  try {
    await invoke('show_main_window')
  } catch {
    return
  }
}

export async function togglePanelWindow() {
  try {
    await invoke('toggle_panel_window')
  } catch {
    return
  }
}

export async function showPanelWindow() {
  try {
    await invoke('show_panel_window')
  } catch {
    return
  }
}

export async function hidePanelWindow() {
  try {
    await invoke('hide_panel_window')
  } catch {
    return
  }
}

export async function setMascotPosition(x: number, y: number) {
  try {
    await invoke('set_mascot_position', { x, y })
  } catch {
    return
  }
}

export async function syncPanelWindow() {
  try {
    await invoke('sync_panel_window')
  } catch {
    return
  }
}

export async function setMascotNotificationVisible(visible: boolean, compact = false) {
  try {
    await invoke('set_mascot_notification_visible', { visible, compact })
  } catch {
    return
  }
}

export async function setPanelExpanded(expanded: boolean) {
  try {
    await invoke('set_panel_expanded', { expanded })
  } catch {
    return
  }
}

export async function exitAssistant() {
  try {
    await invoke('exit_app')
  } catch {
    window.close()
  }
}
