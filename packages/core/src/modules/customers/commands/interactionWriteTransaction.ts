import type { EntityManager } from '@mikro-orm/postgresql'
import type { CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import type {
  InteractionCreateInput,
  InteractionUpdateInput,
} from '../data/validators'

/**
 * Internal, local-execution-only seam for a caller that must validate a claim
 * inside the interaction command's own persistence transaction.
 *
 * The symbol-keyed callback is deliberately non-enumerable and is never part
 * of command input, audit payloads, redo data, or any serialized contract.
 * Ordinary command callers do not attach it and retain the existing behavior.
 *
 * @internal
 */
const INTERNAL_INTERACTION_WRITE_TRANSACTION_HOOK = Symbol.for(
  'open-mercato.customers.internal-interaction-write-transaction-hook',
)

export type InternalInteractionWriteTransactionHook = (params: {
  em: EntityManager
  operation: 'create' | 'update'
  input: InteractionCreateInput | InteractionUpdateInput
}) => Promise<void>

type ContextWithInternalHook = CommandRuntimeContext & {
  [INTERNAL_INTERACTION_WRITE_TRANSACTION_HOOK]?: InternalInteractionWriteTransactionHook
}

/** @internal */
export function attachInternalInteractionWriteTransactionHook<
  TContext extends CommandRuntimeContext,
>(ctx: TContext, hook: InternalInteractionWriteTransactionHook): TContext {
  Object.defineProperty(ctx, INTERNAL_INTERACTION_WRITE_TRANSACTION_HOOK, {
    configurable: true,
    enumerable: false,
    value: hook,
  })
  return ctx
}

/** @internal */
export async function runInternalInteractionWriteTransactionHook(
  ctx: CommandRuntimeContext,
  params: Parameters<InternalInteractionWriteTransactionHook>[0],
): Promise<void> {
  const hook = (ctx as ContextWithInternalHook)[
    INTERNAL_INTERACTION_WRITE_TRANSACTION_HOOK
  ]
  if (hook) await hook(params)
}
