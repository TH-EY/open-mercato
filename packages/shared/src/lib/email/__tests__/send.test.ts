import React from 'react'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { sendEmail } from '../send'

var sendMock: jest.Mock
var ResendMock: jest.Mock
var sesSendMailMock: jest.Mock
var createTransportMock: jest.Mock
var sesDestroyMock: jest.Mock
var SESv2ClientMock: jest.Mock
var SendEmailCommandMock: jest.Mock
var fromHttpMock: jest.Mock
var brokerCredentialsProvider: jest.Mock
var RedisMock: jest.Mock
var redisConnectMock: jest.Mock
var redisEvalMock: jest.Mock
var redisDisconnectMock: jest.Mock

jest.mock('resend', () => {
  sendMock = jest.fn().mockResolvedValue({ data: { id: 'email-1' } })
  ResendMock = jest.fn().mockImplementation(() => ({
    emails: { send: sendMock },
  }))

  return { Resend: ResendMock }
})

jest.mock('nodemailer', () => {
  sesSendMailMock = jest.fn().mockResolvedValue({ messageId: 'ses-1' })
  createTransportMock = jest.fn().mockReturnValue({ sendMail: sesSendMailMock })
  return { __esModule: true, default: { createTransport: createTransportMock } }
})

jest.mock('@aws-sdk/client-sesv2', () => {
  sesDestroyMock = jest.fn()
  SESv2ClientMock = jest.fn().mockImplementation(() => ({ destroy: sesDestroyMock }))
  SendEmailCommandMock = jest.fn()
  return { SESv2Client: SESv2ClientMock, SendEmailCommand: SendEmailCommandMock }
})

jest.mock('@aws-sdk/credential-provider-http', () => {
  brokerCredentialsProvider = jest.fn().mockResolvedValue({
    accessKeyId: 'broker-access',
    secretAccessKey: 'broker-secret',
    sessionToken: 'broker-session',
  })
  fromHttpMock = jest.fn().mockReturnValue(brokerCredentialsProvider)
  return { fromHttp: fromHttpMock }
})

jest.mock('@react-email/render', () => ({
  render: jest.fn().mockResolvedValue('<html><body><div>Hi</div></body></html>'),
  toPlainText: jest.fn().mockReturnValue('Hi'),
}))

jest.mock('ioredis', () => {
  redisConnectMock = jest.fn().mockResolvedValue(undefined)
  redisEvalMock = jest.fn().mockResolvedValue(1)
  redisDisconnectMock = jest.fn()
  RedisMock = jest.fn().mockImplementation(() => ({
    connect: redisConnectMock,
    eval: redisEvalMock,
    disconnect: redisDisconnectMock,
  }))
  return { __esModule: true, default: RedisMock }
})

