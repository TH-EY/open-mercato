import nextConfig from '../../next.config'

describe('apps/mercato search indexing headers', () => {
  it('marks only the agent orchestrator demo host as non-indexable', async () => {
    if (!nextConfig.headers) {
      throw new Error('[internal] next.config headers are not configured')
    }

    const rules = await nextConfig.headers()
    const hostname = 'agent-orchestrator-mvp.om.they.dev'
    const hostPattern = hostname.replaceAll('.', '\\.')
    const rule = rules.find((candidate) =>
      candidate.has?.some(
        (condition) => condition.type === 'host' && condition.value === hostPattern,
      ),
    )

    expect(rule?.source).toBe('/:path*')
    expect(rule?.headers).toContainEqual({
      key: 'X-Robots-Tag',
      value: 'noindex, nofollow, noarchive',
    })
    expect(new RegExp(`^${hostPattern}$`).test(hostname)).toBe(true)
    expect(new RegExp(`^${hostPattern}$`).test('agent-orchestrator-mvpXomYtheyZdev')).toBe(false)
  })
})
