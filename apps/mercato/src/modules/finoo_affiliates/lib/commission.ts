import type { FinooAffiliateCommissionMode, FinooAffiliateTransactionCommissionMode } from '../data/entities'

const MAX_COMMISSION_AMOUNT = 2_147_483_647n
const PERCENTAGE_DENOMINATOR = 1_000_000n

export type AffiliateCommissionSnapshot = {
  commissionAmount: number
  commissionMode: FinooAffiliateTransactionCommissionMode
  commissionRateBps: number | null
  commissionFixedAmount: number | null
  commissionBaseAmount: string | null
}

type AffiliateCommissionInput = {
  commissionMode: FinooAffiliateCommissionMode | null
  commissionRateBps: number | null
  commissionFixedAmount: number | null
  attributionCommissionAmount: number
  dealValueAmount: string | null
  dealValueCurrency: string | null
}

function parsePlnMinorUnits(value: string | null): bigint | null {
  if (!value) return null
  const match = /^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/.exec(value)
  if (!match) return null
  const fractional = (match[2] ?? '').padEnd(2, '0')
  return BigInt(match[1]) * 100n + BigInt(fractional || '0')
}

function toSupportedAmount(value: bigint): number {
  if (value < 0n || value > MAX_COMMISSION_AMOUNT) {
    throw new Error('[internal] Affiliate commission exceeds the supported amount')
  }
  return Number(value)
}

export function resolveAffiliateCommissionSnapshot(input: AffiliateCommissionInput): AffiliateCommissionSnapshot {
  if (input.commissionMode === null) {
    return {
      commissionAmount: toSupportedAmount(BigInt(input.attributionCommissionAmount)),
      commissionMode: 'legacy_deal_amount',
      commissionRateBps: null,
      commissionFixedAmount: null,
      commissionBaseAmount: null,
    }
  }

  if (input.commissionMode === 'fixed') {
    if (
      input.commissionRateBps !== null
      || !Number.isInteger(input.commissionFixedAmount)
      || input.commissionFixedAmount === null
      || input.commissionFixedAmount < 0
      || input.commissionFixedAmount > Number(MAX_COMMISSION_AMOUNT)
    ) {
      throw new Error('[internal] Invalid affiliate commission rule')
    }
    return {
      commissionAmount: input.commissionFixedAmount,
      commissionMode: 'fixed',
      commissionRateBps: null,
      commissionFixedAmount: input.commissionFixedAmount,
      commissionBaseAmount: null,
    }
  }

  if (
    !Number.isInteger(input.commissionRateBps)
    || input.commissionRateBps === null
    || input.commissionRateBps <= 0
    || input.commissionRateBps > 10_000
    || input.commissionFixedAmount !== null
  ) {
    throw new Error('[internal] Invalid affiliate commission rule')
  }
  const baseMinor = parsePlnMinorUnits(input.dealValueAmount)
  if (baseMinor === null || input.dealValueCurrency !== 'PLN') {
    throw new Error('[internal] A percentage affiliate commission requires a non-negative PLN Deal value')
  }
  const roundedWholePln = (
    baseMinor * BigInt(input.commissionRateBps) + PERCENTAGE_DENOMINATOR / 2n
  ) / PERCENTAGE_DENOMINATOR
  return {
    commissionAmount: toSupportedAmount(roundedWholePln),
    commissionMode: 'percentage',
    commissionRateBps: input.commissionRateBps,
    commissionFixedAmount: null,
    commissionBaseAmount: input.dealValueAmount,
  }
}
