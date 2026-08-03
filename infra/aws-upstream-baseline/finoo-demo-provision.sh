#!/usr/bin/env bash
set -euo pipefail

AWS_REGION="${AWS_REGION:-eu-west-2}"
DEPLOY_BRANCH="${DEPLOY_BRANCH:-}"
DEPLOY_COMMIT="${DEPLOY_COMMIT:-}"
DEPLOY_APP_IMAGE="${DEPLOY_APP_IMAGE:-}"
DEPLOY_APP_DIGEST="${DEPLOY_APP_DIGEST:-}"
FINOO_SUPERADMIN_PASSWORD_SECRET_ID="${FINOO_SUPERADMIN_PASSWORD_SECRET_ID:-}"
FINOO_ADMIN_PASSWORD_SECRET_ID="${FINOO_ADMIN_PASSWORD_SECRET_ID:-}"
FINOO_EMPLOYEE_PASSWORD_SECRET_ID="${FINOO_EMPLOYEE_PASSWORD_SECRET_ID:-}"
FINOO_PREFLIGHT_ONLY="${FINOO_PREFLIGHT_ONLY:-false}"

INSTANCE_NAME=openmercato-upstream-baseline-dokploy
LOAD_BALANCER_NAME=they-lb
HOSTNAME=finoo.om.they.dev
PORT=4786
TARGET_GROUP_NAME=om-demo-finoo
PROJECT_NAME=demo-finoo
DEPLOY_ENV=finoo
WORKDIR=/opt/openmercato-demos/finoo
REPO_URL=https://github.com/TH-EY/open-mercato.git
SECRET_PREFIX=openmercato-upstream-baseline-dokploy/finoo-demo

require_value() {
  local name="$1"
  local value="$2"
  if [[ -z "$value" ]]; then
    echo "Missing required value: ${name}" >&2
    exit 1
  fi
}

require_value DEPLOY_BRANCH "$DEPLOY_BRANCH"
require_value DEPLOY_COMMIT "$DEPLOY_COMMIT"
if [[ "$FINOO_PREFLIGHT_ONLY" != true ]]; then
  require_value DEPLOY_APP_IMAGE "$DEPLOY_APP_IMAGE"
  require_value DEPLOY_APP_DIGEST "$DEPLOY_APP_DIGEST"
  require_value FINOO_SUPERADMIN_PASSWORD_SECRET_ID "$FINOO_SUPERADMIN_PASSWORD_SECRET_ID"
  require_value FINOO_ADMIN_PASSWORD_SECRET_ID "$FINOO_ADMIN_PASSWORD_SECRET_ID"
  require_value FINOO_EMPLOYEE_PASSWORD_SECRET_ID "$FINOO_EMPLOYEE_PASSWORD_SECRET_ID"
fi

if [[ "$DEPLOY_BRANCH" != fork/finoo ]]; then
  echo "Finoo deployment requires branch fork/finoo" >&2
  exit 1
fi
if [[ ! "$DEPLOY_COMMIT" =~ ^[0-9a-f]{40}$ ]]; then
  echo "DEPLOY_COMMIT must be a full Git SHA" >&2
  exit 1
