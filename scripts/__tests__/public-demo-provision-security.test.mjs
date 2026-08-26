import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import test from 'node:test'
import { parse } from 'yaml'

const workflowSource = fs.readFileSync('.github/workflows/public-demo-deploy.yml', 'utf8')
const workflow = parse(workflowSource)
const composeSource = fs.readFileSync('docker-compose.public-demo.yml', 'utf8')
const compose = parse(composeSource)
const ssmRunnerSource = fs.readFileSync('scripts/public-demo/ssm-run-step.sh', 'utf8')
const bootstrapSource = fs.readFileSync('scripts/public-demo/init-or-migrate.sh', 'utf8')
const bootstrapStateSource = fs.readFileSync('scripts/public-demo/bootstrap-state.mjs', 'utf8')
const credentialBrokerSource = fs.readFileSync('scripts/public-demo/aws-credential-broker.mjs', 'utf8')
const dockerfileSource = fs.readFileSync('Dockerfile', 'utf8')

const expectedRef = 'refs/heads/feat/THOM-113-public-demo'
const expectedServices = [
  'app', 'worker', 'mcp', 'aws-credential-broker', 'bootstrap', 'postgres', 'redis', 'meilisearch',
]
const longRunningApplicationServices = ['app', 'worker', 'mcp']

function workflowTriggers() {
  return workflow.on ?? workflow.true
}

function actionSteps(job) {
  return job.steps.filter((step) => typeof step.uses === 'string')
}

test('deployment trigger, OIDC subject inputs, and candidate gate are exact', () => {
  const triggers = workflowTriggers()

  assert.deepEqual(Object.keys(triggers), ['push'])
  assert.deepEqual(triggers.push.branches, ['feat/THOM-113-public-demo'])
  assert.equal(workflow.env.EXPECTED_REPOSITORY, 'TH-EY/open-mercato')
  assert.equal(workflow.env.EXPECTED_REF, expectedRef)
  assert.doesNotMatch(workflowSource, /^\s*environment:/m)
  assert.match(workflow.jobs.deploy.if, /vars\.PUBLIC_DEMO_APPROVED_SHA == github\.sha/)
  assert.match(workflow.jobs.deploy.if, /github\.repository == 'TH-EY\/open-mercato'/)
  assert.match(workflow.jobs.deploy.if, /github\.ref == 'refs\/heads\/feat\/THOM-113-public-demo'/)
})

test('build is credential-free and deploy receives only narrow permissions after artifact verification', () => {
  assert.deepEqual(workflow.jobs.build.permissions, { contents: 'read' })
  assert.deepEqual(workflow.jobs.deploy.permissions, {
    'id-token': 'write',
    contents: 'read',
    actions: 'read',
  })
  assert.equal(workflow.jobs.deploy.needs, 'build')
  assert.doesNotMatch(
    workflow.jobs.build.steps.map((step) => `${step.uses ?? ''}\n${step.run ?? ''}`).join('\n'),
    /configure-aws-credentials|amazon-ecr-login|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY/,
  )

  const deployStepNames = workflow.jobs.deploy.steps.map((step) => step.name)
  assert.ok(
    deployStepNames.indexOf('Verify image artifact digest') <
      deployStepNames.indexOf('Configure exact-ref AWS credentials'),
  )
  assert.match(workflowSource, /vars\.PUBLIC_DEMO_APPROVED_SHA/)
  assert.match(workflowSource, /mask-aws-account-id: true/)
  assert.doesNotMatch(workflowSource, /AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN/)
})

test('AWS target guard evaluates the complete EC2 response without jq precedence drift', () => {
  const targetGuard = workflow.jobs.deploy.steps.find(
    (step) => step.name === 'Verify AWS target and host availability',
  )
  const jqProgram = targetGuard.run.match(/jq -e '\n([\s\S]*?)\n\s*' <<<"\$\{instance_json\}"/u)?.[1]
  assert.ok(jqProgram)

  const instance = {
    State: { Name: 'running' },
    MetadataOptions: {
      HttpTokens: 'required',
      HttpEndpoint: 'enabled',
      HttpPutResponseHopLimit: 1,
      State: 'applied',
    },
  }
  const evaluate = (document) => spawnSync('jq', ['-e', jqProgram], {
    input: JSON.stringify(document),
    encoding: 'utf8',
  })

  assert.equal(evaluate({ Reservations: [{ Instances: [instance] }] }).status, 0)
  assert.notEqual(
    evaluate({ Reservations: [{ Instances: [instance] }, { Instances: [instance] }] }).status,
    0,
  )
  assert.notEqual(evaluate({
    Reservations: [{ Instances: [{
      ...instance,
      MetadataOptions: { ...instance.MetadataOptions, HttpPutResponseHopLimit: 2 },
    }] }],
  }).status, 0)
})

