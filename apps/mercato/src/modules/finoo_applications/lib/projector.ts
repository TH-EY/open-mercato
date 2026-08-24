import { createHash, randomUUID } from 'node:crypto'
import type { EntityManager } from '@mikro-orm/postgresql'
import { sql, type Kysely } from 'kysely'
import type { CommandBus } from '@open-mercato/shared/lib/commands'
import type { AppContainer } from '@open-mercato/shared/lib/di/container'
import type { TenantDataEncryptionService } from '@open-mercato/shared/lib/encryption/tenantDataEncryptionService'
import { hashForLookup } from '@open-mercato/shared/lib/encryption/aes'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { CustomFieldDef } from '@open-mercato/core/modules/entities/data/entities'
import { CustomerDeal, CustomerEntity, CustomerPipeline, CustomerPipelineStage } from '@open-mercato/core/modules/customers/data/entities'
import { DictionaryEntry } from '@open-mercato/core/modules/dictionaries/data/entities'
import { normalizeDictionaryValue } from '@open-mercato/core/modules/dictionaries/lib/utils'
import { FinooApplicationConsentEvidence, FinooApplicationIdentityBinding, FinooApplicationIntake, FinooApplicationProjection, type FinooApplicationProjectionState } from '../data/entities'
import { isValidPesel, type SanitizedFinooApplicationPayload } from '../data/validators'
import { FINOO_CONSENT_REGISTRY, FINOO_CONSENT_REGISTRY_VERSION } from './consents'
import { buildFinooIdentityImportInput, resolveFinooIdentityTechnicalImportPort } from './identity-import'
import { hasConfiguredLookupHashPepper } from './security'
import {
  FINOO_APPLICATION_NON_IDENTITY_SENSITIVE_FIELD_SPECS,
  FINOO_APPLICATION_REQUIRED_ENCRYPTION_MAPS,
} from './sensitive-fields'

type Scope = { tenantId: string; organizationId: string }
type OptionalAffiliateService = { findActiveLinkByCodeInScope?: (code: string, scope: Scope) => Promise<unknown | null> }

function normalizeDigits(value: string | undefined): string | null {
  const normalized = value?.replace(/\D/g, '') ?? ''
  return normalized || null
}

function normalizeEmail(value: string | undefined): string | null {
  const normalized = value?.trim().toLowerCase() ?? ''
  return normalized || null
}

function normalizePhone(prefix: string | undefined, value: string | undefined): string | null {
  const trimmed = value?.trim() ?? ''
  if (!trimmed) return null
  if (trimmed.startsWith('+')) return `+${trimmed.slice(1).replace(/\D/g, '')}`
  if (trimmed.startsWith('00')) return `+${trimmed.slice(2).replace(/\D/g, '')}`
  const prefixDigits = prefix?.replace(/\D/g, '') ?? ''
  const valueDigits = trimmed.replace(/\D/g, '')
  return prefixDigits ? `+${prefixDigits}${valueDigits}` : valueDigits
}

function projectionSource(projectionId: string): string {
  return `finoo_application:${projectionId}`
}

function deriveState(payload: SanitizedFinooApplicationPayload): FinooApplicationProjectionState {
  const completed = payload.completed ?? payload.przeszedl_caly_wniosek === 'Tak'
  if (completed && payload.disqualified) return 'disqualified'
  return completed ? 'completed' : 'draft'
}

function targetStage(state: FinooApplicationProjectionState): string {
  if (state === 'completed') return 'Submitted'
  if (state === 'disqualified') return 'Closed'
  return 'Created'
}

function commandContext(container: AppContainer, scope: Scope) {
  return {
    container,
    auth: { tenantId: scope.tenantId } as never,
    organizationScope: null,
    selectedOrganizationId: scope.organizationId,
    organizationIds: [scope.organizationId],
    systemActor: true,
  }
}

export async function requireSensitiveFieldsEncrypted(
  em: EntityManager,
  encryption: TenantDataEncryptionService,
  scope: Scope,
): Promise<void> {
  for (const requirement of FINOO_APPLICATION_REQUIRED_ENCRYPTION_MAPS) {
    const encryptedFields = await encryption.getEncryptedFieldNames(requirement.entityId, scope.tenantId, scope.organizationId)
    if (!requirement.fields.every((field) => encryptedFields.includes(field))) {
      throw new Error('core_field_encryption_required')
    }
  }
  const defs = await em.find(CustomFieldDef, {
    ...scope,
    $or: FINOO_APPLICATION_NON_IDENTITY_SENSITIVE_FIELD_SPECS.map(({ entityId, key, kind }) => ({ entityId, key, kind })),
    deletedAt: null,
    isActive: true,
  })
  if (defs.length !== FINOO_APPLICATION_NON_IDENTITY_SENSITIVE_FIELD_SPECS.length) {
    throw new Error('sensitive_field_definition_missing')
  }
  for (const spec of FINOO_APPLICATION_NON_IDENTITY_SENSITIVE_FIELD_SPECS) {
    const def = defs.find((candidate) => candidate.entityId === spec.entityId && candidate.key === spec.key && candidate.kind === spec.kind)
    if (!def?.configJson || (def.configJson as Record<string, unknown>).encrypted !== true) {
      throw new Error('sensitive_field_encryption_required')
    }
  }
}

