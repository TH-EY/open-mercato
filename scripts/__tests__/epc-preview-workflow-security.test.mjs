import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const workflowPath = path.resolve('.github/workflows/fork-epc-preview-upsert.yml')
const workflow = fs.readFileSync(workflowPath, 'utf8')

function stepBody(name, nextName) {
  const start = workflow.indexOf(`      - name: ${name}`)
  const end = workflow.indexOf(`      - name: ${nextName}`, start + 1)
  assert.notEqual(start, -1, `missing workflow step: ${name}`)
  assert.notEqual(end, -1, `missing workflow step after ${name}: ${nextName}`)
  return workflow.slice(start, end)
}

test('EPC runtime secrets are resolved on the host from identifiers', () => {
  const prepare = stepBody('Prepare checkout and runtime config', 'Pull or verify app image')

  assert.match(prepare, /openrouter_secret_id=/)
  assert.match(prepare, /aws secretsmanager get-secret-value/)
  assert.doesNotMatch(prepare, /PREVIEW_ADMIN_PASSWORD:/)
  assert.doesNotMatch(prepare, /printf 'openrouter_api_key=/)
  assert.doesNotMatch(prepare, /printf 'preview_admin_password=/)
  assert.doesNotMatch(prepare, /python3 - <<'PY'[^\n]*openrouter_api_key/)
  assert.doesNotMatch(prepare, /python3 - <<'PY'[^\n]*preview_admin_password/)
  assert.match(prepare, /os\.environ\['OM_DEPLOY_OPENROUTER_API_KEY'\]/)
  assert.doesNotMatch(prepare, /OM_DEPLOY_ADMIN_PASSWORD/)
  assert.doesNotMatch(prepare, /OM_INIT_SUPERADMIN_PASSWORD/)
  assert.match(prepare, /write-private-file\.py/)
  assert.match(prepare, /read-dotenv-value\.py/)
  assert.doesNotMatch(prepare, /docker exec -e PGPASSWORD=/)
  assert.doesNotMatch(prepare, /\. \.\/\.env/)
})

test('ECR authorization token is created on the host and never serialized for SSM', () => {
  const pull = stepBody('Pull or verify app image', 'Recreate app without touching volumes')

  assert.match(pull, /aws ecr get-login-password --region "\$aws_region"/)
  assert.doesNotMatch(pull, /ecr_password=/)
  assert.doesNotMatch(pull, /printf 'ecr_password=/)
})

test('EPC deploy synchronizes the existing administrator from the host-side secret', () => {
  const recreate = stepBody('Recreate app without touching volumes', 'Local /login healthcheck')

  assert.match(recreate, /admin_password_secret_id=/)
  assert.match(recreate, /aws secretsmanager get-secret-value/)
  assert.match(recreate, /admin_email="\$\(dotenv_value OM_INIT_SUPERADMIN_EMAIL\)"/)
  assert.ok(
    recreate.indexOf('admin_email="$(dotenv_value OM_INIT_SUPERADMIN_EMAIL)"') <
      recreate.indexOf('printf \'%s\' "$admin_email"'),
    'administrator email must be loaded in the same SSM step before lifecycle validation',
  )
  assert.match(recreate, /mercato auth set-password/)
  assert.doesNotMatch(recreate, /EPC_PREVIEW_ADMIN_PASSWORD/)
  assert.doesNotMatch(recreate, /--password "\$admin_password"/)
  assert.match(recreate, /--password-env OM_ROTATED_ADMIN_PASSWORD/)
  assert.match(recreate, /OM_ROTATED_ADMIN_PASSWORD/)
  assert.doesNotMatch(recreate, /docker exec[^\n]*-e OM_ROTATED_ADMIN_PASSWORD=/)
  assert.match(recreate, /printf '%s\\n' "\$admin_password" \| docker exec/)
  assert.match(recreate, /psql -U "\$\{postgres_user:-postgres\}" -d "\$\{postgres_database:-postgres\}"/)
  assert.match(recreate, /render-postgres-password-sql\.py "\$\{postgres_user:-postgres\}"/)
  assert.doesNotMatch(recreate, /openmercato-preview-.*postgres-password\.sql/)
  assert.match(recreate, /docker exec -i "\$existing_epc_postgres" psql/)
  assert.match(recreate, /secure first-time provisioning is a separate procedure/)
  assert.match(recreate, /emailHashLookupValues\(email\)/)
  assert.match(recreate, /render-postgres-email-hashes-exists-sql\.py/)
  assert.doesNotMatch(recreate, /lower\(email\)/)
  assert.match(recreate, /refusing insecure first-time initialization/)
  assert.ok(
    recreate.indexOf('refusing insecure first-time initialization') < recreate.indexOf('compose up -d'),
    'lifecycle preflight must fail before the app is recreated',
  )
  assert.doesNotMatch(recreate, /\. \.\/\.env/)
})

test('authenticated smoke uses the same host-side administrator secret', () => {
  const smoke = stepBody('Smoke test preview', 'Diagnostics')

  assert.match(smoke, /admin_password_secret_id=/)
  assert.match(smoke, /aws secretsmanager get-secret-value/)
  assert.match(smoke, /docker exec -i/)
  assert.match(smoke, /node --input-type=module - --run-smoke/)
  assert.match(smoke, /< \.\/scripts\/smoke-auth-dashboard\.mjs/)
  assert.doesNotMatch(smoke, /bash \.\/infra\/aws-upstream-baseline\/smoke\.sh/)
  assert.doesNotMatch(smoke, /-e SMOKE_TEST_PASSWORD=/)
  assert.doesNotMatch(smoke, /EPC_PREVIEW_ADMIN_PASSWORD/)
  assert.doesNotMatch(smoke, /SMOKE_TEST_PASSWORD: \$\{\{ secrets\./)
  assert.doesNotMatch(smoke, /\. \.\/\.env/)
})
