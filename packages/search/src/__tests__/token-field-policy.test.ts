import { resolveTokenIndexFieldPolicy } from '../strategies/token.strategy'
import type { EntityId } from '@open-mercato/shared/modules/entities'

const ENTITY = 'finoo_intermediaries:finoo_intermediary' as EntityId

describe('token indexing field-policy resolution', () => {
  it('denies all token fields when no resolver is available', () => {
    expect(resolveTokenIndexFieldPolicy(ENTITY)).toEqual({ searchable: [] })
  })

  it('denies all token fields when the resolver throws or cannot resolve the entity', () => {
    expect(resolveTokenIndexFieldPolicy(ENTITY, () => {
      throw new Error('registry unavailable')
    })).toEqual({ searchable: [] })
    expect(resolveTokenIndexFieldPolicy(ENTITY, () => undefined)).toEqual({ searchable: [] })
  })

  it('preserves registered legacy entities without a field policy', () => {
    expect(resolveTokenIndexFieldPolicy(ENTITY, () => null)).toBeUndefined()
  })
})
