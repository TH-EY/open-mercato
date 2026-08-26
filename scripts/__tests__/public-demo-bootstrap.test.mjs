import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const bootstrapScript = path.resolve('scripts/public-demo/init-or-migrate.sh')
const bootstrapStateHelper = path.resolve('scripts/public-demo/bootstrap-state.mjs')

function makeHarness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'public-demo-bootstrap-'))
  const binDir = path.join(root, 'bin')
  const markerDir = path.join(root, 'marker')
  const callsFile = path.join(root, 'calls.log')
  fs.mkdirSync(binDir)
  fs.mkdirSync(markerDir)
  fs.writeFileSync(callsFile, '')

  fs.writeFileSync(
    path.join(binDir, 'yarn'),
    `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_CALLS_FILE"
if [ "\${FAIL_ON_INIT:-}" = "1" ] && [ "$*" = "mercato init --no-examples" ]; then
  touch "$FAKE_INIT_FAILURE_MARKER"
  echo 'Password: should-never-escape' >&2
  exit 1
fi
if [ "$*" = "mercato init --no-examples" ]; then
  touch "$FAKE_INIT_SUCCESS_MARKER"
fi
if [ -n "\${FAIL_ON_COMMAND:-}" ] && [ "$*" = "\${FAIL_ON_COMMAND}" ]; then
  echo 'Password: post-init-secret' >&2
  exit 1
fi
exit 0
`,
    { mode: 0o755 },
  )

  fs.writeFileSync(
    path.join(binDir, 'node'),
    `#!/bin/sh
case "$*" in
  *"bootstrap-state.mjs lock "*)
    for last_argument in "$@"; do :; done
    printf '%s\\n' ready > "$last_argument"
    trap 'exit 0' HUP INT TERM
    while :; do sleep 1; done
    ;;
  *"bootstrap-state.mjs probe "*)
    state="\${FAKE_BOOTSTRAP_STATE:-empty}"
    if [ -f "$FAKE_INIT_SUCCESS_MARKER" ]; then
      state="\${FAKE_STATE_AFTER_INIT_SUCCESS:-initialized}"
    elif [ -f "$FAKE_INIT_FAILURE_MARKER" ]; then
      state="\${FAKE_STATE_AFTER_INIT_FAILURE:-$state}"
    fi
    printf '%s\\n' "$state"
    ;;
  *)
    program="$(cat)"
    if printf '%s' "$program" | grep -q randomUUID; then
      printf '%s\\n' '33333333-3333-4333-8333-333333333333'
    elif [ "$#" -eq 2 ]; then
      printf '%s\\n' '11111111-1111-4111-8111-111111111111 22222222-2222-4222-8222-222222222222'
    fi
    ;;
esac
`,
    { mode: 0o755 },
  )

  return { root, binDir, markerDir, callsFile }
}

