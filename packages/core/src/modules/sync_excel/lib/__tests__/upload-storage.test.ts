import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'

const mockResolveAttachmentAbsolutePath = jest.fn()

jest.mock('../../../attachments/lib/storage', () => ({
  resolveAttachmentAbsolutePath: (...args: unknown[]) => mockResolveAttachmentAbsolutePath(...args),
}))

jest.mock('../../../attachments/data/entities', () => ({
  Attachment: class Attachment {},
  AttachmentPartition: class AttachmentPartition {},
}))

jest.mock('../../../attachments/lib/partitions', () => ({
  ensureDefaultPartitions: jest.fn(async () => undefined),
}))

jest.mock('../../../attachments/lib/imageUrls', () => ({
  buildAttachmentFileUrl: jest.fn(() => '/attachments/test'),
}))

describe('sync_excel upload storage', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockResolveAttachmentAbsolutePath.mockReturnValue('/app/apps/mercato/storage/attachments/privateAttachments/org_1/tenant_1/Leads.csv')
  })

  it('wraps missing-file errors with runtime storage guidance', async () => {
    const { readSyncExcelUploadBuffer } = await import('../upload-storage')

    await expect(readSyncExcelUploadBuffer({
      id: 'attachment-1',
      partitionCode: 'privateAttachments',
      storagePath: 'org_1/tenant_1/Leads.csv',
      storageDriver: 'local',
    } as any)).rejects.toThrow(
      'Ensure all runtimes that execute sync_excel imports share attachment storage for partition "privateAttachments".',
    )
  })

  it('returns the file buffer when the attachment exists on disk', async () => {
    const tempFile = path.join(os.tmpdir(), `sync-excel-upload-storage-${Date.now()}.csv`)
    await fs.writeFile(tempFile, Buffer.from('csv-data'))
    mockResolveAttachmentAbsolutePath.mockReturnValue(tempFile)

    const { readSyncExcelUploadBuffer } = await import('../upload-storage')

    await expect(readSyncExcelUploadBuffer({
      id: 'attachment-1',
      partitionCode: 'privateAttachments',
      storagePath: 'org_1/tenant_1/Leads.csv',
      storageDriver: 'local',
    } as any)).resolves.toEqual(Buffer.from('csv-data'))

    await fs.unlink(tempFile)
  })
})
