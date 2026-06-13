"use client"

import * as React from 'react'
import { usePathname } from 'next/navigation'
import { Plus, Trash2 } from 'lucide-react'
import { Page, PageBody } from '@open-mercato/ui/backend/Page'
import { updateCrud } from '@open-mercato/ui/backend/utils/crud'
import { apiCall, readApiResultOrThrow } from '@open-mercato/ui/backend/utils/apiCall'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { LoadingMessage, ErrorMessage } from '@open-mercato/ui/backend/detail'
import { useConfirmDialog } from '@open-mercato/ui/backend/confirm-dialog'
import { useGuardedMutation } from '@open-mercato/ui/backend/injection/useGuardedMutation'
import { Button } from '@open-mercato/ui/primitives/button'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { projectTaskStatusLabels } from '../../../../lib/statuses'
import { resolveProjectPathnameId, resolveRouteId } from '../../../../lib/route-id'
import {
  normalizeProjectTemplate,
  normalizeProjectTemplateTask,
  ProjectTemplateForm,
  ProjectTemplateTaskEditor,
  type ProjectTemplateTaskValues,
  type ProjectTemplateValues,
  useTaskTemplates,
} from '../../../../components/TemplateForms'
import { useProjectReferenceOptions } from '../../../../components/ProjectForm'

type PageProps = {
  params?: { id?: string | string[] }
}

type ResponsePayload = {
  items?: Record<string, unknown>[]
}

