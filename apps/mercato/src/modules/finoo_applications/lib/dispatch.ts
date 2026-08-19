import type { EntityManager } from '@mikro-orm/postgresql'
import { getFinooApplicationQueue, type FinooApplicationJob } from './queue'

export async function dispatchFinooApplicationIntake(
  em: EntityManager,
  job: FinooApplicationJob,
): Promise<boolean> {
  const now = new Date()
  const leaseExpiresAt = new Date(now.getTime() + 2 * 60_000)
  const claimed = await em.getConnection().execute<Array<{ id: string }>>(
    `update finoo_application_intakes
       set dispatch_state = 'dispatching',
           dispatch_lease_expires_at = ?,
           updated_at = ?
     where id = ?
       and tenant_id = ?
       and organization_id = ?
       and (
         dispatch_state = 'pending'
         or (dispatch_state = 'dispatching' and dispatch_lease_expires_at <= ?)
         or (dispatch_state = 'enqueued' and dispatch_lease_expires_at <= ?)
       )
     returning id`,
    [leaseExpiresAt, now, job.intakeId, job.tenantId, job.organizationId, now, now],
  )
  if (!claimed[0]) return false
  try {
    await getFinooApplicationQueue().enqueue(job)
  } catch {
    await em.getConnection().execute(
      `update finoo_application_intakes
         set dispatch_state = 'pending', dispatch_lease_expires_at = null, updated_at = ?
       where id = ? and tenant_id = ? and organization_id = ? and dispatch_state = 'dispatching'`,
      [new Date(), job.intakeId, job.tenantId, job.organizationId],
    )
    return false
  }
  await em.getConnection().execute(
    `update finoo_application_intakes
       set dispatch_state = 'enqueued', dispatch_lease_expires_at = ?, updated_at = ?
     where id = ? and tenant_id = ? and organization_id = ? and dispatch_state = 'dispatching'`,
    [new Date(Date.now() + 5 * 60_000), new Date(), job.intakeId, job.tenantId, job.organizationId],
  )
  return true
}
