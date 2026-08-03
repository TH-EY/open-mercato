import { readFileSync } from 'node:fs'

describe('apps/mercato robots policy', () => {
  it('blocks crawling for the agent orchestrator demo instance', () => {
    const robots = readFileSync(`${__dirname}/../../public/robots.txt`, 'utf8')

    expect(robots).toBe('User-agent: *\nDisallow: /\n')
  })
})
