import { getFinooCustomerRetentionReconciliationQueue } from '../lib/reconciliationQueue'
import { createLogger } from '@open-mercato/shared/lib/logger'

const logger = createLogger('finoo_customer_retention').child({ component: 'email-linked' })

type EmailLinkedPayload = {
  personId?: string
  tenantId?: string
  organizationId?: string | null
}

export const metadata = {
  event: 'customers.email.linked',
  persistent: false,
  id: 'finoo_customer_retention:email-linked',
}

export default async function handle(payload: EmailLinkedPayload): Promise<void> {
  if (!payload.personId || !payload.tenantId || !payload.organizationId) return
  try {
    await getFinooCustomerRetentionReconciliationQueue().enqueue({
      tenantId: payload.tenantId,
      organizationId: payload.organizationId,
      customerEntityId: payload.personId,
    })
  } catch (error) {
    logger.error('Failed to enqueue email-linked retention refresh', {
      tenantId: payload.tenantId,
      organizationId: payload.organizationId,
      customerEntityId: payload.personId,
      err: error,
    })
  }
}
