import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const iamScript = path.resolve('scripts/public-demo/provision-iam.sh')
const parametersScript = path.resolve('scripts/public-demo/create-runtime-parameters.sh')
const routingScript = path.resolve('scripts/public-demo/cutover-routing.sh')

function source(file) {
  return fs.readFileSync(file, 'utf8')
}

function makeHarness(awsBody) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'public-demo-aws-'))
  const binDir = path.join(root, 'bin')
  const callsFile = path.join(root, 'calls.log')
  fs.mkdirSync(binDir)
  fs.writeFileSync(path.join(binDir, 'aws'), `#!/usr/bin/env bash\nset -euo pipefail\n${awsBody}\n`, {
    mode: 0o755,
  })
  fs.writeFileSync(path.join(binDir, 'sleep'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  return { root, binDir, callsFile }
}

function run(script, args, harness, env, input) {
  return spawnSync('bash', [script, ...args], {
    encoding: 'utf8',
    input,
    env: {
      ...process.env,
      PATH: `${harness.binDir}:${process.env.PATH}`,
      FAKE_CALLS_FILE: harness.callsFile,
      ...env,
    },
  })
}

function hostReadbackEnv(harness) {
  const runner = path.join(harness.root, 'passing-ssm-runner')
  fs.writeFileSync(runner, '#!/bin/sh\ncat >/dev/null\nexit 0\n', { mode: 0o755 })
  const digest = `sha256:${'b'.repeat(64)}`
  return {
    PUBLIC_DEMO_SSM_RUNNER: runner,
    EXPECTED_DEPLOYMENT_SHA: 'a'.repeat(40),
    EXPECTED_IMAGE_URI: `registry.example/openmercato@${digest}`,
    EXPECTED_IMAGE_DIGEST: digest,
  }
}

test('IAM provisioning contains exact trust and least-privilege resource boundaries', () => {
  const script = source(iamScript)

  assert.match(script, /repo:TH-EY\/open-mercato:ref:refs\/heads\/feat\/THOM-113-public-demo/)
  assert.match(script, /token\.actions\.githubusercontent\.com:aud/)
  assert.match(script, /token\.actions\.githubusercontent\.com:sub/)
  assert.match(script, /AWS-RunShellScript/)
  assert.match(script, /ecr:GetAuthorizationToken/)
  assert.match(script, /secretsmanager:GetSecretValue/)
  assert.match(script, /sts:AssumeRole/)
  assert.match(script, /ses:SendEmail/)
  assert.match(script, /ses:FromAddress/)
  assert.match(script, /ses:Recipients/)
  assert.match(script, /success@simulator\.amazonses\.com/)
  assert.match(script, /no-reply@they\.dev/)
  assert.match(script, /ec2 describe-instances/)
  assert.match(script, /iam get-instance-profile/)
  assert.doesNotMatch(script, /MCP_SECRET|mcp.*secret/i)
  assert.doesNotMatch(script, /ssm:GetParameter/)
  assert.doesNotMatch(script, /secretsmanager:(?:List|Put|Update|Delete|Rotate)/)
  assert.doesNotMatch(script, /\b\d{12}\b|i-[0-9a-f]{17}|arn:aws:secretsmanager:[^"']+/)
  assert.match(script, /umask 077/)
  assert.match(script, /chmod 600/)
  assert.match(script, /trap cleanup EXIT/)
  assert.match(script, /list-role-policies/)
  assert.match(script, /list-attached-role-policies/)
})

function iamEnv() {
  return {
    AWS_PARTITION: 'aws',
    AWS_REGION: 'test-region-1',
    AWS_ACCOUNT_ID: '123456789012',
    OIDC_PROVIDER_ARN: 'arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com',
    DEPLOY_ROLE_NAME: 'public-demo-deploy',
    HOST_ROLE_NAME: 'public-demo-host',
    WORKLOAD_ROLE_NAME: 'public-demo-workload',
    INSTANCE_ID: 'i-test123',
    ECR_REPOSITORY: 'openmercato-app',
    OPENROUTER_SECRET_ARN: 'arn:aws:secretsmanager:test-region-1:123456789012:secret:openrouter-test',
    SES_IDENTITY_ARN: 'arn:aws:ses:test-region-1:123456789012:identity/they.dev',
  }
}

for (const scenario of [
  {
    name: 'missing host role',
    hostError: 'NoSuchEntity: host role is absent',
    expectedError: /HOST_ROLE_NAME does not exist/,
  },
  {
    name: 'unexpected host role read error',
    hostError: 'AccessDenied: host role read denied',
    expectedError: /AccessDenied: host role read denied/,
  },
]) {
  test(`IAM provisioning fails closed on ${scenario.name}`, () => {
    const harness = makeHarness(String.raw`
printf '%s\n' "$*" >> "$FAKE_CALLS_FILE"
if [[ "$1 $2" == "ec2 describe-instances" ]]; then
  printf '%s\n' 'arn:aws:iam::123456789012:instance-profile/public-demo-profile'
  exit 0
fi
if [[ "$1 $2" == "iam get-instance-profile" ]]; then
  printf '%s\n' '{"InstanceProfile":{"Roles":[{"RoleName":"public-demo-host","Arn":"arn:aws:iam::123456789012:role/public-demo-host"}]}}'
  exit 0
fi
if [[ "$1 $2" == "iam get-role" ]]; then
  if [[ "$*" == *"public-demo-deploy"* ]]; then
    echo 'NoSuchEntity: deploy role is absent' >&2
  elif [[ "$*" == *"public-demo-workload"* ]]; then
    echo 'NoSuchEntity: workload role is absent' >&2
  else
    echo "$FAKE_HOST_ERROR" >&2
  fi
  exit 254
fi
if [[ "$1 $2" == "iam get-role-policy" ]]; then
  echo 'NoSuchEntity: policy is absent' >&2
  exit 254
fi
if [[ "$1 $2" == "iam list-role-policies" ]]; then
  if [[ "$*" == *"public-demo-deploy"* ]]; then
    printf '%s\n' '{"PolicyNames":["OpenMercatoPublicDemoDeploy"]}'
  else
    printf '%s\n' '{"PolicyNames":["OpenMercatoPublicDemoSesSend"]}'
  fi
  exit 0
fi
if [[ "$1 $2" == "iam list-attached-role-policies" ]]; then
  printf '%s\n' '{"AttachedPolicies":[]}'
  exit 0
fi
case "$1 $2" in
  "iam create-role"|"iam put-role-policy"|"iam delete-role-policy"|"iam delete-role") printf '%s\n' '{}' ;;
  *) exit 2 ;;
esac`)

    try {
      const result = run(iamScript, [], harness, {
        ...iamEnv(),
        FAKE_HOST_ERROR: scenario.hostError,
      })
      assert.notEqual(result.status, 0)
      assert.match(result.stderr, scenario.expectedError)
      const calls = fs.readFileSync(harness.callsFile, 'utf8')
      assert.doesNotMatch(calls, /put-role-policy .*public-demo-host/)
      assert.match(calls, /get-role .*public-demo-workload/)
      assert.match(calls, /get-role .*public-demo-deploy/)
    } finally {
      fs.rmSync(harness.root, { recursive: true, force: true })
    }
  })
}

test('IAM provisioning refuses a host role not bound to the exact instance', () => {
  const harness = makeHarness(String.raw`
printf '%s\n' "$*" >> "$FAKE_CALLS_FILE"
if [[ "$1 $2" == "ec2 describe-instances" ]]; then
  printf '%s\n' 'arn:aws:iam::123456789012:instance-profile/public-demo-profile'
  exit 0
fi
if [[ "$1 $2" == "iam get-instance-profile" ]]; then
  printf '%s\n' '{"InstanceProfile":{"Roles":[{"RoleName":"different-host-role","Arn":"arn:aws:iam::123456789012:role/different-host-role"}]}}'
  exit 0
fi
exit 2`)

  try {
    const result = run(iamScript, [], harness, iamEnv())
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /not bound to the exact HOST_ROLE_NAME/)
    const calls = fs.readFileSync(harness.callsFile, 'utf8')
    assert.doesNotMatch(calls, /create-role|put-role-policy/)
  } finally {
    fs.rmSync(harness.root, { recursive: true, force: true })
  }
})

test('IAM provisioning creates one exact simulator-only workload boundary', () => {
  const harness = makeHarness(String.raw`
printf '%s\n' "$*" >> "$FAKE_CALLS_FILE"
case "$1 $2" in
  "ec2 describe-instances")
    printf '%s\n' 'arn:aws:iam::123456789012:instance-profile/public-demo-profile'
    ;;
  "iam get-instance-profile")
    printf '%s\n' '{"InstanceProfile":{"Roles":[{"RoleName":"public-demo-host","Arn":"arn:aws:iam::123456789012:role/public-demo-host"}]}}'
    ;;
  "iam get-role")
    if [[ "$*" == *"public-demo-host"* ]]; then
      printf '%s\n' '{}'
    else
      echo 'NoSuchEntity: role is absent' >&2
      exit 254
    fi
    ;;
  "iam get-role-policy")
    echo 'NoSuchEntity: policy is absent' >&2
    exit 254
    ;;
  "iam list-role-policies")
    if [[ "$*" == *"public-demo-deploy"* ]]; then
      printf '%s\n' '{"PolicyNames":["OpenMercatoPublicDemoDeploy"]}'
    else
      printf '%s\n' '{"PolicyNames":["OpenMercatoPublicDemoSesSend"]}'
    fi
    ;;
  "iam list-attached-role-policies")
    printf '%s\n' '{"AttachedPolicies":[]}'
    ;;
  "iam create-role"|"iam put-role-policy")
    input=""
    while (($#)); do
      if [[ "$1" == "--policy-document" || "$1" == "--assume-role-policy-document" ]]; then
        input="$(printf '%s' "$2" | sed 's#^file://##')"
        break
      fi
      shift
    done
    test -n "$input"
    cp "$input" "$FAKE_CALLS_FILE.payload.$(find "$(dirname "$FAKE_CALLS_FILE")" -name 'calls.log.payload.*' | wc -l)"
    printf '%s\n' '{}'
    ;;
  *) exit 2 ;;
esac`)

  try {
    const result = run(iamScript, [], harness, iamEnv())
    assert.equal(result.status, 0, result.stderr)
    const payloads = fs
      .readdirSync(harness.root)
      .filter((name) => name.startsWith('calls.log.payload.'))
      .map((name) => JSON.parse(fs.readFileSync(path.join(harness.root, name), 'utf8')))

    const workloadTrust = payloads.find((payload) =>
      payload.Statement?.[0]?.Principal?.AWS === 'arn:aws:iam::123456789012:role/public-demo-host')
    assert.deepEqual(workloadTrust.Statement, [{
      Effect: 'Allow',
      Principal: { AWS: 'arn:aws:iam::123456789012:role/public-demo-host' },
      Action: 'sts:AssumeRole',
    }])

    const workloadPolicy = payloads.find((payload) => payload.Statement?.[0]?.Sid === 'ExactSimulatorDelivery')
    assert.deepEqual(workloadPolicy.Statement, [{
      Sid: 'ExactSimulatorDelivery',
      Effect: 'Allow',
      Action: 'ses:SendEmail',
      Resource: 'arn:aws:ses:test-region-1:123456789012:identity/they.dev',
      Condition: {
        StringEquals: { 'ses:FromAddress': 'no-reply@they.dev' },
        'ForAllValues:StringEquals': {
          'ses:Recipients': ['success@simulator.amazonses.com'],
        },
        Null: { 'ses:Recipients': 'false' },
      },
    }])

    const hostPolicy = payloads.find((payload) =>
      payload.Statement?.some((statement) => statement.Sid === 'AssumeExactPublicDemoWorkloadRole'))
    assert.deepEqual(hostPolicy.Statement[1], {
      Sid: 'AssumeExactPublicDemoWorkloadRole',
      Effect: 'Allow',
      Action: 'sts:AssumeRole',
      Resource: 'arn:aws:iam::123456789012:role/public-demo-workload',
    })
  } finally {
    fs.rmSync(harness.root, { recursive: true, force: true })
  }
})

test('IAM provisioning rejects additional policies on a dedicated role', () => {
  const harness = makeHarness(String.raw`
printf '%s\n' "$*" >> "$FAKE_CALLS_FILE"
case "$1 $2" in
  "ec2 describe-instances")
    printf '%s\n' 'arn:aws:iam::123456789012:instance-profile/public-demo-profile'
    ;;
  "iam get-instance-profile")
    printf '%s\n' '{"InstanceProfile":{"Roles":[{"RoleName":"public-demo-host","Arn":"arn:aws:iam::123456789012:role/public-demo-host"}]}}'
    ;;
  "iam get-role")
    if [[ "$*" == *"public-demo-host"* ]]; then printf '%s\n' '{}'; else echo 'NoSuchEntity' >&2; exit 254; fi
    ;;
  "iam get-role-policy")
    echo 'NoSuchEntity' >&2
    exit 254
    ;;
  "iam create-role"|"iam put-role-policy"|"iam delete-role-policy"|"iam delete-role")
    printf '%s\n' '{}'
    ;;
  "iam list-role-policies")
    if [[ "$*" == *"public-demo-deploy"* ]]; then
      printf '%s\n' '{"PolicyNames":["OpenMercatoPublicDemoDeploy"]}'
    else
      printf '%s\n' '{"PolicyNames":["OpenMercatoPublicDemoSesSend","UnexpectedAllow"]}'
    fi
    ;;
  "iam list-attached-role-policies")
    printf '%s\n' '{"AttachedPolicies":[]}'
    ;;
  *) exit 2 ;;
esac`)

  try {
    const result = run(iamScript, [], harness, iamEnv())
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /policies outside the exact approved set/)
    const calls = fs.readFileSync(harness.callsFile, 'utf8')
    assert.match(calls, /get-role .*public-demo-workload/)
    assert.match(calls, /get-role .*public-demo-deploy/)
  } finally {
    fs.rmSync(harness.root, { recursive: true, force: true })
  }
})

for (const lostOperation of ['create-role', 'put-role-policy']) {
  test(`IAM rollback reconciles an accepted ${lostOperation} with a lost response`, () => {
    const harness = makeHarness(String.raw`
printf '%s\n' "$*" >> "$FAKE_CALLS_FILE"
argument() {
  local wanted="$1"
  shift
  while (($#)); do
    if [[ "$1" == "$wanted" ]]; then printf '%s' "$2"; return; fi
    shift
  done
}
role_name="$(argument --role-name "$@")"
policy_name="$(argument --policy-name "$@")"
case "$1 $2" in
  "ec2 describe-instances")
    printf '%s\n' 'arn:aws:iam::123456789012:instance-profile/public-demo-profile'
    ;;
  "iam get-instance-profile")
    printf '%s\n' '{"InstanceProfile":{"Roles":[{"RoleName":"public-demo-host","Arn":"arn:aws:iam::123456789012:role/public-demo-host"}]}}'
    ;;
  "iam get-role")
    if [[ "$role_name" == "public-demo-host" ]]; then
      printf '%s\n' '{}'
    elif [[ -f "$FAKE_STATE_DIR/$role_name.trust" && -f "$FAKE_STATE_DIR/$role_name.hide-once" ]]; then
      rm -f "$FAKE_STATE_DIR/$role_name.hide-once"
      echo 'NoSuchEntity: role is not visible yet' >&2
      exit 254
    elif [[ -f "$FAKE_STATE_DIR/$role_name.trust" ]]; then
      cat "$FAKE_STATE_DIR/$role_name.trust"
    else
      echo 'NoSuchEntity: role is absent' >&2
      exit 254
    fi
    ;;
  "iam create-role")
    trust_file="$(argument --assume-role-policy-document "$@")"
    trust_path="$(printf '%s' "$trust_file" | sed 's#^file://##')"
    cp "$trust_path" "$FAKE_STATE_DIR/$role_name.trust"
    if [[ "$FAKE_LOST_OPERATION" == "create-role" ]]; then
      touch "$FAKE_STATE_DIR/$role_name.hide-once"
      echo 'simulated lost create-role response' >&2
      exit 255
    fi
    printf '%s\n' '{}'
    ;;
  "iam get-role-policy")
    if [[ -f "$FAKE_STATE_DIR/$role_name.$policy_name.policy" && -f "$FAKE_STATE_DIR/$role_name.$policy_name.hide-once" ]]; then
      rm -f "$FAKE_STATE_DIR/$role_name.$policy_name.hide-once"
      echo 'NoSuchEntity: policy is not visible yet' >&2
      exit 254
    elif [[ -f "$FAKE_STATE_DIR/$role_name.$policy_name.policy" ]]; then
      cat "$FAKE_STATE_DIR/$role_name.$policy_name.policy"
    else
      echo 'NoSuchEntity: policy is absent' >&2
      exit 254
    fi
    ;;
  "iam put-role-policy")
    policy_file="$(argument --policy-document "$@")"
    policy_path="$(printf '%s' "$policy_file" | sed 's#^file://##')"
    cp "$policy_path" "$FAKE_STATE_DIR/$role_name.$policy_name.policy"
    if [[ "$FAKE_LOST_OPERATION" == "put-role-policy" ]]; then
      touch "$FAKE_STATE_DIR/$role_name.$policy_name.hide-once"
      echo 'simulated lost put-role-policy response' >&2
      exit 255
    fi
    printf '%s\n' '{}'
    ;;
  "iam delete-role-policy")
    rm -f "$FAKE_STATE_DIR/$role_name.$policy_name.policy"
    ;;
  "iam delete-role")
    rm -f "$FAKE_STATE_DIR/$role_name.trust"
    ;;
  *) exit 2 ;;
esac`)

    try {
      const result = run(iamScript, [], harness, {
        ...iamEnv(),
        FAKE_STATE_DIR: harness.root,
        FAKE_LOST_OPERATION: lostOperation,
      })
      assert.notEqual(result.status, 0)
      assert.match(result.stderr, new RegExp(`simulated lost ${lostOperation} response`))
      assert.equal(fs.existsSync(path.join(harness.root, 'public-demo-deploy.trust')), false)
      assert.equal(
        fs.existsSync(path.join(harness.root, 'public-demo-deploy.OpenMercatoPublicDemoDeploy.policy')),
        false,
      )
      const calls = fs.readFileSync(harness.callsFile, 'utf8')
      assert.match(calls, new RegExp(`iam ${lostOperation}`))
      assert.match(calls, /iam delete-role .*public-demo-deploy/)
      if (lostOperation === 'put-role-policy') {
        assert.match(calls, /iam delete-role-policy .*OpenMercatoPublicDemoDeploy/)
      }
    } finally {
      fs.rmSync(harness.root, { recursive: true, force: true })
    }
  })
}

test('runtime parameters are created as exact Standard SecureStrings without values in arguments or output', () => {
  const harness = makeHarness(String.raw`
printf '%s\n' "$*" >> "$FAKE_CALLS_FILE"
if [[ "$1 $2" == "ssm describe-parameters" ]]; then
  printf '%s\n' '{"Parameters":[]}'
  exit 0
fi
if [[ "$1 $2" == "ssm put-parameter" ]]; then
  input=""
  while (($#)); do
    if [[ "$1" == "--cli-input-json" ]]; then input="$(printf '%s' "$2" | sed 's#^file://##')"; break; fi
    shift
  done
  test -n "$input"
  stat -f '%Lp' "$input" >> "$FAKE_CALLS_FILE"
  cp "$input" "$FAKE_CALLS_FILE.$(wc -l < "$FAKE_CALLS_FILE")"
  printf '%s\n' '{"Version":1}'
  exit 0
fi
exit 2`)
  const protectedValues = {
    PUBLIC_DEMO_POSTGRES_PASSWORD: 'postgres-secret-value',
    PUBLIC_DEMO_JWT_SECRET: 'jwt-secret-value',
    PUBLIC_DEMO_TENANT_DATA_ENCRYPTION_KEY: 'tenant-secret-value',
    PUBLIC_DEMO_MEILISEARCH_MASTER_KEY: 'meili-secret-value',
    PUBLIC_DEMO_INITIAL_ADMIN_PASSWORD: 'superadmin-secret-value',
    PUBLIC_DEMO_ADMIN_PASSWORD: 'admin-secret-value',
    PUBLIC_DEMO_EMPLOYEE_PASSWORD: 'employee-secret-value',
    PUBLIC_DEMO_OM_HUB_OAUTH_STATE_KEY: 'oauth-secret-value',
  }

  try {
    const result = run(
      parametersScript,
      [],
      harness,
      { AWS_REGION: 'test-region-1' },
      `${Object.values(protectedValues).join('\n')}\n`,
    )
    assert.equal(result.status, 0, result.stderr)

    const combinedOutput = `${result.stdout}\n${result.stderr}`
    const calls = fs.readFileSync(harness.callsFile, 'utf8')
    for (const value of Object.values(protectedValues)) {
      assert.doesNotMatch(combinedOutput, new RegExp(value))
      assert.doesNotMatch(calls, new RegExp(value))
    }
    assert.doesNotMatch(source(parametersScript), /PUBLIC_DEMO_(?:PARAMETER_VALUE|POSTGRES_PASSWORD|JWT_SECRET)/)

    const payloads = fs
      .readdirSync(harness.root)
      .filter((name) => name.startsWith('calls.log.'))
      .map((name) => JSON.parse(fs.readFileSync(path.join(harness.root, name), 'utf8')))
    assert.equal(payloads.length, 8)
    assert.deepEqual(
      payloads.map((payload) => payload.Name).sort(),
      [
        '/openmercato-public-demo/runtime/admin-password',
        '/openmercato-public-demo/runtime/employee-password',
        '/openmercato-public-demo/runtime/initial-admin-password',
        '/openmercato-public-demo/runtime/jwt-secret',
        '/openmercato-public-demo/runtime/meilisearch-master-key',
        '/openmercato-public-demo/runtime/om-hub-oauth-state-key',
        '/openmercato-public-demo/runtime/postgres-password',
        '/openmercato-public-demo/runtime/tenant-data-encryption-key',
      ],
    )
    for (const payload of payloads) {
      assert.equal(payload.Type, 'SecureString')
      assert.equal(payload.Tier, 'Standard')
      assert.equal(payload.Overwrite, false)
    }
    assert.equal(calls.match(/^600$/gm)?.length, 8)
  } finally {
    fs.rmSync(harness.root, { recursive: true, force: true })
  }
})

test('runtime parameters reuse all exact existing metadata without requiring or reading values', () => {
  const harness = makeHarness(String.raw`
printf '%s\n' "$*" >> "$FAKE_CALLS_FILE"
if [[ "$1 $2" == "ssm describe-parameters" ]]; then
  filter=""
  while (($#)); do
    if [[ "$1" == "--parameter-filters" ]]; then filter="$2"; break; fi
    shift
  done
  name="$(printf '%s' "$filter" | sed 's/^.*Values=//')"
  printf '{"Parameters":[{"Name":"%s","Type":"SecureString","Tier":"Standard"}]}\n' "$name"
  exit 0
fi
exit 2`)

  try {
    const result = run(parametersScript, [], harness, { AWS_REGION: 'test-region-1' })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout.match(/Reusing existing Standard SecureString/g)?.length, 8)
    const calls = fs.readFileSync(harness.callsFile, 'utf8')
    assert.equal(calls.match(/describe-parameters/g)?.length, 8)
    assert.doesNotMatch(calls, /put-parameter|get-parameter|--with-decryption/)
  } finally {
    fs.rmSync(harness.root, { recursive: true, force: true })
  }
})

