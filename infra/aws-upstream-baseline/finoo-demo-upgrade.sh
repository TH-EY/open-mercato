#!/usr/bin/env bash
set -euo pipefail

AWS_REGION="${AWS_REGION:-eu-west-2}"
DEPLOY_COMMIT="${DEPLOY_COMMIT:-}"
DEPLOY_APP_IMAGE="${DEPLOY_APP_IMAGE:-}"
DEPLOY_APP_DIGEST="${DEPLOY_APP_DIGEST:-}"
OM_FINOO_AFFILIATE_REDIRECT_HOSTS="${OM_FINOO_AFFILIATE_REDIRECT_HOSTS:-}"
OM_FINOO_DEFAULT_AFFILIATE_DESTINATION_URL="${OM_FINOO_DEFAULT_AFFILIATE_DESTINATION_URL:-}"
RATE_LIMIT_TRUST_PROXY_DEPTH="${RATE_LIMIT_TRUST_PROXY_DEPTH:-}"
FINOO_ADMIN_PASSWORD_SECRET_ID="${FINOO_ADMIN_PASSWORD_SECRET_ID:-}"
FINOO_SES_CREDENTIALS_STAGED="${FINOO_SES_CREDENTIALS_STAGED:-false}"
SYSTEM_EMAIL_PROVIDER=ses
AWS_SES_REGION=eu-west-2
AWS_SES_CONFIGURATION_SET=''
EMAIL_FROM=no-reply@they.dev
NOTIFICATIONS_EMAIL_FROM=no-reply@they.dev

INSTANCE_NAME=openmercato-upstream-baseline-dokploy
HOSTNAME=finoo.om.they.dev
PORT=4786
CANDIDATE_PORT=14786
TARGET_GROUP_NAME=om-demo-finoo
ECR_REPOSITORY_NAME=openmercato-app
WORKDIR=/opt/openmercato-demos/finoo
ACTIVE_CONTAINER=demo-finoo-app-1
CANDIDATE_CONTAINER=demo-finoo-app-candidate
FINOO_TENANT_ID=26d5dc28-6df5-4944-b0e9-0ff26a8bf8a6
FINOO_ORGANIZATION_ID=4ec19265-3d35-4e9f-bcd2-531e62cf8385
FINOO_ADMIN_USER_ID=51d91b4b-622a-46d6-9207-a1a8d394b2c5

require_value() {
  local name="$1"
  local value="$2"
  if [[ -z "$value" ]]; then
    echo "Missing required value: ${name}" >&2
    exit 1
  fi
}

for required_name in \
  DEPLOY_COMMIT DEPLOY_APP_IMAGE DEPLOY_APP_DIGEST \
  OM_FINOO_AFFILIATE_REDIRECT_HOSTS OM_FINOO_DEFAULT_AFFILIATE_DESTINATION_URL \
  RATE_LIMIT_TRUST_PROXY_DEPTH \
  FINOO_ADMIN_PASSWORD_SECRET_ID; do
  require_value "$required_name" "${!required_name}"
done

if [[ ! "$DEPLOY_COMMIT" =~ ^[0-9a-f]{40}$ ]]; then
  echo "Finoo upgrade requires an immutable 40-character commit" >&2
  exit 1
