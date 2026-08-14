"use client"
import * as React from 'react'
import type { ColumnDef } from '@tanstack/react-table'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { DataTable } from '@open-mercato/ui/backend/DataTable'
import { readApiResultOrThrow } from '@open-mercato/ui/backend/utils/apiCall'
type Row = { id: string; paidAt: string; paymentReference: string; amount: string; currency: string }
export default function PortalPayoutsClient() {
  const t = useT(); const [items, setItems] = React.useState<Row[]>([]); const [loading, setLoading] = React.useState(true)
  React.useEffect(() => { void readApiResultOrThrow<{ items: Row[] }>('/api/finoo_affiliates/portal/payouts').then((value) => setItems(value.items)).finally(() => setLoading(false)) }, [])
  const columns = React.useMemo<ColumnDef<Row>[]>(() => [
    { accessorKey: 'paidAt', header: t('finooAffiliates.payouts.date', 'Date'), cell: ({ row }) => new Date(row.original.paidAt).toLocaleDateString() },
    { accessorKey: 'paymentReference', header: t('finooAffiliates.payouts.reference', 'Payment reference') },
    { accessorKey: 'amount', header: t('finooAffiliates.payouts.amount', 'Amount'), cell: ({ row }) => `${row.original.amount} ${row.original.currency}` },
  ], [t])
  return <div className="p-6"><DataTable data={items} columns={columns} isLoading={loading} entityId="finoo_affiliates:finoo_affiliate_payout" extensionTableId="finoo_affiliates.portal.payouts" /></div>
}