test('routing contract is exact and cannot mutate shared DNS, certificates, or security groups', () => {
  const script = source(routingScript)

  for (const token of [
    'om-demo-public-demo',
    'om-demo-public-demo-mcp',
    'public-demo.om.they.dev',
    '4787',
    '4788',
    '4900',
    '1007',
    '1008',
    '/login',
    '/health',
    'LOAD_BALANCER_ARN',
    'LOAD_BALANCER_SECURITY_GROUP_ID',
    'LISTENER_SSL_POLICY',
    'describe-listeners',
    'describe-listener-certificates',
    'describe-load-balancers',
    'describe-certificate',
    'describe-security-group-rules',
    'RegexValues',
  ]) {
    assert.match(script, new RegExp(token.replace('/', '\\/')))
  }
  assert.match(script, /preflight\|cutover\|readback\|rollback/)
  assert.match(script, /wait target-in-service/)
  assert.match(script, /https:\/\/\$\{public_host\}\/login/)
  assert.match(script, /https:\/\/\$\{public_host\}\/mcp/)
  assert.match(script, /mcp_status.*== "401"/)
  assert.doesNotMatch(script, /route53|acm (?:delete|request|import|add|remove)|authorize-security-group|revoke-security-group|delete-security-group/)
  assert.doesNotMatch(script, /(?:docker|aws)[^\n]*(?:prune|delete-target-group)/)
})

