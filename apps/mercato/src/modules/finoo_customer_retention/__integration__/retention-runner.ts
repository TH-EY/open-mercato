import { randomUUID } from 'node:crypto'
import type { EntityManager } from '@mikro-orm/postgresql'
import { bootstrapFromAppRoot } from '@open-mercato/shared/lib/bootstrap/dynamicLoader'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import {
  FinooApplicationIdentityBinding,
  FinooApplicationIntake,
  FinooApplicationProjection,
} from '../../finoo_applications/data/entities'

const action = process.argv[2]
const tenantId = process.env.OM_FINOO_RETENTION_TENANT_ID?.trim() ?? ''
const organizationId = process.env.OM_FINOO_RETENTION_ORGANIZATION_ID?.trim() ?? ''

async function createApplicationCopies(): Promise<{ intakeId: string }> {
  const personId = process.argv[3]?.trim() ?? ''
  const pesel = process.argv[4]?.trim() ?? ''
  const documentNumber = process.argv[5]?.trim() ?? ''
  if (!personId || !pesel || !documentNumber) throw new Error('integration_fixture_input_missing')

  const container = await createRequestContainer()
  try {
    const em = (container.resolve('em') as EntityManager).fork()
    const externalLeadId = `TC-FINOO-RET-007-${randomUUID()}`
    const projection = em.create(FinooApplicationProjection, {
      tenantId,
      organizationId,
      externalLeadId,
      state: 'completed',
      applicantEntityId: personId,
    })
    const intake = em.create(FinooApplicationIntake, {
      tenantId,
      organizationId,
      messageId: `TC-FINOO-RET-007-${randomUUID()}`,
      bodyDigest: `fixture-${randomUUID()}`,
      externalLeadId,
      sourceTimestamp: new Date(),
      payloadJson: {
        leadId: externalLeadId,
        completed: true,
        name: 'Retention fixture',
        pesel,
        idCard: documentNumber,
        ingestionMeta: {
          messageId: `TC-FINOO-RET-007-${randomUUID()}`,
          sourceTimestamp: Date.now(),
          receivedAt: new Date().toISOString(),
          unknownFieldNames: [],
          kontomatikTokenDiscarded: false,
        },
      },
      state: 'processed',
      dispatchState: 'enqueued',
    })
    const binding = em.create(FinooApplicationIdentityBinding, {
      tenantId,
      organizationId,
      projectionId: projection.id,
      identityKind: 'pesel',
      identityHash: `fixture-${randomUUID()}`,
      reservedEntityId: personId,
      customerEntityId: personId,
    })
    em.persist([projection, intake, binding])
    await em.flush()
    return { intakeId: intake.id }
  } finally {
    await container.dispose()
  }
}

async function readApplicationPayload(): Promise<{ payload: Record<string, unknown> | null }> {
  const intakeId = process.argv[3]?.trim() ?? ''
  if (!intakeId) throw new Error('integration_intake_id_missing')

  const container = await createRequestContainer()
  try {
    const em = (container.resolve('em') as EntityManager).fork()
    const intakes = await findWithDecryption(
      em,
      FinooApplicationIntake,
      { id: intakeId, tenantId, organizationId },
      undefined,
      { tenantId, organizationId },
    )
    return {
      payload: (intakes[0]?.payloadJson as Record<string, unknown> | null | undefined) ?? null,
    }
  } finally {
    await container.dispose()
  }
}

async function main(): Promise<void> {
  if (!tenantId || !organizationId) throw new Error('integration_scope_missing')
  await bootstrapFromAppRoot(process.cwd())
  const result = action === 'create-application-copies'
    ? await createApplicationCopies()
    : action === 'read-application-payload'
      ? await readApplicationPayload()
      : null
  if (!result) throw new Error('integration_action_invalid')
  process.stdout.write(`FINOO_RETENTION_RESULT ${JSON.stringify(result)}\n`)
}

void main().then(
  () => setImmediate(() => process.exit(0)),
  (error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    setImmediate(() => process.exit(1))
  },
)