test('consumer workspaces cannot import restricted email implementation subpaths', () => {
  for (const specifier of [
    '@open-mercato/shared/lib/email/ses',
    '@open-mercato/shared/lib/email/ses.js',
    '@open-mercato/shared/lib/email/ses.ts',
    '@open-mercato/shared/lib/email/ses.tsx',
    '@open-mercato/shared/lib/email/ses.js?x',
    '@open-mercato/shared/lib/email/ses.js#x',
    '@open-mercato/shared/lib/email/%73es',
    '@open-mercato/shared/lib/email/restricted-delivery',
    '@open-mercato/shared/lib/email/restricted-delivery.js',
    '@open-mercato/shared/lib/email/restricted-delivery.ts',
    '@open-mercato/shared/lib/email/restricted-delivery.tsx',
    '@open-mercato/shared/lib/email/restricted-delivery.js?x',
    '@open-mercato/shared/lib/email/restricted-delivery.js#x',
    '@open-mercato/shared/lib/email/%72estricted-delivery',
  ]) {
    const result = spawnSync(
      process.execPath,
      ['--input-type=module', '--eval', `await import(${JSON.stringify(specifier)})`],
      { cwd: 'apps/mercato', encoding: 'utf8' },
    )

    assert.notEqual(result.status, 0, specifier)
    assert.match(`${result.stdout}\n${result.stderr}`, /ERR_PACKAGE_PATH_NOT_EXPORTED/u, specifier)
  }
})

test('documented email facade paths remain importable from consumer workspaces', () => {
  for (const [specifier, exportedName] of [
    ['@open-mercato/shared/lib/email/send', 'sendEmail'],
    ['@open-mercato/shared/lib/email/send.js', 'sendEmail'],
    ['@open-mercato/shared/lib/email/send.ts', 'sendEmail'],
    ['@open-mercato/shared/lib/email/send.tsx', 'sendEmail'],
    ['@open-mercato/shared/lib/email/config', 'resolveDefaultEmailFromAddress'],
    ['@open-mercato/shared/lib/email/config.js', 'resolveDefaultEmailFromAddress'],
    ['@open-mercato/shared/lib/email/config.ts', 'resolveDefaultEmailFromAddress'],
    ['@open-mercato/shared/lib/email/config.tsx', 'resolveDefaultEmailFromAddress'],
  ]) {
    const result = spawnSync(
      process.execPath,
      ['--input-type=module', '--eval', `
        const imported = await import(${JSON.stringify(specifier)})
        if (typeof imported[${JSON.stringify(exportedName)}] !== 'function') process.exit(2)
      `],
      { cwd: 'apps/mercato', encoding: 'utf8' },
    )

    assert.equal(result.status, 0, `${specifier}\n${result.stdout}\n${result.stderr}`)
  }
})

test('deployment is first-provision-only and seals the immutable staged candidate', () => {
  const deploySteps = workflow.jobs.deploy.steps
  const stepNames = deploySteps.map((step) => step.name)
  const preflight = deploySteps.find((step) => step.name === 'Preflight isolated host namespace')
  const seal = deploySteps.find((step) => step.name === 'Seal first-provision staging')

  assert.ok(preflight)
  assert.ok(seal)
  assert.match(preflight.run, /\.first-provision-staged/)
  assert.match(
    preflight.run,
    /docker ps -aq --filter label=com\.docker\.compose\.project=openmercato-public-demo/,
  )
  assert.match(preflight.run, /for port in 4787 4788 4900/)
  assert.doesNotMatch(preflight.run, /openmercato-public-demo-\.\*\$\{port\}->|broker_container/)
  assert.match(seal.run, /printf 'deployment_sha=%q\\n' "\$\{GITHUB_SHA\}"/)
  assert.match(seal.run, /mktemp "\$\{workdir\}\/\.first-provision-staged\.tmp\.XXXXXX"/)
  assert.match(seal.run, /chmod 600 "\$\{temporary\}"/)
  assert.match(seal.run, /ln "\$\{temporary\}" "\$\{marker\}"/)
  assert.match(seal.run, /test "\$\(cat "\$\{marker\}"\)" = "\$\{deployment_sha\}"/)
  assert.ok(
    stepNames.indexOf('Probe candidate services in parallel') <
      stepNames.indexOf('Seal first-provision staging'),
  )
  assert.ok(
    stepNames.indexOf('Seal first-provision staging') <
      stepNames.indexOf('Stop unsuccessful pre-cutover candidate'),
  )
  assert.ok(
    stepNames.indexOf('Seal first-provision staging') <
      stepNames.indexOf('Remove protected host bootstrap files'),
  )
})