export default function ProjectTemplateDetailPage({ params }: PageProps) {
  const t = useT()
  const pathname = usePathname()
  const id = resolveRouteId(params?.id) ?? resolveProjectPathnameId(pathname)
  const { confirm, ConfirmDialogElement } = useConfirmDialog()
  const { templates: taskTemplates, reload: reloadTaskTemplates } = useTaskTemplates()
  const { users } = useProjectReferenceOptions()
  const [template, setTemplate] = React.useState<ProjectTemplateValues | null>(null)
  const [templateTasks, setTemplateTasks] = React.useState<ProjectTemplateTaskValues[]>([])
  const [editingTask, setEditingTask] = React.useState<Partial<ProjectTemplateTaskValues> | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const { runMutation, retryLastMutation } = useGuardedMutation<{ retryLastMutation: () => Promise<boolean>; projectTemplateId: string }>({
    contextId: `projects.templates.${id ?? 'unknown'}`,
  })

  const taskTemplateMap = React.useMemo(() => new Map(taskTemplates.map((taskTemplate) => [taskTemplate.id ?? '', taskTemplate])), [taskTemplates])
  const userMap = React.useMemo(() => new Map(users.map((user) => [user.id, user.label])), [users])

  const loadTemplate = React.useCallback(async () => {
    if (!id) {
      setLoading(false)
      setError(t('projects.templates.project.detail.notFound', 'Project template not found.'))
      return
    }
    setLoading(true)
    setError(null)
    try {
      const [templatePayload, tasksPayload] = await Promise.all([
        readApiResultOrThrow<ResponsePayload>(`/api/projects/templates?page=1&pageSize=1&ids=${encodeURIComponent(id)}`),
        readApiResultOrThrow<ResponsePayload>(`/api/projects/templates/tasks?page=1&pageSize=100&projectTemplateId=${encodeURIComponent(id)}&sortField=position&sortDir=asc`),
      ])
      const nextTemplate = Array.isArray(templatePayload.items) ? templatePayload.items.map(normalizeProjectTemplate).find(Boolean) ?? null : null
      setTemplate(nextTemplate)
      setTemplateTasks(Array.isArray(tasksPayload.items) ? tasksPayload.items.map(normalizeProjectTemplateTask).filter((task): task is ProjectTemplateTaskValues => task !== null).sort((a, b) => (a.position ?? 0) - (b.position ?? 0)) : [])
      if (!nextTemplate) setError(t('projects.templates.project.detail.notFound', 'Project template not found.'))
      await reloadTaskTemplates()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('projects.templates.project.detail.loadError', 'Failed to load project template.'))
    } finally {
      setLoading(false)
    }
  }, [id, reloadTaskTemplates, t])

  React.useEffect(() => { void loadTemplate() }, [loadTemplate])

  const saveTemplateTask = React.useCallback(async (values: ProjectTemplateTaskValues) => {
    if (!id) return
    const payload = { ...values, projectTemplateId: id }
    await runMutation({
      context: { retryLastMutation, projectTemplateId: id },
      mutationPayload: payload,
      operation: () => apiCall('/api/projects/templates/tasks', {
        method: values.id ? 'PUT' : 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      }),
    })
    flash(t('projects.templates.project.tasks.flash.saved', 'Template task saved.'), 'success')
    setEditingTask(null)
    await loadTemplate()
  }, [id, loadTemplate, retryLastMutation, runMutation, t])

  const deleteTemplateTask = React.useCallback(async (task: ProjectTemplateTaskValues) => {
    if (!task.id || !id) return
    const ok = await confirm({
      title: t('projects.templates.project.tasks.delete.title', 'Delete template task'),
      description: t('projects.templates.project.tasks.delete.description', 'This will remove the task from this project template.'),
      confirmText: t('common.delete', 'Delete'),
      variant: 'destructive',
    })
    if (!ok) return
    await runMutation({
      context: { retryLastMutation, projectTemplateId: id },
      mutationPayload: { id: task.id },
      operation: () => apiCall(`/api/projects/templates/tasks?id=${encodeURIComponent(task.id ?? '')}`, { method: 'DELETE' }),
    })
    flash(t('projects.templates.project.tasks.flash.deleted', 'Template task deleted.'), 'success')
    await loadTemplate()
  }, [confirm, id, loadTemplate, retryLastMutation, runMutation, t])

  if (loading) {
    return <Page><PageBody><LoadingMessage label={t('common.loading', 'Loading...')} /></PageBody></Page>
  }
  if (error || !template || !id) {
    return (
      <Page>
        <PageBody>
          <ErrorMessage label={error ?? t('projects.templates.project.detail.notFound', 'Project template not found.')} />
          <Button asChild className="mt-4"><a href="/backend/projects/templates">{t('projects.templates.project.detail.back', 'Back to project templates')}</a></Button>
        </PageBody>
      </Page>
    )
  }

  return (
    <Page>
      <PageBody className="space-y-6">
        <ProjectTemplateForm
          title={t('projects.templates.project.detail.title', 'Project template')}
          backHref="/backend/projects/templates"
          cancelHref="/backend/projects/templates"
          submitLabel={t('common.save', 'Save')}
          initialValues={template}
          onSubmit={async (values) => {
            await updateCrud('projects/templates', { ...values, id: template.id })
            flash(t('projects.templates.project.detail.flash', 'Project template updated.'), 'success')
            await loadTemplate()
          }}
        />
        <section className="space-y-4">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-lg font-semibold">{t('projects.templates.project.tasks.title', 'Template tasks')}</h2>
            <Button type="button" onClick={() => setEditingTask({ projectTemplateId: id, position: templateTasks.length })}>
              <Plus className="mr-2 h-4 w-4" />
              {t('projects.templates.project.tasks.add', 'Add task')}
            </Button>
          </div>
          {editingTask ? (
            <ProjectTemplateTaskEditor
              projectTemplateId={id}
              taskTemplates={taskTemplates}
              users={users}
              initialValues={editingTask}
              onCancel={() => setEditingTask(null)}
              onSave={saveTemplateTask}
            />
          ) : null}
          <div className="space-y-2">
            {templateTasks.length === 0 ? (
              <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">{t('projects.templates.project.tasks.empty', 'No tasks in this template yet.')}</div>
            ) : null}
            {templateTasks.map((task) => {
              const taskTemplate = task.taskTemplateId ? taskTemplateMap.get(task.taskTemplateId) : null
              const name = task.name ?? taskTemplate?.name ?? t('projects.templates.project.tasks.unnamed', 'Unnamed task')
              const status = task.status ?? taskTemplate?.status ?? 'todo'
              const ownerId = task.ownerUserId ?? taskTemplate?.ownerUserId ?? null
              const dueInDays = task.dueInDays ?? taskTemplate?.dueInDays ?? null
              return (
                <div key={task.id} className="flex flex-col gap-3 rounded-md border p-3 md:flex-row md:items-center md:justify-between">
                  <div className="min-w-0 text-left">
                    <div className="font-medium">{(task.position ?? 0) + 1}. {name}</div>
                    <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                      <span>{projectTaskStatusLabels[status]}</span>
                      {taskTemplate ? <span>{t('projects.templates.project.tasks.fromTemplate', 'From {name}', { name: taskTemplate.name })}</span> : null}
                      {ownerId ? <span>{userMap.get(ownerId) ?? ownerId}</span> : null}
                      {dueInDays !== null ? <span>{t('projects.create.template.preview.due', 'Due in {days} days', { days: dueInDays })}</span> : null}
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <Button type="button" variant="outline" onClick={() => setEditingTask(task)}>{t('common.edit', 'Edit')}</Button>
                    <Button type="button" variant="destructive" onClick={() => { void deleteTemplateTask(task) }}>
                      <Trash2 className="mr-2 h-4 w-4" />
                      {t('common.delete', 'Delete')}
                    </Button>
                  </div>
                </div>
              )
            })}
          </div>
        </section>
        {ConfirmDialogElement}
      </PageBody>
    </Page>
  )
}
