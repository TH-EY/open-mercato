"use client"

import * as React from 'react'
import { CrudForm, type CrudField, type CrudFormGroup } from '@open-mercato/ui/backend/CrudForm'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import { Button } from '@open-mercato/ui/primitives/button'
import { Input } from '@open-mercato/ui/primitives/input'
import { Textarea } from '@open-mercato/ui/primitives/textarea'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { E } from '#generated/entities.ids.generated'
import { projectTaskStatusLabels, projectTaskStatuses, type ProjectTaskStatus } from '../lib/statuses'
import { useProjectReferenceOptions } from './ProjectForm'

export type ProjectTaskTemplateValues = {
  id?: string
  name: string
  status: ProjectTaskStatus
  description?: string | null
  ownerUserId?: string | null
  dueInDays?: number | null
  isActive?: boolean
  updatedAt?: string | null
}

export type ProjectTemplateValues = {
  id?: string
  name: string
  description?: string | null
  isActive?: boolean
  updatedAt?: string | null
}

export type ProjectTemplateTaskValues = {
  id?: string
  projectTemplateId: string
  taskTemplateId?: string | null
  name?: string | null
  status?: ProjectTaskStatus | null
  description?: string | null
  ownerUserId?: string | null
  dueInDays?: number | null
  position?: number | null
}

export type Option = {
  id: string
  label: string
}

export function normalizeTaskTemplate(item: Record<string, unknown>): ProjectTaskTemplateValues | null {
  const id = typeof item.id === 'string' ? item.id : null
  if (!id) return null
  const status = projectTaskStatuses.includes(item.status as ProjectTaskStatus) ? item.status as ProjectTaskStatus : 'todo'
  return {
    id,
    name: typeof item.name === 'string' ? item.name : id,
    status,
    description: typeof item.description === 'string' ? item.description : null,
    ownerUserId: typeof item.ownerUserId === 'string'
      ? item.ownerUserId
      : typeof item.owner_user_id === 'string'
        ? item.owner_user_id
        : null,
    dueInDays: typeof item.dueInDays === 'number'
      ? item.dueInDays
      : typeof item.due_in_days === 'number'
        ? item.due_in_days
        : null,
    isActive: item.isActive !== false && item.is_active !== false,
    updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : typeof item.updated_at === 'string' ? item.updated_at : null,
  }
}

export function normalizeProjectTemplate(item: Record<string, unknown>): ProjectTemplateValues | null {
  const id = typeof item.id === 'string' ? item.id : null
  if (!id) return null
  return {
    id,
    name: typeof item.name === 'string' ? item.name : id,
    description: typeof item.description === 'string' ? item.description : null,
    isActive: item.isActive !== false && item.is_active !== false,
    updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : typeof item.updated_at === 'string' ? item.updated_at : null,
  }
}

export function normalizeProjectTemplateTask(item: Record<string, unknown>): ProjectTemplateTaskValues | null {
  const id = typeof item.id === 'string' ? item.id : null
  if (!id) return null
  const status = projectTaskStatuses.includes(item.status as ProjectTaskStatus) ? item.status as ProjectTaskStatus : null
  return {
    id,
    projectTemplateId: typeof item.projectTemplateId === 'string'
      ? item.projectTemplateId
      : typeof item.project_template_id === 'string'
        ? item.project_template_id
        : '',
    taskTemplateId: typeof item.taskTemplateId === 'string'
      ? item.taskTemplateId
      : typeof item.task_template_id === 'string'
        ? item.task_template_id
        : null,
    name: typeof item.name === 'string' ? item.name : null,
    status,
    description: typeof item.description === 'string' ? item.description : null,
    ownerUserId: typeof item.ownerUserId === 'string'
      ? item.ownerUserId
      : typeof item.owner_user_id === 'string'
        ? item.owner_user_id
        : null,
    dueInDays: typeof item.dueInDays === 'number'
      ? item.dueInDays
      : typeof item.due_in_days === 'number'
        ? item.due_in_days
        : null,
    position: typeof item.position === 'number' ? item.position : Number(item.position ?? 0),
  }
}

