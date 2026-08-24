import { createHmac, randomBytes } from 'node:crypto'
import { buildApplyFormScenarios } from './apply-form-scenarios'

const endpoint = process.env.FINOO_APPLICATION_ENDPOINT?.trim() ?? ''
const signingSecret = process.env.FINOO_APPLICATION_SIGNING_SECRET ?? ''
const runId = process.env.FINOO_APPLICATION_TEST_RUN_ID?.trim() ?? `run${Date.now().toString(36)}`

type SubmissionResult = {
  scenario: string
  step: number | string
  messageId: string
  status: number
  intakeId?: string
  duplicate?: boolean
}

type RunnerPhase = 'all' | 'step1' | 'step2' | 'step3' | 'negative'

function messageId(): string {
  return `thom110_${randomBytes(18).toString('base64url')}`
}

function sign(body: Uint8Array, nonce: string, timestamp: string, secret = signingSecret): string {
  return createHmac('sha256', secret)
    .update(`${nonce}.${timestamp}.`, 'ascii')
    .update(body)
    .digest('base64')
}

async function send(
  payload: Record<string, unknown>,
  nonce: string,
  options: { timestamp?: string; secret?: string; contentType?: string } = {},
): Promise<{ status: number; response: Record<string, unknown> }> {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  const timestamp = options.timestamp ?? String(Math.floor(Date.now() / 1000))
  const response = await fetch(endpoint, {
    method: 'POST',
    body,
    headers: {
      'content-type': options.contentType ?? 'application/json',
      'finoo-message-id': nonce,
      'finoo-timestamp': timestamp,
      'finoo-signature': `v1,${sign(body, nonce, timestamp, options.secret)}`,
    },
  })
  const responseText = await response.text()
  let parsed: Record<string, unknown> = {}
  try {
    parsed = JSON.parse(responseText) as Record<string, unknown>
  } catch {
    parsed = { error: 'non_json_response' }
  }
  return { status: response.status, response: parsed }
}

function requireStatus(actual: number, expected: number, label: string): void {
  if (actual !== expected) throw new Error(`[internal] ${label} returned ${actual}, expected ${expected}`)
}

async function main(): Promise<void> {
  if (process.argv[2] !== '--execute') throw new Error('[internal] Pass --execute to run live FINOO intake verification')
  const phase = (process.argv[3] ?? 'all') as RunnerPhase
  if (!['all', 'step1', 'step2', 'step3', 'negative'].includes(phase)) {
    throw new Error('[internal] Phase must be all, step1, step2, step3, or negative')
  }
  if (!/^https:\/\//.test(endpoint)) throw new Error('[internal] FINOO_APPLICATION_ENDPOINT must be an HTTPS URL')
  if (Buffer.byteLength(signingSecret, 'utf8') < 32) throw new Error('[internal] FINOO_APPLICATION_SIGNING_SECRET must contain at least 32 bytes')

  const scenarios = buildApplyFormScenarios(runId)
  const results: SubmissionResult[] = []
  if (phase !== 'negative') {
    const selectedStep = phase === 'all' ? undefined : Number(phase.slice(-1))
    for (const scenario of scenarios) {
      for (const formStep of scenario.steps.filter(({ step }) => selectedStep === undefined || step === selectedStep)) {
        const nonce = messageId()
        const result = await send(formStep.payload, nonce)
        requireStatus(result.status, 202, `${scenario.key} step ${formStep.step}`)
        if (typeof result.response.intakeId !== 'string') {
          throw new Error(`[internal] ${scenario.key} step ${formStep.step} returned no intake ID`)
        }
        results.push({
          scenario: scenario.key,
          step: formStep.step,
          messageId: nonce,
          status: result.status,
          intakeId: result.response.intakeId,
        })
      }
    }
  }

  let negativeStatuses: Record<string, number> | undefined
  if (phase === 'all' || phase === 'negative') {
    const duplicateScenario = scenarios[0]!
    const duplicatePayload = duplicateScenario.steps[2]!.payload
    const duplicateNonce = messageId()
    const first = await send(duplicatePayload, duplicateNonce)
    requireStatus(first.status, 202, 'duplicate seed')
    if (typeof first.response.intakeId !== 'string') throw new Error('[internal] Duplicate seed returned no intake ID')
    const duplicate = await send(duplicatePayload, duplicateNonce)
    requireStatus(duplicate.status, 200, 'duplicate replay')
    if (duplicate.response.duplicate !== true || duplicate.response.intakeId !== first.response.intakeId) {
      throw new Error('[internal] Duplicate replay did not return the original intake ID')
    }
    results.push({
      scenario: duplicateScenario.key,
      step: 'duplicate',
      messageId: duplicateNonce,
      status: duplicate.status,
      intakeId: String(duplicate.response.intakeId),
      duplicate: true,
    })
    const conflict = await send({ ...duplicatePayload, amount: '100001' }, duplicateNonce)
    requireStatus(conflict.status, 409, 'message ID conflict')

    const negativeLeadId = `thom110_${runId}_negative`
    const missingConsentVersion = await send({ leadId: negativeLeadId, completed: false, acceptTerms: true }, messageId())
    requireStatus(missingConsentVersion.status, 400, 'missing consent version')
    const invalidSignature = await send({ leadId: negativeLeadId }, messageId(), { secret: 'x'.repeat(32) })
    requireStatus(invalidSignature.status, 401, 'invalid signature')
    const staleTimestamp = String(Math.floor(Date.now() / 1000) - 301)
    const stale = await send({ leadId: negativeLeadId }, messageId(), { timestamp: staleTimestamp })
    requireStatus(stale.status, 400, 'stale timestamp')
    const invalidContentType = await send({ leadId: negativeLeadId }, messageId(), { contentType: 'text/plain' })
    requireStatus(invalidContentType.status, 415, 'invalid content type')
    const oversized = await send({ leadId: negativeLeadId, padding: 'x'.repeat(65_536) }, messageId())
    requireStatus(oversized.status, 413, 'oversized body')
    negativeStatuses = {
      conflict: conflict.status,
      missingConsentVersion: missingConsentVersion.status,
      invalidSignature: invalidSignature.status,
      staleTimestamp: stale.status,
      invalidContentType: invalidContentType.status,
      oversizedBody: oversized.status,
    }
  }

  process.stdout.write(`${JSON.stringify({
    ok: true,
    runId,
    phase,
    endpoint,
    scenarios: scenarios.map(({ key, expectedState, expectedStage }) => ({ key, expectedState, expectedStage })),
    submissions: results,
    negativeStatuses,
  })}\n`)
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
