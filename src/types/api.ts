export interface ApiResponse<T> {
  code?: number
  message?: string
  data: T
}

export interface UserInfo {
  userId: string
  userName: string
  department?: string
}

