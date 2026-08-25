import { llmProviderRegistry } from '@open-mercato/shared/lib/ai/llm-provider-registry'
import type { NextRequest } from 'next/server'
import {
  resetAgentRegistryForTests,
  seedAgentRegistryForTests,
} from '../../../../lib/agent-registry'
import { resetLlmBootstrapState } from '../../../../lib/llm-bootstrap'

const authMock = jest.fn()
const loadAclMock = jest.fn()
const createRequestContainerMock = jest.fn()

jest.mock('@open-mercato/shared/lib/auth/server', () => ({
  getAuthFromRequest: (...args: unknown[]) => authMock(...args),
}))

jest.mock('@open-mercato/shared/lib/di/container', () => ({
  createRequestContainer: (...args: unknown[]) => createRequestContainerMock(...args),
}))

import { GET } from '../route'

describe('GET /api/ai_assistant/ai/agents', () => {
  const originalOpenRouterApiKey = process.env.OPENROUTER_API_KEY

  beforeEach(() => {
    jest.clearAllMocks()
    llmProviderRegistry.reset()
    resetLlmBootstrapState()
    resetAgentRegistryForTests()
    process.env.OPENROUTER_API_KEY = 'test-openrouter-key'
    authMock.mockResolvedValue({
      sub: 'user-1',
      tenantId: 'tenant-1',
      orgId: 'org-1',
    })
    loadAclMock.mockResolvedValue({
      features: ['ai_assistant.view'],
      isSuperAdmin: false,
    })
    createRequestContainerMock.mockResolvedValue({
      resolve: (name: string) => {
        if (name === 'rbacService') return { loadAcl: loadAclMock }
        return null
      },
    })
    seedAgentRegistryForTests([
      {
        id: 'catalog.catalog_assistant',
        moduleId: 'catalog',
        label: 'Catalog Assistant',
        description: 'Catalog test assistant',
        systemPrompt: 'You are a catalog assistant.',
        allowedTools: [],
        requiredFeatures: ['ai_assistant.view'],
      },
    ])
  })

  afterEach(() => {
    if (originalOpenRouterApiKey === undefined) {
      delete process.env.OPENROUTER_API_KEY
    } else {
      process.env.OPENROUTER_API_KEY = originalOpenRouterApiKey
    }
  })

  afterAll(() => {
    llmProviderRegistry.reset()
    resetLlmBootstrapState()
    resetAgentRegistryForTests()
  })

  it('reports AI configured on a cold request when OpenRouter is configured', async () => {
    const response = await GET(
      new Request('http://localhost/api/ai_assistant/ai/agents') as NextRequest,
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      aiConfigured: true,
      total: 1,
    })

    const openRouter = llmProviderRegistry.get('openrouter')
    expect(openRouter).not.toBeNull()
    expect(openRouter?.isConfigured(process.env)).toBe(true)
  })
})
