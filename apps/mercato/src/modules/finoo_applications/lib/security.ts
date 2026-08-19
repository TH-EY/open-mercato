export function hasConfiguredLookupHashPepper(): boolean {
  return [
    process.env.LOOKUP_HASH_PEPPER,
    process.env.TENANT_DATA_ENCRYPTION_FALLBACK_KEY,
    process.env.TENANT_DATA_ENCRYPTION_KEY,
  ].some((candidate) => {
    if (typeof candidate !== 'string') return false
    return candidate.trim().replace(/(?:^['"]|['"]$)/g, '').length > 0
  })
}
