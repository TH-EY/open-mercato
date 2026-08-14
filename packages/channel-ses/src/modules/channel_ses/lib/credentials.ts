import { z } from 'zod'

export const sesCredentialsSchema = z.object({
  region: z.string().min(1),
  fromAddress: z.string().email(),
  configurationSetName: z.string().min(1).optional(),
  authMode: z.enum(['ambient', 'access_keys']).optional(),
  accessKeyId: z.string().min(1).optional(),
  secretAccessKey: z.string().min(1).optional(),
}).superRefine((credentials, ctx) => {
  const hasAccessKeyId = Boolean(credentials.accessKeyId)
  const hasSecretAccessKey = Boolean(credentials.secretAccessKey)
  const hasCompletePair = hasAccessKeyId && hasSecretAccessKey

  if (hasAccessKeyId !== hasSecretAccessKey) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'AWS access key ID and secret access key must be provided together',
    })
  }
  if (credentials.authMode === 'access_keys' && !hasCompletePair) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Access-key authentication requires a complete AWS credential pair',
    })
  }
  if (credentials.authMode !== 'access_keys' && (hasAccessKeyId || hasSecretAccessKey)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Explicit AWS credentials require access-key authentication mode',
    })
  }
})

export const sesExplicitCredentialsInputSchema = z.object({
  accessKeyId: z.string().min(1),
  secretAccessKey: z.string().min(1),
}).strict()

export type SesCredentials = z.infer<typeof sesCredentialsSchema>
export type SesExplicitCredentialsInput = z.infer<typeof sesExplicitCredentialsInputSchema>

export function resolveSesClientCredentials(
  credentials: SesCredentials,
): { accessKeyId: string; secretAccessKey: string } | undefined {
  if (credentials.authMode !== 'access_keys') return undefined
  return {
    accessKeyId: credentials.accessKeyId!,
    secretAccessKey: credentials.secretAccessKey!,
  }
}
