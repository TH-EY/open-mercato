import { expect, test } from '@playwright/test'
import { apiRequest, getAuthToken } from '@open-mercato/core/helpers/integration/api'
import {
  createRoleFixture,
  deleteRoleIfExists,
  setRoleAclFeatures,
} from '@open-mercato/core/helpers/integration/authFixtures'
import { deleteCatalogCategoryIfExists } from '@open-mercato/core/helpers/integration/catalogFixtures'
import {
  createBusinessRuleFixture,
  deleteBusinessRuleIfExists,
} from '@open-mercato/core/helpers/integration/businessRulesFixtures'
import { deleteGeneralEntityIfExists, getTokenScope, readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'
import {
  buildBusinessRulePayload,
  cleanupBusinessRulesUser,
  createBusinessRulesUser,
  type ExecutionRuleEntry,
} from './helpers/businessRulesApi'

export const integrationMeta = {
  dependsOnModules: ['business_rules', 'api_keys', 'auth', 'catalog'],
}

type OpenMercatoOptionsBody = {
  apiKeys?: Array<{ id?: string }>
}

type CatalogCategoryListBody = {
  items?: Array<{ id?: string; name?: string }>
}

test.describe('TC-BR-012: CALL_OPEN_MERCATO grant ceiling', () => {
  test('denies broader API key profiles and executes catalog category creation for an authorized actor', async ({ request }) => {
    const adminToken = await getAuthToken(request, 'superadmin')
    const { organizationId } = getTokenScope(adminToken)
    const stamp = Date.now()
    const profileRoleName = `QA TC-BR-012 Catalog Profile ${stamp}`
    const profileKeyName = `QA TC-BR-012 API Profile ${stamp}`
    const limitedEmail = `qa-br-012-limited-${stamp}@example.test`
    const authorizedEmail = `qa-br-012-authorized-${stamp}@example.test`
    const categoryName = `QA TC-BR-012 Category ${stamp}`
    const entityType = `QaCallOpenMercatoEntity${stamp}`
    let profileRoleId: string | null = null
    let apiKeyProfileId: string | null = null
    let limitedUserId: string | null = null
    let limitedRoleId: string | null = null
    let authorizedUserId: string | null = null
    let authorizedRoleId: string | null = null
    let ruleId: string | null = null
    let categoryId: string | null = null

    try {
      profileRoleId = await createRoleFixture(request, adminToken, { name: profileRoleName })
      await setRoleAclFeatures(request, adminToken, {
        roleId: profileRoleId,
        features: ['catalog.categories.manage', 'catalog.categories.view'],
        organizations: [organizationId],
      })

      const profileResponse = await apiRequest(request, 'POST', '/api/api_keys/keys', {
        token: adminToken,
        data: {
          name: profileKeyName,
          organizationId,
          roles: [profileRoleId],
        },
      })
      expect(profileResponse.status(), 'API key profile creation should succeed').toBe(201)
      const profileBody = await readJsonSafe<{ id?: string }>(profileResponse)
      apiKeyProfileId = profileBody?.id ?? null
      expect(apiKeyProfileId, 'API key profile id should be returned').toBeTruthy()

      const limited = await createBusinessRulesUser(request, adminToken, {
        email: limitedEmail,
        organizationId,
        features: ['business_rules.manage', 'business_rules.view', 'api_keys.view', 'api_keys.create'],
        roleName: `QA TC-BR-012 Limited ${stamp}`,
      })
      limitedUserId = limited.userId
      limitedRoleId = limited.roleId

      const limitedOptionsResponse = await apiRequest(request, 'GET', '/api/business_rules/openmercato-call-options', {
        token: limited.token,
      })
      expect(limitedOptionsResponse.status(), 'limited actor can read filtered OpenMercato options').toBe(200)
      const limitedOptions = await readJsonSafe<OpenMercatoOptionsBody>(limitedOptionsResponse)
      expect(limitedOptions?.apiKeys?.map((entry) => entry.id)).not.toContain(apiKeyProfileId)

      const deniedCreateResponse = await apiRequest(request, 'POST', '/api/business_rules/rules', {
        token: limited.token,
        data: buildBusinessRulePayload(`TC_BR_012_DENIED_${stamp}`, {
          ruleType: 'ACTION',
          entityType,
          successActions: [
            {
              type: 'CALL_OPEN_MERCATO',
              config: {
                endpoint: '/api/catalog/categories',
                method: 'POST',
                apiKeyId: apiKeyProfileId,
                body: { name: `Denied ${categoryName}` },
              },
            },
          ],
        }),
      })
      expect(deniedCreateResponse.status(), 'limited actor must not save a wider profile').toBe(403)
      const deniedBody = await readJsonSafe<{ error?: string }>(deniedCreateResponse)
      expect(deniedBody?.error).toContain('Cannot grant feature catalog.categories.manage')

      const authorized = await createBusinessRulesUser(request, adminToken, {
        email: authorizedEmail,
        organizationId,
        features: [
          'business_rules.manage',
          'business_rules.view',
          'business_rules.execute',
          'api_keys.view',
          'api_keys.create',
          'catalog.categories.manage',
          'catalog.categories.view',
        ],
        roleName: `QA TC-BR-012 Authorized ${stamp}`,
      })
      authorizedUserId = authorized.userId
      authorizedRoleId = authorized.roleId

      const authorizedOptionsResponse = await apiRequest(request, 'GET', '/api/business_rules/openmercato-call-options', {
        token: authorized.token,
      })
      expect(authorizedOptionsResponse.status(), 'authorized actor can read OpenMercato options').toBe(200)
      const authorizedOptions = await readJsonSafe<OpenMercatoOptionsBody>(authorizedOptionsResponse)
      expect(authorizedOptions?.apiKeys?.map((entry) => entry.id)).toContain(apiKeyProfileId)

      const ruleKey = `TC_BR_012_ALLOWED_${stamp}`
      ruleId = await createBusinessRuleFixture(
        request,
        authorized.token,
        buildBusinessRulePayload(ruleKey, {
          ruleId: ruleKey,
          ruleType: 'ACTION',
          entityType,
          successActions: [
            {
              type: 'CALL_OPEN_MERCATO',
              config: {
                endpoint: '/api/catalog/categories',
                method: 'POST',
                apiKeyId: apiKeyProfileId,
                body: { name: categoryName },
              },
            },
          ],
        }),
      )

      const executeResponse = await apiRequest(request, 'POST', '/api/business_rules/execute', {
        token: authorized.token,
        data: {
          entityType,
          eventType: 'beforeSave',
          entityId: crypto.randomUUID(),
          data: { status: 'ACTIVE' },
        },
      })
      expect(executeResponse.status(), 'CALL_OPEN_MERCATO execution should return 200').toBe(200)
      const executeBody = await readJsonSafe<{ executedRules?: ExecutionRuleEntry[] }>(executeResponse)
      const entry = executeBody?.executedRules?.find((item) => item.ruleId === ruleKey)
      expect(entry?.actionsExecuted?.success, 'internal catalog API action should succeed').toBe(true)
      expect(entry?.actionsExecuted?.results?.some((result) => result.type === 'CALL_OPEN_MERCATO' && result.success)).toBe(true)

      const categorySearchResponse = await apiRequest(
        request,
        'GET',
        `/api/catalog/categories?view=manage&pageSize=20&search=${encodeURIComponent(categoryName)}`,
        { token: adminToken },
      )
      expect(categorySearchResponse.status(), 'category created by internal API should be readable').toBe(200)
      const categoryList = await readJsonSafe<CatalogCategoryListBody>(categorySearchResponse)
      const createdCategory = categoryList?.items?.find((item) => item.name === categoryName)
      categoryId = createdCategory?.id ?? null
      expect(categoryId, 'CALL_OPEN_MERCATO should create the category through /api/catalog/categories').toBeTruthy()
    } finally {
      await deleteCatalogCategoryIfExists(request, adminToken, categoryId)
      await deleteBusinessRuleIfExists(request, adminToken, ruleId)
      await deleteGeneralEntityIfExists(request, adminToken, '/api/api_keys/keys', apiKeyProfileId)
      await cleanupBusinessRulesUser(request, adminToken, authorizedUserId, authorizedRoleId)
      await cleanupBusinessRulesUser(request, adminToken, limitedUserId, limitedRoleId)
      await deleteRoleIfExists(request, adminToken, profileRoleId)
    }
  })
})
