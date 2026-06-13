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
import { normalizeProjectTemplate, type ProjectTemplateValues } from '../../../components/TemplateForms'

type ProjectTemplateRow = ProjectTemplateValues & {
  taskTemplateCount?: number
}

type ResponsePayload = {
  items?: Record<string, unknown>[]
  total?: number
  totalPages?: number
}

function normalizeRow(item: Record<string, unknown>): ProjectTemplateRow | null {
  const template = normalizeProjectTemplate(item)
  if (!template) return null
  return {
    ...template,
    taskTemplateCount: typeof item.taskTemplateCount === 'number' ? item.taskTemplateCount : Number(item.taskTemplateCount ?? 0),
  }
}

export default function ProjectTemplatesPage() {
  const t = useT()
  const router = useRouter()
  const { confirm, ConfirmDialogElement } = useConfirmDialog()
  const [rows, setRows] = React.useState<ProjectTemplateRow[]>([])
  const [page, setPage] = React.useState(1)
  const [pageSize, setPageSize] = React.useState(20)
  const [sorting, setSorting] = React.useState<SortingState>([{ id: 'updatedAt', desc: true }])
  const [search, setSearch] = React.useState('')
  const [total, setTotal] = React.useState(0)
  const [totalPages, setTotalPages] = React.useState(1)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const { runMutation, retryLastMutation } = useGuardedMutation<{ retryLastMutation: () => Promise<boolean> }>({
    contextId: 'projects.templates.list',
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
      const payload = await readApiResultOrThrow<ResponsePayload>(`/api/projects/templates?${params.toString()}`)
      setRows(Array.isArray(payload.items) ? payload.items.map(normalizeRow).filter((row): row is ProjectTemplateRow => row !== null) : [])
      setTotal(typeof payload.total === 'number' ? payload.total : 0)
      setTotalPages(typeof payload.totalPages === 'number' ? payload.totalPages : 1)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('projects.templates.project.list.loadError', 'Failed to load project templates.'))
    } finally {
      setLoading(false)
    }
  }, [page, pageSize, search, sorting, t])

  React.useEffect(() => { void loadRows() }, [loadRows])

  const deleteRow = React.useCallback(async (row: ProjectTemplateRow) => {
    if (!row.id) return
    const ok = await confirm({
      title: t('projects.templates.project.delete.title', 'Delete project template'),
      description: t('projects.templates.project.delete.description', 'This will remove the project template and its task list.'),
      confirmText: t('common.delete', 'Delete'),
      variant: 'destructive',
    })
    if (!ok) return
    await runMutation({
      context: { retryLastMutation },
      mutationPayload: { id: row.id },
      operation: () => deleteCrud('projects/templates', row.id ?? ''),
    })
    flash(t('projects.templates.project.delete.flash', 'Project template deleted.'), 'success')
    await loadRows()
  }, [confirm, loadRows, retryLastMutation, runMutation, t])

  const columns = React.useMemo<ColumnDef<ProjectTemplateRow>[]>(() => [
    { accessorKey: 'name', header: t('projects.templates.project.table.name', 'Project template'), cell: ({ row }) => <span className="font-medium">{row.original.name}</span> },
    { accessorKey: 'description', header: t('projects.templates.project.table.description', 'Description'), cell: ({ row }) => row.original.description || '-' },
    { id: 'tasks', header: t('projects.templates.project.table.tasks', 'Tasks'), cell: ({ row }) => row.original.taskTemplateCount ?? 0 },
    { accessorKey: 'isActive', header: t('projects.templates.table.active', 'Active'), cell: ({ row }) => row.original.isActive === false ? t('common.no', 'No') : t('common.yes', 'Yes') },
  ], [t])

  return (
    <Page>
      <PageBody>
        <DataTable<ProjectTemplateRow>
          columns={columns}
          data={rows}
          title={t('projects.templates.project.list.title', 'Project templates')}
          actions={(
            <Button asChild>
              <a href="/backend/projects/templates/create">
                <Plus className="mr-2 h-4 w-4" />
                {t('projects.templates.project.create.title', 'Create project template')}
              </a>
            </Button>
          )}
          entityId={E.projects.project_template}
          extensionTableId="projects.templates"
          searchValue={search}
          onSearchChange={(value) => {
            setSearch(value)
            setPage(1)
          }}
          searchPlaceholder={t('projects.templates.project.list.search', 'Search project templates...')}
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
          onRowClick={(row) => row.id ? router.push(`/backend/projects/templates/${row.id}`) : undefined}
          rowActions={(row) => (
            <RowActions
              items={[
                { id: 'open', label: t('common.open', 'Open'), href: `/backend/projects/templates/${row.id}` },
                { id: 'edit', label: t('common.edit', 'Edit'), href: `/backend/projects/templates/${row.id}` },
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