async function getOrCreateProjection(em: EntityManager, intake: FinooApplicationIntake, state: FinooApplicationProjectionState): Promise<FinooApplicationProjection> {
  const scope = { tenantId: intake.tenantId, organizationId: intake.organizationId }
  let projection = await findOneWithDecryption(em, FinooApplicationProjection, { ...scope, externalLeadId: intake.externalLeadId }, undefined, scope)
  if (!projection) {
    projection = em.create(FinooApplicationProjection, { ...scope, externalLeadId: intake.externalLeadId, state })
    await em.persist(projection).flush()
  }
  return projection
}

async function bindIdentity(
  em: EntityManager,
  scope: Scope,
  projection: FinooApplicationProjection,
  kind: 'nip' | 'pesel' | 'email',
  raw: string,
): Promise<FinooApplicationIdentityBinding> {
  const identityHash = hashForLookup(raw, `finoo_application:${scope.tenantId}:${scope.organizationId}:${kind}`)
  let binding = await findOneWithDecryption(em, FinooApplicationIdentityBinding, { ...scope, identityKind: kind, identityHash }, undefined, scope)
  if (binding) return binding
  binding = em.create(FinooApplicationIdentityBinding, {
    ...scope,
    projectionId: projection.id,
    identityKind: kind,
    identityHash,
    reservedEntityId: randomUUID(),
  })
  await em.persist(binding).flush()
  return binding
}

async function resolvePipeline(em: EntityManager, scope: Scope, state: FinooApplicationProjectionState): Promise<{ pipelineId: string; stageId: string }> {
  const pipeline = await findOneWithDecryption(em, CustomerPipeline, { ...scope, name: 'Web Form Sales Pipeline' }, undefined, scope)
  if (!pipeline) throw new Error('pipeline_missing')
  const stage = await findOneWithDecryption(em, CustomerPipelineStage, { ...scope, pipelineId: pipeline.id, label: targetStage(state) }, undefined, scope)
  if (!stage) throw new Error('pipeline_stage_missing')
  return { pipelineId: pipeline.id, stageId: stage.id }
}

async function resolveDictionaryEntryId(
  em: EntityManager,
  scope: Scope,
  entityId: string,
  key: string,
  value: string,
): Promise<string> {
  const definition = await findOneWithDecryption(em, CustomFieldDef, {
    ...scope,
    entityId,
    key,
    kind: 'dictionary',
    isActive: true,
    deletedAt: null,
  }, undefined, scope)
  const dictionaryId = definition?.configJson && typeof definition.configJson === 'object'
    ? (definition.configJson as Record<string, unknown>).dictionaryId
    : null
  if (typeof dictionaryId !== 'string' || !dictionaryId) throw new Error(`dictionary_definition_missing_${key}`)
  const entry = await findOneWithDecryption(em, DictionaryEntry, {
    ...scope,
    dictionary: dictionaryId,
    normalizedValue: normalizeDictionaryValue(value),
  }, undefined, scope)
  if (!entry) throw new Error(`dictionary_entry_missing_${key}`)
  return entry.id
}

function companyCustomFields(payload: SanitizedFinooApplicationPayload, nip: string, companyTypeEntryId?: string): Record<string, unknown> {
  return {
    tax_number: nip,
    ...(companyTypeEntryId ? { company_type: companyTypeEntryId } : {}),
    ...(payload.businessStartDate ? { business_start_date: payload.businessStartDate } : {}),
  }
}

