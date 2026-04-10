import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { readSyncExcelUploadBuffer } from '../upload-storage'

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

  it('reads CSV payload from attachment metadata when an inline copy is persisted for worker-safe imports', async () => {
    const readFileSpy = jest.spyOn(fs, 'readFile')

    const buffer = await readSyncExcelUploadBuffer({
      partitionCode: 'privateAttachments',
      storagePath: 'org_1/tenant_1/Leads.csv',
      storageDriver: 'local',
      storageMetadata: {
        inlineCsvBase64: Buffer.from('Record Id,Email\next-1,ada@example.com\n', 'utf8').toString('base64'),
      },
    } as any)

    expect(buffer.toString('utf8')).toBe('Record Id,Email\next-1,ada@example.com\n')
    expect(readFileSpy).not.toHaveBeenCalled()
  })

  it('wraps missing-file errors with runtime storage guidance when no inline payload is available', async () => {
    await expect(readSyncExcelUploadBuffer({
      partitionCode: 'privateAttachments',
      storagePath: 'org_1/tenant_1/Leads.csv',
      storageDriver: 'local',
      storageMetadata: null,
    } as any)).rejects.toThrow(
      'Ensure all runtimes that execute sync_excel imports share attachment storage for partition "privateAttachments".',
    )
  })

  it('returns the file buffer when the attachment exists on disk for legacy uploads', async () => {
    const tempFile = path.join(os.tmpdir(), `sync-excel-upload-storage-${Date.now()}.csv`)
    await fs.writeFile(tempFile, Buffer.from('csv-data'))
    mockResolveAttachmentAbsolutePath.mockReturnValue(tempFile)

    await expect(readSyncExcelUploadBuffer({
      partitionCode: 'privateAttachments',
      storagePath: 'org_1/tenant_1/Leads.csv',
      storageDriver: 'local',
      storageMetadata: null,
    } as any)).resolves.toEqual(Buffer.from('csv-data'))

    await fs.unlink(tempFile)
  })
})
