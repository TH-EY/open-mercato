export type ActivityRetryPolicyInput = {
  maxAttempts?: number
  initialIntervalMs?: number
  backoffCoefficient?: number
  maxIntervalMs?: number
  retryDelay?: number
  backoffMultiplier?: number
}

export type NormalizedActivityRetryPolicy = {
  maxAttempts: number
  initialIntervalMs: number
  backoffCoefficient: number
  maxIntervalMs: number
}

const DEFAULT_RETRY_POLICY: NormalizedActivityRetryPolicy = {
  maxAttempts: 3,
  initialIntervalMs: 1000,
  backoffCoefficient: 2,
  maxIntervalMs: 10000,
}

function numberOrDefault(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function intOrDefault(value: unknown, fallback: number): number {
  const resolved = numberOrDefault(value, fallback)
  return Number.isInteger(resolved) ? resolved : Math.trunc(resolved)
}

export function createDefaultActivityRetryPolicy(): NormalizedActivityRetryPolicy {
  return { ...DEFAULT_RETRY_POLICY }
}

export function normalizeActivityRetryPolicy(
  retryPolicy: ActivityRetryPolicyInput | null | undefined,
): NormalizedActivityRetryPolicy {
  return {
    maxAttempts: intOrDefault(retryPolicy?.maxAttempts, DEFAULT_RETRY_POLICY.maxAttempts),
    initialIntervalMs: intOrDefault(
      retryPolicy?.initialIntervalMs ?? retryPolicy?.retryDelay,
      DEFAULT_RETRY_POLICY.initialIntervalMs,
    ),
    backoffCoefficient: numberOrDefault(
      retryPolicy?.backoffCoefficient ?? retryPolicy?.backoffMultiplier,
      DEFAULT_RETRY_POLICY.backoffCoefficient,
    ),
    maxIntervalMs: intOrDefault(retryPolicy?.maxIntervalMs, DEFAULT_RETRY_POLICY.maxIntervalMs),
  }
}

export function normalizeActivityDefinition<TActivity extends { retryPolicy?: ActivityRetryPolicyInput | null }>(
  activity: TActivity,
): Omit<TActivity, 'retryPolicy'> & { retryPolicy?: NormalizedActivityRetryPolicy } {
  if (!activity.retryPolicy) return activity as Omit<TActivity, 'retryPolicy'> & { retryPolicy?: NormalizedActivityRetryPolicy }
  const { retryPolicy: _legacyRetryPolicy, ...rest } = activity
  return {
    ...rest,
    retryPolicy: normalizeActivityRetryPolicy(_legacyRetryPolicy),
  }
}

export function normalizeActivityDefinitions<TActivity extends { retryPolicy?: ActivityRetryPolicyInput | null }>(
  activities: TActivity[] | undefined,
): TActivity[] | undefined {
  if (!Array.isArray(activities)) return activities
  return activities.map((activity) => normalizeActivityDefinition(activity) as TActivity)
}