function consentFields(payload: SanitizedFinooApplicationPayload): Record<string, unknown> {
  const acceptedAt = payload.ingestionMeta.receivedAt
  const source = 'finoo.pl/apply'
  const group = (
    prefix: string,
    accepted: boolean | undefined,
    registryEntries: Array<{ code: string; content: string }>,
  ) => accepted === undefined ? {} : {
    [`${prefix}_accepted`]: accepted,
    [`${prefix}_accepted_at`]: acceptedAt,
    [`${prefix}_source`]: source,
    [`${prefix}_consent_code`]: registryEntries.map(({ code }) => code).join(','),
    [`${prefix}_content`]: registryEntries.map(({ content }) => content).join('\n\n'),
  }
  const aggregateClauses = (clauses: Record<string, { selected: boolean } | undefined> | undefined) => {
    const decisions = clauses ? Object.values(clauses).filter((clause): clause is { selected: boolean } => clause !== undefined) : []
    return decisions.length > 0 ? decisions.every((clause) => clause.selected) : undefined
  }
  const jdgAccepted = aggregateClauses(payload.jdgConsent)
  const legalAccepted = aggregateClauses(payload.legalConsent)
  const sharingDecisions = [payload.emailConsent2, payload.smsConsent2, payload.telefonConsent2]
  const sharingAccepted = sharingDecisions.some((decision) => decision !== undefined)
    ? sharingDecisions.some(Boolean)
    : undefined
  return {
    ...group('tc_consent', payload.acceptTerms, [FINOO_CONSENT_REGISTRY.acceptTerms]),
    ...group('email_consent', payload.emailConsent, [FINOO_CONSENT_REGISTRY.emailConsent]),
    ...group('sms_consent', payload.smsConsent, [FINOO_CONSENT_REGISTRY.smsConsent]),
    ...group('phone_consent', payload.telefonConsent, [FINOO_CONSENT_REGISTRY.phoneConsent]),
    ...group('data_sharing_consent', sharingAccepted, [
      FINOO_CONSENT_REGISTRY.dataSharingEmail,
      FINOO_CONSENT_REGISTRY.dataSharingSms,
      FINOO_CONSENT_REGISTRY.dataSharingPhone,
    ]),
    ...group('jdg_consent', jdgAccepted, [FINOO_CONSENT_REGISTRY.jdg1, FINOO_CONSENT_REGISTRY.jdg2, FINOO_CONSENT_REGISTRY.jdg3]),
    ...group('legal_consent', legalAccepted, [FINOO_CONSENT_REGISTRY.legal1, FINOO_CONSENT_REGISTRY.legal2]),
    ...group('nova_lend_property_community_consent', payload['NovaLend-propertyCommunity'], [FINOO_CONSENT_REGISTRY.propertyCommunity]),
  }
}

async function recordConsentEvidence(
  em: EntityManager,
  scope: Scope,
  intake: FinooApplicationIntake,
  projection: FinooApplicationProjection,
  payload: SanitizedFinooApplicationPayload,
): Promise<void> {
  if (payload.consentVersion !== FINOO_CONSENT_REGISTRY_VERSION) return
  const decisions: Array<[keyof typeof FINOO_CONSENT_REGISTRY, boolean | undefined]> = [
    ['acceptTerms', payload.acceptTerms],
    ['contactConsent', payload.contactConsent],
    ['contactEmail', payload.contactEmail],
    ['contactSms', payload.contactSms],
    ['contactPhone', payload.contactPhone],
    ['emailConsent', payload.emailConsent],
    ['smsConsent', payload.smsConsent],
    ['phoneConsent', payload.telefonConsent],
    ['dataSharingEmail', payload.emailConsent2],
    ['dataSharingSms', payload.smsConsent2],
    ['dataSharingPhone', payload.telefonConsent2],
    ['jdg1', payload.jdgConsent?.jdg1?.selected],
    ['jdg2', payload.jdgConsent?.jdg2?.selected],
    ['jdg3', payload.jdgConsent?.jdg3?.selected],
    ['legal1', payload.legalConsent?.legal1?.selected],
    ['legal2', payload.legalConsent?.legal2?.selected],
    ['propertyCommunity', payload['NovaLend-propertyCommunity']],
  ]
  const acceptedAt = new Date(payload.ingestionMeta.receivedAt)
  const transportSourceIpDigest = payload.ingestionMeta.sourceIp
    ? hashForLookup(payload.ingestionMeta.sourceIp, `finoo_application_consent_ip:${scope.tenantId}:${scope.organizationId}`)
    : null
  for (const [consentKey, accepted] of decisions) {
    if (accepted === undefined) continue
    const existing = await findOneWithDecryption(em, FinooApplicationConsentEvidence, {
      ...scope,
      intakeId: intake.id,
      consentKey,
    }, undefined, scope)
    if (existing) continue
    const registry = FINOO_CONSENT_REGISTRY[consentKey]
    const evidenceDigest = hashForLookup(JSON.stringify({
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      externalLeadId: intake.externalLeadId,
      intakeId: intake.id,
      consentKey,
      registryVersion: FINOO_CONSENT_REGISTRY_VERSION,
      registryCode: registry.code,
      contentDigest: createHash('sha256').update(registry.content).digest('hex'),
      accepted,
      acceptedAt: payload.ingestionMeta.receivedAt,
      transportSourceIpDigest,
    }), `finoo_application_consent:${scope.tenantId}:${scope.organizationId}`)
    em.persist(em.create(FinooApplicationConsentEvidence, {
      ...scope,
      intakeId: intake.id,
      projectionId: projection.id,
      consentKey,
      registryVersion: FINOO_CONSENT_REGISTRY_VERSION,
      registryCode: registry.code,
      accepted,
      acceptedAt,
      transportSourceIpDigest,
      evidenceDigest,
    }))
  }
  await em.flush()
}

