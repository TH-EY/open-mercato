export const EPC_SURVEY_BOOKING_ENDPOINT = '/api/epc/portal/survey-booking'
export const EPC_SURVEY_BOOKING_FEATURE = 'portal.survey.book'
export const EPC_SURVEY_BOOKING_SOURCE = 'epc_demo:survey_booking'
export const EPC_SURVEY_BOOKING_MARKER = 'EPC_SURVEY_BOOKING'

export type EpcSurveyBookingDeal = {
  id: string
  title: string
  stageName: string
  bookedSurvey: EpcSurveyBookingRecord | null
}

export type EpcSurveyBookingRecord = {
  id: string
  dealId: string
  scheduledAt: string
  endsAt: string
  durationMinutes: number
  status: string
}

export type EpcSurveyBookingSlot = {
  id: string
  startsAt: string
  endsAt: string
  label: string
}

export type EpcSurveyBookingState = {
  ok: true
  canBook: boolean
  reason:
    | 'ready'
    | 'not_linked'
    | 'not_in_survey_stage'
    | 'no_surveyors'
    | 'no_slots'
  deals: EpcSurveyBookingDeal[]
  slots: EpcSurveyBookingSlot[]
  durationMinutes: number
}

export type EpcSurveyBookingPostInput = {
  dealId: string
  slotId: string
}

export type EpcSurveyBookingPostResponse = {
  ok: true
  booking: EpcSurveyBookingRecord
  state: EpcSurveyBookingState
}

export type EpcSurveyBookingErrorResponse = {
  ok: false
  error: string
}
