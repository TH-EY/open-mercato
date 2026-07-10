import type { FilterQuery } from '@mikro-orm/core'
import type { UserTask } from '../data/entities'

export type UserTaskActor = {
  userId: string
  roles: string[]
}

/**
 * Personal task predicate shared by inbox and detail APIs.
 *
 * Role candidates can see only unclaimed queue work. Once claimed, the task is
 * private to its claimant. Direct and historical ownership remain visible to
 * the responsible user.
 */
export function buildPersonalTaskFilter(actor: UserTaskActor): FilterQuery<UserTask> {
  const alternatives: FilterQuery<UserTask>[] = [
    { assignedTo: actor.userId },
    { claimedBy: actor.userId },
    { completedBy: actor.userId },
  ]

  if (actor.roles.length > 0) {
    alternatives.push({
      assignedTo: null,
      claimedBy: null,
      status: 'PENDING',
      assignedToRoles: { $overlap: actor.roles },
    })
  }

  return {
    $or: alternatives,
  }
}

export function isTaskVisibleToActor(task: UserTask, actor: UserTaskActor): boolean {
  if (task.assignedTo === actor.userId || task.claimedBy === actor.userId || task.completedBy === actor.userId) {
    return true
  }

  return task.status === 'PENDING'
    && !task.assignedTo
    && !task.claimedBy
    && (task.assignedToRoles ?? []).some((role) => actor.roles.includes(role))
}

export function canActorClaimTask(task: UserTask, actor: UserTaskActor): boolean {
  return task.status === 'PENDING'
    && !task.assignedTo
    && !task.claimedBy
    && (task.assignedToRoles ?? []).some((role) => actor.roles.includes(role))
}

export function canActorCompleteTask(task: UserTask, actor: UserTaskActor): boolean {
  if (task.status !== 'PENDING' && task.status !== 'IN_PROGRESS') return false
  if (task.assignedTo) return task.assignedTo === actor.userId
  return task.status === 'IN_PROGRESS' && task.claimedBy === actor.userId
}
