import { z } from 'zod'
import { createHmac } from 'node:crypto'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { AwilixContainer } from 'awilix'
import type { OpenApiMethodDoc, OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import type { CommandBus, CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import type { AuthContext } from '@open-mercato/shared/lib/auth/server'
import { findWithDecryption, findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { CustomerDeal, CustomerInteraction, CustomerPipelineStage } from '@open-mercato/core/modules/customers/data/entities'
import type { InteractionCreateInput, InteractionUpdateInput } from '@open-mercato/core/modules/customers/data/validators'
import { User } from '@open-mercato/core/modules/auth/data/entities'
import { PlannerAvailabilityRule } from '@open-mercato/core/modules/planner/data/entities'
import type {
  AvailabilityRuleLike,
  AvailabilityWindow,
  PlannerAvailabilityService,
} from '@open-mercato/core/modules/planner/services/plannerAvailabilityService'
import type { StaffMemberDirectory } from '@open-mercato/core/modules/staff/services/staffMemberDirectory'
import type { CustomerAuthContext } from '@open-mercato/core/modules/customer_accounts/lib/customerAuth'
import {
  EPC_SURVEY_BOOKING_MARKER,
  EPC_SURVEY_BOOKING_SOURCE,
  type EpcSurveyBookingDeal,
  type EpcSurveyBookingPostInput,
  type EpcSurveyBookingRecord,
  type EpcSurveyBookingSlot,
  type EpcSurveyBookingState,
} from './surveyBookingTypes'

const uuidSchema = z.string().uuid()

export const epcSurveyBookingPostSchema = z.object({
  dealId: uuidSchema,
  slotId: z.string().trim().min(1).max(500),
})

type SurveyBookingScope = {
  tenantId: string
  organizationId: string
}

type DealOwnership = {
  dealId: string
  entityId: string
  priority: number
}

type SurveyorCandidate = {
  userId: string
  displayName: string
  email: string | null
  staffMemberId: string | null
  availabilityRuleSetId: string | null
}

type SurveyorCandidateLoader = (
  container: AwilixContainer,
  em: EntityManager,
  scope: SurveyBookingScope,
  roleName: string,
) => Promise<SurveyorCandidate[]>

type BusyInterval = {
  userId: string
  start: Date
  end: Date
}

type InternalSurveySlot = EpcSurveyBookingSlot & {
  surveyorUserId: string
}

type InternalSurveyBookingState = Omit<EpcSurveyBookingState, 'slots'> & {
  slots: InternalSurveySlot[]
}

type UserIdRow = {
  user_id: string
}

type BusyRow = {
  owner_user_id: string | null
  participants: Array<{ userId?: string | null }> | null
  scheduled_at: Date | string | null
  duration_minutes: number | string | null
}

export function resolveSurveyorRoleName(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.EPC_SURVEYOR_ROLE_NAME?.trim()
  return configured && configured.length > 0 ? configured : 'Surveyor'
}

export function resolveSurveyStageName(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.EPC_SURVEY_STAGE_NAME?.trim()
  return configured && configured.length > 0 ? configured : 'Survey'
}

export function resolveSurveyDurationMinutes(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number.parseInt(env.EPC_SURVEY_DURATION_MINUTES ?? '', 10)
  return Number.isFinite(parsed) && parsed >= 15 && parsed <= 480 ? parsed : 60
}

export function isSurveyStageName(value: string | null | undefined, expected = resolveSurveyStageName()): boolean {
  return normalizeStageName(value) === normalizeStageName(expected)
}

export function encodeSurveySlotId(input: { surveyorUserId: string; startsAt: string }): string {
  const payload = `${input.surveyorUserId}:${input.startsAt}`
  const digest = createHmac('sha256', resolveSurveySlotSecret()).update(payload).digest('base64url')
  return `survey_${digest.slice(0, 32)}`
}

export function intervalsOverlap(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart < bEnd && aEnd > bStart
}

export function resolveSurveyorAvailabilityWindows(params: {
  service: PlannerAvailabilityService | undefined
  rules: AvailabilityRuleLike[]
  range: { start: Date; end: Date }
}): AvailabilityWindow[] {
  if (!params.service || params.rules.length === 0) return []
  return params.service.getMergedAvailabilityWindows({ rules: params.rules, range: params.range })
}

export function createSurveyorLookup(loadCandidates: SurveyorCandidateLoader) {
  return async (params: {
    container: AwilixContainer
    em: EntityManager
    scope: SurveyBookingScope
    userId: string
  }): Promise<SurveyorCandidate | null> => {
    const surveyors = await loadCandidates(params.container, params.em, params.scope, resolveSurveyorRoleName())
    return surveyors.find((surveyor) => surveyor.userId === params.userId) ?? null
  }
}

export function buildSurveyBookingSlots(params: {
  surveyors: SurveyorCandidate[]
  windowsBySurveyor: Map<string, AvailabilityWindow[]>
  busyIntervals: BusyInterval[]
  rangeStart: Date
  durationMinutes: number
  maxSlots?: number
}): InternalSurveySlot[] {
  const maxSlots = params.maxSlots ?? 12
  const durationMs = params.durationMinutes * 60_000
  const busyByUser = groupBusyIntervals(params.busyIntervals)
  const candidates: InternalSurveySlot[] = []

  for (const surveyor of params.surveyors) {
    const busy = busyByUser.get(surveyor.userId) ?? []
    const windows = params.windowsBySurveyor.get(surveyor.userId) ?? []
    for (const window of windows) {
      let cursor = roundUpToSlotBoundary(new Date(Math.max(window.start.getTime(), params.rangeStart.getTime())), 30)
      while (cursor.getTime() + durationMs <= window.end.getTime()) {
        const end = new Date(cursor.getTime() + durationMs)
        const conflicts = busy.some((interval) => intervalsOverlap(cursor, end, interval.start, interval.end))
        if (!conflicts) {
          const startsAt = cursor.toISOString()
          candidates.push({
            id: encodeSurveySlotId({ surveyorUserId: surveyor.userId, startsAt }),
            surveyorUserId: surveyor.userId,
            startsAt,
            endsAt: end.toISOString(),
            label: formatSlotLabel(cursor, end),
          })
        }
        cursor = new Date(cursor.getTime() + durationMs)
      }
    }
  }

  const byStart = new Map<string, InternalSurveySlot>()
  candidates
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.surveyorUserId.localeCompare(b.surveyorUserId))
    .forEach((slot) => {
      if (!byStart.has(slot.startsAt)) byStart.set(slot.startsAt, slot)
    })

  return Array.from(byStart.values()).slice(0, maxSlots)
}

export async function loadSurveyBookingState(params: {
  container: AwilixContainer
  auth: CustomerAuthContext
  now?: Date
}): Promise<EpcSurveyBookingState> {
  return stripInternalSlots(await loadSurveyBookingStateInternal(params))
}

async function loadSurveyBookingStateInternal(params: {
  container: AwilixContainer
  auth: CustomerAuthContext
  now?: Date
}): Promise<InternalSurveyBookingState> {
  const now = params.now ?? new Date()
  const durationMinutes = resolveSurveyDurationMinutes()
  const scope = { tenantId: params.auth.tenantId, organizationId: params.auth.orgId }
  const em = (params.container.resolve('em') as EntityManager).fork()

  const ownership = await loadCustomerDealOwnership(em, scope, {
    personEntityId: params.auth.personEntityId ?? null,
    customerEntityId: params.auth.customerEntityId ?? null,
  })
  if (ownership.length === 0) {
    return emptyState('not_linked', durationMinutes)
  }

  const ownedByDealId = new Map<string, DealOwnership>()
  for (const entry of ownership.sort((a, b) => a.priority - b.priority)) {
    if (!ownedByDealId.has(entry.dealId)) ownedByDealId.set(entry.dealId, entry)
  }

  const deals = await findWithDecryption(
    em,
    CustomerDeal,
    {
      id: { $in: Array.from(ownedByDealId.keys()) },
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      deletedAt: null,
    },
    undefined,
    scope,
  )
  const stageIds = Array.from(new Set(deals.map((deal) => deal.pipelineStageId).filter((id): id is string => Boolean(id))))
  const stages = stageIds.length > 0
    ? await em.find(CustomerPipelineStage, {
        id: { $in: stageIds },
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
      })
    : []
  const stageById = new Map(stages.map((stage) => [stage.id, stage.label]))

  const eligibleDeals = deals
    .map((deal) => {
      const stageName = stageById.get(deal.pipelineStageId ?? '') ?? deal.pipelineStage ?? ''
      return { deal, stageName }
    })
    .filter(({ deal, stageName }) => deal.status === 'open' && isSurveyStageName(stageName))

  if (eligibleDeals.length === 0) {
    return emptyState('not_in_survey_stage', durationMinutes)
  }

  const surveyors = await loadSurveyors(params.container, em, scope, resolveSurveyorRoleName())
  if (surveyors.length === 0) {
    return {
      ok: true,
      canBook: false,
      reason: 'no_surveyors',
      durationMinutes,
      deals: eligibleDeals.map(({ deal, stageName }) => ({
        id: deal.id,
        title: deal.title,
        stageName,
        bookedSurvey: null,
      })),
      slots: [],
    }
  }

  const existingBookings = await loadExistingBookings(em, scope, eligibleDeals.map(({ deal }) => deal.id), durationMinutes)
  const { rangeStart, rangeEnd } = resolveSlotRange(now)
  const windowsBySurveyor = await loadAvailabilityWindows(params.container, em, scope, surveyors, rangeStart, rangeEnd)
  const busyIntervals = await loadBusyIntervals(em, scope, surveyors.map((surveyor) => surveyor.userId), rangeStart, rangeEnd, durationMinutes)
  const slots = buildSurveyBookingSlots({
    surveyors,
    windowsBySurveyor,
    busyIntervals,
    rangeStart,
    durationMinutes,
  })

  const dealsWithBookings = eligibleDeals.map(({ deal, stageName }) => ({
    id: deal.id,
    title: deal.title,
    stageName,
    bookedSurvey: existingBookings.get(deal.id) ?? null,
  }))

  return {
    ok: true,
    canBook: dealsWithBookings.length > 0 && slots.length > 0,
    reason: slots.length > 0 ? 'ready' : 'no_slots',
    deals: dealsWithBookings,
    slots,
    durationMinutes,
  }
}

export async function bookSurveySlot(params: {
  container: AwilixContainer
  auth: CustomerAuthContext
  input: EpcSurveyBookingPostInput
  request?: Request
}): Promise<{ booking: EpcSurveyBookingRecord; state: EpcSurveyBookingState; existingBookingId: string | null }> {
  const initialState = await loadSurveyBookingStateInternal({ container: params.container, auth: params.auth })
  const deal = initialState.deals.find((entry) => entry.id === params.input.dealId)
  if (!deal) {
    throw new SurveyBookingError(404, 'Survey booking is not available for this deal.')
  }
  const slot = initialState.slots.find((entry) => entry.id === params.input.slotId)
  if (!slot) {
    throw new SurveyBookingError(409, 'This survey slot is no longer available.')
  }

  const scope = { tenantId: params.auth.tenantId, organizationId: params.auth.orgId }
  const em = (params.container.resolve('em') as EntityManager).fork()
  const owner = await loadSurveyorByUserId({ container: params.container, em, scope, userId: slot.surveyorUserId })
  if (!owner) {
    throw new SurveyBookingError(409, 'This surveyor is no longer available.')
  }

  const stillBusy = await loadBusyIntervals(
    em,
    scope,
    [slot.surveyorUserId],
    new Date(slot.startsAt),
    new Date(slot.endsAt),
    initialState.durationMinutes,
  )
  if (stillBusy.some((interval) => intervalsOverlap(new Date(slot.startsAt), new Date(slot.endsAt), interval.start, interval.end))) {
    throw new SurveyBookingError(409, 'This survey slot is no longer available.')
  }

  const ownership = await loadCustomerDealOwnership(em, scope, {
    personEntityId: params.auth.personEntityId ?? null,
    customerEntityId: params.auth.customerEntityId ?? null,
  })
  const entityId = ownership
    .filter((entry) => entry.dealId === deal.id)
    .sort((a, b) => a.priority - b.priority)[0]?.entityId
  if (!entityId) {
    throw new SurveyBookingError(404, 'Survey booking is not available for this deal.')
  }

  const existingBookingId = deal.bookedSurvey?.id ?? null
  const commandBus = params.container.resolve('commandBus') as CommandBus
  const ctx = buildSurveyBookingCommandContext(params.container, params.auth, params.request)
  const payload = buildInteractionPayload({
    auth: params.auth,
    deal,
    entityId,
    slot,
    owner,
    durationMinutes: initialState.durationMinutes,
  })

  const interactionId = existingBookingId
    ? await updateSurveyInteraction(commandBus, ctx, existingBookingId, payload)
    : await createSurveyInteraction(commandBus, ctx, payload)

  const readback = await findOneWithDecryption(
    em,
    CustomerInteraction,
    {
      id: interactionId,
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      deletedAt: null,
    },
    undefined,
    scope,
  )
  const booking = toBookingRecord(readback, initialState.durationMinutes)
  if (!booking || booking.dealId !== deal.id || booking.scheduledAt !== slot.startsAt) {
    throw new SurveyBookingError(500, 'Survey booking could not be verified.')
  }

  const state = await loadSurveyBookingState({ container: params.container, auth: params.auth })
  return { booking, state, existingBookingId }
}

export class SurveyBookingError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'SurveyBookingError'
  }
}

