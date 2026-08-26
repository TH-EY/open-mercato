import type { SendEmailOptions } from './send'

type SesTransportOptions = {
  SES: {
    sesClient: import('@aws-sdk/client-sesv2').SESv2Client
    SendEmailCommand: typeof import('@aws-sdk/client-sesv2').SendEmailCommand
  }
}

function resolveSesRegion(): string {
  const region = process.env.AWS_SES_REGION?.trim() || process.env.AWS_REGION?.trim()
  if (!region) throw new Error('SES_REGION_NOT_CONFIGURED: set AWS_SES_REGION or AWS_REGION')
  return region
}

function resolveErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error'
}

async function resolveSesCredentials() {
  const credentialsFullUri = process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI?.trim()
  const authorizationTokenFile = process.env.AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE?.trim()
  if (!credentialsFullUri && !authorizationTokenFile) return undefined
  if (!credentialsFullUri || !authorizationTokenFile) {
    throw new Error(
      'SES_CREDENTIAL_BROKER_CONFIG_INVALID: set AWS_CONTAINER_CREDENTIALS_FULL_URI and AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE',
    )
  }

  let endpoint: URL
  try {
    endpoint = new URL(credentialsFullUri)
  } catch {
    throw new Error('SES_CREDENTIAL_BROKER_CONFIG_INVALID: credential endpoint must be a valid HTTPS URL')
  }
  if (
    endpoint.protocol !== 'https:' ||
    endpoint.username ||
    endpoint.password ||
    endpoint.hash ||
    endpoint.search ||
    endpoint.pathname !== '/credentials'
  ) {
    throw new Error('SES_CREDENTIAL_BROKER_CONFIG_INVALID: credential endpoint must be an exact HTTPS /credentials URL')
  }

  const { fromHttp } = await import('@aws-sdk/credential-provider-http')
  return fromHttp({
    awsContainerCredentialsFullUri: endpoint.toString(),
    awsContainerAuthorizationTokenFile: authorizationTokenFile,
    maxRetries: 0,
    timeout: 3_000,
  })
}

export async function sendEmailWithSes(
  options: SendEmailOptions & { from: string },
): Promise<void> {
  const region = resolveSesRegion()
  const [sesModule, nodemailerModule, renderModule] = await Promise.all([
    import('@aws-sdk/client-sesv2'),
    import('nodemailer'),
    import('@react-email/render'),
  ])

  const credentials = await resolveSesCredentials()
  const sesClient = new sesModule.SESv2Client({ region, ...(credentials ? { credentials } : {}) })

  try {
    const transporter = nodemailerModule.default.createTransport({
      SES: { sesClient, SendEmailCommand: sesModule.SendEmailCommand },
    } as Parameters<typeof nodemailerModule.default.createTransport>[0] & SesTransportOptions)
    const html = await renderModule.render(options.react)
    const text = renderModule.toPlainText(html)
    await transporter.sendMail({
      to: options.to,
      subject: options.subject,
      from: options.from,
      html,
      text,
      ...(options.replyTo ? { replyTo: options.replyTo } : {}),
      ...(options.attachments?.length
        ? {
            attachments: options.attachments.map((attachment) => ({
              filename: attachment.filename,
              content: attachment.content,
              encoding: 'base64' as const,
              ...(attachment.contentType ? { contentType: attachment.contentType } : {}),
            })),
          }
        : {}),
    })
  } catch (error) {
    throw new Error(`SES_SEND_FAILED: ${resolveErrorMessage(error)}`)
  } finally {
    sesClient.destroy()
  }
}
