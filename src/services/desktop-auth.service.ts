import { getCurrent, onOpenUrl } from '@tauri-apps/plugin-deep-link'
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type { UserInfo } from '../types/api'
import { storage } from '../utils/storage'

export const DESKTOP_AUTH_SCHEME = 'huali-ai-mascot'
const AUTH_CALLBACK_HOST = 'auth-callback'

export interface DesktopAuthCallbackPayload {
  token: string
  userInfo: UserInfo
}

type AuthCallbackHandler = (payload: DesktopAuthCallbackPayload) => void
export type DesktopAuthCallbackError = 'expired' | 'missing-identity' | 'missing-callback-url'
type AuthCallbackErrorHandler = (error: DesktopAuthCallbackError) => void

interface NativeDesktopAuthCallback {
  callbackUrl?: string | null
  argumentCount: number
}

type DesktopAuthCallbackParseResult =
  | { status: 'success'; payload: DesktopAuthCallbackPayload }
  | { status: 'error'; error: DesktopAuthCallbackError }
  | { status: 'ignored' }

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

function parseDesktopAuthCallbackResult(rawUrl: string): DesktopAuthCallbackParseResult {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return { status: 'ignored' }
  }

  if (!isAuthCallbackUrl(url)) return { status: 'ignored' }

  const expectedState = storage.getDesktopAuthState()
  const state = getParam(url, 'state')
  if (!expectedState || !state || state !== expectedState) {
    return { status: 'error', error: 'expired' }
  }

  const token = getParam(url, 'token')
  const userId = getParam(url, 'userId')
  if (!token || !userId) {
    return { status: 'error', error: 'missing-identity' }
  }

  return {
    status: 'success',
    payload: {
      token,
      userInfo: {
        userId,
        userName: getParam(url, 'userName') || userId,
        department: getParam(url, 'department') || undefined
      }
    },
  }
}

export function parseDesktopAuthCallback(rawUrl: string): DesktopAuthCallbackPayload | null {
  const result = parseDesktopAuthCallbackResult(rawUrl)
  return result.status === 'success' ? result.payload : null
}

async function handleUrls(
  urls: string[] | null,
  handler: AuthCallbackHandler,
  onError: AuthCallbackErrorHandler | undefined,
  handledUrls: Set<string>,
) {
  if (!urls) return

  urls.forEach((url) => {
    if (handledUrls.has(url)) return
    handledUrls.add(url)

    const result = parseDesktopAuthCallbackResult(url)
    if (result.status === 'success') {
      handler(result.payload)
    } else if (result.status === 'error') {
      onError?.(result.error)
    }
  })
}

export async function listenDesktopAuthCallbacks(
  handler: AuthCallbackHandler,
  onError?: AuthCallbackErrorHandler,
): Promise<UnlistenFn | undefined> {
  const handledUrls = new Set<string>()
  const unlisteners: UnlistenFn[] = []
  let nativeCallbackPollTimer: number | undefined

  async function pollNativeCallback() {
    try {
      const callback = await invoke<NativeDesktopAuthCallback | null>('take_desktop_auth_callback')
      if (!callback) return

      if (callback.callbackUrl) {
        await handleUrls([callback.callbackUrl], handler, onError, handledUrls)
      } else if (callback.argumentCount > 1) {
        onError?.('missing-callback-url')
      }
    } catch (error) {
      console.warn('Desktop auth native callback poll failed', error)
      window.clearInterval(nativeCallbackPollTimer)
      nativeCallbackPollTimer = undefined
    }
  }

  try {
    unlisteners.push(await onOpenUrl((urls) => {
      void handleUrls(urls, handler, onError, handledUrls)
    }))
  } catch (error) {
    console.warn('Desktop auth deep link listener failed', error)
  }

  try {
    unlisteners.push(await listen<string>('desktop-auth-callback', (event) => {
      void handleUrls([event.payload], handler, onError, handledUrls)
    }))
  } catch (error) {
    console.warn('Desktop auth native callback listener failed', error)
  }

  try {
    await handleUrls(await getCurrent(), handler, onError, handledUrls)
  } catch (error) {
    console.warn('Desktop auth startup callback failed', error)
  }

  void pollNativeCallback()
  nativeCallbackPollTimer = window.setInterval(() => {
    void pollNativeCallback()
  }, 750)

  return () => {
    window.clearInterval(nativeCallbackPollTimer)
    unlisteners.forEach((unlisten) => {
      unlisten()
    })
  }
}