test('every external action is pinned to a full commit SHA', () => {
  const actions = Object.values(workflow.jobs).flatMap(actionSteps)
  assert.ok(actions.length >= 7)

  for (const step of actions) {
    assert.match(step.uses, /^[^@\s]+@[0-9a-f]{40}$/)
  }
})

test('image and registry handling stays immutable and removes credentials', () => {
  assert.match(workflowSource, /imageTag=\$\{GITHUB_SHA\}/)
  assert.match(workflowSource, /repository_uri\}@\$\{image_digest\}/)
  assert.doesNotMatch(workflowSource, /(?:tags?|APP_IMAGE|image_uri)=[^\n]*:latest|:\s*latest/)
  assert.doesNotMatch(workflowSource, /docker (?:image|container|system) prune/)
  assert.match(workflowSource, /trap logout_registry EXIT/)
  assert.match(workflowSource, /docker logout "\$\{registry\}"/)
  assert.match(workflowSource, /Remove runner registry credentials and image artifact/)
  const buildxStep = workflow.jobs.build.steps.find((step) => step.name === 'Set up Docker Buildx')
  assert.match(buildxStep.with['driver-opts'], /^image=moby\/buildkit:[^@]+@sha256:[0-9a-f]{64}$/)

  const dockerfileImages = [...dockerfileSource.matchAll(/^FROM\s+(\S+)/gm)].map((match) => match[1])
  assert.ok(dockerfileImages.length > 0)
  for (const image of dockerfileImages) {
    assert.match(image, /@sha256:[0-9a-f]{64}$/)
  }

  for (const serviceName of ['postgres', 'redis', 'meilisearch']) {
    assert.match(compose.services[serviceName].image, /@sha256:[0-9a-f]{64}$/)
  }
})

test('SSM runner requires one explicit instance and removes all local payload files', () => {
  assert.match(ssmRunnerSource, /INSTANCE_ID is required; target discovery is intentionally disabled/)
  assert.doesNotMatch(ssmRunnerSource, /describe-instances/)
  assert.match(ssmRunnerSource, /--instance-ids "\$\{INSTANCE_ID\}"/)
  assert.match(ssmRunnerSource, /--document-name AWS-RunShellScript/)
  assert.match(ssmRunnerSource, /trap cleanup EXIT/)
  assert.match(ssmRunnerSource, /trap handle_signal HUP INT TERM/)
  assert.match(ssmRunnerSource, /aws ssm cancel-command/)
  assert.match(ssmRunnerSource, /did not reach a terminal status after cancellation/)
  assert.match(ssmRunnerSource, /executionTimeout/)
  assert.doesNotMatch(ssmRunnerSource, /cloud-watch-output-config/)
})

