import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const COMPOSE_PATH = path.resolve(ROOT, 'docker-compose.crm.yml')
const TERRAFORM_PATH = path.resolve(
  ROOT,
  'infra/terraform/modules/single_ec2_rds_crm/main.tf',
)
const DEPLOY_SCRIPT_PATH = path.resolve(ROOT, 'scripts/crm/deploy-crm-they-dev.sh')
const DEPLOY_WORKFLOW_PATH = path.resolve(ROOT, '.github/workflows/crm-they-dev-deploy.yml')
const INFRA_WORKFLOW_PATH = path.resolve(ROOT, '.github/workflows/crm-they-dev-infra.yml')

const SERVICE_LOG_GROUPS = {
  app: '/openmercato/crm/app',
  opencode: '/openmercato/crm/opencode',
  mcp: '/openmercato/crm/mcp',
  worker: '/openmercato/crm/worker',
  redis: '/openmercato/crm/redis',
  meilisearch: '/openmercato/crm/meilisearch',
}

function readService(compose, serviceName) {
  const marker = `\n  ${serviceName}:`
  const start = compose.indexOf(marker)
  assert.notStrictEqual(start, -1, `CRM compose must define ${serviceName}`)

  const remainderStart = start + marker.length
  const nextService = compose.slice(remainderStart).match(/\n  [a-zA-Z0-9_-]+:/)
  const next = nextService ? remainderStart + nextService.index : -1
  return compose.slice(start, next === -1 ? compose.length : next)
}

test('every CRM container uses bounded non-blocking awslogs delivery', () => {
  const compose = fs.readFileSync(COMPOSE_PATH, 'utf8')

  for (const [serviceName, logGroup] of Object.entries(SERVICE_LOG_GROUPS)) {
    const service = readService(compose, serviceName)
    assert.match(service, /^    logging:\n      driver: awslogs$/m, `${serviceName} must use awslogs`)
    assert.match(
      service,
      new RegExp(`^        awslogs-group: ${logGroup.replaceAll('/', '\\/')}$`, 'm'),
      `${serviceName} must use its dedicated log group`,
    )
    assert.match(service, /^        awslogs-create-group: "false"$/m)
    assert.match(service, /^        tag: "\{\{\.Name\}\}\/\{\{\.ID\}\}"$/m)
    assert.match(service, /^        mode: non-blocking$/m)
    assert.match(service, /^        max-buffer-size: 8m$/m)
  }
})

test('CRM MCP port mapping and healthcheck match the configured listener', () => {
  const compose = fs.readFileSync(COMPOSE_PATH, 'utf8')
  const mcp = readService(compose, 'mcp')

  assert.match(mcp, /^      - "\$\{MCP_HOST_PORT:-3002\}:3002"$/m)
  assert.match(mcp, /^      MCP_PORT: "3002"$/m)
  assert.match(mcp, /http:\/\/127\.0\.0\.1:3002\/health/)
})