fi
if [[ ! "$DEPLOY_APP_DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]]; then
  echo "Finoo upgrade requires an immutable image digest" >&2
  exit 1
fi
if [[ "$DEPLOY_APP_IMAGE" != *":finoo-${DEPLOY_COMMIT}" ]]; then
  echo "Finoo upgrade image tag must bind the exact deployment commit" >&2
  exit 1
fi
if [[ "$FINOO_ADMIN_PASSWORD_SECRET_ID" != openmercato-upstream-baseline-dokploy/finoo-demo/finoo-admin-password ]]; then
  echo "Finoo upgrade requires the exact approved Finoo admin password secret identifier" >&2
  exit 1
fi
if [[ "$OM_FINOO_AFFILIATE_REDIRECT_HOSTS" != finoo.pl ]]; then
  echo "Finoo affiliate redirects must be restricted to finoo.pl" >&2
  exit 1
fi
if [[ "$OM_FINOO_DEFAULT_AFFILIATE_DESTINATION_URL" != https://finoo.pl/ ]]; then
  echo "Finoo default affiliate destination must be https://finoo.pl/" >&2
  exit 1
fi
if [[ "$RATE_LIMIT_TRUST_PROXY_DEPTH" != 1 ]]; then
  echo "Finoo requires the verified direct-ALB proxy depth of 1" >&2
  exit 1
fi
if [[ "$FINOO_SES_CREDENTIALS_STAGED" != true && "$FINOO_SES_CREDENTIALS_STAGED" != false ]]; then
  echo "Finoo SES staged-credential rollback mode must be true or false" >&2
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
if [[ "$(git -C "$REPO_ROOT" rev-parse HEAD)" != "$DEPLOY_COMMIT" ]]; then
  echo "Finoo upgrade checkout does not match the requested immutable commit" >&2
  exit 1
fi
if [[ -n "$(git -C "$REPO_ROOT" status --porcelain)" ]]; then
  echo "Finoo upgrade requires a clean checkout" >&2
  exit 1
fi

APPROVED_ECR_REPOSITORY_URL="$(aws ecr describe-repositories \
  --region "$AWS_REGION" \
  --repository-names "$ECR_REPOSITORY_NAME" \
  --query 'repositories[0].repositoryUri' \
  --output text)"
if [[ "$DEPLOY_APP_IMAGE" != "${APPROVED_ECR_REPOSITORY_URL}:finoo-${DEPLOY_COMMIT}" ]]; then
  echo "Finoo upgrade image must use the approved ECR repository and exact commit tag" >&2
  exit 1
fi

INSTANCE_ID="$(aws ec2 describe-instances \
  --region "$AWS_REGION" \
  --filters "Name=tag:Name,Values=${INSTANCE_NAME}" 'Name=instance-state-name,Values=running' \
  --query 'Reservations[].Instances[].InstanceId' \
  --output text)"
if [[ -z "$INSTANCE_ID" || "$INSTANCE_ID" == *$'\t'* ]]; then
  echo "Expected exactly one running Finoo deployment host" >&2
  exit 1
fi

PING_STATUS="$(aws ssm describe-instance-information \
  --region "$AWS_REGION" \
  --filters "Key=InstanceIds,Values=${INSTANCE_ID}" \
  --query 'InstanceInformationList[0].PingStatus' \
  --output text)"
if [[ "$PING_STATUS" != Online ]]; then
  echo "Finoo deployment host is not SSM Online" >&2
  exit 1
fi

TARGET_GROUP_ARN="$(aws elbv2 describe-target-groups \
  --region "$AWS_REGION" \
  --names "$TARGET_GROUP_NAME" \
  --query 'TargetGroups[0].TargetGroupArn' \
  --output text)"
TARGET_STATE="$(aws elbv2 describe-target-health \
  --region "$AWS_REGION" \
  --target-group-arn "$TARGET_GROUP_ARN" \
  --targets "Id=${INSTANCE_ID},Port=${PORT}" \
  --query 'TargetHealthDescriptions[0].TargetHealth.State' \
  --output text)"
if [[ "$TARGET_STATE" != healthy ]]; then
  echo "Finoo rollback target is not healthy before upgrade" >&2
  exit 1
fi
curl -fsS --max-time 15 -o /dev/null "https://${HOSTNAME}/login"

DEPLOY_TOKEN="$(openssl rand -hex 16)"
REMOTE_SCRIPT="$(mktemp)"
trap 'rm -f -- "$REMOTE_SCRIPT"' EXIT
{
  echo "bash <<'EOF_FINOO_UPGRADE'"
  printf 'aws_region=%q\n' "$AWS_REGION"
  printf 'deploy_token=%q\n' "$DEPLOY_TOKEN"
  printf 'deploy_commit=%q\n' "$DEPLOY_COMMIT"
  printf 'deploy_app_image=%q\n' "$DEPLOY_APP_IMAGE"
  printf 'deploy_app_digest=%q\n' "$DEPLOY_APP_DIGEST"
  printf 'redirect_hosts=%q\n' "$OM_FINOO_AFFILIATE_REDIRECT_HOSTS"
  printf 'default_affiliate_destination=%q\n' "$OM_FINOO_DEFAULT_AFFILIATE_DESTINATION_URL"
  printf 'proxy_depth=%q\n' "$RATE_LIMIT_TRUST_PROXY_DEPTH"
  printf 'system_email_provider=%q\n' "$SYSTEM_EMAIL_PROVIDER"
  printf 'ses_region=%q\n' "$AWS_SES_REGION"
  printf 'ses_configuration_set=%q\n' "$AWS_SES_CONFIGURATION_SET"
  printf 'email_from=%q\n' "$EMAIL_FROM"
  printf 'notifications_email_from=%q\n' "$NOTIFICATIONS_EMAIL_FROM"
  printf 'finoo_admin_secret_id=%q\n' "$FINOO_ADMIN_PASSWORD_SECRET_ID"
  printf 'ses_credentials_staged=%q\n' "$FINOO_SES_CREDENTIALS_STAGED"
  printf 'finoo_tenant_id=%q\n' "$FINOO_TENANT_ID"
  printf 'finoo_organization_id=%q\n' "$FINOO_ORGANIZATION_ID"
  printf 'finoo_admin_user_id=%q\n' "$FINOO_ADMIN_USER_ID"
  printf 'workdir=%q\n' "$WORKDIR"
  printf 'live_port=%q\n' "$PORT"
  printf 'candidate_port=%q\n' "$CANDIDATE_PORT"
  printf 'active_container=%q\n' "$ACTIVE_CONTAINER"
  printf 'candidate_container=%q\n' "$CANDIDATE_CONTAINER"
  cat <<'EOF_REMOTE'
set -euo pipefail

exec 9>/var/lock/finoo-demo-upgrade.lock
if ! flock -n 9; then
  echo "Another Finoo host operation is active" >&2
  exit 1
fi

cd "$workdir"
command -v timeout >/dev/null
pending_file=.finoo-upgrade-pending
env_backup=".env.rollback-${deploy_token}"
commit_backup=".finoo-active-commit.rollback-${deploy_token}"
digest_backup=".finoo-active-image-digest.rollback-${deploy_token}"
rollback_container="${active_container}-rollback-thom108-${deploy_commit:0:12}"
recovery_container="${active_container}-recovery-thom108-${deploy_commit:0:12}"
test ! -e "$pending_file"
test ! -e "$env_backup"
test ! -e "$commit_backup"
test ! -e "$digest_backup"
test -f .finoo-first-provision-owned
test -f .env
test "$(stat -c '%a' .env)" = 600
docker inspect "$active_container" >/dev/null
test "$(docker inspect --format '{{.State.Running}}' "$active_container")" = true
curl -fsS --max-time 10 -o /dev/null "http://127.0.0.1:${live_port}/login"
test -z "$(docker ps -aq --filter "name=^/${candidate_container}$")"
test -z "$(docker ps -aq --filter "name=^/${rollback_container}$")"
test -z "$(docker ps -aq --filter "name=^/${recovery_container}$")"
test -z "$(ss -ltnH "sport = :${candidate_port}")"

old_container_id="$(docker inspect --format '{{.Id}}' "$active_container")"
old_image_id="$(docker inspect --format '{{.Image}}' "$active_container")"
compose_project="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$active_container")"
compose_service="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.service"}}' "$active_container")"
test "$compose_project" = demo-finoo
test "$compose_service" = app
new_image_id=""
candidate_created=false
cutover_started=false
legacy_cutover_attempted=false
preserve_new_runtime=false
env_modified=false
stage_complete=false
admin_credential_attempted=false
admin_credential_applied=false
immutable_image="${deploy_app_image%:*}@${deploy_app_digest}"

restore_staged_ses_credentials() {
  if [[ "$ses_credentials_staged" != true ]]; then return 0; fi
  local restore_env
  restore_env="$(mktemp)"
  chmod 600 "$restore_env"
  docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$active_container" > "$restore_env"
  if docker run --rm \
    --network mercato-network-finoo \
    --volumes-from "$active_container" \
    --env-file "$restore_env" \
    --workdir /app/apps/mercato \
    --user 0 \
    "$immutable_image" \
    yarn mercado channel_ses restore-ambient-credentials \
      --tenant "$finoo_tenant_id" \
      --organization "$finoo_organization_id"; then
    rm -f -- "$restore_env"
    echo "ses_credentials_restored=ambient"
    return 0
  fi
  rm -f -- "$restore_env"
  return 1
}

wait_for_login() {
  local port="$1"
  for attempt in $(seq 1 120); do
    if curl -fsS --max-time 5 -o /dev/null "http://127.0.0.1:${port}/login"; then return 0; fi
    sleep 5
  done
  return 1
}

normalize_identity_json_report() {
  local output="$1"
  python3 - "$output" <<'PY'
import json
import sys

expected_key_sets = {
    frozenset({
        'mode', 'scanned', 'eligible', 'wouldCreate', 'created', 'unchanged',
        'destinationConflicts', 'invalidPesel', 'unknownDocumentType',
        'unknownCountry', 'invalidIssuedOn', 'invalidExpiresOn',
    }),
    frozenset({
        'scanned', 'migrated', 'unmigrated', 'destinationRecords',
        'linkedDestinationRecords', 'destinationConflicts',
        'aliasValues', 'activeDefinitions', 'inactiveDefinitions',
    }),
    frozenset({
        'mode', 'scanned', 'countryConflicts', 'countriesNormalized',
        'completenessUpdated', 'wouldNormalizeCountries',
        'wouldUpdateCompleteness',
    }),
}
matches = []
for line in sys.argv[1].splitlines():
    try:
        report = json.loads(line)
    except json.JSONDecodeError:
        continue
    if isinstance(report, dict) and frozenset(report) in expected_key_sets:
        matches.append(report)
if len(matches) != 1:
    raise SystemExit('Expected exactly one FINOO identity count-only JSON report')
print(json.dumps(matches[0], separators=(',', ':'), sort_keys=True))
PY
}

assert_identity_migration_report() {
  local report="$1"
  local expected_mode="$2"
  python3 - "$report" "$expected_mode" <<'PY'
import json
import sys

expected_keys = {
    'mode', 'scanned', 'eligible', 'wouldCreate', 'created', 'unchanged',
    'destinationConflicts', 'invalidPesel', 'unknownDocumentType',
    'unknownCountry', 'invalidIssuedOn', 'invalidExpiresOn',
}
report = json.loads(sys.argv[1])
if set(report) != expected_keys or report.get('mode') != sys.argv[2]:
    raise SystemExit('Unexpected FINOO identity migration report shape')
if any(type(value) is not int or value < 0 for key, value in report.items() if key != 'mode'):
    raise SystemExit('FINOO identity migration report must contain counts only')
if report['destinationConflicts'] != 0:
    raise SystemExit('FINOO identity migration has destination conflicts')
PY
}

assert_identity_completeness_report() {
  local report="$1"
  local expected_mode="$2"
  local expected_state="$3"
  python3 - "$report" "$expected_mode" "$expected_state" <<'PY'
import json
import sys

expected_keys = {
    'mode', 'scanned', 'countryConflicts', 'countriesNormalized',
    'completenessUpdated', 'wouldNormalizeCountries',
    'wouldUpdateCompleteness',
}
report = json.loads(sys.argv[1])
if set(report) != expected_keys or report.get('mode') != sys.argv[2]:
    raise SystemExit('Unexpected FINOO identity completeness report shape')
if any(type(value) is not int or value < 0 for key, value in report.items() if key != 'mode'):
    raise SystemExit('FINOO identity completeness report must contain counts only')
if report['countryConflicts'] != 0:
    raise SystemExit('FINOO identity completeness repair found country conflicts')
if report['mode'] == 'dry-run' and (report['countriesNormalized'] != 0 or report['completenessUpdated'] != 0):
    raise SystemExit('FINOO identity completeness dry-run performed writes')
if report['mode'] == 'apply' and (report['wouldNormalizeCountries'] != 0 or report['wouldUpdateCompleteness'] != 0):
    raise SystemExit('FINOO identity completeness apply report is inconsistent')
if sys.argv[3] == 'clean' and (report['wouldNormalizeCountries'] != 0 or report['wouldUpdateCompleteness'] != 0):
    raise SystemExit('FINOO identity completeness verification is not clean')
PY
}

assert_identity_verification_report() {
  local report="$1"
  local expected_active="$2"
  local expected_inactive="$3"
  python3 - "$report" "$expected_active" "$expected_inactive" <<'PY'
import json
import sys

expected_keys = {
    'scanned', 'migrated', 'unmigrated', 'destinationRecords',
    'linkedDestinationRecords', 'destinationConflicts',
    'aliasValues', 'activeDefinitions', 'inactiveDefinitions',
}
report = json.loads(sys.argv[1])
if set(report) != expected_keys:
    raise SystemExit('Unexpected FINOO identity verification report shape')
if any(type(value) is not int or value < 0 for value in report.values()):
    raise SystemExit('FINOO identity verification report must contain counts only')
if report['unmigrated'] != 0 or report['destinationConflicts'] != 0:
    raise SystemExit('FINOO identity migration verification failed')
if report['aliasValues'] != 0:
    raise SystemExit('FINOO identity migration has prefixed legacy aliases')
if report['scanned'] != report['migrated'] + report['unmigrated'] + report['destinationConflicts']:
    raise SystemExit('FINOO identity scanned count does not reconcile')
if report['linkedDestinationRecords'] != report['migrated'] + report['destinationConflicts']:
    raise SystemExit('FINOO identity linked destination count does not reconcile')
if report['destinationRecords'] < report['linkedDestinationRecords']:
    raise SystemExit('FINOO identity destination count is inconsistent')
if report['activeDefinitions'] != int(sys.argv[2]) or report['inactiveDefinitions'] != int(sys.argv[3]):
    raise SystemExit('FINOO identity legacy definition count is not exact')
PY
}

read_identity_definition_state_from_report() {
  local report="$1"
  python3 - "$report" <<'PY'
import json
import sys

report = json.loads(sys.argv[1])
expected_keys = {
    'scanned', 'migrated', 'unmigrated', 'destinationRecords',
    'linkedDestinationRecords', 'destinationConflicts',
    'aliasValues', 'activeDefinitions', 'inactiveDefinitions',
}
if set(report) != expected_keys or any(type(value) is not int or value < 0 for value in report.values()):
    raise SystemExit('Unexpected FINOO identity definition-state report')
if report['unmigrated'] != 0 or report['destinationConflicts'] != 0:
    raise SystemExit('FINOO identity migration is not safe for cutover')
if report['aliasValues'] != 0:
    raise SystemExit('FINOO identity migration has prefixed legacy aliases')
if report['scanned'] != report['migrated'] + report['unmigrated'] + report['destinationConflicts']:
    raise SystemExit('FINOO identity scanned count does not reconcile')
if report['linkedDestinationRecords'] != report['migrated'] + report['destinationConflicts']:
    raise SystemExit('FINOO identity linked destination count does not reconcile')
if report['destinationRecords'] < report['linkedDestinationRecords']:
    raise SystemExit('FINOO identity destination count is inconsistent')
active = report['activeDefinitions']
inactive = report['inactiveDefinitions']
if (active, inactive) not in {(6, 0), (0, 6)}:
    raise SystemExit('FINOO identity definitions are in a partial state')
print(f'{active} {inactive}')
PY
}

run_preserved_new_cli() {
  local source_container="$1"
  shift
  local command_env
  local status
  command_env="$(mktemp)"
  chmod 600 "$command_env"
  docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$source_container" > "$command_env"
  if docker run --rm \
    --network mercato-network-finoo \
    --volumes-from "$source_container" \
    --env-file "$command_env" \
    --workdir /app/apps/mercato \
    --user 0 \
    "$immutable_image" \
    yarn mercato "$@"; then
    status=0
  else
    status=$?
  fi
  rm -f -- "$command_env"
  return "$status"
}

read_identity_definition_state() {
  local source_container="$1"
  local verification_output
  local verification_report
  verification_output="$(run_preserved_new_cli "$source_container" finoo_identities verify-legacy \
    --tenant "$finoo_tenant_id" \
    --organization "$finoo_organization_id")" || return 1
  verification_report="$(normalize_identity_json_report "$verification_output")" || return 1
  read_identity_definition_state_from_report "$verification_report"
}

ensure_legacy_identity_state_for_old() {
  local source_container="$1"
  local definition_state
  definition_state="$(read_identity_definition_state "$source_container")" || return 1
  if [[ "$legacy_cutover_attempted" != true ]]; then
    run_preserved_new_cli "$source_container" configs cache structural \
      --tenant "$finoo_tenant_id" \
      --json || return 1
    return 0
  fi
  if [[ "$definition_state" == "0 6" ]]; then
    run_preserved_new_cli "$source_container" finoo_identities rollback-legacy \
      --tenant "$finoo_tenant_id" \
      --organization "$finoo_organization_id" \
      --apply \
      --maintenance-window \
      --confirm THOM-108 >/dev/null || return 1
    definition_state="$(read_identity_definition_state "$source_container")" || return 1
  fi
  [[ "$definition_state" == "6 0" ]] || return 1
  run_preserved_new_cli "$source_container" configs cache structural \
    --tenant "$finoo_tenant_id" \
    --json || return 1
}

restore_identity_cutover_for_new() {
  local source_container="$1"
  local verification_output
  local verification_report
  run_preserved_new_cli "$source_container" finoo_identities cutover-legacy \
    --tenant "$finoo_tenant_id" \
    --organization "$finoo_organization_id" \
    --apply \
    --maintenance-window \
    --confirm THOM-108 >/dev/null || return 1
  verification_output="$(run_preserved_new_cli "$source_container" finoo_identities verify-legacy \
    --tenant "$finoo_tenant_id" \
    --organization "$finoo_organization_id")" || return 1
  verification_report="$(normalize_identity_json_report "$verification_output")" || return 1
  assert_identity_verification_report "$verification_report" 0 6 || return 1
  run_preserved_new_cli "$source_container" configs cache structural \
    --tenant "$finoo_tenant_id" \
    --json || return 1
}

restore_preserved_new_runtime() {
  local source_container="$1"
  if [[ "$source_container" != "$recovery_container" ]]; then
    preserve_new_runtime=true
    echo "The FINOO candidate runtime remains available for manual recovery" >&2
    return 1
  fi
  docker stop --time 30 "$active_container" >/dev/null 2>&1 || true
  if docker inspect "$active_container" >/dev/null 2>&1; then
    docker rename "$active_container" "$rollback_container" >/dev/null 2>&1 || return 1
  fi
  docker rename "$recovery_container" "$active_container" || return 1
  docker start "$active_container" >/dev/null || return 1
  wait_for_login "$live_port" || return 1
  preserve_new_runtime=true
}

install_finoo_smoke_helper() {
  local container="$1"
  local source_hash
  local target_hash
  if ! source_hash="$(docker run --rm --entrypoint /bin/sh "$immutable_image" -c 'sha256sum /app/scripts/smoke-auth-dashboard.mjs' | awk '{print $1}')"; then
    return 1
  fi
  if [[ -z "$source_hash" ]]; then return 1; fi
  if ! docker exec --user 0 "$container" rm -f -- /tmp/finoo-smoke-auth-dashboard.mjs; then
    return 1
  fi
  if ! docker run --rm --entrypoint /bin/cat "$immutable_image" /app/scripts/smoke-auth-dashboard.mjs |
    docker exec --user 0 -i "$container" sh -c 'umask 022; cat > /tmp/finoo-smoke-auth-dashboard.mjs'; then
    return 1
  fi
  if ! target_hash="$(docker exec "$container" sha256sum /tmp/finoo-smoke-auth-dashboard.mjs | awk '{print $1}')"; then
    return 1
  fi
  [[ "$target_hash" == "$source_hash" ]]
}

run_finoo_admin_smoke() {
  local container="$1"
  timeout --signal=TERM --kill-after=5s 20s aws secretsmanager get-secret-value \
    --region "$aws_region" \
    --secret-id "$finoo_admin_secret_id" \
    --cli-connect-timeout 5 \
    --cli-read-timeout 10 \
    --query SecretString \
    --output text |
    timeout --signal=TERM --kill-after=5s 30s docker exec -i \
      -e SMOKE_TEST_EMAIL=admin@finoo.om.they.dev \
      -e 'EXPECTED_ROLE=Finoo Superadmin' \
      -e "SMOKE_TEST_TENANT_ID=${finoo_tenant_id}" \
      -e REQUIRE_TENANT_SCOPE=true \
      -e SMOKE_REQUEST_TIMEOUT_MS=5000 \
      -e BASE_URL=http://127.0.0.1:3000 \
      "$container" sh -lc 'IFS= read -r SMOKE_TEST_PASSWORD; export SMOKE_TEST_PASSWORD; exec node /tmp/finoo-smoke-auth-dashboard.mjs --run-smoke'
}

wait_for_finoo_admin_smoke() {
  local container="$1"
  for attempt in $(seq 1 6); do
    if run_finoo_admin_smoke "$container"; then return 0; fi
    sleep 65
  done
  return 1
}

restore_old() {
  local failed=false
  local current_id=""
  local preserved_new=""
  current_id="$(docker inspect --format '{{.Id}}' "$active_container" 2>/dev/null || true)"
  if [[ "$current_id" == "$old_container_id" && \
        "$(docker inspect --format '{{.State.Running}}' "$active_container" 2>/dev/null || true)" == true ]]; then
    docker stop --time 30 "$active_container" >/dev/null || {
      echo "Finoo old writer could not be stopped before identity rollback" >&2
      return 1
    }
  fi
  if [[ -n "$current_id" && "$current_id" != "$old_container_id" ]]; then
    if ! docker rename "$active_container" "$recovery_container"; then
      preserve_new_runtime=true
      return 1
    fi
    if ! docker stop --time 30 "$recovery_container" >/dev/null; then
      docker rename "$recovery_container" "$active_container" >/dev/null 2>&1 || true
      preserve_new_runtime=true
      return 1
    fi
    preserved_new="$recovery_container"
  elif docker inspect "$candidate_container" >/dev/null 2>&1; then
    docker stop --time 30 "$candidate_container" >/dev/null || {
      preserve_new_runtime=true
      return 1
    }
    preserved_new="$candidate_container"
  fi
  if [[ -z "$preserved_new" ]]; then
    echo "No preserved new runtime is available for the identity rollback command" >&2
    preserve_new_runtime=true
    return 1
  fi
  if [[ "$(docker inspect --format '{{.State.Running}}' "$rollback_container" 2>/dev/null || true)" == true ]]; then
    docker stop --time 30 "$rollback_container" >/dev/null || {
      echo "Finoo rollback writer could not be stopped before identity rollback" >&2
      preserve_new_runtime=true
      return 1
    }
  fi
  if ! ensure_legacy_identity_state_for_old "$preserved_new"; then
    echo "FINOO identity definition state is partial or unreadable; both runtime writers remain stopped" >&2
    preserve_new_runtime=true
    return 1
  fi
  if docker inspect "$rollback_container" >/dev/null 2>&1; then
    if docker inspect "$active_container" >/dev/null 2>&1; then
      docker rm -f "$active_container" >/dev/null || failed=true
    fi
    docker rename "$rollback_container" "$active_container" || failed=true
  fi
  if [[ "$(docker inspect --format '{{.Id}}' "$active_container" 2>/dev/null || true)" != "$old_container_id" ]]; then
    failed=true
  fi
  if [[ "$(docker inspect --format '{{.Image}}' "$active_container" 2>/dev/null || true)" != "$old_image_id" ]]; then
    failed=true
  fi
  docker start "$active_container" >/dev/null || failed=true
  wait_for_login "$live_port" || failed=true
  if [[ -f "$env_backup" ]]; then
    cp -p -- "$env_backup" .env || failed=true
    chmod 600 .env || failed=true
  fi
  if [[ "$failed" == true ]]; then
    docker stop --time 30 "$active_container" >/dev/null 2>&1 || true
    if restore_identity_cutover_for_new "$preserved_new"; then
      restore_preserved_new_runtime "$preserved_new" || true
    else
      echo "FINOO cutover could not be restored after old-runtime failure; both runtime writers remain stopped" >&2
    fi
    echo "Finoo rollback failed; manual recovery required" >&2
    return 1
  fi
  if docker inspect "$recovery_container" >/dev/null 2>&1; then
    docker rm -f "$recovery_container" >/dev/null
  fi
}

verify_stage_cleanup_admin_credential() {
  if [[ "$admin_credential_attempted" != true ]]; then return 0; fi
  if ! install_finoo_smoke_helper "$active_container"; then
    return 1
  fi
  if ! wait_for_finoo_admin_smoke "$active_container"; then
    return 1
  fi
  echo "persistent_finoo_admin_credential_verified_during_stage_cleanup=true"
}

cleanup() {
  local status=$?
  local cleanup_failed=false
  if [[ "$stage_complete" != true ]]; then
    restore_staged_ses_credentials || {
      echo "Finoo SES credential rollback failed; IAM revocation and manual recovery required" >&2
      cleanup_failed=true
      status=71
    }
  fi
  if [[ "$stage_complete" != true && "$cutover_started" == true ]]; then
    restore_old || {
      cleanup_failed=true
      status=70
    }
  fi
  if [[ "$stage_complete" != true && "$cutover_started" != true ]]; then
    local pre_cutover_failed=false
    if [[ "$env_modified" == true ]]; then
      cp -p -- "$env_backup" .env || pre_cutover_failed=true
      chmod 600 .env || pre_cutover_failed=true
    else
      rm -f -- "$env_backup"
    fi
    if [[ "$pre_cutover_failed" == true ]]; then
      echo "Finoo pre-cutover configuration rollback failed; manual recovery required" >&2
      cleanup_failed=true
      status=70
    fi
  fi
  if [[ "$stage_complete" != true && "$cleanup_failed" != true ]]; then
    verify_stage_cleanup_admin_credential || {
      echo "Finoo persistent administrator credential could not be verified after stage recovery" >&2
      cleanup_failed=true
      status=72
    }
  fi
  if [[ "$stage_complete" != true && "$cleanup_failed" != true ]]; then
    rm -f -- "$env_backup" "$commit_backup" "$digest_backup" "$pending_file"
  fi
  if [[ "$candidate_created" == true && "$preserve_new_runtime" != true ]]; then
    docker rm -f "$candidate_container" >/dev/null 2>&1 || true
  fi
  docker logout "${deploy_app_image%%/*}" >/dev/null 2>&1 || true
  if [[ -n "${docker_config:-}" ]]; then rm -rf -- "$docker_config"; fi
  if [[ -n "${runtime_env:-}" ]]; then rm -f -- "$runtime_env"; fi
  exit "$status"
}
trap cleanup EXIT

cp -p -- .env "$env_backup"
prior_commit_present=false
prior_digest_present=false
if [[ -f .finoo-active-commit ]]; then
  cp -p -- .finoo-active-commit "$commit_backup"
  prior_commit_present=true
fi
if [[ -f .finoo-active-image-digest ]]; then
  cp -p -- .finoo-active-image-digest "$digest_backup"
  prior_digest_present=true
fi
cat > "$pending_file" <<EOF_PENDING
deploy_token=${deploy_token}
deploy_commit=${deploy_commit}
deploy_app_digest=${deploy_app_digest}
ses_credentials_staged=${ses_credentials_staged}
finoo_tenant_id=${finoo_tenant_id}
finoo_organization_id=${finoo_organization_id}
finoo_admin_user_id=${finoo_admin_user_id}
finoo_admin_secret_id=${finoo_admin_secret_id}
aws_region=${aws_region}
admin_credential_attempted=false
admin_credential_applied=false
immutable_image=${immutable_image}
old_container_id=${old_container_id}
old_image_id=${old_image_id}
rollback_container=${rollback_container}
recovery_container=${recovery_container}
candidate_container=${candidate_container}
env_backup=${env_backup}
commit_backup=${commit_backup}
digest_backup=${digest_backup}
prior_commit_present=${prior_commit_present}
prior_digest_present=${prior_digest_present}
legacy_cutover_attempted=false
EOF_PENDING
chmod 600 "$pending_file"

docker_config="$(mktemp -d)"
runtime_env="$(mktemp)"
chmod 700 "$docker_config"
chmod 600 "$runtime_env"
export DOCKER_CONFIG="$docker_config"
registry="${deploy_app_image%%/*}"
aws ecr get-login-password --region "$aws_region" |
  docker login "$registry" --username AWS --password-stdin >/dev/null
docker pull "$immutable_image" >/dev/null
repo_digests="$(docker image inspect --format '{{json .RepoDigests}}' "$immutable_image")"
if [[ "$repo_digests" != *"@$deploy_app_digest"* ]]; then
  echo "Pulled Finoo upgrade image does not match the requested digest" >&2
  exit 1
fi
image_revision="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$immutable_image")"
if [[ "$image_revision" != "$deploy_commit" ]]; then
  echo "Pulled Finoo image revision does not match the requested commit" >&2
  exit 1
fi
new_image_id="$(docker image inspect --format '{{.Id}}' "$immutable_image")"
printf 'new_image_id=%s\n' "$new_image_id" >> "$pending_file"

docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$active_container" > "$runtime_env"
python3 - "$runtime_env" "$redirect_hosts" "$default_affiliate_destination" "$proxy_depth" "$system_email_provider" "$ses_region" "$ses_configuration_set" "$email_from" "$notifications_email_from" <<'PY'
import sys
from pathlib import Path

path = Path(sys.argv[1])
updates = {
    'NEXT_PUBLIC_OM_PORTAL_ALLOW_SELF_REGISTRATION': 'false',
    'OM_FINOO_AFFILIATE_REDIRECT_HOSTS': sys.argv[2],
    'OM_FINOO_DEFAULT_AFFILIATE_DESTINATION_URL': sys.argv[3],
    'RATE_LIMIT_ENABLED': 'true',
    'RATE_LIMIT_STRATEGY': 'redis',
    'RATE_LIMIT_TRUST_PROXY_DEPTH': sys.argv[4],
    'REDIS_URL': 'redis://mercato-redis-finoo:6379',
    'SYSTEM_EMAIL_PROVIDER': sys.argv[5],
    'AWS_SES_REGION': sys.argv[6],
    'AWS_SES_CONFIGURATION_SET': sys.argv[7],
    'EMAIL_FROM': sys.argv[8],
    'NOTIFICATIONS_EMAIL_FROM': sys.argv[9],
}
lines = [line for line in path.read_text().splitlines() if line.split('=', 1)[0] not in updates]
lines.extend(f'{key}={value}' for key, value in updates.items())
path.write_text('\n'.join(lines) + '\n')
PY

docker create \
  --name "$candidate_container" \
  --network mercato-network-finoo \
  --volumes-from "$active_container" \
  --publish "127.0.0.1:${candidate_port}:3000" \
  --env-file "$runtime_env" \
  --workdir /app/apps/mercato \
  --user 0 \
  "$immutable_image" \
  /bin/sh -lc "INIT_COMMAND='yarn mercato init' sh /app/docker/scripts/init-or-migrate.sh && yarn start" >/dev/null
candidate_created=true
docker start "$candidate_container" >/dev/null
if ! wait_for_login "$candidate_port"; then
  docker logs --tail 120 "$candidate_container" >&2
  echo "Finoo candidate did not become reachable" >&2
  exit 1
fi
docker exec "$candidate_container" yarn mercato entities seed-encryption \
  --tenant "$finoo_tenant_id" \
  --organization "$finoo_organization_id"
echo "[finoo-identities] Exact-scope encryption maps seeded"
docker exec "$candidate_container" yarn mercato finoo_identities ensure-organization-setup \
  --tenant "$finoo_tenant_id" \
  --organization "$finoo_organization_id" \
  --apply
echo "[finoo-identities] Existing organization role and ACL setup verified"
identity_dry_run_output="$(docker exec "$candidate_container" yarn mercato finoo_identities migrate-legacy \
  --tenant "$finoo_tenant_id" \
  --organization "$finoo_organization_id" \
  --dry-run)"
identity_dry_run_report="$(normalize_identity_json_report "$identity_dry_run_output")"
assert_identity_migration_report "$identity_dry_run_report" dry-run
printf '[finoo-identities] migration_dry_run=%s\n' "$identity_dry_run_report"
identity_completeness_dry_run_output="$(docker exec "$candidate_container" yarn mercato finoo_identities repair-completeness \
  --tenant "$finoo_tenant_id" \
  --organization "$finoo_organization_id" \
  --dry-run)"
identity_completeness_dry_run_report="$(normalize_identity_json_report "$identity_completeness_dry_run_output")"
assert_identity_completeness_report "$identity_completeness_dry_run_report" dry-run pending
printf '[finoo-identities] completeness_dry_run=%s\n' "$identity_completeness_dry_run_report"
docker exec "$candidate_container" yarn mercato finoo_customer_retention ensure-organization-setup \
  --tenant "$finoo_tenant_id" \
  --organization "$finoo_organization_id" \
  --apply
echo "[finoo-retention] Organization settings and hourly reconciliation schedule verified"
docker exec "$candidate_container" yarn mercato channel_ses assert-env-preset-exact
echo "[finoo-email] Existing exact Amazon SES preset preserved"
docker exec "$candidate_container" yarn mercato channel_ses assert-explicit-credentials \
  --tenant "$finoo_tenant_id" \
  --organization "$finoo_organization_id"
docker exec "$candidate_container" yarn mercato channel_ses assert-credentials-health \
  --tenant "$finoo_tenant_id" \
  --organization "$finoo_organization_id"
echo "[finoo-email] Dedicated FINOO Amazon SES credentials verified"
signup_status="$(curl -sS --max-time 10 -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:${candidate_port}/api/customer_accounts/signup")"
if [[ "$signup_status" != 404 && "$signup_status" != 405 ]]; then
  echo "Finoo candidate still exposes customer self-registration" >&2
  exit 1
