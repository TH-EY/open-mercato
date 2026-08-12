import {
  buildAffiliateDestination,
  buildAffiliateRateLimitKey,
  hashAffiliateVisitor,
  parseAllowedRedirectHosts,
  shouldCountAffiliateRequest,
  validateAffiliateDestination,
} from '../tracking'
import { RateLimiterService } from '@open-mercato/shared/lib/ratelimit/service'

describe('Finoo affiliate tracking', () => {
  it('appends one affiliate code while preserving the destination URL', () => {
    const destination = new URL('https://apply.finoo.test/form?campaign=summer#step-1')
    const result = buildAffiliateDestination(destination, 'new-code')

    expect(result.toString()).toBe('https://apply.finoo.test/form?campaign=summer&affiliate_code=new-code#step-1')
    expect(destination.searchParams.has('affiliate_code')).toBe(false)
    result.searchParams.set('affiliate_code', 'replacement')
    expect(result.searchParams.getAll('affiliate_code')).toEqual(['replacement'])
  })

  it('allows exact HTTPS hosts and rejects insecure, subdomain, and foreign destinations', () => {
    const allowedHosts = parseAllowedRedirectHosts('apply.finoo.test, forms.finoo.test ')

    expect(validateAffiliateDestination('https://apply.finoo.test/start', { allowedHosts }).hostname).toBe('apply.finoo.test')
    expect(() => validateAffiliateDestination('http://apply.finoo.test/start', { allowedHosts })).toThrow()
    expect(() => validateAffiliateDestination('https://evil.apply.finoo.test/start', { allowedHosts })).toThrow()
    expect(() => validateAffiliateDestination('https://example.test/start', { allowedHosts })).toThrow()
    expect(() => validateAffiliateDestination('https://user:secret@apply.finoo.test/start', { allowedHosts })).toThrow()
    expect(() => validateAffiliateDestination('https://apply.finoo.test:8443/start', { allowedHosts })).toThrow()
  })

  it.each([
    ['HEAD request', new Request('https://finoo.test/r/code', { method: 'HEAD', headers: { 'user-agent': 'Mozilla/5.0' } })],
    ['missing user agent', new Request('https://finoo.test/r/code')],
    ['bot user agent', new Request('https://finoo.test/r/code', { headers: { 'user-agent': 'Googlebot/2.1' } })],
    ['preview purpose', new Request('https://finoo.test/r/code', { headers: { 'user-agent': 'Mozilla/5.0', purpose: 'preview' } })],
    ['prefetch purpose', new Request('https://finoo.test/r/code', { headers: { 'user-agent': 'Mozilla/5.0', 'sec-purpose': 'prefetch' } })],
    ['image subresource', new Request('https://finoo.test/r/code', { headers: { 'user-agent': 'Mozilla/5.0', 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'image' } })],
    ['iframe navigation', new Request('https://finoo.test/r/code', { headers: { 'user-agent': 'Mozilla/5.0', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'iframe' } })],
    ['Meta external crawler', new Request('https://finoo.test/r/code', { headers: { 'user-agent': 'meta-externalagent/1.1' } })],
  ])('does not count a %s', (_label, request) => {
    expect(shouldCountAffiliateRequest(request)).toBe(false)
  })

  it('counts an ordinary human GET and scopes the pseudonymous hash to the link', () => {
    const request = new Request('https://finoo.test/r/code', { headers: { 'user-agent': 'Mozilla/5.0 Safari/605.1', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', 'sec-fetch-user': '?1' } })
    expect(shouldCountAffiliateRequest(request)).toBe(true)
    expect(hashAffiliateVisitor('visitor-token', 'link-a')).toHaveLength(64)
    expect(hashAffiliateVisitor('visitor-token', 'link-a')).toBe(hashAffiliateVisitor('visitor-token', 'link-a'))
    expect(hashAffiliateVisitor('visitor-token', 'link-a')).not.toBe(hashAffiliateVisitor('visitor-token', 'link-b'))
  })

  it('builds a stable rate-limit key without retaining the raw client address', () => {
    const key = buildAffiliateRateLimitKey('link-a', '198.51.100.12')
    expect(key).toHaveLength(64)
    expect(key).not.toContain('198.51.100.12')
    expect(key).toBe(buildAffiliateRateLimitKey('link-a', '198.51.100.12'))
    expect(key).not.toBe(buildAffiliateRateLimitKey('link-b', '198.51.100.12'))
  })

  it('bounds cookie churn before visit persistence', async () => {
    const limiter = new RateLimiterService({
      enabled: true,
      strategy: 'memory',
      keyPrefix: 'finoo-test',
      trustProxyDepth: 1,
    })
    const config = { points: 2, duration: 60, keyPrefix: 'click' }
    const firstCookie = 'finoo_affiliate_visitor=one'
    const secondCookie = 'finoo_affiliate_visitor=two'
    const key = buildAffiliateRateLimitKey('link-a', '198.51.100.12')

    expect(firstCookie).not.toBe(secondCookie)
    expect(key).toBe(buildAffiliateRateLimitKey('link-a', '198.51.100.12'))
    expect((await limiter.consume(key, config)).allowed).toBe(true)
    expect((await limiter.consume(key, config)).allowed).toBe(true)
    expect((await limiter.consume(key, config)).allowed).toBe(false)
  })
})
