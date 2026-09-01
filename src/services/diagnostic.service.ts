type DiagnosticValue = string | number | boolean | null
type DiagnosticFields = Record<string, DiagnosticValue>

export interface DiagnosticCredentialMetadata {
  credentialFormat: 'jwt' | 'opaque' | 'missing'
  credentialExpiryKnown: boolean
  credentialExpired?: boolean
  credentialAgeSeconds?: number
  credentialLifetimeSeconds?: number
  credentialRemainingSeconds?: number
}

function normalizeIdentifier(value: string) {
  const trimmed = value.trim()
  if (!trimmed) return ''
  if (trimmed.length <= 4) return '*'.repeat(trimmed.length)
  return `${trimmed.slice(0, 2)}***${trimmed.slice(-2)}`
}

export function maskDiagnosticIdentifier(value: string | null | undefined) {
  return normalizeIdentifier(value || '')
}

function decodeBase64UrlJson(value: string) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
  return JSON.parse(atob(padded)) as Record<string, unknown>
}

function toEpochSeconds(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined
}

/**
 * Reports only lifetime characteristics of a credential. No token bytes,
 * claims, subject, issuer or fingerprint leave this function.
 */
export function getDiagnosticCredentialMetadata(
  credential: string | null | undefined,
  now = Date.now(),
): DiagnosticCredentialMetadata {
  const token = credential?.trim() || ''
  if (!token) {
    return { credentialFormat: 'missing', credentialExpiryKnown: false }
  }

  const segments = token.split('.')
  if (segments.length !== 3) {
    return { credentialFormat: 'opaque', credentialExpiryKnown: false }
  }

  try {
    const payload = decodeBase64UrlJson(segments[1])
    const issuedAt = toEpochSeconds(payload.iat)
    const expiresAt = toEpochSeconds(payload.exp)
    if (!expiresAt) {
      return { credentialFormat: 'jwt', credentialExpiryKnown: false }
    }

    const nowSeconds = Math.floor(now / 1000)
    return {
      credentialFormat: 'jwt',
      credentialExpiryKnown: true,
      credentialExpired: expiresAt <= nowSeconds,
      ...(issuedAt ? { credentialAgeSeconds: Math.max(0, nowSeconds - issuedAt) } : {}),
      ...(issuedAt && expiresAt >= issuedAt
        ? { credentialLifetimeSeconds: expiresAt - issuedAt }
        : {}),
      credentialRemainingSeconds: expiresAt - nowSeconds,
    }
  } catch {
    return { credentialFormat: 'opaque', credentialExpiryKnown: false }
  }
}

/**
 * The P0 diagnostic build used this stable call site across renderer modules.
 * Formal releases intentionally keep it as a no-op so no user-local diagnostic
 * file can be recreated while the surrounding business instrumentation is
 * removed independently from product behavior.
 */
export function recordDesktopDiagnostic(_event: string, _fields: DiagnosticFields = {}) {
  // Intentionally disabled in formal releases.
}
