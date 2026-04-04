export const DEFAULT_DATA_SYNC_BATCH_SIZE = 100
export const DEFAULT_SYNC_EXCEL_BATCH_SIZE = 25

export function resolveDefaultDataSyncBatchSize(integrationId?: string | null): number {
  if (integrationId === 'sync_excel') {
    return DEFAULT_SYNC_EXCEL_BATCH_SIZE
  }
  return DEFAULT_DATA_SYNC_BATCH_SIZE
}
