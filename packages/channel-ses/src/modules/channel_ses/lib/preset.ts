import type { EntityManager } from '@mikro-orm/postgresql'
import type { AppContainer } from '@open-mercato/shared/lib/di/container'
import { normalizeEnvString, resolveDefaultEmailFromAddress } from '@open-mercato/shared/lib/email/config'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { CommunicationChannel } from '@open-mercato/core/modules/communication_channels/data/entities'
import { IntegrationCredentials } from '@open-mercato/core/modules/integrations/data/entities'
import { sesCapabilities } from '../capabilities'

export type PresetScope = {
  em: EntityManager
  container: AppContainer
  tenantId: string
  organizationId: string
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

  const credentialsService = ctx.container.resolve('integrationCredentialsService') as {
    resolve: (
      integrationId: string,
      scope: { organizationId: string; tenantId: string; userId?: string | null },
    ) => Promise<Record<string, unknown> | null>
  }
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

  if (!credentials || !hasExactValue(credentials, preset) || !channelMatches) {
    throw new Error(`SES_ENV_PRESET_MISMATCH: existing preset differs for organization ${ctx.organizationId}`)
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

type CredentialsServiceLike = {
  save: (
    integrationId: string,
    credentials: Record<string, unknown>,
    scope: { organizationId: string; tenantId: string; userId?: string | null },
  ) => Promise<void>
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

  await credentialsService.save('channel_ses', preset, {
    tenantId: ctx.tenantId,
    organizationId: ctx.organizationId,
    userId: null,
  })

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
