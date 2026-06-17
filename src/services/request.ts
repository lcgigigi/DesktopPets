import axios from 'axios'
import { env } from '../utils/env'
import { storage } from '../utils/storage'

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
  (response) => response.data?.data ?? response.data,
  (error) => {
    const message = error.response?.data?.message || error.message || '接口请求失败'
    return Promise.reject(new Error(message))
  }
)

