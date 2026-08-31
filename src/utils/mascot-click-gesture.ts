export const MASCOT_DOUBLE_CLICK_MIN_INTERVAL_MS = 60
export const MASCOT_DOUBLE_CLICK_MAX_INTERVAL_MS = 320
export const MASCOT_DOUBLE_CLICK_DISTANCE_PX = 10

export interface MascotCompletedClick {
  pressedAt: number
  screenX: number
  screenY: number
  pointerType: string
}

export type MascotClickContinuation = 'double' | 'duplicate' | 'separate'

export function classifyMascotClickContinuation(
  previous: MascotCompletedClick,
  current: MascotCompletedClick,
): MascotClickContinuation {
  const interval = current.pressedAt - previous.pressedAt
  const distance = Math.hypot(
    current.screenX - previous.screenX,
    current.screenY - previous.screenY,
  )
  const samePointerType = current.pointerType === previous.pointerType
  const sameClickArea = distance <= MASCOT_DOUBLE_CLICK_DISTANCE_PX

  if (!samePointerType || !sameClickArea || interval < 0) return 'separate'
  if (interval < MASCOT_DOUBLE_CLICK_MIN_INTERVAL_MS) return 'duplicate'
  if (interval <= MASCOT_DOUBLE_CLICK_MAX_INTERVAL_MS) return 'double'
  return 'separate'
}
