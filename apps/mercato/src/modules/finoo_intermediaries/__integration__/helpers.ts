import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, type APIRequestContext, type APIResponse } from '@playwright/test'
import { apiRequest, getAuthToken } from '@open-mercato/core/helpers/integration/api'
import {
  createOrganizationFixture,
  createRoleFixture,
  createUserFixture,
  deleteOrganizationIfExists,
  deleteRoleIfExists,
  deleteUserIfExists,
  setRoleAclFeatures,
} from '@open-mercato/core/helpers/integration/authFixtures'
import { readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'

export const DIRECTORY_PATH = '/api/finoo_intermediaries/admin/directory'
export const JSON_HEADERS = { 'Content-Type': 'application/json' }

export type DirectoryStatus = 'delivery_failed' | 'invited' | 'expired' | 'active' | 'inactive'

export type DirectoryItem = {
  id: string
  firstName: string
  lastName: string
  email: string
  status: DirectoryStatus
  hasLinkedAccount: boolean
  relatedDeals: number
  invitationExpiresAt: string | null
  lastEmailStatus: 'pending' | 'delivered' | 'failed' | null
  lastEmailErrorCode: string | null
  updatedAt: string
}

export type DirectoryMutation = {
  item: DirectoryItem
  requiresReactivation?: boolean
  warningCode?: 'access_notice_delivery_failed'
  code?: 'invitation_delivery_failed'
}

export type Scenario = {
  superToken: string
  token: string
  tenantId: string
  organizationId: string
  staffUserId: string
  staffRoleId: string
  staffEmail: string
  staffPassword: string
  intermediaryRoleId: string
  recipient: string
}

type CapturedEmail = {
  to?: string
  subject?: string
  links?: string[]
  text?: string
  capturedAt?: string
}

export async function queryDatabase<T extends Record<string, unknown>>(
  sql: string,
  values: unknown[] = [],
): Promise<T[]> {
  const { Client } = await import('pg')
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) throw new Error('[internal] DATABASE_URL is required')
  const client = new Client({ connectionString: databaseUrl })
  await client.connect()
  try {
    const result = await client.query(sql, values)
    return result.rows as T[]
  } finally {
    await client.end()
  }
}

export async function scopedApiRequest(
  request: APIRequestContext,
  scenario: Pick<Scenario, 'token' | 'organizationId'>,
  method: string,
  path: string,
  data?: unknown,
): Promise<APIResponse> {
  return apiRequest(request, method, path, {
    token: scenario.token,
    data,
    headers: { Cookie: `om_selected_org=${scenario.organizationId}` },
  })
}

