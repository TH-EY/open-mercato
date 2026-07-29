import {
  composeEndpointValue,
  findMatchingEndpoint,
  findUnresolvedEndpointParams,
  matchEndpointTemplate,
  requiredEndpointParamPlaceholder,
  splitEndpointValue,
} from '../endpoint-path'
import { schemaFieldHints } from '../endpoint-schema'

describe('workflow endpoint helpers', () => {
  it('splits raw query values without changing workflow interpolation tokens', () => {
    expect(splitEndpointValue('/api/people?search={{context.q}}&page=2')).toEqual({
      path: '/api/people',
      query: { search: '{{context.q}}', page: '2' },
    })
    expect(splitEndpointValue('/api/people/')).toEqual({ path: '/api/people', query: {} })
  })

  it('matches path templates and treats an unresolved placeholder as empty', () => {
    expect(matchEndpointTemplate('/api/orders/o-1', '/api/orders/{id}')).toEqual({
      pathParams: { id: 'o-1' },
    })
    expect(matchEndpointTemplate('/api/orders/{id}', '/api/orders/{id}')).toEqual({
      pathParams: { id: '' },
    })
    expect(matchEndpointTemplate('/api/orders', '/api/orders/{id}')).toBeNull()
  })

  it('prefers exact routes and then the template with fewer parameters', () => {
    const items = [
      { path: '/api/{module}/{resource}', method: 'GET' },
      { path: '/api/sales/{resource}', method: 'GET' },
      { path: '/api/sales/orders', method: 'GET' },
    ]

    expect(findMatchingEndpoint('/api/sales/orders', 'get', items)?.item.path).toBe('/api/sales/orders')
    expect(findMatchingEndpoint('/api/sales/quotes', 'GET', items)?.item.path).toBe('/api/sales/{resource}')
    expect(findMatchingEndpoint('/api/sales/orders', 'DELETE', items)).toBeNull()
  })

  it('composes path and query values while retaining unresolved required placeholders', () => {
    expect(
      composeEndpointValue('/api/orders/{id}', { id: '{{context.orderId}}' }, { include: 'lines', empty: '' }),
    ).toBe('/api/orders/{{context.orderId}}?include=lines')
    expect(composeEndpointValue(
      '/api/orders/{id}',
      { id: requiredEndpointParamPlaceholder('id') },
      { page: requiredEndpointParamPlaceholder('page') },
    )).toBe(
      '/api/orders/{__om_required_id}?page={__om_required_page}',
    )
    expect(findUnresolvedEndpointParams(
      '/api/orders/{__om_required_id}?page={__om_required_page}&q={{context.q}}',
    )).toEqual([
      'id',
      'page',
    ])
  })

  it('omits empty optional path params and preserves unknown manual braces', () => {
    expect(composeEndpointValue(
      '/api/attachments/image/{id}/{slug}',
      { id: 'image-1', slug: '' },
      {},
      ['slug'],
    )).toBe('/api/attachments/image/image-1')
    expect(findUnresolvedEndpointParams('/api/custom/{tenant}?scope={scope}')).toEqual([])
  })

  it('encodes literal path and query values without encoding workflow tokens twice', () => {
    expect(composeEndpointValue(
      '/api/orders/{id}',
      { id: 'A/B' },
      { q: 'A&B=C#D', space: 'two words', token: '{{context.query}}' },
    )).toBe('/api/orders/A%2FB?q=A%26B%3DC%23D&space=two%20words&token={{context.query}}')
    expect(matchEndpointTemplate('/api/orders/A%2FB', '/api/orders/{id}')).toEqual({
      pathParams: { id: 'A/B' },
    })
    expect(splitEndpointValue('/api/orders/A%2FB?q=A%26B')).toEqual({
      path: '/api/orders/A%2FB',
      query: { q: 'A&B' },
    })
  })

  it('projects top-level request and response field hints', () => {
    expect(schemaFieldHints({
      type: 'object',
      properties: {
        data: { type: 'array' },
        total: { type: 'number' },
      },
      required: ['data'],
    })).toEqual([
      { name: 'data', type: 'array', required: true },
      { name: 'total', type: 'number', required: false },
    ])
    expect(schemaFieldHints(undefined)).toEqual([])
  })
})
