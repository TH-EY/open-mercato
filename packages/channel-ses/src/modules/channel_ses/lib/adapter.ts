import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2'
import nodemailer from 'nodemailer'
import type {
  ChannelAdapter,
  ChannelNativeContent,
  ConvertOutboundInput,
  GetMessageStatusInput,
  InboundMessage,
  MessageStatus,
  NormalizedInboundMessage,
  SendMessageInput,
  SendMessageResult,
  VerifyWebhookInput,
} from '@open-mercato/core/modules/communication_channels/lib/adapter'
import {
  htmlToText,
  sanitizeHeaderValue,
  stringOrUndefined,
  toAddressList,
} from '@open-mercato/core/modules/communication_channels/lib/email-mime'
import { createLogger } from '@open-mercato/shared/lib/logger'
import { sesCapabilities } from '../capabilities'
import { resolveSesClientCredentials, sesCredentialsSchema } from './credentials'

const logger = createLogger('channel_ses')

type SesAttachment = {
  filename: string
  content: string
  encoding: 'base64'
  contentType?: string
}

type SesSendInfo = {
  messageId?: string
  response?: string
}

type SesTransportOptions = {
  SES: {
    sesClient: SESv2Client
    SendEmailCommand: typeof SendEmailCommand
  }
}

type SesMailOptions = Parameters<ReturnType<typeof nodemailer.createTransport>['sendMail']>[0] & {
  ses?: {
    ConfigurationSetName?: string
  }
}

type SesProviderErrorCategory = 'authorization' | 'credentials' | 'throttling' | 'configuration' | 'provider'

const knownSesProviderErrorTokens = new Set([
  'AccessDeniedException',
  'AccountSuspendedException',
  'BadRequestException',
  'ConfigurationSetDoesNotExistException',
  'CredentialsProviderError',
  'EAI_AGAIN',
  'ECONNECTION',
  'ECONNRESET',
  'ENOTFOUND',
  'ESES',
  'ETIMEDOUT',
  'ExpiredTokenException',
  'InvalidParameterValue',
  'InvalidSignatureException',
  'MailFromDomainNotVerifiedException',
  'MessageRejected',
  'NotFoundException',
  'SendingPausedException',
  'ThrottlingException',
  'TooManyRequestsException',
  'UnauthorizedException',
  'UnrecognizedClientException',
])

function knownErrorToken(value: unknown, fallback: string): string {
  return typeof value === 'string' && knownSesProviderErrorTokens.has(value) ? value : fallback
}

function classifySesProviderError(error: unknown): {
  errorName: string
  errorCode: string
  category: SesProviderErrorCategory
} {
  const record = error && typeof error === 'object' ? error as Record<string, unknown> : {}
  const errorName = knownErrorToken(record.name, 'UnknownProviderError')
  const errorCode = knownErrorToken(record.code, 'UNKNOWN')
  const classificationToken = `${errorName}:${errorCode}`.toLowerCase()
  let category: SesProviderErrorCategory = 'provider'

  if (/accessdenied|unauthorized/.test(classificationToken)) category = 'authorization'
  else if (/credential|expiredtoken|invalidsignature|unrecognizedclient/.test(classificationToken)) category = 'credentials'
  else if (/throttl|toomanyrequests/.test(classificationToken)) category = 'throttling'
  else if (/invalidparameter|messagerejected|mailfromdomainnotverified/.test(classificationToken)) category = 'configuration'

  return { errorName, errorCode, category }
}

function attachmentsFromMeta(value: unknown): SesAttachment[] | undefined {
  if (!Array.isArray(value)) return undefined
  const attachments = value.flatMap((item): SesAttachment[] => {
    if (!item || typeof item !== 'object') return []
    const record = item as Record<string, unknown>
    const filename = stringOrUndefined(record.filename)
    const content = stringOrUndefined(record.content)
    if (!filename || !content) return []
    const contentType = stringOrUndefined(record.contentType)
    return [{
      filename,
      content,
      encoding: 'base64',
      ...(contentType ? { contentType } : {}),
    }]
  })
  return attachments.length ? attachments : undefined
}