export async function createScenario(
  request: APIRequestContext,
  testId: string,
  features: string[] = [
    'finoo_intermediaries.view',
    'finoo_intermediaries.manage',
    'customer_accounts.view',
    'customer_accounts.manage',
    'customer_accounts.roles.manage',
    'customer_accounts.invite',
    'communication_channels.connect_user_channel',
    'customers.deals.view',
    'customers.deals.manage',
  ],
): Promise<Scenario> {
  const suffix = randomUUID().replace(/-/g, '').slice(0, 12)
  const superToken = await getAuthToken(request, 'superadmin')
  const tenantResponse = await apiRequest(request, 'POST', '/api/directory/tenants', {
    token: superToken,
    data: { name: `${testId} tenant ${suffix}` },
  })
  expect(tenantResponse.status(), 'tenant fixture should be created').toBe(201)
  const tenantId = ((await readJsonSafe<{ id?: string }>(tenantResponse))?.id)!
  expect(tenantId).toBeTruthy()
  const organizationId = await createOrganizationFixture(request, superToken, {
    name: `${testId} organization ${suffix}`,
    tenantId,
  })
  const staffRoleId = await createRoleFixture(request, superToken, {
    name: `${testId} administrator ${suffix}`,
    tenantId,
  })
  await setRoleAclFeatures(request, superToken, {
    roleId: staffRoleId,
    features,
    organizations: [organizationId],
  })
  const staffEmail = `${testId.toLowerCase()}-staff-${suffix}@test.local`
  const staffPassword = `Aa1!${suffix}`
  const staffUserId = await createUserFixture(request, superToken, {
    email: staffEmail,
    password: staffPassword,
    organizationId,
    roles: [staffRoleId],
    name: `${testId} Staff`,
  })
  const token = await getAuthToken(request, staffEmail, staffPassword)
  const roleResponse = await apiRequest(request, 'POST', '/api/customer_accounts/admin/roles', {
    token,
    headers: { Cookie: `om_selected_org=${organizationId}` },
    data: {
      name: 'Intermediary',
      slug: 'intermediary',
      description: `${testId} exact scoped intermediary role`,
      customerAssignable: false,
    },
  })
  expect(roleResponse.status(), 'exact intermediary role should be created').toBe(201)
  const roleBody = await readJsonSafe<{ role?: { id?: string } }>(roleResponse)
  const intermediaryRoleId = roleBody?.role?.id
  expect(intermediaryRoleId).toBeTruthy()
  const roleAclResponse = await apiRequest(
    request,
    'PUT',
    `/api/customer_accounts/admin/roles/${intermediaryRoleId}/acl`,
    {
      token,
      headers: { Cookie: `om_selected_org=${organizationId}` },
      data: { features: ['portal.finoo_intermediaries.view'] },
    },
  )
  expect(roleAclResponse.status(), 'intermediary portal ACL should be configured').toBe(200)
  return {
    superToken,
    token,
    tenantId,
    organizationId,
    staffUserId,
    staffRoleId,
    staffEmail,
    staffPassword,
    intermediaryRoleId: intermediaryRoleId!,
    recipient: `${testId.toLowerCase()}-${suffix}@test.local`,
  }
}

export async function inviteIntermediary(
  request: APIRequestContext,
  scenario: Scenario,
  input: { email?: string; firstName?: string; lastName?: string } = {},
): Promise<{ response: APIResponse; body: DirectoryMutation }> {
  const response = await scopedApiRequest(request, scenario, 'POST', `${DIRECTORY_PATH}/invite`, {
    email: input.email ?? scenario.recipient,
    firstName: input.firstName ?? 'Ada',
    lastName: input.lastName ?? 'Lovelace',
  })
  const body = (await readJsonSafe<DirectoryMutation>(response))!
  return { response, body }
}

export async function listDirectory(
  request: APIRequestContext,
  scenario: Pick<Scenario, 'token' | 'organizationId'>,
  query = '',
): Promise<{ response: APIResponse; items: DirectoryItem[]; nextCursor: string | null }> {
  const response = await scopedApiRequest(request, scenario, 'GET', `${DIRECTORY_PATH}${query}`)
  const body = await readJsonSafe<{ items?: DirectoryItem[]; nextCursor?: string | null }>(response)
  return { response, items: body?.items ?? [], nextCursor: body?.nextCursor ?? null }
}

export async function updateIntermediary(
  request: APIRequestContext,
  scenario: Scenario,
  item: DirectoryItem,
  input: { firstName: string; lastName: string; email?: string },
): Promise<{ response: APIResponse; body: DirectoryMutation }> {
  const response = await scopedApiRequest(request, scenario, 'PUT', `${DIRECTORY_PATH}/${item.id}`, {
    ...input,
    expectedUpdatedAt: item.updatedAt,
  })
  return { response, body: (await readJsonSafe<DirectoryMutation>(response))! }
}

export async function runLifecycleAction(
  request: APIRequestContext,
  scenario: Scenario,
  item: DirectoryItem,
  action: 'resend' | 'cancel-invitation' | 'deactivate' | 'reactivate',
): Promise<{ response: APIResponse; body: DirectoryMutation }> {
  const response = await scopedApiRequest(
    request,
    scenario,
    'POST',
    `${DIRECTORY_PATH}/${item.id}/${action}`,
    { expectedUpdatedAt: item.updatedAt },
  )
  return { response, body: (await readJsonSafe<DirectoryMutation>(response))! }
}

const capturePath = process.env.OM_TEST_EMAIL_CAPTURE_PATH?.trim()
  || join(process.cwd(), '.ai', 'qa', 'email-capture.jsonl')

