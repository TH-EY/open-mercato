"use client"

import * as React from 'react'
import { Button } from '@open-mercato/ui/primitives/button'
import { Input } from '@open-mercato/ui/primitives/input'
import { Textarea } from '@open-mercato/ui/primitives/textarea'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@open-mercato/ui/primitives/dialog'
import { apiCall, readApiResultOrThrow } from '@open-mercato/ui/backend/utils/apiCall'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { useGuardedMutation } from '@open-mercato/ui/backend/injection/useGuardedMutation'
import { AttachmentInput } from '@open-mercato/core/modules/attachments/fields/attachment'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { CalendarDays, Paperclip, Plus, Trash2, UserRound } from 'lucide-react'
import { E } from '#generated/entities.ids.generated'
import { projectTaskStatusLabels, projectTaskStatuses, type ProjectTaskStatus } from '../lib/statuses'
import { useProjectReferenceOptions } from './ProjectForm'

type TaskRow = {
  id: string
  projectId: string
  name: string
  status: ProjectTaskStatus
  description: string | null
  ownerUserId: string | null
  deadlineAt: string | null
  position: number
  updatedAt: string | null
}

type TaskDraft = {
  id?: string
  name: string
  status: ProjectTaskStatus
  description: string
  ownerUserId: string
  deadlineAt: string
}

type TasksResponse = {
  items?: Record<string, unknown>[]
}

const emptyDraft = (status: ProjectTaskStatus): TaskDraft => ({
  name: '',
  status,
  description: '',
  ownerUserId: '',
  deadlineAt: '',
})

const taskDragDataType = 'application/x-open-mercato-project-task'

function normalizeTask(item: Record<string, unknown>): TaskRow | null {
  const id = typeof item.id === 'string' ? item.id : null
  if (!id) return null
  const status = projectTaskStatuses.includes(item.status as ProjectTaskStatus)
    ? item.status as ProjectTaskStatus
    : 'todo'
  return {
    id,
    projectId: typeof item.projectId === 'string'
      ? item.projectId
      : typeof item.project_id === 'string'
        ? item.project_id
        : '',
    name: typeof item.name === 'string' ? item.name : id,
    status,
    description: typeof item.description === 'string' ? item.description : null,
    ownerUserId: typeof item.ownerUserId === 'string'
      ? item.ownerUserId
      : typeof item.owner_user_id === 'string'
        ? item.owner_user_id
        : null,
    deadlineAt: typeof item.deadlineAt === 'string'
      ? item.deadlineAt
      : typeof item.deadline_at === 'string'
        ? item.deadline_at
        : null,
    position: typeof item.position === 'number' ? item.position : Number(item.position ?? 0),
    updatedAt: typeof item.updatedAt === 'string'
      ? item.updatedAt
      : typeof item.updated_at === 'string'
        ? item.updated_at
        : null,
  }
}

function dateForInput(value: string | null): string {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toISOString().slice(0, 10)
}

function normalizeDateInput(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  return new Date(`${trimmed}T00:00:00.000Z`).toISOString()
}

function reorderTasks(tasks: TaskRow[], taskId: string, nextStatus: ProjectTaskStatus, beforeId?: string): TaskRow[] {
  const moving = tasks.find((task) => task.id === taskId)
  if (!moving) return tasks
  const withoutMoving = tasks.filter((task) => task.id !== taskId)
  const nextMoving = { ...moving, status: nextStatus }
  const beforeIndex = beforeId
    ? withoutMoving.findIndex((task) => task.id === beforeId && task.status === nextStatus)
    : -1
  const targetIndex = beforeIndex >= 0 ? beforeIndex : withoutMoving.length
  const result = [
    ...withoutMoving.slice(0, targetIndex),
    nextMoving,
    ...withoutMoving.slice(targetIndex),
  ]
  return projectTaskStatuses.flatMap((status) =>
    result
      .filter((task) => task.status === status)
      .map((task, index) => ({ ...task, position: index })),
  )
}

