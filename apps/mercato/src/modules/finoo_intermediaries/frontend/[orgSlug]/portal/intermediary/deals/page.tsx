import DealsPageClient from './page.client'

export default function IntermediaryDealsPage({ params }: { params: { orgSlug: string } }) {
  return <DealsPageClient orgSlug={params.orgSlug} />
}
