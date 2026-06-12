"use client"

import * as React from 'react'
import { usePathname } from 'next/navigation'
import { Page, PageBody } from '@open-mercato/ui/backend/Page'
import { Button } from '@open-mercato/ui/primitives/button'
import { readApiResultOrThrow } from '@open-mercato/ui/backend/utils/apiCall'
import { updateCrud } from '@open-mercato/ui/backend/utils/crud'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { LoadingMessage, ErrorMessage } from '@open-mercato/ui/backend/detail'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { ProjectForm, useProjectReferenceOptions, type ProjectFormValues } from '../../../components/ProjectForm'
import { ProjectBoard } from '../../../components/ProjectBoard'
import { resolveProjectPathnameId, resolveRouteId } from '../../../lib/route-id'

type ProjectDetail = ProjectFormValues & {
  id: string
  updatedAt?: string | null
  openTaskCount?: number
  doneTaskCount?: number
}

type ProjectsResponse = {
  items?: Record<string, unknown>[]
}

type ProjectDetailPageProps = {
  params?: {
    id?: string | string[]
  }
}

function normalizeProject(item: Record<string, unknown>): ProjectDetail | null {
  const id = typeof item.id === 'string' ? item.id : null
  if (!id) return null
  return {
    id,
    name: typeof item.name === 'string' ? item.name : id,
    orderId: typeof item.orderId === 'string' ? item.orderId : typeof item.order_id === 'string' ? item.order_id : null,
    ownerUserId: typeof item.ownerUserId === 'string' ? item.ownerUserId : typeof item.owner_user_id === 'string' ? item.owner_user_id : null,
    isActive: item.isActive !== false && item.is_active !== false,
    updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : typeof item.updated_at === 'string' ? item.updated_at : null,
    openTaskCount: typeof item.openTaskCount === 'number' ? item.openTaskCount : Number(item.openTaskCount ?? 0),
    doneTaskCount: typeof item.doneTaskCount === 'number' ? item.doneTaskCount : Number(item.doneTaskCount ?? 0),
  }
}

export default function ProjectDetailPage({ params }: ProjectDetailPageProps) {
  const t = useT()
  const pathname = usePathname()
  const projectId = resolveRouteId(params?.id) ?? resolveProjectPathnameId(pathname)
  const { orders, users } = useProjectReferenceOptions()
  const orderMap = React.useMemo(() => new Map(orders.map((order) => [order.id, order.label])), [orders])
  const userMap = React.useMemo(() => new Map(users.map((user) => [user.id, user.label])), [users])
  const [project, setProject] = React.useState<ProjectDetail | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)

  const loadProject = React.useCallback(async () => {
    if (!projectId) {
      setLoading(false)
      setError(t('projects.detail.notFound', 'Project not found.'))
      return
    }
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams({ page: '1', pageSize: '1', ids: projectId })
      const payload = await readApiResultOrThrow<ProjectsResponse>(`/api/projects?${params.toString()}`)
      const nextProject = Array.isArray(payload.items) ? payload.items.map(normalizeProject).find(Boolean) ?? null : null
      setProject(nextProject)
      if (!nextProject) setError(t('projects.detail.notFound', 'Project not found.'))
    } catch (err) {
      setError(err instanceof Error ? err.message : t('projects.detail.loadError', 'Failed to load project.'))
    } finally {
      setLoading(false)
    }
  }, [projectId, t])

  React.useEffect(() => { void loadProject() }, [loadProject])

  if (loading) {
    return (
      <Page>
        <PageBody><LoadingMessage label={t('common.loading', 'Loading...')} /></PageBody>
      </Page>
    )
  }

  if (error || !project) {
    return (
      <Page>
        <PageBody>
          <ErrorMessage label={error ?? t('projects.detail.notFound', 'Project not found.')} />
          <Button asChild className="mt-4"><a href="/backend/projects">{t('projects.detail.back', 'Back to projects')}</a></Button>
        </PageBody>
      </Page>
    )
  }

  return (
    <Page>
      <PageBody className="space-y-6">
        <div className="flex flex-col gap-2 border-b pb-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h1 className="text-2xl font-semibold">{project.name}</h1>
              <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
                <span>{t('projects.detail.order', 'Order')}: {project.orderId ? orderMap.get(project.orderId) ?? project.orderId : t('projects.form.order.none', 'No order')}</span>
                <span>{t('projects.detail.owner', 'Owner')}: {project.ownerUserId ? userMap.get(project.ownerUserId) ?? project.ownerUserId : t('projects.form.owner.none', 'No owner')}</span>
                <span>{t('projects.detail.tasks.summary', '{open} open / {done} done', { open: project.openTaskCount ?? 0, done: project.doneTaskCount ?? 0 })}</span>
              </div>
            </div>
            <Button asChild variant="outline"><a href="/backend/projects">{t('projects.detail.back', 'Back to projects')}</a></Button>
          </div>
        </div>
        <ProjectForm
          title={t('projects.detail.editTitle', 'Project details')}
          backHref="/backend/projects"
          cancelHref="/backend/projects"
          submitLabel={t('common.save', 'Save')}
          initialValues={project}
          onSubmit={async (values) => {
            await updateCrud('projects', { ...values, id: project.id })
            flash(t('projects.detail.flash.updated', 'Project updated.'), 'success')
            await loadProject()
          }}
        />
        <ProjectBoard projectId={project.id} />
      </PageBody>
    </Page>
  )
}
