"use client"

export function normalizeNumber(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim().length) {
    const parsed = Number(value)
    if (!Number.isNaN(parsed)) return parsed
  }
  return fallback
}

export function formatMoney(value: number, currency: string | null | undefined): string {
  if (!currency) return value.toFixed(2)
  return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(value)
}

export function normalizeCurrencyCode(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length ? value.trim().toUpperCase() : null
}

export function buildServiceLookupSubtitle(
  title: string | null | undefined,
  scope: string | null | undefined,
  description: string | null | undefined,
): string | undefined {
  const normalizedTitle = typeof title === 'string' ? title.trim() : ''
  const normalizedTitleLower = normalizedTitle.toLowerCase()
  for (const candidate of [scope, description]) {
    const text = typeof candidate === 'string' ? candidate.trim() : ''
    if (!text) continue
    if (!normalizedTitleLower) return text
    const lower = text.toLowerCase()
    if (lower === normalizedTitleLower) continue
    if (lower.startsWith(normalizedTitleLower)) {
      const remainder = text.slice(normalizedTitle.length).replace(/^[\s:–—-]+/, '').trim()
      if (remainder) return remainder
      continue
    }
    return text
  }
  return undefined
}

export type LineDiscountDisplay = {
  amount: number | null
  percent: number | null
}

type LineDiscountSource = {
  discountAmount?: unknown
  discountPercent?: unknown
  unitPriceNet?: unknown
  quantity?: unknown
}

const DISCOUNT_MATCH_TOLERANCE = 0.01
const DISCOUNT_MATCH_TOLERANCE_PER_UNIT = 0.0001

function percentAccountsForAmount(
  line: LineDiscountSource,
  percent: number,
  amount: number,
): boolean {
  if (percent <= 0) return false
  const quantity = normalizeNumber(line.quantity, 0)
  const netBeforeDiscount = normalizeNumber(line.unitPriceNet, 0) * quantity
  if (netBeforeDiscount <= 0) return false
  const tolerance = Math.max(
    DISCOUNT_MATCH_TOLERANCE,
    quantity * DISCOUNT_MATCH_TOLERANCE_PER_UNIT,
  )
  return Math.abs((percent / 100) * netBeforeDiscount - amount) <= tolerance
}

export function resolveLineDiscountDisplay(
  line: LineDiscountSource,
): LineDiscountDisplay | null {
  const amount = normalizeNumber(line.discountAmount, 0)
  const percent = normalizeNumber(line.discountPercent, 0)
  if (amount > 0) {
    return {
      amount,
      percent: percentAccountsForAmount(line, percent, amount) ? percent : null,
    }
  }
  if (percent > 0) return { amount: null, percent }
  return null
}
