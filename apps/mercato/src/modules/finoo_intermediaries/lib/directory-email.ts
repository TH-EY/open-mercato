import type { AppContainer } from '@open-mercato/shared/lib/di/container'
import { sendEmail } from '@open-mercato/shared/lib/email/send'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import { urlForCustomerOrg } from '@open-mercato/core/modules/customer_accounts/lib/customerUrl'

export type IntermediaryAccessNoticeInput = {
  container: AppContainer
  tenantId: string
  organizationId: string
  email: string
}

export async function sendIntermediaryAccessNotice(
  input: IntermediaryAccessNoticeInput,
): Promise<void> {
  const { translate } = await resolveTranslations()
  const portalUrl = await urlForCustomerOrg(input.organizationId, '/', { container: input.container })
  const subject = translate(
    'finooIntermediaries.directory.email.accessNotice.subject',
    'Customer portal access',
  )
  const body = translate(
    'finooIntermediaries.directory.email.accessNotice.body',
    'Your customer portal access is available.',
  )
  await sendEmail({
    to: input.email,
    subject,
    text: `${body}\n\n${portalUrl}`,
    tenantId: input.tenantId,
    organizationId: input.organizationId,
  })
}
