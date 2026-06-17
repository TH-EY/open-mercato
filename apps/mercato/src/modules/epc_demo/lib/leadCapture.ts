import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { AwilixContainer } from 'awilix'
import type { OpenApiMethodDoc, OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import type { CommandBus, CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import type { AuthContext } from '@open-mercato/shared/lib/auth/server'
import { findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { validatePhoneNumber } from '@open-mercato/shared/lib/phone'
import { CustomerEntity } from '@open-mercato/core/modules/customers/data/entities'
import type {
  AddressCreateInput,
  DealCreateInput,
  PersonCreateInput,
} from '@open-mercato/core/modules/customers/data/validators'
import { Dictionary, DictionaryEntry } from '@open-mercato/core/modules/dictionaries/data/entities'
import { normalizeDictionaryValue } from '@open-mercato/core/modules/dictionaries/lib/utils'
import { CustomFieldDef } from '@open-mercato/core/modules/entities/data/entities'
import {
  EPC_LEAD_SOURCE,
  EPC_PROJECT_TYPE_DICTIONARY_ID,
  EPC_PROJECT_TYPE_FIELD_KEY,
  EPC_PROJECT_TYPE_OPTIONS,
  EPC_PROJECT_TYPE_VALUES,
  EPC_SERVICE_NEEDED_DICTIONARY_ID,
  EPC_SERVICE_NEEDED_FIELD_KEY,
  EPC_SERVICE_NEEDED_OPTIONS,
  EPC_SERVICE_NEEDED_VALUES,
} from './leadCaptureConstants'

const uuidSchema = z.string().uuid()

const requiredText = (max: number) => z.string().trim().min(1).max(max)
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((value) => (value && value.length > 0 ? value : undefined))

const serviceNeededSchema = z.enum(EPC_SERVICE_NEEDED_VALUES)
const projectTypeSchema = z.enum(EPC_PROJECT_TYPE_VALUES)

export const epcLeadCaptureSchema = z.object({
  fullName: requiredText(180),
  email: z.string().trim().email().max(254),
  phone: optionalText(80),
  addressLine1: requiredText(300),
  addressLine2: optionalText(300),
  city: requiredText(150),
  region: optionalText(150),
  postalCode: requiredText(30),
  country: z
    .string()
    .trim()
    .max(150)
    .optional()
    .default('GB')
    .transform((value) => (value.length > 0 ? value : 'GB')),
  message: optionalText(2000),
  serviceNeeded: z.array(serviceNeededSchema).min(1).max(EPC_SERVICE_NEEDED_OPTIONS.length),
  projectType: z.array(projectTypeSchema).min(1).max(EPC_PROJECT_TYPE_OPTIONS.length),
  companyWebsite: z.string().trim().max(200).optional().default(''),
})

export type EpcLeadCaptureInput = z.infer<typeof epcLeadCaptureSchema>
export type EpcLeadCaptureScope = {
  tenantId: string
  organizationId: string
  ownerUserId?: string | null
  pipelineStageId?: string | null
}

export type EpcLeadCaptureResult = {
  personId: string
  addressId: string
  dealId: string
  reusedPerson: boolean
}

export type EpcLeadCaptureCorsConfig = {
  allowed: boolean
  headers: Record<string, string>
}

export function resolveEpcLeadCaptureScope(env: NodeJS.ProcessEnv = process.env): EpcLeadCaptureScope | null {
  const tenantId = uuidSchema.safeParse(env.EPC_LEAD_TENANT_ID)
  const organizationId = uuidSchema.safeParse(env.EPC_LEAD_ORGANIZATION_ID)
  if (!tenantId.success || !organizationId.success) {
    return null
  }

  const ownerUserId = env.EPC_LEAD_OWNER_USER_ID
  const pipelineStageId = env.EPC_LEAD_PIPELINE_STAGE_ID

  return {
    tenantId: tenantId.data,
    organizationId: organizationId.data,
    ownerUserId: ownerUserId && uuidSchema.safeParse(ownerUserId).success ? ownerUserId : null,
    pipelineStageId: pipelineStageId && uuidSchema.safeParse(pipelineStageId).success ? pipelineStageId : null,
  }
}

export function resolveEpcLeadCaptureCorsConfig(
  origin: string | null,
  requestUrl: string,
  env: NodeJS.ProcessEnv = process.env,
): EpcLeadCaptureCorsConfig {
  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  }

  if (!origin) return { allowed: true, headers }

  const normalizedOrigin = normalizeOrigin(origin)
  if (!normalizedOrigin) return { allowed: false, headers }

  const allowedOrigins = new Set<string>()
  addOrigin(allowedOrigins, requestUrl)
  addOrigin(allowedOrigins, env.APP_URL)
  addOrigin(allowedOrigins, env.NEXT_PUBLIC_APP_URL)
  for (const configuredOrigin of (env.EPC_LEAD_CAPTURE_ALLOWED_ORIGINS ?? '').split(',')) {
    addOrigin(allowedOrigins, configuredOrigin)
  }
  if (env.APP_URL === 'https://preview-epc.om.they.dev' || env.NEXT_PUBLIC_APP_URL === 'https://preview-epc.om.they.dev') {
    allowedOrigins.add('https://preview-epc.om.they.dev')
  }

  if (!allowedOrigins.has(normalizedOrigin)) return { allowed: false, headers }
  return {
    allowed: true,
    headers: {
      ...headers,
      'Access-Control-Allow-Origin': normalizedOrigin,
    },
  }
}

export function splitFullName(fullName: string): { firstName: string; lastName: string } {
  const parts = fullName.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 1) return { firstName: parts[0], lastName: 'Lead' }
  return {
    firstName: parts.slice(0, -1).join(' '),
    lastName: parts[parts.length - 1],
  }
}

function normalizeOrigin(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  try {
    return new URL(trimmed).origin
  } catch {
    return null
  }
}

function addOrigin(origins: Set<string>, value: string | undefined): void {
  if (!value) return
  const origin = normalizeOrigin(value)
  if (origin) origins.add(origin)
}

export function buildLeadDescription(input: EpcLeadCaptureInput): string {
  const serviceLabels = labelsForValues(EPC_SERVICE_NEEDED_OPTIONS, input.serviceNeeded)
  const projectLabels = labelsForValues(EPC_PROJECT_TYPE_OPTIONS, input.projectType)
  const address = [
    input.addressLine1,
    input.addressLine2,
    input.city,
    input.region,
    input.postalCode,
    input.country,
  ].filter(Boolean).join(', ')

  return [
    input.message ? `Message: ${input.message}` : null,
    input.phone ? `Phone: ${input.phone}` : null,
    `Address: ${address}`,
    `Service needed: ${serviceLabels.join(', ')}`,
    `Project type: ${projectLabels.join(', ')}`,
  ].filter(Boolean).join('\n\n')
}

export function buildDealCustomFields(input: Pick<EpcLeadCaptureInput, 'serviceNeeded' | 'projectType'>): Record<string, string[]> {
  return {
    [EPC_SERVICE_NEEDED_FIELD_KEY]: Array.from(new Set(input.serviceNeeded)),
    [EPC_PROJECT_TYPE_FIELD_KEY]: Array.from(new Set(input.projectType)),
  }
}

export function normalizeLeadCapturePhone(phone: string | undefined, country: string | undefined): string | undefined {
  const trimmed = phone?.trim()
  if (!trimmed) return undefined

  const directValidation = validatePhoneNumber(trimmed)
  if (directValidation.valid) return directValidation.normalized ?? undefined

  const normalizedCountry = country?.trim().toUpperCase()
  if (normalizedCountry !== 'GB' && normalizedCountry !== 'UK') return undefined

  const digits = directValidation.digits
  const candidate = digits.startsWith('0')
    ? `+44${digits.slice(1)}`
    : digits.startsWith('44')
      ? `+${digits}`
      : null

  if (!candidate) return undefined
  const candidateValidation = validatePhoneNumber(candidate)
  return candidateValidation.valid ? candidate : undefined
}

export async function ensureEpcLeadCaptureMetadata(
  em: EntityManager,
  scope: Pick<EpcLeadCaptureScope, 'tenantId' | 'organizationId'>,
): Promise<void> {
  await ensureDictionary(em, {
    id: EPC_SERVICE_NEEDED_DICTIONARY_ID,
    key: EPC_SERVICE_NEEDED_FIELD_KEY,
    name: 'Service needed',
    description: 'EPC public lead capture service needs.',
    entries: EPC_SERVICE_NEEDED_OPTIONS,
    scope,
  })

  await ensureDictionary(em, {
    id: EPC_PROJECT_TYPE_DICTIONARY_ID,
    key: EPC_PROJECT_TYPE_FIELD_KEY,
    name: 'Project type',
    description: 'EPC public lead capture project types.',
    entries: EPC_PROJECT_TYPE_OPTIONS,
    scope,
  })

  await ensureCustomFieldDef(em, {
    entityId: 'customers:customer_deal',
    key: EPC_SERVICE_NEEDED_FIELD_KEY,
    kind: 'dictionary',
    configJson: {
      label: 'Service needed',
      dictionaryId: EPC_SERVICE_NEEDED_DICTIONARY_ID,
      dictionaryInlineCreate: true,
      multi: true,
      filterable: true,
      formEditable: true,
      listVisible: true,
    },
    scope,
  })

  await ensureCustomFieldDef(em, {
    entityId: 'customers:customer_deal',
    key: EPC_PROJECT_TYPE_FIELD_KEY,
    kind: 'dictionary',
    configJson: {
      label: 'Project type',
      dictionaryId: EPC_PROJECT_TYPE_DICTIONARY_ID,
      dictionaryInlineCreate: true,
      multi: true,
      filterable: true,
      formEditable: true,
      listVisible: true,
    },
    scope,
  })

  await em.flush()
}

export async function createEpcLeadFromCapture(args: {
  input: EpcLeadCaptureInput
  scope: EpcLeadCaptureScope
  container: AwilixContainer
  request?: Request
}): Promise<EpcLeadCaptureResult> {
  const em = (args.container.resolve('em') as EntityManager).fork()
  await ensureEpcLeadCaptureMetadata(em, args.scope)

  const commandBus = args.container.resolve('commandBus') as CommandBus
  const commandContext = buildCommandContext(args.container, args.scope, args.request)
  const personLookup = await findExistingPersonByEmail(em, args.scope, args.input.email)
  const personId = personLookup?.id ?? await createPerson(commandBus, commandContext, args.input, args.scope)
  const addressId = await createAddress(commandBus, commandContext, args.input, args.scope, personId)
  const dealId = await createDeal(commandBus, commandContext, args.input, args.scope, personId)

  return { personId, addressId, dealId, reusedPerson: Boolean(personLookup) }
}

const successResponseSchema = z.object({
  ok: z.literal(true),
  dealId: z.string().uuid(),
})

const errorResponseSchema = z.object({
  ok: z.literal(false),
  error: z.string(),
})

export const epcLeadCapturePostDoc: OpenApiMethodDoc = {
  summary: 'Submit an EPC public lead',
  description: 'Creates a CRM person, address, and deal from the EPC public lead capture form.',
  tags: ['EPC Demo'],
  requestBody: {
    contentType: 'application/json',
    schema: epcLeadCaptureSchema,
    description: 'EPC lead capture form payload.',
  },
  responses: [
    { status: 200, description: 'Lead captured successfully.', schema: successResponseSchema },
    { status: 400, description: 'Invalid lead capture payload.', schema: errorResponseSchema },
    { status: 500, description: 'Lead capture is not configured or could not be saved.', schema: errorResponseSchema },
  ],
}

export const epcLeadCaptureOpenApi: OpenApiRouteDoc = {
  tag: 'EPC Demo',
  summary: 'EPC lead capture',
  methods: {
    POST: epcLeadCapturePostDoc,
  },
}

function labelsForValues<T extends readonly { value: string; label: string }[]>(options: T, values: readonly string[]): string[] {
  const labels = new Map(options.map((option) => [option.value, option.label]))
  return values.map((value) => labels.get(value) ?? value)
}

function buildCommandContext(
  container: AwilixContainer,
  scope: EpcLeadCaptureScope,
  request?: Request,
): CommandRuntimeContext {
  const auth: NonNullable<AuthContext> = {
    sub: scope.ownerUserId ?? 'epc-lead-capture',
    tenantId: scope.tenantId,
    orgId: scope.organizationId,
    roles: ['epc_lead_capture'],
  }
  return {
    container,
    auth,
    organizationScope: null,
    selectedOrganizationId: scope.organizationId,
    organizationIds: [scope.organizationId],
    request,
    syncOrigin: 'epc_demo:lead_capture',
  }
}

async function findExistingPersonByEmail(
  em: EntityManager,
  scope: Pick<EpcLeadCaptureScope, 'tenantId' | 'organizationId'>,
  email: string,
): Promise<CustomerEntity | null> {
  const normalizedEmail = email.trim().toLowerCase()
  const people = await findWithDecryption<CustomerEntity>(
    em,
    CustomerEntity,
    {
      kind: 'person',
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      deletedAt: null,
      primaryEmail: normalizedEmail,
    },
    { limit: 1 },
    scope,
  )
  return people[0] ?? null
}

async function createPerson(
  commandBus: CommandBus,
  ctx: CommandRuntimeContext,
  input: EpcLeadCaptureInput,
  scope: EpcLeadCaptureScope,
): Promise<string> {
  const { firstName, lastName } = splitFullName(input.fullName)
  const createInput: PersonCreateInput = {
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    displayName: input.fullName,
    firstName,
    lastName,
    primaryEmail: input.email,
    primaryPhone: normalizeLeadCapturePhone(input.phone, input.country),
    source: EPC_LEAD_SOURCE,
    ownerUserId: scope.ownerUserId ?? undefined,
  }

  const { result } = await commandBus.execute<PersonCreateInput, { entityId: string; personId: string }>(
    'customers.people.create',
    { input: createInput, ctx },
  )
  return result.entityId
}

async function createAddress(
  commandBus: CommandBus,
  ctx: CommandRuntimeContext,
  input: EpcLeadCaptureInput,
  scope: EpcLeadCaptureScope,
  personId: string,
): Promise<string> {
  const createInput: AddressCreateInput = {
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    entityId: personId,
    name: `${input.fullName} project address`,
    purpose: 'Project site',
    addressLine1: input.addressLine1,
    addressLine2: input.addressLine2,
    city: input.city,
    region: input.region,
    postalCode: input.postalCode,
    country: input.country,
    isPrimary: true,
  }

  const { result } = await commandBus.execute<AddressCreateInput, { addressId: string }>(
    'customers.addresses.create',
    { input: createInput, ctx },
  )
  return result.addressId
}

async function createDeal(
  commandBus: CommandBus,
  ctx: CommandRuntimeContext,
  input: EpcLeadCaptureInput,
  scope: EpcLeadCaptureScope,
  personId: string,
): Promise<string> {
  const createInput: DealCreateInput & { customFields: Record<string, string[]> } = {
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    title: `EPC web form lead - ${input.fullName}`,
    description: buildLeadDescription(input),
    source: EPC_LEAD_SOURCE,
    ownerUserId: scope.ownerUserId ?? undefined,
    pipelineStageId: scope.pipelineStageId ?? undefined,
    personIds: [personId],
    customFields: buildDealCustomFields(input),
  }

  const { result } = await commandBus.execute<typeof createInput, { dealId: string }>(
    'customers.deals.create',
    { input: createInput, ctx },
  )
  return result.dealId
}

async function ensureDictionary(
  em: EntityManager,
  args: {
    id: string
    key: string
    name: string
    description: string
    entries: readonly { value: string; label: string }[]
    scope: Pick<EpcLeadCaptureScope, 'tenantId' | 'organizationId'>
  },
): Promise<void> {
  let dictionary = await em.findOne(Dictionary, {
    id: args.id,
    tenantId: args.scope.tenantId,
    organizationId: args.scope.organizationId,
    deletedAt: null,
  })
  if (!dictionary) {
    dictionary = await em.findOne(Dictionary, {
      key: args.key,
      tenantId: args.scope.tenantId,
      organizationId: args.scope.organizationId,
      deletedAt: null,
    })
  }
  if (!dictionary) {
    const now = new Date()
    dictionary = em.create(Dictionary, {
      id: args.id,
      tenantId: args.scope.tenantId,
      organizationId: args.scope.organizationId,
      key: args.key,
      name: args.name,
      description: args.description,
      isSystem: false,
      isActive: true,
      managerVisibility: 'default',
      entrySortMode: 'label_asc',
      createdAt: now,
      updatedAt: now,
    })
    em.persist(dictionary)
  } else {
    dictionary.key = args.key
    dictionary.name = args.name
    dictionary.description = args.description
    dictionary.isActive = true
    dictionary.deletedAt = null
  }

  for (const [position, option] of args.entries.entries()) {
    const normalizedValue = normalizeDictionaryValue(option.value)
    let entry = await em.findOne(DictionaryEntry, {
      dictionary,
      tenantId: args.scope.tenantId,
      organizationId: args.scope.organizationId,
      normalizedValue,
    })
    if (!entry) {
      entry = em.create(DictionaryEntry, {
        dictionary,
        tenantId: args.scope.tenantId,
        organizationId: args.scope.organizationId,
        value: option.value,
        normalizedValue,
        label: option.label,
        position,
        isDefault: false,
      })
      em.persist(entry)
    } else {
      entry.value = option.value
      entry.normalizedValue = normalizedValue
      entry.label = option.label
      entry.position = position
    }
  }
}

async function ensureCustomFieldDef(
  em: EntityManager,
  args: {
    entityId: string
    key: string
    kind: string
    configJson: Record<string, unknown>
    scope: Pick<EpcLeadCaptureScope, 'tenantId' | 'organizationId'>
  },
): Promise<void> {
  const where = {
    entityId: args.entityId,
    key: args.key,
    tenantId: args.scope.tenantId,
    organizationId: args.scope.organizationId,
  }
  let def = await em.findOne(CustomFieldDef, where)
  if (!def) {
    const now = new Date()
    def = em.create(CustomFieldDef, {
      ...where,
      kind: args.kind,
      configJson: args.configJson,
      isActive: true,
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    })
    em.persist(def)
  } else {
    def.kind = args.kind
    def.configJson = { ...(def.configJson ?? {}), ...args.configJson }
    def.isActive = true
    def.deletedAt = null
  }
}
