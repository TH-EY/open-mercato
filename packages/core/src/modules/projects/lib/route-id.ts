export function resolveRouteId(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0]
  return value
}

export function resolveProjectPathnameId(pathname: string): string | undefined {
  const parts = pathname.split('/').filter(Boolean)
  const projectId = parts.at(-1)
  if (!projectId || projectId === 'projects' || projectId === 'backend') return undefined
  return decodeURIComponent(projectId)
}
