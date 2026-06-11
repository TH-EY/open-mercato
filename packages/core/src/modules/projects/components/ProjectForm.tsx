"use client"

import * as React from 'react'
import { CrudForm, type CrudField, type CrudFormGroup } from '@open-mercato/ui/backend/CrudForm'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { E } from '#generated/entities.ids.generated'

export type ProjectFormValues = {
  id?: string
  name: string
  orderId?: string | null
  ownerUserId?: string | null
  isActive?: boolean
  updatedAt?: string | null
}

type Option = {
  id: string
  label: string
}

type ProjectFormProps = {
  title: string
  initialValues: Partial<ProjectFormValues>
  submitLabel: string
  backHref: string
  cancelHref: string
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

export function ProjectForm({ title, initialValues, submitLabel, backHref, cancelHref, onSubmit }: ProjectFormProps) {
  const t = useT()
  const { orders, users } = useProjectReferenceOptions()

  const fields = React.useMemo<CrudField[]>(() => [
    { id: 'name', label: t('projects.form.name', 'Name'), type: 'text', required: true },
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
  ], [orders, t, users])

  const groups = React.useMemo<CrudFormGroup[]>(() => [
    { id: 'details', title: t('projects.form.group.details', 'Details'), column: 1, fields: ['name', 'orderId', 'ownerUserId', 'isActive'] },
  ], [t])

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