export function OptionSelect({
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

export function useTaskTemplates() {
  const [templates, setTemplates] = React.useState<ProjectTaskTemplateValues[]>([])
  const load = React.useCallback(async () => {
    const payload = await apiCall<{ items?: Record<string, unknown>[] }>('/api/projects/task-templates?page=1&pageSize=100&isActive=true')
      .then((call) => call.result)
      .catch(() => null)
    setTemplates(Array.isArray(payload?.items) ? payload.items.map(normalizeTaskTemplate).filter((item): item is ProjectTaskTemplateValues => item !== null) : [])
  }, [])
  React.useEffect(() => { void load() }, [load])
  return { templates, reload: load }
}

export function useProjectTemplates() {
  const [templates, setTemplates] = React.useState<ProjectTemplateValues[]>([])
  const load = React.useCallback(async () => {
    const payload = await apiCall<{ items?: Record<string, unknown>[] }>('/api/projects/templates?page=1&pageSize=100&isActive=true')
      .then((call) => call.result)
      .catch(() => null)
    setTemplates(Array.isArray(payload?.items) ? payload.items.map(normalizeProjectTemplate).filter((item): item is ProjectTemplateValues => item !== null) : [])
  }, [])
  React.useEffect(() => { void load() }, [load])
  return { templates, reload: load }
}

export function ProjectTaskTemplateForm({
  title,
  initialValues,
  submitLabel,
  backHref,
  cancelHref,
  onSubmit,
}: {
  title: string
  initialValues: Partial<ProjectTaskTemplateValues>
  submitLabel: string
  backHref: string
  cancelHref: string
  onSubmit: (values: ProjectTaskTemplateValues) => Promise<void>
}) {
  const t = useT()
  const { users } = useProjectReferenceOptions()
  const fields = React.useMemo<CrudField[]>(() => [
    { id: 'name', label: t('projects.templates.task.form.name', 'Name'), type: 'text', required: true },
    {
      id: 'status',
      label: t('projects.templates.task.form.status', 'Status'),
      type: 'custom',
      component: ({ value, setValue }) => (
        <select
          className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
          value={typeof value === 'string' ? value : 'todo'}
          onChange={(event) => setValue(event.target.value)}
        >
          {projectTaskStatuses.map((status) => (
            <option key={status} value={status}>{projectTaskStatusLabels[status]}</option>
          ))}
        </select>
      ),
    },
    { id: 'description', label: t('projects.templates.task.form.description', 'Description'), type: 'textarea' },
    {
      id: 'ownerUserId',
      label: t('projects.templates.task.form.owner', 'Owner'),
      type: 'custom',
      component: ({ value, setValue }) => (
        <OptionSelect value={value} onChange={(next) => setValue(next)} options={users} emptyLabel={t('projects.form.owner.none', 'No owner')} />
      ),
    },
    { id: 'dueInDays', label: t('projects.templates.task.form.dueInDays', 'Due in days'), type: 'number' },
    { id: 'isActive', label: t('projects.form.isActive', 'Active'), type: 'checkbox' },
  ], [t, users])
  const groups = React.useMemo<CrudFormGroup[]>(() => [
    { id: 'details', title: t('projects.form.group.details', 'Details'), column: 1, fields: ['name', 'status', 'description', 'ownerUserId', 'dueInDays', 'isActive'] },
  ], [t])
  return (
    <CrudForm<ProjectTaskTemplateValues>
      title={title}
      backHref={backHref}
      cancelHref={cancelHref}
      entityId={E.projects.project_task_template}
      fields={fields}
      groups={groups}
      initialValues={initialValues}
      submitLabel={submitLabel}
      onSubmit={onSubmit}
    />
  )
}

export function ProjectTemplateForm({
  title,
  initialValues,
  submitLabel,
  backHref,
  cancelHref,
  onSubmit,
}: {
  title: string
  initialValues: Partial<ProjectTemplateValues>
  submitLabel: string
  backHref: string
  cancelHref: string
  onSubmit: (values: ProjectTemplateValues) => Promise<void>
}) {
  const t = useT()
  const fields = React.useMemo<CrudField[]>(() => [
    { id: 'name', label: t('projects.templates.project.form.name', 'Name'), type: 'text', required: true },
    { id: 'description', label: t('projects.templates.project.form.description', 'Description'), type: 'textarea' },
    { id: 'isActive', label: t('projects.form.isActive', 'Active'), type: 'checkbox' },
  ], [t])
  const groups = React.useMemo<CrudFormGroup[]>(() => [
    { id: 'details', title: t('projects.form.group.details', 'Details'), column: 1, fields: ['name', 'description', 'isActive'] },
  ], [t])
  return (
    <CrudForm<ProjectTemplateValues>
      title={title}
      backHref={backHref}
      cancelHref={cancelHref}
      entityId={E.projects.project_template}
      fields={fields}
      groups={groups}
      initialValues={initialValues}
      submitLabel={submitLabel}
      onSubmit={onSubmit}
    />
  )
}

export function ProjectTemplateTaskEditor({
  projectTemplateId,
  taskTemplates,
  users,
  initialValues,
  onCancel,
  onSave,
}: {
  projectTemplateId: string
  taskTemplates: ProjectTaskTemplateValues[]
  users: Option[]
  initialValues: Partial<ProjectTemplateTaskValues>
  onCancel: () => void
  onSave: (values: ProjectTemplateTaskValues) => Promise<void>
}) {
  const t = useT()
  const [values, setValues] = React.useState<ProjectTemplateTaskValues>({
    projectTemplateId,
    taskTemplateId: initialValues.taskTemplateId ?? null,
    name: initialValues.name ?? null,
    status: initialValues.status ?? null,
    description: initialValues.description ?? null,
    ownerUserId: initialValues.ownerUserId ?? null,
    dueInDays: initialValues.dueInDays ?? null,
    position: initialValues.position ?? 0,
    id: initialValues.id,
  })
  const taskTemplateOptions = React.useMemo(() => taskTemplates.map((template) => ({ id: template.id ?? '', label: template.name })), [taskTemplates])
  const updateValue = React.useCallback((patch: Partial<ProjectTemplateTaskValues>) => {
    setValues((current) => ({ ...current, ...patch }))
  }, [])
  const selectedTemplate = taskTemplates.find((template) => template.id === values.taskTemplateId)
  const resolvedName = values.name || selectedTemplate?.name || ''
  const canSave = resolvedName.trim().length > 0
  return (
    <div className="rounded-md border p-4">
      <div className="grid gap-3 md:grid-cols-2">
        <label className="space-y-1 text-sm">
          <span>{t('projects.templates.project.tasks.form.taskTemplate', 'Task template')}</span>
          <OptionSelect value={values.taskTemplateId} onChange={(next) => updateValue({ taskTemplateId: next })} options={taskTemplateOptions} emptyLabel={t('projects.templates.project.tasks.form.inline', 'Inline task')} />
        </label>
        <label className="space-y-1 text-sm">
          <span>{t('projects.templates.project.tasks.form.position', 'Position')}</span>
          <Input type="number" value={String(values.position ?? 0)} onChange={(event) => updateValue({ position: Number(event.target.value || 0) })} />
        </label>
        <label className="space-y-1 text-sm">
          <span>{t('projects.templates.project.tasks.form.nameOverride', 'Name override')}</span>
          <Input value={values.name ?? ''} placeholder={selectedTemplate?.name ?? ''} onChange={(event) => updateValue({ name: event.target.value || null })} />
        </label>
        <label className="space-y-1 text-sm">
          <span>{t('projects.templates.project.tasks.form.statusOverride', 'Status override')}</span>
          <select
            className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
            value={values.status ?? ''}
            onChange={(event) => updateValue({ status: event.target.value ? event.target.value as ProjectTaskStatus : null })}
          >
            <option value="">{selectedTemplate ? projectTaskStatusLabels[selectedTemplate.status] : t('projects.templates.inherit', 'Inherit')}</option>
            {projectTaskStatuses.map((status) => (
              <option key={status} value={status}>{projectTaskStatusLabels[status]}</option>
            ))}
          </select>
        </label>
        <label className="space-y-1 text-sm">
          <span>{t('projects.templates.project.tasks.form.ownerOverride', 'Owner override')}</span>
          <OptionSelect value={values.ownerUserId} onChange={(next) => updateValue({ ownerUserId: next })} options={users} emptyLabel={selectedTemplate?.ownerUserId ?? t('projects.form.owner.none', 'No owner')} />
        </label>
        <label className="space-y-1 text-sm">
          <span>{t('projects.templates.project.tasks.form.dueOverride', 'Due in days override')}</span>
          <Input type="number" value={values.dueInDays ?? ''} placeholder={selectedTemplate?.dueInDays === null || selectedTemplate?.dueInDays === undefined ? '' : String(selectedTemplate.dueInDays)} onChange={(event) => updateValue({ dueInDays: event.target.value ? Number(event.target.value) : null })} />
        </label>
      </div>
      <label className="mt-3 block space-y-1 text-sm">
        <span>{t('projects.templates.project.tasks.form.descriptionOverride', 'Description override')}</span>
        <Textarea rows={3} value={values.description ?? ''} placeholder={selectedTemplate?.description ?? ''} onChange={(event) => updateValue({ description: event.target.value || null })} />
      </label>
      <div className="mt-4 flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancel}>{t('common.cancel', 'Cancel')}</Button>
        <Button type="button" disabled={!canSave} onClick={() => { void onSave(values) }}>{t('common.save', 'Save')}</Button>
      </div>
    </div>
  )
}