fi
admin_credential_attempted=true
printf 'admin_credential_attempted=true\n' >> "$pending_file"
sync "$pending_file"
aws secretsmanager get-secret-value \
  --region "$aws_region" \
  --secret-id "$finoo_admin_secret_id" \
  --query SecretString \
  --output text |
  docker exec -i "$candidate_container" yarn mercato finoo_customer_retention ensure-admin-credential \
    --tenant "$finoo_tenant_id" \
    --organization "$finoo_organization_id" \
    --user "$finoo_admin_user_id" \
    --password-stdin \
    --apply
admin_credential_applied=true
printf 'admin_credential_applied=true\n' >> "$pending_file"
sync "$pending_file"
echo "[finoo-auth] Exact tenant-scoped Finoo admin credential verified"

python3 - .env "$redirect_hosts" "$default_affiliate_destination" "$proxy_depth" "$system_email_provider" "$ses_region" "$ses_configuration_set" "$email_from" "$notifications_email_from" <<'PY'
import os
import sys
from pathlib import Path

path = Path(sys.argv[1])
updates = {
    'NEXT_PUBLIC_OM_PORTAL_ALLOW_SELF_REGISTRATION': 'false',
    'OM_FINOO_AFFILIATE_REDIRECT_HOSTS': sys.argv[2],
    'OM_FINOO_DEFAULT_AFFILIATE_DESTINATION_URL': sys.argv[3],
    'RATE_LIMIT_ENABLED': 'true',
    'RATE_LIMIT_STRATEGY': 'redis',
    'RATE_LIMIT_TRUST_PROXY_DEPTH': sys.argv[4],
    'REDIS_URL': 'redis://mercato-redis-finoo:6379',
    'SYSTEM_EMAIL_PROVIDER': sys.argv[5],
    'AWS_SES_REGION': sys.argv[6],
    'AWS_SES_CONFIGURATION_SET': sys.argv[7],
    'EMAIL_FROM': sys.argv[8],
    'NOTIFICATIONS_EMAIL_FROM': sys.argv[9],
}
lines = [line for line in path.read_text().splitlines() if line.split('=', 1)[0] not in updates]
lines.extend(f'{key}={value}' for key, value in updates.items())
temporary = path.with_suffix('.tmp')
temporary.write_text('\n'.join(lines) + '\n')
os.chmod(temporary, 0o600)
temporary.replace(path)
PY
env_modified=true

