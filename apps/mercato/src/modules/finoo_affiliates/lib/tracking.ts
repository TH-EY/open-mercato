import { createHash } from 'node:crypto'

const nonCountingUserAgentTokens = [
  'bot',
  'crawler',
  'spider',
  'slurp',
  'facebookexternalhit',
  'facebot',
  'meta-externalagent',
  'meta-externalfetcher',
  'facebookcatalog',
  'linkedinbot',
  'twitterbot',
  'slackbot',
  'discordbot',
  'telegrambot',
  'whatsapp',
  'skypeuripreview',
  'google-inspectiontool',
  'bingpreview',
] as const

export function parseAllowedRedirectHosts(rawValue: string | undefined): Set<string> {
  return new Set(
    (rawValue ?? '')
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter((value) => value.length > 0),
  )
}

export function validateAffiliateDestination(
  rawUrl: string,
  options: { allowedHosts: Set<string>; allowLocalhost?: boolean },
): URL {
  const destination = new URL(rawUrl)
  const host = destination.hostname.toLowerCase()
  const isLocalhost = host === 'localhost' || host === '127.0.0.1'
  const allowedProtocol = destination.protocol === 'https:' || (options.allowLocalhost === true && isLocalhost && destination.protocol === 'http:')
  const hasCredentials = destination.username.length > 0 || destination.password.length > 0
  const hasUnexpectedPort = destination.port.length > 0 && !(options.allowLocalhost === true && isLocalhost)
  if (hasCredentials || hasUnexpectedPort || !allowedProtocol || (!options.allowedHosts.has(host) && !(options.allowLocalhost === true && isLocalhost))) {
    throw new Error('[internal] Affiliate destination is not allowed')
  }
  return destination
}

export function buildAffiliateDestination(destination: URL, affiliateCode: string): URL {
  const result = new URL(destination.toString())
  result.searchParams.set('affiliate_code', affiliateCode)
  return result
}

export function shouldCountAffiliateRequest(request: Request): boolean {
  if (request.method.toUpperCase() !== 'GET') return false
  const purpose = [request.headers.get('purpose'), request.headers.get('sec-purpose'), request.headers.get('x-purpose')]
    .filter((value): value is string => typeof value === 'string')
    .join(' ')
    .toLowerCase()
  if (purpose.includes('prefetch') || purpose.includes('preview')) return false
  const fetchMode = request.headers.get('sec-fetch-mode')?.trim().toLowerCase()
  if (fetchMode && fetchMode !== 'navigate') return false
  const fetchDestination = request.headers.get('sec-fetch-dest')?.trim().toLowerCase()
  if (fetchDestination && fetchDestination !== 'document') return false
  const fetchUser = request.headers.get('sec-fetch-user')?.trim().toLowerCase()
  if (fetchUser && fetchUser !== '?1') return false
  const userAgent = request.headers.get('user-agent')?.trim().toLowerCase()
  if (!userAgent) return false
  return !nonCountingUserAgentTokens.some((token) => userAgent.includes(token))
}

export function buildAffiliateRateLimitKey(
  affiliateLinkId: string,
  clientIdentity: string,
): string {
  return createHash('sha256').update(`${affiliateLinkId}:${clientIdentity}`, 'utf8').digest('hex')
}

export function hashAffiliateVisitor(visitorToken: string, affiliateLinkId: string): string {
  return createHash('sha256').update(`${affiliateLinkId}:${visitorToken}`, 'utf8').digest('hex')
}