test('Terraform owns every CRM log destination and preserves retained evidence', () => {
  const terraform = fs.readFileSync(TERRAFORM_PATH, 'utf8')
  const resources = [
    'app',
    'worker',
    'redis',
    'meilisearch',
    'mcp',
    'opencode',
    'host',
    'ssm_deploy',
    'rds_postgresql',
    'rds_upgrade',
  ]

  for (const resourceName of resources) {
    assert.match(
      terraform,
      new RegExp(`resource "aws_cloudwatch_log_group" "${resourceName}"`),
      `Terraform must own the ${resourceName} log group`,
    )
  }

  assert.match(terraform, /enabled_cloudwatch_logs_exports\s*=\s*\["postgresql", "upgrade"\]/)
  assert.match(terraform, /resource "aws_ssm_association" "cloudwatch_agent_package"/)
  assert.match(terraform, /resource "aws_ssm_association" "cloudwatch_agent_config"/)
  assert.match(
    terraform,
    /resource "aws_ssm_association" "cloudwatch_agent_package"[\s\S]*?wait_for_success_timeout_seconds\s*=\s*600/,
  )
  assert.match(
    terraform,
    /resource "aws_ssm_association" "cloudwatch_agent_config"[\s\S]*?wait_for_success_timeout_seconds\s*=\s*300/,
  )
  assert.match(terraform, /"logs:DescribeLogGroups"/)
  assert.match(terraform, /"logs:CreateLogStream"/)
  assert.match(terraform, /"logs:PutLogEvents"/)
  assert.match(terraform, /skip_destroy\s*=\s*true/)
  assert.match(terraform, /resource "aws_cloudwatch_log_data_protection_policy" "crm"/)
  assert.match(terraform, /arn:aws:dataprotection::aws:data-identifier\/AwsSecretKey/)
  assert.match(terraform, /arn:aws:dataprotection::aws:data-identifier\/EmailAddress/)
  assert.match(terraform, /Deidentify\s*=\s*\{/)
  assert.match(terraform, /MaskConfig\s*=\s*\{\}/)
})

test('standalone CRM deployments publish SSM output to the managed group', () => {
  const script = fs.readFileSync(DEPLOY_SCRIPT_PATH, 'utf8')

  assert.match(
    script,
    /SSM_CLOUDWATCH_LOG_GROUP="\$\{SSM_CLOUDWATCH_LOG_GROUP:-\/aws\/ssm\/\$\{NAME_PREFIX\}\/deploy\}"/,
  )
  assert.match(
    script,
    /--cloud-watch-output-config "CloudWatchOutputEnabled=true,CloudWatchLogGroupName=\$\{SSM_CLOUDWATCH_LOG_GROUP\}"/,
  )
  assert.match(script, /active_services=\(app worker mcp redis meilisearch\)/)
  assert.match(
    script,
    /pull "\$\{active_services\[@\]\}"/,
  )
  assert.match(
    script,
    /up -d --no-build --remove-orphans "\$\{active_services\[@\]\}"/,
  )
  assert.doesNotMatch(script, /active_services=\([^)]*opencode/)
})

test('CRM deployments use the canonical global OpenRouter configuration', () => {
  for (const filePath of [DEPLOY_SCRIPT_PATH, DEPLOY_WORKFLOW_PATH]) {
    const source = fs.readFileSync(filePath, 'utf8')

    assert.match(source, /^\s*OM_AI_PROVIDER=openrouter$/m)
    assert.match(
      source,
      /^\s*OM_AI_MODEL=meta-llama\/llama-3\.3-70b-instruct$/m,
    )
    assert.doesNotMatch(
      source,
      /^\s*OM_AI_(?:CATALOG|CUSTOMERS)_(?:PROVIDER|MODEL)=/m,
    )
  }

  const compose = fs.readFileSync(COMPOSE_PATH, 'utf8')
  for (const serviceName of ['app', 'worker']) {
    const service = readService(compose, serviceName)

    assert.match(service, /^      OPENROUTER_API_KEY: \$\{OPENROUTER_API_KEY:-\}$/m)
    assert.match(service, /^      OM_AI_PROVIDER: \$\{OM_AI_PROVIDER:-\}$/m)
    assert.match(service, /^      OM_AI_MODEL: \$\{OM_AI_MODEL:-\}$/m)
    assert.doesNotMatch(
      service,
      /^      OM_AI_(?:CATALOG|CUSTOMERS)_(?:PROVIDER|MODEL):/m,
    )
  }
})

test('CRM deployments fetch requested branches into remote-tracking refs', () => {
  const workflow = fs.readFileSync(DEPLOY_WORKFLOW_PATH, 'utf8')
  const deployScript = fs.readFileSync(DEPLOY_SCRIPT_PATH, 'utf8')

  assert.match(
    workflow,
    /fetch origin "\+refs\/heads\/\$\{branch\}:refs\/remotes\/origin\/\$\{branch\}" --prune/,
  )
  assert.match(
    deployScript,
    /fetch origin "\+refs\/heads\/\$branch:refs\/remotes\/origin\/\$branch" --prune/,
  )

  assert.match(workflow, /id: source\n\s+run: echo "sha=\$\(git rev-parse HEAD\)"/)
  assert.match(
    workflow,
    /image_uri=\$\{REPOSITORY_URL\}:\$\{\{ steps\.source\.outputs\.sha \}\}/,
  )
  assert.match(workflow, /DEPLOY_SHA: \$\{\{ steps\.source\.outputs\.sha \}\}/)
  assert.match(workflow, /if \[\[ "\$\{remote_sha\}" != "\$\{deployment_sha\}" \]\]/)
  assert.match(workflow, /checkout -B "\$\{branch\}" "\$\{deployment_sha\}"/)
  assert.doesNotMatch(workflow, /image_uri=\$\{REPOSITORY_URL\}:\$\{GITHUB_SHA\}/)
})

test('CRM infrastructure workflow cannot execute an unrestricted apply', () => {
  const workflow = fs.readFileSync(INFRA_WORKFLOW_PATH, 'utf8')

  assert.doesNotMatch(workflow, /tofu apply/)
  assert.doesNotMatch(workflow, /- apply$/m)
  assert.match(workflow, /name: Terraform plan/)
})
