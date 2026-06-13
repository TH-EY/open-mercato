"use client"

import * as React from 'react'
import { usePathname } from 'next/navigation'
import { Page, PageBody } from '@open-mercato/ui/backend/Page'
import { updateCrud } from '@open-mercato/ui/backend/utils/crud'
import { readApiResultOrThrow } from '@open-mercato/ui/backend/utils/apiCall'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { LoadingMessage, ErrorMessage } from '@open-mercato/ui/backend/detail'
import { Button } from '@open-mercato/ui/primitives/button'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { normalizeTaskTemplate, ProjectTaskTemplateForm, type ProjectTaskTemplateValues } from '../../../../components/TemplateForms'
import { resolveProjectPathnameId, resolveRouteId } from '../../../../lib/route-id'

type PageProps = {
  params?: { id?: string | string[] }
}

type ResponsePayload = {
  items?: Record<string, unknown>[]
}

export default function ProjectTaskTemplateDetailPage({ params }: PageProps) {
  const t = useT()
  const pathname = usePathname()
  const id = resolveRouteId(params?.id) ?? resolveProjectPathnameId(pathname)
  const [template, setTemplate] = React.useState<ProjectTaskTemplateValues | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)

  const loadTemplate = React.useCallback(async () => {
    if (!id) {
      setLoading(false)
      setError(t('projects.templates.task.detail.notFound', 'Task template not found.'))
      return
    }
    setLoading(true)
    setError(null)
    try {
      const payload = await readApiResultOrThrow<ResponsePayload>(`/api/projects/task-templates?page=1&pageSize=1&ids=${encodeURIComponent(id)}`)
      const nextTemplate = Array.isArray(payload.items) ? payload.items.map(normalizeTaskTemplate).find(Boolean) ?? null : null
      setTemplate(nextTemplate)
      if (!nextTemplate) setError(t('projects.templates.task.detail.notFound', 'Task template not found.'))
    } catch (err) {
      setError(err instanceof Error ? err.message : t('projects.templates.task.detail.loadError', 'Failed to load task template.'))
    } finally {
      setLoading(false)
    }
  }, [id, t])

  React.useEffect(() => { void loadTemplate() }, [loadTemplate])

  if (loading) {
    return <Page><PageBody><LoadingMessage label={t('common.loading', 'Loading...')} /></PageBody></Page>
  }
  if (error || !template) {
    return (
      <Page>
        <PageBody>
          <ErrorMessage label={error ?? t('projects.templates.task.detail.notFound', 'Task template not found.')} />
          <Button asChild className="mt-4"><a href="/backend/projects/task-templates">{t('projects.templates.task.detail.back', 'Back to task templates')}</a></Button>
        </PageBody>
      </Page>
    )
  }

  return (
    <Page>
      <PageBody>
        <ProjectTaskTemplateForm
          title={t('projects.templates.task.detail.title', 'Task template')}
          backHref="/backend/projects/task-templates"
          cancelHref="/backend/projects/task-templates"
          submitLabel={t('common.save', 'Save')}
          initialValues={template}
          onSubmit={async (values) => {
            await updateCrud('projects/task-templates', { ...values, id: template.id })
            flash(t('projects.templates.task.detail.flash', 'Task template updated.'), 'success')
            await loadTemplate()
          }}
        />
      </PageBody>
    </Page>
  )
}
