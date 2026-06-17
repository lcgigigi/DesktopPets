import { openUrl } from '@tauri-apps/plugin-opener'
import { invoke } from '@tauri-apps/api/core'
import { env } from '../utils/env'

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
    todoDraftId: options.draftId,
    desktopTodoText: options.todoText
  })
  return openExternal(buildUrl(`/workbench${query}`))
}

export function openCalendar(taskId?: string) {
  const query = taskId ? `?taskId=${encodeURIComponent(taskId)}` : ''
  return openExternal(buildUrl(`/calendar${query}`))
}

export function openAgents() {
  return openExternal(buildUrl('/agents'))
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

export async function syncPanelWindow() {
  try {
    await invoke('sync_panel_window')
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
