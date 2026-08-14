import type { EntityManager } from '@mikro-orm/postgresql'
import type { AppContainer } from '@open-mercato/shared/lib/di/container'
import { normalizeEnvString, resolveDefaultEmailFromAddress } from '@open-mercato/shared/lib/email/config'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { CommunicationChannel } from '@open-mercato/core/modules/communication_channels/data/entities'
import { IntegrationCredentials } from '@open-mercato/core/modules/integrations/data/entities'
import { sesCapabilities } from '../capabilities'
import {
  sesCredentialsSchema,
  type SesCredentials,
  type SesExplicitCredentialsInput,
} from './credentials'
import { channelSesHealthCheck } from './health'

export type PresetScope = {
  em: EntityManager
  container: AppContainer
  tenantId: string
  organizationId: string
}

type CredentialsServiceLike = {
  resolve: (
    integrationId: string,
    scope: { organizationId: string; tenantId: string; userId?: string | null },
  ) => Promise<Record<string, unknown> | null>
  save: (
    integrationId: string,
    credentials: Record<string, unknown>,
    scope: { organizationId: string; tenantId: string; userId?: string | null },
  ) => Promise<void>
}

export async function assertSesEnvPresetAbsent(ctx: PresetScope): Promise<void> {
  const [channel, credentials] = await Promise.all([
    ctx.em.findOne(CommunicationChannel, {
      providerKey: 'ses',
      channelType: 'email',
      tenantId: ctx.tenantId,
      organizationId: ctx.organizationId,
      userId: null,
      deletedAt: null,
    }),
    ctx.em.findOne(IntegrationCredentials, {
      integrationId: 'channel_ses',
      tenantId: ctx.tenantId,
      organizationId: ctx.organizationId,
      userId: null,
      deletedAt: null,
    }),
  ])
  if (channel || credentials) {
    throw new Error(
      `SES_ENV_PRESET_ALREADY_EXISTS: refusing rollback-unsafe preset replacement for organization ${ctx.organizationId}`,
    )
  }
}

function hasExactValue(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(actual) || Array.isArray(expected)) {
    return Array.isArray(actual)
      && Array.isArray(expected)
      && actual.length === expected.length
      && actual.every((value, index) => hasExactValue(value, expected[index]))
  }
  if (!actual || !expected || typeof actual !== 'object' || typeof expected !== 'object') {
    return actual === expected
  }
  const actualRecord = actual as Record<string, unknown>
  const expectedRecord = expected as Record<string, unknown>
  const actualKeys = Object.keys(actualRecord).sort()
  const expectedKeys = Object.keys(expectedRecord).sort()
  return actualKeys.length === expectedKeys.length
    && actualKeys.every((key, index) => (
      key === expectedKeys[index] && hasExactValue(actualRecord[key], expectedRecord[key])
    ))
}

export async function assertSesEnvPresetExact(ctx: PresetScope): Promise<void> {
  const preset = readSesEnvPreset()
  if (!preset) {
    throw new Error('SES_ENV_PRESET_MISSING_ENV: SES environment preset is incomplete')
  }

  const credentialsService = ctx.container.resolve('integrationCredentialsService') as CredentialsServiceLike
  const scope = { tenantId: ctx.tenantId, organizationId: ctx.organizationId, userId: null }
  const credentialsFilter = {
    integrationId: 'channel_ses',
    tenantId: ctx.tenantId,
    organizationId: ctx.organizationId,
    userId: null,
    deletedAt: null,
  }
  const channelFilter = {
    providerKey: 'ses',
    channelType: 'email',
    tenantId: ctx.tenantId,
    organizationId: ctx.organizationId,
    userId: null,
    deletedAt: null,
  }
  const [credentialsCount, channelCount] = await Promise.all([
    ctx.em.count(IntegrationCredentials, credentialsFilter),
    ctx.em.count(CommunicationChannel, channelFilter),
  ])
  if (credentialsCount !== 1 || channelCount !== 1) {
    throw new Error(`SES_ENV_PRESET_MISMATCH: expected exactly one preset for organization ${ctx.organizationId}`)
  }

  const [credentials, channel] = await Promise.all([
    credentialsService.resolve('channel_ses', scope),
    findOneWithDecryption(
      ctx.em,
      CommunicationChannel,
      channelFilter,
      undefined,
      { tenantId: ctx.tenantId, organizationId: ctx.organizationId },
    ),
  ])

  const channelMatches = channel
    && channel.displayName === 'Amazon SES system email'
    && channel.externalIdentifier === preset.fromAddress
    && channel.isActive === true
    && channel.status === 'connected'
    && channel.lastError == null
    && hasExactValue(channel.capabilities ?? {}, sesCapabilities)

  const parsedCredentials = sesCredentialsSchema.safeParse(credentials)
  const publicCredentialsMatch = parsedCredentials.success
    && parsedCredentials.data.region === preset.region
    && parsedCredentials.data.fromAddress === preset.fromAddress
    && parsedCredentials.data.configurationSetName === preset.configurationSetName

  if (!publicCredentialsMatch || !channelMatches) {
    throw new Error(`SES_ENV_PRESET_MISMATCH: existing preset differs for organization ${ctx.organizationId}`)
  }
}

