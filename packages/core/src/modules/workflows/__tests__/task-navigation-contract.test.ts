/** @jest-environment node */

import { describe, expect, test } from '@jest/globals'
import { hasAllFeatures } from '@open-mercato/shared/security/features'
import { metadata as taskPageMetadata } from '../backend/tasks/page.meta'
import { setup } from '../setup'
import taskNavigationWidget from '../widgets/injection/my-tasks-menu/widget'

function visibleItemIds(grantedFeatures: string[]): string[] {
  const widgetFeatures = taskNavigationWidget.metadata.features ?? []
  return taskNavigationWidget.menuItems
    .filter((item) => hasAllFeatures(grantedFeatures, [...widgetFeatures, ...(item.features ?? [])]))
    .map((item) => item.id)
}

describe('workflow task navigation contract', () => {
  test('keeps the personal inbox as the only task destination for an operational employee', () => {
    const operationalFeatures = setup.defaultRoleFeatures?.employee ?? []
    const dependencyCompleteOperationalFeatures = [...operationalFeatures, 'workflows.view']

    expect(visibleItemIds(dependencyCompleteOperationalFeatures)).toEqual(['workflows-my-tasks'])
  })

  test('restores the grouped administrative destination for a workflow manager', () => {
    const managerFeatures = [
      'workflows.view',
      'workflows.manage',
      'workflows.view_tasks',
      'workflows.tasks.view',
    ]

    expect(visibleItemIds(managerFeatures)).toEqual([
      'workflows-my-tasks',
      'workflows-user-tasks-admin',
    ])
    expect(taskNavigationWidget.menuItems).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'workflows-user-tasks-admin',
        href: '/backend/tasks',
        features: ['workflows.manage', 'workflows.view_tasks', 'workflows.tasks.view'],
        groupId: 'workflows.module.name',
      }),
    ]))
  })

  test('preserves the legacy route guard while keeping generated navigation hidden', () => {
    expect(taskPageMetadata.requireFeatures).toEqual(['workflows.view_tasks'])
    expect(taskPageMetadata.navHidden).toBe(true)
  })

  test('includes the administrative destination for a wildcard administrator', () => {
    expect(visibleItemIds(['workflows.*'])).toContain('workflows-user-tasks-admin')
  })
})
