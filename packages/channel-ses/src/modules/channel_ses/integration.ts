import { buildIntegrationDetailWidgetSpotId, type IntegrationBundle, type IntegrationDefinition } from '@open-mercato/shared/modules/integrations/types'

export const channelSesDetailWidgetSpotId = buildIntegrationDetailWidgetSpotId('channel_ses')

export const integration: IntegrationDefinition = {
  id: 'channel_ses',
  title: 'Amazon SES',
  description: 'Send transactional email through Amazon SES using the Communications Hub.',
  category: 'communication',
  hub: 'communication_channels',
  providerKey: 'ses',
  icon: 'mail',
  docsUrl: 'https://docs.aws.amazon.com/ses/',
  package: '@open-mercato/channel-ses',
  version: '0.6.6',
  author: 'Open Mercato Team',
  company: 'Open Mercato',
  license: 'MIT',
  tags: ['email', 'aws', 'ses', 'transactional', 'communication'],
  detailPage: {
    widgetSpotId: channelSesDetailWidgetSpotId,
  },
  apiVersions: [
    {
      id: 'sesv2',
      label: 'Amazon SES v2',
      status: 'stable',
      default: true,
      changelog: 'Initial outbound transactional email adapter.',
    },
  ],
  healthCheck: { service: 'channelSesHealthCheck' },
  credentials: {
    fields: [
      {
        key: 'region',
        label: 'AWS region',
        type: 'text',
        required: true,
        placeholder: 'eu-west-2',
        helpText: 'SES region used for this tenant connection.',
      },
      {
        key: 'fromAddress',
        label: 'From address',
        type: 'text',
        required: true,
        placeholder: 'no-reply@example.com',
        helpText: 'Verified SES sender address or domain identity.',
      },
      {
        key: 'configurationSetName',
        label: 'Configuration set',
        type: 'text',
        required: false,
        helpText: 'Optional SES configuration set name.',
      },
      {
        key: 'authMode',
        label: 'Authentication',
        type: 'select',
        required: false,
        helpText: 'Use the AWS SDK default credential chain unless this channel has a dedicated access key.',
        options: [
          { value: 'ambient', label: 'AWS SDK default credential chain' },
          { value: 'access_keys', label: 'Dedicated access key' },
        ],
      },
      {
        key: 'accessKeyId',
        label: 'Access key ID',
        type: 'secret',
        required: true,
        helpText: 'Dedicated IAM access key ID for this SES channel.',
        visibleWhen: { field: 'authMode', equals: 'access_keys' },
      },
      {
        key: 'secretAccessKey',
        label: 'Secret access key',
        type: 'secret',
        required: true,
        helpText: 'Dedicated IAM secret access key for this SES channel.',
        visibleWhen: { field: 'authMode', equals: 'access_keys' },
      },
    ],
  },
}

export const integrations: IntegrationDefinition[] = [integration]
export const bundles: IntegrationBundle[] = []
export const bundle: IntegrationBundle | undefined = undefined
