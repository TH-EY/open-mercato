import { parseRedisUrl, resolveRedisConnection } from '../connection'

describe('parseRedisUrl', () => {
  it('preserves TLS intent for rediss urls', () => {
    expect(parseRedisUrl('rediss://:secret@example.cache.amazonaws.com:6379')).toEqual({
      host: 'example.cache.amazonaws.com',
      port: 6379,
      password: 'secret',
      db: undefined,
      tls: {},
    })
  })

  it('does not set tls for plain redis urls', () => {
    expect(parseRedisUrl('redis://:secret@localhost:6380/2')).toEqual({
      host: 'localhost',
      port: 6380,
      password: 'secret',
      db: 2,
      tls: undefined,
    })
  })
})

describe('resolveRedisConnection', () => {
  const originalEnv = process.env

  afterEach(() => {
    process.env = originalEnv
  })

  it('keeps tls when resolving from QUEUE_REDIS_URL', () => {
    process.env = {
      ...originalEnv,
      QUEUE_REDIS_URL: 'rediss://:secret@queue.example.amazonaws.com:6379',
    }

    expect(resolveRedisConnection('QUEUE')).toEqual({
      url: 'rediss://:secret@queue.example.amazonaws.com:6379',
      host: 'queue.example.amazonaws.com',
      port: 6379,
      password: 'secret',
      db: undefined,
      tls: {},
    })
  })
})
