import {
  calculateRetentionProjection,
  latestTrustedActivity,
  trustedActivityTimestamp,
} from '../services/projection'

describe('Finoo customer retention projection', () => {
  const now = new Date('2026-08-24T12:00:00.000Z')
  const anchor = new Date('2026-08-01T12:00:00.000Z')

  it('uses the later of system creation and a non-future occurrence', () => {
    expect(trustedActivityTimestamp({
      createdAt: new Date('2026-08-20T12:00:00.000Z'),
      occurredAt: new Date('2020-01-01T00:00:00.000Z'),
    }, now)).toEqual(new Date('2026-08-20T12:00:00.000Z'))
    expect(trustedActivityTimestamp({
      createdAt: new Date('2026-08-20T12:00:00.000Z'),
      occurredAt: new Date('2026-09-01T00:00:00.000Z'),
    }, now)).toEqual(new Date('2026-08-20T12:00:00.000Z'))
  })

  it('ignores historical activity before a fresh eligibility anchor', () => {
    expect(latestTrustedActivity([
      { createdAt: new Date('2026-07-01T00:00:00.000Z') },
      { createdAt: new Date('2026-08-20T00:00:00.000Z') },
    ], now, anchor)).toEqual(new Date('2026-08-20T00:00:00.000Z'))
  })

  it('expires exactly after elapsed UTC 24-hour days', () => {
    const result = calculateRetentionProjection({
      now,
      inactivityWindowDays: 10,
      eligibilityAnchorAt: anchor,
      latestQualifyingActivityAt: null,
      previousStatus: 'active',
      previousExpiredAt: null,
      previousRetentionExpiresAt: null,
      reenteredEligibility: false,
      excluded: false,
    })
    expect(result.retentionStatus).toBe('expired')
    expect(result.retentionExpiresAt).toEqual(new Date('2026-08-11T12:00:00.000Z'))
    expect(result.expiredAt).toEqual(now)
  })

  it('keeps expired people sticky on window increase and disable', () => {
    const expiredAt = new Date('2026-08-15T12:00:00.000Z')
    const reachedDeadline = new Date('2026-08-11T12:00:00.000Z')
    for (const inactivityWindowDays of [3650, null]) {
      const result = calculateRetentionProjection({
        now,
        inactivityWindowDays,
        eligibilityAnchorAt: anchor,
        latestQualifyingActivityAt: null,
        previousStatus: 'expired',
        previousExpiredAt: expiredAt,
        previousRetentionExpiresAt: reachedDeadline,
        reenteredEligibility: false,
        excluded: false,
      })
      expect(result.retentionStatus).toBe('expired')
      expect(result.expiredAt).toEqual(expiredAt)
      expect(result.retentionExpiresAt).toEqual(reachedDeadline)
    }
  })

  it('reactivates only for new activity or partner re-entry', () => {
    const expiredAt = new Date('2026-08-15T12:00:00.000Z')
    const newActivity = new Date('2026-08-24T11:00:00.000Z')
    const activityResult = calculateRetentionProjection({
      now,
      inactivityWindowDays: 30,
      eligibilityAnchorAt: anchor,
      latestQualifyingActivityAt: newActivity,
      previousStatus: 'expired',
      previousExpiredAt: expiredAt,
      previousRetentionExpiresAt: new Date('2026-08-11T12:00:00.000Z'),
      reenteredEligibility: false,
      excluded: false,
    })
    expect(activityResult.retentionStatus).toBe('active')
    expect(activityResult.expiredAt).toBeNull()

    const reentryResult = calculateRetentionProjection({
      now,
      inactivityWindowDays: 30,
      eligibilityAnchorAt: now,
      latestQualifyingActivityAt: null,
      previousStatus: 'excluded',
      previousExpiredAt: null,
      previousRetentionExpiresAt: null,
      reenteredEligibility: true,
      excluded: false,
    })
    expect(reentryResult.retentionStatus).toBe('active')
  })

  it('clears expiry state for excluded partners', () => {
    expect(calculateRetentionProjection({
      now,
      inactivityWindowDays: 30,
      eligibilityAnchorAt: anchor,
      latestQualifyingActivityAt: now,
      previousStatus: 'expired',
      previousExpiredAt: now,
      previousRetentionExpiresAt: now,
      reenteredEligibility: false,
      excluded: true,
    })).toEqual({
      retentionStatus: 'excluded',
      eligibilityAnchorAt: anchor,
      lastQualifyingActivityAt: null,
      retentionExpiresAt: null,
      expiredAt: null,
    })
  })
})
