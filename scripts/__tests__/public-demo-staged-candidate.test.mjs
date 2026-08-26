import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const verifier = path.resolve('scripts/public-demo/verify-staged-candidate.sh')
const reservationScript = path.resolve('scripts/public-demo/reserve-first-provision.sh')
const routingScript = path.resolve('scripts/public-demo/cutover-routing.sh')
const deploymentSha = 'a'.repeat(40)
const imageDigest = `sha256:${'b'.repeat(64)}`
const imageUri = `registry.example/openmercato@${imageDigest}`

function makeVerifierHarness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'public-demo-staged-'))
  const binDir = path.join(root, 'bin')
  const workdir = path.join(root, 'workdir')
  fs.mkdirSync(binDir)
  fs.mkdirSync(path.join(workdir, '.git'), { recursive: true })
  fs.writeFileSync(path.join(workdir, '.first-provision-owner'), `${deploymentSha}\n`, { mode: 0o600 })
  fs.writeFileSync(
    path.join(workdir, '.first-provision-staged'),
    `deployment_sha=${deploymentSha}\nimage_uri=${imageUri}\nimage_digest=${imageDigest}\n`,
    { mode: 0o600 },
  )
  fs.writeFileSync(path.join(binDir, 'git'), `#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == *"rev-parse HEAD"* ]]; then printf '%s\\n' "$EXPECTED_DEPLOYMENT_SHA"; exit 0; fi
if [[ "$*" == *"status --porcelain --untracked-files=no"* ]]; then exit 0; fi
exit 2
`, { mode: 0o755 })
  fs.writeFileSync(path.join(binDir, 'docker'), `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == ps ]]; then
  printf '%s\\n' app aws-credential-broker mcp meilisearch postgres redis worker
  exit 0
fi
if [[ "$1" == compose ]]; then
  printf '%s\\n' '{"services":{"app":{"image":"'"$EXPECTED_IMAGE_URI"'"},"aws-credential-broker":{"image":"'"$EXPECTED_IMAGE_URI"'"},"mcp":{"image":"'"$EXPECTED_IMAGE_URI"'"},"meilisearch":{"image":"'"$EXPECTED_IMAGE_URI"'"},"postgres":{"image":"'"$EXPECTED_IMAGE_URI"'"},"redis":{"image":"'"$EXPECTED_IMAGE_URI"'"},"worker":{"image":"'"$EXPECTED_IMAGE_URI"'"}}}'
  exit 0
fi
if [[ "$1" == inspect && "$*" == *".State.Running"* ]]; then printf '%s\\n' true; exit 0; fi
if [[ "$1" == inspect && "$*" == *".Config.Image"* ]]; then printf '%s\\n' "\${FAKE_IMAGE_URI:-$EXPECTED_IMAGE_URI}"; exit 0; fi
exit 2
`, { mode: 0o755 })
  fs.writeFileSync(path.join(binDir, 'curl'), `#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == *":4787/login"* ]]; then printf '%s' 200; else printf '%s' 200; fi
`, { mode: 0o755 })
  fs.writeFileSync(path.join(binDir, 'stat'), `#!/bin/sh
if [ "$1 $2" = "-c %a" ]; then printf '%s\\n' 600; exit 0; fi
exit 2
`, { mode: 0o755 })
  return { root, binDir, workdir }
}

