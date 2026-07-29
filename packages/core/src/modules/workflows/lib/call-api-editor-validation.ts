import { z } from 'zod'
import {
  findUnresolvedEndpointParams,
  unresolvedRequiredEndpointParamName,
} from './endpoint-path'
import { isRecord } from './endpoint-schema'

export type CallApiEditorValidationKey =
  'workflows.endpointPicker.requiredParametersMissing'

interface CallApiActivityIssue {
  key: CallApiEditorValidationKey
}

function callApiActivityIssues(activities: unknown): CallApiActivityIssue[] {
  if (!Array.isArray(activities)) return []
  const issues: CallApiActivityIssue[] = []

  activities.forEach((activity) => {
    if (!isRecord(activity) || activity.activityType !== 'CALL_API') return
    const config = isRecord(activity.config) ? activity.config : {}
    const endpoint = typeof config.endpoint === 'string' ? config.endpoint : ''

    if (endpoint.trim().length === 0) return

    const unresolved = findUnresolvedEndpointParams(endpoint)
    if (isRecord(config.headers)) {
      for (const value of Object.values(config.headers)) {
        if (typeof value === 'string') {
          const name = unresolvedRequiredEndpointParamName(value)
          if (name) unresolved.push(name)
        }
      }
    }

    if (unresolved.length > 0) {
      issues.push({ key: 'workflows.endpointPicker.requiredParametersMissing' })
    }
  })

  return issues
}

export function firstCallApiActivityValidationKey(activities: unknown): CallApiEditorValidationKey | null {
  return callApiActivityIssues(activities)[0]?.key ?? null
}

export function firstCallApiTransitionValidationKey(transitions: unknown): CallApiEditorValidationKey | null {
  if (!Array.isArray(transitions)) return null
  for (const transition of transitions) {
    if (!isRecord(transition)) continue
    const key = firstCallApiActivityValidationKey(transition.activities)
    if (key) return key
  }
  return null
}

export function createCallApiActivitiesFormSchema(translate: (key: string) => string) {
  return z.object({
    activities: z.array(z.unknown()).optional(),
    stepActivities: z.array(z.unknown()).optional(),
    transitions: z.array(z.unknown()).optional(),
  }).passthrough().superRefine((values, context) => {
    const collections: Array<{
      path: 'activities' | 'stepActivities' | 'transitions'
      key: CallApiEditorValidationKey | null
    }> = [
      { path: 'activities', key: firstCallApiActivityValidationKey(values.activities) },
      { path: 'stepActivities', key: firstCallApiActivityValidationKey(values.stepActivities) },
      { path: 'transitions', key: firstCallApiTransitionValidationKey(values.transitions) },
    ]
    for (const collection of collections) {
      if (!collection.key) continue
      context.addIssue({
        code: 'custom',
        message: translate(collection.key),
        path: [collection.path],
      })
    }
  })
}
