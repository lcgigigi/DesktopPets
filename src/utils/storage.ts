const TOKEN_KEY = 'huali_ai_desktop_token'
const USER_INFO_KEY = 'huali_ai_desktop_user_info'
const DESKTOP_AUTH_STATE_KEY = 'huali_ai_desktop_auth_state'
const LAST_SYS_MESSAGE_DETAIL_KEY = 'huali_ai_last_sys_message_detail'
const TODO_INPUT_DRAFT_KEY = 'huali_ai_todo_input_draft'

export interface StoredUserInfo {
  userId: string
  userName: string
  department?: string
}

export interface StoredDesktopAuthAttempt {
  state: string
  createdAt: number
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
  getDesktopAuthAttempt(): StoredDesktopAuthAttempt | null {
    const value = localStorage.getItem(DESKTOP_AUTH_STATE_KEY)
    if (!value) return null

    try {
      const attempt = JSON.parse(value) as Partial<StoredDesktopAuthAttempt>
      if (
        typeof attempt.state === 'string'
        && attempt.state
        && typeof attempt.createdAt === 'number'
        && Number.isFinite(attempt.createdAt)
      ) {
        return {
          state: attempt.state,
          createdAt: attempt.createdAt,
        }
      }
    } catch {
      // v1.0.45 and earlier stored only the raw state. Preserve that in-flight
      // browser confirmation across an upgrade, then migrate it to the timed
      // attempt format used by current releases.
      const migrated = {
        state: value,
        createdAt: Date.now(),
      }
      localStorage.setItem(DESKTOP_AUTH_STATE_KEY, JSON.stringify(migrated))
      return migrated
    }

    return null
  },
  getDesktopAuthState() {
    return this.getDesktopAuthAttempt()?.state || ''
  },
  setDesktopAuthState(state: string, createdAt = Date.now()) {
    localStorage.setItem(DESKTOP_AUTH_STATE_KEY, JSON.stringify({ state, createdAt }))
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
  },
  getTodoInputDraft() {
    return localStorage.getItem(TODO_INPUT_DRAFT_KEY) || ''
  },
  setTodoInputDraft(text: string) {
    if (text) {
      localStorage.setItem(TODO_INPUT_DRAFT_KEY, text)
    } else {
      localStorage.removeItem(TODO_INPUT_DRAFT_KEY)
    }
  }
}
