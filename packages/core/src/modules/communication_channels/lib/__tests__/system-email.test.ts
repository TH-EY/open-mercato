import React from 'react'
import { isSystemEmailTransportConfigured, sendSystemEmail } from '../system-email'
import type { ChannelAdapter } from '../adapter'
import { registerSystemEmailProviderConfigResolver } from '../system-email-provider-config'

var findOneWithDecryptionMock: jest.Mock
var findWithDecryptionMock: jest.Mock

jest.mock('@open-mercato/shared/lib/encryption/find', () => {
  findOneWithDecryptionMock = jest.fn()
  findWithDecryptionMock = jest.fn()
  return {
    findOneWithDecryption: findOneWithDecryptionMock,
    findWithDecryption: findWithDecryptionMock,
  }
})

describe('sendSystemEmail', () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      SYSTEM_EMAIL_PROVIDER: 'test-email',
      EMAIL_FROM: 'from@example.com',
    }
    registerSystemEmailProviderConfigResolver({
      providerKey: 'test-email',
      isConfigured: () => true,
      resolveCredentials: ({ fromAddress }) => ({ token: 'test-token', fromAddress }),
    })
    findOneWithDecryptionMock.mockReset()
    findWithDecryptionMock.mockReset()
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it('uses the communications hub adapter registry for pre-tenant system email', async () => {
    const convertOutbound = jest.fn().mockResolvedValue({
      content: { html: '<div>Hello</div>', text: 'Hello', bodyFormat: 'html' },
      metadata: {
        to: ['user@example.com'],
        subject: 'Hello',
        from: 'from@example.com',
      },
    })
    const sendMessage = jest.fn().mockResolvedValue({
      externalMessageId: 'email-1',
      status: 'sent',
    })
    const adapter = {
      providerKey: 'test-email',
      channelType: 'email',
      capabilities: {} as ChannelAdapter['capabilities'],
      convertOutbound,
      sendMessage,
      normalizeInbound: jest.fn(),
      verifyWebhook: jest.fn(),
      getStatus: jest.fn(),
    } satisfies ChannelAdapter
    const container = {
      resolve(name: string) {
        if (name === 'em') return { fork: () => ({}) }
        if (name === 'channelAdapterRegistry') return { get: () => adapter }
        throw new Error(`[internal] unexpected dependency ${name}`)
      },
    }

    await sendSystemEmail(container as never, {
      to: 'user@example.com',
      subject: 'Hello',
      from: 'from@example.com',
      react: React.createElement('div', null, 'Hello'),
    })

    expect(convertOutbound).toHaveBeenCalledWith(expect.objectContaining({
      bodyFormat: 'html',
      channelMetadata: expect.objectContaining({
        to: 'user@example.com',
        subject: 'Hello',
        from: 'from@example.com',
      }),
    }))
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      credentials: { token: 'test-token', fromAddress: 'from@example.com' },
      scope: { tenantId: 'system', organizationId: 'system' },
    }))
  })

  it('uses stored credentials for a tenant-wide channel', async () => {
    findOneWithDecryptionMock.mockResolvedValue({
      providerKey: 'test-email',
      channelType: 'email',
      organizationId: 'org-1',
      isActive: true,
      status: 'connected',
    })
    const sendMessage = jest.fn().mockResolvedValue({ externalMessageId: 'email-1', status: 'sent' })
    const adapter = {
      providerKey: 'test-email',
      channelType: 'email',
      capabilities: {} as ChannelAdapter['capabilities'],
      convertOutbound: jest.fn().mockResolvedValue({
        content: { text: 'Hello', bodyFormat: 'text' },
        metadata: { to: ['user@example.com'], subject: 'Hello', from: 'from@example.com' },
      }),
      sendMessage,
      normalizeInbound: jest.fn(),
      verifyWebhook: jest.fn(),
      getStatus: jest.fn(),
    } satisfies ChannelAdapter
    const resolveCredentials = jest.fn().mockResolvedValue({ token: 'stored-token', fromAddress: 'from@example.com' })
    const container = {
      resolve(name: string) {
        if (name === 'em') return { fork: () => ({}) }
        if (name === 'channelAdapterRegistry') return { get: () => adapter }
        if (name === 'integrationCredentialsService') return { resolve: resolveCredentials }
        throw new Error(`[internal] unexpected dependency ${name}`)
      },
    }

    await sendSystemEmail(container as never, {
      to: 'user@example.com',
      subject: 'Hello',
      from: 'from@example.com',
      text: 'Hello',
      tenantId: 'tenant-1',
      organizationId: 'org-1',
    })

    expect(resolveCredentials).toHaveBeenCalledWith('channel_test-email', {
      tenantId: 'tenant-1',
      organizationId: 'org-1',
      userId: null,
    })
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      credentials: { token: 'stored-token', fromAddress: 'from@example.com' },
    }))
  })

  it('uses the only tenant channel for an organization-less auth email', async () => {
    findWithDecryptionMock.mockResolvedValue([{
      providerKey: 'test-email',
      channelType: 'email',
      organizationId: 'org-1',
      isActive: true,
      status: 'connected',
    }])
    const sendMessage = jest.fn().mockResolvedValue({ externalMessageId: 'email-1', status: 'sent' })
    const adapter = {
      providerKey: 'test-email',
      channelType: 'email',
      capabilities: {} as ChannelAdapter['capabilities'],
      convertOutbound: jest.fn().mockResolvedValue({
        content: { text: 'Hello', bodyFormat: 'text' },
        metadata: { to: ['user@example.com'], subject: 'Hello', from: 'from@example.com' },
      }),
      sendMessage,
      normalizeInbound: jest.fn(),
      verifyWebhook: jest.fn(),
      getStatus: jest.fn(),
    } satisfies ChannelAdapter
    const resolveCredentials = jest.fn().mockResolvedValue({ token: 'stored-token', fromAddress: 'from@example.com' })
    const container = {
      resolve(name: string) {
        if (name === 'em') return { fork: () => ({}) }
        if (name === 'channelAdapterRegistry') return { get: () => adapter }
        if (name === 'integrationCredentialsService') return { resolve: resolveCredentials }
        throw new Error(`[internal] unexpected dependency ${name}`)
      },
    }

    await sendSystemEmail(container as never, {
      to: 'user@example.com',
      subject: 'Hello',
      from: 'from@example.com',
      text: 'Hello',
      tenantId: 'tenant-1',
      organizationId: null,
    })

    expect(resolveCredentials).toHaveBeenCalledWith('channel_test-email', {
      tenantId: 'tenant-1',
      organizationId: 'org-1',
      userId: null,
    })
  })

  it('fails closed when an organization-less auth email has multiple tenant channels', async () => {
    findWithDecryptionMock.mockResolvedValue([
      { id: 'channel-1', organizationId: 'org-1' },
      { id: 'channel-2', organizationId: 'org-2' },
    ])
    const container = {
      resolve(name: string) {
        if (name === 'em') return { fork: () => ({}) }
        throw new Error(`[internal] unexpected dependency ${name}`)
      },
    }

    await expect(sendSystemEmail(container as never, {
      to: 'user@example.com',
      subject: 'Hello',
      from: 'from@example.com',
      text: 'Hello',
      tenantId: 'tenant-1',
      organizationId: null,
    })).rejects.toThrow('SYSTEM_EMAIL_CHANNEL_AMBIGUOUS')
  })

  it('fails closed when tenant credentials cannot be resolved', async () => {
    findOneWithDecryptionMock.mockResolvedValue({
      providerKey: 'test-email',
      channelType: 'email',
      organizationId: 'org-1',
      isActive: true,
      status: 'connected',
    })
    const adapter = {
      providerKey: 'test-email',
      channelType: 'email',
      capabilities: {} as ChannelAdapter['capabilities'],
      convertOutbound: jest.fn(),
      sendMessage: jest.fn(),
      normalizeInbound: jest.fn(),
      verifyWebhook: jest.fn(),
      getStatus: jest.fn(),
    } satisfies ChannelAdapter
    const container = {
      resolve(name: string) {
        if (name === 'em') return { fork: () => ({}) }
        if (name === 'channelAdapterRegistry') return { get: () => adapter }
        if (name === 'integrationCredentialsService') return { resolve: jest.fn().mockResolvedValue(null) }
        throw new Error(`[internal] unexpected dependency ${name}`)
      },
    }

    await expect(sendSystemEmail(container as never, {
      to: 'user@example.com',
      subject: 'Hello',
      from: 'from@example.com',
      text: 'Hello',
      tenantId: 'tenant-1',
      organizationId: 'org-1',
    })).rejects.toThrow('SYSTEM_EMAIL_CREDENTIALS_NOT_CONFIGURED')
    expect(adapter.convertOutbound).not.toHaveBeenCalled()
    expect(adapter.sendMessage).not.toHaveBeenCalled()
  })

  it('fails closed when tenant credential resolution fails', async () => {
    const adapter = { providerKey: 'test-email' } as ChannelAdapter
    const channel = {
      providerKey: 'test-email',
      channelType: 'email',
      organizationId: 'org-1',
      isActive: true,
      status: 'connected',
    }
    findOneWithDecryptionMock.mockResolvedValue(channel)
    const container = {
      resolve(name: string) {
        if (name === 'em') return { fork: () => ({}) }
        if (name === 'channelAdapterRegistry') return { get: () => adapter }
        if (name === 'integrationCredentialsService') {
          return { resolve: jest.fn().mockRejectedValue(new Error('credential store unavailable')) }
        }
        throw new Error(`[internal] unexpected dependency ${name}`)
      },
    }

    await expect(sendSystemEmail(container as never, {
      to: 'user@example.com',
      subject: 'Hello',
      from: 'from@example.com',
      text: 'Hello',
      tenantId: 'tenant-1',
      organizationId: 'org-1',
    })).rejects.toThrow('credential store unavailable')
  })

  it('rejects missing tenant credentials instead of using environment credentials', async () => {
    const adapter = { providerKey: 'test-email' } as ChannelAdapter
    const channel = {
      providerKey: 'test-email',
      channelType: 'email',
      organizationId: 'org-1',
      isActive: true,
      status: 'connected',
    }
    findOneWithDecryptionMock.mockResolvedValue(channel)
    const container = {
      resolve(name: string) {
        if (name === 'em') return { fork: () => ({}) }
        if (name === 'channelAdapterRegistry') return { get: () => adapter }
        if (name === 'integrationCredentialsService') return { resolve: jest.fn().mockResolvedValue(null) }
        throw new Error(`[internal] unexpected dependency ${name}`)
      },
    }

    await expect(sendSystemEmail(container as never, {
      to: 'user@example.com',
      subject: 'Hello',
      from: 'from@example.com',
      text: 'Hello',
      tenantId: 'tenant-1',
      organizationId: 'org-1',
    })).rejects.toThrow('SYSTEM_EMAIL_CREDENTIALS_NOT_CONFIGURED')
  })

  it('reports unknown and disabled providers as unconfigured', () => {
    process.env.SYSTEM_EMAIL_PROVIDER = 'unknown-email-provider'
    expect(isSystemEmailTransportConfigured()).toBe(false)

    registerSystemEmailProviderConfigResolver({
      providerKey: 'disabled-email-provider',
      isConfigured: () => false,
      resolveCredentials: () => ({}),
    })
    process.env.SYSTEM_EMAIL_PROVIDER = 'disabled-email-provider'
    expect(isSystemEmailTransportConfigured()).toBe(false)
  })
})
