import { createHash } from 'node:crypto'
import { FINOO_CONSENT_REGISTRY, FINOO_CONSENT_REGISTRY_SOURCE, FINOO_CONSENT_REGISTRY_VERSION } from '../../lib/consents'
import { parseAndSanitizeFinooApplicationPayload } from '../validators'

const metadata = {
  messageId: 'message_1234567890123456',
  sourceTimestamp: 1_787_000_000,
  receivedAt: '2026-08-19T00:00:00.000Z',
  sourceIp: '192.0.2.10',
}

describe('FINOO application payload sanitization', () => {
  it('pins the ordered server registry to the reviewed source fingerprint', () => {
    expect(createHash('sha256').update(JSON.stringify(FINOO_CONSENT_REGISTRY)).digest('hex'))
      .toBe(FINOO_CONSENT_REGISTRY_SOURCE.registrySha256)
  })

  it('accepts the current consent registry, strips raw evidence/token and keeps only unknown names', () => {
    const parsed = parseAndSanitizeFinooApplicationPayload({
      leadId: 'lead_12345678',
      consentVersion: FINOO_CONSENT_REGISTRY_VERSION,
      przeszedl_caly_wniosek: 'Tak',
      companyName: 'Test company',
      companyNip: '1234567890',
      name: 'Jan',
      surname: 'Kowalski',
      pesel: '12345678901',
      acceptTerms: '1',
      contactConsent: '1',
      contactEmail: true,
      jdgConsent: {
        jdg1: {
          selected: '1',
          text: FINOO_CONSENT_REGISTRY.jdg1.content,
          timestamp: '1999-01-01T00:00:00.000Z',
          username: 'UNTRUSTED_NAME',
        },
      },
      kontomatikToken: 'TOKEN_CANARY',
      unexpectedSecret: 'SECRET_CANARY',
    }, metadata)

    expect(JSON.stringify(parsed)).not.toContain('TOKEN_CANARY')
    expect(JSON.stringify(parsed)).not.toContain('SECRET_CANARY')
    expect(JSON.stringify(parsed)).not.toContain('UNTRUSTED_NAME')
    expect(parsed.jdgConsent?.jdg1).toEqual({ selected: true })
    expect(parsed).toMatchObject({ contactConsent: true, contactEmail: true })
    expect(parsed.ingestionMeta).toMatchObject({
      receivedAt: metadata.receivedAt,
      sourceIp: metadata.sourceIp,
      unknownFieldNames: ['unexpectedSecret'],
      kontomatikTokenDiscarded: true,
    })
  })

  it('rejects consent text that does not match the signed registry version', () => {
    expect(() => parseAndSanitizeFinooApplicationPayload({
      leadId: 'lead_12345678',
      jdgConsent: { jdg1: { selected: true, text: 'changed text' } },
    }, metadata)).toThrow('consent_registry_mismatch')
  })

  it('accepts current clause decisions without caller-supplied legal text', () => {
    const parsed = parseAndSanitizeFinooApplicationPayload({
      leadId: 'lead_12345678',
      consentVersion: FINOO_CONSENT_REGISTRY_VERSION,
      legalConsent: { legal1: { selected: true }, legal2: { selected: false } },
    }, metadata)

    expect(parsed.legalConsent).toEqual({ legal1: { selected: true }, legal2: { selected: false } })
  })

  it('rejects superseded consent clause names instead of dropping a decision', () => {
    expect(() => parseAndSanitizeFinooApplicationPayload({
      leadId: 'lead_12345678',
      consentVersion: FINOO_CONSENT_REGISTRY_VERSION,
      jdgConsent: { jdg: { selected: true } },
    }, metadata)).toThrow()
  })

  it('rejects invalid final NIP and PESEL lengths', () => {
    expect(() => parseAndSanitizeFinooApplicationPayload({
      leadId: 'lead_12345678',
      consentVersion: FINOO_CONSENT_REGISTRY_VERSION,
      completed: true,
      companyName: 'Test company',
      companyNip: '123',
      name: 'Jan',
      surname: 'Kowalski',
      pesel: '123',
    }, metadata)).toThrow()
  })

  it('requires the current registry version for draft consent decisions', () => {
    expect(() => parseAndSanitizeFinooApplicationPayload({
      leadId: 'lead_12345678',
      acceptTerms: true,
    }, metadata)).toThrow()
  })

  it('enforces the 8 to 128 character lead ID boundary', () => {
    expect(() => parseAndSanitizeFinooApplicationPayload({ leadId: '1234567' }, metadata)).toThrow()
    expect(parseAndSanitizeFinooApplicationPayload({ leadId: '12345678' }, metadata).leadId).toBe('12345678')
    expect(parseAndSanitizeFinooApplicationPayload({ leadId: `a${'b'.repeat(127)}` }, metadata).leadId).toHaveLength(128)
    expect(() => parseAndSanitizeFinooApplicationPayload({ leadId: `a${'b'.repeat(128)}` }, metadata)).toThrow()
  })
})
