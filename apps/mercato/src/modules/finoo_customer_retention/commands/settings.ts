import { z } from 'zod'
import type { CommandHandler, CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import { registerCommand } from '@open-mercato/shared/lib/commands'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import {
  finooCustomerRetentionPreviewSchema,
  finooCustomerRetentionWindowSchema,
} from '../data/validators'
import type {
  FinooCustomerRetentionSettingsService,
  RetentionPreviewView,
  RetentionSettingView,
} from '../services/settingsService'
import { retentionSettingsInternals } from '../services/settingsService'

const scopeSchema = z.object({
  tenantId: z.string().uuid(),
  organizationId: z.string().uuid(),
})

const previewCommandSchema = scopeSchema.extend({
  inactivityWindowDays: finooCustomerRetentionPreviewSchema.shape.inactivityWindowDays,
})

const updateCommandSchema = scopeSchema.extend({
  inactivityWindowDays: finooCustomerRetentionWindowSchema,
  previewTokenHash: z.string().length(64).optional(),
  actorUserId: z.string().nullable(),
})

type PreviewCommandInput = z.infer<typeof previewCommandSchema>
type UpdateCommandInput = z.infer<typeof updateCommandSchema>

type PreviewCommandResult = RetentionPreviewView
type UpdateCommandResult = {
  settingId: string
  setting: RetentionSettingView
  progressJobId: string
}

function service(ctx: CommandRuntimeContext) {
  return ctx.container.resolve<FinooCustomerRetentionSettingsService>(
    'finooCustomerRetentionSettingsService',
  )
}

function assertScope(
  input: { tenantId: string; organizationId: string },
  ctx: CommandRuntimeContext,
): void {
  if (ctx.auth?.tenantId !== input.tenantId) {
    throw new Error('[internal] Retention command tenant scope mismatch')
  }
  const organizationId = ctx.selectedOrganizationId ?? ctx.auth?.orgId ?? null
  if (organizationId !== input.organizationId) {
    throw new Error('[internal] Retention command organization scope mismatch')
  }
}

const previewSettingsCommand: CommandHandler<PreviewCommandInput, PreviewCommandResult> = {
  id: 'finoo_customer_retention.settings.preview',
  isUndoable: true,
  async execute(rawInput, ctx) {
    const input = previewCommandSchema.parse(rawInput)
    assertScope(input, ctx)
    return service(ctx).preview({
      ...input,
      httpRequest: ctx.request,
    })
  },
  captureAfter(input, result) {
    const parsed = previewCommandSchema.parse(input)
    const previewTokenHash = retentionSettingsInternals.hashPreviewToken(result.token)
    return {
      tenantId: parsed.tenantId,
      organizationId: parsed.organizationId,
      settingId: result.settingId,
      previewTokenHash,
      updatedAt: result.updatedAt,
      inactivityWindowDays: parsed.inactivityWindowDays,
      totalEligible: result.totalEligible,
      newlyExpired: result.newlyExpired,
      alreadyExpired: result.alreadyExpired,
    }
  },
  async buildLog({ input, result }) {
    const { translate } = await resolveTranslations()
    const previewTokenHash = retentionSettingsInternals.hashPreviewToken(result.token)
    return {
      actionLabel: translate(
        'finooCustomerRetention.audit.preview',
        'Preview customer retention setting change',
      ),
      resourceKind: 'finoo_customer_retention.settings',
      resourceId: result.settingId,
      tenantId: input.tenantId,
      organizationId: input.organizationId,
      snapshotAfter: {
        inactivityWindowDays: input.inactivityWindowDays,
        previewTokenHash,
        updatedAt: result.updatedAt,
        totalEligible: result.totalEligible,
        newlyExpired: result.newlyExpired,
        alreadyExpired: result.alreadyExpired,
      },
    }
  },
  async undo({ logEntry, ctx }) {
    const snapshot = logEntry.snapshotAfter as {
      previewTokenHash?: unknown
      updatedAt?: unknown
    } | null
    const previewTokenHash = typeof snapshot?.previewTokenHash === 'string'
      ? snapshot.previewTokenHash
      : null
    const updatedAt = typeof snapshot?.updatedAt === 'string' ? snapshot.updatedAt : null
    const tenantId = typeof logEntry.tenantId === 'string' ? logEntry.tenantId : null
    const organizationId = typeof logEntry.organizationId === 'string'
      ? logEntry.organizationId
      : null
    if (!previewTokenHash || !updatedAt || !tenantId || !organizationId) return
    await service(ctx).clearPreviewIfCurrent({
      tenantId,
      organizationId,
      previewTokenHash,
      updatedAt,
    })
  },
}

const updateSettingsCommand: CommandHandler<UpdateCommandInput, UpdateCommandResult> = {
  id: 'finoo_customer_retention.settings.update',
  isUndoable: false,
  async prepare(rawInput, ctx) {
    const input = updateCommandSchema.parse(rawInput)
    assertScope(input, ctx)
    return {
      before: await service(ctx).get({
        tenantId: input.tenantId,
        organizationId: input.organizationId,
      }),
    }
  },
  async execute(rawInput, ctx) {
    const input = updateCommandSchema.parse(rawInput)
    assertScope(input, ctx)
    return service(ctx).update({
      ...input,
      httpRequest: ctx.request,
    })
  },
  captureAfter(_input, result) {
    return result.setting
  },
  async buildLog({ input, result, snapshots }) {
    const { translate } = await resolveTranslations()
    return {
      actionLabel: translate(
        'finooCustomerRetention.audit.update',
        'Update customer retention settings',
      ),
      resourceKind: 'finoo_customer_retention.settings',
      resourceId: result.settingId,
      tenantId: input.tenantId,
      organizationId: input.organizationId,
      snapshotBefore: snapshots.before,
      snapshotAfter: result.setting,
    }
  },
}

registerCommand(previewSettingsCommand)
registerCommand(updateSettingsCommand)
