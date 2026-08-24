import { createHash } from 'node:crypto'
import { FINOO_CONSENT_REGISTRY_VERSION } from '../lib/consents'

export type ApplyFormStep = {
  step: 1 | 2 | 3
  payload: Record<string, unknown>
}

export type ApplyFormScenario = {
  key: string
  businessType: 'jdg' | 'company'
  documentType: 'IDCARD' | 'PASSPORT' | 'DIGITCARD'
  expectedState: 'completed' | 'disqualified'
  expectedStage: 'Submitted' | 'Closed'
  steps: ApplyFormStep[]
}

type ScenarioOptions = {
  index: number
  businessType: 'jdg' | 'company'
  documentType: 'IDCARD' | 'PASSPORT' | 'DIGITCARD'
  rejection?: 'arrears' | 'too_young' | 'arrears_and_too_young'
}

function documentFields(documentType: ScenarioOptions['documentType']): Record<string, unknown> {
  if (documentType === 'PASSPORT') {
    return {
      idType: documentType,
      passport: 'PA1234567',
      passportCountryCode: 'PL',
      passportIssued: '2023-01-02',
      passportExpiry: '2033-01-02',
    }
  }
  if (documentType === 'DIGITCARD') {
    return {
      idType: documentType,
      digitCard: 'ABCD12345',
      digitCardIssued: '2023-01-02',
      digitCardExpiry: '2033-01-02',
      country: 'PL',
    }
  }
  return {
    idType: documentType,
    idCard: 'ABC123456',
    idCardIssued: '2023-01-02',
    idCardExpiry: '2033-01-02',
    country: 'PL',
  }
}

function numericIdentifier(runId: string, index: number, length: number): string {
  const digest = createHash('sha256').update(`${runId}:${index}:${length}`).digest('hex')
  return (BigInt(`0x${digest.slice(0, 16)}`) % (10n ** BigInt(length))).toString().padStart(length, '0')
}

function buildScenario(runId: string, options: ScenarioOptions): ApplyFormScenario {
  const suffix = String(options.index).padStart(2, '0')
  const leadId = `thom110_${runId}_${suffix}`
  const companyName = `THOM 110 ${runId} ${suffix}`
  const email = `thom110-${runId}-${suffix}@example.invalid`
  const nip = numericIdentifier(runId, options.index, 10)
  const pesel = numericIdentifier(runId, options.index, 11)
  const tooYoung = options.rejection === 'too_young' || options.rejection === 'arrears_and_too_young'
  const arrears = options.rejection === 'arrears' || options.rejection === 'arrears_and_too_young'
  const recentBusinessStartDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1_000).toISOString().slice(0, 10)
  const step1 = {
    leadId,
    consentVersion: FINOO_CONSENT_REGISTRY_VERSION,
    przeszedl_caly_wniosek: 'Nie',
    leadType: 'business',
    companyName,
    nip,
    businessType: options.businessType,
    businessStartDate: tooYoung ? recentBusinessStartDate : '2024-01-02',
    earnings: '50000',
    amount: '100000',
    months: '12',
    reason: 'Synthetic THOM-110 end-to-end verification',
    phonePrefix: '+48',
    phone: `5100000${suffix}`,
    email,
    arrearsUsZus: arrears,
    contactConsent: true,
    contactEmail: true,
    contactSms: false,
    contactPhone: true,
    ...(options.businessType === 'company' ? {
      representatives: [{
        firstname: 'Anna',
        lastname: `Representative${suffix}`,
        email: `thom110-representative-${runId}-${suffix}@example.invalid`,
      }],
    } : {}),
  }
  const step2 = {
    ...step1,
    name: 'Jan',
    surname: `Applicant${suffix}`,
    pesel,
    position: options.businessType === 'jdg' ? 'Właściciel' : 'Prezes zarządu',
    ...documentFields(options.documentType),
    ...(options.businessType === 'jdg' ? { 'NovaLend-propertyCommunity': true } : {}),
  }
  const disqualificationMessage = options.rejection === 'arrears'
    ? 'Synthetic automatic rejection: ZUS/US arrears'
    : options.rejection === 'too_young'
      ? 'Synthetic automatic rejection: business age below six months'
      : options.rejection === 'arrears_and_too_young'
        ? 'Synthetic automatic rejection: ZUS/US arrears and business age below six months'
        : undefined
  const step3 = {
    ...step2,
    przeszedl_caly_wniosek: 'Tak',
    acceptTerms: true,
    emailConsent: options.index % 2 === 0,
    smsConsent: options.index % 3 === 0,
    telefonConsent: options.index % 2 !== 0,
    emailConsent2: options.index % 2 !== 0,
    smsConsent2: false,
    telefonConsent2: options.index % 3 === 0,
    ...(options.businessType === 'jdg' ? {
      jdgConsent: {
        jdg1: { selected: true },
        jdg2: { selected: true },
        jdg3: { selected: true },
      },
    } : {
      legalConsent: {
        legal1: { selected: true },
        legal2: { selected: true },
      },
    }),
    kontomatikCompleted: options.index === 1,
    ...(options.rejection ? {
      disqualified: true,
      disqualification_message: disqualificationMessage,
    } : {}),
  }
  return {
    key: `${options.businessType}-${options.documentType.toLowerCase()}${options.rejection ? `-${options.rejection}` : ''}`,
    businessType: options.businessType,
    documentType: options.documentType,
    expectedState: options.rejection ? 'disqualified' : 'completed',
    expectedStage: options.rejection ? 'Closed' : 'Submitted',
    steps: [
      { step: 1, payload: step1 },
      { step: 2, payload: step2 },
      { step: 3, payload: step3 },
    ],
  }
}

export function buildApplyFormScenarios(rawRunId: string): ApplyFormScenario[] {
  const runId = rawRunId.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 24)
  if (runId.length < 8) throw new Error('[internal] FINOO apply test run ID must contain at least eight safe characters')
  const qualified = (['jdg', 'company'] as const).flatMap((businessType, businessIndex) =>
    (['IDCARD', 'PASSPORT', 'DIGITCARD'] as const).map((documentType, documentIndex) => buildScenario(runId, {
      index: businessIndex * 3 + documentIndex + 1,
      businessType,
      documentType,
    })),
  )
  return [
    ...qualified,
    buildScenario(runId, { index: 7, businessType: 'jdg', documentType: 'IDCARD', rejection: 'arrears' }),
    buildScenario(runId, { index: 8, businessType: 'jdg', documentType: 'IDCARD', rejection: 'too_young' }),
    buildScenario(runId, { index: 9, businessType: 'jdg', documentType: 'IDCARD', rejection: 'arrears_and_too_young' }),
  ]
}