function personCustomFields(
  payload: SanitizedFinooApplicationPayload,
  dictionaries: { jobPositionEntryId?: string },
): Record<string, unknown> {
  const mobile = normalizePhone(payload.mobilePrefix, payload.mobile)
  return {
    ...(mobile ? { mobile } : {}),
    ...(dictionaries.jobPositionEntryId ? { job_position: dictionaries.jobPositionEntryId } : {}),
    ...consentFields(payload),
  }
}

function dealCustomFields(
  payload: SanitizedFinooApplicationPayload,
  state: FinooApplicationProjectionState,
  history: Array<Record<string, unknown>>,
): Record<string, unknown> {
  return {
    external_id: payload.leadId,
    form_complete: state !== 'draft',
    ...(payload.earnings ? { earnings: Number(payload.earnings.replace(/\D/g, '')) } : {}),
    ...(payload.arrearsUsZus !== undefined ? { arrears: payload.arrearsUsZus } : {}),
    ...(payload.amount ? { amount: Number(payload.amount.replace(/\D/g, '')) } : {}),
    ...(payload.months ? { months: Number(payload.months.replace(/\D/g, '')) } : {}),
    ...(payload.affiliate_code ? { affiliate_code: payload.affiliate_code } : {}),
    ...(payload.traffic_source ? { traffic_source: payload.traffic_source } : {}),
    ...(payload.utm_source ? { utm_source: payload.utm_source } : {}),
    ...(payload.utm_medium ? { utm_medium: payload.utm_medium } : {}),
    ...(payload.utm_campaign ? { utm_campaign: payload.utm_campaign } : {}),
    ...(payload.utm_term ? { utm_term: payload.utm_term } : {}),
    ...(payload.utm_content ? { utm_content: payload.utm_content } : {}),
    ...(payload.first_utm_source ? { first_utm_source: payload.first_utm_source } : {}),
    ...(payload.first_utm_medium ? { first_utm_medium: payload.first_utm_medium } : {}),
    ...(payload.first_utm_campaign ? { first_utm_campaign: payload.first_utm_campaign } : {}),
    ...(payload.gclid ? { gclid: payload.gclid } : {}),
    ...(payload.fbclid ? { fbclid: payload.fbclid } : {}),
    ...(payload.msclkid ? { msclkid: payload.msclkid } : {}),
    ...(payload.landingPage ? { landing_page: payload.landingPage } : {}),
    ...(payload.initialReferrer ? { initial_referrer: payload.initialReferrer } : {}),
    ...(payload.lastReferrer ? { last_referrer: payload.lastReferrer } : {}),
    ...(payload.session_started_at ? { session_started_at: payload.session_started_at } : {}),
    ...(payload.first_touch_at ? { first_touch_at: payload.first_touch_at } : {}),
    ...(payload.last_touch_at ? { last_touch_at: payload.last_touch_at } : {}),
    ...(payload.disqualification_message ? { nova_lend_status_reason: payload.disqualification_message } : {}),
    submission_history: JSON.stringify(history),
  }
}

