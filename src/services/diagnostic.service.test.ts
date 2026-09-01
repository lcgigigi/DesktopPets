import { beforeEach, describe, expect, it, vi } from 'vitest'

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}))

import {
  getDiagnosticCredentialMetadata,
  maskDiagnosticIdentifier,
  recordDesktopDiagnostic,
} from './diagnostic.service'

function toBase64Url(value: object) {
  return btoa(JSON.stringify(value))
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
}

describe('desktop diagnostics', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    invokeMock.mockResolvedValue(true)
  })

  it('masks user identifiers before they are logged', () => {
    expect(maskDiagnosticIdentifier('employee-123456')).toBe('em***56')
    expect(maskDiagnosticIdentifier('u001')).toBe('****')
    expect(maskDiagnosticIdentifier('')).toBe('')
  })

  it('sends complete caller-provided callback diagnostics to the native writer', async () => {
    recordDesktopDiagnostic('session.restore', {
      rawUrl: 'huali-ai-mascot://auth-callback?token=complete-token&state=complete-state',
      token: 'complete-token',
      state: 'complete-state',
      tokenPresent: true,
      tokenLength: 128,
      userId: 'employee-123456',
      userIdMasked: maskDiagnosticIdentifier('employee-123456'),
    })
    await Promise.resolve()

    expect(invokeMock).toHaveBeenCalledWith('record_desktop_diagnostic_event', {
      event: 'session.restore',
      fields: {
        rawUrl: 'huali-ai-mascot://auth-callback?token=complete-token&state=complete-state',
        token: 'complete-token',
        state: 'complete-state',
        tokenPresent: true,
        tokenLength: 128,
        userId: 'employee-123456',
        userIdMasked: 'em***56',
      },
    })
  })

  it('extracts only JWT lifetime metadata and never returns credential content', () => {
    const credential = [
      toBase64Url({ alg: 'none' }),
      toBase64Url({ sub: 'employee-123456', iat: 1_000, exp: 4_600 }),
      'signature-secret',
    ].join('.')

    const metadata = getDiagnosticCredentialMetadata(credential, 2_000_000)

    expect(metadata).toEqual({
      credentialFormat: 'jwt',
      credentialExpiryKnown: true,
      credentialExpired: false,
      credentialAgeSeconds: 1_000,
      credentialLifetimeSeconds: 3_600,
      credentialRemainingSeconds: 2_600,
    })
    expect(JSON.stringify(metadata)).not.toContain('employee-123456')
    expect(JSON.stringify(metadata)).not.toContain('signature-secret')
  })

  it('marks opaque and missing credentials without inspecting their content', () => {
    expect(getDiagnosticCredentialMetadata('opaque-secret')).toEqual({
      credentialFormat: 'opaque',
      credentialExpiryKnown: false,
    })
    expect(getDiagnosticCredentialMetadata('')).toEqual({
      credentialFormat: 'missing',
      credentialExpiryKnown: false,
    })
  })
})
