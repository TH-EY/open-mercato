import type { ApiRouteManifestEntry } from '../registry'

const GLOBAL_KEY = '__openMercatoApiRouteManifestsRegistry__'

function clearGlobalRegistry(): void {
  delete (globalThis as typeof globalThis & Record<string, unknown>)[GLOBAL_KEY]
}

function clearRegistryModuleCache(): void {
  const registryPath = /packages\/shared\/src\/modules\/registry\.ts$/
  for (const key of Object.keys(require.cache)) {
    if (registryPath.test(key)) delete require.cache[key]
  }
}

function loadRegistry(): typeof import('../registry') {
  clearRegistryModuleCache()
  return require('../registry') as typeof import('../registry')
}

describe('API route manifest registry', () => {
  const routes: ApiRouteManifestEntry[] = [
    {
      moduleId: 'workflows',
      path: '/api/workflows/endpoints',
      methods: ['GET'],
      load: async () => ({}),
    },
  ]

  beforeEach(clearGlobalRegistry)

  afterEach(() => {
    clearGlobalRegistry()
    clearRegistryModuleCache()
  })

  it('returns registered manifests from the same module instance', () => {
    const registry = loadRegistry()
    registry.registerApiRouteManifests(routes)
    expect(registry.getApiRouteManifests()).toEqual(routes)
  })

  it('survives module duplication between the catch-all route and a lazy API handler', () => {
    const catchAllRegistry = loadRegistry()
    catchAllRegistry.registerApiRouteManifests(routes)

    const lazyHandlerRegistry = loadRegistry()
    expect(lazyHandlerRegistry.getApiRouteManifests()).toEqual(routes)
  })
})
