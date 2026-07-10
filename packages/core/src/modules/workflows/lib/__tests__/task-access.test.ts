import type { UserTask } from '../../data/entities'
import {
  canActorClaimTask,
  canActorCompleteTask,
  isTaskVisibleToActor,
} from '../task-access'

function task(overrides: Partial<UserTask> = {}): UserTask {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    status: 'PENDING',
    assignedTo: null,
    assignedToRoles: ['Sales'],
    claimedBy: null,
    completedBy: null,
    ...overrides,
  } as UserTask
}

describe('workflow user task access', () => {
  const salesActor = { userId: 'user-a', roles: ['Sales'] }

  it('shows an unclaimed role task to a matching candidate', () => {
    const candidateTask = task()
    expect(isTaskVisibleToActor(candidateTask, salesActor)).toBe(true)
    expect(canActorClaimTask(candidateTask, salesActor)).toBe(true)
    expect(canActorCompleteTask(candidateTask, salesActor)).toBe(false)
  })

  it('hides a role task after another candidate claims it', () => {
    const claimedTask = task({ status: 'IN_PROGRESS', claimedBy: 'user-b' })
    expect(isTaskVisibleToActor(claimedTask, salesActor)).toBe(false)
    expect(canActorClaimTask(claimedTask, salesActor)).toBe(false)
    expect(canActorCompleteTask(claimedTask, salesActor)).toBe(false)
  })

  it('allows only the claimant to complete a role task', () => {
    const claimedTask = task({ status: 'IN_PROGRESS', claimedBy: 'user-a' })
    expect(isTaskVisibleToActor(claimedTask, salesActor)).toBe(true)
    expect(canActorCompleteTask(claimedTask, salesActor)).toBe(true)
    expect(canActorCompleteTask(claimedTask, { userId: 'user-b', roles: ['Sales'] })).toBe(false)
  })

  it('allows a direct assignee to complete without claiming', () => {
    const directTask = task({ assignedTo: 'user-a', assignedToRoles: null })
    expect(canActorClaimTask(directTask, salesActor)).toBe(false)
    expect(canActorCompleteTask(directTask, salesActor)).toBe(true)
  })

  it('never allows terminal tasks to be mutated', () => {
    const completedTask = task({
      status: 'COMPLETED',
      assignedTo: 'user-a',
      assignedToRoles: null,
      completedBy: 'user-a',
    })
    expect(isTaskVisibleToActor(completedTask, salesActor)).toBe(true)
    expect(canActorClaimTask(completedTask, salesActor)).toBe(false)
    expect(canActorCompleteTask(completedTask, salesActor)).toBe(false)
  })
})