async function capturedEmails(): Promise<CapturedEmail[]> {
  try {
    return (await readFile(capturePath, 'utf8')).split('\n').filter(Boolean)
      .map((line) => JSON.parse(line) as CapturedEmail)
  } catch {
    return []
  }
}

export async function waitForCapturedEmail(recipient: string): Promise<CapturedEmail> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const match = (await capturedEmails()).reverse()
      .find((email) => email.to?.toLowerCase() === recipient.toLowerCase())
    if (match) return match
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error(`[internal] Timed out waiting for captured email for ${recipient}`)
}

export function invitationToken(email: CapturedEmail): string {
  const link = email.links?.find((candidate) => candidate.includes('/portal/invite?token='))
  expect(link, 'capture should include invitation link').toBeTruthy()
  const token = new URL(link!).searchParams.get('token')
  expect(token, 'invitation link should include token').toBeTruthy()
  return token!
}

export async function acceptInvitation(
  request: APIRequestContext,
  token: string,
  displayName = 'Portal Accepted User',
): Promise<APIResponse> {
  return request.post('/api/customer_accounts/invitations/accept', {
    headers: JSON_HEADERS,
    data: { token, password: `Aa1!${randomUUID()}`, displayName },
  })
}

export async function createCustomerUser(
  request: APIRequestContext,
  scenario: Scenario,
  input: { email?: string; displayName?: string; roleIds?: string[] } = {},
): Promise<{ id: string; email: string; password: string }> {
  const email = input.email ?? scenario.recipient
  const password = `Aa1!${randomUUID().replace(/-/g, '')}`
  const response = await scopedApiRequest(request, scenario, 'POST', '/api/customer_accounts/admin/users', {
    email,
    password,
    displayName: input.displayName ?? 'Existing Portal User',
    ...(input.roleIds ? { roleIds: input.roleIds } : {}),
  })
  expect(response.status(), 'customer user fixture should be created').toBe(201)
  const body = await readJsonSafe<{ user?: { id?: string } }>(response)
  expect(body?.user?.id).toBeTruthy()
  return { id: body!.user!.id!, email, password }
}

export async function setCustomerUserActive(userId: string, active: boolean): Promise<void> {
  await queryDatabase('update customer_users set is_active = $2, updated_at = now() where id = $1', [userId, active])
}

export async function seedAssignment(input: {
  scenario: Scenario
  customerUserId: string
  deleted?: boolean
}): Promise<string> {
  const id = randomUUID()
  await queryDatabase(
    `insert into finoo_intermediary_assignments
      (id, tenant_id, organization_id, deal_id, intermediary_customer_user_id,
       intermediary_role_id, eligible_stage_id, partner_status, assigned_by_user_id,
       created_at, updated_at, deleted_at)
     values ($1,$2,$3,$4,$5,$6,$7,'new',$8,now(),now(),$9)`,
    [
      id,
      input.scenario.tenantId,
      input.scenario.organizationId,
      randomUUID(),
      input.customerUserId,
      input.scenario.intermediaryRoleId,
      randomUUID(),
      input.scenario.staffUserId,
      input.deleted ? new Date() : null,
    ],
  )
  return id
}

