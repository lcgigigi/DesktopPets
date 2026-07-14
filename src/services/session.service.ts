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

interface NormalizedCurrentUser {
  userInfo: UserInfo
  identifiers: string[]
}

function toText(value: unknown) {
  return value === null || value === undefined ? '' : String(value).trim()
}

function normalizeCurrentUser(data: CurrentUserPayload): NormalizedCurrentUser | null {
  const user = data.user ?? data
  const userId = toText(user.userId)
  const userName = toText(user.userName)
  const resolvedUserId = userId || userName
  const identifiers = [userId, userName].filter(Boolean)
  if (!resolvedUserId) return null

  return {
    userInfo: {
      userId: resolvedUserId,
      userName: toText(user.nickName) || userName || resolvedUserId,
      department: toText(user.department) || toText(user.deptName) || undefined,
    },
    identifiers,
  }
}

export async function loadDesktopCurrentUser(): Promise<UserInfo> {
  const data = await request.get<unknown, CurrentUserPayload>('/getInfo')
  const currentUser = normalizeCurrentUser(data)
  if (!currentUser) throw new DesktopRequestError('后台未返回有效用户信息')
  return currentUser.userInfo
}

export async function validateDesktopSession(expectedUserId: string): Promise<DesktopSessionCheck> {
  try {
    const data = await request.get<unknown, CurrentUserPayload>('/getInfo')
    const currentUser = normalizeCurrentUser(data)
    if (!currentUser) throw new DesktopRequestError('后台未返回有效用户信息')

    const { userInfo, identifiers } = currentUser
    const expected = expectedUserId.trim()
    if (expected && !identifiers.includes(expected)) return { status: 'unauthorized' }

    return {
      status: 'valid',
      userInfo: {
        ...userInfo,
        userId: expected || userInfo.userId,
      },
    }
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
