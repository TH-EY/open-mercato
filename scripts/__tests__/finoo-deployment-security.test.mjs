import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { runSmoke } from '../smoke-auth-dashboard.mjs'

const workflow = fs.readFileSync(path.resolve('.github/workflows/fork-finoo-demo-provision.yml'), 'utf8')
const deployScript = fs.readFileSync(path.resolve('infra/aws-upstream-baseline/finoo-demo-provision.sh'), 'utf8')
const upgradeScript = fs.readFileSync(path.resolve('infra/aws-upstream-baseline/finoo-demo-upgrade.sh'), 'utf8')
const provision = fs.readFileSync(path.resolve('infra/aws-upstream-baseline/docker-compose.finoo-provision.yml'), 'utf8')
const dockerfile = fs.readFileSync(path.resolve('Dockerfile'), 'utf8')

function extractShellFunctions(source, name) {
  return [...source.matchAll(new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?^\\}`, 'gm'))]
    .map((match) => match[0])
}

function runBash(source) {
  return spawnSync('bash', ['-c', source], { encoding: 'utf8' })
}

test('branch-bound workflow binds the exact private Finoo lane and immutable image', () => {
  const eventConfig = workflow.slice(workflow.indexOf('on:\n'), workflow.indexOf('\nconcurrency:'))
  assert.equal(eventConfig, 'on:\n  push:\n    branches:\n      - fork/finoo\n')
  const normalizeCondition = (jobName) => {
    const conditionBlock = workflow.match(new RegExp(`${jobName}:\\n(?:\\s{4}needs: .+\\n)?\\s{4}if: >-\\n(?<condition>(?:\\s{6}.+\\n)+)\\s{4}runs-on:`))
    assert.ok(conditionBlock?.groups?.condition)
    return conditionBlock.groups.condition
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .join(' ')
  }
  assert.equal(
    normalizeCondition('first-provision-admission'),
    "github.ref == 'refs/heads/fork/finoo' && github.event_name == 'push' && github.event.deleted == false",
  )
  assert.equal(
    normalizeCondition('deploy-demo'),
    "github.ref == 'refs/heads/fork/finoo' && github.event_name == 'push' && github.event.deleted == false && needs.first-provision-admission.outputs.allowed == 'true'",
  )
  assert.doesNotMatch(workflow, /workflow_dispatch/)
  const shouldProvision = ({ ref, eventName, deleted, message }) =>
    ref === 'refs/heads/fork/finoo'
    && eventName === 'push'
    && deleted === false
    && message.includes('[finoo:first-provision]')
  assert.equal(shouldProvision({ ref: 'refs/heads/fork/finoo', eventName: 'push', deleted: false, message: 'baseline update' }), false)
  assert.equal(shouldProvision({ ref: 'refs/heads/fork/finoo', eventName: 'push', deleted: false, message: 'Provision [finoo:first-provision]' }), true)
  assert.equal(shouldProvision({ ref: 'refs/heads/fork/finoo', eventName: 'push', deleted: false, message: 'Provision [FINOO:FIRST-PROVISION]' }), false)
  assert.equal(shouldProvision({ ref: 'refs/heads/fork/finoo', eventName: 'push', deleted: true, message: 'Provision [finoo:first-provision]' }), false)
  assert.equal(shouldProvision({ ref: 'refs/heads/other', eventName: 'push', deleted: false, message: 'Provision [finoo:first-provision]' }), false)
  assert.match(workflow, /first-provision-admission:\n(?:.|\n)*?permissions: \{\}\n(?:.|\n)*?\[\[ "\$HEAD_COMMIT_MESSAGE" == \*'\[finoo:first-provision\]'\* \]\]/)
  assert.doesNotMatch(workflow, /contains\(github\.event\.head_commit\.message/)
  assert.match(workflow, /permissions:\n\s{6}id-token: write\n\s{6}contents: read\n/)
  assert.match(workflow, /https:\/\/finoo\.om\.they\.dev/)
  assert.match(workflow, /finoo-\$\{GITHUB_SHA\}/)
  assert.match(workflow, /DEPLOY_APP_DIGEST: \$\{\{ steps\.build\.outputs\.digest \}\}/)
  assert.match(workflow, /group: om-dokploy-host-deploy/)
  assert.match(workflow, /FINOO_PREFLIGHT_ONLY: 'true'/)
  assert.doesNotMatch(workflow, /:finoo-latest/)
  const actionRefs = [...workflow.matchAll(/uses:\s+([^\s]+)/g)].map((match) => match[1])
  assert.deepEqual(actionRefs, [
    'actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0',
    'aws-actions/configure-aws-credentials@8df5847569e6427dd6c4fb1cf565c83acfa8afa7',
    'aws-actions/amazon-ecr-login@062b18b96a7aff071d4dc91bc00c4c1a7945b076',
    'docker/setup-buildx-action@4d04d5d9486b7bd6fa91e7baf45bbb4f8b9deedd',
    'docker/build-push-action@d08e5c354a6adb9ed34480a06d141179aa583294',
  ])
})

test('workflow and SSM payload contain secret identifiers, never secret values', () => {
  assert.match(workflow, /FINOO_SUPERADMIN_PASSWORD_SECRET_ID/)
  assert.match(workflow, /FINOO_ADMIN_PASSWORD_SECRET_ID/)
  assert.match(workflow, /FINOO_EMPLOYEE_PASSWORD_SECRET_ID/)
  assert.doesNotMatch(workflow, /FINOO_(SUPERADMIN|ADMIN|EMPLOYEE)_PASSWORD:\s*\$\{\{ secrets\./)
  assert.match(deployScript, /aws secretsmanager get-secret-value/)
  assert.match(deployScript, /aws ecr get-login-password/)
  assert.doesNotMatch(deployScript, /printf '.*password=%q/)
})

test('first provision isolates data and never writes bootstrap passwords to dotenv', () => {
  assert.match(deployScript, /PROJECT_NAME=demo-finoo/)
  assert.match(deployScript, /DEPLOY_ENV=finoo/)
  assert.match(deployScript, /WORKDIR=\/opt\/openmercato-demos\/finoo/)
  assert.match(deployScript, /this workflow is first-provision only/)
  assert.match(deployScript, /test ! -e \/opt\/openmercato-demos\/finoo/)
  assert.doesNotMatch(deployScript, /set_env_value OM_INIT_(SUPERADMIN|ADMIN|EMPLOYEE)_PASSWORD/)
  assert.match(provision, /FINOO_BOOTSTRAP_SUPERADMIN_PASSWORD/)
  assert.match(provision, /FINOO_BOOTSTRAP_ADMIN_PASSWORD/)
  assert.match(provision, /FINOO_BOOTSTRAP_EMPLOYEE_PASSWORD/)
  assert.match(provision, /OM_INIT_REDACT_CREDENTIAL_OUTPUT: "true"/)
  assert.match(provision, /restart: unless-stopped/)
})

test('deployment fails closed, rolls back only new resources, and proves all three roles after scrubbing', () => {
  assert.match(deployScript, /Port \$\{PORT\} is already owned/)
  assert.match(deployScript, /Pulled Finoo image does not match/)
  assert.match(deployScript, /trap cleanup_on_exit EXIT/)
  assert.match(deployScript, /rollback failed Finoo first provision/)
  assert.match(deployScript, /TARGET_GROUP_CREATE_ATTEMPTED=true/)
  assert.match(deployScript, /RULE_CREATE_ATTEMPTED=true/)
  assert.match(deployScript, /reconciled_target_group_shape/)
  assert.match(deployScript, /find_rule_for_hostname/)
  assert.match(deployScript, /down --remove-orphans --volumes/)
  assert.match(deployScript, /delete-rule/)
  assert.match(deployScript, /delete-target-group/)
  assert.match(deployScript, /stop_active_provision/)
  assert.match(deployScript, /ACTIVE_PROVISION_TERMINAL=true/)
  assert.match(deployScript, /Skipping destructive host rollback while the original SSM command may still be running/)
  const postScrub = deployScript.indexOf('unset FINOO_BOOTSTRAP_SUPERADMIN_PASSWORD')
  assert.ok(postScrub > -1)
  const afterScrub = deployScript.slice(postScrub)
  assert.match(afterScrub, /run_role_smoke superadmin/)
  assert.match(afterScrub, /run_role_smoke admin/)
  assert.match(afterScrub, /run_role_smoke employee/)
})

test('password and ECR handling reject injection and clean temporary auth state', () => {
  assert.match(deployScript, /\^\[A-Za-z0-9\._!@%\+=:-\]\+\$/)
  assert.match(deployScript, /Refusing a multiline Finoo environment value/)
  assert.match(deployScript, /docker_config="\$\(mktemp -d\)"/)
  assert.match(deployScript, /export DOCKER_CONFIG="\$docker_config"/)
  assert.match(deployScript, /rm -rf -- "\$docker_config"/)
  assert.doesNotMatch(deployScript, /-e SMOKE_TEST_PASSWORD=/)
  assert.match(deployScript, /cp scripts\/smoke-auth-dashboard\.mjs app:\/tmp\/finoo-smoke-auth-dashboard\.mjs/)
  assert.match(deployScript, /node \/tmp\/finoo-smoke-auth-dashboard\.mjs --run-smoke/)
  assert.doesNotMatch(deployScript, /node \/app\/scripts\/smoke-auth-dashboard\.mjs/)
  assert.match(deployScript, /docker image ls -q open-mercato\/app:\$\{deploy_env\}/)
  assert.match(deployScript, /ss -ltnH "sport = :\$\{demo_port\}"/)
  assert.match(deployScript, /mercato-postgres-data-finoo/)
  assert.match(deployScript, /mercato-attachments-storage-finoo/)
  assert.match(deployScript, /mercato-network-finoo/)
  assert.match(deployScript, /assert_literal_runtime_absent/)
  assert.match(deployScript, /\.finoo-first-provision-owned/)
  assert.match(deployScript, /base64 --decode \| bash/)
})

test('host checkout uses the public HTTPS endpoint without SSH host trust', () => {
  assert.match(deployScript, /REPO_URL=https:\/\/github\.com\/TH-EY\/open-mercato\.git/)
  assert.doesNotMatch(deployScript, /git@github\.com/)
})

test('operator-invoked upgrade keeps the healthy live port until candidate smoke and has verified rollback', () => {
  assert.match(upgradeScript, /image tag must bind the exact deployment commit/)
  assert.match(upgradeScript, /OM_FINOO_DEFAULT_AFFILIATE_DESTINATION_URL/)
  assert.match(upgradeScript, /default affiliate destination must be https:\/\/finoo\.pl\//)
  assert.match(upgradeScript, /approved ECR repository and exact commit tag/)
  assert.match(upgradeScript, /immutable_image="\$\{deploy_app_image%:\*\}@\$\{deploy_app_digest\}"/)
  assert.match(upgradeScript, /org\.opencontainers\.image\.revision/)
  assert.match(upgradeScript, /image revision does not match the requested commit/)
  assert.match(upgradeScript, /exact approved Finoo admin password secret identifier/)
  assert.match(upgradeScript, /FINOO_EXPECTED_IDENTITY_RECORDS/)
  assert.match(upgradeScript, /positive preflight identity-record count/)
  assert.match(upgradeScript, /destination count changed from approved preflight/)
  assert.equal((upgradeScript.match(/verify_identity_purge_state\(\)/g) ?? []).length, 2)
  assert.equal((upgradeScript.match(/finoo_identities purge-legacy/g) ?? []).length, 2)
  assert.doesNotMatch(upgradeScript, /finoo_identities purge-legacy[\s\S]{0,250}--apply/)
  assert.match(upgradeScript, /checkout does not match the requested immutable commit/)
  assert.match(upgradeScript, /upgrade requires a clean checkout/)
  assert.match(upgradeScript, /Finoo rollback target is not healthy before upgrade/)
  assert.match(upgradeScript, /127\.0\.0\.1:\$\{candidate_port\}:3000/)
  assert.match(upgradeScript, /Finoo candidate did not become reachable/)
  assert.match(upgradeScript, /signup_status/)
  assert.match(upgradeScript, /exec 9>\/var\/lock\/finoo-demo-upgrade\.lock/)
  assert.match(upgradeScript, /\.finoo-upgrade-pending/)
  assert.match(upgradeScript, /docker create/)
  assert.match(upgradeScript, /docker rename "\$active_container" "\$rollback_container"/)
  assert.match(upgradeScript, /docker rename "\$rollback_container" "\$active_container"/)
  assert.match(upgradeScript, /--restart unless-stopped/)
  assert.match(upgradeScript, /--network-alias app/)
  assert.match(upgradeScript, /--volumes-from "\$rollback_container"/)
  assert.match(upgradeScript, /com\.docker\.compose\.project/)
  assert.match(upgradeScript, /com\.docker\.compose\.service/)
  assert.doesNotMatch(upgradeScript, /com\.docker\.compose\.container-number/)
  assert.match(upgradeScript, /key\.startswith\("org\.opencontainers\.image\."\)/)
  assert.match(upgradeScript, /--label "org\.opencontainers\.image\.revision=\$\{deploy_commit\}"/)
  assert.match(upgradeScript, /index \.Config\.Labels "org\.opencontainers\.image\.revision"/)
  assert.match(upgradeScript, /test "\$\(docker inspect --format '\{\{\.Id\}\}' "\$active_container"/)
  assert.match(upgradeScript, /aws ssm cancel-command/)
  assert.match(upgradeScript, /Unable to prove that Finoo SSM command/)
  assert.match(upgradeScript, /decision=finalize/)
  assert.match(upgradeScript, /decision=rollback/)
  assert.match(upgradeScript, /env_modified=true/)
  assert.match(upgradeScript, /pre-cutover configuration rollback failed/)
  assert.match(upgradeScript, /prior_commit_present/)
  assert.match(upgradeScript, /prior_digest_present/)
  assert.match(upgradeScript, /commit_temp=/)
  assert.match(upgradeScript, /digest_temp=/)
  assert.match(upgradeScript, /if signup_code="\$\(curl/)
  assert.doesNotMatch(upgradeScript, /down --remove-orphans --volumes/)
  assert.doesNotMatch(upgradeScript, /delete-target-group|modify-rule|delete-rule/)
  assert.match(upgradeScript, /FINOO_ADMIN_PASSWORD_SECRET_ID/)
  assert.doesNotMatch(upgradeScript, /FINOO_(SUPERADMIN|EMPLOYEE)_PASSWORD_SECRET_ID/)
  assert.doesNotMatch(upgradeScript, /superadmin-password|employee-password/)
  assert.match(upgradeScript, /finoo-demo\/finoo-admin-password/)
  assert.match(upgradeScript, /ensure-admin-credential/)
  assert.match(upgradeScript, /--password-stdin/)
  assert.match(upgradeScript, /SMOKE_TEST_TENANT_ID/)
  assert.match(upgradeScript, /REQUIRE_TENANT_SCOPE=true/)
  assert.match(upgradeScript, /run_finoo_admin_smoke/)
  assert.match(upgradeScript, /admin_credential_attempted=false/)
  assert.match(upgradeScript, /admin_credential_attempted=true/)
  assert.equal((upgradeScript.match(/install_finoo_smoke_helper\(\)/g) ?? []).length, 2)
  assert.equal((upgradeScript.match(/wait_for_finoo_admin_smoke\(\)/g) ?? []).length, 2)
  assert.equal((upgradeScript.match(/for attempt in \$\(seq 1 6\); do\s+if run_finoo_admin_smoke "\$container"; then return 0; fi\s+sleep 65/g) ?? []).length, 2)
  assert.match(upgradeScript, /install_finoo_smoke_helper "\$active_container"\nwait_for_finoo_admin_smoke "\$active_container"/)
  assert.doesNotMatch(upgradeScript, /docker cp scripts\/smoke-auth-dashboard\.mjs/)
  assert.equal((upgradeScript.match(/docker run --rm --entrypoint \/bin\/cat "\$immutable_image" \/app\/scripts\/smoke-auth-dashboard\.mjs/g) ?? []).length, 2)
  assert.equal((upgradeScript.match(/"\$target_hash" == "\$source_hash"/g) ?? []).length, 2)
  assert.equal((upgradeScript.match(/timeout --signal=TERM --kill-after=5s 20s aws secretsmanager get-secret-value/g) ?? []).length, 2)
  assert.equal((upgradeScript.match(/timeout --signal=TERM --kill-after=5s 30s docker exec -i/g) ?? []).length, 2)
  assert.equal((upgradeScript.match(/-e SMOKE_REQUEST_TIMEOUT_MS=5000/g) ?? []).length, 2)
  assert.match(upgradeScript, /if ! wait_for_finoo_admin_smoke "\$active_container"; then\s+return 1\s+fi\s+echo "persistent_finoo_admin_credential_verified_during_stage_cleanup=true"/)
  assert.match(upgradeScript, /if ! wait_for_finoo_admin_smoke "\$active_container"; then\s+return 1\s+fi\s+echo "persistent_finoo_admin_credential_verified_after_rollback=true"/)
  assert.match(upgradeScript, /admin_credential_applied=false/)
  assert.match(upgradeScript, /admin_credential_applied=true/)
  assert.match(upgradeScript, /persistent_finoo_admin_credential_verified_during_stage_cleanup=true/)
  assert.match(upgradeScript, /persistent_finoo_admin_credential_verified_after_rollback=true/)
  const credentialApply = upgradeScript.indexOf('docker exec -i "$candidate_container" yarn mercato finoo_customer_retention ensure-admin-credential')
  const attemptedState = upgradeScript.indexOf('admin_credential_attempted=true')
  const attemptedSync = upgradeScript.indexOf('sync "$pending_file"', attemptedState)
  const appliedState = upgradeScript.indexOf('admin_credential_applied=true', credentialApply)
  const cleanupVerifier = upgradeScript.indexOf('verify_stage_cleanup_admin_credential ||')
  const cleanupPendingRemoval = upgradeScript.indexOf('rm -f -- "$env_backup" "$commit_backup" "$digest_backup" "$pending_file"')
  assert.ok(attemptedState > -1 && attemptedSync > attemptedState && credentialApply > attemptedSync)
  assert.ok(appliedState > credentialApply)
  assert.match(upgradeScript, /if \[\[ "\$admin_credential_attempted" != true \]\]; then return 0; fi/)
  assert.ok(cleanupVerifier > -1 && cleanupVerifier < cleanupPendingRemoval)
  for (const comment of [
    'THOM-108 stage immutable private Finoo upgrade',
    'THOM-108 rollback failed Finoo stage',
    'THOM-108 ${decision} private Finoo upgrade',
    'THOM-108 rollback failed Finoo finalization',
  ]) {
    assert.ok(upgradeScript.includes(comment), `missing SSM comment: ${comment}`)
  }
  assert.doesNotMatch(upgradeScript, /thom88/i)
  assert.doesNotMatch(upgradeScript, /auth list-users|run_role_smoke/)
})

test('upgrade readiness retries transient failures and fails after its bounded attempts', () => {
  const waitFunctions = extractShellFunctions(upgradeScript, 'wait_for_finoo_admin_smoke')
  assert.equal(waitFunctions.length, 2)
  for (const waitFunction of waitFunctions) {
    const transient = runBash(`
set -u
${waitFunction}
attempts=0
run_finoo_admin_smoke() {
  attempts=$((attempts + 1))
  [[ "$attempts" -ge 3 ]]
}
sleep() { :; }
wait_for_finoo_admin_smoke active
printf 'attempts=%s\\n' "$attempts"
`)
    assert.equal(transient.status, 0, transient.stderr)
    assert.match(transient.stdout, /attempts=3/)

    const permanent = runBash(`
set -u
${waitFunction}
run_finoo_admin_smoke() { return 1; }
sleep() { :; }
if wait_for_finoo_admin_smoke active; then
  exit 99
fi
printf 'permanent_failure=true\\n'
`)
    assert.equal(permanent.status, 0, permanent.stderr)
    assert.match(permanent.stdout, /permanent_failure=true/)
  }
})

test('rollback credential proof fails closed when the immutable helper install fails', () => {
  const installers = extractShellFunctions(upgradeScript, 'install_finoo_smoke_helper')
  const verifiers = [
    ...extractShellFunctions(upgradeScript, 'verify_stage_cleanup_admin_credential'),
    ...extractShellFunctions(upgradeScript, 'verify_persistent_finoo_admin_credential'),
  ]
  assert.equal(installers.length, 2)
  assert.equal(verifiers.length, 2)
  for (const [index, verifier] of verifiers.entries()) {
    const functionName = verifier.match(/^(\w+)\(\)/)?.[1]
    assert.ok(functionName)
    const result = runBash(`
set -u
${installers[index]}
${verifier}
admin_credential_attempted=true
active_container=active
immutable_image=immutable
docker() {
  if [[ "$1" == run && "$*" == *"/bin/sh"* ]]; then
    printf 'reviewedhash  /app/scripts/smoke-auth-dashboard.mjs\\n'
    return 0
  fi
  if [[ "$1" == exec && "$*" == *"rm -f"* ]]; then return 0; fi
  if [[ "$1" == run && "$*" == *"/bin/cat"* ]]; then
    printf 'reviewed helper'
    return 0
  fi
  if [[ "$1" == exec && "$*" == *"umask 022; cat > /tmp/finoo-smoke-auth-dashboard.mjs"* ]]; then return 1; fi
  return 2
}
wait_for_finoo_admin_smoke() {
  printf 'stale_smoke_ran=true\\n'
  return 0
}
pending_removed=false
if ${functionName}; then
  pending_removed=true
fi
printf 'pending_removed=%s\\n' "$pending_removed"
`)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /pending_removed=false/)
    assert.doesNotMatch(result.stdout, /stale_smoke_ran=true|persistent_finoo_admin_credential_verified/)
  }
})

test('rollback credential proof accepts only the hash-matched immutable helper', () => {
  const installer = extractShellFunctions(upgradeScript, 'install_finoo_smoke_helper')[0]
  const verifier = extractShellFunctions(upgradeScript, 'verify_stage_cleanup_admin_credential')[0]
  const result = runBash(`
set -uo pipefail
${installer}
${verifier}
admin_credential_attempted=true
active_container=active
immutable_image=immutable
docker() {
  if [[ "$1" == run && "$*" == *"/bin/sh"* ]]; then
    printf 'reviewedhash  /app/scripts/smoke-auth-dashboard.mjs\\n'
    return 0
  fi
  if [[ "$1" == exec && "$*" == *"rm -f"* ]]; then return 0; fi
  if [[ "$1" == run && "$*" == *"/bin/cat"* ]]; then
    printf 'reviewed helper'
    return 0
  fi
  if [[ "$1" == exec && "$*" == *"umask 022; cat > /tmp/finoo-smoke-auth-dashboard.mjs"* ]]; then
    cat >/dev/null
    return 0
  fi
  if [[ "$1" == exec && "$*" == *"sha256sum /tmp/finoo-smoke-auth-dashboard.mjs"* ]]; then
    printf 'reviewedhash  /tmp/finoo-smoke-auth-dashboard.mjs\\n'
    return 0
  fi
  return 2
}
wait_for_finoo_admin_smoke() {
  printf 'tenant_smoke_ran=true\\n'
  return 0
}
verify_stage_cleanup_admin_credential
`)
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /tenant_smoke_ran=true/)
  assert.match(result.stdout, /persistent_finoo_admin_credential_verified_during_stage_cleanup=true/)
})

test('production image carries the reviewed authenticated smoke helper', () => {
  const runnerStage = dockerfile.slice(dockerfile.indexOf('FROM node:24-alpine AS runner'))
  assert.match(runnerStage, /COPY --from=builder \/app\/scripts\/smoke-auth-dashboard\.mjs \.\/scripts\/smoke-auth-dashboard\.mjs/)
})

test('upgrade configures Finoo attribution securely without logging credentials', () => {
  assert.match(upgradeScript, /redirects must be restricted to finoo\.pl/)
  assert.match(upgradeScript, /verified direct-ALB proxy depth of 1/)
  assert.match(upgradeScript, /RATE_LIMIT_STRATEGY': 'redis'/)
  assert.match(upgradeScript, /REDIS_URL': 'redis:\/\/mercato-redis-finoo:6379'/)
  assert.match(upgradeScript, /NEXT_PUBLIC_OM_PORTAL_ALLOW_SELF_REGISTRATION': 'false'/)
  assert.match(upgradeScript, /aws secretsmanager get-secret-value/)
  assert.doesNotMatch(upgradeScript, /printf '.*password=%q/)
  assert.match(upgradeScript, /chmod 600 "\$pending_file"/)
  assert.match(upgradeScript, /chmod 600 "\$commit_temp" "\$digest_temp"/)
})

test('Finoo keeps ambient SES as the default and gates its dedicated encrypted channel credentials', () => {
  for (const source of [deployScript, upgradeScript]) {
    assert.match(source, /SYSTEM_EMAIL_PROVIDER/)
    assert.match(source, /AWS_SES_REGION/)
    assert.match(source, /EMAIL_FROM/)
    assert.match(source, /NOTIFICATIONS_EMAIL_FROM/)
    assert.match(source, /no-reply@they\.dev/)
    assert.doesNotMatch(source, /AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN/)
  }
  assert.match(deployScript, /set_env_value SYSTEM_EMAIL_PROVIDER ses/)
  assert.match(deployScript, /set_env_value AWS_SES_REGION eu-west-2/)
  assert.match(upgradeScript, /yarn mercato channel_ses assert-env-preset-exact/)
  assert.match(upgradeScript, /yarn mercato channel_ses assert-explicit-credentials/)
  assert.match(upgradeScript, /yarn mercato channel_ses assert-credentials-health/)
  assert.match(upgradeScript, /FINOO_SES_CREDENTIALS_STAGED/)
  assert.match(upgradeScript, /yarn mercado channel_ses restore-ambient-credentials/)
  assert.match(upgradeScript, /ses_credentials_restored=ambient/)
  assert.ok(
    upgradeScript.indexOf('restore_staged_ses_credentials ||')
      < upgradeScript.indexOf('docker rm -f "$candidate_container"'),
    'staged SES credentials must be restored before candidate cleanup',
  )
  assert.match(upgradeScript, /FINOO_TENANT_ID=26d5dc28-6df5-4944-b0e9-0ff26a8bf8a6/)
  assert.match(upgradeScript, /FINOO_ORGANIZATION_ID=4ec19265-3d35-4e9f-bcd2-531e62cf8385/)
  assert.doesNotMatch(upgradeScript, /yarn mercato channel_ses (?:assert-env-preset-absent|remove-env-preset)/)
  assert.doesNotMatch(upgradeScript, /yarn mercato seed:defaults --module channel_ses/)
  assert.doesNotMatch(upgradeScript, /configure-explicit-credentials|accessKeyId|secretAccessKey/)
  assert.match(upgradeScript, /cp -p -- \.env "\$env_backup"/)
  assert.match(upgradeScript, /cp -p -- "\$env_backup" \.env/)
})

test('authenticated smoke verifies email, role, and backend access', async () => {
  const responses = [
    new Response('', { status: 200 }),
    new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'set-cookie': 'auth_token=token; Path=/; HttpOnly' },
    }),
    new Response(JSON.stringify({ email: 'admin@finoo.om.they.dev', roles: ['Finoo Superadmin'] }), { status: 200 }),
    new Response('<html>backend</html>', { status: 200 }),
  ]
  const requests = []
  await runSmoke({
    env: {
      BASE_URL: 'https://finoo.om.they.dev',
      SMOKE_TEST_EMAIL: 'admin@finoo.om.they.dev',
      SMOKE_TEST_PASSWORD: 'not-a-real-secret',
      EXPECTED_ROLE: 'Finoo Superadmin',
      SMOKE_TEST_TENANT_ID: '26d5dc28-6df5-4944-b0e9-0ff26a8bf8a6',
      REQUIRE_TENANT_SCOPE: 'true',
    },
    fetch: async (url, options) => {
      requests.push({ url, options })
      return responses.shift()
    },
    log: () => {},
  })
  assert.equal(responses.length, 0)
  assert.equal(
    requests[0].url,
    'https://finoo.om.they.dev/login?tenant=26d5dc28-6df5-4944-b0e9-0ff26a8bf8a6',
  )
  assert.equal(
    requests[1].options.body.get('tenantId'),
    '26d5dc28-6df5-4944-b0e9-0ff26a8bf8a6',
  )
})

test('authenticated smoke requires an explicit tenant scope', async () => {
  await assert.rejects(
    runSmoke({
      env: {
        BASE_URL: 'https://finoo.om.they.dev',
        SMOKE_TEST_EMAIL: 'admin@finoo.om.they.dev',
        SMOKE_TEST_PASSWORD: 'not-a-real-secret',
        EXPECTED_ROLE: 'Finoo Superadmin',
        REQUIRE_TENANT_SCOPE: 'true',
      },
      fetch: async () => {
        throw new Error('fetch must not run')
      },
      log: () => {},
    }),
    /SMOKE_TEST_TENANT_ID/,
  )
})

test('authenticated smoke rejects a request that never resolves within its deadline', async () => {
  const smoke = runSmoke({
    env: {
      BASE_URL: 'https://finoo.om.they.dev',
      SMOKE_TEST_EMAIL: 'admin@finoo.om.they.dev',
      SMOKE_TEST_PASSWORD: 'not-a-real-secret',
      EXPECTED_ROLE: 'Finoo Superadmin',
      SMOKE_TEST_TENANT_ID: '26d5dc28-6df5-4944-b0e9-0ff26a8bf8a6',
      REQUIRE_TENANT_SCOPE: 'true',
      SMOKE_REQUEST_TIMEOUT_MS: '10',
    },
    fetch: () => new Promise(() => {}),
    log: () => {},
  })
  const watchdog = new Promise((_, reject) => {
    setTimeout(() => reject(new Error('smoke timeout watchdog expired')), 250)
  })
  await assert.rejects(Promise.race([smoke, watchdog]), /Request timed out after 10ms/)
})

test('authenticated smoke includes response body reads in the request deadline', async () => {
  const bodyNeverResolves = {
    ok: true,
    status: 200,
    headers: new Headers({ 'set-cookie': 'auth_token=token; Path=/; HttpOnly' }),
    text: () => new Promise(() => {}),
  }
  const responses = [new Response('', { status: 200 }), bodyNeverResolves]
  const smoke = runSmoke({
    env: {
      BASE_URL: 'https://finoo.om.they.dev',
      SMOKE_TEST_EMAIL: 'admin@finoo.om.they.dev',
      SMOKE_TEST_PASSWORD: 'not-a-real-secret',
      EXPECTED_ROLE: 'Finoo Superadmin',
      SMOKE_TEST_TENANT_ID: '26d5dc28-6df5-4944-b0e9-0ff26a8bf8a6',
      REQUIRE_TENANT_SCOPE: 'true',
      SMOKE_REQUEST_TIMEOUT_MS: '10',
    },
    fetch: async () => responses.shift(),
    log: () => {},
  })
  const watchdog = new Promise((_, reject) => {
    setTimeout(() => reject(new Error('smoke body timeout watchdog expired')), 250)
  })
  await assert.rejects(Promise.race([smoke, watchdog]), /Request timed out after 10ms/)
})

test('authenticated smoke preserves first-provision compatibility outside strict tenant mode', async () => {
  const responses = [
    new Response('', { status: 200 }),
    new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'set-cookie': 'auth_token=token; Path=/; HttpOnly' },
    }),
    new Response(JSON.stringify({ email: 'admin@finoo.om.they.dev', roles: ['admin'] }), { status: 200 }),
    new Response('<html>backend</html>', { status: 200 }),
  ]
  const requests = []
  await runSmoke({
    env: {
      BASE_URL: 'https://finoo.om.they.dev',
      SMOKE_TEST_EMAIL: 'admin@finoo.om.they.dev',
      SMOKE_TEST_PASSWORD: 'not-a-real-secret',
      EXPECTED_ROLE: 'admin',
    },
    fetch: async (url, options) => {
      requests.push({ url, options })
      return responses.shift()
    },
    log: () => {},
  })
  assert.equal(requests[0].url, 'https://finoo.om.they.dev/login')
  assert.equal(requests[1].options.body.has('tenantId'), false)
})

test('authenticated smoke rejects a mismatched role', async () => {
  const responses = [
    new Response('', { status: 200 }),
    new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'set-cookie': 'auth_token=token; Path=/; HttpOnly' },
    }),
    new Response(JSON.stringify({ email: 'employee@finoo.om.they.dev', roles: ['employee'] }), { status: 200 }),
  ]
  await assert.rejects(
    runSmoke({
      env: {
        BASE_URL: 'https://finoo.om.they.dev',
        SMOKE_TEST_EMAIL: 'employee@finoo.om.they.dev',
        SMOKE_TEST_PASSWORD: 'not-a-real-secret',
        EXPECTED_ROLE: 'Finoo Superadmin',
        SMOKE_TEST_TENANT_ID: '26d5dc28-6df5-4944-b0e9-0ff26a8bf8a6',
        REQUIRE_TENANT_SCOPE: 'true',
      },
      fetch: async () => responses.shift(),
      log: () => {},
    }),
    /did not prove Finoo Superadmin access/,
  )
})
