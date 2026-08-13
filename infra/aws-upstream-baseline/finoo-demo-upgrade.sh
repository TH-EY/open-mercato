#!/usr/bin/env bash
set -euo pipefail

AWS_REGION="${AWS_REGION:-eu-west-2}"
DEPLOY_COMMIT="${DEPLOY_COMMIT:-}"
DEPLOY_APP_IMAGE="${DEPLOY_APP_IMAGE:-}"
DEPLOY_APP_DIGEST="${DEPLOY_APP_DIGEST:-}"
OM_FINOO_AFFILIATE_REDIRECT_HOSTS="${OM_FINOO_AFFILIATE_REDIRECT_HOSTS:-}"
OM_FINOO_DEFAULT_AFFILIATE_DESTINATION_URL="${OM_FINOO_DEFAULT_AFFILIATE_DESTINATION_URL:-}"
RATE_LIMIT_TRUST_PROXY_DEPTH="${RATE_LIMIT_TRUST_PROXY_DEPTH:-}"
FINOO_SUPERADMIN_PASSWORD_SECRET_ID="${FINOO_SUPERADMIN_PASSWORD_SECRET_ID:-}"
FINOO_EMPLOYEE_PASSWORD_SECRET_ID="${FINOO_EMPLOYEE_PASSWORD_SECRET_ID:-}"

INSTANCE_NAME=openmercato-upstream-baseline-dokploy
HOSTNAME=finoo.om.they.dev
PORT=4786
CANDIDATE_PORT=14786
TARGET_GROUP_NAME=om-demo-finoo
ECR_REPOSITORY_NAME=openmercato-app
WORKDIR=/opt/openmercato-demos/finoo
ACTIVE_CONTAINER=demo-finoo-app-1
CANDIDATE_CONTAINER=demo-finoo-app-candidate

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
  FINOO_SUPERADMIN_PASSWORD_SECRET_ID FINOO_EMPLOYEE_PASSWORD_SECRET_ID; do
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
if [[ "$FINOO_SUPERADMIN_PASSWORD_SECRET_ID" != openmercato-upstream-baseline-dokploy/finoo-demo/superadmin-password || \
      "$FINOO_EMPLOYEE_PASSWORD_SECRET_ID" != openmercato-upstream-baseline-dokploy/finoo-demo/employee-password ]]; then
  echo "Finoo upgrade requires the exact approved smoke-role password secret identifiers" >&2
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
  printf 'superadmin_secret_id=%q\n' "$FINOO_SUPERADMIN_PASSWORD_SECRET_ID"
  printf 'employee_secret_id=%q\n' "$FINOO_EMPLOYEE_PASSWORD_SECRET_ID"
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
pending_file=.finoo-upgrade-pending
env_backup=".env.rollback-${deploy_token}"
commit_backup=".finoo-active-commit.rollback-${deploy_token}"
digest_backup=".finoo-active-image-digest.rollback-${deploy_token}"
rollback_container="${active_container}-rollback-thom88-${deploy_commit:0:12}"
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
env_modified=false
stage_complete=false

wait_for_login() {
  local port="$1"
  for attempt in $(seq 1 120); do
    if curl -fsS --max-time 5 -o /dev/null "http://127.0.0.1:${port}/login"; then return 0; fi
    sleep 5
  done
  return 1
}

restore_old() {
  local failed=false
  local current_id=""
  current_id="$(docker inspect --format '{{.Id}}' "$active_container" 2>/dev/null || true)"
  if [[ -n "$current_id" && "$current_id" != "$old_container_id" ]]; then
    docker rm -f "$active_container" >/dev/null || failed=true
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
    echo "Finoo rollback failed; manual recovery required" >&2
    return 1
  fi
  rm -f -- "$env_backup" "$commit_backup" "$digest_backup" "$pending_file"
}

cleanup() {
  local status=$?
  if [[ "$stage_complete" != true && "$cutover_started" == true ]]; then
    restore_old || status=70
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
      status=70
    else
      rm -f -- "$env_backup" "$commit_backup" "$digest_backup" "$pending_file"
    fi
  fi
  if [[ "$candidate_created" == true ]]; then
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
old_container_id=${old_container_id}
old_image_id=${old_image_id}
rollback_container=${rollback_container}
env_backup=${env_backup}
commit_backup=${commit_backup}
digest_backup=${digest_backup}
prior_commit_present=${prior_commit_present}
prior_digest_present=${prior_digest_present}
EOF_PENDING
chmod 600 "$pending_file"

docker_config="$(mktemp -d)"
runtime_env="$(mktemp)"
chmod 700 "$docker_config"
chmod 600 "$runtime_env"
export DOCKER_CONFIG="$docker_config"
registry="${deploy_app_image%%/*}"
immutable_image="${deploy_app_image%:*}@${deploy_app_digest}"
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
python3 - "$runtime_env" "$redirect_hosts" "$default_affiliate_destination" "$proxy_depth" <<'PY'
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
signup_status="$(curl -sS --max-time 10 -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:${candidate_port}/api/customer_accounts/signup")"
if [[ "$signup_status" != 404 && "$signup_status" != 405 ]]; then
  echo "Finoo candidate still exposes customer self-registration" >&2
  exit 1
fi