test('Compose has seven long-running services plus one secret-scoped bootstrap with no cloud log expansion', () => {
  assert.equal(compose.name, 'openmercato-public-demo')
  assert.deepEqual(Object.keys(compose.services).sort(), [...expectedServices].sort())

  for (const [serviceName, service] of Object.entries(compose.services)) {
    assert.equal(service.container_name, `openmercato-public-demo-${serviceName}`)
    if (serviceName === 'aws-credential-broker') {
      assert.equal(service.network_mode, 'host')
      assert.equal(service.networks, undefined)
    } else {
      assert.deepEqual(service.networks, ['public_demo_network'])
    }
    assert.equal(service.logging.driver, 'local')
  }

  assert.deepEqual(compose.services.app.ports, ['${APP_PORT:-4787}:${CONTAINER_PORT:-3000}'])
  assert.deepEqual(compose.services.mcp.ports, ['${MCP_HOST_PORT:-4788}:3002'])
  assert.equal(compose.services.app.environment.EMAIL_STRATEGY, 'ses')
  assert.equal(compose.services.app.environment.AWS_EC2_METADATA_DISABLED, 'true')
  assert.equal(compose.services.worker.environment.AWS_EC2_METADATA_DISABLED, 'true')
  assert.equal(compose.services.mcp.environment.AWS_EC2_METADATA_DISABLED, 'true')
  assert.equal(compose.services.bootstrap.environment.AWS_EC2_METADATA_DISABLED, 'true')
  for (const serviceName of ['app', 'worker']) {
    assert.equal(
      compose.services[serviceName].environment.AWS_CONTAINER_CREDENTIALS_FULL_URI,
      'https://public-demo-aws-credential-broker:4900/credentials',
    )
    assert.equal(
      compose.services[serviceName].environment.AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE,
      '/run/aws-credential-broker/token',
    )
    assert.equal(compose.services[serviceName].environment.NODE_EXTRA_CA_CERTS, '/run/aws-credential-broker/ca.pem')
    assert.deepEqual(compose.services[serviceName].extra_hosts, ['public-demo-aws-credential-broker:host-gateway'])
  }
  assert.equal(compose.services.mcp.environment.AWS_CONTAINER_CREDENTIALS_FULL_URI, undefined)
  assert.equal(compose.services.mcp.environment.AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE, undefined)
  assert.equal(compose.services.app.environment.OM_AI_PROVIDER, 'openrouter')
  assert.equal(compose.services.app.environment.OM_AI_MODEL, 'meta-llama/llama-3.3-70b-instruct')
  assert.equal(compose.services.app.environment.MCP_SERVER_API_KEY_FILE, '/run/mcp-shared/mcp-api-key')
  assert.equal(compose.services.app.environment.MCP_SERVER_API_KEY, undefined)
  assert.ok(compose.services.app.volumes.includes('public_demo_mcp_shared:/run/mcp-shared:ro'))
  assert.match(compose.services.app.environment.DATABASE_URL, /PostgreSQL service/)
  assert.doesNotMatch(
    composeSource,
    /AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|openmercato-crm-|crm\.they\.dev|OM_GMAIL|opencode/i,
  )
  assert.equal(compose.services.app.environment.OM_INIT_SUPERADMIN_PASSWORD, undefined)
  assert.equal(compose.services.app.environment.OM_INIT_ADMIN_PASSWORD, undefined)
  assert.equal(compose.services.app.environment.OM_INIT_EMPLOYEE_PASSWORD, undefined)
  assert.match(compose.services.bootstrap.command.at(-1), /scripts\/public-demo\/init-or-migrate\.sh/)
  assert.match(compose.services.bootstrap.command.at(-1), /su -p omuser/)
  assert.deepEqual(compose.services.bootstrap.secrets, [
    'public_demo_superadmin_password',
    'public_demo_admin_password',
    'public_demo_employee_password',
  ])
  assert.equal(compose.services.bootstrap.restart, 'no')
  assert.equal(compose.services.mcp.environment.NODE_ENV, 'production')
  const broker = compose.services['aws-credential-broker']
  assert.equal(broker.user, '1001:1001')
  assert.equal(broker.read_only, true)
  assert.deepEqual(broker.cap_drop, ['ALL'])
  assert.deepEqual(broker.security_opt, ['no-new-privileges:true'])
  assert.equal(broker.ports, undefined)
  assert.equal(broker.environment.AWS_CREDENTIAL_BROKER_PORT, '4900')
  assert.equal(broker.environment.AWS_CREDENTIAL_BROKER_TOKEN_FILE, '/run/aws-credential-broker/token')
  assert.equal(broker.environment.NODE_EXTRA_CA_CERTS, '/run/aws-credential-broker/ca.pem')
  for (const serviceName of longRunningApplicationServices) {
    assert.equal(compose.services[serviceName].user, '1001:1001')
    assert.deepEqual(compose.services[serviceName].cap_drop, ['ALL'])
    assert.deepEqual(compose.services[serviceName].security_opt, ['no-new-privileges:true'])
  }
})

test('public workflow contains references, never secret values or private infrastructure identifiers', () => {
  assert.doesNotMatch(workflowSource, /\b\d{12}\b|i-[0-9a-f]{17}|arn:aws:secretsmanager:/)
  assert.match(workflowSource, /secrets\.PUBLIC_DEMO_INSTANCE_ID/)
  assert.match(workflowSource, /secrets\.PUBLIC_DEMO_OPENROUTER_SECRET_ID/)
  assert.match(workflowSource, /secrets\.AWS_PUBLIC_DEMO_WORKLOAD_ROLE_ARN/)
  assert.doesNotMatch(workflowSource, /PUBLIC_DEMO_MCP_SECRET_ID/)
  assert.match(workflowSource, /set \+x/)
  assert.match(workflowSource, /umask 077/)
  assert.match(workflowSource, /chmod 600/)
  assert.match(workflowSource, /steps\.prepare-runtime\.outcome != 'skipped'/)
  assert.match(workflowSource, /Remove protected host bootstrap files/)
  assert.match(workflowSource, /trap cleanup_prepare EXIT HUP INT TERM/)
  assert.match(workflowSource, /prepare_complete=1/)
  assert.match(workflowSource, /wait_for_stable_running_container/)
  assert.match(workflowSource, /restart count.*60 seconds/)
  assert.match(workflowSource, /openssl rand -hex 32/)
  assert.match(workflowSource, /subjectAltName=DNS:public-demo-aws-credential-broker/)
  assert.match(workflowSource, /for port in 4787 4788 4900/)
  assert.match(workflowSource, /docker network inspect bridge/)
  assert.match(workflowSource, /MetadataOptions\.HttpTokens == "required"/)
  assert.match(workflowSource, /MetadataOptions\.HttpEndpoint == "enabled"/)
  assert.match(workflowSource, /MetadataOptions\.HttpPutResponseHopLimit == 1/)
  assert.match(workflowSource, /MetadataOptions\.State == "applied"/)
  assert.match(workflowSource, /logout_registry\n\s+trap - EXIT/)
  assert.match(workflowSource, /job\.status != 'success'/)
  assert.match(workflowSource, /Refusing to remove runtime config while public-demo containers remain/)
})

