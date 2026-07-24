import { isTauri } from '@tauri-apps/api/core'
import { fetch as nativeFetch } from '@tauri-apps/plugin-http'
import { env } from '../utils/env'
import { storage } from '../utils/storage'

interface BusinessResponse<T = unknown> {
  code?: number
  success?: boolean
  msg?: string
  message?: string
  data?: T
}

export class DesktopRequestError extends Error {
  status?: number
  code?: number

  constructor(message: string, options: { status?: number; code?: number } = {}) {
    super(message)
    this.name = 'DesktopRequestError'
    this.status = options.status
    this.code = options.code
  }
}

interface DesktopRequestOptions {
  params?: Record<string, string | number | boolean | null | undefined>
}

export interface DesktopUnauthorizedContext {
  token: string
}

type UnauthorizedListener = (context: DesktopUnauthorizedContext) => void
type DesktopRequestMethod = 'GET' | 'POST' | 'PUT'

const unauthorizedListeners = new Set<UnauthorizedListener>()
const REQUEST_TIMEOUT = 12_000

function notifyUnauthorized(token: string, status?: number, code?: number) {
  // 401 means the token is no longer accepted. A 403 can instead mean this
  // user lacks one optional desktop permission, so it must not erase an
  // otherwise valid login.
  if (status !== 401 && code !== 401) return
  unauthorizedListeners.forEach((listener) => listener({ token }))
}

function getBusinessMessage(response: BusinessResponse, fallback: string) {
  return response.msg || response.message || fallback
}

function buildRequestUrl(path: string, options: DesktopRequestOptions = {}) {
  const configuredBaseUrl = env.apiBaseUrl.trim().replace(/\/+$/, '')
  const baseUrl = configuredBaseUrl || window.location.origin
  const url = new URL(`${baseUrl}/${path.replace(/^\/+/, '')}`)

  Object.entries(options.params ?? {}).forEach(([key, value]) => {
    if (value !== null && value !== undefined) url.searchParams.set(key, String(value))
  })
  return url.toString()
}

async function parseResponse(response: Response) {
  const text = await response.text()
  if (!text) return undefined

  try {
    return JSON.parse(text) as BusinessResponse
  } catch {
    throw new DesktopRequestError('后台返回了无法识别的内容', { status: response.status })
  }
}

async function performFetch(url: string, init: RequestInit) {
  if (isTauri()) {
    // Tauri's Rust HTTP client is not subject to WebView2 CORS restrictions.
    // This is required when the packaged app talks to the company intranet API.
    return nativeFetch(url, { ...init, connectTimeout: REQUEST_TIMEOUT })
  }

  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT)
  try {
    return await window.fetch(url, { ...init, signal: controller.signal })
  } finally {
    window.clearTimeout(timeout)
  }
}

async function send<T>(
  method: DesktopRequestMethod,
  path: string,
  body?: unknown,
  options: DesktopRequestOptions = {},
): Promise<T> {
  const headers = new Headers({ Accept: 'application/json' })
  const token = storage.getToken() || env.mockToken
  if (token) headers.set('Authorization', `Bearer ${token}`)
  if (body !== undefined) headers.set('Content-Type', 'application/json')

  let response: Response
  try {
    response = await performFetch(buildRequestUrl(path, options), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch (error) {
    const message = error instanceof Error && error.name === 'AbortError'
      ? '连接后台服务超时'
      : error instanceof Error
        ? error.message
        : '无法连接后台服务'
    throw new DesktopRequestError(message)
  }

  const result = await parseResponse(response)
  const code = typeof result?.code === 'number' ? result.code : undefined

  if (!response.ok || result?.success === false || (code !== undefined && code !== 200)) {
    notifyUnauthorized(token, response.status, code)
    throw new DesktopRequestError(
      getBusinessMessage(result ?? {}, response.ok ? '接口请求失败' : `请求失败（${response.status}）`),
      { status: response.status, code },
    )
  }

  return (result?.data ?? result) as T
}

export const request = {
  get<_Request = unknown, ResponseData = unknown>(path: string, options?: DesktopRequestOptions) {
    return send<ResponseData>('GET', path, undefined, options)
  },
  post<_Request = unknown, ResponseData = unknown>(
    path: string,
    body?: unknown,
    options?: DesktopRequestOptions,
  ) {
    return send<ResponseData>('POST', path, body, options)
  },
  put<_Request = unknown, ResponseData = unknown>(
    path: string,
    body?: unknown,
    options?: DesktopRequestOptions,
  ) {
    return send<ResponseData>('PUT', path, body, options)
  },
}

export function onDesktopUnauthorized(listener: UnauthorizedListener) {
  unauthorizedListeners.add(listener)
  return () => unauthorizedListeners.delete(listener)
}
