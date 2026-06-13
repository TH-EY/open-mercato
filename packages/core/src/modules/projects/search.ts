import type { SearchBuildContext, SearchIndexSource, SearchModuleConfig, SearchResultPresenter } from '@open-mercato/shared/modules/search'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'

function pickString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value !== 'string') continue
    const trimmed = value.trim()
    if (trimmed.length > 0) return trimmed
  }
  return null
}

function appendLine(lines: string[], label: string, value: unknown) {
  if (value === null || value === undefined) return
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value)
  if (!text.trim()) return
  lines.push(`${label}: ${text}`)
}

function buildSource(ctx: SearchBuildContext, presenter: SearchResultPresenter, lines: string[]): SearchIndexSource | null {
  for (const [key, value] of Object.entries(ctx.customFields)) appendLine(lines, key.replace(/^cf:/, ''), value)
  if (lines.length === 0) return null
  return {
    text: lines,
    presenter,
    checksumSource: { record: ctx.record, customFields: ctx.customFields },
  }
}

export const searchConfig: SearchModuleConfig = {
  entities: [
    {
      entityId: 'projects:project',
      enabled: true,
      priority: 8,
      buildSource: async (ctx) => {
        const { t } = await resolveTranslations()
        const title = pickString(ctx.record.name, ctx.customFields.name) ?? t('projects.search.badge.project', 'Project')
        return buildSource(ctx, {
          title,
          subtitle: pickString(ctx.record.order_id, ctx.record.owner_user_id) ?? undefined,
          icon: 'folder-kanban',
          badge: t('projects.search.badge.project', 'Project'),
        }, [
          `Name: ${title}`,
          ...(ctx.record.order_id ? [`Order: ${String(ctx.record.order_id)}`] : []),
          ...(ctx.record.owner_user_id ? [`Owner: ${String(ctx.record.owner_user_id)}`] : []),
        ])
      },
    },
    {
      entityId: 'projects:project_task',
      enabled: true,
      priority: 7,
      buildSource: async (ctx) => {
        const { t } = await resolveTranslations()
        const title = pickString(ctx.record.name, ctx.customFields.name) ?? t('projects.search.badge.task', 'Project task')
        return buildSource(ctx, {
          title,
          subtitle: pickString(ctx.record.description, ctx.record.status) ?? undefined,
          icon: 'list-checks',
          badge: t('projects.search.badge.task', 'Project task'),
        }, [
          `Name: ${title}`,
          ...(ctx.record.description ? [`Description: ${String(ctx.record.description)}`] : []),
          ...(ctx.record.status ? [`Status: ${String(ctx.record.status)}`] : []),
          ...(ctx.record.deadline_at ? [`Deadline: ${String(ctx.record.deadline_at)}`] : []),
        ])
      },
    },
    {
      entityId: 'projects:project_task_template',
      enabled: true,
      priority: 6,
      buildSource: async (ctx) => {
        const { t } = await resolveTranslations()
        const title = pickString(ctx.record.name, ctx.customFields.name) ?? t('projects.search.badge.taskTemplate', 'Task template')
        return buildSource(ctx, {
          title,
          subtitle: pickString(ctx.record.description, ctx.record.status) ?? undefined,
          icon: 'copy-check',
          badge: t('projects.search.badge.taskTemplate', 'Task template'),
        }, [
          `Name: ${title}`,
          ...(ctx.record.description ? [`Description: ${String(ctx.record.description)}`] : []),
          ...(ctx.record.status ? [`Status: ${String(ctx.record.status)}`] : []),
          ...(ctx.record.due_in_days ? [`Due in days: ${String(ctx.record.due_in_days)}`] : []),
        ])
      },
    },
    {
      entityId: 'projects:project_template',
      enabled: true,
      priority: 6,
      buildSource: async (ctx) => {
        const { t } = await resolveTranslations()
        const title = pickString(ctx.record.name, ctx.customFields.name) ?? t('projects.search.badge.projectTemplate', 'Project template')
        return buildSource(ctx, {
          title,
          subtitle: pickString(ctx.record.description) ?? undefined,
          icon: 'clipboard-list',
          badge: t('projects.search.badge.projectTemplate', 'Project template'),
        }, [
          `Name: ${title}`,
          ...(ctx.record.description ? [`Description: ${String(ctx.record.description)}`] : []),
        ])
      },
    },
    {
      entityId: 'projects:project_template_task',
      enabled: true,
      priority: 5,
      buildSource: async (ctx) => {
        const { t } = await resolveTranslations()
        const title = pickString(ctx.record.name, ctx.customFields.name) ?? t('projects.search.badge.projectTemplateTask', 'Project template task')
        return buildSource(ctx, {
          title,
          subtitle: pickString(ctx.record.description, ctx.record.status) ?? undefined,
          icon: 'list-plus',
          badge: t('projects.search.badge.projectTemplateTask', 'Project template task'),
        }, [
          `Name: ${title}`,
          ...(ctx.record.description ? [`Description: ${String(ctx.record.description)}`] : []),
          ...(ctx.record.status ? [`Status: ${String(ctx.record.status)}`] : []),
          ...(ctx.record.due_in_days ? [`Due in days: ${String(ctx.record.due_in_days)}`] : []),
        ])
      },
    },
  ],
}

export default searchConfig
