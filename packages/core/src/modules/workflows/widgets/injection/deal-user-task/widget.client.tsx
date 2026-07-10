"use client"

import * as React from 'react'
import Link from 'next/link'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { InjectionWidgetComponentProps } from '@open-mercato/shared/modules/widgets/injection'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import { useGuardedMutation } from '@open-mercato/ui/backend/injection/useGuardedMutation'
import { Alert, AlertDescription, AlertTitle } from '@open-mercato/ui/primitives/alert'
import { Button } from '@open-mercato/ui/primitives/button'

type DealContext = {
  dealId?: string
  resourceId?: string
}

type DealRecord = {
  id?: string
}

type UserTask = {
  id: string
  taskName: string
  description: string | null
  status: 'PENDING' | 'IN_PROGRESS'
  formSchema: Record<string, unknown> | null
  assignedTo: string | null
}

type TasksResponse = {
  data: UserTask[]
}

function requiresFormInput(schema: Record<string, unknown> | null): boolean {
  if (!schema) return false
  if (Array.isArray(schema.required) && schema.required.length > 0) return true
  if (!Array.isArray(schema.fields)) return false
  return schema.fields.some((field) => (
    typeof field === 'object'
      && field !== null
      && 'required' in field
      && field.required === true
  ))
}

export default function DealUserTaskWidget({
  context,
  data,
}: InjectionWidgetComponentProps<DealContext, DealRecord>) {
  const t = useT()
  const queryClient = useQueryClient()
  const dealId = context?.dealId ?? context?.resourceId ?? data?.id
  const [isMutating, setIsMutating] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const { runMutation } = useGuardedMutation({
    contextId: dealId ? `customers.deal:${dealId}:workflow-task` : 'customers.deal:workflow-task',
  })

  const queryKey = ['workflow-tasks', 'deal', dealId]
  const { data: task } = useQuery({
    queryKey,
    queryFn: async () => {
      if (!dealId) return null
      for (const entityType of ['customers.deal', 'deal']) {
        const params = new URLSearchParams({
          myTasks: 'true',
          status: 'PENDING,IN_PROGRESS',
          entityType,
          entityId: dealId,
          order: 'oldest',
          limit: '1',
        })
        const result = await apiCall<TasksResponse>(`/api/workflows/tasks?${params.toString()}`)
        if (!result.ok) return null
        const matchingTask = result.result?.data?.[0]
        if (matchingTask) return matchingTask
      }
      return null
    },
    enabled: Boolean(dealId),
    staleTime: 10_000,
  })

  if (!dealId || !task) return null

  const needsInput = requiresFormInput(task.formSchema)
  const shouldClaim = task.status === 'PENDING' && !task.assignedTo
  const mutationContext = {
    dealId,
    resourceId: dealId,
    resourceKind: 'customers.deal',
  }

  const mutateTask = async (operation: 'claim' | 'complete') => {
    setIsMutating(true)
    setError(null)
    try {
      await runMutation({
        context: mutationContext,
        mutationPayload: { taskId: task.id, operation },
        operation: async () => {
          const result = await apiCall(`/api/workflows/tasks/${task.id}/${operation}`, {
            method: 'POST',
            ...(operation === 'complete'
              ? { body: JSON.stringify({ formData: {} }) }
              : {}),
          })
          if (!result.ok) {
            const payload = result.result as { error?: string } | null
            throw new Error(payload?.error ?? t('workflows.dealTask.actionFailed', 'Could not update the task.'))
          }
          return result.result
        },
      })
      await queryClient.invalidateQueries({ queryKey: ['workflow-tasks'] })
    } catch (mutationError) {
      setError(
        mutationError instanceof Error
          ? mutationError.message
          : t('workflows.dealTask.actionFailed', 'Could not update the task.'),
      )
    } finally {
      setIsMutating(false)
    }
  }

  let action: React.ReactNode
  if (shouldClaim) {
    action = (
      <Button size="sm" disabled={isMutating} onClick={() => void mutateTask('claim')}>
        {t('workflows.dealTask.claim', 'Claim task')}
      </Button>
    )
  } else if (needsInput) {
    action = (
      <Button size="sm" asChild>
        <Link href={`/backend/tasks/${task.id}`}>
          {t('workflows.dealTask.open', 'Open task')}
        </Link>
      </Button>
    )
  } else {
    action = (
      <Button size="sm" disabled={isMutating} onClick={() => void mutateTask('complete')}>
        {t('workflows.dealTask.complete', `Complete ${task.taskName}`, { name: task.taskName })}
      </Button>
    )
  }

  return (
    <Alert status={error ? 'error' : 'warning'} action={action} className="w-full">
      <AlertTitle>
        {t('workflows.dealTask.waiting', `${task.taskName} is waiting for action`, { name: task.taskName })}
      </AlertTitle>
      <AlertDescription>
        {error ?? task.description ?? t('workflows.dealTask.description', 'Complete this task to continue the workflow.')}
      </AlertDescription>
    </Alert>
  )
}