export async function cleanupScenario(request: APIRequestContext, scenario: Scenario | null): Promise<void> {
  if (!scenario) return
  await queryDatabase('delete from finoo_intermediary_notes where tenant_id = $1 and organization_id = $2', [scenario.tenantId, scenario.organizationId])
  await queryDatabase('delete from finoo_intermediary_assignments where tenant_id = $1 and organization_id = $2', [scenario.tenantId, scenario.organizationId])
  await queryDatabase('delete from finoo_intermediaries where tenant_id = $1 and organization_id = $2', [scenario.tenantId, scenario.organizationId])
  await queryDatabase('delete from customer_deal_people where deal_id in (select id from customer_deals where tenant_id=$1 and organization_id=$2)', [scenario.tenantId, scenario.organizationId])
  await queryDatabase('delete from customer_deal_companies where deal_id in (select id from customer_deals where tenant_id=$1 and organization_id=$2)', [scenario.tenantId, scenario.organizationId])
  await queryDatabase('delete from customer_deal_stage_transitions where tenant_id=$1 and organization_id=$2', [scenario.tenantId, scenario.organizationId])
  await queryDatabase('delete from customer_activities where tenant_id=$1 and organization_id=$2', [scenario.tenantId, scenario.organizationId])
  await queryDatabase('delete from customer_comments where tenant_id=$1 and organization_id=$2', [scenario.tenantId, scenario.organizationId])
  await queryDatabase('delete from customer_deals where tenant_id=$1 and organization_id=$2', [scenario.tenantId, scenario.organizationId])
  await queryDatabase('delete from customer_person_company_links where tenant_id=$1 and organization_id=$2', [scenario.tenantId, scenario.organizationId])
  await queryDatabase('delete from customer_people where tenant_id=$1 and organization_id=$2', [scenario.tenantId, scenario.organizationId])
  await queryDatabase('delete from customer_companies where tenant_id=$1 and organization_id=$2', [scenario.tenantId, scenario.organizationId])
  await queryDatabase('delete from customer_pipeline_stages where tenant_id=$1 and organization_id=$2', [scenario.tenantId, scenario.organizationId])
  await queryDatabase('delete from customer_pipelines where tenant_id=$1 and organization_id=$2', [scenario.tenantId, scenario.organizationId])
  await queryDatabase('delete from customer_entities where tenant_id=$1 and organization_id=$2', [scenario.tenantId, scenario.organizationId])
  await queryDatabase(`delete from customer_user_email_verifications where user_id in (select id from customer_users where tenant_id = $1 and organization_id = $2)`, [scenario.tenantId, scenario.organizationId])
  await queryDatabase(`delete from customer_user_password_resets where user_id in (select id from customer_users where tenant_id = $1 and organization_id = $2)`, [scenario.tenantId, scenario.organizationId])
  await queryDatabase(`delete from customer_user_sessions where user_id in (select id from customer_users where tenant_id = $1 and organization_id = $2)`, [scenario.tenantId, scenario.organizationId])
  await queryDatabase(`delete from customer_user_acls where user_id in (select id from customer_users where tenant_id = $1 and organization_id = $2)`, [scenario.tenantId, scenario.organizationId])
  await queryDatabase(`delete from customer_user_roles where user_id in (select id from customer_users where tenant_id = $1 and organization_id = $2)`, [scenario.tenantId, scenario.organizationId])
  await queryDatabase('delete from customer_user_invitations where tenant_id = $1 and organization_id = $2', [scenario.tenantId, scenario.organizationId])
  await queryDatabase('delete from customer_users where tenant_id = $1 and organization_id = $2', [scenario.tenantId, scenario.organizationId])
  await queryDatabase(`delete from customer_role_acls where role_id in (select id from customer_roles where tenant_id = $1 and organization_id = $2)`, [scenario.tenantId, scenario.organizationId])
  await queryDatabase('delete from customer_roles where tenant_id = $1 and organization_id = $2', [scenario.tenantId, scenario.organizationId])
  await queryDatabase('delete from communication_channels where tenant_id = $1 and organization_id = $2', [scenario.tenantId, scenario.organizationId])
  await queryDatabase('delete from sessions where user_id in (select id from users where tenant_id=$1)', [scenario.tenantId])
  await queryDatabase('delete from user_roles where user_id in (select id from users where tenant_id=$1)', [scenario.tenantId])
  await queryDatabase('delete from user_acls where user_id in (select id from users where tenant_id=$1)', [scenario.tenantId])
  await queryDatabase('delete from role_acls where tenant_id=$1', [scenario.tenantId])
  await queryDatabase('delete from users where tenant_id=$1', [scenario.tenantId])
  await queryDatabase('delete from roles where tenant_id=$1', [scenario.tenantId])
  await deleteUserIfExists(request, scenario.superToken, scenario.staffUserId)
  await deleteRoleIfExists(request, scenario.superToken, scenario.staffRoleId)
  await deleteOrganizationIfExists(request, scenario.superToken, scenario.organizationId)
  await apiRequest(request, 'DELETE', '/api/directory/tenants', {
    token: scenario.superToken,
    data: { id: scenario.tenantId },
  }).catch(() => undefined)
}
