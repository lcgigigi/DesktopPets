import { invoke } from '@tauri-apps/api/core'

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
 * Writes one structured diagnostic event through the native process. The
 * native command applies a second redaction boundary before persisting JSONL.
 * Callers must still pass field presence/length instead of token values.
 */
export function recordDesktopDiagnostic(event: string, fields: DiagnosticFields = {}) {
  try {
    void invoke<boolean>('record_desktop_diagnostic_event', { event, fields }).catch(() => false)
  } catch {
    // Browser previews and isolated unit tests do not host Tauri IPC.
  }
}
