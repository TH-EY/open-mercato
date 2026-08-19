const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export type FinooApplicationScope = { tenantId: string; organizationId: string }

export function resolveFinooApplicationScope(): FinooApplicationScope | null {
  const tenantId = process.env.OM_FINOO_APPLICATION_TENANT_ID?.trim() ?? ''
  const organizationId = process.env.OM_FINOO_APPLICATION_ORGANIZATION_ID?.trim() ?? ''
  return uuidPattern.test(tenantId) && uuidPattern.test(organizationId) ? { tenantId, organizationId } : null
}

export function isFinooApplicationScope(scope: FinooApplicationScope): boolean {
  const configured = resolveFinooApplicationScope()
  return configured?.tenantId === scope.tenantId && configured.organizationId === scope.organizationId
}
