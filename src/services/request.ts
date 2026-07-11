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
        return Promise.reject(new Error(getBusinessMessage(result, '接口请求失败')))
      }

      if (typeof result.code === 'number' && result.code !== 200) {
        return Promise.reject(new Error(getBusinessMessage(result, '接口请求失败')))
      }
    }

    return (result?.data ?? result) as unknown as typeof response
  },
  (error) => {
    const message = error.response?.data?.msg || error.response?.data?.message || error.message || '接口请求失败'
    return Promise.reject(new Error(message))
  }
)
