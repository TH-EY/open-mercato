export type AffiliateName = { firstName: string; lastName: string }

export function splitAffiliateDisplayName(displayName: string): AffiliateName {
  const normalized = displayName.trim().replace(/\s+/g, ' ')
  const separator = normalized.lastIndexOf(' ')
  if (separator < 0) return { firstName: normalized, lastName: '' }
  return {
    firstName: normalized.slice(0, separator),
    lastName: normalized.slice(separator + 1),
  }
}

export function resolveAffiliateName(
  displayName: string,
  person?: { firstName?: string | null; lastName?: string | null } | null,
): AffiliateName {
  const fallback = splitAffiliateDisplayName(displayName)
  return {
    firstName: person?.firstName?.trim() || fallback.firstName,
    lastName: person?.lastName?.trim() || fallback.lastName,
  }
}
