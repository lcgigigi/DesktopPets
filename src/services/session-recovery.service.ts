export const DESKTOP_UNAUTHORIZED_CONFIRMATIONS_REQUIRED = 2
export const DESKTOP_UNAUTHORIZED_CONFIRMATION_WINDOW_MS = 60 * 1000

export interface DesktopUnauthorizedEvidence {
  token: string
  confirmations: number
  firstConfirmedAt: number
  lastConfirmedAt: number
}

export interface DesktopUnauthorizedConfirmation {
  evidence: DesktopUnauthorizedEvidence
  shouldExpire: boolean
}

export function recordConfirmedDesktopUnauthorized(
  previous: DesktopUnauthorizedEvidence | undefined,
  token: string,
  now = Date.now(),
): DesktopUnauthorizedConfirmation {
  const continuesPreviousEvidence = Boolean(
    previous
    && previous.token === token
    && now >= previous.lastConfirmedAt
    && now - previous.firstConfirmedAt <= DESKTOP_UNAUTHORIZED_CONFIRMATION_WINDOW_MS,
  )

  const evidence: DesktopUnauthorizedEvidence = continuesPreviousEvidence && previous
    ? {
        ...previous,
        confirmations: previous.confirmations + 1,
        lastConfirmedAt: now,
      }
    : {
        token,
        confirmations: 1,
        firstConfirmedAt: now,
        lastConfirmedAt: now,
      }

  return {
    evidence,
    shouldExpire: evidence.confirmations >= DESKTOP_UNAUTHORIZED_CONFIRMATIONS_REQUIRED,
  }
}
