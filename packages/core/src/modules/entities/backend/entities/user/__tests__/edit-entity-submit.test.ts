jest.mock('@open-mercato/ui/backend/CrudForm', () => ({
  CrudForm: () => null,
}))

import {
  buildDefinitionsBatchPayload,
  buildEntityMetadataPayload,
  shouldPersistEntityMetadata,
} from '../[entityId]/page'

describe('buildEntityMetadataPayload', () => {
  describe('code-sourced (system) entities', () => {
    it('returns a payload with label, description, and defaultEditor', () => {
      const result = buildEntityMetadataPayload('code', {
        label: 'My Entity',
        description: 'Some description',
        defaultEditor: 'markdown',
      })
      expect(result).not.toBeNull()
      expect(result).toMatchObject({
        label: 'My Entity',
        description: 'Some description',
        defaultEditor: 'markdown',
      })
    })

    it('returns a payload even when only label is provided', () => {
      const result = buildEntityMetadataPayload('code', { label: 'System Entity' })
      expect(result).not.toBeNull()
      expect(result?.label).toBe('System Entity')
    })

    it('does not include showInSidebar in the payload', () => {
      const result = buildEntityMetadataPayload('code', {
        label: 'My Entity',
        showInSidebar: true,
      })
      expect(result).not.toBeNull()
      expect(result).not.toHaveProperty('showInSidebar')
    })

    it('normalizes empty string defaultEditor to undefined', () => {
      const result = buildEntityMetadataPayload('code', {
        label: 'My Entity',
        defaultEditor: '',
      })
      expect(result).not.toBeNull()
      expect(result?.defaultEditor).toBeUndefined()
    })
  })

  describe('custom entities', () => {
    it('returns a payload with showInSidebar', () => {
      const result = buildEntityMetadataPayload('custom', {
        label: 'Custom Entity',
        description: 'Custom description',
        showInSidebar: true,
      })
      expect(result).not.toBeNull()
      expect(result).toMatchObject({
        label: 'Custom Entity',
        description: 'Custom description',
        showInSidebar: true,
      })
    })

    it('returns a valid payload when showInSidebar is not provided', () => {
      const result = buildEntityMetadataPayload('custom', { label: 'Custom Entity' })
      expect(result).not.toBeNull()
      expect(result?.label).toBe('Custom Entity')
    })
  })

  it('returns null when label is missing', () => {
    const result = buildEntityMetadataPayload('code', { description: 'No label here' })
    expect(result).toBeNull()
  })

  it('returns null when label is empty', () => {
    const result = buildEntityMetadataPayload('custom', { label: '' })
    expect(result).toBeNull()
  })
})

describe('shouldPersistEntityMetadata', () => {
  it('does not persist metadata for code-sourced system entities', () => {
    expect(shouldPersistEntityMetadata('code')).toBe(false)
  })

  it('persists metadata for user-defined custom entities', () => {
    expect(shouldPersistEntityMetadata('custom')).toBe(true)
  })
})

describe('buildDefinitionsBatchPayload', () => {
  it('preserves inactive definitions in the batch payload', () => {
    const result = buildDefinitionsBatchPayload({
      entityId: 'customers:customer_deal',
      defs: [
        {
          key: 'hidden_field',
          kind: 'text',
          configJson: { label: 'Hidden field' },
          isActive: false,
        },
        {
          key: 'visible_field',
          kind: 'integer',
          configJson: { label: 'Visible field' },
          isActive: true,
        },
      ],
      fieldsets: [],
      singleFieldsetPerRecord: true,
    })

    expect(result).toMatchObject({
      entityId: 'customers:customer_deal',
      definitions: [
        { key: 'hidden_field', kind: 'text', isActive: false },
        { key: 'visible_field', kind: 'integer', isActive: true },
      ],
      singleFieldsetPerRecord: true,
    })
  })

  it('omits definitions without keys', () => {
    const result = buildDefinitionsBatchPayload({
      entityId: 'customers:customer_deal',
      defs: [
        { key: '', kind: 'text', configJson: {}, isActive: true },
        { key: 'visible_field', kind: 'text', configJson: {}, isActive: true },
      ],
      fieldsets: [],
      singleFieldsetPerRecord: true,
    })

    expect(result.definitions).toEqual([
      { key: 'visible_field', kind: 'text', configJson: {}, isActive: true },
    ])
  })
})
