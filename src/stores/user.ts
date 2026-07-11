import { defineStore } from 'pinia'
import type { UserInfo } from '../types/api'
import { env } from '../utils/env'
import { storage } from '../utils/storage'

interface UserState {
  token: string
  userInfo: UserInfo | null
  clientId: string
}

const LEGACY_MOCK_TOKEN = 'mock_desktop_token'
const LEGACY_MOCK_USER_ID = 'u001'

function getInitialSession() {
  const token = storage.getToken() || env.mockToken
  const userInfo =
    storage.getUserInfo() ??
    (env.desktopUserId || env.mockUserId
      ? {
          userId: env.desktopUserId || env.mockUserId,
          userName: '刘美华',
          department: '信息技术部'
        }
      : null)

  if (!env.enableMock && (token === LEGACY_MOCK_TOKEN || userInfo?.userId === LEGACY_MOCK_USER_ID)) {
    storage.clearToken()
    storage.clearUserInfo()
    storage.clearDesktopAuthState()

    return {
      token: '',
      userInfo: null
    }
  }

  return {
    token,
    userInfo
  }
}

export const useUserStore = defineStore('user', {
  state: (): UserState => {
    const session = getInitialSession()

    return {
      token: session.token,
      userInfo: session.userInfo,
      clientId: 'desktop_client_mock'
    }
  },
  getters: {
    isAuthenticated: (state) => Boolean(state.token && state.userInfo?.userId)
  },
  actions: {
    setToken(token: string) {
      this.token = token
      storage.setToken(token)
    },
    setSession(params: { token: string; userInfo: UserInfo }) {
      this.token = params.token
      this.userInfo = params.userInfo
      storage.setToken(params.token)
      storage.setUserInfo(params.userInfo)
      storage.clearDesktopAuthState()
    },
    clearSession() {
      this.token = ''
      this.userInfo = null
      storage.clearToken()
      storage.clearUserInfo()
      storage.clearDesktopAuthState()
    }
  }
})