mapfile -d '' label_args < <(docker inspect "$active_container" | python3 -c '
import json, sys
labels = json.load(sys.stdin)[0]["Config"].get("Labels") or {}
for key, value in labels.items():
    if key.startswith("org.opencontainers.image."):
        continue
    sys.stdout.buffer.write(b"--label\0")
    sys.stdout.buffer.write(f"{key}={value}".encode() + b"\0")
')

docker tag "$immutable_image" open-mercato/app:finoo
cutover_started=true
docker stop --time 30 "$active_container" >/dev/null
identity_apply_output="$(docker exec "$candidate_container" yarn mercato finoo_identities migrate-legacy \
  --tenant "$finoo_tenant_id" \
  --organization "$finoo_organization_id" \
  --apply)"
identity_apply_report="$(normalize_identity_json_report "$identity_apply_output")"
assert_identity_migration_report "$identity_apply_report" apply
printf '[finoo-identities] migration_apply=%s\n' "$identity_apply_report"
identity_completeness_apply_output="$(docker exec "$candidate_container" yarn mercato finoo_identities repair-completeness \
  --tenant "$finoo_tenant_id" \
  --organization "$finoo_organization_id" \
  --apply)"
identity_completeness_apply_report="$(normalize_identity_json_report "$identity_completeness_apply_output")"
assert_identity_completeness_report "$identity_completeness_apply_report" apply clean
printf '[finoo-identities] completeness_apply=%s\n' "$identity_completeness_apply_report"
identity_completeness_verify_output="$(docker exec "$candidate_container" yarn mercato finoo_identities repair-completeness \
  --tenant "$finoo_tenant_id" \
  --organization "$finoo_organization_id" \
  --dry-run)"
identity_completeness_verify_report="$(normalize_identity_json_report "$identity_completeness_verify_output")"
assert_identity_completeness_report "$identity_completeness_verify_report" dry-run clean
printf '[finoo-identities] completeness_verify=%s\n' "$identity_completeness_verify_report"
identity_verification_output="$(docker exec "$candidate_container" yarn mercato finoo_identities verify-legacy \
  --tenant "$finoo_tenant_id" \
  --organization "$finoo_organization_id")"
identity_verification_report="$(normalize_identity_json_report "$identity_verification_output")"
identity_definition_state="$(read_identity_definition_state_from_report "$identity_verification_report")"
printf '[finoo-identities] migration_verify=%s\n' "$identity_verification_report"
if [[ "$identity_definition_state" == "6 0" ]]; then
  legacy_cutover_attempted=true
  printf 'legacy_cutover_attempted=true\n' >> "$pending_file"
  sync "$pending_file"
  docker exec "$candidate_container" yarn mercato finoo_identities cutover-legacy \
    --tenant "$finoo_tenant_id" \
    --organization "$finoo_organization_id" \
    --apply \
    --maintenance-window \
    --confirm THOM-108 >/dev/null
fi
identity_cutover_output="$(docker exec "$candidate_container" yarn mercato finoo_identities verify-legacy \
  --tenant "$finoo_tenant_id" \
  --organization "$finoo_organization_id")"
identity_cutover_report="$(normalize_identity_json_report "$identity_cutover_output")"
assert_identity_verification_report "$identity_cutover_report" 0 6
docker exec "$candidate_container" yarn mercato configs cache structural \
  --tenant "$finoo_tenant_id" \
  --json
printf '[finoo-identities] cutover_verify=%s\n' "$identity_cutover_report"
docker rename "$active_container" "$rollback_container"
docker create \
  --name "$active_container" \
  --restart unless-stopped \
  --network mercato-network-finoo \
  --network-alias app \
  --volumes-from "$rollback_container" \
  --publish "${live_port}:3000" \
  --env-file "$runtime_env" \
  --workdir /app/apps/mercato \
  --user 0 \
  "${label_args[@]}" \
  --label "org.opencontainers.image.revision=${deploy_commit}" \
  "$immutable_image" \
  /bin/sh -lc "INIT_COMMAND='yarn mercato init' sh /app/docker/scripts/init-or-migrate.sh && yarn start" >/dev/null
docker start "$active_container" >/dev/null
test "$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$active_container")" = "$compose_project"
test "$(docker inspect --format '{{index .Config.Labels "com.docker.compose.service"}}' "$active_container")" = "$compose_service"
test "$(docker inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$active_container")" = "$deploy_commit"
if ! wait_for_login "$live_port"; then
  docker logs --tail 120 "$active_container" >&2
  echo "Upgraded Finoo app did not become reachable" >&2
  exit 1