function runBootstrap(harness, extraEnv = {}) {
  return spawnSync('sh', [bootstrapScript], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${harness.binDir}:${process.env.PATH}`,
      PUBLIC_DEMO_INIT_MARKER_DIR: harness.markerDir,
      PUBLIC_DEMO_BOOTSTRAP_STATE_HELPER: bootstrapStateHelper,
      FAKE_CALLS_FILE: harness.callsFile,
      FAKE_INIT_FAILURE_MARKER: path.join(harness.root, 'init-failed'),
      FAKE_INIT_SUCCESS_MARKER: path.join(harness.root, 'init-succeeded'),
      DEPLOYMENT_SHA: 'a'.repeat(40),
      DATABASE_URL: 'postgresql://placeholder',
      ...extraEnv,
    },
  })
}

test('first bootstrap and restart converge without exposing protected command output', () => {
  const harness = makeHarness()
  try {
    const first = runBootstrap(harness)
    assert.equal(first.status, 0, first.stderr)
    assert.match(first.stdout, /first public-demo initialization/)
    assert.match(first.stdout, /bootstrap and read-back passed/)
    assert.doesNotMatch(`${first.stdout}\n${first.stderr}`, /Password:/)
    assert.equal(fs.readFileSync(path.join(harness.markerDir, '.seeded-v1'), 'utf8'), `${'a'.repeat(40)}\n`)
    assert.equal(fs.readFileSync(path.join(harness.markerDir, '.initialized-v1'), 'utf8'), `${'a'.repeat(40)}\n`)
    assert.equal(fs.existsSync(path.join(harness.markerDir, '.bootstrap.log')), false)

    const firstCalls = fs.readFileSync(harness.callsFile, 'utf8')
    assert.match(firstCalls, /^mercato init --no-examples$/m)
    assert.match(firstCalls, /^mercato customers seed-examples --tenant /m)
    assert.match(firstCalls, /^mercato catalog seed-examples-bundle --tenant /m)

    const second = runBootstrap(harness)
    assert.equal(second.status, 0, second.stderr)
    assert.match(second.stdout, /public-demo migrations and convergence/)
    const allCalls = fs.readFileSync(harness.callsFile, 'utf8')
    assert.match(allCalls, /^db:migrate$/m)
  } finally {
    fs.rmSync(harness.root, { recursive: true, force: true })
  }
})

test('failed initialization preserves the empty database and converges on retry', () => {
  const harness = makeHarness()
  try {
    const result = runBootstrap(harness, { FAIL_ON_INIT: '1' })
    assert.notEqual(result.status, 0)
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /should-never-escape|Password:/)
    assert.equal(fs.existsSync(path.join(harness.markerDir, '.seeded-v1')), false)
    assert.equal(fs.existsSync(path.join(harness.markerDir, '.initialized-v1')), false)
    assert.equal(fs.existsSync(path.join(harness.markerDir, '.bootstrap.log')), false)
    assert.doesNotMatch(fs.readFileSync(harness.callsFile, 'utf8'), /reset-empty/)

    const retry = runBootstrap(harness)
    assert.equal(retry.status, 0, retry.stderr)
    assert.equal(fs.readFileSync(harness.callsFile, 'utf8').match(/^mercato init --no-examples$/gm)?.length, 2)
    assert.equal(fs.existsSync(path.join(harness.markerDir, '.initialized-v1')), true)
  } finally {
    fs.rmSync(harness.root, { recursive: true, force: true })
  }
})

test('a post-init failure resumes from migrations without rerunning init', () => {
  const harness = makeHarness()
  try {
    const interrupted = runBootstrap(harness, { FAIL_ON_COMMAND: 'seed:defaults' })
    assert.notEqual(interrupted.status, 0)
    assert.equal(fs.existsSync(path.join(harness.markerDir, '.initialized-v1')), true)
    assert.equal(fs.existsSync(path.join(harness.markerDir, '.seeded-v1')), false)
    assert.doesNotMatch(`${interrupted.stdout}\n${interrupted.stderr}`, /post-init-secret|Password:/)

    const resumed = runBootstrap(harness)
    assert.equal(resumed.status, 0, resumed.stderr)
    assert.match(resumed.stdout, /public-demo migrations and convergence/)
    const calls = fs.readFileSync(harness.callsFile, 'utf8')
    assert.equal(calls.match(/^mercato init --no-examples$/gm)?.length, 1)
    assert.match(calls, /^db:migrate$/m)
    assert.equal(fs.existsSync(path.join(harness.markerDir, '.seeded-v1')), true)
  } finally {
    fs.rmSync(harness.root, { recursive: true, force: true })
  }
})

test('a different deployment SHA cannot resume initialized data', () => {
  const harness = makeHarness()
  try {
    const first = runBootstrap(harness)
    assert.equal(first.status, 0, first.stderr)

    const crossSha = runBootstrap(harness, { DEPLOYMENT_SHA: 'b'.repeat(40) })
    assert.notEqual(crossSha.status, 0)
    assert.match(crossSha.stderr, /belongs to a different deployment SHA/)
    assert.equal(fs.readFileSync(harness.callsFile, 'utf8').match(/^db:migrate$/gm)?.length, 1)
  } finally {
    fs.rmSync(harness.root, { recursive: true, force: true })
  }
})

test('a failed init that committed the exact identities resumes without resetting data', () => {
  const harness = makeHarness()
  try {
    const result = runBootstrap(harness, {
      FAIL_ON_INIT: '1',
      FAKE_STATE_AFTER_INIT_FAILURE: 'initialized',
    })
    assert.equal(result.status, 0, result.stderr)
    const calls = fs.readFileSync(harness.callsFile, 'utf8')
    assert.equal(calls.match(/^mercato init --no-examples$/gm)?.length, 1)
    assert.doesNotMatch(calls, /reset-empty/)
    assert.equal(fs.existsSync(path.join(harness.markerDir, '.initialized-v1')), true)
    assert.equal(fs.existsSync(path.join(harness.markerDir, '.seeded-v1')), true)
  } finally {
    fs.rmSync(harness.root, { recursive: true, force: true })
  }
})

test('partial or ambiguous identity drift fails closed without initialization or deletion', () => {
  const harness = makeHarness()
  try {
    const result = runBootstrap(harness, { FAKE_BOOTSTRAP_STATE: 'empty-partial' })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /partial or ambiguous identity drift/)
    const calls = fs.readFileSync(harness.callsFile, 'utf8')
    assert.doesNotMatch(calls, /^mercato init --no-examples$/m)
    assert.doesNotMatch(calls, /reset-empty/)
    assert.equal(fs.existsSync(path.join(harness.markerDir, '.initialized-v1')), false)
    assert.equal(fs.existsSync(path.join(harness.markerDir, '.seeded-v1')), false)
  } finally {
    fs.rmSync(harness.root, { recursive: true, force: true })
  }
})

test('an initialized marker never bypasses fresh identity read-back', () => {
  const harness = makeHarness()
  try {
    fs.writeFileSync(path.join(harness.markerDir, '.initialized-v1'), `${'a'.repeat(40)}\n`)
    const result = runBootstrap(harness, { FAKE_BOOTSTRAP_STATE: 'drift' })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /marker does not match current database identities/)
    assert.doesNotMatch(fs.readFileSync(harness.callsFile, 'utf8'), /^db:migrate$/m)
  } finally {
    fs.rmSync(harness.root, { recursive: true, force: true })
  }
})