function normalizeStageName(value: string | null | undefined): string {
  return (value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function emptyState(reason: EpcSurveyBookingState['reason'], durationMinutes: number): InternalSurveyBookingState {
  return {
    ok: true,
    canBook: false,
    reason,
    deals: [],
    slots: [],
    durationMinutes,
  }
}

function stripInternalSlots(state: InternalSurveyBookingState): EpcSurveyBookingState {
  return {
    ...state,
    slots: state.slots.map(({ surveyorUserId: _surveyorUserId, ...slot }) => slot),
  }
}

function resolveSurveySlotSecret(env: NodeJS.ProcessEnv = process.env): string {
  return env.EPC_SURVEY_SLOT_SECRET
    ?? env.JWT_SECRET
    ?? env.NEXTAUTH_SECRET
    ?? 'open-mercato-epc-survey-booking'
}

async function loadCustomerDealOwnership(
  em: EntityManager,
  scope: SurveyBookingScope,
  ids: { personEntityId: string | null; customerEntityId: string | null },
): Promise<DealOwnership[]> {
  const rows: DealOwnership[] = []
  const personIds = Array.from(new Set([ids.personEntityId, ids.customerEntityId].filter((id): id is string => uuidSchema.safeParse(id).success)))
  const companyIds = Array.from(new Set([ids.customerEntityId].filter((id): id is string => uuidSchema.safeParse(id).success)))

  if (personIds.length > 0) {
    rows.push(...await executeRows<DealOwnership>(
      em,
      `select l.deal_id as "dealId", l.person_entity_id as "entityId", 1 as priority
       from customer_deal_people l
       inner join customer_deals d on d.id = l.deal_id
       where d.tenant_id = ? and d.organization_id = ? and d.deleted_at is null
         and l.person_entity_id in (${placeholders(personIds.length)})`,
      [scope.tenantId, scope.organizationId, ...personIds],
    ))
  }

  if (companyIds.length > 0) {
    rows.push(...await executeRows<DealOwnership>(
      em,
      `select l.deal_id as "dealId", l.company_entity_id as "entityId", 2 as priority
       from customer_deal_companies l
       inner join customer_deals d on d.id = l.deal_id
       where d.tenant_id = ? and d.organization_id = ? and d.deleted_at is null
         and l.company_entity_id in (${placeholders(companyIds.length)})`,
      [scope.tenantId, scope.organizationId, ...companyIds],
    ))
  }

  return rows
}

async function loadSurveyors(
  container: AwilixContainer,
  em: EntityManager,
  scope: SurveyBookingScope,
  roleName: string,
): Promise<SurveyorCandidate[]> {
  const authRoleUsers = await executeRows<UserIdRow>(
    em,
    `select distinct u.id as "user_id"
     from roles r
     inner join user_roles ur on ur.role_id = r.id and ur.deleted_at is null
     inner join users u on u.id = ur.user_id and u.deleted_at is null
     where r.tenant_id = ? and r.deleted_at is null and lower(r.name) = lower(?)
       and (u.tenant_id = ? or u.tenant_id is null)
       and (u.organization_id = ? or u.organization_id is null)`,
    [scope.tenantId, roleName, scope.tenantId, scope.organizationId],
  )

  const userIds = Array.from(new Set(authRoleUsers.map((row) => row.user_id)))
  if (userIds.length === 0) return []

  const directory = container.resolve<StaffMemberDirectory>('staffMemberDirectory', {
    allowUnregistered: true,
  })
  if (!directory) return []
  const schedulingRefs = await directory.listActiveSchedulingRefs({
    userIds,
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
  })
  const schedulingRefsByUserId = new Map(schedulingRefs.map((ref) => [ref.userId, ref]))

  const users = await findWithDecryption(
    em,
    User,
    {
      id: { $in: userIds },
      deletedAt: null,
    },
    undefined,
    scope,
  )
  const usersById = new Map(users.map((user) => [user.id, user]))

  const candidates: SurveyorCandidate[] = []
  for (const userId of userIds) {
    const user = usersById.get(userId)
    const schedulingRef = schedulingRefsByUserId.get(userId)
    if (!user || !schedulingRef) continue
    candidates.push({
      userId,
      displayName: user.name?.trim() || schedulingRef.displayName.trim() || 'Surveyor',
      email: user.email ?? null,
      staffMemberId: schedulingRef.staffMemberId,
      availabilityRuleSetId: schedulingRef.availabilityRuleSetId,
    })
  }

  return candidates.sort((a, b) => a.displayName.localeCompare(b.displayName) || a.userId.localeCompare(b.userId))
}

const loadSurveyorByUserId = createSurveyorLookup(loadSurveyors)

async function loadExistingBookings(
  em: EntityManager,
  scope: SurveyBookingScope,
  dealIds: string[],
  durationMinutes: number,
): Promise<Map<string, EpcSurveyBookingRecord>> {
  if (dealIds.length === 0) return new Map()
  const rows = await findWithDecryption(
    em,
    CustomerInteraction,
    {
      dealId: { $in: dealIds },
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      source: EPC_SURVEY_BOOKING_SOURCE,
      deletedAt: null,
      status: { $ne: 'canceled' },
    },
    { orderBy: { scheduledAt: 'asc', createdAt: 'desc' } as never },
    scope,
  )
  const result = new Map<string, EpcSurveyBookingRecord>()
  for (const row of rows) {
    const record = toBookingRecord(row, durationMinutes)
    if (record && !result.has(record.dealId)) result.set(record.dealId, record)
  }
  return result
}

async function loadAvailabilityWindows(
  container: AwilixContainer,
  em: EntityManager,
  scope: SurveyBookingScope,
  surveyors: SurveyorCandidate[],
  rangeStart: Date,
  rangeEnd: Date,
): Promise<Map<string, AvailabilityWindow[]>> {
  const subjectIds = Array.from(new Set(
    surveyors.flatMap((surveyor) => [surveyor.staffMemberId, surveyor.availabilityRuleSetId]).filter((id): id is string => Boolean(id)),
  ))
  const rules = subjectIds.length > 0
    ? await findWithDecryption(
        em,
        PlannerAvailabilityRule,
        {
          subjectId: { $in: subjectIds },
          tenantId: scope.tenantId,
          organizationId: scope.organizationId,
          deletedAt: null,
        },
        undefined,
        scope,
      )
    : []
  const rulesBySubject = new Map<string, PlannerAvailabilityRule[]>()
  for (const rule of rules) {
    const entries = rulesBySubject.get(rule.subjectId) ?? []
    entries.push(rule)
    rulesBySubject.set(rule.subjectId, entries)
  }

  const service = container.resolve<PlannerAvailabilityService>('plannerAvailabilityService', {
    allowUnregistered: true,
  })
  const result = new Map<string, AvailabilityWindow[]>()
  for (const surveyor of surveyors) {
    const surveyorRules = [
      ...(surveyor.availabilityRuleSetId ? rulesBySubject.get(surveyor.availabilityRuleSetId) ?? [] : []),
      ...(surveyor.staffMemberId ? rulesBySubject.get(surveyor.staffMemberId) ?? [] : []),
    ]
    const windows = resolveSurveyorAvailabilityWindows({
      service,
      rules: surveyorRules.map((rule) => ({
        id: rule.id,
        rrule: rule.rrule,
        exdates: rule.exdates,
        kind: rule.kind,
        note: rule.note ?? null,
      })),
      range: { start: rangeStart, end: rangeEnd },
    })
    result.set(surveyor.userId, windows)
  }
  return result
}

async function loadBusyIntervals(
  em: EntityManager,
  scope: SurveyBookingScope,
  surveyorUserIds: string[],
  rangeStart: Date,
  rangeEnd: Date,
  defaultDurationMinutes: number,
): Promise<BusyInterval[]> {
  if (surveyorUserIds.length === 0) return []
  const participantChecks = surveyorUserIds.map(() => 'participants @> ?::jsonb').join(' or ')
  const rows = await executeRows<BusyRow>(
    em,
    `select owner_user_id as "owner_user_id", participants, scheduled_at as "scheduled_at", duration_minutes as "duration_minutes"
     from customer_interactions
     where tenant_id = ? and organization_id = ? and deleted_at is null and status <> 'canceled'
       and scheduled_at is not null
       and scheduled_at < ?
       and (scheduled_at + (coalesce(duration_minutes, ?) * interval '1 minute')) > ?
       and (
         owner_user_id in (${placeholders(surveyorUserIds.length)})
         ${participantChecks ? `or ${participantChecks}` : ''}
       )`,
    [
      scope.tenantId,
      scope.organizationId,
      rangeEnd,
      defaultDurationMinutes,
      rangeStart,
      ...surveyorUserIds,
      ...surveyorUserIds.map((userId) => JSON.stringify([{ userId }])),
    ],
  )

  const result: BusyInterval[] = []
  for (const row of rows) {
    const start = parseDate(row.scheduled_at)
    if (!start) continue
    const duration = Number(row.duration_minutes ?? defaultDurationMinutes)
    const end = new Date(start.getTime() + Math.max(1, duration) * 60_000)
    if (row.owner_user_id && surveyorUserIds.includes(row.owner_user_id)) {
      result.push({ userId: row.owner_user_id, start, end })
    }
    for (const participant of row.participants ?? []) {
      const participantUserId = typeof participant?.userId === 'string' ? participant.userId : null
      if (participantUserId && surveyorUserIds.includes(participantUserId)) {
        result.push({ userId: participantUserId, start, end })
      }
    }
  }
  return result
}

function buildInteractionPayload(params: {
  auth: CustomerAuthContext
  deal: EpcSurveyBookingDeal
  entityId: string
  slot: InternalSurveySlot
  owner: SurveyorCandidate
  durationMinutes: number
}): Omit<InteractionCreateInput, 'tenantId' | 'organizationId'> & SurveyBookingScope {
  return {
    tenantId: params.auth.tenantId,
    organizationId: params.auth.orgId,
    entityId: params.entityId,
    dealId: params.deal.id,
    interactionType: 'event',
    title: `Survey appointment - ${params.deal.title}`,
    body: [
      EPC_SURVEY_BOOKING_MARKER,
      `Booked from the customer portal by ${params.auth.displayName || params.auth.email}.`,
      `Customer email: ${params.auth.email}`,
    ].join('\n'),
    status: 'planned',
    scheduledAt: new Date(params.slot.startsAt),
    durationMinutes: params.durationMinutes,
    ownerUserId: params.owner.userId,
    authorUserId: params.owner.userId,
    source: EPC_SURVEY_BOOKING_SOURCE,
    appearanceIcon: 'lucide:calendar-check',
    appearanceColor: '#2563eb',
    location: 'Customer site',
    allDay: false,
    participants: [{
      userId: params.owner.userId,
      name: params.owner.displayName,
      ...(params.owner.email ? { email: params.owner.email } : {}),
      status: 'accepted',
    }],
    reminderMinutes: 60,
    visibility: 'team',
    linkedEntities: [{ id: params.deal.id, type: 'deal', label: params.deal.title }],
    guestPermissions: { canInviteOthers: false, canModify: false, canSeeList: false },
  }
}

async function createSurveyInteraction(
  commandBus: CommandBus,
  ctx: CommandRuntimeContext,
  payload: InteractionCreateInput,
): Promise<string> {
  const { result } = await commandBus.execute<InteractionCreateInput, { interactionId: string }>(
    'customers.interactions.create',
    { input: payload, ctx },
  )
  return result.interactionId
}

async function updateSurveyInteraction(
  commandBus: CommandBus,
  ctx: CommandRuntimeContext,
  id: string,
  payload: InteractionCreateInput,
): Promise<string> {
  const updatePayload: InteractionUpdateInput = {
    id,
    ...payload,
  }
  await commandBus.execute<InteractionUpdateInput, { interactionId?: string }>(
    'customers.interactions.update',
    { input: updatePayload, ctx },
  )
  return id
}

function buildSurveyBookingCommandContext(
  container: AwilixContainer,
  auth: CustomerAuthContext,
  request?: Request,
): CommandRuntimeContext {
  const commandAuth: NonNullable<AuthContext> = {
    sub: auth.sub,
    tenantId: auth.tenantId,
    orgId: auth.orgId,
    roles: ['customer_portal'],
  }
  return {
    container,
    auth: commandAuth,
    organizationScope: null,
    selectedOrganizationId: auth.orgId,
    organizationIds: [auth.orgId],
    request,
    syncOrigin: EPC_SURVEY_BOOKING_SOURCE,
  }
}

function toBookingRecord(
  interaction: CustomerInteraction | null | undefined,
  fallbackDurationMinutes: number,
): EpcSurveyBookingRecord | null {
  if (!interaction?.scheduledAt || !interaction.dealId) return null
  const durationMinutes = interaction.durationMinutes ?? fallbackDurationMinutes
  const endsAt = new Date(interaction.scheduledAt.getTime() + durationMinutes * 60_000)
  return {
    id: interaction.id,
    dealId: interaction.dealId,
    scheduledAt: interaction.scheduledAt.toISOString(),
    endsAt: endsAt.toISOString(),
    durationMinutes,
    status: interaction.status,
  }
}

function resolveSlotRange(now: Date): { rangeStart: Date; rangeEnd: Date } {
  const rangeStart = roundUpToSlotBoundary(new Date(now.getTime() + 60 * 60_000), 30)
  const rangeEnd = new Date(rangeStart)
  rangeEnd.setUTCDate(rangeEnd.getUTCDate() + 14)
  return { rangeStart, rangeEnd }
}

function roundUpToSlotBoundary(value: Date, stepMinutes: number): Date {
  const stepMs = stepMinutes * 60_000
  return new Date(Math.ceil(value.getTime() / stepMs) * stepMs)
}

function groupBusyIntervals(intervals: BusyInterval[]): Map<string, BusyInterval[]> {
  const map = new Map<string, BusyInterval[]>()
  for (const interval of intervals) {
    const entries = map.get(interval.userId) ?? []
    entries.push(interval)
    map.set(interval.userId, entries)
  }
  return map
}

function formatSlotLabel(start: Date, end: Date): string {
  const dateFormatter = new Intl.DateTimeFormat('en-GB', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  })
  const timeFormatter = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
  })
  return `${dateFormatter.format(start)}, ${timeFormatter.format(start)}-${timeFormatter.format(end)}`
}

