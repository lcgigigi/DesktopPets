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
  const userId = toText(user.userId)
  const userName = toText(user.userName)
  const resolvedUserId = userId || userName
  if (!resolvedUserId) return null

  return {
    userId: resolvedUserId,
    userName: toText(user.nickName) || userName || resolvedUserId,
    department: toText(user.department) || toText(user.deptName) || undefined,
  }
}

export async function validateDesktopSession(expectedUserId: string): Promise<DesktopSessionCheck> {
  try {
    const data = await request.get<unknown, CurrentUserPayload>('/getInfo')
    const currentUser = normalizeCurrentUser(data)
    const expected = expectedUserId.trim()
    // A successful /getInfo response proves the token is accepted. Different
    // backend deployments expose different identifiers (numeric userId,
    // employee number, or login name), so an identifier mismatch must not
    // immediately erase a freshly completed desktop login.
    if (!currentUser) return { status: 'unavailable' }

    return {
      status: 'valid',
      userInfo: {
        ...currentUser,
        // Keep the callback ID because it is the ID the Web login flow supplied
        // for the desktop notification channel.
        userId: expected || currentUser.userId,
      },
    }
  } catch (error) {
    if (
      error instanceof DesktopRequestError &&
      (error.status === 401 || error.code === 401)
    ) {
      return { status: 'unauthorized' }
    }

    return { status: 'unavailable' }
  }
}
