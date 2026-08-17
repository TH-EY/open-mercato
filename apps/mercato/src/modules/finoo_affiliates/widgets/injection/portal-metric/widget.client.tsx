"use client"

import * as React from 'react'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { LineChart } from '@open-mercato/ui/backend/charts'
import { readApiResultOrThrow } from '@open-mercato/ui/backend/utils/apiCall'
import { Input } from '@open-mercato/ui/primitives/input'
import { Label } from '@open-mercato/ui/primitives/label'

type Metric = 'leads' | 'clicks' | 'transactions' | 'affiliateTransactions'
type WeeklyPoint = { weekStart: string; count: number }
type DashboardPayload = Record<Metric, WeeklyPoint[]> & {
  range: { from: string; to: string; timezone: string }
}

export function PortalMetricWidget({ metric }: { metric: Metric }) {
  const t = useT()
  const [range, setRange] = React.useState<{ from: string; to: string } | null>(null)
  const [data, setData] = React.useState<WeeklyPoint[]>([])
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    let active = true
    setLoading(true)
    setError(null)
    const params = range ? `?${new URLSearchParams(range).toString()}` : ''
    void readApiResultOrThrow<DashboardPayload>(`/api/finoo_affiliates/portal/dashboard${params}`)
      .then((payload) => {
        if (active) {
          setData(payload[metric] ?? [])
          if (!range) setRange({ from: payload.range.from, to: payload.range.to })
        }
      })
      .catch(() => {
        if (active) setError(t('finooAffiliates.portal.dashboard.loadError', 'Unable to load dashboard data.'))
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [metric, range, t])

  const title = t(`finooAffiliates.portal.dashboard.${metric}`, metric)
  const chartData = React.useMemo(
    () => data.map((point) => ({ week: point.weekStart, value: point.count })),
    [data],
  )

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor={`${metric}-from`}>{t('finooAffiliates.portal.dashboard.from', 'From')}</Label>
          <Input
            id={`${metric}-from`}
            type="date"
            value={range?.from ?? ''}
            max={range?.to}
            onChange={(event) => setRange((current) => ({ from: event.target.value, to: current?.to ?? event.target.value }))}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${metric}-to`}>{t('finooAffiliates.portal.dashboard.to', 'To')}</Label>
          <Input
            id={`${metric}-to`}
            type="date"
            value={range?.to ?? ''}
            min={range?.from}
            onChange={(event) => setRange((current) => ({ from: current?.from ?? event.target.value, to: event.target.value }))}
          />
        </div>
      </div>
      <LineChart
        data={chartData}
        index="week"
        categories={['value']}
        categoryLabels={{ value: title }}
        loading={loading}
        error={error}
        showArea
        showLegend={false}
        valueFormatter={(value) => Number.isInteger(value) ? value.toLocaleString() : ''}
        emptyMessage={t('finooAffiliates.portal.dashboard.empty', 'No data in this range.')}
        className="border-0 bg-transparent p-0"
      />
    </div>
  )
}
