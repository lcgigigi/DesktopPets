import axios from 'axios'
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

type UnauthorizedListener = () => void
const unauthorizedListeners = new Set<UnauthorizedListener>()

function notifyUnauthorized(status?: number, code?: number) {
  if (status !== 401 && status !== 403 && code !== 401 && code !== 403) return
  unauthorizedListeners.forEach((listener) => listener())
}

function getBusinessMessage(response: BusinessResponse, fallback: string) {
  return response.msg || response.message || fallback
}

export const request = axios.create({
  baseURL: env.apiBaseUrl,
  timeout: 12000
})

request.interceptors.request.use((config) => {
  const token = storage.getToken() || env.mockToken
  if (token) {
    config.headers.Authorization = `Bearer ${token}`
  }
  return config
})

request.interceptors.response.use(
  (response) => {
    const result = response.data as BusinessResponse

    if (result && typeof result === 'object') {
      if (result.success === false) {
        const code = typeof result.code === 'number' ? result.code : undefined
        notifyUnauthorized(response.status, code)
        return Promise.reject(
          new DesktopRequestError(getBusinessMessage(result, '接口请求失败'), {
            status: response.status,
            code,
          }),
        )
      }

      if (typeof result.code === 'number' && result.code !== 200) {
        notifyUnauthorized(response.status, result.code)
        return Promise.reject(
          new DesktopRequestError(getBusinessMessage(result, '接口请求失败'), {
            status: response.status,
            code: result.code,
          }),
        )
      }
    }

    return (result?.data ?? result) as unknown as typeof response
  },
  (error) => {
    const message = error.response?.data?.msg || error.response?.data?.message || error.message || '接口请求失败'
    const status = error.response?.status
    const payload = error.response?.data as BusinessResponse | undefined
    const code = typeof payload?.code === 'number' ? payload.code : undefined
    notifyUnauthorized(status, code)
    return Promise.reject(new DesktopRequestError(message, { status, code }))
  }
)

export function onDesktopUnauthorized(listener: UnauthorizedListener) {
  unauthorizedListeners.add(listener)
  return () => unauthorizedListeners.delete(listener)
}
