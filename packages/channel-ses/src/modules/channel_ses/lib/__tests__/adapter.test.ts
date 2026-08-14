import { getSesChannelAdapter } from '../adapter'

var sendMailMock: jest.Mock
var createTransportMock: jest.Mock
var SESv2ClientMock: jest.Mock
var SendEmailCommandMock: jest.Mock
var loggerErrorMock: jest.Mock

jest.mock('nodemailer', () => {
  sendMailMock = jest.fn().mockResolvedValue({ messageId: 'ses-1', response: 'ok' })
  createTransportMock = jest.fn().mockReturnValue({ sendMail: sendMailMock })
  return { __esModule: true, default: { createTransport: createTransportMock } }
})

jest.mock('@aws-sdk/client-sesv2', () => {
  SESv2ClientMock = jest.fn()
  SendEmailCommandMock = jest.fn()
  return {
    SESv2Client: SESv2ClientMock,
    SendEmailCommand: SendEmailCommandMock,
  }
})

jest.mock('@open-mercato/shared/lib/logger', () => {
  loggerErrorMock = jest.fn()
  return {
    createLogger: jest.fn(() => ({
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: loggerErrorMock,
      child: jest.fn(),
    })),
  }
})

describe('SesChannelAdapter', () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = { ...originalEnv }
    sendMailMock.mockClear()
    createTransportMock.mockClear()
    SESv2ClientMock.mockClear()
    SendEmailCommandMock.mockClear()
    loggerErrorMock.mockClear()
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it('sends html email through Nodemailer SES transport', async () => {
    const adapter = getSesChannelAdapter()
    const converted = await adapter.convertOutbound({
      body: '<p>Hello</p>',
      bodyFormat: 'html',
      channelMetadata: {
        to: 'user@example.com',
        subject: 'Hello',
        from: 'from@example.com',
        replyTo: 'reply@example.com',
        attachments: [{ filename: 'a.txt', content: 'dGVzdA==', contentType: 'text/plain' }],
      },
    })

    const result = await adapter.sendMessage({
      content: converted.content,
      credentials: {
        region: 'eu-west-2',
        fromAddress: 'fallback@example.com',
        configurationSetName: 'default',
      },
      scope: { tenantId: 'tenant', organizationId: 'org' },
      metadata: converted.metadata,
    })

    expect(result).toEqual(expect.objectContaining({ status: 'sent', externalMessageId: 'ses-1' }))
    expect(SESv2ClientMock).toHaveBeenCalledWith({ region: 'eu-west-2' })
    expect(createTransportMock).toHaveBeenCalledWith(expect.objectContaining({ SES: expect.any(Object) }))
    expect(sendMailMock).toHaveBeenCalledWith(expect.objectContaining({
      from: 'fallback@example.com',
      to: ['user@example.com'],
      subject: 'Hello',
      html: '<p>Hello</p>',
      text: 'Hello',
      replyTo: 'reply@example.com',
      attachments: [{ filename: 'a.txt', content: 'dGVzdA==', encoding: 'base64', contentType: 'text/plain' }],
      ses: { ConfigurationSetName: 'default' },
    }))
  })

  it('returns a failed result when the SES transport rejects', async () => {
    sendMailMock.mockRejectedValueOnce({
      name: 'AccessDeniedException',
      code: 'ESES',
      message: 'secret/request payload marker',
      request: { credentials: 'must-not-be-logged' },
    })
    const adapter = getSesChannelAdapter()

    const result = await adapter.sendMessage({
      content: { text: 'Hello' },
      credentials: { region: 'eu-west-2', fromAddress: 'from@example.com' },
      scope: { tenantId: 'tenant', organizationId: 'org' },
      metadata: { to: ['user@example.com'], subject: 'Hello' },
    })

    expect(result).toEqual(expect.objectContaining({
      status: 'failed',
      error: 'SES_SEND_FAILED',
    }))
    expect(loggerErrorMock).toHaveBeenCalledWith('channel_ses SES send failed', {
      errorName: 'AccessDeniedException',
      errorCode: 'ESES',
      category: 'authorization',
    })
    expect(JSON.stringify(loggerErrorMock.mock.calls)).not.toContain('secret/request payload marker')
    expect(JSON.stringify(loggerErrorMock.mock.calls)).not.toContain('must-not-be-logged')
  })

  it.each([
    ['AKIAEXAMPLECREDENTIAL', 'OpaqueSecretToken123456'],
    ['user@example.com', 'request-123'],
    ['AccessDeniedException\nforged', 'ESES\nforged'],
  ])('redacts unknown provider error identifiers', async (name, code) => {
    sendMailMock.mockRejectedValueOnce({ name, code })
    const adapter = getSesChannelAdapter()

    await adapter.sendMessage({
      content: { text: 'Hello' },
      credentials: { region: 'eu-west-2', fromAddress: 'from@example.com' },
      scope: { tenantId: 'tenant', organizationId: 'org' },
      metadata: { to: ['user@example.com'], subject: 'Hello' },
    })

    expect(loggerErrorMock).toHaveBeenCalledWith('channel_ses SES send failed', {
      errorName: 'UnknownProviderError',
      errorCode: 'UNKNOWN',
      category: 'provider',
    })
    expect(JSON.stringify(loggerErrorMock.mock.calls)).not.toContain(name)
    expect(JSON.stringify(loggerErrorMock.mock.calls)).not.toContain(code)
  })

  it('uses dedicated credentials only when the channel explicitly opts in', async () => {
    const adapter = getSesChannelAdapter()

    await adapter.sendMessage({
      content: { text: 'Hello' },
      credentials: {
        region: 'eu-west-2',
        fromAddress: 'from@example.com',
        authMode: 'access_keys',
        accessKeyId: 'access-key-id',
        secretAccessKey: 'secret-access-key',
      },
      scope: { tenantId: 'tenant', organizationId: 'org' },
      metadata: { to: ['user@example.com'], subject: 'Hello' },
    })

    expect(SESv2ClientMock).toHaveBeenCalledWith({
      region: 'eu-west-2',
      credentials: { accessKeyId: 'access-key-id', secretAccessKey: 'secret-access-key' },
    })
  })
})
