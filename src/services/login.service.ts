import { DesktopRequestError, request } from './request'
import { loadDesktopCurrentUser } from './session.service'
import { storage } from '../utils/storage'
import type { DesktopLoginCredentials, DesktopLoginSession } from '../types/auth'

interface LoginResponse {
  token?: string
  accessToken?: string
}

export async function loginDesktop(
  credentials: DesktopLoginCredentials,
): Promise<DesktopLoginSession> {
  const username = credentials.username.trim()
  if (!username || !credentials.password) {
    throw new DesktopRequestError('请输入账号和密码')
  }

  const result = await request.post<unknown, LoginResponse>('/login', {
    username,
    password: credentials.password,
  })
  const token = result?.token?.trim() || result?.accessToken?.trim() || ''
  if (!token) throw new DesktopRequestError('登录成功，但后台未返回 token')

  storage.setToken(token)
  try {
    const userInfo = await loadDesktopCurrentUser()
    return { token, userInfo }
  } catch (error) {
    storage.clearToken()
    throw error
  }
}
