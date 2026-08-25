"use client"

import * as React from 'react'
import { Users } from 'lucide-react'
import { readApiResultOrThrow } from '@open-mercato/ui/backend/utils/apiCall'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { createTranslatorWithFallback } from '@open-mercato/shared/lib/i18n/translate'
import type { TabEmptyStateConfig, Translator } from './types'
import {
  LinkedPeopleSection,
  type LinkedPeoplePage,
  type LinkedPersonSummary,
} from './LinkedPeopleSection'
import { createPersonLinkAdapter } from '../linking/adapters/personAdapter'
import type { LinkEntityConfirmInput } from '../linking/LinkEntityDialog'

type GuardedMutationRunner = <T>(
  operation: () => Promise<T>,
  mutationPayload?: Record<string, unknown>,
) => Promise<T>

export type DealPeopleSectionProps = {
  dealId: string
  dealName?: string | null
  /** Ids currently linked to the deal; also seeds the link dialog selection. */
  selectedIds: string[]
  /** Persists the whole selection through the deal's optimistic-locked update. */
  onSaveSelection: (nextIds: string[]) => Promise<void>
  fallbackPeople?: LinkedPersonSummary[]
  disabled?: boolean
  emptyLabel: string
  emptyState: TabEmptyStateConfig
  translator?: Translator
  runGuardedMutation?: GuardedMutationRunner
  onLoadingChange?: (isLoading: boolean) => void
}

export function DealPeopleSection({
  dealId,
  dealName,
  selectedIds,
  onSaveSelection,
  fallbackPeople,
  disabled = false,
  emptyLabel,
  emptyState,
  translator,
  runGuardedMutation,
  onLoadingChange,
}: DealPeopleSectionProps) {
  const tHook = useT()
  const fallbackTranslator = React.useMemo<Translator>(
    () => createTranslatorWithFallback(tHook),
    [tHook],
  )
  const translate: Translator = translator ?? fallbackTranslator

  const loadPage = React.useCallback(
    async ({
      page,
      pageSize,
      sort,
      search,
    }: {
      page: number
      pageSize: number
      sort: 'name-asc' | 'name-desc' | 'recent'
      search: string
    }): Promise<LinkedPeoplePage> => {
      const params = new URLSearchParams({
        page: String(page),
        pageSize: String(pageSize),
        sort,
      })
      if (search.length > 0) {
        params.set('search', search)
      }
      return readApiResultOrThrow<LinkedPeoplePage>(
        `/api/customers/deals/${encodeURIComponent(dealId)}/people?${params.toString()}`,
        undefined,
        {
          errorMessage: translate(
            'customers.deals.detail.people.loadError',
            'Failed to load people.',
          ),
        },
      )
    },
    [dealId, translate],
  )

  const handleUnlink = React.useCallback(
    async (personId: string) => {
      await onSaveSelection(selectedIds.filter((id) => id !== personId))
    },
    [onSaveSelection, selectedIds],
  )

  const handleLinkConfirm = React.useCallback(
    async ({ nextSelectedIds }: LinkEntityConfirmInput) => {
      await onSaveSelection(nextSelectedIds)
    },
    [onSaveSelection],
  )

  const personLinkAdapter = React.useMemo(
    () =>
      createPersonLinkAdapter({
        dialogTitle: translate('customers.linking.person.dialogTitle', 'Link person'),
        dialogSubtitle: dealName
          ? translate(
              'customers.linking.person.dialogSubtitleFor',
              'Link an existing contact to {{name}}',
              { name: dealName },
            )
          : translate(
              'customers.deals.detail.people.dialogSubtitle',
              'Link an existing contact to this deal',
            ),
        sectionLabel: translate('customers.linking.person.sectionLabel', 'MATCHING CONTACTS'),
        searchPlaceholder: translate(
          'customers.linking.person.searchPlaceholder',
          'Search all people…',
        ),
        searchEmptyHint: translate(
          'customers.linking.person.searchEmpty',
          'No matching people found.',
        ),
        selectedEmptyHint: translate(
          'customers.linking.person.selectedEmpty',
          'No people selected.',
        ),
        confirmButtonLabel: translate('customers.linking.person.confirmButton', 'Link person'),
        defaultAvatarIcon: <Users className="size-4" />,
        excludeLinkedDealId: dealId,
      }),
    [dealId, dealName, translate],
  )

  return (
    <LinkedPeopleSection
      scopeId={dealId}
      fallbackPeople={fallbackPeople}
      loadPage={loadPage}
      onUnlink={handleUnlink}
      linkAdapter={personLinkAdapter}
      linkedIds={selectedIds}
      onLinkConfirm={handleLinkConfirm}
      sectionTitle={translate('customers.deals.detail.people.sectionTitle', 'People')}
      sectionSubtitle={translate(
        'customers.deals.detail.people.sectionSubtitle',
        'Contacts involved in this deal',
      )}
      searchPlaceholder={translate(
        'customers.deals.detail.people.searchPlaceholder',
        'Search by name, role, email...',
      )}
      linkActionLabel={translate(
        'customers.deals.detail.people.linkAction',
        'Link existing person',
      )}
      emptyLabel={emptyLabel}
      emptyState={emptyState}
      disabled={disabled}
      translator={translate}
      runGuardedMutation={runGuardedMutation}
      onLoadingChange={onLoadingChange}
    />
  )
}

export default DealPeopleSection