fi
docker rm -f "$candidate_container" >/dev/null
candidate_created=false

install_finoo_smoke_helper "$active_container"
wait_for_finoo_admin_smoke "$active_container"

if [[ "$(docker inspect --format '{{.Image}}' "$active_container")" != "$new_image_id" ]]; then
  echo "Finoo active container does not use the staged image" >&2
  exit 1
fi
stage_complete=true
echo "remote_finoo_stage=pending-private-verification"
EOF_REMOTE
  echo 'EOF_FINOO_UPGRADE'
} > "$REMOTE_SCRIPT"

send_command() {
  local comment="$1"
  local script_path="$2"
  local parameters
  parameters="$(python3 - "$script_path" <<'PY'
import json, sys
from pathlib import Path
print(json.dumps({'commands': [Path(sys.argv[1]).read_text()]}))
PY
)"
  aws ssm send-command \
    --region "$AWS_REGION" \
    --instance-ids "$INSTANCE_ID" \
    --document-name AWS-RunShellScript \
    --comment "$comment" \
    --parameters "$parameters" \
    --query 'Command.CommandId' \
    --output text
}

wait_for_command() {
  local command_id="$1"
  local max_attempts="$2"
  for attempt in $(seq 1 "$max_attempts"); do
    local status
    status="$(aws ssm get-command-invocation \
      --region "$AWS_REGION" \
      --command-id "$command_id" \
      --instance-id "$INSTANCE_ID" \
      --query Status \
      --output text 2>/dev/null || true)"
    case "$status" in
      Success) return 0 ;;
      Failed|Cancelled|TimedOut)
        aws ssm get-command-invocation \
          --region "$AWS_REGION" \
          --command-id "$command_id" \
          --instance-id "$INSTANCE_ID" \
          --query '{Status:Status,ResponseCode:ResponseCode,Stdout:StandardOutputContent,Stderr:StandardErrorContent}' \
          --output json
        return 1
        ;;
    esac
    sleep 10
  done
  aws ssm cancel-command --region "$AWS_REGION" --command-id "$command_id" >/dev/null
  for attempt in $(seq 1 60); do
    local status
    status="$(aws ssm get-command-invocation \
      --region "$AWS_REGION" \
      --command-id "$command_id" \
      --instance-id "$INSTANCE_ID" \
      --query Status \
      --output text 2>/dev/null || true)"
    case "$status" in
      Success|Failed|Cancelled|TimedOut) return 2 ;;
    esac
    sleep 5
  done
  echo "Unable to prove that Finoo SSM command ${command_id} stopped" >&2
  return 3
}

