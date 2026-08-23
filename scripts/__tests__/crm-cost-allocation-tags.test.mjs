import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const ENVIRONMENT_PATH = path.resolve(
  ROOT,
  'infra/terraform/environments/crm-they-dev/main.tf',
)

test('CRM Terraform provider preserves canonical cost allocation tags', () => {
  const terraform = fs.readFileSync(ENVIRONMENT_PATH, 'utf8')

  for (const [key, value] of Object.entries({
    Project: 'open-mercato',
    Environment: 'production',
    Workload: 'crm',
    Owner: 'they.dev',
    ManagedBy: 'terraform',
    Lifecycle: 'permanent',
  })) {
    assert.match(
      terraform,
      new RegExp(`^\\s*${key}\\s*=\\s*"${value}"$`, 'm'),
      `default_tags must preserve ${key}=${value}`,
    )
  }

  assert.doesNotMatch(terraform, /^\s*Environment\s*=\s*"crm-they-dev"$/m)
  assert.doesNotMatch(terraform, /^\s*Owner\s*=\s*"THEY"$/m)
})
