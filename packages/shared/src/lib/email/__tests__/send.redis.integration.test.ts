import React from 'react'
import Redis from 'ioredis'
import { sendEmail } from '../send'

var sesSendMailMock: jest.Mock

jest.mock('resend', () => ({ Resend: jest.fn() }))

jest.mock('nodemailer', () => {
  sesSendMailMock = jest.fn().mockResolvedValue({ messageId: 'ses-integration-1' })
  return {
    __esModule: true,
    default: { createTransport: jest.fn().mockReturnValue({ sendMail: sesSendMailMock }) },
  }
})

jest.mock('@aws-sdk/client-sesv2', () => {
  return {
    SESv2Client: jest.fn().mockImplementation(() => ({ destroy: jest.fn() })),
    SendEmailCommand: jest.fn(),
  }
})

jest.mock('@react-email/render', () => ({
  render: jest.fn().mockResolvedValue('<html><body><div>Hi</div></body></html>'),
  toPlainText: jest.fn().mockReturnValue('Hi'),
}))

const redisUrl = process.env.OM_EMAIL_REDIS_INTEGRATION_URL?.trim()
const describeWithRedis = redisUrl ? describe : describe.skip

describeWithRedis('sendEmail restricted delivery with real Redis', () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      EMAIL_STRATEGY: 'ses',
      AWS_SES_REGION: 'eu-west-2',
      EMAIL_FROM: 'from@example.com',
      EMAIL_DELIVERY_POLICY: 'restricted',
      EMAIL_ALLOWED_RECIPIENT: 'success@simulator.amazonses.com',
      EMAIL_ALLOWED_FROM: 'from@example.com',
      EMAIL_DELIVERY_LIMIT: '10',
      EMAIL_DELIVERY_WINDOW_SECONDS: '86400',
      REDIS_URL: redisUrl,
    }
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it('atomically caps concurrent provider calls and anchors the quota TTL', async () => {
    const policyKey = `public-demo-real-redis-${process.pid}-${Date.now()}`
    const redisKey = `om:email-delivery:${policyKey}`
    process.env.EMAIL_DELIVERY_POLICY_KEY = policyKey
    const redis = new Redis(redisUrl as string, {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
    })

    try {
      await redis.connect()
      await redis.del(redisKey)

      const results = await Promise.allSettled(Array.from({ length: 20 }, () => sendEmail({
        to: 'success@simulator.amazonses.com',
        subject: 'Concurrent quota probe',
        react: React.createElement('div', null, 'Hi'),
      })))

      const fulfilled = results.filter((result) => result.status === 'fulfilled')
      const rejected = results.filter((result) => result.status === 'rejected')
      expect(fulfilled).toHaveLength(10)
      expect(rejected).toHaveLength(10)
      for (const result of rejected) {
        expect((result as PromiseRejectedResult).reason).toEqual(
          expect.objectContaining({ message: 'EMAIL_DELIVERY_LIMIT_EXCEEDED' }),
        )
      }
      expect(sesSendMailMock).toHaveBeenCalledTimes(10)
      expect(await redis.get(redisKey)).toBe('10')

      const ttlBeforeRejectedRetry = await redis.pttl(redisKey)
      expect(ttlBeforeRejectedRetry).toBeGreaterThan(86_390_000)
      expect(ttlBeforeRejectedRetry).toBeLessThanOrEqual(86_400_000)

      await new Promise((resolve) => setTimeout(resolve, 1_200))
      await expect(sendEmail({
        to: 'success@simulator.amazonses.com',
        subject: 'Rejected quota retry',
        react: React.createElement('div', null, 'Hi'),
      })).rejects.toThrow('EMAIL_DELIVERY_LIMIT_EXCEEDED')

      const ttlAfterRejectedRetry = await redis.pttl(redisKey)
      expect(await redis.get(redisKey)).toBe('10')
      expect(ttlAfterRejectedRetry).toBeLessThan(ttlBeforeRejectedRetry - 800)
      expect(sesSendMailMock).toHaveBeenCalledTimes(10)
    } finally {
      await redis.del(redisKey)
      redis.disconnect()
    }
  }, 30_000)
})
