import { expect, test, type Page } from '@playwright/test'
import { login } from '@open-mercato/core/modules/core/__integration__/helpers/auth'
import { apiRequest, getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'
import { deleteWorkflowDefinitionIfExists } from '@open-mercato/core/helpers/integration/workflowsFixtures'

type EndpointParam = {
  name: string
  in: 'path' | 'query' | 'header'
  required: boolean
  type: string
}

type EndpointItem = {
  path: string
  method: string
  summary: string
  params: EndpointParam[]
  requestSchema?: { properties?: Record<string, unknown> }
  responseSchema?: { properties?: Record<string, unknown> }
}

type EndpointCatalogResponse = {
  items?: EndpointItem[]
}

type DefinitionListResponse = {
  data?: Array<{ id?: string; workflowId?: string }>
}

type DefinitionDetailResponse = {
  data?: {
    definition?: {
      transitions?: Array<{
        activities?: Array<{
          config?: {
            endpoint?: string
            method?: string
            headers?: Record<string, string>
          }
        }>
      }>
    }
  }
}

const endpointInputId = 'transition-0-activity-0-endpoint'

async function fillText(
  locator: ReturnType<Page['locator']>,
  value: string,
): Promise<void> {
  await locator.fill('')
  await locator.fill(value)
}

async function pickRadix(
  page: Page,
  triggerId: string,
  optionLabel: string | RegExp,
): Promise<void> {
  await page.locator(`#${triggerId}`).click()
  const option = typeof optionLabel === 'string'
    ? page.getByRole('option', { name: optionLabel, exact: true })
    : page.getByRole('option', { name: optionLabel })
  await option.first().click()
}

async function pickEndpoint(page: Page, endpoint: EndpointItem): Promise<void> {
  await page.getByRole('button', { name: /^browse endpoints$/i }).click()
  const search = page.getByRole('textbox', {
    name: /search by path, method, tag, or summary/i,
  })
  await search.fill(endpoint.path)
  const result = page
    .getByRole('button')
    .filter({ hasText: endpoint.path })
    .filter({ hasText: endpoint.method })
    .first()
  await expect(result).toBeVisible()
  await result.click()
}

function paramInput(page: Page, param: EndpointParam) {
  return page.locator(`[id="${endpointInputId}-${param.in}-${param.name}"]`)
}

function paramValue(param: EndpointParam, stamp: number, suffix = ''): string {
  if (param.type === 'number' || param.type === 'integer') return suffix ? '2' : '1'
  return `qa-${stamp}${suffix}`
}

async function findDefinitionId(
  request: Parameters<typeof apiRequest>[0],
  token: string,
  workflowId: string,
): Promise<string | null> {
  const response = await apiRequest(
    request,
    'GET',
    '/api/workflows/definitions?limit=100',
    { token },
  )
  if (response.status() !== 200) return null
  const body = await readJsonSafe<DefinitionListResponse>(response)
  return body?.data?.find((definition) => definition.workflowId === workflowId)?.id ?? null
}

test.describe('TC-WF-035: CALL_API endpoint picker', () => {
  test('selects declared endpoints, validates parameters, and round-trips the config', async ({
    page,
    request,
  }) => {
    const stamp = Date.now()
    const workflowId = `qa-wf-endpoint-picker-${stamp}`
    const workflowName = `QA endpoint picker ${stamp}`
    const token = await getAuthToken(request, 'admin')
    let definitionId: string | null = null

    try {
      const catalogResponse = await apiRequest(
        request,
        'GET',
        '/api/workflows/endpoints',
        { token },
      )
      const catalogBody = await readJsonSafe<EndpointCatalogResponse>(catalogResponse)
      expect(catalogResponse.status()).toBe(200)

      const catalog = catalogBody?.items ?? []
      const safeParams = (item: EndpointItem) =>
        item.params.every((param) => /^[A-Za-z0-9_-]+$/.test(param.name))
      const schemaEndpoint = catalog.find((item) =>
        safeParams(item)
        && item.params.some((param) => param.required && param.in !== 'header')
        && Object.keys(item.requestSchema?.properties ?? {}).length > 0
        && Object.keys(item.responseSchema?.properties ?? {}).length > 0,
      )
      const optionalEndpoint = catalog.find((item) =>
        safeParams(item) && item.params.some((param) => !param.required),
      )

      expect(schemaEndpoint, 'catalog should expose a schema-backed endpoint with a required parameter').toBeTruthy()
      expect(optionalEndpoint, 'catalog should expose an endpoint with an optional parameter').toBeTruthy()

      await login(page, 'admin')
      await page.goto('/backend/definitions/create')
      await expect(page).toHaveURL(/\/backend\/definitions\/create/)

      await fillText(page.getByPlaceholder('checkout_workflow'), workflowId)
      await fillText(page.getByPlaceholder('Enter a descriptive workflow name'), workflowName)

      const addStep = page.getByRole('button', { name: /^add step$/i })
      await addStep.click()
      await fillText(page.locator('#step-0-id'), 'start')
      await fillText(page.locator('#step-0-name'), 'Start')
      await pickRadix(page, 'step-0-type', 'Start')

      await addStep.click()
      await fillText(page.locator('#step-1-id'), 'end')
      await fillText(page.locator('#step-1-name'), 'End')
      await pickRadix(page, 'step-1-type', 'End')

      await page.getByRole('button', { name: /^add transition$/i }).click()
      await fillText(page.locator('#transition-0-id'), 'start-to-end')
      await fillText(page.locator('#transition-0-name'), 'Call API')
      await pickRadix(page, 'transition-0-from', /^start$/i)
      await pickRadix(page, 'transition-0-to', /^end$/i)
      await page.getByRole('button', { name: /^add activity$/i }).click()
      await fillText(page.locator('#activity-0-0-id'), 'call-api')
      await fillText(page.locator('#activity-0-0-name'), 'Call selected API')

      await pickEndpoint(page, optionalEndpoint!)
      const optionalParam = optionalEndpoint!.params.find((param) => !param.required)!
      await expect(paramInput(page, optionalParam)).toHaveValue('')
      await expect(paramInput(page, optionalParam)).toHaveAttribute('aria-invalid', 'false')

      await pickEndpoint(page, schemaEndpoint!)
      const requiredParams = schemaEndpoint!.params.filter((param) => param.required)
      const firstRequiredParam = requiredParams[0]
      await expect(paramInput(page, firstRequiredParam)).toHaveValue('')
      await expect(paramInput(page, firstRequiredParam)).toHaveAttribute('aria-invalid', 'true')
      await expect(page.getByText(/required parameter must be filled/i).first()).toBeVisible()

      const requestSchema = page.getByText(/^request schema$/i).locator('..')
      const responseSchema = page.getByText(/^response schema$/i).locator('..')
      const firstRequestField = Object.keys(schemaEndpoint!.requestSchema?.properties ?? {})[0]
      const firstResponseField = Object.keys(schemaEndpoint!.responseSchema?.properties ?? {})[0]
      await expect(requestSchema).toContainText(firstRequestField)
      await expect(responseSchema).toContainText(firstResponseField)

      await page.getByRole('button', { name: /^create workflow$/i }).first().click()
      await expect(page).toHaveURL(/\/backend\/definitions\/create/)
      await expect(paramInput(page, firstRequiredParam)).toHaveAttribute('aria-invalid', 'true')

      for (const param of requiredParams) {
        await paramInput(page, param).fill(paramValue(param, stamp))
      }
      const optionalSchemaParam = schemaEndpoint!.params.find((param) => !param.required)
      if (optionalSchemaParam) {
        await expect(paramInput(page, optionalSchemaParam)).toHaveValue('')
      }

      const endpointInput = page.locator(`#${endpointInputId}`)
      const savedEndpoint = await endpointInput.inputValue()
      await page.getByRole('button', { name: /^create workflow$/i }).first().click()
      await expect(page).toHaveURL(/\/backend\/definitions(?:\?.*)?$/, { timeout: 15_000 })

      definitionId = await findDefinitionId(request, token, workflowId)
      expect(definitionId).toBeTruthy()

      const createdResponse = await apiRequest(
        request,
        'GET',
        `/api/workflows/definitions/${definitionId}`,
        { token },
      )
      const createdBody = await readJsonSafe<DefinitionDetailResponse>(createdResponse)
      const createdConfig = createdBody?.data?.definition?.transitions?.[0]?.activities?.[0]?.config
      expect(createdResponse.status()).toBe(200)
      expect(createdConfig?.endpoint).toBe(savedEndpoint)
      expect(createdConfig?.method).toBe(schemaEndpoint!.method)

      await page.goto(`/backend/definitions/${definitionId}`)
      await expect(page.locator(`#${endpointInputId}`)).toHaveValue(savedEndpoint)
      await expect(page.getByText(/^request schema$/i)).toBeVisible()
      await expect(page.getByText(/^response schema$/i)).toBeVisible()

      const editedValue = paramValue(firstRequiredParam, stamp, '-edited')
      await paramInput(page, firstRequiredParam).fill(editedValue)
      const editedEndpoint = await page.locator(`#${endpointInputId}`).inputValue()
      await page.getByRole('button', { name: /^update workflow$/i }).first().click()
      await expect(page).toHaveURL(/\/backend\/definitions(?:\?.*)?$/, { timeout: 15_000 })

      const updatedResponse = await apiRequest(
        request,
        'GET',
        `/api/workflows/definitions/${definitionId}`,
        { token },
      )
      const updatedBody = await readJsonSafe<DefinitionDetailResponse>(updatedResponse)
      const updatedConfig = updatedBody?.data?.definition?.transitions?.[0]?.activities?.[0]?.config
      expect(updatedResponse.status()).toBe(200)
      expect(updatedConfig?.endpoint).toBe(editedEndpoint)
      expect(updatedConfig?.method).toBe(schemaEndpoint!.method)
    } finally {
      await deleteWorkflowDefinitionIfExists(request, token, definitionId)
    }
  })
})