python3 - .env "$redirect_hosts" "$default_affiliate_destination" "$proxy_depth" <<'PY'
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

docker rm -f "$candidate_container" >/dev/null
candidate_created=false
docker tag "$immutable_image" open-mercato/app:finoo
cutover_started=true
docker stop --time 30 "$active_container" >/dev/null
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

docker cp scripts/smoke-auth-dashboard.mjs "${active_container}:/tmp/finoo-smoke-auth-dashboard.mjs"
run_role_smoke() {
  local role="$1"
  local email="$2"
  local secret_id="$3"
  local password
  password="$(aws secretsmanager get-secret-value --region "$aws_region" --secret-id "$secret_id" --query SecretString --output text)"
  printf '%s\n' "$password" |
    docker exec -i \
      -e "SMOKE_TEST_EMAIL=${email}" \
      -e "EXPECTED_ROLE=${role}" \
      -e BASE_URL=http://127.0.0.1:3000 \
      "$active_container" sh -lc 'IFS= read -r SMOKE_TEST_PASSWORD; export SMOKE_TEST_PASSWORD; exec node /tmp/finoo-smoke-auth-dashboard.mjs --run-smoke'
  unset password
}
run_role_smoke superadmin superadmin@finoo.om.they.dev "$superadmin_secret_id"
run_role_smoke employee employee@finoo.om.they.dev "$employee_secret_id"

if ! user_listing="$(docker exec "$active_container" sh -lc 'yarn mercato auth list-users' 2>/dev/null)"; then
  echo "Finoo admin account metadata could not be read" >&2
  exit 1
fi
admin_roles="$(printf '%s\n' "$user_listing" | awk -F '|' '
  $2 ~ /^[[:space:]]*admin@finoo[.]om[.]they[.]dev[[:space:]]*$/ {
    gsub(/^[[:space:]]+|[[:space:]]+$/, "", $6)
    print $6
  }
')"
unset user_listing
if ! printf '%s\n' "$admin_roles" | tr ',' '\n' | sed 's/^[[:space:]]*//; s/[[:space:]]*$//' | grep -Fxq admin; then
  echo "Finoo admin account or role assignment is missing" >&2
  exit 1
fi
unset admin_roles
echo "[finoo-smoke] Existing admin role assignment verified without password access"

if [[ "$(docker inspect --format '{{.Image}}' "$active_container")" != "$new_image_id" ]]; then
  echo "Finoo active container does not use the staged image" >&2
  exit 1
fi
stage_complete=true
echo "remote_finoo_stage=pending-public-verification"
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
current_id="$(docker inspect --format '{{.Id}}' "$active_container" 2>/dev/null || true)"
if [[ -n "$current_id" && "$current_id" != "$old_container_id" ]]; then
  docker rm -f "$active_container" >/dev/null || failed=true
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
  echo "Finoo rollback failed; manual recovery required" >&2
  exit 70
fi
rm -f -- "$env_backup" "$commit_backup" "$digest_backup" "$pending_file"
echo "remote_finoo_rolled_back=true"
EOF_DECISION
    echo 'EOF_FINOO_DECISION'
  } > "$output_path"
}

STAGE_COMMAND_ID="$(send_command 'THOM-88 stage immutable Finoo upgrade' "$REMOTE_SCRIPT")"
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
  rollback_command_id="$(send_command 'THOM-88 rollback failed Finoo stage' "$rollback_script")"
  wait_for_command "$rollback_command_id" 180
  rm -f -- "$rollback_script"
  exit 1
fi

public_ok=true
aws elbv2 wait target-in-service \
  --region "$AWS_REGION" \
  --target-group-arn "$TARGET_GROUP_ARN" \
  --targets "Id=${INSTANCE_ID},Port=${PORT}" || public_ok=false
curl -fsS --max-time 15 -o /dev/null "https://${HOSTNAME}/login" || public_ok=false
if signup_code="$(curl -sS --max-time 15 -o /dev/null -w '%{http_code}' -X POST "https://${HOSTNAME}/api/customer_accounts/signup")"; then
  if [[ "$signup_code" != 404 && "$signup_code" != 405 ]]; then
    public_ok=false
  fi
else
  public_ok=false
fi

decision=finalize
if [[ "$public_ok" != true ]]; then decision=rollback; fi
DECISION_SCRIPT="$(mktemp)"
build_decision_script "$decision" "$DECISION_SCRIPT"
DECISION_COMMAND_ID="$(send_command "THOM-88 ${decision} Finoo upgrade" "$DECISION_SCRIPT")"
if wait_for_command "$DECISION_COMMAND_ID" 180; then
  decision_status=0
else
  decision_status=$?
fi
rm -f -- "$DECISION_SCRIPT"
if [[ "$decision_status" != 0 && "$decision" == finalize ]]; then
  rollback_script="$(mktemp)"
  build_decision_script rollback "$rollback_script"
  rollback_command_id="$(send_command 'THOM-88 rollback failed Finoo finalization' "$rollback_script")"
  wait_for_command "$rollback_command_id" 180
  rm -f -- "$rollback_script"
  exit 1
fi
if [[ "$decision_status" != 0 ]]; then
  exit 1
fi
if [[ "$decision" != finalize ]]; then
  echo "Finoo public verification failed and the previous container was restored" >&2
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
