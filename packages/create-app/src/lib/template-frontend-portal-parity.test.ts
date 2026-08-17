import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

function readSource(relativeUrl: string): string {
  return fs.readFileSync(new URL(relativeUrl, import.meta.url), 'utf8')
}

test('standalone template mirrors the main app frontend portal catch-all and its regression coverage', () => {
  const sourcePairs = [
    [
      '../../template/src/app/(frontend)/[...slug]/page.tsx',
      '../../../../apps/mercato/src/app/(frontend)/[...slug]/page.tsx',
    ],
    [
      '../../template/src/app/(frontend)/__tests__/portal-org-binding.test.tsx',
      '../../../../apps/mercato/src/app/(frontend)/__tests__/portal-org-binding.test.tsx',
    ],
  ]

  for (const [templatePath, mainAppPath] of sourcePairs) {
    assert.equal(
      readSource(templatePath),
      readSource(mainAppPath),
      `${templatePath} drifted from ${mainAppPath}`,
    )
  }
})