build_decision_script() {
  local decision="$1"
  local output_path="$2"
  {
    echo "bash <<'EOF_FINOO_DECISION'"
    printf 'requested_token=%q\n' "$DEPLOY_TOKEN"
    printf 'decision=%q\n' "$decision"
    printf 'workdir=%q\n' "$WORKDIR"
    printf 'live_port=%q\n' "$PORT"
    printf 'active_container=%q\n' "$ACTIVE_CONTAINER"
    cat <<'EOF_DECISION'
set -euo pipefail
exec 9>/var/lock/finoo-demo-upgrade.lock
flock -n 9
cd "$workdir"
command -v timeout >/dev/null
pending_file=.finoo-upgrade-pending
if [[ ! -f "$pending_file" ]]; then
  if [[ "$decision" == rollback ]]; then
    curl -fsS --max-time 10 -o /dev/null "http://127.0.0.1:${live_port}/login"
    echo "remote_finoo_rollback_not_needed=true"
    exit 0
  fi
  echo "Finoo pending deployment state is missing" >&2
  exit 1
fi
set -a
source "$pending_file"
set +a
admin_credential_attempted="${admin_credential_attempted:-${admin_credential_applied:-false}}"
if [[ "$deploy_token" != "$requested_token" ]]; then
  echo "Finoo deployment token mismatch" >&2
  exit 1
fi
wait_for_login() {
  for attempt in $(seq 1 120); do
    if curl -fsS --max-time 5 -o /dev/null "http://127.0.0.1:${live_port}/login"; then return 0; fi
    sleep 5
  done
  return 1
}
normalize_identity_json_report() {
  local output="$1"
  python3 - "$output" <<'PY'
import json
import sys

expected_key_sets = {
    frozenset({
        'mode', 'scanned', 'eligible', 'wouldCreate', 'created', 'unchanged',
        'destinationConflicts', 'invalidPesel', 'unknownDocumentType',
        'unknownCountry', 'invalidIssuedOn', 'invalidExpiresOn',
    }),
    frozenset({
        'scanned', 'migrated', 'unmigrated', 'destinationRecords',
        'linkedDestinationRecords', 'destinationConflicts',
        'aliasValues', 'activeDefinitions', 'inactiveDefinitions',
    }),
    frozenset({
        'mode', 'scanned', 'countryConflicts', 'countriesNormalized',
        'completenessUpdated', 'wouldNormalizeCountries',
        'wouldUpdateCompleteness',
    }),
}
matches = []
for line in sys.argv[1].splitlines():
    try:
        report = json.loads(line)
    except json.JSONDecodeError:
        continue
    if isinstance(report, dict) and frozenset(report) in expected_key_sets:
        matches.append(report)
if len(matches) != 1:
    raise SystemExit('Expected exactly one FINOO identity count-only JSON report')
print(json.dumps(matches[0], separators=(',', ':'), sort_keys=True))
PY
}

read_identity_definition_state_from_report() {
  local report="$1"
  python3 - "$report" <<'PY'
import json
import sys

report = json.loads(sys.argv[1])
expected_keys = {
    'scanned', 'migrated', 'unmigrated', 'destinationRecords',
    'linkedDestinationRecords', 'destinationConflicts',
    'aliasValues', 'activeDefinitions', 'inactiveDefinitions',
}
if set(report) != expected_keys or any(type(value) is not int or value < 0 for value in report.values()):
    raise SystemExit('Unexpected FINOO identity definition-state report')
if report['unmigrated'] != 0 or report['destinationConflicts'] != 0:
    raise SystemExit('FINOO identity migration is not safe for cutover')
if report['aliasValues'] != 0:
    raise SystemExit('FINOO identity migration has prefixed legacy aliases')
if report['scanned'] != report['migrated'] + report['unmigrated'] + report['destinationConflicts']:
    raise SystemExit('FINOO identity scanned count does not reconcile')
if report['linkedDestinationRecords'] != report['migrated'] + report['destinationConflicts']:
    raise SystemExit('FINOO identity linked destination count does not reconcile')
if report['destinationRecords'] < report['linkedDestinationRecords']:
    raise SystemExit('FINOO identity destination count is inconsistent')
active = report['activeDefinitions']
inactive = report['inactiveDefinitions']
if (active, inactive) not in {(6, 0), (0, 6)}:
    raise SystemExit('FINOO identity definitions are in a partial state')
print(f'{active} {inactive}')
PY
}

install_finoo_smoke_helper() {
  local container="$1"
  local source_hash
  local target_hash
  if ! source_hash="$(docker run --rm --entrypoint /bin/sh "$immutable_image" -c 'sha256sum /app/scripts/smoke-auth-dashboard.mjs' | awk '{print $1}')"; then
    return 1
  fi
  if [[ -z "$source_hash" ]]; then return 1; fi
  if ! docker exec --user 0 "$container" rm -f -- /tmp/finoo-smoke-auth-dashboard.mjs; then
    return 1
  fi
  if ! docker run --rm --entrypoint /bin/cat "$immutable_image" /app/scripts/smoke-auth-dashboard.mjs |
    docker exec --user 0 -i "$container" sh -c 'umask 022; cat > /tmp/finoo-smoke-auth-dashboard.mjs'; then
    return 1
  fi
  if ! target_hash="$(docker exec "$container" sha256sum /tmp/finoo-smoke-auth-dashboard.mjs | awk '{print $1}')"; then
    return 1
  fi
  [[ "$target_hash" == "$source_hash" ]]
}
run_finoo_admin_smoke() {
  local container="$1"
  timeout --signal=TERM --kill-after=5s 20s aws secretsmanager get-secret-value \
    --region "$aws_region" \
    --secret-id "$finoo_admin_secret_id" \
    --cli-connect-timeout 5 \
    --cli-read-timeout 10 \
    --query SecretString \
    --output text |
    timeout --signal=TERM --kill-after=5s 30s docker exec -i \
      -e SMOKE_TEST_EMAIL=admin@finoo.om.they.dev \
      -e 'EXPECTED_ROLE=Finoo Superadmin' \
      -e "SMOKE_TEST_TENANT_ID=${finoo_tenant_id}" \
      -e REQUIRE_TENANT_SCOPE=true \
      -e SMOKE_REQUEST_TIMEOUT_MS=5000 \
      -e BASE_URL=http://127.0.0.1:3000 \
      "$container" sh -lc 'IFS= read -r SMOKE_TEST_PASSWORD; export SMOKE_TEST_PASSWORD; exec node /tmp/finoo-smoke-auth-dashboard.mjs --run-smoke'
}
wait_for_finoo_admin_smoke() {
  local container="$1"
  for attempt in $(seq 1 6); do
    if run_finoo_admin_smoke "$container"; then return 0; fi
    sleep 65
  done
  return 1
}
restore_staged_ses_credentials() {
  if [[ "$ses_credentials_staged" != true ]]; then return 0; fi
  local restore_env
  restore_env="$(mktemp)"
  chmod 600 "$restore_env"
  docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$active_container" > "$restore_env"
  if docker run --rm \
    --network mercato-network-finoo \
    --volumes-from "$active_container" \
    --env-file "$restore_env" \
    --workdir /app/apps/mercato \
    --user 0 \
    "$immutable_image" \
    yarn mercado channel_ses restore-ambient-credentials \
      --tenant "$finoo_tenant_id" \
      --organization "$finoo_organization_id"; then
    rm -f -- "$restore_env"
    echo "ses_credentials_restored=ambient"
    return 0
  fi
  rm -f -- "$restore_env"
  return 1
}
run_preserved_new_cli() {
  local source_container="$1"
  shift
  local command_env
  local status
  command_env="$(mktemp)"
  chmod 600 "$command_env"
  docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$source_container" > "$command_env"
  if docker run --rm \
    --network mercato-network-finoo \
    --volumes-from "$source_container" \
    --env-file "$command_env" \
    --workdir /app/apps/mercato \
    --user 0 \
    "$immutable_image" \
    yarn mercato "$@"; then
    status=0
  else
    status=$?
  fi
  rm -f -- "$command_env"
  return "$status"
}
read_identity_definition_state() {
  local source_container="$1"
  local verification_output
  local verification_report
  verification_output="$(run_preserved_new_cli "$source_container" finoo_identities verify-legacy \
    --tenant "$finoo_tenant_id" \
    --organization "$finoo_organization_id")" || return 1
  verification_report="$(normalize_identity_json_report "$verification_output")" || return 1
  read_identity_definition_state_from_report "$verification_report"
}
ensure_legacy_identity_state_for_old() {
  local source_container="$1"
  local definition_state
  definition_state="$(read_identity_definition_state "$source_container")" || return 1
  if [[ "$legacy_cutover_attempted" != true ]]; then
    run_preserved_new_cli "$source_container" configs cache structural \
      --tenant "$finoo_tenant_id" \
      --json || return 1
    return 0
  fi
  if [[ "$definition_state" == "0 6" ]]; then
    run_preserved_new_cli "$source_container" finoo_identities rollback-legacy \
      --tenant "$finoo_tenant_id" \
      --organization "$finoo_organization_id" \
      --apply \
      --maintenance-window \
      --confirm THOM-108 >/dev/null || return 1
    definition_state="$(read_identity_definition_state "$source_container")" || return 1
  fi
  [[ "$definition_state" == "6 0" ]] || return 1
  run_preserved_new_cli "$source_container" configs cache structural \
    --tenant "$finoo_tenant_id" \
    --json || return 1
}
restore_identity_cutover_for_new() {
  local source_container="$1"
  local verification_output
  local verification_report
  local definition_state
  run_preserved_new_cli "$source_container" finoo_identities cutover-legacy \
    --tenant "$finoo_tenant_id" \
    --organization "$finoo_organization_id" \
    --apply \
    --maintenance-window \
    --confirm THOM-108 >/dev/null || return 1
  verification_output="$(run_preserved_new_cli "$source_container" finoo_identities verify-legacy \
    --tenant "$finoo_tenant_id" \
    --organization "$finoo_organization_id")" || return 1
  verification_report="$(normalize_identity_json_report "$verification_output")" || return 1
  definition_state="$(read_identity_definition_state_from_report "$verification_report")" || return 1
  [[ "$definition_state" == "0 6" ]] || return 1
  run_preserved_new_cli "$source_container" configs cache structural \
    --tenant "$finoo_tenant_id" \
    --json || return 1
}
restore_preserved_new_runtime() {
  local source_container="$1"
  if [[ "$source_container" != "$recovery_container" ]]; then
    echo "The FINOO candidate runtime remains available for manual recovery" >&2
    return 1
  fi
  docker stop --time 30 "$active_container" >/dev/null 2>&1 || true
  if docker inspect "$active_container" >/dev/null 2>&1; then
    docker rename "$active_container" "$rollback_container" >/dev/null 2>&1 || return 1
  fi
  docker rename "$recovery_container" "$active_container" || return 1
  docker start "$active_container" >/dev/null || return 1
  wait_for_login || return 1
}
verify_persistent_finoo_admin_credential() {
  if [[ "$admin_credential_attempted" != true ]]; then return 0; fi
  if ! install_finoo_smoke_helper "$active_container"; then
    return 1
  fi
  if ! wait_for_finoo_admin_smoke "$active_container"; then
    return 1
  fi
  echo "persistent_finoo_admin_credential_verified_after_rollback=true"
}
if [[ "$decision" == finalize ]]; then
  test "$(docker inspect --format '{{.Image}}' "$active_container")" = "$new_image_id"
  test "$(docker inspect --format '{{.HostConfig.RestartPolicy.Name}}' "$active_container")" = unless-stopped
  test "$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$active_container")" = demo-finoo
  test "$(docker inspect --format '{{index .Config.Labels "com.docker.compose.service"}}' "$active_container")" = app
  test "$(docker inspect --format '{{.Id}}' "$rollback_container")" = "$old_container_id"
  test "$(docker inspect --format '{{.Image}}' "$rollback_container")" = "$old_image_id"
  test "$(docker inspect --format '{{.State.Running}}' "$rollback_container")" = false
  wait_for_login
  commit_temp=".finoo-active-commit.tmp-${requested_token}"
  digest_temp=".finoo-active-image-digest.tmp-${requested_token}"
  printf '%s\n' "$deploy_commit" > "$commit_temp"
  printf '%s\n' "$deploy_app_digest" > "$digest_temp"
  chmod 600 "$commit_temp" "$digest_temp"
  mv -f -- "$commit_temp" .finoo-active-commit
  mv -f -- "$digest_temp" .finoo-active-image-digest
  rm -f -- "$env_backup" "$commit_backup" "$digest_backup" "$pending_file"
  echo "remote_finoo_finalized=true"
  exit 0
fi

failed=false
preserved_new=""
current_id="$(docker inspect --format '{{.Id}}' "$active_container" 2>/dev/null || true)"
if [[ "$current_id" == "$old_container_id" && \
      "$(docker inspect --format '{{.State.Running}}' "$active_container" 2>/dev/null || true)" == true ]]; then
  docker stop --time 30 "$active_container" >/dev/null || {
    echo "Finoo old writer could not be stopped before identity rollback" >&2
    exit 70
  }
fi
if [[ -n "$current_id" && "$current_id" != "$old_container_id" ]]; then
  if ! docker rename "$active_container" "$recovery_container"; then
    echo "Finoo rollback could not preserve the new runtime" >&2
    exit 70
  fi
  if ! docker stop --time 30 "$recovery_container" >/dev/null; then
    docker rename "$recovery_container" "$active_container" >/dev/null 2>&1 || true
    echo "Finoo rollback could not stop the preserved new runtime" >&2
    exit 70
  fi
  preserved_new="$recovery_container"
elif docker inspect "$candidate_container" >/dev/null 2>&1; then
  docker stop --time 30 "$candidate_container" >/dev/null || {
    echo "Finoo rollback could not stop the candidate writer" >&2
    exit 70
  }
  preserved_new="$candidate_container"
fi
if [[ -z "$preserved_new" ]]; then
  echo "No preserved new runtime is available for the identity rollback command" >&2
  exit 70
fi
if [[ "$(docker inspect --format '{{.State.Running}}' "$rollback_container" 2>/dev/null || true)" == true ]]; then
  docker stop --time 30 "$rollback_container" >/dev/null || {
    echo "Finoo rollback writer could not be stopped before identity rollback" >&2
    exit 70
  }
fi
if ! ensure_legacy_identity_state_for_old "$preserved_new"; then
  echo "FINOO identity definition state is partial or unreadable; both runtime writers remain stopped" >&2
  exit 70
fi
if docker inspect "$rollback_container" >/dev/null 2>&1; then
  docker rename "$rollback_container" "$active_container" || failed=true
fi
test "$(docker inspect --format '{{.Id}}' "$active_container" 2>/dev/null || true)" = "$old_container_id" || failed=true
test "$(docker inspect --format '{{.Image}}' "$active_container" 2>/dev/null || true)" = "$old_image_id" || failed=true
docker start "$active_container" >/dev/null || failed=true
wait_for_login || failed=true
if [[ -f "$env_backup" ]]; then
  cp -p -- "$env_backup" .env || failed=true
  chmod 600 .env || failed=true
fi
restore_staged_ses_credentials || failed=true
verify_persistent_finoo_admin_credential || failed=true
if [[ "$prior_commit_present" == true ]]; then
  cp -p -- "$commit_backup" .finoo-active-commit || failed=true
  chmod 600 .finoo-active-commit || failed=true
else
  rm -f -- .finoo-active-commit
fi
if [[ "$prior_digest_present" == true ]]; then
  cp -p -- "$digest_backup" .finoo-active-image-digest || failed=true
  chmod 600 .finoo-active-image-digest || failed=true
else
  rm -f -- .finoo-active-image-digest
fi
if [[ "$failed" == true ]]; then
  docker stop --time 30 "$active_container" >/dev/null 2>&1 || true
  if restore_identity_cutover_for_new "$preserved_new"; then
    restore_preserved_new_runtime "$preserved_new" || true
  else
    echo "FINOO cutover could not be restored after old-runtime failure; both runtime writers remain stopped" >&2
  fi
  echo "Finoo rollback failed; manual recovery required" >&2
  exit 70
fi
if docker inspect "$recovery_container" >/dev/null 2>&1; then
  docker rm -f "$recovery_container" >/dev/null
fi
if docker inspect "$candidate_container" >/dev/null 2>&1; then
  docker rm -f "$candidate_container" >/dev/null
fi
rm -f -- "$env_backup" "$commit_backup" "$digest_backup" "$pending_file"
echo "remote_finoo_rolled_back=true"
EOF_DECISION
    echo 'EOF_FINOO_DECISION'
  } > "$output_path"
}

