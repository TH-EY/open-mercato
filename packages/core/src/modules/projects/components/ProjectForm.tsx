"use client"

import * as React from 'react'
import { CrudForm, type CrudField, type CrudFormGroup } from '@open-mercato/ui/backend/CrudForm'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { E } from '#generated/entities.ids.generated'
import { projectTaskStatusLabels, projectTaskStatuses, type ProjectTaskStatus } from '../lib/statuses'

export type ProjectFormValues = {
  id?: string
  name: string
  orderId?: string | null
  ownerUserId?: string | null
  templateId?: string | null
  isActive?: boolean
  updatedAt?: string | null
}

type Option = {
  id: string
  label: string
}

type ProjectTemplateOption = Option & {
  description?: string | null
}

type TaskTemplateRow = {
  id: string
  name: string
  status: ProjectTaskStatus
  ownerUserId: string | null
  dueInDays: number | null
}

type ProjectTemplateTaskRow = {
  id: string
  taskTemplateId: string | null
  name: string | null
  status: ProjectTaskStatus | null
  ownerUserId: string | null
  dueInDays: number | null
  position: number
}

type ProjectFormProps = {
  title: string
  initialValues: Partial<ProjectFormValues>
  submitLabel: string
  backHref: string
  cancelHref: string
  enableTemplateSelection?: boolean
  onSubmit: (values: ProjectFormValues) => Promise<void>
}

function normalizeOrder(item: Record<string, unknown>): Option | null {
  const id = typeof item.id === 'string' ? item.id : null
  if (!id) return null
  const number = typeof item.orderNumber === 'string'
    ? item.orderNumber
    : typeof item.order_number === 'string'
      ? item.order_number
      : id
  return { id, label: number }
}

function normalizeUser(item: Record<string, unknown>): Option | null {
  const id = typeof item.id === 'string' ? item.id : null
  if (!id) return null
  const name = typeof item.name === 'string' && item.name.trim().length ? item.name.trim() : null
  const email = typeof item.email === 'string' && item.email.trim().length ? item.email.trim() : null
  return { id, label: name ?? email ?? id }
}

function normalizeProjectTemplate(item: Record<string, unknown>): ProjectTemplateOption | null {
  const id = typeof item.id === 'string' ? item.id : null
  if (!id) return null
  return {
    id,
    label: typeof item.name === 'string' ? item.name : id,
    description: typeof item.description === 'string' ? item.description : null,
  }
}

function normalizeTaskTemplate(item: Record<string, unknown>): TaskTemplateRow | null {
  const id = typeof item.id === 'string' ? item.id : null
  if (!id) return null
  const status = projectTaskStatuses.includes(item.status as ProjectTaskStatus) ? item.status as ProjectTaskStatus : 'todo'
  return {
    id,
    name: typeof item.name === 'string' ? item.name : id,
    status,
    ownerUserId: typeof item.ownerUserId === 'string' ? item.ownerUserId : typeof item.owner_user_id === 'string' ? item.owner_user_id : null,
    dueInDays: typeof item.dueInDays === 'number' ? item.dueInDays : typeof item.due_in_days === 'number' ? item.due_in_days : null,
  }
}

function normalizeTemplateTask(item: Record<string, unknown>): ProjectTemplateTaskRow | null {
  const id = typeof item.id === 'string' ? item.id : null
  if (!id) return null
  const status = projectTaskStatuses.includes(item.status as ProjectTaskStatus) ? item.status as ProjectTaskStatus : null
  return {
    id,
    taskTemplateId: typeof item.taskTemplateId === 'string' ? item.taskTemplateId : typeof item.task_template_id === 'string' ? item.task_template_id : null,
    name: typeof item.name === 'string' ? item.name : null,
    status,
    ownerUserId: typeof item.ownerUserId === 'string' ? item.ownerUserId : typeof item.owner_user_id === 'string' ? item.owner_user_id : null,
    dueInDays: typeof item.dueInDays === 'number' ? item.dueInDays : typeof item.due_in_days === 'number' ? item.due_in_days : null,
    position: typeof item.position === 'number' ? item.position : Number(item.position ?? 0),
  }
}

