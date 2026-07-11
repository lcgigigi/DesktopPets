const TOKEN_KEY = 'huali_ai_desktop_token'
const USER_INFO_KEY = 'huali_ai_desktop_user_info'
const DESKTOP_AUTH_STATE_KEY = 'huali_ai_desktop_auth_state'
const LAST_SYS_MESSAGE_DETAIL_KEY = 'huali_ai_last_sys_message_detail'

export interface StoredUserInfo {
  userId: string
  userName: string
  department?: string
}

export interface LastSysMessageDetail {
  messageId: string
  detailId: string
  bizType?: number
}

export const storage = {
  getToken() {
    return localStorage.getItem(TOKEN_KEY)
  },
  setToken(token: string) {
    localStorage.setItem(TOKEN_KEY, token)
  },
  clearToken() {
    localStorage.removeItem(TOKEN_KEY)
  },
  getUserInfo(): StoredUserInfo | null {
    const value = localStorage.getItem(USER_INFO_KEY)
    if (!value) return null

    try {
      const userInfo = JSON.parse(value) as StoredUserInfo
      return userInfo.userId ? userInfo : null
    } catch {
      return null
    }
  },
  setUserInfo(userInfo: StoredUserInfo) {
    localStorage.setItem(USER_INFO_KEY, JSON.stringify(userInfo))
  },
  clearUserInfo() {
    localStorage.removeItem(USER_INFO_KEY)
  },
  getDesktopAuthState() {
    return localStorage.getItem(DESKTOP_AUTH_STATE_KEY) || ''
  },
  setDesktopAuthState(state: string) {
    localStorage.setItem(DESKTOP_AUTH_STATE_KEY, state)
  },
  clearDesktopAuthState() {
    localStorage.removeItem(DESKTOP_AUTH_STATE_KEY)
  },
  setLastSysMessageDetail(detail: LastSysMessageDetail) {
    localStorage.setItem(LAST_SYS_MESSAGE_DETAIL_KEY, JSON.stringify(detail))
  },
  getLastSysMessageDetail(): LastSysMessageDetail | null {
    const value = localStorage.getItem(LAST_SYS_MESSAGE_DETAIL_KEY)
    if (!value) return null

    try {
      return JSON.parse(value) as LastSysMessageDetail
    } catch {
      return null
    }
  }
}