STAGE_COMMAND_ID="$(send_command 'THOM-108 stage immutable private Finoo upgrade' "$REMOTE_SCRIPT")"
if wait_for_command "$STAGE_COMMAND_ID" 360; then
  stage_status=0
else
  stage_status=$?
fi
if [[ "$stage_status" != 0 ]]; then
  if [[ "$stage_status" == 3 ]]; then
    echo "Finoo stage state is uncertain; refusing automated recovery" >&2
    exit 1
  fi
  rollback_script="$(mktemp)"
  build_decision_script rollback "$rollback_script"
  rollback_command_id="$(send_command 'THOM-108 rollback failed Finoo stage' "$rollback_script")"
  wait_for_command "$rollback_command_id" 180
  rm -f -- "$rollback_script"
  exit 1
fi

private_runtime_ok=true
aws elbv2 wait target-in-service \
  --region "$AWS_REGION" \
  --target-group-arn "$TARGET_GROUP_ARN" \
  --targets "Id=${INSTANCE_ID},Port=${PORT}" || private_runtime_ok=false
curl -fsS --max-time 15 -o /dev/null "https://${HOSTNAME}/login" || private_runtime_ok=false
if signup_code="$(curl -sS --max-time 15 -o /dev/null -w '%{http_code}' -X POST "https://${HOSTNAME}/api/customer_accounts/signup")"; then
  if [[ "$signup_code" != 404 && "$signup_code" != 405 ]]; then
    private_runtime_ok=false
  fi