export async function assertSesExplicitCredentialsExact(ctx: PresetScope): Promise<SesCredentials> {
  await assertSesEnvPresetExact(ctx)
  const credentialsService = ctx.container.resolve('integrationCredentialsService') as CredentialsServiceLike
  const credentials = await credentialsService.resolve('channel_ses', {
    tenantId: ctx.tenantId,
    organizationId: ctx.organizationId,
    userId: null,
  })
  const parsed = sesCredentialsSchema.safeParse(credentials)
  if (!parsed.success || parsed.data.authMode !== 'access_keys') {
    throw new Error(`SES_EXPLICIT_CREDENTIALS_MISSING: expected dedicated credentials for organization ${ctx.organizationId}`)
  }
  return parsed.data
}

export async function assertSesExplicitCredentialsHealthy(ctx: PresetScope): Promise<void> {
  const credentials = await assertSesExplicitCredentialsExact(ctx)
  const result = await channelSesHealthCheck.check(credentials, {
    tenantId: ctx.tenantId,
    organizationId: ctx.organizationId,
    userId: null,
  })
  if (result.status !== 'healthy') {
    throw new Error(`SES_EXPLICIT_CREDENTIALS_UNHEALTHY: health check failed for organization ${ctx.organizationId}`)
  }
}

export async function configureSesExplicitCredentials(
  ctx: PresetScope,
  explicitCredentials: SesExplicitCredentialsInput,
): Promise<void> {
  await assertSesEnvPresetExact(ctx)
  const preset = readSesEnvPreset()
  if (!preset) {
    throw new Error('SES_ENV_PRESET_MISSING_ENV: SES environment preset is incomplete')
  }
  const credentials = sesCredentialsSchema.parse({
    ...preset,
    authMode: 'access_keys',
    ...explicitCredentials,
  })
  const health = await channelSesHealthCheck.check(credentials, {
    tenantId: ctx.tenantId,
    organizationId: ctx.organizationId,
    userId: null,
  })
  if (health.status !== 'healthy') {
    throw new Error(`SES_EXPLICIT_CREDENTIALS_UNHEALTHY: refusing credential update for organization ${ctx.organizationId}`)
  }
  const credentialsService = ctx.container.resolve('integrationCredentialsService') as CredentialsServiceLike
  await credentialsService.save('channel_ses', credentials, {
    tenantId: ctx.tenantId,
    organizationId: ctx.organizationId,
    userId: null,
  })
  await assertSesExplicitCredentialsExact(ctx)
  const stored = await credentialsService.resolve('channel_ses', {
    tenantId: ctx.tenantId,
    organizationId: ctx.organizationId,
    userId: null,
  })
  if (!hasExactValue(stored, credentials)) {
    throw new Error(`SES_EXPLICIT_CREDENTIALS_CHANGED: concurrent update detected for organization ${ctx.organizationId}`)
  }
}

export async function restoreSesAmbientCredentials(ctx: PresetScope): Promise<void> {
  const preset = readSesEnvPreset()
  if (!preset) {
    throw new Error('SES_ENV_PRESET_MISSING_ENV: SES environment preset is incomplete')
  }
  const credentialsService = ctx.container.resolve('integrationCredentialsService') as CredentialsServiceLike
  const scope = {
    tenantId: ctx.tenantId,
    organizationId: ctx.organizationId,
    userId: null,
  }
  await credentialsService.save('channel_ses', preset, scope)
  await assertSesEnvPresetExact(ctx)
  const restored = await credentialsService.resolve('channel_ses', scope)
  if (!hasExactValue(restored, preset)) {
    throw new Error(`SES_AMBIENT_CREDENTIALS_RESTORE_FAILED: organization ${ctx.organizationId}`)
  }
}

