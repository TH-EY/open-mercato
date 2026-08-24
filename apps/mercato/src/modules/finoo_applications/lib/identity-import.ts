import type { AppContainer } from '@open-mercato/shared/lib/di/container'
import type { SanitizedFinooApplicationPayload } from '../data/validators'

export type FinooIdentityImportInput = {
  pesel: string
  documentType: 'identity_card' | 'passport' | 'digital_identity_card' | null
  issuingCountryCode: string | null
  documentNumber: string | null
  issuedOn: string | null
  expiresOn: string | null
}

export type FinooIdentityTechnicalImportPort = {
  createFromTechnicalImport(input: {
    tenantId: string
    organizationId: string
    personId: string
    sourceModule: 'finoo_applications'
    sourceRecordId: string
    input: FinooIdentityImportInput
  }): Promise<{
    status: 'created' | 'unchanged' | 'conflict'
    identityId: string
    isComplete: boolean
    conflictId?: string
  }>
}

function normalizedText(value: string | undefined): string | null {
  const normalized = value?.trim() ?? ''
  return normalized || null
}

export function buildFinooIdentityImportInput(payload: SanitizedFinooApplicationPayload): FinooIdentityImportInput {
  const documentType = payload.idType === 'IDCARD'
    ? 'identity_card'
    : payload.idType === 'PASSPORT'
      ? 'passport'
      : payload.idType === 'DIGITCARD'
        ? 'digital_identity_card'
        : null
  const documentNumber = payload.idType === 'PASSPORT'
    ? normalizedText(payload.passport)
    : payload.idType === 'DIGITCARD'
      ? normalizedText(payload.digitCard)
      : payload.idType === 'IDCARD'
        ? normalizedText(payload.idCard)
        : null
  const issuedOn = payload.idType === 'PASSPORT'
    ? normalizedText(payload.passportIssued)
    : payload.idType === 'DIGITCARD'
      ? normalizedText(payload.digitCardIssued)
      : payload.idType === 'IDCARD'
        ? normalizedText(payload.idCardIssued)
        : null
  const expiresOn = payload.idType === 'PASSPORT'
    ? normalizedText(payload.passportExpiry)
    : payload.idType === 'DIGITCARD'
      ? normalizedText(payload.digitCardExpiry)
      : payload.idType === 'IDCARD'
        ? normalizedText(payload.idCardExpiry)
        : null
  const country = normalizedText(payload.idType === 'PASSPORT'
    ? payload.passportCountryCode || payload.country
    : payload.country)
  return {
    pesel: payload.pesel?.replace(/\D/g, '') ?? '',
    documentType,
    issuingCountryCode: country?.toUpperCase() ?? null,
    documentNumber,
    issuedOn,
    expiresOn,
  }
}

export function resolveFinooIdentityTechnicalImportPort(container: AppContainer): FinooIdentityTechnicalImportPort {
  try {
    const candidate = container.resolve('finooIdentityTechnicalImport') as Partial<FinooIdentityTechnicalImportPort>
    if (typeof candidate?.createFromTechnicalImport === 'function') {
      return candidate as FinooIdentityTechnicalImportPort
    }
  } catch {
    throw new Error('identity_service_unavailable')
  }
  throw new Error('identity_service_unavailable')
}