else
  private_runtime_ok=false
fi

decision=finalize
if [[ "$private_runtime_ok" != true ]]; then decision=rollback; fi
DECISION_SCRIPT="$(mktemp)"
build_decision_script "$decision" "$DECISION_SCRIPT"
DECISION_COMMAND_ID="$(send_command "THOM-108 ${decision} private Finoo upgrade" "$DECISION_SCRIPT")"
if wait_for_command "$DECISION_COMMAND_ID" 180; then
  decision_status=0
else
  decision_status=$?
fi
rm -f -- "$DECISION_SCRIPT"
if [[ "$decision_status" != 0 && "$decision" == finalize ]]; then
  rollback_script="$(mktemp)"
  build_decision_script rollback "$rollback_script"
  rollback_command_id="$(send_command 'THOM-108 rollback failed Finoo finalization' "$rollback_script")"
  wait_for_command "$rollback_command_id" 180
  rm -f -- "$rollback_script"
  exit 1
fi
if [[ "$decision_status" != 0 ]]; then
  exit 1
fi
if [[ "$decision" != finalize ]]; then
  echo "Finoo private runtime verification failed and the previous container was restored" >&2
  exit 1
fi

aws ssm get-command-invocation \
  --region "$AWS_REGION" \
  --command-id "$STAGE_COMMAND_ID" \
  --instance-id "$INSTANCE_ID" \
  --query StandardOutputContent \
  --output text
echo "finoo_hostname=${HOSTNAME}"
echo "finoo_url=https://${HOSTNAME}"
echo "finoo_port=${PORT}"
echo "finoo_target_group_arn=${TARGET_GROUP_ARN}"
echo "finoo_commit=${DEPLOY_COMMIT}"
echo "finoo_image_digest=${DEPLOY_APP_DIGEST}"