export async function removeSesEnvPreset(ctx: PresetScope): Promise<void> {
  await ctx.em.transactional(async (em) => {
    await em.nativeDelete(CommunicationChannel, {
      providerKey: 'ses',
      channelType: 'email',
      tenantId: ctx.tenantId,
      organizationId: ctx.organizationId,
      userId: null,
      deletedAt: null,
    })
    await em.nativeDelete(IntegrationCredentials, {
      integrationId: 'channel_ses',
      tenantId: ctx.tenantId,
      organizationId: ctx.organizationId,
      userId: null,
      deletedAt: null,
    })
  })
}

export function readSesEnvPreset(): { region: string; fromAddress: string; configurationSetName?: string } | null {
  const fromAddress = resolveDefaultEmailFromAddress()
  const region = normalizeEnvString(process.env.AWS_SES_REGION) || normalizeEnvString(process.env.AWS_REGION)
  if (!fromAddress || !region) return null
  const configurationSetName = normalizeEnvString(process.env.AWS_SES_CONFIGURATION_SET)
  return {
    fromAddress,
    region,
    ...(configurationSetName ? { configurationSetName } : {}),
  }
}

export async function applySesEnvPreset(ctx: PresetScope): Promise<void> {
  const preset = readSesEnvPreset()
  if (!preset) return

  let credentialsService: CredentialsServiceLike
  try {
    credentialsService = ctx.container.resolve('integrationCredentialsService') as CredentialsServiceLike
  } catch {
    return
  }

  const scope = {
    tenantId: ctx.tenantId,
    organizationId: ctx.organizationId,
    userId: null,
  }
  const existingCredentials = await credentialsService.resolve('channel_ses', scope)
  const parsedExistingCredentials = sesCredentialsSchema.safeParse(existingCredentials)
  const explicitFieldsPresent = existingCredentials
    && ['authMode', 'accessKeyId', 'secretAccessKey'].some((key) => key in existingCredentials)
  if (!parsedExistingCredentials.success && explicitFieldsPresent) {
    throw new Error(`SES_EXPLICIT_CREDENTIALS_INVALID: refusing to overwrite credentials for organization ${ctx.organizationId}`)
  }
  const publicPresetMatches = parsedExistingCredentials.success
    && parsedExistingCredentials.data.region === preset.region
    && parsedExistingCredentials.data.fromAddress === preset.fromAddress
    && parsedExistingCredentials.data.configurationSetName === preset.configurationSetName
  if (parsedExistingCredentials.success && parsedExistingCredentials.data.authMode === 'access_keys') {
    if (!publicPresetMatches) {
      throw new Error(`SES_EXPLICIT_CREDENTIALS_PUBLIC_PRESET_MISMATCH: refusing secret-bearing rewrite for organization ${ctx.organizationId}`)
    }
  } else if (!publicPresetMatches) {
    await credentialsService.save('channel_ses', {
      ...preset,
      ...(parsedExistingCredentials.success && parsedExistingCredentials.data.authMode === 'ambient'
        ? { authMode: 'ambient' }
        : {}),
    }, scope)
  }

  const dscope = { tenantId: ctx.tenantId, organizationId: ctx.organizationId }
  const existing = await findOneWithDecryption(
    ctx.em,
    CommunicationChannel,
    {
      providerKey: 'ses',
      channelType: 'email',
      tenantId: ctx.tenantId,
      organizationId: ctx.organizationId,
      userId: null,
      deletedAt: null,
    },
    undefined,
    dscope,
  )

  if (existing) {
    existing.displayName = 'Amazon SES system email'
    existing.externalIdentifier = preset.fromAddress
    existing.capabilities = { ...sesCapabilities }
    existing.isActive = true
    existing.status = 'connected'
    existing.lastError = null
    await ctx.em.flush()
    return
  }

  const channel = ctx.em.create(CommunicationChannel, {
    providerKey: 'ses',
    channelType: 'email',
    displayName: 'Amazon SES system email',
    externalIdentifier: preset.fromAddress,
    capabilities: { ...sesCapabilities },
    isActive: true,
    status: 'connected',
    userId: null,
    pollIntervalSeconds: null,
    tenantId: ctx.tenantId,
    organizationId: ctx.organizationId,
  })
  await ctx.em.persist(channel).flush()
}