describe('sendEmail', () => {
  const originalEnv = process.env
  let tempDir: string | null = null

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      RESEND_API_KEY: 'test-key',
      EMAIL_FROM: 'from@example.com',
    }
    delete process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI
    delete process.env.AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE
    sendMock.mockClear()
    ResendMock.mockClear()
    sesSendMailMock?.mockClear()
    createTransportMock?.mockClear()
    sesDestroyMock?.mockClear()
    SESv2ClientMock?.mockClear()
    SendEmailCommandMock?.mockClear()
    fromHttpMock?.mockClear()
    brokerCredentialsProvider?.mockClear()
    RedisMock?.mockClear()
    redisConnectMock?.mockClear()
    redisEvalMock?.mockReset().mockResolvedValue(1)
    redisDisconnectMock?.mockClear()
  })

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true })
      tempDir = null
    }
    process.env = originalEnv
  })

  it('maps replyTo to reply_to in Resend payload', async () => {
    await sendEmail({
      to: 'user@example.com',
      subject: 'Hello',
      react: React.createElement('div', null, 'Hi'),
      replyTo: 'reply@example.com',
    })

    expect(ResendMock).toHaveBeenCalledWith('test-key')
    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'user@example.com',
        subject: 'Hello',
        from: 'from@example.com',
        reply_to: 'reply@example.com',
      })
    )
  })

  it('preserves the Resend API key error before sender validation when unconfigured', async () => {
    delete process.env.EMAIL_STRATEGY
    delete process.env.RESEND_API_KEY
    delete process.env.NOTIFICATIONS_EMAIL_FROM
    delete process.env.EMAIL_FROM
    delete process.env.ADMIN_EMAIL

    await expect(sendEmail({
      to: 'user@example.com',
      subject: 'Hello',
      react: React.createElement('div', null, 'Hi'),
    })).rejects.toThrow('RESEND_API_KEY is not set')

    expect(ResendMock).not.toHaveBeenCalled()
    expect(SESv2ClientMock?.mock.calls ?? []).toHaveLength(0)
  })

  it('sends through SES when the explicit email strategy is ses', async () => {
    process.env.EMAIL_STRATEGY = 'ses'
    process.env.AWS_SES_REGION = 'eu-west-2'
    process.env.AWS_REGION = 'us-east-1'
    delete process.env.RESEND_API_KEY

    await sendEmail({
      to: 'user@example.com',
      subject: 'Hello',
      react: React.createElement('div', null, 'Hi'),
      replyTo: 'reply@example.com',
      attachments: [{ filename: 'invoice.pdf', content: 'dGVzdA==', contentType: 'application/pdf' }],
    })

    expect(ResendMock).not.toHaveBeenCalled()
    expect(SESv2ClientMock).toHaveBeenCalledWith({ region: 'eu-west-2' })
    expect(sesSendMailMock).toHaveBeenCalledWith(expect.objectContaining({
      to: 'user@example.com',
      subject: 'Hello',
      from: 'from@example.com',
      html: '<html><body><div>Hi</div></body></html>',
      text: 'Hi',
      replyTo: 'reply@example.com',
      attachments: [{
        filename: 'invoice.pdf',
        content: 'dGVzdA==',
        encoding: 'base64',
        contentType: 'application/pdf',
      }],
    }))
    expect(sesDestroyMock).toHaveBeenCalledTimes(1)
  })

  it('enforces an exact restricted recipient and sender before creating an SES client', async () => {
    process.env.EMAIL_STRATEGY = 'ses'
    process.env.AWS_SES_REGION = 'eu-west-2'
    process.env.EMAIL_DELIVERY_POLICY = 'restricted'
    process.env.EMAIL_DELIVERY_POLICY_KEY = 'public-demo-v1'
    process.env.EMAIL_ALLOWED_RECIPIENT = 'success@simulator.amazonses.com'
    process.env.EMAIL_ALLOWED_FROM = 'from@example.com'
    process.env.EMAIL_DELIVERY_LIMIT = '10'
    process.env.EMAIL_DELIVERY_WINDOW_SECONDS = '86400'
    process.env.REDIS_URL = 'redis://redis:6379'

    await expect(sendEmail({
      to: 'other@example.invalid',
      subject: 'Hello',
      react: React.createElement('div', null, 'Hi'),
    })).rejects.toThrow('EMAIL_RECIPIENT_NOT_ALLOWED')
    await expect(sendEmail({
      to: 'success@simulator.amazonses.com',
      from: 'other@example.invalid',
      subject: 'Hello',
      react: React.createElement('div', null, 'Hi'),
    })).rejects.toThrow('EMAIL_FROM_NOT_ALLOWED')

    expect(RedisMock).not.toHaveBeenCalled()
    expect(SESv2ClientMock).not.toHaveBeenCalled()
    expect(sesSendMailMock).not.toHaveBeenCalled()
  })

  it('passes the exact HTTPS broker provider to SES without falling back to the default chain', async () => {
    process.env.EMAIL_STRATEGY = 'ses'
    process.env.AWS_SES_REGION = 'eu-west-2'
    process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI = 'https://broker.internal:4900/credentials'
    process.env.AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE = '/run/broker/token'

    await sendEmail({
      to: 'user@example.com',
      subject: 'Hello',
      react: React.createElement('div', null, 'Hi'),
    })

    expect(fromHttpMock).toHaveBeenCalledWith({
      awsContainerCredentialsFullUri: 'https://broker.internal:4900/credentials',
      awsContainerAuthorizationTokenFile: '/run/broker/token',
      maxRetries: 0,
      timeout: 3000,
    })
    expect(SESv2ClientMock).toHaveBeenCalledWith({
      region: 'eu-west-2',
      credentials: brokerCredentialsProvider,
    })
  })

  it('fails before creating SES when broker configuration is partial or non-HTTPS', async () => {
    process.env.EMAIL_STRATEGY = 'ses'
    process.env.AWS_SES_REGION = 'eu-west-2'
    process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI = 'https://broker.internal:4900/credentials'

    await expect(sendEmail({
      to: 'user@example.com',
      subject: 'Hello',
      react: React.createElement('div', null, 'Hi'),
    })).rejects.toThrow('SES_CREDENTIAL_BROKER_CONFIG_INVALID')

    process.env.AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE = '/run/broker/token'
    process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI = 'http://broker.internal:4900/credentials'
    await expect(sendEmail({
      to: 'user@example.com',
      subject: 'Hello',
      react: React.createElement('div', null, 'Hi'),
    })).rejects.toThrow('SES_CREDENTIAL_BROKER_CONFIG_INVALID')

    expect(fromHttpMock).not.toHaveBeenCalled()
    expect(SESv2ClientMock).not.toHaveBeenCalled()
  })

  it('fails closed before SES when restricted policy configuration or Redis is unavailable', async () => {
    process.env.EMAIL_STRATEGY = 'ses'
    process.env.AWS_SES_REGION = 'eu-west-2'
    process.env.EMAIL_DELIVERY_POLICY = 'restricted'
    process.env.EMAIL_DELIVERY_POLICY_KEY = 'public-demo-v1'
    process.env.EMAIL_ALLOWED_RECIPIENT = 'success@simulator.amazonses.com'
    process.env.EMAIL_ALLOWED_FROM = 'from@example.com'
    process.env.EMAIL_DELIVERY_LIMIT = '10'
    process.env.EMAIL_DELIVERY_WINDOW_SECONDS = '86400'
    delete process.env.REDIS_URL

    await expect(sendEmail({
      to: 'success@simulator.amazonses.com',
      subject: 'Hello',
      react: React.createElement('div', null, 'Hi'),
    })).rejects.toThrow('EMAIL_DELIVERY_POLICY_CONFIG_INVALID')

    process.env.REDIS_URL = 'redis://redis:6379'
    redisConnectMock.mockRejectedValueOnce(new Error('connection refused'))
    await expect(sendEmail({
      to: 'success@simulator.amazonses.com',
      subject: 'Hello',
      react: React.createElement('div', null, 'Hi'),
    })).rejects.toThrow('EMAIL_DELIVERY_POLICY_UNAVAILABLE')

    expect(redisDisconnectMock).toHaveBeenCalledTimes(1)
    expect(SESv2ClientMock).not.toHaveBeenCalled()
    expect(sesSendMailMock).not.toHaveBeenCalled()
  })

  it('allows at most ten provider calls across concurrent restricted attempts', async () => {
    process.env.EMAIL_STRATEGY = 'ses'
    process.env.AWS_SES_REGION = 'eu-west-2'
    process.env.EMAIL_DELIVERY_POLICY = 'restricted'
    process.env.EMAIL_DELIVERY_POLICY_KEY = 'public-demo-v1'
    process.env.EMAIL_ALLOWED_RECIPIENT = 'success@simulator.amazonses.com'
    process.env.EMAIL_ALLOWED_FROM = 'from@example.com'
    process.env.EMAIL_DELIVERY_LIMIT = '10'
    process.env.EMAIL_DELIVERY_WINDOW_SECONDS = '86400'
    process.env.REDIS_URL = 'redis://redis:6379'
    let attempts = 0
    redisEvalMock.mockImplementation(async () => {
      attempts += 1
      return attempts <= 10 ? 1 : 0
    })

    const results = await Promise.allSettled(Array.from({ length: 20 }, () => sendEmail({
      to: 'success@simulator.amazonses.com',
      subject: 'Hello',
      react: React.createElement('div', null, 'Hi'),
    })))

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(10)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(10)
    expect(sesSendMailMock).toHaveBeenCalledTimes(10)
    expect(redisEvalMock).toHaveBeenCalledTimes(20)
    expect(redisDisconnectMock).toHaveBeenCalledTimes(20)
  })

  it('fails before creating an SES client when no region is configured', async () => {
    process.env.EMAIL_STRATEGY = 'ses'
    delete process.env.RESEND_API_KEY
    delete process.env.AWS_SES_REGION
    delete process.env.AWS_REGION

    await expect(sendEmail({
      to: 'user@example.com',
      subject: 'Hello',
      react: React.createElement('div', null, 'Hi'),
    })).rejects.toThrow('SES_REGION_NOT_CONFIGURED')

    expect(SESv2ClientMock).not.toHaveBeenCalled()
    expect(sesSendMailMock).not.toHaveBeenCalled()
  })

  it('closes SES resources when the provider rejects', async () => {
    process.env.EMAIL_STRATEGY = 'ses'
    process.env.AWS_REGION = 'eu-west-2'
    delete process.env.AWS_SES_REGION
    delete process.env.RESEND_API_KEY
    sesSendMailMock.mockRejectedValueOnce(new Error('access denied'))

    await expect(sendEmail({
      to: 'user@example.com',
      subject: 'Hello',
      react: React.createElement('div', null, 'Hi'),
    })).rejects.toThrow('SES_SEND_FAILED: access denied')

    expect(SESv2ClientMock).toHaveBeenCalledWith({ region: 'eu-west-2' })
    expect(sesDestroyMock).toHaveBeenCalledTimes(1)
  })

  it('destroys the SES client when transport construction fails', async () => {
    process.env.EMAIL_STRATEGY = 'ses'
    process.env.AWS_REGION = 'eu-west-2'
    delete process.env.AWS_SES_REGION
    delete process.env.RESEND_API_KEY
    createTransportMock.mockImplementationOnce(() => {
      throw new Error('transport setup failed')
    })

    await expect(sendEmail({
      to: 'user@example.com',
      subject: 'Hello',
      react: React.createElement('div', null, 'Hi'),
    })).rejects.toThrow('SES_SEND_FAILED: transport setup failed')

    expect(sesSendMailMock).not.toHaveBeenCalled()
    expect(sesDestroyMock).toHaveBeenCalledTimes(1)
  })

  it('fails closed for an unsupported email strategy', async () => {
    process.env.EMAIL_STRATEGY = 'unknown'

    await expect(sendEmail({
      to: 'user@example.com',
      subject: 'Hello',
      react: React.createElement('div', null, 'Hi'),
    })).rejects.toThrow('EMAIL_STRATEGY_UNSUPPORTED: unknown')

    expect(ResendMock).not.toHaveBeenCalled()
    expect(SESv2ClientMock).not.toHaveBeenCalled()
  })

  it('preserves Resend when the strategy is explicitly resend', async () => {
    process.env.EMAIL_STRATEGY = 'resend'

    await sendEmail({
      to: 'user@example.com',
      subject: 'Hello',
      react: React.createElement('div', null, 'Hi'),
    })

    expect(ResendMock).toHaveBeenCalledWith('test-key')
    expect(SESv2ClientMock).not.toHaveBeenCalled()
  })

  it('omits reply_to when replyTo is not provided', async () => {
    await sendEmail({
      to: 'user@example.com',
      subject: 'Hello',
      react: React.createElement('div', null, 'Hi'),
    })

    const payload = sendMock.mock.calls[0]?.[0] as Record<string, unknown>
    expect(payload).toBeDefined()
    expect(payload.reply_to).toBeUndefined()
  })

  it('passes attachments to Resend payload when provided', async () => {
    await sendEmail({
      to: 'user@example.com',
      subject: 'Hello',
      react: React.createElement('div', null, 'Hi'),
      attachments: [
        {
          filename: 'invoice.pdf',
          content: 'dGVzdA==',
          contentType: 'application/pdf',
        },
      ],
    })

    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        attachments: [
          {
            filename: 'invoice.pdf',
            content: 'dGVzdA==',
            contentType: 'application/pdf',
          },
        ],
      })
    )
  })

  it('throws when Resend returns an error', async () => {
    sendMock.mockResolvedValueOnce({ error: { message: 'invalid domain' } })

    await expect(sendEmail({
      to: 'user@example.com',
      subject: 'Hello',
      react: React.createElement('div', null, 'Hi'),
    })).rejects.toThrow('RESEND_SEND_FAILED: invalid domain')
  })

  it('falls back to NOTIFICATIONS_EMAIL_FROM when EMAIL_FROM is not set', async () => {
    delete process.env.EMAIL_FROM
    process.env.NOTIFICATIONS_EMAIL_FROM = 'notifications@example.com'

    await sendEmail({
      to: 'user@example.com',
      subject: 'Hello',
      react: React.createElement('div', null, 'Hi'),
    })

    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        from: 'notifications@example.com',
      })
    )
  })

  it('falls back to ADMIN_EMAIL when sender-specific env vars are not set', async () => {
    delete process.env.EMAIL_FROM
    delete process.env.NOTIFICATIONS_EMAIL_FROM
    process.env.ADMIN_EMAIL = 'admin@example.com'

    await sendEmail({
      to: 'user@example.com',
      subject: 'Hello',
      react: React.createElement('div', null, 'Hi'),
    })

    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        from: 'admin@example.com',
      })
    )
  })

  it('throws a clear error when no sender address is configured', async () => {
    delete process.env.EMAIL_FROM
    delete process.env.NOTIFICATIONS_EMAIL_FROM
    delete process.env.ADMIN_EMAIL

    await expect(sendEmail({
      to: 'user@example.com',
      subject: 'Hello',
      react: React.createElement('div', null, 'Hi'),
    })).rejects.toThrow('EMAIL_FROM_NOT_CONFIGURED')
  })

  it('skips external delivery in test mode when email delivery is disabled', async () => {
    process.env.OM_DISABLE_EMAIL_DELIVERY = '1'
    process.env.EMAIL_STRATEGY = 'ses'
    delete process.env.RESEND_API_KEY
    delete process.env.AWS_SES_REGION
    delete process.env.AWS_REGION

    await sendEmail({
      to: 'user@example.com',
      subject: 'Hello',
      react: React.createElement('div', null, 'Hi'),
    })

    expect(ResendMock).not.toHaveBeenCalled()
    expect(sendMock).not.toHaveBeenCalled()
    expect(SESv2ClientMock).not.toHaveBeenCalled()
    expect(sesSendMailMock).not.toHaveBeenCalled()
  })

  it('captures email links in OM_TEST_MODE without external delivery', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'om-email-capture-'))
    const capturePath = join(tempDir, 'emails.jsonl')
    process.env.OM_TEST_MODE = '1'
    process.env.OM_TEST_EMAIL_CAPTURE_PATH = capturePath
    delete process.env.RESEND_API_KEY

    await sendEmail({
      to: 'user@example.com',
      subject: 'Invite',
      react: React.createElement('div', null, [
        React.createElement('p', { key: 'text' }, 'Accept your invite'),
        React.createElement('a', { key: 'link', href: 'https://example.com/portal/invite?token=raw' }, 'Accept'),
      ]),
    })

    const rows = (await readFile(capturePath, 'utf8')).trim().split('\n')
    expect(rows).toHaveLength(1)
    expect(JSON.parse(rows[0])).toEqual(expect.objectContaining({
      to: 'user@example.com',
      subject: 'Invite',
      links: ['https://example.com/portal/invite?token=raw'],
      text: 'Accept your invite Accept',
    }))
    expect(ResendMock).not.toHaveBeenCalled()
    expect(sendMock).not.toHaveBeenCalled()
  })
})
