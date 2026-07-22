import { expect, test } from '@playwright/test'
import { login } from '@open-mercato/core/helpers/integration/auth'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { withClient } from '@open-mercato/core/helpers/integration/dbFixtures'
import {
  buildMinimalDefinitionPayload,
  createWorkflowDefinitionFixture,
  deleteWorkflowDefinitionIfExists,
  pollWorkflowInstance,
  startWorkflowInstanceFixture,
} from '@open-mercato/core/helpers/integration/workflowsFixtures'
import { CALL_API_IDENTITY_ERROR_MARKER } from '../lib/call-api-identity-error'

async function deleteWorkflowInstanceFixtures(instanceIds: Array<string | null>): Promise<void> {
  const ids = instanceIds.filter((id): id is string => typeof id === 'string')
  if (ids.length === 0) return

  await withClient(async (client) => {
    await client.query('delete from user_tasks where workflow_instance_id = any($1::uuid[])', [ids])
    await client.query('delete from workflow_events where workflow_instance_id = any($1::uuid[])', [ids])
    await client.query('delete from step_instances where workflow_instance_id = any($1::uuid[])', [ids])
    await client.query('delete from workflow_branch_instances where workflow_instance_id = any($1::uuid[])', [ids])
    await client.query('delete from workflow_instances where id = any($1::uuid[])', [ids])
  })
}

/**
 * TC-WF-036 [P1]: CALL_API identity-resolution guidance on instance details
 *
 * There is no public API for setting a deterministic workflow failure. As in TC-WF-026,
 * each fixture is allowed to complete before its isolated test row is forced to FAILED.
 */
test.describe('TC-WF-036: CALL_API identity-resolution guidance', () => {
  test('shows guidance only for the stable identity-resolution error marker', async ({ page, request }) => {
    const token = await getAuthToken(request, 'admin')
    const timestamp = Date.now()
    const markerDefinition = buildMinimalDefinitionPayload(timestamp, '-identity-marker')
    const controlDefinition = buildMinimalDefinitionPayload(timestamp + 1, '-identity-control')
    let markerDefinitionId: string | null = null
    let controlDefinitionId: string | null = null
    let markerInstanceId: string | null = null
    let controlInstanceId: string | null = null

    try {
      markerDefinitionId = await createWorkflowDefinitionFixture(request, token, markerDefinition)
      controlDefinitionId = await createWorkflowDefinitionFixture(request, token, controlDefinition)
      markerInstanceId = await startWorkflowInstanceFixture(request, token, {
        workflowId: markerDefinition.workflowId,
      })
      controlInstanceId = await startWorkflowInstanceFixture(request, token, {
        workflowId: controlDefinition.workflowId,
      })

      await pollWorkflowInstance(request, token, markerInstanceId, (instance) => instance.status === 'COMPLETED')
      await pollWorkflowInstance(request, token, controlInstanceId, (instance) => instance.status === 'COMPLETED')

      await withClient(async (client) => {
        await client.query(
          "update workflow_instances set status = 'FAILED', error_message = $2, error_details = null, completed_at = null, updated_at = now() where id = $1",
          [markerInstanceId, `${CALL_API_IDENTITY_ERROR_MARKER}. No traceable user roles could be resolved.`],
        )
        await client.query(
          "update workflow_instances set status = 'FAILED', error_message = $2, error_details = null, completed_at = null, updated_at = now() where id = $1",
          [controlInstanceId, 'CALL_API request failed with status 500'],
        )
      })

      await login(page, 'admin')

      await page.goto(`/backend/instances/${markerInstanceId}`)
      await expect(page.getByText(CALL_API_IDENTITY_ERROR_MARKER, { exact: false })).toBeVisible()
      const guidance = page.getByRole('alert').filter({ hasText: 'CALL_API' })
      await expect(guidance).toBeVisible()
      await expect(guidance).toContainText('CALL_API')
      await expect(guidance).toContainText(/workflow definition/i)

      await page.goto(`/backend/instances/${controlInstanceId}`)
      await expect(page.getByText('CALL_API request failed with status 500', { exact: false })).toBeVisible()
      await expect(page.getByRole('alert').filter({ hasText: 'CALL_API' })).toHaveCount(0)

      await page.setViewportSize({ width: 390, height: 844 })
      await page.goto(`/backend/instances/${markerInstanceId}`)
      await expect(page.getByRole('alert').filter({ hasText: 'CALL_API' })).toBeVisible()

      await page.goto(`/backend/instances/${controlInstanceId}`)
      await expect(page.getByText('CALL_API request failed with status 500', { exact: false })).toBeVisible()
      await expect(page.getByRole('alert').filter({ hasText: 'CALL_API' })).toHaveCount(0)
    } finally {
      await deleteWorkflowInstanceFixtures([markerInstanceId, controlInstanceId])
      await deleteWorkflowDefinitionIfExists(request, token, markerDefinitionId)
      await deleteWorkflowDefinitionIfExists(request, token, controlDefinitionId)
    }
  })
})
