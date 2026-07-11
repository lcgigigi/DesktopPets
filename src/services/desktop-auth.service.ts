import { getCurrent, onOpenUrl } from '@tauri-apps/plugin-deep-link'
import type { UnlistenFn } from '@tauri-apps/api/event'
import type { UserInfo } from '../types/api'
import { storage } from '../utils/storage'

export const DESKTOP_AUTH_SCHEME = 'huali-ai-mascot'
const AUTH_CALLBACK_HOST = 'auth-callback'

export interface DesktopAuthCallbackPayload {
  token: string
  userInfo: UserInfo
}

type AuthCallbackHandler = (payload: DesktopAuthCallbackPayload) => void

function createFallbackState() {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`
}

export function createDesktopAuthState() {
  const state = globalThis.crypto?.randomUUID?.() ?? createFallbackState()
  storage.setDesktopAuthState(state)
  return state
}

function isAuthCallbackUrl(url: URL) {
  return url.protocol === `${DESKTOP_AUTH_SCHEME}:` && url.hostname === AUTH_CALLBACK_HOST
}

function getParam(url: URL, key: string) {
  return url.searchParams.get(key)?.trim() || ''
}

export function parseDesktopAuthCallback(rawUrl: string): DesktopAuthCallbackPayload | null {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return null
  }

  if (!isAuthCallbackUrl(url)) return null

  const expectedState = storage.getDesktopAuthState()
  const state = getParam(url, 'state')
  if (!expectedState || state !== expectedState) return null

  const token = getParam(url, 'token')
  const userId = getParam(url, 'userId')
  if (!token || !userId) return null

  return {
    token,
    userInfo: {
      userId,
      userName: getParam(url, 'userName') || userId,
      department: getParam(url, 'department') || undefined
    }
  }
}

async function handleUrls(urls: string[] | null, handler: AuthCallbackHandler) {
  if (!urls) return

  urls.forEach((url) => {
    const payload = parseDesktopAuthCallback(url)
    if (payload) handler(payload)
  })
}

export async function listenDesktopAuthCallbacks(handler: AuthCallbackHandler): Promise<UnlistenFn | undefined> {
  try {
    await handleUrls(await getCurrent(), handler)
    return await onOpenUrl((urls) => {
      void handleUrls(urls, handler)
    })
  } catch (error) {
    console.warn('Desktop auth deep link listener failed', error)
    return undefined
  }
}
