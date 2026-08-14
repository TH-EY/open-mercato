import DealDetailPageClient from './page.client'

export default function IntermediaryDealDetailPage({ params }: { params: { orgSlug: string; id: string } }) {
  return <DealDetailPageClient orgSlug={params.orgSlug} dealId={params.id} />
}
