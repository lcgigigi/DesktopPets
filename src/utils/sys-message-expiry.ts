export const SYS_MESSAGE_EXPIRY_MS = 30 * 60 * 1000

function parseSysMessageTime(rawValue?: string) {
  const raw = rawValue?.trim()
  if (!raw) return undefined

  const parsed = new Date(raw.replace(' ', 'T')).getTime()
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * A reminder never outlives either its server creation time or 30 minutes in
 * this desktop session. The arrival fallback keeps malformed/missing backend
 * timestamps useful without allowing a card to remain forever.
 */
export function resolveSysMessageExpiresAt(createTime?: string, receivedAt = Date.now()) {
  const safeReceivedAt = Number.isFinite(receivedAt) ? receivedAt : Date.now()
  const arrivalExpiry = safeReceivedAt + SYS_MESSAGE_EXPIRY_MS
  const createdAt = parseSysMessageTime(createTime)

  return createdAt === undefined
    ? arrivalExpiry
    : Math.min(createdAt + SYS_MESSAGE_EXPIRY_MS, arrivalExpiry)
}

export function isSysMessageExpired(expiresAt: number, now = Date.now()) {
  return !Number.isFinite(expiresAt) || expiresAt <= now
}