test('routing preflight rejects non-TLS listeners, direct ingress, and wildcard or regex host collisions', () => {
  const harness = makeHarness(String.raw`
printf '%s\n' "$*" >> "$FAKE_CALLS_FILE"
case "$1 $2" in
  "ec2 describe-instances")
    printf '%s\n' '{"Reservations":[{"Instances":[{"InstanceId":"i-test","VpcId":"vpc-test","State":{"Name":"running"},"SecurityGroups":[{"GroupId":"sg-instance"}]}]}]}'
    ;;
  "ec2 describe-security-group-rules")
    printf '{"SecurityGroupRules":[{"IsEgress":false,"IpProtocol":"tcp","FromPort":%s,"ToPort":%s,"ReferencedGroupInfo":{"GroupId":"%s"}}]}\n' "$FAKE_INGRESS_FROM_PORT" "$FAKE_INGRESS_TO_PORT" "$FAKE_INGRESS_SOURCE"
    ;;
  "elbv2 describe-listeners")
    printf '{"Listeners":[{"ListenerArn":"arn:test:listener","LoadBalancerArn":"arn:test:load-balancer","Protocol":"%s","Port":%s,"SslPolicy":"ELBSecurityPolicy-TLS13-1-2-2021-06","Certificates":[{"CertificateArn":"arn:test:default-certificate"}]}]}\n' "$FAKE_LISTENER_PROTOCOL" "$FAKE_LISTENER_PORT"
    ;;
  "elbv2 describe-listener-certificates")
    printf '%s\n' '{"Certificates":[{"CertificateArn":"arn:test:default-certificate","IsDefault":true},{"CertificateArn":"arn:test:certificate","IsDefault":false}]}'
    ;;
  "elbv2 describe-load-balancers")
    printf '%s\n' '{"LoadBalancers":[{"LoadBalancerArn":"arn:test:load-balancer","VpcId":"vpc-test","Type":"application","Scheme":"internet-facing","State":{"Code":"active"},"SecurityGroups":["sg-alb"]}]}'
    ;;
  "acm describe-certificate")
    if [[ "$*" == *"default-certificate"* ]]; then
      printf '%s\n' '{"Certificate":{"DomainName":"crm.they.dev","SubjectAlternativeNames":["crm.they.dev"]}}'
    else
      printf '%s\n' '{"Certificate":{"DomainName":"*.om.they.dev","SubjectAlternativeNames":["*.om.they.dev"]}}'
    fi
    ;;
  "elbv2 describe-target-groups")
    echo 'TargetGroupNotFound' >&2
    exit 254
    ;;
  "elbv2 describe-rules") printf '%s\n' "$FAKE_RULES_JSON" ;;
  *) exit 2 ;;
esac`)
  const baseEnv = {
    AWS_REGION: 'test-region-1',
    INSTANCE_ID: 'i-test',
    VPC_ID: 'vpc-test',
    LOAD_BALANCER_ARN: 'arn:test:load-balancer',
    LISTENER_ARN: 'arn:test:listener',
    LOAD_BALANCER_SECURITY_GROUP_ID: 'sg-alb',
    LISTENER_SSL_POLICY: 'ELBSecurityPolicy-TLS13-1-2-2021-06',
    FAKE_LISTENER_PROTOCOL: 'HTTPS',
    FAKE_LISTENER_PORT: '443',
    FAKE_INGRESS_SOURCE: 'sg-alb',
    FAKE_INGRESS_FROM_PORT: '4787',
    FAKE_INGRESS_TO_PORT: '4788',
    FAKE_RULES_JSON: '{"Rules":[{"Priority":"default","Conditions":[],"Actions":[]}]}',
  }

  try {
    const valid = run(routingScript, ['preflight'], harness, baseEnv)
    assert.equal(valid.status, 0, valid.stderr)

    for (const scenario of [
      {
        name: 'HTTP listener',
        env: { FAKE_LISTENER_PROTOCOL: 'HTTP', FAKE_LISTENER_PORT: '80' },
        error: /exact HTTPS\/443 listener/,
      },
      {
        name: 'non-ALB ingress source',
        env: { FAKE_INGRESS_SOURCE: 'sg-public' },
        error: /exposes or incompletely scopes ports/,
      },
      {
        name: 'credential broker ingress',
        env: { FAKE_INGRESS_FROM_PORT: '4787', FAKE_INGRESS_TO_PORT: '4900' },
        error: /exposes credential broker port 4900/,
      },
      {
        name: 'wildcard collision',
        env: {
          FAKE_RULES_JSON: '{"Rules":[{"Priority":"2","Conditions":[{"Field":"host-header","Values":["*.om.they.dev"]}],"Actions":[]}]}',
        },
        error: /hostname is already used/,
      },
      {
        name: 'regex collision',
        env: {
          FAKE_RULES_JSON: '{"Rules":[{"Priority":"2","Conditions":[{"Field":"host-header","RegexValues":["public-demo[.]om[.]they[.]dev"]}],"Actions":[]}]}',
        },
        error: /hostname is already used/,
      },
    ]) {
      const result = run(routingScript, ['preflight'], harness, { ...baseEnv, ...scenario.env })
      assert.notEqual(result.status, 0, scenario.name)
      assert.match(result.stderr, scenario.error, scenario.name)
    }
  } finally {
    fs.rmSync(harness.root, { recursive: true, force: true })
  }
})

