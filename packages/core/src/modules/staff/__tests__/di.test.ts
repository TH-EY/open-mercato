/** @jest-environment node */

import type { EntityManager } from '@mikro-orm/postgresql'
import { asValue, createContainer, InjectionMode } from 'awilix'
import { register } from '../di'
import type { StaffMemberDirectory } from '../services/staffMemberDirectory'

describe('staff/di — availabilityAccessResolver registration', () => {
  it('registers the availabilityAccessResolver token with a resolveAvailabilityWriteAccess method', () => {
    const container = createContainer({ injectionMode: InjectionMode.PROXY })
    register(container)
    expect(container.hasRegistration('availabilityAccessResolver')).toBe(true)
    const resolver = container.resolve<{
      resolveAvailabilityWriteAccess: unknown
    }>('availabilityAccessResolver')
    expect(typeof resolver.resolveAvailabilityWriteAccess).toBe('function')
  })

  it('registers the staffMemberDirectory token with a listActiveSchedulingRefs method', () => {
    const container = createContainer({ injectionMode: InjectionMode.PROXY })
    container.register({ em: asValue({} as EntityManager) })
    register(container)
    expect(container.hasRegistration('staffMemberDirectory')).toBe(true)
    const directory = container.resolve<StaffMemberDirectory>('staffMemberDirectory')
    expect(typeof directory.listActiveSchedulingRefs).toBe('function')
  })

  it('returns undefined (not throws) when consumer uses allowUnregistered on a container without staff', () => {
    const container = createContainer({ injectionMode: InjectionMode.PROXY })
    const availabilityAccessResolver = container.resolve('availabilityAccessResolver', {
      allowUnregistered: true,
    })
    const staffMemberDirectory = container.resolve('staffMemberDirectory', {
      allowUnregistered: true,
    })
    expect(availabilityAccessResolver).toBeUndefined()
    expect(staffMemberDirectory).toBeUndefined()
  })
})