async function projectFinooApplicationUnlocked(
  em: EntityManager,
  commandBus: CommandBus,
  container: AppContainer,
  intake: FinooApplicationIntake,
): Promise<FinooApplicationProjection> {
  const scope = { tenantId: intake.tenantId, organizationId: intake.organizationId }
  if (!hasConfiguredLookupHashPepper()) {
    throw new Error('lookup_hash_pepper_required')
  }
  const encryption = container.resolve('tenantEncryptionService') as TenantDataEncryptionService
  if (!encryption.isEnabled() || !Boolean((await encryption.getDek(scope.tenantId))?.key)) {
    throw new Error('tenant_encryption_unavailable')
  }
  await requireSensitiveFieldsEncrypted(em, encryption, scope)
  const payload = intake.payloadJson
  if (!payload) throw new Error('intake_payload_missing')
  const incomingState = deriveState(payload)
  const projection = await getOrCreateProjection(em, intake, incomingState)
  await recordConsentEvidence(em, scope, intake, projection, payload)
  if (projection.lastSourceTimestamp && projection.lastSourceTimestamp > intake.sourceTimestamp) {
    projection.warningsJson = [...new Set([...projection.warningsJson, 'stale_submission_ignored'])].slice(-50)
    await em.flush()
    return projection
  }
  if (projection.state !== 'draft' && incomingState === 'draft') {
    projection.warningsJson = [...new Set([...projection.warningsJson, 'terminal_draft_ignored'])].slice(-50)
    await em.flush()
    return projection
  }
  if (projection.state !== 'draft' && projection.state !== incomingState) {
    projection.warningsJson = [...new Set([...projection.warningsJson, 'terminal_state_conflict'])].slice(-50)
    await em.flush()
    return projection
  }
  const state = projection.state === 'draft' ? incomingState : projection.state
  const nip = normalizeDigits(payload.companyNip || payload.nip)
  const pesel = normalizeDigits(payload.pesel)
  const email = normalizeEmail(payload.email)
  if (!nip || nip.length !== 10 || !pesel || !isValidPesel(pesel) || !payload.companyName || !payload.name || !payload.surname) {
    projection.warningsJson = [...new Set([...projection.warningsJson, 'insufficient_draft_data'])].slice(-50)
    projection.lastIntakeId = intake.id
    projection.lastSourceTimestamp = intake.sourceTimestamp
    await em.flush()
    return projection
  }

  const context = commandContext(container, scope)
  const ownedSource = projectionSource(projection.id)
  const primaryPhone = normalizePhone(payload.mobilePrefix, payload.mobile) || normalizePhone(payload.phonePrefix, payload.phone)
  const companyTypeEntryId = payload.businessType
    ? await resolveDictionaryEntryId(
      em,
      scope,
      'customers:customer_company_profile',
      'company_type',
      payload.businessType === 'jdg' ? 'sole_trader' : 'private_limited_company',
    )
    : undefined
  const applicantDictionaries = {
    ...(payload.position ? {
      jobPositionEntryId: await resolveDictionaryEntryId(
        em,
        scope,
        'customers:customer_person_profile',
        'job_position',
        payload.position,
      ),
    } : {}),
  }
  if (payload.affiliate_code) {
    let affiliateService: OptionalAffiliateService | null = null
    try {
      affiliateService = container.resolve('finooAffiliateService') as OptionalAffiliateService
    } catch {
      projection.warningsJson = [...new Set([...projection.warningsJson, 'affiliate_module_unavailable'])].slice(-50)
    }
    if (affiliateService && typeof affiliateService.findActiveLinkByCodeInScope !== 'function') {
      projection.warningsJson = [...new Set([...projection.warningsJson, 'affiliate_scope_lookup_unavailable'])].slice(-50)
    } else if (affiliateService && !await affiliateService.findActiveLinkByCodeInScope!(payload.affiliate_code, scope)) {
      projection.warningsJson = [...new Set([...projection.warningsJson, 'unknown_affiliate_code'])].slice(-50)
    }
  }
  const companyBinding = await bindIdentity(em, scope, projection, 'nip', nip)
  const companyBindingOwned = companyBinding.projectionId === projection.id
  let companyCreated = false
  let companyEntity = projection.companyEntityId
    ? await findOneWithDecryption(em, CustomerEntity, { ...scope, id: projection.companyEntityId, kind: 'company', deletedAt: null }, undefined, scope)
    : null
  if (projection.companyEntityId && !companyEntity) throw new Error('company_projection_missing')
  if (!projection.companyEntityId) {
    if (companyBinding.customerEntityId) {
      companyEntity = await findOneWithDecryption(em, CustomerEntity, { ...scope, id: companyBinding.customerEntityId, kind: 'company', deletedAt: null }, undefined, scope)
      if (!companyEntity) throw new Error('company_identity_conflict')
      projection.companyEntityId = companyEntity.id
    } else {
      if (!companyBindingOwned) {
        projection.warningsJson = [...new Set([...projection.warningsJson, 'company_identity_requires_review'])].slice(-50)
        projection.lastIntakeId = intake.id
        projection.lastSourceTimestamp = intake.sourceTimestamp
        projection.lastErrorCode = 'company_identity_requires_review'
        await em.flush()
        return projection
      }
      companyEntity = await findOneWithDecryption(em, CustomerEntity, { ...scope, id: companyBinding.reservedEntityId, kind: 'company', deletedAt: null }, undefined, scope)
      if (!companyEntity) {
        const created = await commandBus.execute<Record<string, unknown>, { entityId: string }>('customers.companies.create', {
          input: { ...scope, systemEntityId: companyBinding.reservedEntityId, systemProfileId: randomUUID(), displayName: payload.companyName, legalName: payload.companyName, source: ownedSource, customFields: companyCustomFields(payload, nip, companyTypeEntryId) }, ctx: context,
        })
        projection.companyEntityId = created.result.entityId
        companyCreated = true
        companyEntity = await findOneWithDecryption(em, CustomerEntity, { ...scope, id: projection.companyEntityId, kind: 'company', deletedAt: null }, undefined, scope)
      } else {
        projection.companyEntityId = companyEntity.id
      }
    }
    await em.flush()
  }
  const companyObjectOwned = companyEntity?.source === ownedSource
  if (companyObjectOwned && companyBindingOwned) {
    if (companyBinding.customerEntityId && companyBinding.customerEntityId !== projection.companyEntityId) {
      throw new Error('company_identity_conflict')
    }
    if (!companyCreated) {
      await commandBus.execute('customers.companies.update', { input: { id: projection.companyEntityId, ...scope, displayName: payload.companyName, legalName: payload.companyName, customFields: companyCustomFields(payload, nip, companyTypeEntryId) }, ctx: context })
    }
    companyBinding.customerEntityId = projection.companyEntityId
    await em.flush()
  } else if (!companyObjectOwned) {
    projection.warningsJson = [...new Set([...projection.warningsJson, 'existing_company_requires_review'])].slice(-50)
    await em.flush()
  } else {
    projection.warningsJson = [...new Set([...projection.warningsJson, 'company_identity_requires_review'])].slice(-50)
    await em.flush()
  }

  const applicantBinding = await bindIdentity(em, scope, projection, 'pesel', pesel)
  const emailBinding = email
    ? await bindIdentity(em, scope, projection, 'email', email)
    : applicantBinding
  const applicantOwned = applicantBinding.projectionId === projection.id
    && emailBinding.projectionId === projection.id
  if (!applicantOwned) {
    projection.warningsJson = [...new Set([...projection.warningsJson, 'existing_person_requires_review'])].slice(-50)
    projection.lastIntakeId = intake.id
    projection.lastSourceTimestamp = intake.sourceTimestamp
    projection.lastErrorCode = 'applicant_identity_requires_review'
    await em.flush()
    return projection
  }
  let applicantEntity = projection.applicantEntityId
    ? await findOneWithDecryption(em, CustomerEntity, { ...scope, id: projection.applicantEntityId, kind: 'person', deletedAt: null }, undefined, scope)
    : null
  if (projection.applicantEntityId && !applicantEntity) throw new Error('applicant_projection_missing')
  let applicantCreated = false
  if (!projection.applicantEntityId) {
    applicantEntity = applicantBinding.customerEntityId
      ? await findOneWithDecryption(em, CustomerEntity, { ...scope, id: applicantBinding.customerEntityId, kind: 'person', deletedAt: null }, undefined, scope)
      : await findOneWithDecryption(em, CustomerEntity, { ...scope, id: applicantBinding.reservedEntityId, kind: 'person', deletedAt: null }, undefined, scope)
    if (!applicantEntity) {
      const created = await commandBus.execute<Record<string, unknown>, { entityId: string }>('customers.people.create', {
        input: { ...scope, systemEntityId: applicantBinding.reservedEntityId, systemProfileId: randomUUID(), firstName: payload.name, lastName: payload.surname, primaryEmail: email, primaryPhone, companyEntityId: projection.companyEntityId, source: ownedSource, customFields: personCustomFields(payload, applicantDictionaries) }, ctx: context,
      })
      projection.applicantEntityId = created.result.entityId
      applicantCreated = true
      applicantEntity = await findOneWithDecryption(em, CustomerEntity, { ...scope, id: projection.applicantEntityId, kind: 'person', deletedAt: null }, undefined, scope)
    } else {
      projection.applicantEntityId = applicantEntity.id
    }
    await em.flush()
  }
  if (applicantEntity?.source !== ownedSource) {
    projection.warningsJson = [...new Set([...projection.warningsJson, 'existing_person_requires_review'])].slice(-50)
    projection.lastIntakeId = intake.id
    projection.lastSourceTimestamp = intake.sourceTimestamp
    projection.lastErrorCode = 'applicant_identity_requires_review'
    await em.flush()
    return projection
  }
  {
    if (applicantBinding.customerEntityId && applicantBinding.customerEntityId !== projection.applicantEntityId) {
      throw new Error('applicant_identity_conflict')
    }
    if (emailBinding.customerEntityId && emailBinding.customerEntityId !== projection.applicantEntityId) {
      throw new Error('applicant_identity_conflict')
    }
    if (!applicantCreated) {
      await commandBus.execute('customers.people.update', {
        input: {
          id: projection.applicantEntityId,
          ...scope,
          firstName: payload.name,
          lastName: payload.surname,
          primaryEmail: email,
          primaryPhone,
          companyEntityId: projection.companyEntityId,
          customFields: personCustomFields(payload, applicantDictionaries),
        },
        ctx: context,
      })
    }
    applicantBinding.customerEntityId = projection.applicantEntityId
    emailBinding.customerEntityId = projection.applicantEntityId
    await em.flush()
  }

  const identityService = resolveFinooIdentityTechnicalImportPort(container)
  const identityImport = await identityService.createFromTechnicalImport({
    ...scope,
    personId: projection.applicantEntityId,
    sourceModule: 'finoo_applications',
    sourceRecordId: intake.id,
    input: buildFinooIdentityImportInput(payload),
  })
  if (identityImport.status === 'conflict') {
    projection.warningsJson = [...new Set([...projection.warningsJson, 'identity_import_conflict'])].slice(-50)
    await em.flush()
  }

  const representativeEntityIds: string[] = []
  for (const representative of payload.representatives ?? []) {
    const representativeEmail = normalizeEmail(representative.email)
    if (!representativeEmail || representativeEmail === email) continue
    const binding = await bindIdentity(em, scope, projection, 'email', representativeEmail)
    const owned = binding.projectionId === projection.id
    if (!owned) {
      projection.warningsJson = [...new Set([...projection.warningsJson, 'representative_identity_requires_review'])].slice(-50)
      continue
    }
    let personId = binding.customerEntityId ?? null
    let representativeCreated = false
    let representativeEntity = personId
      ? await findOneWithDecryption(em, CustomerEntity, { ...scope, id: personId, kind: 'person', deletedAt: null }, undefined, scope)
      : null
    if (!personId) {
      representativeEntity = await findOneWithDecryption(em, CustomerEntity, { ...scope, id: binding.reservedEntityId, kind: 'person', deletedAt: null }, undefined, scope)
      if (representativeEntity) personId = representativeEntity.id
      else {
        const created = await commandBus.execute<Record<string, unknown>, { entityId: string }>('customers.people.create', {
          input: { ...scope, systemEntityId: binding.reservedEntityId, systemProfileId: randomUUID(), firstName: representative.firstname, lastName: representative.lastname, primaryEmail: representativeEmail, companyEntityId: projection.companyEntityId, source: ownedSource }, ctx: context,
        })
        personId = created.result.entityId
        representativeCreated = true
        representativeEntity = await findOneWithDecryption(em, CustomerEntity, { ...scope, id: personId, kind: 'person', deletedAt: null }, undefined, scope)
      }
    }
    if (representativeEntity?.source !== ownedSource) {
      projection.warningsJson = [...new Set([...projection.warningsJson, 'representative_identity_requires_review'])].slice(-50)
      continue
    }
    if (!representativeCreated) {
      await commandBus.execute('customers.people.update', { input: { id: personId, ...scope, firstName: representative.firstname, lastName: representative.lastname, primaryEmail: representativeEmail, companyEntityId: projection.companyEntityId }, ctx: context })
    }
    if (!personId) throw new Error('representative_projection_failed')
    binding.customerEntityId = personId
    await em.flush()
    if (personId !== projection.applicantEntityId) representativeEntityIds.push(personId)
  }

  const pipeline = await resolvePipeline(em, scope, state)
  if (!projection.submissionHistoryJson.some((entry) => entry.intakeId === intake.id)) {
    projection.submissionHistoryJson = [...projection.submissionHistoryJson, {
      intakeId: intake.id,
      state,
      acceptedAt: payload.ingestionMeta.receivedAt,
      disqualificationDigest: payload.disqualification_message
        ? createHash('sha256').update(payload.disqualification_message).digest('hex')
        : null,
      kontomatikCompleted: payload.kontomatikCompleted ?? false,
    }].slice(-50)
    await em.flush()
  }
  const valueAmount = payload.amount ? Number(String(payload.amount).replace(',', '.').replace(/[^0-9.]/g, '')) : undefined
  if (!projection.dealId) {
    const dealId = randomUUID()
    projection.dealId = dealId
    await em.flush()
    const existing = await findOneWithDecryption(em, CustomerDeal, { ...scope, id: dealId }, undefined, scope)
    if (existing) projection.dealId = existing.id
    else {
      const created = await commandBus.execute<Record<string, unknown>, { dealId: string }>('customers.deals.create', {
        input: { ...scope, systemDealId: dealId, title: payload.companyName, description: payload.reason, status: state === 'disqualified' ? 'closed' : 'open', pipelineId: pipeline.pipelineId, pipelineStageId: pipeline.stageId, valueAmount: Number.isFinite(valueAmount) ? valueAmount : undefined, valueCurrency: 'PLN', companyIds: [projection.companyEntityId], personIds: [projection.applicantEntityId, ...representativeEntityIds], primaryPersonEntityId: projection.applicantEntityId, source: `finoo_application:${projection.id}`, customFields: dealCustomFields(payload, state, projection.submissionHistoryJson) }, ctx: context,
      })
      projection.dealId = created.result.dealId
    }
  } else {
    const existing = await findOneWithDecryption(em, CustomerDeal, { ...scope, id: projection.dealId }, undefined, scope)
    if (existing) {
      await commandBus.execute('customers.deals.update', {
        input: { id: projection.dealId, ...scope, title: payload.companyName, description: payload.reason, status: state === 'disqualified' ? 'closed' : 'open', pipelineId: pipeline.pipelineId, pipelineStageId: pipeline.stageId, valueAmount: Number.isFinite(valueAmount) ? valueAmount : undefined, valueCurrency: 'PLN', companyIds: [projection.companyEntityId], personIds: [projection.applicantEntityId, ...representativeEntityIds], primaryPersonEntityId: projection.applicantEntityId, customFields: dealCustomFields(payload, state, projection.submissionHistoryJson) }, ctx: context,
      })
    } else {
      await commandBus.execute('customers.deals.create', {
        input: { ...scope, systemDealId: projection.dealId, title: payload.companyName, description: payload.reason, status: state === 'disqualified' ? 'closed' : 'open', pipelineId: pipeline.pipelineId, pipelineStageId: pipeline.stageId, valueAmount: Number.isFinite(valueAmount) ? valueAmount : undefined, valueCurrency: 'PLN', companyIds: [projection.companyEntityId], personIds: [projection.applicantEntityId, ...representativeEntityIds], primaryPersonEntityId: projection.applicantEntityId, source: `finoo_application:${projection.id}`, customFields: dealCustomFields(payload, state, projection.submissionHistoryJson) }, ctx: context,
      })
    }
  }
  projection.state = state
  projection.lastIntakeId = intake.id
  projection.lastSourceTimestamp = intake.sourceTimestamp
  projection.lastErrorCode = null
  projection.warningsJson = [...new Set([...projection.warningsJson, ...payload.ingestionMeta.unknownFieldNames.map(() => 'unknown_field')])].slice(-50)
  await em.flush()
  return projection
}