test('routing rollback deletes only exact matching rules and deregisters only the exact instance', () => {
  const harness = makeHarness(String.raw`
printf '%s\n' "$*" >> "$FAKE_CALLS_FILE"
case "$1 $2" in
  "ec2 describe-instances") printf '%s\n' '{"Reservations":[{"Instances":[{"InstanceId":"i-test","VpcId":"vpc-test","State":{"Name":"running"},"SecurityGroups":[{"GroupId":"sg-instance"}]}]}]}' ;;
  "ec2 describe-security-group-rules")
    printf '%s\n' '{"SecurityGroupRules":[{"IsEgress":false,"IpProtocol":"tcp","FromPort":4787,"ToPort":4788,"ReferencedGroupInfo":{"GroupId":"sg-alb"}}]}'
    ;;
  "elbv2 describe-listeners")
    printf '%s\n' '{"Listeners":[{"ListenerArn":"arn:test:listener","LoadBalancerArn":"arn:test:load-balancer","Protocol":"HTTPS","Port":443,"SslPolicy":"ELBSecurityPolicy-TLS13-1-2-2021-06","Certificates":[{"CertificateArn":"arn:test:default-certificate"}]}]}'
    ;;
  "elbv2 describe-listener-certificates")
    printf '%s\n' '{"Certificates":[{"CertificateArn":"arn:test:default-certificate","IsDefault":true},{"CertificateArn":"arn:test:certificate","IsDefault":false}]}'
    ;;
  "elbv2 describe-load-balancers")
    printf '%s\n' '{"LoadBalancers":[{"LoadBalancerArn":"arn:test:load-balancer","VpcId":"vpc-test","Type":"application","Scheme":"internet-facing","State":{"Code":"active"},"SecurityGroups":["sg-alb"]}]}'
    ;;
  "acm describe-certificate")
    printf '%s\n' '{"Certificate":{"DomainName":"*.om.they.dev","SubjectAlternativeNames":["*.om.they.dev"]}}'
    ;;
  "elbv2 describe-target-groups")
    if [[ "$*" == *"om-demo-public-demo-mcp"* ]]; then suffix=mcp; port=4788; else suffix=app; port=4787; fi
    printf '{"TargetGroups":[{"TargetGroupName":"%s","TargetGroupArn":"arn:test:tg:%s","Protocol":"HTTP","Port":%s,"VpcId":"vpc-test","HealthCheckProtocol":"HTTP","HealthCheckPath":"%s","Matcher":{"HttpCode":"%s"},"TargetType":"instance"}]}\n' "$( [[ "$suffix" == mcp ]] && echo om-demo-public-demo-mcp || echo om-demo-public-demo )" "$suffix" "$port" "$( [[ "$suffix" == mcp ]] && echo /health || echo /login )" "$( [[ "$suffix" == mcp ]] && echo 200 || echo 200-399 )"
    ;;
  "elbv2 describe-rules")
    if [[ "$*" == *"--rule-arns"* ]]; then
      echo 'RuleNotFound' >&2
      exit 254
    fi
    printf '%s\n' '{"Rules":[{"RuleArn":"arn:test:rule:mcp","Priority":"1007","Conditions":[{"Field":"host-header","Values":["public-demo.om.they.dev"]},{"Field":"path-pattern","Values":["/mcp*"]}],"Actions":[{"Type":"forward","TargetGroupArn":"arn:test:tg:mcp"}]},{"RuleArn":"arn:test:rule:app","Priority":"1008","Conditions":[{"Field":"host-header","Values":["public-demo.om.they.dev"]}],"Actions":[{"Type":"forward","TargetGroupArn":"arn:test:tg:app"}]}]}'
    ;;
  "elbv2 describe-target-health")
    if [[ "$*" == *"arn:test:tg:mcp"* ]]; then port=4788; else port=4787; fi
    if grep -q "deregister-targets .*Port=$port" "$FAKE_CALLS_FILE"; then
      printf '%s\n' '{"TargetHealthDescriptions":[]}'
      exit 0
    fi
    printf '{"TargetHealthDescriptions":[{"Target":{"Id":"i-test","Port":%s},"TargetHealth":{"State":"healthy"}}]}\n' "$port"
    ;;
  "elbv2 delete-rule"|"elbv2 deregister-targets") printf '%s\n' '{}' ;;
  *) exit 2 ;;
esac`)
  fs.writeFileSync(
    path.join(harness.binDir, 'curl'),
    `#!/bin/sh
case "$*" in
  *"/login") printf '%s' 200 ;;
  *"/mcp") printf '%s' "\${FAKE_MCP_STATUS:-401}" ;;
  *) exit 2 ;;
esac
`,
    { mode: 0o755 },
  )
  const routingEnv = {
    AWS_REGION: 'test-region-1',
    INSTANCE_ID: 'i-test',
    VPC_ID: 'vpc-test',
    LOAD_BALANCER_ARN: 'arn:test:load-balancer',
    LISTENER_ARN: 'arn:test:listener',
    LISTENER_SSL_POLICY: 'ELBSecurityPolicy-TLS13-1-2-2021-06',
    LOAD_BALANCER_SECURITY_GROUP_ID: 'sg-alb',
    ...hostReadbackEnv(harness),
  }

  try {
    const exposedMcp = run(routingScript, ['readback'], harness, { ...routingEnv, FAKE_MCP_STATUS: '200' })
    assert.notEqual(exposedMcp.status, 0)
    assert.match(exposedMcp.stderr, /MCP routing probe failed with status 200/)

    const safeReadback = run(routingScript, ['readback'], harness, routingEnv)
    assert.equal(safeReadback.status, 0, safeReadback.stderr)

    const result = run(routingScript, ['rollback'], harness, routingEnv)
    assert.equal(result.status, 0, result.stderr)
    const calls = fs.readFileSync(harness.callsFile, 'utf8')
    assert.match(calls, /delete-rule .*arn:test:rule:mcp/)
    assert.match(calls, /delete-rule .*arn:test:rule:app/)
    assert.equal(calls.match(/deregister-targets/g)?.length, 2)
    assert.match(calls, /Id=i-test,Port=4787/)
    assert.match(calls, /Id=i-test,Port=4788/)
    assert.doesNotMatch(calls, /delete-target-group|modify-listener|delete-listener/)
  } finally {
    fs.rmSync(harness.root, { recursive: true, force: true })
  }
})

