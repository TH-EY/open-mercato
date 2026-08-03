import { readFileSync } from 'node:fs'

describe('apps/mercato robots policy', () => {
  it('keeps crawling allowed while CRM deindexing is pending', () => {
    const robots = readFileSync(`${__dirname}/../../public/robots.txt`, 'utf8')

    expect(robots).toBe('User-agent: *\nDisallow:\n')
  })
})
