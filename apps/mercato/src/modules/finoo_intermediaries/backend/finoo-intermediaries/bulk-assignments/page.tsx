import { Page } from '@open-mercato/ui/backend/Page'
import BulkAssignmentClient from '../../../components/bulk-assignments/bulk-assignment.client'

export default async function BulkAssignmentsPage({
  searchParams,
}: {
  searchParams: Promise<{ dealIds?: string }>
}) {
  const params = await searchParams
  return (
    <Page>
      <BulkAssignmentClient dealIds={params.dealIds ?? ''} />
    </Page>
  )
}