fi
if [[ "$FINOO_PREFLIGHT_ONLY" != true && ! "$DEPLOY_APP_DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]]; then
  echo "DEPLOY_APP_DIGEST must be an immutable sha256 digest" >&2
  exit 1
fi
if [[ "$FINOO_PREFLIGHT_ONLY" != true ]]; then
  for secret_id in \
    "$FINOO_SUPERADMIN_PASSWORD_SECRET_ID" \
    "$FINOO_ADMIN_PASSWORD_SECRET_ID" \
    "$FINOO_EMPLOYEE_PASSWORD_SECRET_ID"; do
    if [[ "$secret_id" != "$SECRET_PREFIX"/* ]]; then
      echo "Finoo password secret is outside the approved namespace" >&2
      exit 1
    fi
  done
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

LOAD_BALANCER_ARN="$(aws elbv2 describe-load-balancers \
  --region "$AWS_REGION" \
  --names "$LOAD_BALANCER_NAME" \
  --query 'LoadBalancers[0].LoadBalancerArn' \
  --output text)"
VPC_ID="$(aws elbv2 describe-load-balancers \
  --region "$AWS_REGION" \
  --names "$LOAD_BALANCER_NAME" \
  --query 'LoadBalancers[0].VpcId' \
  --output text)"
LISTENER_ARN="$(aws elbv2 describe-listeners \
  --region "$AWS_REGION" \
  --load-balancer-arn "$LOAD_BALANCER_ARN" \
  --query 'Listeners[?Port==`443`].ListenerArn|[0]' \
  --output text)"
require_value LISTENER_ARN "$LISTENER_ARN"

TARGET_GROUP_ARN="$(aws elbv2 describe-target-groups \
  --region "$AWS_REGION" \
  --names "$TARGET_GROUP_NAME" \
  --query 'TargetGroups[0].TargetGroupArn' \
  --output text 2>/dev/null || true)"
if [[ -n "$TARGET_GROUP_ARN" && "$TARGET_GROUP_ARN" != None ]]; then
  echo "Finoo target group already exists; this workflow is first-provision only" >&2
  exit 1
fi

PORT_OWNER="$(aws elbv2 describe-target-groups \
  --region "$AWS_REGION" \
  --query "TargetGroups[?Port==\`${PORT}\`].TargetGroupName" \
  --output text)"
if [[ -n "$PORT_OWNER" ]]; then
  echo "Port ${PORT} is already owned by target group ${PORT_OWNER}" >&2
  exit 1
fi

find_rule_for_hostname() {
  aws elbv2 describe-rules --region "$AWS_REGION" --listener-arn "$LISTENER_ARN" --output json |
    python3 -c 'import json,sys
hostname=sys.argv[1]
for rule in json.load(sys.stdin).get("Rules", []):
  for condition in rule.get("Conditions", []):
    values=condition.get("HostHeaderConfig", {}).get("Values", [])
    if condition.get("Field") == "host-header" and hostname in values:
      print(rule["RuleArn"])
      raise SystemExit(0)' "$HOSTNAME"
}
if [[ -n "$(find_rule_for_hostname)" ]]; then
  echo "Finoo listener rule already exists; this workflow is first-provision only" >&2
  exit 1
fi

wait_for_ssm_command() {
  local command_id="$1"
  for attempt in $(seq 1 180); do
    local command_status
    command_status="$(aws ssm get-command-invocation \
      --region "$AWS_REGION" \
      --command-id "$command_id" \
      --instance-id "$INSTANCE_ID" \
      --query Status \
      --output text 2>/dev/null || true)"
    case "$command_status" in
      Success)
        if [[ "$command_id" == "${ACTIVE_PROVISION_COMMAND_ID:-}" ]]; then
          ACTIVE_PROVISION_TERMINAL=true
        fi
        return 0
        ;;
      Failed|Cancelled|TimedOut)
        if [[ "$command_id" == "${ACTIVE_PROVISION_COMMAND_ID:-}" ]]; then
          ACTIVE_PROVISION_TERMINAL=true
        fi
        aws ssm get-command-invocation \
          --region "$AWS_REGION" \
          --command-id "$command_id" \
          --instance-id "$INSTANCE_ID" \
          --query '{Status:Status,ResponseCode:ResponseCode,Stdout:StandardOutputContent,Stderr:StandardErrorContent}' \
          --output json
        return 1
        ;;
    esac
    if (( attempt == 180 )); then
      echo "Timed out waiting for Finoo SSM command ${command_id}" >&2
      return 1
    fi
    sleep 10
  done
}

stop_active_provision() {
  if [[ -z "${ACTIVE_PROVISION_COMMAND_ID:-}" || "${ACTIVE_PROVISION_TERMINAL:-true}" == true ]]; then
    return 0
  fi
  aws ssm cancel-command \
    --region "$AWS_REGION" \
    --command-id "$ACTIVE_PROVISION_COMMAND_ID" >/dev/null 2>&1 || true
  for attempt in $(seq 1 60); do
    local command_status
    command_status="$(aws ssm get-command-invocation \
      --region "$AWS_REGION" \
      --command-id "$ACTIVE_PROVISION_COMMAND_ID" \
      --instance-id "$INSTANCE_ID" \
      --query Status \
      --output text 2>/dev/null || true)"
    case "$command_status" in
      Success|Failed|Cancelled|TimedOut)
        ACTIVE_PROVISION_TERMINAL=true
        return 0
        ;;
    esac
    sleep 5
  done
  echo "Unable to confirm that the original Finoo SSM provision stopped" >&2
  return 1
}

send_shell_command() {
  local comment="$1"
  local shell_command="$2"
  local encoded_command
  local parameters
  encoded_command="$(printf '%s' "$shell_command" | base64 | tr -d '\n')"
  parameters="$(python3 -c 'import json,sys; print(json.dumps({"commands": [f"printf %s {sys.argv[1]} | base64 --decode | bash"]}))' "$encoded_command")"
  aws ssm send-command \
    --region "$AWS_REGION" \
    --instance-ids "$INSTANCE_ID" \
    --document-name AWS-RunShellScript \
    --comment "$comment" \
    --parameters "$parameters" \
    --query 'Command.CommandId' \
    --output text
}

PREFLIGHT_COMMAND="$(send_shell_command \
  'THOM-83 Finoo first-provision preflight' \
  'set -euo pipefail
test ! -e /opt/openmercato-demos/finoo
test -z "$(docker ps -aq --filter label=com.docker.compose.project=demo-finoo)"
test -z "$(docker volume ls -q --filter label=com.docker.compose.project=demo-finoo)"
for volume_name in mercato-postgres-data-finoo mercato-redis-data-finoo mercato-meilisearch-data-finoo mercato-localstack-data-finoo mercato-init-marker-finoo mercato-attachments-storage-finoo mercato-mcp-shared-finoo; do
  ! docker volume inspect "$volume_name" >/dev/null 2>&1
done
for container_name in mercato-opencode-finoo mercato-mcp-finoo mercato-postgres-finoo mercato-redis-finoo mercato-meilisearch-finoo mercato-localstack-finoo; do
  ! docker container inspect "$container_name" >/dev/null 2>&1
done
! docker network inspect mercato-network-finoo >/dev/null 2>&1
test -z "$(docker image ls -q open-mercato/app:finoo)"
if command -v ss >/dev/null 2>&1; then ! ss -ltnH "sport = :4786" | grep -q .; fi')"
wait_for_ssm_command "$PREFLIGHT_COMMAND"
if [[ "$FINOO_PREFLIGHT_ONLY" == true ]]; then
  echo "Finoo first-provision preflight passed"
  exit 0
fi

REMOTE_SCRIPT="$(mktemp)"
TARGET_GROUP_CREATE_ATTEMPTED=false
RULE_CREATE_ATTEMPTED=false
REMOTE_PROVISION_STARTED=false
PROVISION_COMPLETE=false
RULE_ARN=""
ACTIVE_PROVISION_COMMAND_ID=""
ACTIVE_PROVISION_TERMINAL=true

cleanup_on_exit() {
  local original_status=$?
  local cleanup_failed=false
  rm -f "$REMOTE_SCRIPT"
  if [[ "$PROVISION_COMPLETE" != true ]]; then
    local remote_cleanup_safe=true
    if ! stop_active_provision; then
      remote_cleanup_safe=false
      cleanup_failed=true
    fi
    if [[ "$RULE_CREATE_ATTEMPTED" == true ]]; then
      local reconciled_rule_arn
      local reconciled_rule_target
      local reconciled_target_group_arn
      reconciled_rule_arn="$(find_rule_for_hostname)"
      reconciled_target_group_arn="$(aws elbv2 describe-target-groups \
        --region "$AWS_REGION" \
        --names "$TARGET_GROUP_NAME" \
        --query 'TargetGroups[0].TargetGroupArn' \
        --output text 2>/dev/null || true)"
      if [[ -n "$reconciled_rule_arn" ]]; then
        reconciled_rule_target="$(aws elbv2 describe-rules \
          --region "$AWS_REGION" \
          --rule-arns "$reconciled_rule_arn" \
          --query 'Rules[0].Actions[?Type==`forward`].TargetGroupArn|[0]' \
          --output text 2>/dev/null || true)"
        if [[ -n "$reconciled_target_group_arn" && "$reconciled_target_group_arn" != None && \
              "$reconciled_rule_target" == "$reconciled_target_group_arn" ]]; then
          if ! aws elbv2 delete-rule --region "$AWS_REGION" --rule-arn "$reconciled_rule_arn" >/dev/null; then
            echo "Failed to delete the reconciled Finoo listener rule" >&2
            cleanup_failed=true
          fi
        else
          echo "Refusing to delete a Finoo hostname rule with an unexpected target" >&2
          cleanup_failed=true
        fi
      fi
    fi
    if [[ "$TARGET_GROUP_CREATE_ATTEMPTED" == true ]]; then
      local reconciled_target_group_arn
      local reconciled_target_group_shape
      reconciled_target_group_arn="$(aws elbv2 describe-target-groups \
        --region "$AWS_REGION" \
        --names "$TARGET_GROUP_NAME" \
        --query 'TargetGroups[0].TargetGroupArn' \
        --output text 2>/dev/null || true)"
      if [[ -n "$reconciled_target_group_arn" && "$reconciled_target_group_arn" != None ]]; then
        reconciled_target_group_shape="$(aws elbv2 describe-target-groups \
          --region "$AWS_REGION" \
          --target-group-arns "$reconciled_target_group_arn" \
          --query 'TargetGroups[0].[Port,VpcId,Protocol,HealthCheckPath]' \
          --output text 2>/dev/null || true)"
        if [[ "$reconciled_target_group_shape" == $'4786\t'"${VPC_ID}"$'\tHTTP\t/login' ]]; then
          aws elbv2 deregister-targets \
            --region "$AWS_REGION" \
            --target-group-arn "$reconciled_target_group_arn" \
            --targets "Id=${INSTANCE_ID},Port=${PORT}" >/dev/null 2>&1 || true
          if ! aws elbv2 delete-target-group \
            --region "$AWS_REGION" \
            --target-group-arn "$reconciled_target_group_arn" >/dev/null; then
            echo "Failed to delete the reconciled Finoo target group" >&2
            cleanup_failed=true
          fi
        else
          echo "Refusing to delete a Finoo target group with an unexpected shape" >&2
          cleanup_failed=true
        fi
      fi
    fi
    if [[ "$REMOTE_PROVISION_STARTED" == true && "$remote_cleanup_safe" == true ]]; then
      local cleanup_command_id
      cleanup_command_id="$(send_shell_command \
        'THOM-83 rollback failed Finoo first provision' \
        'set -euo pipefail
if [[ -f /opt/openmercato-demos/finoo/.finoo-first-provision-owned ]]; then
  cd /opt/openmercato-demos/finoo
  docker compose --project-name demo-finoo --env-file .env -f docker-compose.fullapp.yml -f infra/aws-upstream-baseline/docker-compose.finoo-provision.yml down --remove-orphans --volumes || true
fi
docker image rm open-mercato/app:finoo >/dev/null 2>&1 || true
rm -rf -- /opt/openmercato-demos/finoo')" || true
      if [[ -n "${cleanup_command_id:-}" ]]; then
        if ! wait_for_ssm_command "$cleanup_command_id"; then
          echo "Failed to complete the reconciled Finoo host rollback" >&2
          cleanup_failed=true
        fi
      fi
    fi
    if [[ "$REMOTE_PROVISION_STARTED" == true && "$remote_cleanup_safe" != true ]]; then
      echo "Skipping destructive host rollback while the original SSM command may still be running" >&2
    fi
    if [[ "$cleanup_failed" == true ]]; then
      echo "Finoo rollback requires manual read-only reconciliation before retry" >&2
    fi
  fi
  return "$original_status"
}
trap cleanup_on_exit EXIT

{
  echo "bash <<'EOF_FINOO_PROVISION'"
  echo 'set -euo pipefail'
  printf 'aws_region=%q\n' "$AWS_REGION"
  printf 'branch=%q\n' "$DEPLOY_BRANCH"
  printf 'deploy_commit=%q\n' "$DEPLOY_COMMIT"
  printf 'deploy_app_image=%q\n' "$DEPLOY_APP_IMAGE"
  printf 'deploy_app_digest=%q\n' "$DEPLOY_APP_DIGEST"
  printf 'superadmin_secret_id=%q\n' "$FINOO_SUPERADMIN_PASSWORD_SECRET_ID"
  printf 'admin_secret_id=%q\n' "$FINOO_ADMIN_PASSWORD_SECRET_ID"
  printf 'employee_secret_id=%q\n' "$FINOO_EMPLOYEE_PASSWORD_SECRET_ID"
  printf 'repo_url=%q\n' "$REPO_URL"
  printf 'workdir=%q\n' "$WORKDIR"
  printf 'project_name=%q\n' "$PROJECT_NAME"
  printf 'deploy_env=%q\n' "$DEPLOY_ENV"
  printf 'demo_port=%q\n' "$PORT"
  cat <<'EOF_REMOTE'
for command_name in aws docker git openssl python3 curl; do
  command -v "$command_name" >/dev/null 2>&1 || { echo "Missing runtime command: $command_name" >&2; exit 1; }
done
docker compose version >/dev/null
export GIT_TERMINAL_PROMPT=0

provision_succeeded=false
docker_config=""
cleanup_failed_provision() {
  local original_status=$?
  unset FINOO_BOOTSTRAP_SUPERADMIN_PASSWORD FINOO_BOOTSTRAP_ADMIN_PASSWORD FINOO_BOOTSTRAP_EMPLOYEE_PASSWORD
  unset superadmin_password admin_password employee_password
  if [[ -n "$docker_config" ]]; then
    docker logout "${deploy_app_image%%/*}" >/dev/null 2>&1 || true
    rm -rf -- "$docker_config"
  fi
  if [[ "$provision_succeeded" != true && -d "$workdir" ]]; then
    cd "$workdir"
    if [[ -f .env && -f .finoo-first-provision-owned ]]; then
      docker compose --project-name "$project_name" --env-file .env \
        -f docker-compose.fullapp.yml \
        -f infra/aws-upstream-baseline/docker-compose.finoo-provision.yml \
        down --remove-orphans --volumes >/dev/null 2>&1 || true
    fi
    cd /
    docker image rm "open-mercato/app:${deploy_env}" >/dev/null 2>&1 || true
    rm -rf -- "$workdir"
  fi
  return "$original_status"
}
trap cleanup_failed_provision EXIT

assert_literal_runtime_absent() {
  local volume_name
  local container_name
  for volume_name in \
    mercato-postgres-data-finoo \
    mercato-redis-data-finoo \
    mercato-meilisearch-data-finoo \
    mercato-localstack-data-finoo \
    mercato-init-marker-finoo \
    mercato-attachments-storage-finoo \
    mercato-mcp-shared-finoo; do
    ! docker volume inspect "$volume_name" >/dev/null 2>&1 || return 1
  done
  for container_name in \
    mercato-opencode-finoo \
    mercato-mcp-finoo \
    mercato-postgres-finoo \
    mercato-redis-finoo \
    mercato-meilisearch-finoo \
    mercato-localstack-finoo; do
    ! docker container inspect "$container_name" >/dev/null 2>&1 || return 1
  done
  ! docker network inspect mercato-network-finoo >/dev/null 2>&1
}

if [[ -e "$workdir" ]] || \
   [[ -n "$(docker ps -aq --filter label=com.docker.compose.project=${project_name})" ]] || \
   [[ -n "$(docker volume ls -q --filter label=com.docker.compose.project=${project_name})" ]] || \
   [[ -n "$(docker image ls -q open-mercato/app:${deploy_env})" ]] || \
   { command -v ss >/dev/null 2>&1 && ss -ltnH "sport = :${demo_port}" | grep -q .; } || \
   ! assert_literal_runtime_absent; then
  echo "Finoo runtime state already exists; refusing a first-provision workflow" >&2
  exit 1
fi

read_secret() {
  aws secretsmanager get-secret-value \
    --region "$aws_region" \
    --secret-id "$1" \
    --query SecretString \
    --output text
}

validate_password() {
  local value="$1"
  if (( ${#value} < 20 || ${#value} > 96 )) || \
    [[ ! "$value" =~ ^[A-Za-z0-9._!@%+=:-]+$ ]] || \
    [[ ! "$value" =~ [A-Z] ]] || \
    [[ ! "$value" =~ [a-z] ]] || \
    [[ ! "$value" =~ [0-9] ]] || \
    [[ ! "$value" =~ [._!@%+=:-] ]]; then
    echo "Finoo password secret does not satisfy the single-line deployment policy" >&2
    exit 1
  fi
}

superadmin_password="$(read_secret "$superadmin_secret_id")"
admin_password="$(read_secret "$admin_secret_id")"
employee_password="$(read_secret "$employee_secret_id")"
validate_password "$superadmin_password"
validate_password "$admin_password"
validate_password "$employee_password"
if [[ "$superadmin_password" == "$admin_password" || \
      "$superadmin_password" == "$employee_password" || \
      "$admin_password" == "$employee_password" ]]; then
  echo "Finoo role passwords must be independent" >&2
  exit 1
fi

mkdir -p "$(dirname "$workdir")"
timeout 300 git clone --branch "$branch" --single-branch "$repo_url" "$workdir"
if [[ "$(git -C "$workdir" rev-parse HEAD)" != "$deploy_commit" ]]; then
  echo "Finoo checkout does not match the requested immutable commit" >&2
  exit 1
fi

env_file="$workdir/.env"
umask 077
: > "$env_file"
set_env_value() {
  local key="$1"
  local value="$2"
  if [[ "$value" == *$'\n'* || "$value" == *$'\r'* ]]; then
    echo "Refusing a multiline Finoo environment value" >&2
    exit 1
  fi
  printf '%s=%s\n' "$key" "$value" >> "$env_file"
}
set_env_value APP_NAME finoo-demo
set_env_value DEPLOY_ENV "$deploy_env"
set_env_value APP_PORT "$demo_port"
set_env_value CONTAINER_PORT 3000
set_env_value APP_URL https://finoo.om.they.dev
set_env_value NEXT_PUBLIC_APP_URL https://finoo.om.they.dev
set_env_value PLATFORM_PORTAL_BASE_URL https://finoo.om.they.dev
set_env_value PLATFORM_DOMAINS finoo.om.they.dev
set_env_value POSTGRES_USER postgres
set_env_value POSTGRES_PASSWORD "$(openssl rand -hex 32)"
set_env_value POSTGRES_DB open-mercato
set_env_value JWT_SECRET "$(openssl rand -hex 48)"
set_env_value NEXTAUTH_SECRET "$(openssl rand -hex 48)"
set_env_value CONSENT_INTEGRITY_SECRET "$(openssl rand -hex 48)"
set_env_value TENANT_DATA_ENCRYPTION_KEY "$(openssl rand -hex 48)"
set_env_value MEILISEARCH_MASTER_KEY "$(openssl rand -hex 32)"
set_env_value DEMO_MODE true
set_env_value SELF_SERVICE_ONBOARDING_ENABLED false
set_env_value MERCATO_INIT_ARGS --no-examples
set_env_value OM_INIT_REDACT_CREDENTIAL_OUTPUT true
set_env_value OM_INIT_SUPERADMIN_EMAIL superadmin@finoo.om.they.dev
set_env_value OM_INIT_ADMIN_EMAIL admin@finoo.om.they.dev
set_env_value OM_INIT_EMPLOYEE_EMAIL employee@finoo.om.they.dev
chmod 600 "$env_file"

docker_config="$(mktemp -d)"
chmod 700 "$docker_config"
export DOCKER_CONFIG="$docker_config"
registry="${deploy_app_image%%/*}"
aws ecr get-login-password --region "$aws_region" |
  docker login "$registry" --username AWS --password-stdin >/dev/null
docker pull "$deploy_app_image" >/dev/null
repo_digests="$(docker image inspect --format '{{json .RepoDigests}}' "$deploy_app_image")"
if [[ "$repo_digests" != *"@$deploy_app_digest"* ]]; then
  echo "Pulled Finoo image does not match the requested digest" >&2
  exit 1
fi
docker tag "$deploy_app_image" "open-mercato/app:${deploy_env}"
docker logout "$registry" >/dev/null 2>&1 || true
rm -rf -- "$docker_config"
docker_config=""
unset DOCKER_CONFIG

cd "$workdir"
compose=(docker compose --project-name "$project_name" --env-file "$env_file" \
  -f docker-compose.fullapp.yml \
  -f infra/aws-upstream-baseline/docker-compose.finoo-provision.yml)

wait_for_login() {
  for attempt in $(seq 1 120); do
    if curl -fsS --max-time 5 -o /dev/null "http://127.0.0.1:${demo_port}/login"; then return 0; fi
    sleep 5
  done
  echo "Finoo app did not become reachable on the host" >&2
  return 1
}

run_role_smoke() {
  local role="$1"
  local email="$2"
  local password="$3"
  printf '%s\n' "$password" |
    "${compose[@]}" exec -T \
      -e "SMOKE_TEST_EMAIL=${email}" \
      -e "EXPECTED_ROLE=${role}" \
      -e BASE_URL=http://127.0.0.1:3000 \
      app sh -lc \
        'IFS= read -r SMOKE_TEST_PASSWORD; export SMOKE_TEST_PASSWORD; exec node /tmp/finoo-smoke-auth-dashboard.mjs --run-smoke'
}

install_smoke_script() {
  "${compose[@]}" cp scripts/smoke-auth-dashboard.mjs app:/tmp/finoo-smoke-auth-dashboard.mjs
}

export FINOO_BOOTSTRAP_SUPERADMIN_PASSWORD="$superadmin_password"
export FINOO_BOOTSTRAP_ADMIN_PASSWORD="$admin_password"
export FINOO_BOOTSTRAP_EMPLOYEE_PASSWORD="$employee_password"
if ! assert_literal_runtime_absent; then
  echo "Literal Finoo runtime state appeared before Compose creation" >&2
  exit 1
fi
touch .finoo-first-provision-owned
chmod 600 .finoo-first-provision-owned
"${compose[@]}" up -d --no-build --remove-orphans
wait_for_login
install_smoke_script
run_role_smoke superadmin superadmin@finoo.om.they.dev "$superadmin_password"
run_role_smoke admin admin@finoo.om.they.dev "$admin_password"
run_role_smoke employee employee@finoo.om.they.dev "$employee_password"

unset FINOO_BOOTSTRAP_SUPERADMIN_PASSWORD FINOO_BOOTSTRAP_ADMIN_PASSWORD FINOO_BOOTSTRAP_EMPLOYEE_PASSWORD
"${compose[@]}" up -d --no-deps --no-build --force-recreate app
wait_for_login
install_smoke_script
run_role_smoke superadmin superadmin@finoo.om.they.dev "$superadmin_password"
run_role_smoke admin admin@finoo.om.they.dev "$admin_password"
run_role_smoke employee employee@finoo.om.they.dev "$employee_password"

app_container="$("${compose[@]}" ps -q app)"
if [[ -z "$app_container" ]]; then
  echo "Finoo app container was not created" >&2
  exit 1
fi
if docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$app_container" |
  grep -Eq '^OM_INIT_(SUPERADMIN|ADMIN|EMPLOYEE)_PASSWORD=.+$'; then
  echo "Finoo bootstrap passwords remain in the running container" >&2
  exit 1
fi
if grep -Eq '(^|PASSWORD=)(.*@finoo\.om\.they\.dev|[^[:space:]]{20,})' "$env_file"; then
  if grep -Eq '^OM_INIT_(SUPERADMIN|ADMIN|EMPLOYEE)_PASSWORD=.+$' "$env_file"; then
    echo "Finoo bootstrap passwords remain in the persistent runtime env" >&2
    exit 1
  fi
fi

unset superadmin_password admin_password employee_password
provision_succeeded=true
echo "remote_finoo_commit=$deploy_commit"
echo "remote_finoo_image_digest=$deploy_app_digest"
EOF_REMOTE
  echo 'EOF_FINOO_PROVISION'
} > "$REMOTE_SCRIPT"

COMMAND_PARAMETERS="$(python3 - "$REMOTE_SCRIPT" <<'PY'
import json, sys
from pathlib import Path
print(json.dumps({'commands': [Path(sys.argv[1]).read_text()]}))
PY
)"
COMMAND_ID="$(aws ssm send-command \
  --region "$AWS_REGION" \
  --instance-ids "$INSTANCE_ID" \
  --document-name AWS-RunShellScript \
  --comment "THOM-83 immutable Finoo first provision" \
  --parameters "$COMMAND_PARAMETERS" \
  --query 'Command.CommandId' \
  --output text)"
REMOTE_PROVISION_STARTED=true
ACTIVE_PROVISION_COMMAND_ID="$COMMAND_ID"
ACTIVE_PROVISION_TERMINAL=false
wait_for_ssm_command "$COMMAND_ID"
aws ssm get-command-invocation \
  --region "$AWS_REGION" \
  --command-id "$COMMAND_ID" \
  --instance-id "$INSTANCE_ID" \
  --query StandardOutputContent \
  --output text

if [[ -n "$(aws elbv2 describe-target-groups \
  --region "$AWS_REGION" \
  --names "$TARGET_GROUP_NAME" \
  --query 'TargetGroups[0].TargetGroupArn' \
  --output text 2>/dev/null || true)" ]] || \
   [[ -n "$(aws elbv2 describe-target-groups \
     --region "$AWS_REGION" \
     --query "TargetGroups[?Port==\`${PORT}\`].TargetGroupName" \
     --output text)" ]] || \
   [[ -n "$(find_rule_for_hostname)" ]]; then
  echo "Finoo ALB state changed after preflight; refusing provisioning" >&2
  exit 1
fi

TARGET_GROUP_CREATE_ATTEMPTED=true
TARGET_GROUP_ARN="$(aws elbv2 create-target-group \
  --region "$AWS_REGION" \
  --name "$TARGET_GROUP_NAME" \
  --protocol HTTP \
  --port "$PORT" \
  --vpc-id "$VPC_ID" \
  --target-type instance \
  --health-check-protocol HTTP \
  --health-check-port "$PORT" \
  --health-check-path /login \
  --health-check-interval-seconds 15 \
  --health-check-timeout-seconds 10 \
  --healthy-threshold-count 2 \
  --unhealthy-threshold-count 2 \
  --matcher HttpCode=200-399 \
  --query 'TargetGroups[0].TargetGroupArn' \
  --output text)"

aws elbv2 register-targets \
  --region "$AWS_REGION" \
  --target-group-arn "$TARGET_GROUP_ARN" \
  --targets "Id=${INSTANCE_ID},Port=${PORT}" >/dev/null

RULES_JSON="$(aws elbv2 describe-rules --region "$AWS_REGION" --listener-arn "$LISTENER_ARN" --output json)"
PRIORITY="$(python3 -c 'import json,sys
used={int(rule["Priority"]) for rule in json.loads(sys.argv[1]).get("Rules", []) if rule.get("Priority", "").isdigit()}
print(next(value for value in range(1000, 50000) if value not in used))' "$RULES_JSON")"
if [[ -n "$(find_rule_for_hostname)" ]]; then
  echo "Finoo listener rule appeared after target registration; refusing provisioning" >&2
  exit 1
fi
RULE_CREATE_ATTEMPTED=true
RULE_ARN="$(aws elbv2 create-rule \
  --region "$AWS_REGION" \
  --listener-arn "$LISTENER_ARN" \
  --priority "$PRIORITY" \
  --conditions "[{\"Field\":\"host-header\",\"HostHeaderConfig\":{\"Values\":[\"${HOSTNAME}\"]}}]" \
  --actions "[{\"Type\":\"forward\",\"TargetGroupArn\":\"${TARGET_GROUP_ARN}\"}]" \
  --query 'Rules[0].RuleArn' \
  --output text)"

aws elbv2 wait target-in-service \
  --region "$AWS_REGION" \
  --target-group-arn "$TARGET_GROUP_ARN" \
  --targets "Id=${INSTANCE_ID},Port=${PORT}"

for attempt in $(seq 1 60); do
  if curl -fsS --max-time 10 -o /dev/null "https://${HOSTNAME}/login"; then break; fi
  if (( attempt == 60 )); then
    echo "Finoo HTTPS login page did not become reachable" >&2
    exit 1
  fi
  sleep 5
done

PROVISION_COMPLETE=true
echo "finoo_hostname=${HOSTNAME}"
echo "finoo_url=https://${HOSTNAME}"
echo "finoo_port=${PORT}"
echo "finoo_target_group_arn=${TARGET_GROUP_ARN}"
echo "finoo_commit=${DEPLOY_COMMIT}"
echo "finoo_image_digest=${DEPLOY_APP_DIGEST}"