class SesChannelAdapter implements ChannelAdapter {
  readonly providerKey = 'ses'
  readonly channelType = 'email'
  readonly capabilities = sesCapabilities

  async sendMessage(input: SendMessageInput): Promise<SendMessageResult> {
    const credentials = sesCredentialsSchema.parse(input.credentials)
    const meta = (input.metadata ?? {}) as Record<string, unknown>
    const to = Array.isArray(meta.to) ? (meta.to as string[]) : []
    if (to.length === 0) {
      return { externalMessageId: '', status: 'failed', error: '[internal] Email send requires at least one recipient' }
    }
    const subject = stringOrUndefined(meta.subject)
    if (!subject) {
      return { externalMessageId: '', status: 'failed', error: '[internal] Email send requires a subject' }
    }

    const explicitCredentials = resolveSesClientCredentials(credentials)
    const sesClient = new SESv2Client({
      region: credentials.region,
      ...(explicitCredentials ? { credentials: explicitCredentials } : {}),
    })
    const transporter = nodemailer.createTransport({
      SES: { sesClient, SendEmailCommand },
    } as Parameters<typeof nodemailer.createTransport>[0] & SesTransportOptions)
    const configurationSetName = stringOrUndefined(credentials.configurationSetName)
    const options: SesMailOptions = {
      from: credentials.fromAddress,
      to,
      subject,
      ...(input.content.text ? { text: input.content.text } : {}),
      ...(input.content.html ? { html: input.content.html } : {}),
      ...(stringOrUndefined(meta.replyTo) ? { replyTo: stringOrUndefined(meta.replyTo) } : {}),
      ...(attachmentsFromMeta(meta.attachments)?.length ? { attachments: attachmentsFromMeta(meta.attachments) } : {}),
      ...(configurationSetName ? { ses: { ConfigurationSetName: configurationSetName } } : {}),
    }

    try {
      const info = await transporter.sendMail(options) as SesSendInfo
      return {
        externalMessageId: info.messageId || `ses:${Date.now()}`,
        conversationId: input.conversationId,
        status: 'sent',
        metadata: info.response ? { response: info.response } : undefined,
      }
    } catch (error) {
      logger.error('channel_ses SES send failed', classifySesProviderError(error))
      return { externalMessageId: '', status: 'failed', error: 'SES_SEND_FAILED' }
    }
  }

  async verifyWebhook(_input: VerifyWebhookInput): Promise<InboundMessage> {
    return { raw: {}, eventType: 'other', metadata: { reason: 'ses-system-email-outbound-only' } }
  }

  async getStatus(_input: GetMessageStatusInput): Promise<MessageStatus> {
    return { status: 'sent' }
  }

  async normalizeInbound(_raw: InboundMessage): Promise<NormalizedInboundMessage> {
    throw new Error('[internal] Amazon SES system email adapter is outbound-only')
  }

  async convertOutbound(input: ConvertOutboundInput): Promise<ChannelNativeContent> {
    const meta = (input.channelMetadata ?? {}) as Record<string, unknown>
    const to = toAddressList(meta.to).map(sanitizeHeaderValue)
    const subject = stringOrUndefined(meta.subject)
    const html = input.bodyFormat === 'html' ? input.body : undefined
    const text = input.bodyFormat === 'html' ? htmlToText(input.body) : input.body
    return {
      content: {
        text,
        html,
        bodyFormat: input.bodyFormat,
      },
      metadata: {
        to,
        subject,
        from: stringOrUndefined(meta.from),
        replyTo: stringOrUndefined(meta.replyTo),
        attachments: attachmentsFromMeta(meta.attachments),
      },
    }
  }
}

const adapter = new SesChannelAdapter()

export function getSesChannelAdapter(): ChannelAdapter {
  return adapter
}