test('bootstrap hides credential-bearing output and records completion only after role read-back', () => {
  assert.match(bootstrapSource, /umask 077/)
  assert.match(bootstrapSource, /trap cleanup EXIT HUP INT TERM/)
  assert.match(bootstrapSource, /yarn mercato init --no-examples/)
  assert.match(bootstrapSource, /yarn mercato customers seed-examples/)
  assert.match(bootstrapSource, /yarn mercato catalog seed-examples-bundle/)
  assert.match(bootstrapSource, /PUBLIC_DEMO_ROLE_LINK_COUNT_INVALID/)
  assert.match(bootstrapSource, /bootstrap-state\.mjs/)
  assert.match(bootstrapStateSource, /pg_try_advisory_lock/)
  assert.match(bootstrapStateSource, /PUBLIC_DEMO_DATABASE_GUARD_MISMATCH/)
  assert.doesNotMatch(bootstrapSource, /reset-empty|DROP SCHEMA|DELETE FROM/i)
  assert.doesNotMatch(bootstrapStateSource, /reset-empty|DROP SCHEMA|DELETE FROM/i)
  assert.ok(
    bootstrapSource.indexOf('PUBLIC_DEMO_ROLE_LINK_COUNT_INVALID') <
      bootstrapSource.indexOf('> "${marker_file}"'),
  )
  assert.doesNotMatch(bootstrapSource, /cat\s+"?\$\{?log_file/i)
  assert.doesNotMatch(bootstrapSource, /Password:/)
  assert.match(
    dockerfileSource,
    /COPY --from=builder \/app\/scripts\/public-demo\/init-or-migrate\.sh \.\/scripts\/public-demo\/init-or-migrate\.sh/,
  )
  assert.match(
    dockerfileSource,
    /COPY --from=builder \/app\/scripts\/public-demo\/aws-credential-broker\.mjs \.\/scripts\/public-demo\/aws-credential-broker\.mjs/,
  )
})

test('app and worker share the exact fail-closed SES recipient and quota policy', () => {
  for (const serviceName of ['app', 'worker']) {
    const environment = compose.services[serviceName].environment
    assert.equal(environment.EMAIL_DELIVERY_POLICY, 'restricted')
    assert.equal(environment.EMAIL_DELIVERY_POLICY_KEY, 'openmercato-public-demo-v1')
    assert.equal(environment.EMAIL_ALLOWED_RECIPIENT, 'success@simulator.amazonses.com')
    assert.equal(environment.EMAIL_ALLOWED_FROM, '${EMAIL_FROM:?EMAIL_FROM must be set}')
    assert.equal(environment.EMAIL_DELIVERY_LIMIT, '10')
    assert.equal(environment.EMAIL_DELIVERY_WINDOW_SECONDS, '86400')
  }
})

test('credential broker fails closed around token, TLS, refresh, and STS output', () => {
  assert.match(credentialBrokerSource, /timingSafeEqual/)
  assert.match(credentialBrokerSource, /createHash\('sha256'\)/)
  assert.match(credentialBrokerSource, /request\.method !== 'GET'/)
  assert.match(credentialBrokerSource, /request\.url !== DEFAULT_PATH/)
  assert.match(credentialBrokerSource, /cache-control': 'no-store'/)
  assert.match(credentialBrokerSource, /RoleSessionName: 'openmercato-public-demo'/)
  assert.match(credentialBrokerSource, /DurationSeconds: 900/)
  assert.match(credentialBrokerSource, /refreshWindowMs/)
  assert.match(credentialBrokerSource, /AWS_CREDENTIAL_BROKER_STS_TIMEOUT_MS/)
  assert.doesNotMatch(credentialBrokerSource, /console\.(?:log|error)|SecretAccessKey.*stdout|SessionToken.*stdout/)
})
