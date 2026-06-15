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
import { apiCall, readApiResultOrThrow } from '@open-mercato/ui/backend/utils/apiCall'
import { deleteCrud } from '@open-mercato/ui/backend/utils/crud'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { Button } from '@open-mercato/ui/primitives/button'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { E } from '#generated/entities.ids.generated'
import { useProjectReferenceOptions } from '../../components/ProjectForm'

type ProjectRow = {
  id: string
  name: string
  orderId: string | null
  ownerUserId: string | null
  openTaskCount: number
  doneTaskCount: number
  updatedAt: string | null
}

type ProjectsResponse = {
  items?: Record<string, unknown>[]
  total?: number
  page?: number
  pageSize?: number
  totalPages?: number
}

function normalizeProject(item: Record<string, unknown>): ProjectRow | null {
  const id = typeof item.id === 'string' ? item.id : null
  if (!id) return null
  return {
    id,
    name: typeof item.name === 'string' ? item.name : id,
    orderId: typeof item.orderId === 'string' ? item.orderId : typeof item.order_id === 'string' ? item.order_id : null,
    ownerUserId: typeof item.ownerUserId === 'string' ? item.ownerUserId : typeof item.owner_user_id === 'string' ? item.owner_user_id : null,
    openTaskCount: typeof item.openTaskCount === 'number' ? item.openTaskCount : Number(item.openTaskCount ?? 0),
    doneTaskCount: typeof item.doneTaskCount === 'number' ? item.doneTaskCount : Number(item.doneTaskCount ?? 0),
    updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : typeof item.updated_at === 'string' ? item.updated_at : null,
  }
}

function formatDate(value: string | null): string {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleDateString()
}

