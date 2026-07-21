import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const workflow = fs.readFileSync(path.resolve('.github/workflows/fork-manoj-demo-upsert.yml'), 'utf8')
const deployScript = fs.readFileSync(path.resolve('infra/aws-upstream-baseline/preview-upsert.sh'), 'utf8')

test('Manoj workflow passes only secret identifiers to SSM deployment', () => {
  assert.match(workflow, /MANOJ_SUPERADMIN_PASSWORD_SECRET_ID:/)
  assert.match(workflow, /MANOJ_ADMIN_PASSWORD_SECRET_ID:/)
  assert.match(workflow, /MANOJ_EMPLOYEE_PASSWORD_SECRET_ID:/)
  assert.doesNotMatch(workflow, /MANOJ_DEMO_SUPERADMIN_PASSWORD\s*}}/)
  assert.doesNotMatch(workflow, /MANOJ_DEMO_ADMIN_PASSWORD\s*}}/)
  assert.doesNotMatch(workflow, /MANOJ_DEMO_EMPLOYEE_PASSWORD\s*}}/)
  assert.doesNotMatch(workflow, /DEPLOY_ECR_PASSWORD=/)
  assert.doesNotMatch(workflow, /SMOKE_TEST_PASSWORD:/)
})

test('Manoj host resolves secrets and ECR token without serializing their values', () => {
  assert.match(deployScript, /aws secretsmanager get-secret-value/)
  assert.match(deployScript, /aws ecr get-login-password --region "\$aws_region"/)
  assert.match(deployScript, /if \[\[ "\$\{PREVIEW_SLUG\}" != "manoj" \]\]; then/)
  assert.match(deployScript, /! "\$secret_value_to_validate" =~ \[A-Z\]/)
  assert.match(deployScript, /! "\$secret_value_to_validate" =~ \[0-9\]/)
  assert.doesNotMatch(deployScript, /printf 'deploy_superadmin_password=%q[^\n]*MANOJ/)
  assert.doesNotMatch(deployScript, /printf 'deploy_ecr_password=%q[^\n]*MANOJ/)
})

test('Manoj deployment is lifecycle-only and removes persistent bootstrap passwords', () => {
  const firstPreflight = deployScript.indexOf('secure first-time provisioning is a separate procedure')
  const envWrite = deployScript.indexOf('write-private-file.py')
  const recreate = deployScript.indexOf('compose up -d --no-deps --no-build --force-recreate app')
  assert.ok(firstPreflight > -1)
  assert.ok(firstPreflight < envWrite)
  assert.ok(firstPreflight < recreate)
  assert.match(deployScript, /docker-compose\.manoj-lifecycle\.yml/)
  assert.match(deployScript, /emailHashLookupValues/)
  assert.doesNotMatch(deployScript, /hmac\.new/)
  assert.match(deployScript, /exactly one existing \$\{expected_role\} account/)
  assert.match(deployScript, /--user-id "\$OM_ROTATED_ACCOUNT_USER_ID"/)
  assert.match(deployScript, /--tenant-id "\$OM_ROTATED_ACCOUNT_TENANT_ID"/)
  assert.match(deployScript, /render-postgres-password-sql\.py/)
  assert.doesNotMatch(deployScript, /openmercato-preview-.*postgres-password\.sql/)
  assert.match(deployScript, /--password-env OM_ROTATED_ACCOUNT_PASSWORD/)
  assert.match(deployScript, /SMOKE_TEST_PASSWORD; export SMOKE_TEST_PASSWORD/)
})

test('Manoj config restart refreshes deployment tooling while preserving .env', () => {
  assert.match(deployScript, /if \[\[ "\$deploy_mode" == "full" \|\| "\$branch" == "fork\/manoj" \]\]; then/)
  assert.match(deployScript, /git -C "\$workdir" clean -fdx -e \.env/)
  assert.match(deployScript, /if \[\[ "\$branch" == "fork\/manoj" \]\]; then\n\s+render_runtime_env/)
  assert.match(deployScript, /secure scoped password-rotation CLI; run a full deploy first/)
})

test('Manoj target is quiesced during recreation and restored on failure', () => {
  assert.match(deployScript, /aws elbv2 deregister-targets/)
  assert.match(deployScript, /aws elbv2 wait target-deregistered/)
  assert.match(deployScript, /restore_manoj_target/)
  assert.match(deployScript, /Restoring Manoj ALB target after an interrupted deployment/)
  assert.match(deployScript, /MANOJ_TARGET_QUIESCED=false/)
})
