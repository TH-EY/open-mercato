import {
  aggregateSurveyorCandidates,
  buildSurveyBookingAdvisoryLockKeys,
  buildSurveyBookingSlots,
  createSurveyorLookup,
  encodeSurveySlotId,
  executeRows,
  intervalsOverlap,
  isSurveyStageName,
  mapBusyRowsToIntervals,
  resolveSurveyorAvailabilityWindows,
  resolveSurveyDurationMinutes,
  type BusyRow,
} from '../surveyBooking'
import { DefaultPlannerAvailabilityService } from '@open-mercato/core/modules/planner/services/plannerAvailabilityService'

const surveyorA = {
  userId: '11111111-1111-4111-8111-111111111111',
  displayName: 'Surveyor A',
  email: 'a@example.com',
  availabilitySubjectIds: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
}

const surveyorB = {
  userId: '22222222-2222-4222-8222-222222222222',
  displayName: 'Surveyor B',
  email: 'b@example.com',
  availabilitySubjectIds: ['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'],
}

function busyRow(overrides: Partial<BusyRow> = {}): BusyRow {
  return {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    interaction_type: 'event',
    title: 'Busy',
    status: 'planned',
    owner_user_id: surveyorA.userId,
    participants: [],
    scheduled_at: '2026-07-13T10:00:00.000Z',
    occurred_at: null,
    duration_minutes: 60,
    all_day: false,
    location: null,
    recurrence_rule: null,
    recurrence_end: null,
    appearance_icon: null,
    appearance_color: null,
    entity_id: null,
    deal_id: null,
    updated_at: '2026-07-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('EPC survey booking', () => {
  it('binds raw reads and advisory locks to the active EntityManager transaction', async () => {
    const transaction = { client: 'transaction' }
    const execute = jest.fn(async () => [{ ok: true }])
    const em = {
      getConnection: () => ({ execute }),
      getTransactionContext: () => transaction,
    } as never

    await expect(executeRows(em, 'select ?', ['value'])).resolves.toEqual([{ ok: true }])
    expect(execute).toHaveBeenCalledWith('select ?', ['value'], 'all', transaction)
  })

  it('forwards POST owner lookup dependencies to the surveyor candidate loader', async () => {
    const container = {} as never
    const em = {} as never
    const scope = { tenantId: 'tenant', organizationId: 'organization' }
    const candidateLoader = jest.fn().mockResolvedValue([surveyorB, surveyorA])
    const lookup = createSurveyorLookup(candidateLoader)

    await expect(lookup({ container, em, scope, userId: surveyorA.userId })).resolves.toBe(surveyorA)
    expect(candidateLoader).toHaveBeenCalledWith(container, em, scope, 'Surveyor')
  })

  it('returns no windows without explicit planner availability', () => {
    expect(resolveSurveyorAvailabilityWindows({
      service: new DefaultPlannerAvailabilityService(),
      rules: [],
      range: {
        start: new Date('2026-07-13T00:00:00.000Z'),
        end: new Date('2026-07-14T00:00:00.000Z'),
      },
    })).toEqual([])
  })

  it('returns no windows when the planner service is unavailable', () => {
    expect(resolveSurveyorAvailabilityWindows({
      service: undefined,
      rules: [{
        id: 'rule',
        kind: 'availability',
        rrule: 'DTSTART:20260713T090000Z\nDURATION:PT2H\nRRULE:FREQ=DAILY;COUNT=1',
      }],
      range: {
        start: new Date('2026-07-13T00:00:00.000Z'),
        end: new Date('2026-07-14T00:00:00.000Z'),
      },
    })).toEqual([])
  })

  it('aggregates every deterministic scheduling reference into one Surveyor candidate', () => {
    const candidates = aggregateSurveyorCandidates({
      userIds: [surveyorA.userId],
      users: [{ id: surveyorA.userId, name: '', email: surveyorA.email }],
      schedulingRefs: [
        {
          userId: surveyorA.userId,
          staffMemberId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          availabilityRuleSetId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
          displayName: 'Second ref',
        },
        {
          userId: surveyorA.userId,
          staffMemberId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          availabilityRuleSetId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          displayName: 'First ref',
        },
      ],
    })

    expect(candidates).toEqual([{
      userId: surveyorA.userId,
      displayName: 'First ref',
      email: surveyorA.email,
      availabilitySubjectIds: [
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      ],
    }])
  })

  it('expands recurring busy interactions whose base starts before the requested range', () => {
    const intervals = mapBusyRowsToIntervals({
      rows: [busyRow({
        scheduled_at: '2026-07-06T10:00:00.000Z',
        recurrence_rule: 'FREQ=WEEKLY;COUNT=2',
        recurrence_end: '2026-07-13T10:00:00.000Z',
      })],
      surveyorUserIds: [surveyorA.userId],
      rangeStart: new Date('2026-07-13T00:00:00.000Z'),
      rangeEnd: new Date('2026-07-14T00:00:00.000Z'),
      defaultDurationMinutes: 60,
    })

    expect(intervals).toEqual([{
      userId: surveyorA.userId,
      start: new Date('2026-07-13T10:00:00.000Z'),
      end: new Date('2026-07-13T11:00:00.000Z'),
    }])
  })

  it('maps all-day owner and participant interactions through canonical calendar semantics', () => {
    const intervals = mapBusyRowsToIntervals({
      rows: [busyRow({
        scheduled_at: '2026-07-13T12:00:00.000Z',
        owner_user_id: null,
        participants: [{ userId: surveyorA.userId }],
        all_day: true,
      })],
      surveyorUserIds: [surveyorA.userId],
      rangeStart: new Date('2026-07-13T10:00:00.000Z'),
      rangeEnd: new Date('2026-07-13T11:00:00.000Z'),
      defaultDurationMinutes: 60,
    })

    expect(intervals).toHaveLength(1)
    expect(intervals[0].userId).toBe(surveyorA.userId)
    expect(intervalsOverlap(
      new Date('2026-07-13T10:00:00.000Z'),
      new Date('2026-07-13T11:00:00.000Z'),
      intervals[0].start,
      intervals[0].end,
    )).toBe(true)
  })

  it('builds sorted scoped advisory keys whose time buckets overlap for conflicting claims', () => {
    const base = {
      scope: { tenantId: 'tenant-a', organizationId: 'organization-a' },
      dealId: 'deal-a',
      surveyorUserId: surveyorA.userId,
    }
    const first = buildSurveyBookingAdvisoryLockKeys({
      ...base,
      startsAt: new Date('2026-07-13T10:00:00.000Z'),
      endsAt: new Date('2026-07-13T11:00:00.000Z'),
    })
    const overlapping = buildSurveyBookingAdvisoryLockKeys({
      ...base,
      dealId: 'deal-b',
      startsAt: new Date('2026-07-13T10:30:00.000Z'),
      endsAt: new Date('2026-07-13T11:30:00.000Z'),
    })

    expect(first).toEqual([...first].sort())
    expect(first.some((key) => key.includes('tenant-a:organization-a'))).toBe(true)
    expect(first.filter((key) => overlapping.includes(key))).not.toEqual([])
  })

  it('matches Survey stage names without accepting unrelated stages', () => {
    expect(isSurveyStageName('Survey')).toBe(true)
    expect(isSurveyStageName(' survey ')).toBe(true)
    expect(isSurveyStageName('SURVEY')).toBe(true)
    expect(isSurveyStageName('Survey booked')).toBe(false)
    expect(isSurveyStageName('Lead')).toBe(false)
  })

  it('uses a bounded survey duration from env with a stable default', () => {
    expect(resolveSurveyDurationMinutes({} as NodeJS.ProcessEnv)).toBe(60)
    expect(resolveSurveyDurationMinutes({ EPC_SURVEY_DURATION_MINUTES: '90' } as NodeJS.ProcessEnv)).toBe(90)
    expect(resolveSurveyDurationMinutes({ EPC_SURVEY_DURATION_MINUTES: '5' } as NodeJS.ProcessEnv)).toBe(60)
  })

  it('encodes stable opaque slot ids without exposing surveyor identifiers', () => {
    const id = encodeSurveySlotId({
      surveyorUserId: surveyorA.userId,
      startsAt: '2026-07-13T09:00:00.000Z',
    })
    const sameId = encodeSurveySlotId({
      surveyorUserId: surveyorA.userId,
      startsAt: '2026-07-13T09:00:00.000Z',
    })
    const differentSurveyorId = encodeSurveySlotId({
      surveyorUserId: surveyorB.userId,
      startsAt: '2026-07-13T09:00:00.000Z',
    })

    expect(id).toBe(sameId)
    expect(id).not.toBe(differentSurveyorId)
    expect(id).toMatch(/^survey_[A-Za-z0-9_-]{32}$/)
    expect(id).not.toContain(surveyorA.userId)
    expect(id).not.toContain('2026-07-13')
  })

  it('detects overlapping busy intervals at exact calendar boundaries', () => {
    const ten = new Date('2026-07-13T10:00:00.000Z')
    const eleven = new Date('2026-07-13T11:00:00.000Z')

    expect(intervalsOverlap(ten, eleven, new Date('2026-07-13T09:00:00.000Z'), ten)).toBe(false)
    expect(intervalsOverlap(ten, eleven, eleven, new Date('2026-07-13T12:00:00.000Z'))).toBe(false)
    expect(intervalsOverlap(ten, eleven, new Date('2026-07-13T10:30:00.000Z'), new Date('2026-07-13T11:30:00.000Z'))).toBe(true)
  })

  it('builds slots from availability windows and removes busy surveyor times', () => {
    const slots = buildSurveyBookingSlots({
      surveyors: [surveyorA],
      windowsBySurveyor: new Map([
        [surveyorA.userId, [{
          start: new Date('2026-07-13T09:00:00.000Z'),
          end: new Date('2026-07-13T12:00:00.000Z'),
        }]],
      ]),
      busyIntervals: [{
        userId: surveyorA.userId,
        start: new Date('2026-07-13T10:00:00.000Z'),
        end: new Date('2026-07-13T11:00:00.000Z'),
      }],
      rangeStart: new Date('2026-07-13T09:00:00.000Z'),
      durationMinutes: 60,
    })

    expect(slots.map((slot) => slot.startsAt)).toEqual([
      '2026-07-13T09:00:00.000Z',
      '2026-07-13T11:00:00.000Z',
    ])
  })

  it('deduplicates matching customer-facing times across surveyors', () => {
    const slots = buildSurveyBookingSlots({
      surveyors: [surveyorA, surveyorB],
      windowsBySurveyor: new Map([
        [surveyorA.userId, [{
          start: new Date('2026-07-13T09:00:00.000Z'),
          end: new Date('2026-07-13T10:00:00.000Z'),
        }]],
        [surveyorB.userId, [{
          start: new Date('2026-07-13T09:00:00.000Z'),
          end: new Date('2026-07-13T10:00:00.000Z'),
        }]],
      ]),
      busyIntervals: [],
      rangeStart: new Date('2026-07-13T09:00:00.000Z'),
      durationMinutes: 60,
    })

    expect(slots).toHaveLength(1)
    expect(slots[0].startsAt).toBe('2026-07-13T09:00:00.000Z')
  })
})
