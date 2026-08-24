import { buildApplyFormScenarios } from '../../__integration__/apply-form-scenarios'
import { parseAndSanitizeFinooApplicationPayload } from '../validators'

const metadata = {
  messageId: 'message_1234567890123456',
  sourceTimestamp: 1_787_000_000,
  receivedAt: '2026-08-24T00:00:00.000Z',
  sourceIp: '192.0.2.10',
}

describe('current finoo.pl/apply server contract', () => {
  it('accepts every canonical step for all business, identity-document and rejection paths', () => {
    const scenarios = buildApplyFormScenarios('unitrun01')
    expect(scenarios).toHaveLength(9)
    expect(scenarios.flatMap(({ steps }) => steps)).toHaveLength(27)
    for (const scenario of scenarios) {
      expect(scenario.steps.map(({ step }) => step)).toEqual([1, 2, 3])
      expect(scenario.steps.map(({ payload }) => payload.completed)).toEqual([false, false, true])
      for (const formStep of scenario.steps) {
        expect(() => parseAndSanitizeFinooApplicationPayload(formStep.payload, metadata)).not.toThrow()
      }
    }
    expect(new Set(scenarios.filter(({ expectedState }) => expectedState === 'completed')
      .map(({ businessType, documentType }) => `${businessType}:${documentType}`))).toEqual(new Set([
      'jdg:IDCARD', 'jdg:PASSPORT', 'jdg:DIGITCARD',
      'company:IDCARD', 'company:PASSPORT', 'company:DIGITCARD',
    ]))
    expect(scenarios.filter(({ expectedState }) => expectedState === 'disqualified')).toHaveLength(3)
  })

  it('keeps contact and marketing decisions separate and strips unsupported UI-only fields', () => {
    const payload = buildApplyFormScenarios('unitrun02')[0]!.steps[2]!.payload
    const parsed = parseAndSanitizeFinooApplicationPayload({
      ...payload,
      contactEmail: true,
      emailConsent: false,
      propertyCollateral: true,
      turnover: '50 000 zł',
    }, metadata)
    expect(parsed.contactEmail).toBe(true)
    expect(parsed.emailConsent).toBe(false)
    expect(parsed.ingestionMeta.unknownFieldNames).toEqual(['propertyCollateral', 'turnover'])
    expect(parsed).not.toHaveProperty('propertyCollateral')
    expect(parsed).not.toHaveProperty('turnover')
  })
})
