import type { UserInfo } from './api'

export interface DesktopLoginCredentials {
  username: string
  password: string
}

export interface DesktopLoginSession {
  token: string
  userInfo: UserInfo
}
