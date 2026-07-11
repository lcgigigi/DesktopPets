import { DesktopRequestError, request } from './request'
import type { UserInfo } from '../types/api'

interface CurrentUserPayload {
  user?: {
    userId?: string | number
    userName?: string
    nickName?: string
    deptName?: string
    department?: string
  }
  userId?: string | number
  userName?: string
  nickName?: string
  deptName?: string
  department?: string
}

export type DesktopSessionCheck =
  | { status: 'valid'; userInfo: UserInfo }
  | { status: 'unauthorized' }
  | { status: 'unavailable' }

function toText(value: unknown) {
  return value === null || value === undefined ? '' : String(value).trim()
}

function normalizeCurrentUser(data: CurrentUserPayload): UserInfo | null {
  const user = data.user ?? data
  const userId = toText(user.userName) || toText(user.userId)
  if (!userId) return null

  return {
    userId,
    userName: toText(user.nickName) || toText(user.userName) || userId,
    department: toText(user.department) || toText(user.deptName) || undefined,
  }
}

export async function validateDesktopSession(expectedUserId: string): Promise<DesktopSessionCheck> {
  try {
    const data = await request.get<unknown, CurrentUserPayload>('/getInfo')
    const userInfo = normalizeCurrentUser(data)
    if (!userInfo || userInfo.userId !== expectedUserId.trim()) return { status: 'unauthorized' }

    return { status: 'valid', userInfo }
  } catch (error) {
    if (
      error instanceof DesktopRequestError &&
      (error.status === 401 || error.status === 403 || error.code === 401 || error.code === 403)
    ) {
      return { status: 'unauthorized' }
    }

    return { status: 'unavailable' }
  }
}