export default function ProjectsPage() {
  const t = useT()
  const router = useRouter()
  const { confirm, ConfirmDialogElement } = useConfirmDialog()
  const { orders, users } = useProjectReferenceOptions()
  const orderMap = React.useMemo(() => new Map(orders.map((order) => [order.id, order.label])), [orders])
  const userMap = React.useMemo(() => new Map(users.map((user) => [user.id, user.label])), [users])
  const [rows, setRows] = React.useState<ProjectRow[]>([])
  const [page, setPage] = React.useState(1)
  const [pageSize, setPageSize] = React.useState(20)
  const [sorting, setSorting] = React.useState<SortingState>([{ id: 'updatedAt', desc: true }])
  const [search, setSearch] = React.useState('')
  const [total, setTotal] = React.useState(0)
  const [totalPages, setTotalPages] = React.useState(1)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [canManage, setCanManage] = React.useState(false)
  const [canManageTemplates, setCanManageTemplates] = React.useState(false)
  const { runMutation, retryLastMutation } = useGuardedMutation<{ retryLastMutation: () => Promise<boolean> }>({
    contextId: 'projects.list',
  })

  React.useEffect(() => {
    let cancelled = false
    async function loadPermissions() {
      try {
        const call = await apiCall<{ granted?: string[]; ok?: boolean }>('/api/auth/feature-check', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ features: ['projects.manage', 'projects.templates.manage'] }),
        })
        if (!cancelled) {
          const granted = Array.isArray(call.result?.granted) ? call.result.granted : []
          setCanManage(granted.includes('projects.manage'))
          setCanManageTemplates(granted.includes('projects.templates.manage'))
        }
      } catch {
        if (!cancelled) {
          setCanManage(false)
          setCanManageTemplates(false)
        }
      }
    }
    void loadPermissions()
    return () => { cancelled = true }
  }, [])

  const loadProjects = React.useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const currentSort = sorting[0]
      const params = new URLSearchParams({
        page: String(page),
        pageSize: String(pageSize),
      })
      if (search.trim()) params.set('search', search.trim())
      if (currentSort) {
        params.set('sortField', currentSort.id)
        params.set('sortDir', currentSort.desc ? 'desc' : 'asc')
      }
      const payload = await readApiResultOrThrow<ProjectsResponse>(`/api/projects?${params.toString()}`)
      setRows(Array.isArray(payload.items) ? payload.items.map(normalizeProject).filter((row): row is ProjectRow => row !== null) : [])
      setTotal(typeof payload.total === 'number' ? payload.total : 0)
      setTotalPages(typeof payload.totalPages === 'number' ? payload.totalPages : 1)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('projects.list.loadError', 'Failed to load projects.'))
    } finally {
      setLoading(false)
    }
  }, [page, pageSize, search, sorting, t])

  React.useEffect(() => { void loadProjects() }, [loadProjects])

  const columns = React.useMemo<ColumnDef<ProjectRow>[]>(() => [
    {
      accessorKey: 'name',
      header: t('projects.table.name', 'Project'),
      cell: ({ row }) => <span className="font-medium">{row.original.name}</span>,
    },
    {
      accessorKey: 'orderId',
      header: t('projects.table.order', 'Order'),
      cell: ({ row }) => row.original.orderId ? orderMap.get(row.original.orderId) ?? row.original.orderId : <span className="text-muted-foreground">-</span>,
    },
    {
      accessorKey: 'ownerUserId',
      header: t('projects.table.owner', 'Owner'),
      cell: ({ row }) => row.original.ownerUserId ? userMap.get(row.original.ownerUserId) ?? row.original.ownerUserId : <span className="text-muted-foreground">-</span>,
    },
    {
      id: 'tasks',
      header: t('projects.table.tasks', 'Tasks'),
      cell: ({ row }) => t('projects.table.tasks.summary', '{open} open / {done} done', { open: row.original.openTaskCount, done: row.original.doneTaskCount }),
    },
    {
      accessorKey: 'updatedAt',
      header: t('projects.table.updatedAt', 'Updated'),
      cell: ({ row }) => formatDate(row.original.updatedAt),
    },
  ], [orderMap, t, userMap])

  const deleteProject = React.useCallback(async (row: ProjectRow) => {
    const ok = await confirm({
      title: t('projects.delete.title', 'Delete project'),
      description: t('projects.delete.description', 'This will remove the project and its tasks.'),
      confirmText: t('common.delete', 'Delete'),
      variant: 'destructive',
    })
    if (!ok) return
    await runMutation({
      context: { retryLastMutation },
      mutationPayload: { id: row.id },
      operation: () => deleteCrud('projects', row.id),
    })
    flash(t('projects.delete.flash.deleted', 'Project deleted.'), 'success')
    await loadProjects()
  }, [confirm, loadProjects, retryLastMutation, runMutation, t])

  return (
    <Page>
      <PageBody>
        <DataTable<ProjectRow>
          columns={columns}
          data={rows}
          title={t('projects.list.title', 'Projects')}
          actions={(
            <div className="flex flex-wrap gap-2">
              {canManageTemplates ? (
                <>
                  <Button asChild variant="outline">
                    <a href="/backend/projects/templates">{t('projects.templates.project.list.title', 'Project templates')}</a>
                  </Button>
                  <Button asChild variant="outline">
                    <a href="/backend/projects/task-templates">{t('projects.templates.task.list.title', 'Task templates')}</a>
                  </Button>
                </>
              ) : null}
              {canManage ? (
                <Button asChild>
                  <a href="/backend/projects/create">
                    <Plus className="mr-2 h-4 w-4" />
                    {t('projects.create.title', 'Create project')}
                  </a>
                </Button>
              ) : null}
            </div>
          )}
          entityId={E.projects.project}
          extensionTableId="projects.projects"
          searchValue={search}
          onSearchChange={(value) => {
            setSearch(value)
            setPage(1)
          }}
          searchPlaceholder={t('projects.list.search', 'Search projects...')}
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
          onRowClick={(row) => router.push(`/backend/projects/${row.id}`)}
          rowActions={(row) => (
            <RowActions
              items={canManage
                ? [
                    { id: 'open', label: t('common.open', 'Open'), href: `/backend/projects/${row.id}` },
                    { id: 'kanban-board', label: t('projects.board.action', 'Kanban board'), href: `/backend/projects/${row.id}/board` },
                    { id: 'edit', label: t('common.edit', 'Edit'), href: `/backend/projects/${row.id}` },
                    { id: 'delete', label: t('common.delete', 'Delete'), destructive: true, onSelect: () => { void deleteProject(row) } },
                  ]
                : [
                    { id: 'open', label: t('common.open', 'Open'), href: `/backend/projects/${row.id}` },
                    { id: 'kanban-board', label: t('projects.board.action', 'Kanban board'), href: `/backend/projects/${row.id}/board` },
                  ]}
            />
          )}
        />
        {ConfirmDialogElement}
      </PageBody>
    </Page>
  )
}
