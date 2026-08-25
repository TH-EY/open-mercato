import { Page, PageBody } from '@open-mercato/ui/backend/Page'
import RetentionSettingsClient from './RetentionSettingsClient'

export default function CustomerRetentionSettingsPage() {
  return (
    <Page>
      <PageBody>
        <RetentionSettingsClient />
      </PageBody>
    </Page>
  )
}
