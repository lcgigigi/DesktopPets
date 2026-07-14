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

type UnauthorizedListener = () => void
const unauthorizedListeners = new Set<UnauthorizedListener>()

function notifyUnauthorized(status?: number, code?: number) {
  if (status !== 401 && status !== 403 && code !== 401 && code !== 403) return
  unauthorizedListeners.forEach((listener) => listener())
}

function getBusinessMessage(response: BusinessResponse, fallback: string) {
  return response.msg || response.message || fallback
}

function buildRequestUrl(path: string, options: DesktopRequestOptions = {}) {
  const baseUrl = env.apiBaseUrl.trim().replace(/\/+$/, '')
  if (!baseUrl) throw new DesktopRequestError('未配置后台服务地址')

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

async function send<T>(
  method: 'GET' | 'POST',
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
    response = await nativeFetch(buildRequestUrl(path, options), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      connectTimeout: 12_000,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : '无法连接后台服务'
    throw new DesktopRequestError(message)
  }

  const result = await parseResponse(response)
  const code = typeof result?.code === 'number' ? result.code : undefined

  if (!response.ok || result?.success === false || (code !== undefined && code !== 200)) {
    notifyUnauthorized(response.status, code)
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
}

export function onDesktopUnauthorized(listener: UnauthorizedListener) {
  unauthorizedListeners.add(listener)
  return () => unauthorizedListeners.delete(listener)
}
