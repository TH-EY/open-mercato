import nextConfig from '../../next.config'

describe('apps/mercato search indexing headers', () => {
  it('keeps CRM indexable while blocking the configured private hosts', async () => {
    if (!nextConfig.headers) {
      throw new Error('[internal] next.config headers are not configured')
    }

    const rules = await nextConfig.headers()
    const expectedHosts = [
      'epc-preview.om.they.dev',
      'manoj.om.they.dev',
      'om.they.dev',
      'preview-epc.om.they.dev',
    ]
    const configuredHostPatterns = rules
      .flatMap((rule) => rule.has ?? [])
      .filter((condition) => condition.type === 'host')
      .map((condition) => condition.value)
      .sort()

    expect(configuredHostPatterns).toEqual(
      expectedHosts.map((host) => host.replaceAll('.', '\\.')),
    )

    for (const host of expectedHosts) {
      const rule = rules.find((candidate) =>
        candidate.has?.some(
          (condition) =>
            condition.type === 'host'
            && new RegExp(`^${condition.value}$`).test(host),
        ),
      )

      expect(rule?.source).toBe('/:path*')
      expect(rule?.headers).toContainEqual({
        key: 'X-Robots-Tag',
        value: 'noindex, nofollow, noarchive',
      })
    }

    expect(
      configuredHostPatterns.some((pattern) =>
        new RegExp(`^${pattern}$`).test('crm.they.dev'),
      ),
    ).toBe(false)

    for (const unrelatedHost of [
      'crmXtheyYdev',
      'preview-epcXomYtheyZdev',
      'example.com',
    ]) {
      expect(
        configuredHostPatterns.some((pattern) =>
          new RegExp(`^${pattern}$`).test(unrelatedHost),
        ),
      ).toBe(false)
    }
  })
})
