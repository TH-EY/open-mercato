"use client"

import * as React from 'react'
import { useRouter } from 'next/navigation'
import type { ColumnDef, SortingState } from '@tanstack/react-table'
import { Plus } from 'lucide-react'
import { Page, PageBody } from '@open-mercato/ui/backend/Page'
import { DataTable } from '@open-mercato/ui/backend/DataTable'
import { RowActions } from '@open-mercato/ui/backend/RowActions'
import { useConfirmDialog } from '@open-mercato/ui/backend/confirm-dialog'
import { useGuardedMutation } from '@open-mercato/ui/backend/injection/useGuardedMutation'
import { readApiResultOrThrow } from '@open-mercato/ui/backend/utils/apiCall'
import { deleteCrud } from '@open-mercato/ui/backend/utils/crud'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { Button } from '@open-mercato/ui/primitives/button'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { E } from '#generated/entities.ids.generated'
import { projectTaskStatusLabels } from '../../../lib/statuses'
import { normalizeTaskTemplate, type ProjectTaskTemplateValues } from '../../../components/TemplateForms'

type ResponsePayload = {
  items?: Record<string, unknown>[]
  total?: number
  totalPages?: number
}

export default function ProjectTaskTemplatesPage() {
  const t = useT()
  const router = useRouter()
  const { confirm, ConfirmDialogElement } = useConfirmDialog()
  const [rows, setRows] = React.useState<ProjectTaskTemplateValues[]>([])
  const [page, setPage] = React.useState(1)
  const [pageSize, setPageSize] = React.useState(20)
  const [sorting, setSorting] = React.useState<SortingState>([{ id: 'updatedAt', desc: true }])
  const [search, setSearch] = React.useState('')
  const [total, setTotal] = React.useState(0)
  const [totalPages, setTotalPages] = React.useState(1)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const { runMutation, retryLastMutation } = useGuardedMutation<{ retryLastMutation: () => Promise<boolean> }>({
    contextId: 'projects.task-templates.list',
  })

  const loadRows = React.useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const currentSort = sorting[0]
      const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) })
      if (search.trim()) params.set('search', search.trim())
      if (currentSort) {
        params.set('sortField', currentSort.id)
        params.set('sortDir', currentSort.desc ? 'desc' : 'asc')
      }
      const payload = await readApiResultOrThrow<ResponsePayload>(`/api/projects/task-templates?${params.toString()}`)
      setRows(Array.isArray(payload.items) ? payload.items.map(normalizeTaskTemplate).filter((row): row is ProjectTaskTemplateValues => row !== null) : [])
      setTotal(typeof payload.total === 'number' ? payload.total : 0)
      setTotalPages(typeof payload.totalPages === 'number' ? payload.totalPages : 1)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('projects.templates.task.list.loadError', 'Failed to load task templates.'))
    } finally {
      setLoading(false)
    }
  }, [page, pageSize, search, sorting, t])

  React.useEffect(() => { void loadRows() }, [loadRows])

  const deleteRow = React.useCallback(async (row: ProjectTaskTemplateValues) => {
    if (!row.id) return
    const ok = await confirm({
      title: t('projects.templates.task.delete.title', 'Delete task template'),
      description: t('projects.templates.task.delete.description', 'This will remove the reusable task template.'),
      confirmText: t('common.delete', 'Delete'),
      variant: 'destructive',
    })
    if (!ok) return
    await runMutation({
      context: { retryLastMutation },
      mutationPayload: { id: row.id },
      operation: () => deleteCrud('projects/task-templates', row.id ?? ''),
    })
    flash(t('projects.templates.task.delete.flash', 'Task template deleted.'), 'success')
    await loadRows()
  }, [confirm, loadRows, retryLastMutation, runMutation, t])

  const columns = React.useMemo<ColumnDef<ProjectTaskTemplateValues>[]>(() => [
    { accessorKey: 'name', header: t('projects.templates.task.table.name', 'Task template'), cell: ({ row }) => <span className="font-medium">{row.original.name}</span> },
    { accessorKey: 'status', header: t('projects.templates.task.table.status', 'Status'), cell: ({ row }) => projectTaskStatusLabels[row.original.status] },
    { accessorKey: 'dueInDays', header: t('projects.templates.task.table.dueInDays', 'Due in days'), cell: ({ row }) => row.original.dueInDays ?? '-' },
    { accessorKey: 'isActive', header: t('projects.templates.table.active', 'Active'), cell: ({ row }) => row.original.isActive === false ? t('common.no', 'No') : t('common.yes', 'Yes') },
  ], [t])

  return (
    <Page>
      <PageBody>
        <DataTable<ProjectTaskTemplateValues>
          columns={columns}
          data={rows}
          title={t('projects.templates.task.list.title', 'Task templates')}
          actions={(
            <Button asChild>
              <a href="/backend/projects/task-templates/create">
                <Plus className="mr-2 h-4 w-4" />
                {t('projects.templates.task.create.title', 'Create task template')}
              </a>
            </Button>
          )}
          entityId={E.projects.project_task_template}
          extensionTableId="projects.task-templates"
          searchValue={search}
          onSearchChange={(value) => {
            setSearch(value)
            setPage(1)
          }}
          searchPlaceholder={t('projects.templates.task.list.search', 'Search task templates...')}
          isLoading={loading}
          error={error}
          manualSorting
          sorting={sorting}
          onSortingChange={setSorting}
          pagination={{
            page,
            pageSize,
            total,
            totalPages,
            onPageChange: setPage,
            onPageSizeChange: (nextPageSize) => {
              setPageSize(nextPageSize)
              setPage(1)
            },
          }}
          onRowClick={(row) => row.id ? router.push(`/backend/projects/task-templates/${row.id}`) : undefined}
          rowActions={(row) => (
            <RowActions
              items={[
                { id: 'open', label: t('common.open', 'Open'), href: `/backend/projects/task-templates/${row.id}` },
                { id: 'edit', label: t('common.edit', 'Edit'), href: `/backend/projects/task-templates/${row.id}` },
                { id: 'delete', label: t('common.delete', 'Delete'), destructive: true, onSelect: () => { void deleteRow(row) } },
              ]}
            />
          )}
        />
        {ConfirmDialogElement}
      </PageBody>
    </Page>
  )
}
