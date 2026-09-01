import { getCurrent, onOpenUrl } from '@tauri-apps/plugin-deep-link'
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type { UserInfo } from '../types/api'
import { storage } from '../utils/storage'
import { recordDesktopDiagnostic } from './diagnostic.service'

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

interface RecognizedDesktopAuthCallback {
  canonicalUrl: string
  searchParams: URLSearchParams
}

function recognizeDesktopAuthCallback(rawUrl: string): RecognizedDesktopAuthCallback | null {
  const expectedCallback = `${DESKTOP_AUTH_SCHEME}://${AUTH_CALLBACK_HOST}`
  const candidate = rawUrl.trim()
  const prefix = candidate.slice(0, expectedCallback.length)
  if (prefix.toLowerCase() !== expectedCallback.toLowerCase()) return null

  let suffix = candidate.slice(expectedCallback.length)
  if (suffix.startsWith('/')) {
    // The Web confirmation page serializes this non-special URL with one
    // trailing slash on some browser engines. Accept only that exact
    // authority terminator; a second slash or a real path remains invalid.
    if (suffix.length > 1 && suffix[1] !== '?' && suffix[1] !== '#') return null
    suffix = suffix.slice(1)
  } else if (suffix && suffix[0] !== '?' && suffix[0] !== '#') {
    return null
  }

  const queryStart = suffix.indexOf('?')
  const fragmentStart = suffix.indexOf('#')
  const hasQuery = queryStart >= 0 && (fragmentStart < 0 || queryStart < fragmentStart)
  const rawQuery = hasQuery
    ? suffix.slice(queryStart + 1, fragmentStart >= 0 ? fragmentStart : undefined)
    : ''

  return {
    canonicalUrl: `${expectedCallback}${suffix}`,
    searchParams: new URLSearchParams(rawQuery),
  }
}

function recordRendererSmokeReceipt(rawUrl: string, result: DesktopAuthCallbackParseResult) {
  if (result.status === 'ignored') return

  const callback = recognizeDesktopAuthCallback(rawUrl)
  if (!callback?.searchParams.get('smokeNonce')) return
  const outcome = result.status === 'success'
    ? 'success'
    : `error:${result.error}`
  void invoke<boolean>('record_desktop_auth_renderer_receipt', {
    callbackUrl: rawUrl,
    outcome,
  }).catch(() => undefined)
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

function getParam(callback: RecognizedDesktopAuthCallback, key: string) {
  return callback.searchParams.get(key)?.trim() || ''
}

export function getDesktopAuthCallbackDiagnosticFields(
  rawUrl: string,
  source: 'deep-link' | 'event' | 'startup' | 'native-poll',
  outcome: string,
  duplicate: boolean,
) {
  const expectedCallback = `${DESKTOP_AUTH_SCHEME}://${AUTH_CALLBACK_HOST}`
  const attempt = storage.getDesktopAuthAttempt()
  const expectedState = attempt?.state || ''
  let parsedUrl: URL | undefined
  let parseError = ''
  try {
    parsedUrl = new URL(rawUrl)
  } catch (error) {
    parseError = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  }

  const receivedState = parsedUrl?.searchParams.get('state') ?? ''
  const token = parsedUrl?.searchParams.get('token') ?? ''
  const userId = parsedUrl?.searchParams.get('userId') ?? ''
  const recognizedCallback = recognizeDesktopAuthCallback(rawUrl)

  return {
    source,
    outcome,
    duplicate,
    rawUrl,
    rawUrlLength: rawUrl.length,
    expectedCallback,
    callbackPrefixMatches: rawUrl.slice(0, expectedCallback.length).toLowerCase()
      === expectedCallback.toLowerCase(),
    callbackPrefixBoundary: rawUrl.slice(expectedCallback.length, expectedCallback.length + 1),
    parseSucceeded: Boolean(parsedUrl),
    parseError,
    rawIdentityMatches: Boolean(recognizedCallback),
    canonicalUrl: recognizedCallback?.canonicalUrl ?? '',
    normalizedUrl: parsedUrl?.href ?? '',
    origin: parsedUrl?.origin ?? '',
    protocol: parsedUrl?.protocol ?? '',
    username: parsedUrl?.username ?? '',
    password: parsedUrl?.password ?? '',
    host: parsedUrl?.host ?? '',
    hostname: parsedUrl?.hostname ?? '',
    port: parsedUrl?.port ?? '',
    pathname: parsedUrl?.pathname ?? '',
    search: parsedUrl?.search ?? '',
    hash: parsedUrl?.hash ?? '',
    searchParamsJson: parsedUrl
      ? JSON.stringify(Array.from(parsedUrl.searchParams.entries()))
      : '',
    expectedProtocol: `${DESKTOP_AUTH_SCHEME}:`,
    expectedHostname: AUTH_CALLBACK_HOST,
    protocolMatches: parsedUrl
      ? parsedUrl.protocol.toLowerCase() === `${DESKTOP_AUTH_SCHEME}:`
      : false,
    hostnameMatches: parsedUrl
      ? parsedUrl.hostname.toLowerCase() === AUTH_CALLBACK_HOST
      : false,
    expectedState,
    receivedState,
    stateMatches: Boolean(expectedState && receivedState && expectedState === receivedState),
    authAttemptCreatedAt: attempt?.createdAt ?? 0,
    authAttemptAgeMs: attempt ? Math.max(0, Date.now() - attempt.createdAt) : -1,
    token,
    userId,
    userName: parsedUrl?.searchParams.get('userName') ?? '',
    department: parsedUrl?.searchParams.get('department') ?? '',
  }
}

function parseDesktopAuthCallbackResult(rawUrl: string): DesktopAuthCallbackParseResult {
  const callback = recognizeDesktopAuthCallback(rawUrl)
  if (!callback) return { status: 'ignored' }

  const expectedState = storage.getDesktopAuthState()
  const state = getParam(callback, 'state')
  if (!expectedState || !state || state !== expectedState) {
    return { status: 'error', error: 'expired' }
  }

  const token = getParam(callback, 'token')
  const userId = getParam(callback, 'userId')
  if (!token || !userId) {
    return { status: 'error', error: 'missing-identity' }
  }

  return {
    status: 'success',
    payload: {
      token,
      userInfo: {
        userId,
        userName: getParam(callback, 'userName') || userId,
        department: getParam(callback, 'department') || undefined
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
    if (handledUrls.has(url)) {
      recordDesktopDiagnostic('auth.callback.renderer_parsed',
        getDesktopAuthCallbackDiagnosticFields(url, source, 'duplicate', true))
      return
    }

    const result = parseDesktopAuthCallbackResult(url)
    recordDesktopDiagnostic('auth.callback.renderer_parsed', getDesktopAuthCallbackDiagnosticFields(
      url,
      source,
      result.status === 'error' ? `error:${result.error}` : result.status,
      false,
    ))
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