export async function projectFinooApplication(
  em: EntityManager,
  commandBus: CommandBus,
  container: AppContainer,
  intake: FinooApplicationIntake,
): Promise<FinooApplicationProjection> {
  const payload = intake.payloadJson
  const scopePrefix = `${intake.tenantId}:${intake.organizationId}`
  const identityKeys = payload ? [
    normalizeDigits(payload.companyNip || payload.nip) ? `nip:${normalizeDigits(payload.companyNip || payload.nip)}` : null,
    normalizeDigits(payload.pesel) ? `pesel:${normalizeDigits(payload.pesel)}` : null,
    normalizeEmail(payload.email) ? `email:${normalizeEmail(payload.email)}` : null,
    ...(payload.representatives ?? []).map((representative) => normalizeEmail(representative.email))
      .filter((email): email is string => Boolean(email))
      .map((email) => `email:${email}`),
  ].filter((key): key is string => Boolean(key)) : []
  const lockKeys = [...new Set([
    `${scopePrefix}:lead:${intake.externalLeadId}`,
    ...identityKeys.map((identity) => `${scopePrefix}:identity:${hashForLookup(identity, `finoo_application_lock:${scopePrefix}`)}`),
  ])].sort()
  const database = (em as unknown as { getKysely: () => Kysely<unknown> }).getKysely()
  return database.transaction().execute(async (transaction) => {
    for (const lockKey of lockKeys) {
      await sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`.execute(transaction)
    }
    return projectFinooApplicationUnlocked(em, commandBus, container, intake)
  })
}

export function safeProjectionErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : 'projection_failed'
  return /^[a-z0-9_]{1,80}$/.test(message) ? message : `projection_${createHash('sha256').update(message).digest('hex').slice(0, 12)}`
}
