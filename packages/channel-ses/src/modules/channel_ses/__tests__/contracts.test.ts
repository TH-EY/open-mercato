import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { features } from '../acl'
import { sesCapabilities } from '../capabilities'
import { integration } from '../integration'
import { metadata } from '../index'

describe('channel_ses contracts', () => {
  it('declares supported module metadata and coordinated versions', () => {
    expect(metadata).toEqual(expect.objectContaining({
      id: 'channel_ses',
      version: '0.6.6',
      requires: ['communication_channels', 'integrations'],
    }))
    expect(integration).toEqual(expect.objectContaining({
      version: '0.6.6',
      healthCheck: { service: 'channelSesHealthCheck' },
    }))
    expect(metadata).not.toHaveProperty('dependencies')
  })

  it('exports catalog-compatible ACL features and honest capabilities', () => {
    expect(features).toEqual([
      { id: 'channel_ses.view', title: expect.any(String), module: 'channel_ses' },
      { id: 'channel_ses.configure', title: expect.any(String), module: 'channel_ses' },
    ])
    expect(sesCapabilities.fileSharing).toBe(false)
  })

  it('treats both elements of a dedicated AWS credential pair as secrets', () => {
    const fields = integration.credentials?.fields ?? []
    expect(fields.find((field) => field.key === 'accessKeyId')).toEqual(expect.objectContaining({
      type: 'secret',
      visibleWhen: { field: 'authMode', equals: 'access_keys' },
    }))
    expect(fields.find((field) => field.key === 'secretAccessKey')).toEqual(expect.objectContaining({
      type: 'secret',
      visibleWhen: { field: 'authMode', equals: 'access_keys' },
    }))
  })

  it('removes hidden dedicated keys when the shared credentials UI switches SES to ambient', () => {
    const integrationPage = readFileSync(resolve(
      process.cwd(),
      '../core/src/modules/integrations/backend/integrations/[id]/page.tsx',
    ), 'utf8')
    expect(integrationPage.match(/currentIntegrationId === 'storage_s3' \|\| currentIntegrationId === 'channel_ses'/g))
      .toHaveLength(2)
    expect(integrationPage).toContain('delete sanitizedValues.accessKeyId')
    expect(integrationPage).toContain('delete sanitizedValues.secretAccessKey')
  })
})
