export type IntermediaryStatus = 'delivery_failed' | 'invited' | 'expired' | 'active' | 'inactive'

export type IntermediaryDirectoryItem = {
  id: string
  firstName: string
  lastName: string
  email: string
  status: IntermediaryStatus
  hasLinkedAccount: boolean
  relatedDeals: number
  invitationExpiresAt: string | null
  lastEmailStatus: 'pending' | 'delivered' | 'failed' | null
  lastEmailErrorCode: string | null
  updatedAt: string
}

export type DirectoryResponse = {
  items: IntermediaryDirectoryItem[]
  nextCursor: string | null
}

export type DirectoryMutationResponse = {
  item: IntermediaryDirectoryItem
  requiresReactivation?: boolean
  warningCode?: 'access_notice_delivery_failed'
  code?: 'invitation_delivery_failed'
}
