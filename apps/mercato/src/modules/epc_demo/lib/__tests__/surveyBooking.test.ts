import {
  buildSurveyBookingSlots,
  encodeSurveySlotId,
  intervalsOverlap,
  isSurveyStageName,
  resolveSurveyorAvailabilityWindows,
  resolveSurveyDurationMinutes,
} from '../surveyBooking'
import { DefaultPlannerAvailabilityService } from '@open-mercato/core/modules/planner/services/plannerAvailabilityService'

const surveyorA = {
  userId: '11111111-1111-4111-8111-111111111111',
  displayName: 'Surveyor A',
  email: 'a@example.com',
  staffMemberId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  availabilityRuleSetId: null,
}

const surveyorB = {
  userId: '22222222-2222-4222-8222-222222222222',
  displayName: 'Surveyor B',
  email: 'b@example.com',
  staffMemberId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  availabilityRuleSetId: null,
}

describe('EPC survey booking', () => {
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