function runVerifier(harness, extraEnv = {}) {
  return spawnSync('bash', [verifier], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${harness.binDir}:${process.env.PATH}`,
      PUBLIC_DEMO_WORKDIR: harness.workdir,
      EXPECTED_DEPLOYMENT_SHA: deploymentSha,
      EXPECTED_IMAGE_URI: imageUri,
      EXPECTED_IMAGE_DIGEST: imageDigest,
      ...extraEnv,
    },
  })
}

test('host verifier accepts only the exact staged SHA, image digest, service set, and probes', () => {
  const harness = makeVerifierHarness()
  try {
    const result = runVerifier(harness)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /exact approved SHA, image digest, services, and local probes/)
  } finally {
    fs.rmSync(harness.root, { recursive: true, force: true })
  }
})

test('host verifier rejects a cross-SHA staged marker and runtime image drift', () => {
  const harness = makeVerifierHarness()
  try {
    fs.writeFileSync(
      path.join(harness.workdir, '.first-provision-staged'),
      `deployment_sha=${'c'.repeat(40)}\nimage_uri=${imageUri}\nimage_digest=${imageDigest}\n`,
      { mode: 0o600 },
    )
    const crossSha = runVerifier(harness)
    assert.notEqual(crossSha.status, 0)
    assert.match(crossSha.stderr, /manifest does not match/)

    fs.writeFileSync(
      path.join(harness.workdir, '.first-provision-staged'),
      `deployment_sha=${deploymentSha}\nimage_uri=${imageUri}\nimage_digest=${imageDigest}\n`,
      { mode: 0o600 },
    )
    const imageDrift = runVerifier(harness, {
      FAKE_IMAGE_URI: `registry.example/openmercato@sha256:${'d'.repeat(64)}`,
    })
    assert.notEqual(imageDrift.status, 0)
    assert.match(imageDrift.stderr, /does not run the exact reviewed image/)
  } finally {
    fs.rmSync(harness.root, { recursive: true, force: true })
  }
})

test('cutover stops on failed host read-back before any AWS topology call', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'public-demo-cutover-gate-'))
  const binDir = path.join(root, 'bin')
  const callsFile = path.join(root, 'aws-calls')
  const failingRunner = path.join(root, 'failing-ssm-runner')
  fs.mkdirSync(binDir)
  fs.writeFileSync(path.join(binDir, 'aws'), `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_CALLS_FILE"
exit 2
`, { mode: 0o755 })
  fs.writeFileSync(failingRunner, '#!/bin/sh\ncat >/dev/null\nexit 42\n', { mode: 0o755 })
  try {
    const result = spawnSync('bash', [routingScript, 'cutover'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        FAKE_CALLS_FILE: callsFile,
        PUBLIC_DEMO_SSM_RUNNER: failingRunner,
        AWS_REGION: 'test-region-1',
        INSTANCE_ID: 'i-test',
        VPC_ID: 'vpc-test',
        LOAD_BALANCER_ARN: 'arn:test:load-balancer',
        LISTENER_ARN: 'arn:test:listener',
        LISTENER_SSL_POLICY: 'test-policy',
        LOAD_BALANCER_SECURITY_GROUP_ID: 'sg-test',
        EXPECTED_DEPLOYMENT_SHA: deploymentSha,
        EXPECTED_IMAGE_URI: imageUri,
        EXPECTED_IMAGE_DIGEST: imageDigest,
      },
    })
    assert.equal(result.status, 42)
    assert.equal(fs.existsSync(callsFile), false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

function makeReservationHarness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'public-demo-reservation-'))
  const binDir = path.join(root, 'bin')
  fs.mkdirSync(binDir)
  fs.writeFileSync(path.join(binDir, 'docker'), `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == ps ]]; then exit 0; fi
if [[ "$1 $2" == "volume inspect" ]]; then
  [[ "\${3:-}" == "\${FAKE_EXISTING_VOLUME:-}" ]] && exit 0
  exit 1
fi
if [[ "$1 $2 $3" == "network inspect public_demo_network" ]]; then
  [[ "\${FAKE_EXISTING_NETWORK:-0}" == 1 ]] && exit 0
  exit 1
fi
exit 2
`, { mode: 0o755 })
  fs.writeFileSync(path.join(binDir, 'ss'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  fs.writeFileSync(path.join(binDir, 'stat'), `#!/bin/sh
if [ "$1 $2" = "-c %a" ]; then printf '%s\\n' 600; exit 0; fi
exit 2
`, { mode: 0o755 })
  return { root, binDir, workdir: path.join(root, 'openmercato-public-demo') }
}

function runReservation(harness, sha = deploymentSha, extraEnv = {}) {
  return spawnSync('bash', [reservationScript], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${harness.binDir}:${process.env.PATH}`,
      PUBLIC_DEMO_WORKDIR: harness.workdir,
      DEPLOYMENT_SHA: sha,
      ...extraEnv,
    },
  })
}

test('first-provision reservation supports only same-SHA recovery', () => {
  const harness = makeReservationHarness()
  try {
    const first = runReservation(harness)
    assert.equal(first.status, 0, first.stderr)
    assert.equal(
      fs.readFileSync(path.join(harness.workdir, '.first-provision-owner'), 'utf8'),
      `${deploymentSha}\n`,
    )

    const sameSha = runReservation(harness)
    assert.equal(sameSha.status, 0, sameSha.stderr)
    assert.match(sameSha.stdout, /Same-SHA first-provision recovery admitted/)

    const crossSha = runReservation(harness, 'c'.repeat(40))
    assert.notEqual(crossSha.status, 0)
    assert.match(crossSha.stderr, /belongs to a different deployment SHA/)
  } finally {
    fs.rmSync(harness.root, { recursive: true, force: true })
  }
})

test('first-provision reservation rejects orphaned named storage and network state', () => {
  for (const extraEnv of [
    { FAKE_EXISTING_VOLUME: 'public_demo_postgres_data' },
    { FAKE_EXISTING_NETWORK: '1' },
  ]) {
    const harness = makeReservationHarness()
    try {
      const result = runReservation(harness, deploymentSha, extraEnv)
      assert.notEqual(result.status, 0)
      assert.match(result.stderr, /exists without an exact owner marker/)
      assert.equal(fs.existsSync(harness.workdir), false)
    } finally {
      fs.rmSync(harness.root, { recursive: true, force: true })
    }
  }
})