function parseDate(value: Date | string | null): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value
  if (typeof value !== 'string') return null
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ')
}

async function executeRows<T>(em: EntityManager, sql: string, params: unknown[]): Promise<T[]> {
  const rows = await em.getConnection().execute(sql, params)
  return Array.isArray(rows) ? rows as T[] : []
}

const surveyBookingRecordSchema = z.object({
  id: z.string().uuid(),
  dealId: z.string().uuid(),
  scheduledAt: z.string().datetime(),
  endsAt: z.string().datetime(),
  durationMinutes: z.number().int(),
  status: z.string(),
})

const surveyBookingStateSchema = z.object({
  ok: z.literal(true),
  canBook: z.boolean(),
  reason: z.enum(['ready', 'not_linked', 'not_in_survey_stage', 'no_surveyors', 'no_slots']),
  deals: z.array(z.object({
    id: z.string().uuid(),
    title: z.string(),
    stageName: z.string(),
    bookedSurvey: surveyBookingRecordSchema.nullable(),
  })),
  slots: z.array(z.object({
    id: z.string(),
    startsAt: z.string().datetime(),
    endsAt: z.string().datetime(),
    label: z.string(),
  })),
  durationMinutes: z.number().int(),
})

const surveyBookingErrorSchema = z.object({
  ok: z.literal(false),
  error: z.string(),
})

