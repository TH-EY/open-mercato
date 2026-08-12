import type { EntityManager } from "@mikro-orm/postgresql";
import {
  addDays,
  addWeeks,
  differenceInCalendarDays,
  format,
  parseISO,
  startOfWeek,
  subDays,
} from "date-fns";
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import type { FinooScope } from "./service";

type WeeklyCountRow = { week_start: string | Date; count: string | number };
export type WeeklyCount = { weekStart: string; count: number };

export type FinooAnalyticsRange = {
  from: string;
  to: string;
  fromInstant: Date;
  toExclusiveInstant: Date;
  timezone: string;
};

export function resolveFinooAnalyticsRange(
  input: { from?: string; to?: string },
  now = new Date(),
): FinooAnalyticsRange {
  const timezone =
    process.env.OM_FINOO_ANALYTICS_TIMEZONE?.trim() || "Europe/Warsaw";
  const today = formatInTimeZone(now, timezone, "yyyy-MM-dd");
  const to = input.to ?? today;
  const from = input.from ?? format(subDays(parseISO(to), 29), "yyyy-MM-dd");
  const fromDate = parseISO(from);
  const toDate = parseISO(to);
  const daySpan = differenceInCalendarDays(toDate, fromDate);
  if (Number.isNaN(daySpan) || daySpan < 0 || daySpan >= 366) {
    throw new Error(
      "[internal] Analytics range must include between 1 and 366 days",
    );
  }
  return {
    from,
    to,
    fromInstant: fromZonedTime(`${from}T00:00:00`, timezone),
    toExclusiveInstant: fromZonedTime(
      `${format(addDays(toDate, 1), "yyyy-MM-dd")}T00:00:00`,
      timezone,
    ),
    timezone,
  };
}

function zeroFilledWeeks(
  range: FinooAnalyticsRange,
  rows: WeeklyCountRow[],
): WeeklyCount[] {
  const counts = new Map(
    rows.map((row) => [
      typeof row.week_start === "string"
        ? row.week_start.slice(0, 10)
        : format(row.week_start, "yyyy-MM-dd"),
      Number(row.count),
    ]),
  );
  const firstWeek = startOfWeek(parseISO(range.from), { weekStartsOn: 1 });
  const lastWeek = startOfWeek(parseISO(range.to), { weekStartsOn: 1 });
  const result: WeeklyCount[] = [];
  for (
    let cursor = firstWeek;
    cursor <= lastWeek;
    cursor = addWeeks(cursor, 1)
  ) {
    const weekStart = format(cursor, "yyyy-MM-dd");
    result.push({ weekStart, count: counts.get(weekStart) ?? 0 });
  }
  return result;
}

async function queryWeeklyCounts(
  em: EntityManager,
  table: "finoo_affiliate_visits" | "finoo_deal_attributions",
  dateColumn: "visited_at" | "lead_at" | "transaction_at",
  affiliateUserId: string,
  scope: FinooScope,
  range: FinooAnalyticsRange,
): Promise<WeeklyCount[]> {
  const deletedPredicate =
    table === "finoo_deal_attributions" ? "and deleted_at is null" : "";
  const nonNullPredicate =
    dateColumn === "transaction_at" ? "and transaction_at is not null" : "";
  const rows = await em.getConnection().execute<WeeklyCountRow[]>(
    `select to_char(date_trunc('week', ${dateColumn} at time zone ?), 'YYYY-MM-DD') as week_start,
            count(*)::int as count
       from ${table}
      where tenant_id = ?
        and organization_id = ?
        and affiliate_user_id = ?
        and ${dateColumn} >= ?
        and ${dateColumn} < ?
        ${deletedPredicate}
        ${nonNullPredicate}
      group by 1
      order by 1`,
    [
      range.timezone,
      scope.tenantId,
      scope.organizationId,
      affiliateUserId,
      range.fromInstant,
      range.toExclusiveInstant,
    ],
  );
  return zeroFilledWeeks(range, rows);
}

export async function loadFinooDashboard(
  em: EntityManager,
  affiliateUserId: string,
  scope: FinooScope,
  range: FinooAnalyticsRange,
): Promise<{
  leads: WeeklyCount[];
  clicks: WeeklyCount[];
  transactions: WeeklyCount[];
}> {
  const [leads, clicks, transactions] = await Promise.all([
    queryWeeklyCounts(
      em,
      "finoo_deal_attributions",
      "lead_at",
      affiliateUserId,
      scope,
      range,
    ),
    queryWeeklyCounts(
      em,
      "finoo_affiliate_visits",
      "visited_at",
      affiliateUserId,
      scope,
      range,
    ),
    queryWeeklyCounts(
      em,
      "finoo_deal_attributions",
      "transaction_at",
      affiliateUserId,
      scope,
      range,
    ),
  ]);
  return { leads, clicks, transactions };
}
