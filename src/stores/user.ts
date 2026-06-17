import { defineStore } from 'pinia'
import type { UserInfo } from '../types/api'
import { env } from '../utils/env'
import { storage } from '../utils/storage'

interface UserState {
  token: string
  userInfo: UserInfo | null
  clientId: string
}

export const useUserStore = defineStore('user', {
  state: (): UserState => ({
    token: storage.getToken() || env.mockToken,
    userInfo: {
      userId: env.mockUserId,
      userName: '刘美华',
      department: '信息技术部'
    },
    clientId: 'desktop_client_mock'
  }),
  actions: {
    setToken(token: string) {
      this.token = token
      storage.setToken(token)
    },
    clearSession() {
      this.token = ''
      this.userInfo = null
      storage.clearToken()
    }
  }
})

