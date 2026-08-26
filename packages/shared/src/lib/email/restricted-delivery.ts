import Redis from 'ioredis'

type RestrictedDeliveryPolicy = {
  allowedRecipient: string | null
  allowedFrom: string
  limit: number
  windowSeconds: number
  key: string
  redisUrl: string
}

const CONSUME_ATTEMPT_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if not current then
  redis.call('SET', KEYS[1], 1, 'EX', ARGV[1])
  return 1
end
if tonumber(current) >= tonumber(ARGV[2]) then
  return 0
end
local consumed = redis.call('INCR', KEYS[1])
if consumed <= tonumber(ARGV[2]) then
  return 1
end
return 0
`

function normalizeMailbox(value: string): string {
  return value.trim().toLowerCase()
}

function readRequiredEnv(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error('EMAIL_DELIVERY_POLICY_CONFIG_INVALID')
  return value
}

function readPositiveInteger(name: string): number {
  const value = Number(readRequiredEnv(name))
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error('EMAIL_DELIVERY_POLICY_CONFIG_INVALID')
  }
  return value
}

function resolveRestrictedDeliveryPolicy(): RestrictedDeliveryPolicy | null {
  const strategy = process.env.EMAIL_DELIVERY_POLICY?.trim().toLowerCase()
  if (!strategy) return null
  if (strategy !== 'restricted') {
    throw new Error(`EMAIL_DELIVERY_POLICY_UNSUPPORTED: ${strategy}`)
  }

  const key = readRequiredEnv('EMAIL_DELIVERY_POLICY_KEY')
  if (!/^[A-Za-z0-9._~-]{1,64}$/.test(key)) {
    throw new Error('EMAIL_DELIVERY_POLICY_CONFIG_INVALID')
  }

  const allowedRecipient = normalizeMailbox(readRequiredEnv('EMAIL_ALLOWED_RECIPIENT'))

  return {
    allowedRecipient: allowedRecipient === '*' ? null : allowedRecipient,
    allowedFrom: normalizeMailbox(readRequiredEnv('EMAIL_ALLOWED_FROM')),
    limit: readPositiveInteger('EMAIL_DELIVERY_LIMIT'),
    windowSeconds: readPositiveInteger('EMAIL_DELIVERY_WINDOW_SECONDS'),
    key,
    redisUrl: readRequiredEnv('REDIS_URL'),
  }
}

export async function enforceRestrictedEmailDelivery(input: { to: string; from: string }): Promise<void> {
  const policy = resolveRestrictedDeliveryPolicy()
  if (!policy) return
  if (policy.allowedRecipient && normalizeMailbox(input.to) !== policy.allowedRecipient) {
    throw new Error('EMAIL_RECIPIENT_NOT_ALLOWED')
  }
  if (normalizeMailbox(input.from) !== policy.allowedFrom) {
    throw new Error('EMAIL_FROM_NOT_ALLOWED')
  }

  const redis = new Redis(policy.redisUrl, {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
  })
  try {
    await redis.connect()
    const allowed = await redis.eval(
      CONSUME_ATTEMPT_SCRIPT,
      1,
      `om:email-delivery:${policy.key}`,
      policy.windowSeconds,
      policy.limit,
    )
    if (allowed !== 1) throw new Error('EMAIL_DELIVERY_LIMIT_EXCEEDED')
  } catch (error) {
    if (error instanceof Error && error.message === 'EMAIL_DELIVERY_LIMIT_EXCEEDED') throw error
    throw new Error('EMAIL_DELIVERY_POLICY_UNAVAILABLE')
  } finally {
    redis.disconnect()
  }
}