export function useProjectReferenceOptions() {
  const [orders, setOrders] = React.useState<Option[]>([])
  const [users, setUsers] = React.useState<Option[]>([])

  React.useEffect(() => {
    let cancelled = false
    async function load() {
      const [ordersPayload, usersPayload] = await Promise.all([
        apiCall<{ items?: Record<string, unknown>[] }>('/api/sales/orders?page=1&pageSize=100')
          .then((call) => call.result)
          .catch(() => null),
        apiCall<{ items?: Record<string, unknown>[] }>('/api/auth/users?page=1&pageSize=100')
          .then((call) => call.result)
          .catch(() => null),
      ])
      if (cancelled) return
      const nextOrders = Array.isArray(ordersPayload?.items)
        ? ordersPayload.items.map(normalizeOrder).filter((option): option is Option => option !== null)
        : []
      const nextUsers = Array.isArray(usersPayload?.items)
        ? usersPayload.items.map(normalizeUser).filter((option): option is Option => option !== null)
        : []
      setOrders(nextOrders)
      setUsers(nextUsers)
    }
    void load()
    return () => { cancelled = true }
  }, [])

  return { orders, users }
}

function useProjectTemplates() {
  const [templates, setTemplates] = React.useState<ProjectTemplateOption[]>([])
  React.useEffect(() => {
    let cancelled = false
    async function load() {
      const payload = await apiCall<{ items?: Record<string, unknown>[] }>('/api/projects/templates?page=1&pageSize=100&isActive=true')
        .then((call) => call.result)
        .catch(() => null)
      if (cancelled) return
      setTemplates(Array.isArray(payload?.items) ? payload.items.map(normalizeProjectTemplate).filter((option): option is ProjectTemplateOption => option !== null) : [])
    }
    void load()
    return () => { cancelled = true }
  }, [])
  return templates
}

function OptionSelect({
  value,
  onChange,
  options,
  emptyLabel,
}: {
  value: unknown
  onChange: (next: string | null) => void
  options: Option[]
  emptyLabel: string
}) {
  const selected = typeof value === 'string' ? value : ''
  return (
    <select
      className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
      value={selected}
      onChange={(event) => onChange(event.target.value || null)}
    >
      <option value="">{emptyLabel}</option>
      {options.map((option) => (
        <option key={option.id} value={option.id}>{option.label}</option>
      ))}
    </select>
  )
}

function ProjectTemplatePreview({ templateId, users }: { templateId: string | null; users: Option[] }) {
  const t = useT()
  const [tasks, setTasks] = React.useState<ProjectTemplateTaskRow[]>([])
  const [taskTemplates, setTaskTemplates] = React.useState<TaskTemplateRow[]>([])

  React.useEffect(() => {
    let cancelled = false
    async function load() {
      if (!templateId) {
        setTasks([])
        return
      }
      const [templateTasksPayload, taskTemplatesPayload] = await Promise.all([
        apiCall<{ items?: Record<string, unknown>[] }>(`/api/projects/templates/tasks?page=1&pageSize=100&projectTemplateId=${encodeURIComponent(templateId)}&sortField=position&sortDir=asc`)
          .then((call) => call.result)
          .catch(() => null),
        apiCall<{ items?: Record<string, unknown>[] }>('/api/projects/task-templates?page=1&pageSize=100')
          .then((call) => call.result)
          .catch(() => null),
      ])
      if (cancelled) return
      setTasks(Array.isArray(templateTasksPayload?.items) ? templateTasksPayload.items.map(normalizeTemplateTask).filter((task): task is ProjectTemplateTaskRow => task !== null) : [])
      setTaskTemplates(Array.isArray(taskTemplatesPayload?.items) ? taskTemplatesPayload.items.map(normalizeTaskTemplate).filter((task): task is TaskTemplateRow => task !== null) : [])
    }
    void load()
    return () => { cancelled = true }
  }, [templateId])

  if (!templateId) return null
  const taskTemplateMap = new Map(taskTemplates.map((template) => [template.id, template]))
  const userMap = new Map(users.map((user) => [user.id, user.label]))
  return (
    <div className="rounded-md border bg-muted/20 p-3">
      {tasks.length === 0 ? (
        <div className="text-sm text-muted-foreground">{t('projects.create.template.preview.empty', 'This template has no tasks yet.')}</div>
      ) : (
        <div className="space-y-2">
          {tasks
            .slice()
            .sort((a, b) => a.position - b.position)
            .map((task) => {
              const taskTemplate = task.taskTemplateId ? taskTemplateMap.get(task.taskTemplateId) : null
              const name = task.name ?? taskTemplate?.name ?? t('projects.create.template.preview.unnamed', 'Unnamed task')
              const status = task.status ?? taskTemplate?.status ?? 'todo'
              const owner = task.ownerUserId ?? taskTemplate?.ownerUserId ?? null
              const dueInDays = task.dueInDays ?? taskTemplate?.dueInDays ?? null
              return (
                <div key={task.id} className="rounded-md border bg-background p-2 text-sm">
                  <div className="font-medium">{task.position + 1}. {name}</div>
                  <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    <span>{projectTaskStatusLabels[status]}</span>
                    {owner ? <span>{userMap.get(owner) ?? owner}</span> : null}
                    {dueInDays !== null ? <span>{t('projects.create.template.preview.due', 'Due in {days} days', { days: dueInDays })}</span> : null}
                  </div>
                </div>
              )
            })}
        </div>
      )}
    </div>
  )
}

