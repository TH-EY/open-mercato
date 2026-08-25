import {
  appendExtensionQueryFilters,
  readExtensionQueryFilters,
} from '../page'

describe('People extension query filters', () => {
  it('preserves extension query parameters without absorbing owned list state', () => {
    const params = new URLSearchParams({
      page: '2',
      search: 'Ada',
      sortField: 'name',
      sortDir: 'asc',
      'filter[root][id]': 'root',
      finooIdentityComplete: 'false',
    })

    expect(readExtensionQueryFilters(params)).toEqual({ finooIdentityComplete: 'false' })
  })

  it('writes only safe non-empty extension parameters', () => {
    const params = new URLSearchParams({ page: '1' })

    appendExtensionQueryFilters(params, {
      finooIdentityComplete: 'true',
      blank: '',
      page: '99',
      'filter[root][id]': 'forged',
    })

    expect(params.toString()).toBe('page=1&finooIdentityComplete=true')
  })
})
