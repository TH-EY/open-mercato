import { resolveProjectPathnameId, resolveRouteId } from '../lib/route-id'

describe('projects route id resolution', () => {
  it('uses params when Next provides a route id', () => {
    expect(resolveRouteId('project-1')).toBe('project-1')
    expect(resolveRouteId(['project-1', 'ignored'])).toBe('project-1')
  })

  it('reads the project id from the virtual backend pathname', () => {
    expect(resolveProjectPathnameId('/backend/projects/2de98346-84c8-40cb-b7d8-9ea96ce47f97')).toBe(
      '2de98346-84c8-40cb-b7d8-9ea96ce47f97',
    )
    expect(resolveProjectPathnameId('/backend/projects/2de98346-84c8-40cb-b7d8-9ea96ce47f97/board')).toBe(
      '2de98346-84c8-40cb-b7d8-9ea96ce47f97',
    )
  })

  it('decodes encoded path segments and ignores collection paths', () => {
    expect(resolveProjectPathnameId('/backend/projects/project%20id')).toBe('project id')
    expect(resolveProjectPathnameId('/backend/projects')).toBeUndefined()
  })

  it('keeps nested non-board detail routes using the trailing id', () => {
    expect(resolveProjectPathnameId('/backend/projects/templates/template-1')).toBe('template-1')
    expect(resolveProjectPathnameId('/backend/projects/task-templates/task-template-1')).toBe('task-template-1')
  })
})