for (const lostOperation of ['register-targets', 'create-rule']) {
  test(`routing rollback reconciles an accepted ${lostOperation} with a lost response`, () => {
    const harness = makeHarness(String.raw`
printf '%s\n' "$*" >> "$FAKE_CALLS_FILE"
case "$1 $2" in
  "ec2 describe-instances")
    printf '%s\n' '{"Reservations":[{"Instances":[{"InstanceId":"i-test","VpcId":"vpc-test","State":{"Name":"running"},"SecurityGroups":[{"GroupId":"sg-instance"}]}]}]}'
    ;;
  "ec2 describe-security-group-rules")
    printf '%s\n' '{"SecurityGroupRules":[{"IsEgress":false,"IpProtocol":"tcp","FromPort":4787,"ToPort":4788,"ReferencedGroupInfo":{"GroupId":"sg-alb"}}]}'
    ;;
  "elbv2 describe-listeners")
    printf '%s\n' '{"Listeners":[{"ListenerArn":"arn:test:listener","LoadBalancerArn":"arn:test:load-balancer","Protocol":"HTTPS","Port":443,"SslPolicy":"ELBSecurityPolicy-TLS13-1-2-2021-06","Certificates":[{"CertificateArn":"arn:test:default-certificate"}]}]}'
    ;;
  "elbv2 describe-listener-certificates")
    printf '%s\n' '{"Certificates":[{"CertificateArn":"arn:test:default-certificate","IsDefault":true},{"CertificateArn":"arn:test:certificate","IsDefault":false}]}'
    ;;
  "elbv2 describe-load-balancers")
    printf '%s\n' '{"LoadBalancers":[{"LoadBalancerArn":"arn:test:load-balancer","VpcId":"vpc-test","Type":"application","Scheme":"internet-facing","State":{"Code":"active"},"SecurityGroups":["sg-alb"]}]}'
    ;;
  "acm describe-certificate")
    printf '%s\n' '{"Certificate":{"DomainName":"*.om.they.dev","SubjectAlternativeNames":["*.om.they.dev"]}}'
    ;;
  "elbv2 describe-target-groups")
    if [[ "$*" == *"om-demo-public-demo-mcp"* ]]; then suffix=mcp; port=4788; path=/health; matcher=200; name=om-demo-public-demo-mcp; else suffix=app; port=4787; path=/login; matcher=200-399; name=om-demo-public-demo; fi
    printf '{"TargetGroups":[{"TargetGroupName":"%s","TargetGroupArn":"arn:test:tg:%s","Protocol":"HTTP","Port":%s,"VpcId":"vpc-test","HealthCheckProtocol":"HTTP","HealthCheckPath":"%s","Matcher":{"HttpCode":"%s"},"TargetType":"instance"}]}\n' "$name" "$suffix" "$port" "$path" "$matcher"
    ;;
  "elbv2 describe-target-health")
    if [[ "$*" == *"arn:test:tg:mcp"* ]]; then port=4788; else port=4787; fi
    if [[ -f "$FAKE_STATE_DIR/target-$port" ]]; then
      printf '{"TargetHealthDescriptions":[{"Target":{"Id":"i-test","Port":%s},"TargetHealth":{"State":"healthy"}}]}\n' "$port"
    else
      printf '%s\n' '{"TargetHealthDescriptions":[]}'
    fi
    ;;
  "elbv2 register-targets")
    port="$(printf '%s' "$*" | sed -E 's/.*Port=([0-9]+).*/\1/')"
    touch "$FAKE_STATE_DIR/target-$port"
    if [[ "$FAKE_LOST_OPERATION" == "register-targets" && "$port" == 4787 ]]; then
      echo 'simulated lost register-targets response' >&2
      exit 255
    fi
    ;;
  "elbv2 deregister-targets")
    port="$(printf '%s' "$*" | sed -E 's/.*Port=([0-9]+).*/\1/')"
    rm -f "$FAKE_STATE_DIR/target-$port"
    ;;
  "elbv2 wait") ;;
  "elbv2 describe-rules")
    if [[ -f "$FAKE_STATE_DIR/rule-mcp" && -f "$FAKE_STATE_DIR/rule-mcp.hide-once" ]]; then
      rm -f "$FAKE_STATE_DIR/rule-mcp.hide-once"
      printf '%s\n' '{"Rules":[{"RuleArn":"arn:test:default","Priority":"default","Conditions":[],"Actions":[]}]}'
    elif [[ -f "$FAKE_STATE_DIR/rule-mcp" ]]; then
      printf '%s\n' '{"Rules":[{"RuleArn":"arn:test:rule:mcp","Priority":"1007","Conditions":[{"Field":"host-header","Values":["public-demo.om.they.dev"]},{"Field":"path-pattern","Values":["/mcp*"]}],"Actions":[{"Type":"forward","TargetGroupArn":"arn:test:tg:mcp"}]},{"RuleArn":"arn:test:default","Priority":"default","Conditions":[],"Actions":[]}]}'
    else
      printf '%s\n' '{"Rules":[{"RuleArn":"arn:test:default","Priority":"default","Conditions":[],"Actions":[]}]}'
    fi
    ;;
  "elbv2 create-rule")
    touch "$FAKE_STATE_DIR/rule-mcp"
    if [[ "$FAKE_LOST_OPERATION" == "create-rule" ]]; then
      touch "$FAKE_STATE_DIR/rule-mcp.hide-once"
      echo 'simulated lost create-rule response' >&2
      exit 255
    fi
    printf '%s\n' 'arn:test:rule:mcp'
    ;;
  "elbv2 delete-rule")
    rm -f "$FAKE_STATE_DIR/rule-mcp"
    ;;
  *) exit 2 ;;
esac`)
    fs.writeFileSync(path.join(harness.binDir, 'curl'), '#!/bin/sh\nexit 2\n', { mode: 0o755 })
    const env = {
      AWS_REGION: 'test-region-1',
      INSTANCE_ID: 'i-test',
      VPC_ID: 'vpc-test',
      LOAD_BALANCER_ARN: 'arn:test:load-balancer',
      LISTENER_ARN: 'arn:test:listener',
      LISTENER_SSL_POLICY: 'ELBSecurityPolicy-TLS13-1-2-2021-06',
      LOAD_BALANCER_SECURITY_GROUP_ID: 'sg-alb',
      FAKE_STATE_DIR: harness.root,
      FAKE_LOST_OPERATION: lostOperation,
      ...hostReadbackEnv(harness),
    }
    if (lostOperation === 'create-rule') {
      fs.writeFileSync(path.join(harness.root, 'target-4787'), '')
      fs.writeFileSync(path.join(harness.root, 'target-4788'), '')
    }

    try {
      const result = run(routingScript, ['cutover'], harness, env)
      assert.notEqual(result.status, 0)
      assert.match(result.stderr, new RegExp(`simulated lost ${lostOperation} response`))
      const calls = fs.readFileSync(harness.callsFile, 'utf8')
      assert.match(calls, new RegExp(`elbv2 ${lostOperation}`))
      if (lostOperation === 'register-targets') {
        assert.equal(fs.existsSync(path.join(harness.root, 'target-4787')), false)
        assert.match(calls, /deregister-targets .*Port=4787/)
      } else {
        assert.equal(fs.existsSync(path.join(harness.root, 'rule-mcp')), false)
        assert.match(calls, /delete-rule .*arn:test:rule:mcp/)
      }
    } finally {
      fs.rmSync(harness.root, { recursive: true, force: true })
    }
  })
}
