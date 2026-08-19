import { createHmac } from 'node:crypto'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { CommandBus } from '@open-mercato/shared/lib/commands'
import { createRequestContainer, type AppContainer } from '@open-mercato/shared/lib/di/container'
import { bootstrapFromAppRoot } from '@open-mercato/shared/lib/bootstrap/dynamicLoader'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import type { CredentialsService } from '@open-mercato/core/modules/integrations/lib/credentials-service'
import type { IntegrationStateService } from '@open-mercato/core/modules/integrations/lib/state-service'
import type { TenantDataEncryptionService } from '@open-mercato/shared/lib/encryption/tenantDataEncryptionService'
import type { RateLimiterService } from '@open-mercato/shared/lib/ratelimit/service'
import { POST } from '../api/intake/route'
import { FinooApplicationIntake } from '../data/entities'
import { FINOO_APPLICATION_INTEGRATION_ID } from '../integration'
import { projectFinooApplication } from '../lib/projector'
import reconcile from '../workers/reconcile'
import prune from '../workers/prune'
import project from '../workers/project'

const action = process.argv[2]
const signingSecret = process.env.OM_FINOO_TEST_SIGNING_SECRET ?? ''
const tenantId = process.env.OM_FINOO_APPLICATION_TENANT_ID ?? ''
const organizationId = process.env.OM_FINOO_APPLICATION_ORGANIZATION_ID ?? ''

async function configure(): Promise<Record<string, unknown>> {
  const container = await createRequestContainer()
  try {
    const scope = { tenantId, organizationId }
    await (container.resolve('integrationCredentialsService') as CredentialsService)
      .save(FINOO_APPLICATION_INTEGRATION_ID, { signingSecret }, scope)
    await (container.resolve('integrationStateService') as IntegrationStateService)
      .upsert(FINOO_APPLICATION_INTEGRATION_ID, { isEnabled: true }, scope)
    return { ok: true }
  } finally {
    await (container as unknown as { dispose?: () => Promise<void> }).dispose?.()
  }
}

async function diagnose(): Promise<Record<string, unknown>> {
  const container = await createRequestContainer()
  try {
    const scope = { tenantId, organizationId }
    const credentials = await (container.resolve('integrationCredentialsService') as CredentialsService)
      .resolve(FINOO_APPLICATION_INTEGRATION_ID, scope)
    const encryption = container.resolve('tenantEncryptionService') as TenantDataEncryptionService
    const rateLimit = await (container.resolve('rateLimiterService') as RateLimiterService)
      .consume(`${tenantId}:integration-diagnostic`, { points: 120, duration: 60, keyPrefix: 'finoo_applications:diagnostic' })
    return {
      enabled: await (container.resolve('integrationStateService') as IntegrationStateService)
        .isEnabled(FINOO_APPLICATION_INTEGRATION_ID, scope),
      hasSigningSecret: typeof credentials?.signingSecret === 'string' && credentials.signingSecret.length >= 32,
      encryptionEnabled: encryption.isEnabled(),
      hasDek: Boolean((await encryption.getDek(tenantId))?.key),
      encryptedFields: await encryption.getEncryptedFieldNames(
        'finoo_applications:finoo_application_intake',
        tenantId,
        organizationId,
      ),
      rateLimitAllowed: rateLimit.allowed,
    }
  } finally {
    await (container as unknown as { dispose?: () => Promise<void> }).dispose?.()
  }
}

async function submit(): Promise<Record<string, unknown>> {
  const messageId = process.argv[3] ?? ''
  const payload = Buffer.from(process.argv[4] ?? '', 'base64url').toString('utf8')
  const timestamp = process.argv[5] ?? String(Math.floor(Date.now() / 1000))
  const body = Buffer.from(payload, 'utf8')
  const signature = createHmac('sha256', signingSecret)
    .update(`${messageId}.${timestamp}.`, 'ascii')
    .update(body)
    .digest('base64')
  const response = await POST(new Request('http://localhost/api/finoo_applications/intake', {
    method: 'POST',
    body,
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': '192.0.2.10',
      'finoo-message-id': messageId,
      'finoo-timestamp': timestamp,
      'finoo-signature': `v1,${signature}`,
    },
  }))
  return { status: response.status, body: await response.json() }
}

async function runScopedWorker(worker: (job: never, context: never) => Promise<void>): Promise<Record<string, unknown>> {
  const container = await createRequestContainer()
  try {
    await worker(
      { payload: { tenantId, organizationId } } as never,
      { resolve: <T = unknown>(name: string) => container.resolve(name) as T } as never,
    )
    return { ok: true }
  } finally {
    await (container as unknown as { dispose?: () => Promise<void> }).dispose?.()
  }
}

async function projectOnce(): Promise<Record<string, unknown>> {
  const intakeId = process.argv[3] ?? ''
  try {
    await project(
      { payload: { intakeId, tenantId, organizationId } } as never,
      {} as never,
    )
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'projection_failed' }
  }
}

async function projectWithoutAffiliate(): Promise<Record<string, unknown>> {
  const intakeId = process.argv[3] ?? ''
  const container = await createRequestContainer()
  try {
    const scope = { tenantId, organizationId }
    const em = (container.resolve('em') as EntityManager).fork()
    const intake = await findOneWithDecryption(
      em,
      FinooApplicationIntake,
      { ...scope, id: intakeId },
      undefined,
      scope,
    )
    if (!intake) throw new Error('integration_intake_missing')
    const commandBus = container.resolve('commandBus') as CommandBus
    const projectionContainer = {
      resolve: <T = unknown>(name: string): T => {
        if (name === 'finooAffiliateService') throw new Error('integration_affiliate_unavailable')
        return container.resolve(name) as T
      },
    } as unknown as AppContainer
    try {
      await projectFinooApplication(em, commandBus, projectionContainer, intake)
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'projection_failed' }
    }
  } finally {
    await (container as unknown as { dispose?: () => Promise<void> }).dispose?.()
  }
}

async function main(): Promise<void> {
  if (!tenantId || !organizationId || signingSecret.length < 32) throw new Error('integration_scope_or_secret_missing')
  await bootstrapFromAppRoot(process.cwd())
  const result = action === 'configure' ? await configure()
    : action === 'diagnose' ? await diagnose()
      : action === 'submit' ? await submit()
        : action === 'reconcile' ? await runScopedWorker(reconcile)
          : action === 'prune' ? await runScopedWorker(prune)
            : action === 'project-once' ? await projectOnce()
              : action === 'project-without-affiliate' ? await projectWithoutAffiliate()
        : null
  if (!result) throw new Error('integration_action_invalid')
  process.stdout.write(`FINOO_INTAKE_RESULT ${JSON.stringify(result)}\n`)
}

void main().then(
  () => setImmediate(() => process.exit(0)),
  (error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    setImmediate(() => process.exit(1))
  },
)
