export function resolveRouteId(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0]
  return value
}

export function resolveProjectPathnameId(pathname: string): string | undefined {
  const parts = pathname.split('/').filter(Boolean)
  const projectsIndex = parts.indexOf('projects')
  const projectId = parts.at(-1) === 'board' && projectsIndex >= 0 ? parts[projectsIndex + 1] : parts.at(-1)
  if (!projectId || projectId === 'projects' || projectId === 'backend') return undefined
  return decodeURIComponent(projectId)
}
