import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const scriptPaths = [
  'docker/scripts/init-or-migrate.sh',
  'packages/create-app/template/docker/scripts/init-or-migrate.sh',
]

test('production image installs the Resend and SES provider workspaces', () => {
  const source = fs.readFileSync(path.resolve('Dockerfile'), 'utf8')
  for (const provider of ['channel-resend', 'channel-ses']) {
    const manifest = `packages/${provider}/package.json`
    assert.equal(source.split(manifest).length - 1, 3)
  }
})

test('existing Resend deployments bootstrap provider state after migrations', () => {
  for (const scriptPath of scriptPaths) {
    const source = fs.readFileSync(path.resolve(scriptPath), 'utf8')
    assert.match(source, /SYSTEM_EMAIL_PROVIDER:-resend/)
    assert.match(source, /yarn mercato seed:defaults --module channel_resend/)
    assert.match(source, /run_subsequent_provider_upgrade/)
    assert.ok(
      source.indexOf('run_subsequent_provider_upgrade\n  exit $?')
        > source.indexOf('run_command_with_cli_recovery "${MIGRATE_COMMAND}"'),
    )
  }
})

test('existing Resend deployment startup fails closed when provider bootstrap fails', async () => {
  const temporaryDirectory = fs.mkdtempSync(path.join('/tmp', 'open-mercato-email-upgrade-'))
  const markerPath = path.join(temporaryDirectory, 'marker')
  const migrateCommand = path.join(temporaryDirectory, 'migrate.sh')
  const failingSeedCommand = path.join(temporaryDirectory, 'seed.sh')
  fs.writeFileSync(migrateCommand, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
  fs.writeFileSync(failingSeedCommand, '#!/bin/sh\nexit 42\n', { mode: 0o700 })
  fs.writeFileSync(markerPath, '')

  const { spawn } = await import('node:child_process')
  const status = await new Promise((resolve) => {
    const child = spawn('sh', ['docker/scripts/init-or-migrate.sh'], {
      cwd: path.resolve('.'),
      env: {
        ...process.env,
        INIT_MARKER_FILE: markerPath,
        MIGRATE_COMMAND: migrateCommand,
        RESEND_UPGRADE_COMMAND: failingSeedCommand,
        SYSTEM_EMAIL_PROVIDER: 'resend',
      },
      stdio: 'ignore',
    })
    child.on('exit', resolve)
  })

  fs.rmSync(temporaryDirectory, { recursive: true, force: true })
  assert.equal(status, 42)
})
