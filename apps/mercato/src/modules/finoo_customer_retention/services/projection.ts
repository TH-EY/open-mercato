import type { FinooCustomerRetentionStatus } from '../data/entities'

const DAY_MS = 24 * 60 * 60 * 1000

export type RetentionActivityFact = {
  createdAt: Date
  occurredAt?: Date | null
}

export type RetentionProjectionInput = {
  now: Date
  inactivityWindowDays: number | null
  eligibilityAnchorAt: Date
  latestQualifyingActivityAt: Date | null
  previousStatus: FinooCustomerRetentionStatus | null
  previousExpiredAt: Date | null
  previousRetentionExpiresAt: Date | null
  reenteredEligibility: boolean
  excluded: boolean
}

export type RetentionProjection = {
  retentionStatus: FinooCustomerRetentionStatus
  eligibilityAnchorAt: Date
  lastQualifyingActivityAt: Date | null
  retentionExpiresAt: Date | null
  expiredAt: Date | null
}

export function trustedActivityTimestamp(
  fact: RetentionActivityFact,
  now: Date,
): Date {
  if (!fact.occurredAt) return fact.createdAt
  if (fact.occurredAt > now) return fact.createdAt
  return fact.occurredAt > fact.createdAt ? fact.occurredAt : fact.createdAt
}

export function latestTrustedActivity(
  facts: RetentionActivityFact[],
  now: Date,
  notBefore: Date,
): Date | null {
  let latest: Date | null = null
  for (const fact of facts) {
    const candidate = trustedActivityTimestamp(fact, now)
    if (candidate < notBefore) continue
    if (!latest || candidate > latest) latest = candidate
  }
  return latest
}

export function addRetentionDays(anchor: Date, days: number): Date {
  return new Date(anchor.getTime() + days * DAY_MS)
}

export function calculateRetentionProjection(
  input: RetentionProjectionInput,
): RetentionProjection {
  if (input.excluded) {
    return {
      retentionStatus: 'excluded',
      eligibilityAnchorAt: input.eligibilityAnchorAt,
      lastQualifyingActivityAt: null,
      retentionExpiresAt: null,
      expiredAt: null,
    }
  }

  const effectiveAnchor = input.latestQualifyingActivityAt ?? input.eligibilityAnchorAt
  const retentionExpiresAt = input.inactivityWindowDays === null
    ? null
    : addRetentionDays(effectiveAnchor, input.inactivityWindowDays)
  const activityReactivated = input.previousStatus === 'expired'
    && input.latestQualifyingActivityAt !== null
    && (input.previousExpiredAt === null || input.latestQualifyingActivityAt > input.previousExpiredAt)
  const stickyExpired = input.previousStatus === 'expired'
    && !input.reenteredEligibility
    && !activityReactivated

  if (stickyExpired) {
    return {
      retentionStatus: 'expired',
      eligibilityAnchorAt: input.eligibilityAnchorAt,
      lastQualifyingActivityAt: input.latestQualifyingActivityAt,
      retentionExpiresAt: input.previousRetentionExpiresAt,
      expiredAt: input.previousExpiredAt ?? input.now,
    }
  }

  if (retentionExpiresAt && retentionExpiresAt <= input.now) {
    return {
      retentionStatus: 'expired',
      eligibilityAnchorAt: input.eligibilityAnchorAt,
      lastQualifyingActivityAt: input.latestQualifyingActivityAt,
      retentionExpiresAt,
      expiredAt: input.now,
    }
  }

  return {
    retentionStatus: 'active',
    eligibilityAnchorAt: input.eligibilityAnchorAt,
    lastQualifyingActivityAt: input.latestQualifyingActivityAt,
    retentionExpiresAt,
    expiredAt: null,
  }
}
