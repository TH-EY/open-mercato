"use client"
import * as React from 'react'
import type { ColumnDef } from '@tanstack/react-table'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { Page, PageBody, PageHeader } from '@open-mercato/ui/backend/Page'
import { DataTable } from '@open-mercato/ui/backend/DataTable'
import { readApiResultOrThrow } from '@open-mercato/ui/backend/utils/apiCall'
type Row = { id: string; affiliateFirstName: string; affiliateLastName: string; paymentReference: string; amount: string; currency: string; paidAt: string; transactionCount: number }
export default function PayoutsClient() {
  const t = useT(); const [items, setItems] = React.useState<Row[]>([]); const [loading, setLoading] = React.useState(true)
  React.useEffect(() => { void readApiResultOrThrow<{ items: Row[] }>('/api/finoo_affiliates/payouts').then((value) => setItems(value.items)).finally(() => setLoading(false)) }, [])
  const columns = React.useMemo<ColumnDef<Row>[]>(() => [
    { accessorKey: 'affiliateFirstName', header: t('finooAffiliates.payouts.affiliateFirstName', 'Affiliate first name') },
    { accessorKey: 'affiliateLastName', header: t('finooAffiliates.payouts.affiliateLastName', 'Affiliate last name') },
    { accessorKey: 'paymentReference', header: t('finooAffiliates.payouts.reference', 'Payment reference') },
    { accessorKey: 'amount', header: t('finooAffiliates.payouts.amount', 'Amount'), cell: ({ row }) => `${row.original.amount} ${row.original.currency}` },
    { accessorKey: 'paidAt', header: t('finooAffiliates.payouts.date', 'Date'), cell: ({ row }) => new Date(row.original.paidAt).toLocaleDateString() },
    { accessorKey: 'transactionCount', header: t('finooAffiliates.payouts.transactionCount', 'Transactions') },
  ], [t])
  return <Page><PageHeader title={t('finooAffiliates.payouts.title', 'Affiliate payouts')} /><PageBody><DataTable data={items} columns={columns} isLoading={loading} entityId="finoo_affiliates:finoo_affiliate_payout" extensionTableId="finoo_affiliates.payouts" /></PageBody></Page>
}