export function ProjectForm({ title, initialValues, submitLabel, backHref, cancelHref, enableTemplateSelection = false, onSubmit }: ProjectFormProps) {
  const t = useT()
  const { orders, users } = useProjectReferenceOptions()
  const projectTemplates = useProjectTemplates()
  const [selectedTemplateId, setSelectedTemplateId] = React.useState<string | null>(
    typeof initialValues.templateId === 'string' ? initialValues.templateId : null,
  )

  const fields = React.useMemo<CrudField[]>(() => [
    { id: 'name', label: t('projects.form.name', 'Name'), type: 'text', required: true },
    ...(enableTemplateSelection ? [
      {
        id: 'templateId',
        label: t('projects.create.template.label', 'Project template'),
        type: 'custom' as const,
        component: ({ value, setValue }: { value: unknown; setValue: (value: unknown) => void }) => (
          <OptionSelect
            value={value}
            onChange={(next) => {
              setValue(next)
              setSelectedTemplateId(next)
            }}
            options={projectTemplates}
            emptyLabel={t('projects.create.template.none', 'No template')}
          />
        ),
      },
      {
        id: 'templatePreview',
        label: t('projects.create.template.preview', 'Template tasks'),
        type: 'custom' as const,
        component: () => <ProjectTemplatePreview templateId={selectedTemplateId} users={users} />,
      },
    ] : []),
    {
      id: 'orderId',
      label: t('projects.form.order', 'Order'),
      type: 'custom',
      component: ({ value, setValue }) => (
        <OptionSelect
          value={value}
          onChange={(next) => setValue(next)}
          options={orders}
          emptyLabel={t('projects.form.order.none', 'No order')}
        />
      ),
    },
    {
      id: 'ownerUserId',
      label: t('projects.form.owner', 'Owner'),
      type: 'custom',
      component: ({ value, setValue }) => (
        <OptionSelect
          value={value}
          onChange={(next) => setValue(next)}
          options={users}
          emptyLabel={t('projects.form.owner.none', 'No owner')}
        />
      ),
    },
    { id: 'isActive', label: t('projects.form.isActive', 'Active'), type: 'checkbox' },
  ], [enableTemplateSelection, orders, projectTemplates, selectedTemplateId, t, users])

  const groups = React.useMemo<CrudFormGroup[]>(() => [
    { id: 'details', title: t('projects.form.group.details', 'Details'), column: 1, fields: enableTemplateSelection ? ['name', 'templateId', 'templatePreview', 'orderId', 'ownerUserId', 'isActive'] : ['name', 'orderId', 'ownerUserId', 'isActive'] },
  ], [enableTemplateSelection, t])

  return (
    <CrudForm<ProjectFormValues>
      title={title}
      backHref={backHref}
      cancelHref={cancelHref}
      entityId={E.projects.project}
      fields={fields}
      groups={groups}
      initialValues={initialValues}
      submitLabel={submitLabel}
      onSubmit={onSubmit}
    />
  )
}
