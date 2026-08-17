import type { NextResponse } from 'next/server'
import {
  checkAuthRateLimit,
  customerInviteIpRateLimitConfig,
  customerInviteRateLimitConfig,
} from '@open-mercato/core/modules/customer_accounts/lib/rateLimiter'

export async function checkDirectoryEmailRateLimit(
  request: Request,
  email: string,
): Promise<NextResponse | null> {
  const { error } = await checkAuthRateLimit({
    req: request,
    ipConfig: customerInviteIpRateLimitConfig,
    compoundConfig: customerInviteRateLimitConfig,
    compoundIdentifier: email.trim().toLowerCase(),
  })
  return error
}