export const epcSurveyBookingGetDoc: OpenApiMethodDoc = {
  summary: 'Get EPC portal survey booking state',
  description: 'Returns eligible Survey-stage deals and anonymized survey booking slots for the authenticated customer portal user.',
  tags: ['EPC Demo'],
  responses: [{ status: 200, description: 'Survey booking state.', schema: surveyBookingStateSchema }],
  errors: [
    { status: 401, description: 'Customer authentication required.', schema: surveyBookingErrorSchema },
    { status: 403, description: 'Portal feature is missing.', schema: surveyBookingErrorSchema },
  ],
}

export const epcSurveyBookingPostDoc: OpenApiMethodDoc = {
  summary: 'Book EPC portal survey appointment',
  description: 'Creates or reschedules a planned CRM calendar interaction for a customer-owned Survey-stage deal.',
  tags: ['EPC Demo'],
  requestBody: {
    contentType: 'application/json',
    schema: epcSurveyBookingPostSchema,
  },
  responses: [{
    status: 200,
    description: 'Survey booked.',
    schema: z.object({
      ok: z.literal(true),
      booking: surveyBookingRecordSchema,
      state: surveyBookingStateSchema,
    }),
  }],
  errors: [
    { status: 400, description: 'Invalid booking payload.', schema: surveyBookingErrorSchema },
    { status: 401, description: 'Customer authentication required.', schema: surveyBookingErrorSchema },
    { status: 403, description: 'Portal feature is missing.', schema: surveyBookingErrorSchema },
    { status: 409, description: 'Selected slot is no longer available.', schema: surveyBookingErrorSchema },
  ],
}

export const epcSurveyBookingOpenApi: OpenApiRouteDoc = {
  tag: 'EPC Demo',
  summary: 'EPC portal survey booking',
  methods: {
    GET: epcSurveyBookingGetDoc,
    POST: epcSurveyBookingPostDoc,
  },
}
