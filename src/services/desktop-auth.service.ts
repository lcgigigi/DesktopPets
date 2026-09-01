import { getCurrent, onOpenUrl } from '@tauri-apps/plugin-deep-link'
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type { UserInfo } from '../types/api'
import { storage } from '../utils/storage'
import { maskDiagnosticIdentifier, recordDesktopDiagnostic } from './diagnostic.service'

export const DESKTOP_AUTH_SCHEME = 'huali-ai-mascot'
const AUTH_CALLBACK_HOST = 'auth-callback'
export const DESKTOP_AUTH_ATTEMPT_MAX_AGE = 30 * 60 * 1000

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

interface DesktopReleaseSmokeConfig {
  authState: string
}

type DesktopAuthCallbackParseResult =
  | { status: 'success'; payload: DesktopAuthCallbackPayload }
  | { status: 'error'; error: DesktopAuthCallbackError }
  | { status: 'ignored' }

function recordRendererSmokeReceipt(rawUrl: string, result: DesktopAuthCallbackParseResult) {
  if (result.status === 'ignored') return

  try {
    const url = new URL(rawUrl)
    if (!url.searchParams.get('smokeNonce')) return
    const outcome = result.status === 'success'
      ? 'success'
      : `error:${result.error}`
    void invoke<boolean>('record_desktop_auth_renderer_receipt', {
      callbackUrl: rawUrl,
      outcome,
    }).catch(() => undefined)
  } catch {
    // Only a valid callback URL can reach the native receipt command.
  }
}

function createFallbackState() {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`
}

function createDesktopAuthState(now = Date.now()) {
  const state = globalThis.crypto?.randomUUID?.() ?? createFallbackState()
  storage.setDesktopAuthState(state, now)
  return state
}

export function getOrCreateDesktopAuthState(now = Date.now()) {
  const attempt = storage.getDesktopAuthAttempt()
  if (
    attempt
    && attempt.createdAt <= now
    && now - attempt.createdAt < DESKTOP_AUTH_ATTEMPT_MAX_AGE
  ) {
    return attempt.state
  }

  return createDesktopAuthState(now)
}

function isAuthCallbackUrl(url: URL) {
  // Windows may preserve the registered protocol target's host casing when it
  // launches a non-special URL. URL normalizes the scheme, but not reliably
  // the hostname for custom schemes, so compare both components according to
  // the case-insensitive protocol identity accepted by the native shell.
  return url.protocol.toLowerCase() === `${DESKTOP_AUTH_SCHEME}:`
    && url.hostname.toLowerCase() === AUTH_CALLBACK_HOST
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
  source: 'deep-link' | 'event' | 'startup' | 'native-poll',
) {
  if (!urls) return

  urls.forEach((url) => {
    if (handledUrls.has(url)) return

    const result = parseDesktopAuthCallbackResult(url)
    let parsedUrl: URL | undefined
    try {
      parsedUrl = new URL(url)
    } catch {
      parsedUrl = undefined
    }
    recordDesktopDiagnostic('auth.callback.renderer_parsed', {
      source,
      outcome: result.status === 'error' ? `error:${result.error}` : result.status,
      hasState: Boolean(parsedUrl?.searchParams.get('state')),
      hasToken: Boolean(parsedUrl?.searchParams.get('token')),
      hasUserId: Boolean(parsedUrl?.searchParams.get('userId')),
      userIdMasked: maskDiagnosticIdentifier(parsedUrl?.searchParams.get('userId')),
    })
    // Ignore unrelated or malformed URLs without consuming them forever. The
    // native queue and deep-link plugin intentionally provide redundant
    // delivery paths; only a recognized auth callback may be deduplicated.
    if (result.status === 'ignored') return
    handledUrls.add(url)
    if (result.status === 'success') {
      handler(result.payload)
    } else if (result.status === 'error') {
      onError?.(result.error)
    }
    // A success receipt is written only after the session callback has returned.
    // This closes the old gate's gap where URL parsing passed but the Pinia/local
    // storage session had not yet been committed.
    recordRendererSmokeReceipt(url, result)
  })
}

export async function prepareDesktopReleaseSmokeState() {
  try {
    const config = await invoke<DesktopReleaseSmokeConfig | null>('get_desktop_release_smoke_config')
    if (!config?.authState) return false
    storage.setDesktopAuthState(config.authState)
    recordDesktopDiagnostic('release_smoke.auth_state_prepared', {
      statePresent: true,
    })
    return true
  } catch {
    return false
  }
}

export function recordDesktopReleaseSmokeSession(
  sessionCommitted: boolean,
  subscriptionsStarted: boolean,
  reminderTypesQueued: number,
) {
  void invoke<boolean>('record_desktop_release_smoke_session', {
    sessionCommitted,
    subscriptionsStarted,
    reminderTypesQueued,
  }).catch(() => false)
}

export function recordDesktopReleaseSmokeRestart(sessionRestored: boolean) {
  void invoke<boolean>('record_desktop_release_smoke_restart', {
    sessionRestored,
  }).catch(() => false)
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
        await handleUrls([callback.callbackUrl], handler, onError, handledUrls, 'native-poll')
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
      void handleUrls(urls, handler, onError, handledUrls, 'deep-link')
    }))
  } catch (error) {
    console.warn('Desktop auth deep link listener failed', error)
  }

  try {
    unlisteners.push(await listen<string>('desktop-auth-callback', (event) => {
      void handleUrls([event.payload], handler, onError, handledUrls, 'event')
    }))
  } catch (error) {
    console.warn('Desktop auth native callback listener failed', error)
  }

  try {
    await handleUrls(await getCurrent(), handler, onError, handledUrls, 'startup')
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