export function ProjectBoard({ projectId }: { projectId: string }) {
  const t = useT()
  const { users } = useProjectReferenceOptions()
  const userMap = React.useMemo(() => new Map(users.map((user) => [user.id, user.label])), [users])
  const [tasks, setTasks] = React.useState<TaskRow[]>([])
  const [attachmentCounts, setAttachmentCounts] = React.useState<Map<string, number>>(new Map())
  const [loading, setLoading] = React.useState(true)
  const [dialogOpen, setDialogOpen] = React.useState(false)
  const [draft, setDraft] = React.useState<TaskDraft>(() => emptyDraft('todo'))
  const [draggingTaskId, setDraggingTaskId] = React.useState<string | null>(null)
  const { runMutation, retryLastMutation } = useGuardedMutation<{ projectId: string; retryLastMutation: () => Promise<boolean> }>({
    contextId: `projects.board.${projectId}`,
  })

  const loadAttachmentCounts = React.useCallback(async (items: TaskRow[]) => {
    const entries = await Promise.all(items.map(async (task) => {
      const payload = await apiCall<{ items?: unknown[] }>(
        `/api/attachments?entityId=${encodeURIComponent(E.projects.project_task)}&recordId=${encodeURIComponent(task.id)}`,
        { cache: 'no-store' },
      ).then((call) => call.result).catch(() => null)
      return [task.id, Array.isArray(payload?.items) ? payload.items.length : 0] as const
    }))
    setAttachmentCounts(new Map(entries))
  }, [])

  const loadTasks = React.useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams({
        page: '1',
        pageSize: '100',
        projectId,
        sortField: 'position',
        sortDir: 'asc',
      })
      const payload = await readApiResultOrThrow<TasksResponse>(`/api/projects/tasks?${params.toString()}`, { cache: 'no-store' })
      const nextTasks = (Array.isArray(payload.items) ? payload.items : [])
        .map(normalizeTask)
        .filter((task): task is TaskRow => task !== null)
        .sort((a, b) => a.status.localeCompare(b.status) || a.position - b.position)
      setTasks(nextTasks)
      void loadAttachmentCounts(nextTasks)
    } finally {
      setLoading(false)
    }
  }, [loadAttachmentCounts, projectId])

  React.useEffect(() => { void loadTasks() }, [loadTasks])

  const openCreate = React.useCallback((status: ProjectTaskStatus) => {
    setDraft(emptyDraft(status))
    setDialogOpen(true)
  }, [])

  const openEdit = React.useCallback((task: TaskRow) => {
    setDraft({
      id: task.id,
      name: task.name,
      status: task.status,
      description: task.description ?? '',
      ownerUserId: task.ownerUserId ?? '',
      deadlineAt: dateForInput(task.deadlineAt),
    })
    setDialogOpen(true)
  }, [])

  const saveTask = React.useCallback(async () => {
    const payload = {
      id: draft.id,
      projectId,
      name: draft.name.trim(),
      status: draft.status,
      description: draft.description.trim() || null,
      ownerUserId: draft.ownerUserId || null,
      deadlineAt: normalizeDateInput(draft.deadlineAt),
    }
    if (!payload.name) return
    const result = await runMutation({
      context: { projectId, retryLastMutation },
      mutationPayload: payload,
      operation: async () => {
        if (draft.id) {
          return apiCall('/api/projects/tasks', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
          })
        }
        return apiCall<{ id?: string | null }>('/api/projects/tasks', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        })
      },
    })
    const createdId = !draft.id && typeof result.result?.id === 'string' ? result.result.id : null
    if (createdId) setDraft((prev) => ({ ...prev, id: createdId }))
    flash(t('projects.tasks.flash.saved', 'Task saved.'), 'success')
    await loadTasks()
    if (draft.id) setDialogOpen(false)
  }, [draft, loadTasks, projectId, retryLastMutation, runMutation, t])

  const handleTaskDialogKeyDown = React.useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault()
      void saveTask()
    }
    if (event.key === 'Escape') {
      setDialogOpen(false)
    }
  }, [saveTask])

  const deleteTask = React.useCallback(async () => {
    if (!draft.id) return
    const id = draft.id
    await runMutation({
      context: { projectId, retryLastMutation },
      mutationPayload: { id },
      operation: () => apiCall(`/api/projects/tasks?id=${encodeURIComponent(id)}`, { method: 'DELETE' }),
    })
    flash(t('projects.tasks.flash.deleted', 'Task deleted.'), 'success')
    setDialogOpen(false)
    await loadTasks()
  }, [draft.id, loadTasks, projectId, retryLastMutation, runMutation, t])

  const persistOrder = React.useCallback(async (nextTasks: TaskRow[]) => {
    setTasks(nextTasks)
    await runMutation({
      context: { projectId, retryLastMutation },
      mutationPayload: { projectId, moves: nextTasks.map((task) => ({ id: task.id, status: task.status, position: task.position })) },
      operation: () => apiCall('/api/projects/tasks/reorder', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          projectId,
          moves: nextTasks.map((task) => ({ id: task.id, status: task.status, position: task.position })),
        }),
      }),
    })
  }, [projectId, retryLastMutation, runMutation])

  const handleDrop = React.useCallback(async (status: ProjectTaskStatus, beforeId?: string, droppedTaskId?: string) => {
    const taskId = droppedTaskId || draggingTaskId
    if (!taskId) return
    const nextTasks = reorderTasks(tasks, taskId, status, beforeId)
    setDraggingTaskId(null)
    await persistOrder(nextTasks)
  }, [draggingTaskId, persistOrder, tasks])

  const readDraggedTaskId = React.useCallback((event: React.DragEvent<HTMLElement>) => (
    event.dataTransfer.getData(taskDragDataType) || event.dataTransfer.getData('text/plain') || undefined
  ), [])

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">{t('projects.detail.tasks', 'Tasks')}</h2>
        <Button type="button" onClick={() => openCreate('todo')}>
          <Plus className="mr-2 h-4 w-4" />
          {t('projects.tasks.create', 'Add task')}
        </Button>
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        {projectTaskStatuses.map((status) => {
          const columnTasks = tasks.filter((task) => task.status === status).sort((a, b) => a.position - b.position)
          return (
            <div
              key={status}
              className="min-h-[360px] rounded-md border bg-muted/20 p-3"
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault()
                void handleDrop(status, undefined, readDraggedTaskId(event))
              }}
            >
              <div className="mb-3 flex items-center justify-between gap-2">
                <div className="text-sm font-semibold">{projectTaskStatusLabels[status]}</div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label={t('projects.tasks.createInColumn', 'Add task to {status}', { status: projectTaskStatusLabels[status] })}
                  onClick={() => openCreate(status)}
                >
                  <Plus className="h-4 w-4" />
                </Button>
              </div>
              <div className="space-y-2">
                {loading && columnTasks.length === 0 ? (
                  <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">{t('common.loading', 'Loading...')}</div>
                ) : null}
                {columnTasks.map((task) => (
                  <button
                    key={task.id}
                    type="button"
                    draggable
                    onDragStart={(event) => {
                      setDraggingTaskId(task.id)
                      event.dataTransfer.effectAllowed = 'move'
                      event.dataTransfer.setData(taskDragDataType, task.id)
                      event.dataTransfer.setData('text/plain', task.id)
                    }}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={(event) => {
                      event.preventDefault()
                      event.stopPropagation()
                      void handleDrop(status, task.id, readDraggedTaskId(event))
                    }}
                    onClick={() => openEdit(task)}
                    className="w-full rounded-md border bg-background p-3 text-left shadow-sm transition hover:border-primary/60"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 font-medium">{task.name}</div>
                      {attachmentCounts.get(task.id) ? <Paperclip className="h-4 w-4 shrink-0 text-muted-foreground" /> : null}
                    </div>
                    {task.description ? (
                      <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{task.description}</p>
                    ) : null}
                    <div className="mt-3 flex flex-wrap gap-2 text-xs text-muted-foreground">
                      {task.ownerUserId ? (
                        <span className="inline-flex items-center gap-1"><UserRound className="h-3 w-3" />{userMap.get(task.ownerUserId) ?? task.ownerUserId}</span>
                      ) : null}
                      {task.deadlineAt ? (
                        <span className="inline-flex items-center gap-1"><CalendarDays className="h-3 w-3" />{dateForInput(task.deadlineAt)}</span>
                      ) : null}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )
        })}
      </div>
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-2xl" onKeyDown={handleTaskDialogKeyDown}>
          <DialogHeader>
            <DialogTitle>{draft.id ? t('projects.tasks.dialog.edit', 'Edit task') : t('projects.tasks.dialog.create', 'Create task')}</DialogTitle>
            <DialogDescription>
              {t('projects.tasks.dialog.description', 'Manage task details, ownership, deadline, and attachments.')}
            </DialogDescription>
          </DialogHeader>
          <div
            className="space-y-4"
          >
            <div className="grid gap-3 md:grid-cols-2">
              <label className="space-y-1 text-sm">
                <span>{t('projects.tasks.form.name', 'Name')}</span>
                <Input value={draft.name} onChange={(event) => setDraft((prev) => ({ ...prev, name: event.target.value }))} />
              </label>
              <label className="space-y-1 text-sm">
                <span>{t('projects.tasks.form.status', 'Status')}</span>
                <select
                  className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                  value={draft.status}
                  onChange={(event) => setDraft((prev) => ({ ...prev, status: event.target.value as ProjectTaskStatus }))}
                >
                  {projectTaskStatuses.map((status) => (
                    <option key={status} value={status}>{projectTaskStatusLabels[status]}</option>
                  ))}
                </select>
              </label>
              <label className="space-y-1 text-sm">
                <span>{t('projects.tasks.form.owner', 'Owner')}</span>
                <select
                  className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                  value={draft.ownerUserId}
                  onChange={(event) => setDraft((prev) => ({ ...prev, ownerUserId: event.target.value }))}
                >
                  <option value="">{t('projects.form.owner.none', 'No owner')}</option>
                  {users.map((user) => <option key={user.id} value={user.id}>{user.label}</option>)}
                </select>
              </label>
              <label className="space-y-1 text-sm">
                <span>{t('projects.tasks.form.deadline', 'Deadline')}</span>
                <Input type="date" value={draft.deadlineAt} onChange={(event) => setDraft((prev) => ({ ...prev, deadlineAt: event.target.value }))} />
              </label>
            </div>
            <label className="space-y-1 text-sm">
              <span>{t('projects.tasks.form.description', 'Description')}</span>
              <Textarea rows={4} value={draft.description} onChange={(event) => setDraft((prev) => ({ ...prev, description: event.target.value }))} />
            </label>
            {draft.id ? (
              <div className="rounded-md border p-3">
                <AttachmentInput entityId={E.projects.project_task} recordId={draft.id} def={{ key: 'attachments', kind: 'attachment' }} />
              </div>
            ) : null}
            <div className="flex justify-between gap-3">
              <div>
                {draft.id ? (
                  <Button type="button" variant="destructive" onClick={() => { void deleteTask() }}>
                    <Trash2 className="mr-2 h-4 w-4" />
                    {t('common.delete', 'Delete')}
                  </Button>
                ) : null}
              </div>
              <div className="flex gap-2">
                <Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>{t('common.cancel', 'Cancel')}</Button>
                <Button type="button" onClick={() => { void saveTask() }}>{t('common.save', 'Save')}</Button>
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  )
}
