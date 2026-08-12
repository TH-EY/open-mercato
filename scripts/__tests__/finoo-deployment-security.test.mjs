import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { runSmoke } from '../smoke-auth-dashboard.mjs'

const workflow = fs.readFileSync(path.resolve('.github/workflows/fork-finoo-demo-provision.yml'), 'utf8')
const deployScript = fs.readFileSync(path.resolve('infra/aws-upstream-baseline/finoo-demo-provision.sh'), 'utf8')
const upgradeScript = fs.readFileSync(path.resolve('infra/aws-upstream-baseline/finoo-demo-upgrade.sh'), 'utf8')
const provision = fs.readFileSync(path.resolve('infra/aws-upstream-baseline/docker-compose.finoo-provision.yml'), 'utf8')

test('branch-bound workflow binds the exact private Finoo lane and immutable image', () => {
  const eventConfig = workflow.slice(workflow.indexOf('on:\n'), workflow.indexOf('\nconcurrency:'))
  assert.equal(eventConfig, 'on:\n  push:\n    branches:\n      - fork/finoo\n  workflow_dispatch:\n')
  assert.match(
    workflow,
    /deploy-demo:\n\s{4}if: github\.ref == 'refs\/heads\/fork\/finoo' && \(github\.event_name == 'workflow_dispatch' \|\| \(github\.event_name == 'push' && github\.event\.deleted == false\)\)/,
  )
  assert.match(workflow, /https:\/\/finoo\.om\.they\.dev/)
  assert.match(workflow, /finoo-\$\{GITHUB_SHA\}/)
  assert.match(workflow, /DEPLOY_APP_DIGEST: \$\{\{ steps\.build\.outputs\.digest \}\}/)
  assert.match(workflow, /group: om-dokploy-host-deploy/)
  assert.match(workflow, /FINOO_PREFLIGHT_ONLY: 'true'/)
  assert.doesNotMatch(workflow, /:finoo-latest/)
  const actionRefs = [...workflow.matchAll(/uses:\s+[^@\s]+@([^\s]+)/g)].map((match) => match[1])
  assert.ok(actionRefs.length > 0)
  assert.ok(actionRefs.every((reference) => /^[0-9a-f]{40}$/.test(reference)))
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
  assert.match(upgradeScript, /approved ECR repository and exact commit tag/)
  assert.match(upgradeScript, /immutable_image="\$\{deploy_app_image%:\*\}@\$\{deploy_app_digest\}"/)
  assert.match(upgradeScript, /org\.opencontainers\.image\.revision/)
  assert.match(upgradeScript, /image revision does not match the requested commit/)
  assert.match(upgradeScript, /exact approved role password secret identifiers/)
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

test('authenticated smoke verifies email, role, and backend access', async () => {
  const responses = [
    new Response('', { status: 200 }),
    new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'set-cookie': 'auth_token=token; Path=/; HttpOnly' },
    }),
    new Response(JSON.stringify({ email: 'admin@finoo.om.they.dev', roles: ['admin'] }), { status: 200 }),
    new Response('<html>backend</html>', { status: 200 }),
  ]
  await runSmoke({
    env: {
      BASE_URL: 'https://finoo.om.they.dev',
      SMOKE_TEST_EMAIL: 'admin@finoo.om.they.dev',
      SMOKE_TEST_PASSWORD: 'not-a-real-secret',
      EXPECTED_ROLE: 'admin',
    },
    fetch: async () => responses.shift(),
    log: () => {},
  })
  assert.equal(responses.length, 0)
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
        EXPECTED_ROLE: 'admin',
      },
      fetch: async () => responses.shift(),
      log: () => {},
    }),
    /did not prove admin access/,
  )
})
