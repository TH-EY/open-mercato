#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./preview-common.sh
source "${SCRIPT_DIR}/preview-common.sh"

BRANCH="${BRANCH:-upstream-baseline}"
DEPLOY_MODE="${DEPLOY_MODE:-full}"
BASELINE_PROJECT="${BASELINE_PROJECT:-baseline-zjkhnl}"
BASELINE_WORKDIR="${BASELINE_WORKDIR:-/etc/dokploy/compose/baseline-zjkhnl/code}"
BASELINE_URL="${BASELINE_URL:-https://om.they.dev}"

if [[ "${DEPLOY_MODE}" != "full" && "${DEPLOY_MODE}" != "config-restart" ]]; then
  echo "DEPLOY_MODE must be either 'full' or 'config-restart'" >&2
  exit 1
fi

REMOTE_SCRIPT="$(mktemp)"
{
  echo '#!/usr/bin/env bash'
  echo 'set -euo pipefail'
  printf 'branch=%q\n' "${BRANCH}"
  printf 'repo_url=%q\n' "${PREVIEW_REPO_URL}"
  printf 'deploy_mode=%q\n' "${DEPLOY_MODE}"
  printf 'baseline_project=%q\n' "${BASELINE_PROJECT}"
  printf 'workdir=%q\n' "${BASELINE_WORKDIR}"
  cat <<'EOF'
command -v git >/dev/null 2>&1 || { echo "Missing git on baseline host" >&2; exit 1; }
command -v docker >/dev/null 2>&1 || { echo "Missing docker on baseline host" >&2; exit 1; }

if [[ ! -d "$workdir/.git" ]]; then
  if [[ "$deploy_mode" == "config-restart" ]]; then
    echo "Config-only deploy requires an existing baseline checkout at ${workdir}" >&2
    exit 1
  fi
  rm -rf "$workdir"
  git clone --branch "$branch" --single-branch "$repo_url" "$workdir"
else
  if [[ "$deploy_mode" == "full" ]]; then
    git -C "$workdir" remote set-url origin "$repo_url"
    git -C "$workdir" config --unset-all remote.origin.fetch || true
    git -C "$workdir" config --add remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*'
    git -C "$workdir" fetch origin --prune
    git -C "$workdir" checkout -B "$branch" "origin/$branch"
    git -C "$workdir" reset --hard "origin/$branch"
    git -C "$workdir" clean -fdx -e .env
  fi
fi

cd "$workdir"
set -a
. ./.env
set +a

compose() {
  COMPOSE_BAKE=false COMPOSE_DOCKER_CLI_BUILD=0 DOCKER_BUILDKIT=0 docker compose --project-name "$baseline_project" --env-file .env -f docker-compose.fullapp.yml "$@"
}

wait_for_local_login() {
  local url="http://127.0.0.1:${APP_PORT:-3001}/login"
  for attempt in $(seq 1 40); do
    status="$(curl -fsS -o /tmp/openmercato-baseline-login.html -w '%{http_code}' "$url" 2>/dev/null || true)"
    if [[ "$status" =~ ^[23] ]]; then
      echo "Local baseline login endpoint is reachable: ${url} (${status})"
      return 0
    fi
    echo "Waiting for local baseline login endpoint (${attempt}/40): ${status:-no response}"
    sleep 5
  done
  cat /tmp/openmercato-baseline-login.html 2>/dev/null || true
  echo "Baseline app did not become reachable at ${url}" >&2
  return 1
}

post_deploy_cleanup() {
  echo "Post-deploy cleanup; app is already running:"
  df -h /
  timeout 30s docker system df || echo "docker system df skipped, failed, or timed out"
  timeout 6m docker builder prune -af || echo "docker builder prune skipped, failed, or timed out"
  timeout 3m docker image prune -f || echo "docker image prune skipped, failed, or timed out"
  echo "Post-deploy cleanup complete:"
  df -h /
  timeout 30s docker system df || echo "docker system df skipped, failed, or timed out"
}

app_image="open-mercato/app:${DEPLOY_ENV:-local}"
if [[ "$deploy_mode" == "config-restart" ]]; then
  echo "Config-only baseline deploy: skipping image build and restarting app with existing image."
  if ! timeout 30s docker image inspect "$app_image" >/dev/null 2>&1; then
    echo "Missing existing image ${app_image}; run a full deploy first." >&2
    exit 1
  fi
  compose up -d --no-deps --no-build --force-recreate app
else
  if ! timeout 30s docker image inspect opencode-mvp:latest >/dev/null 2>&1; then
    docker build -t opencode-mvp:latest docker/opencode
  fi
  build_log="/tmp/openmercato-baseline-${DEPLOY_ENV:-local}-build.log"
  rm -f "$build_log"
  echo "Building new baseline app image while the current app container stays online."
  if ! DOCKER_BUILDKIT=1 BUILDKIT_PROGRESS=plain timeout 45m docker build --progress=plain \
    --build-arg CONTAINER_PORT="${CONTAINER_PORT:-3000}" \
    -t "$app_image" \
    . >"$build_log" 2>&1; then
    tail -n 240 "$build_log" || true
    exit 1
  fi
  tail -n 80 "$build_log" || true
  compose up -d --no-build --remove-orphans postgres redis meilisearch opencode
  compose up -d --no-deps --no-build --force-recreate app
fi
wait_for_local_login
post_deploy_cleanup
EOF
} > "${REMOTE_SCRIPT}"

COMMANDS_JSON="$(python3 - <<'PY' "${REMOTE_SCRIPT}"
import json, sys
path = sys.argv[1]
print(json.dumps({'commands': [open(path, 'r', encoding='utf-8').read()]}))
PY
)"
COMMAND_ID="$(aws ssm send-command \
  --region "${AWS_REGION}" \
  --instance-ids "${PREVIEW_INSTANCE_ID}" \
  --document-name AWS-RunShellScript \
  --parameters "${COMMANDS_JSON}" \
  --query 'Command.CommandId' \
  --output text)"
echo "SSM baseline deploy command sent: ${COMMAND_ID}"
wait_for_ssm_command "${COMMAND_ID}" "${PREVIEW_INSTANCE_ID}"
echo "SSM baseline deploy command completed: ${COMMAND_ID}"
rm -f "${REMOTE_SCRIPT}"

wait_for_http_200 "${BASELINE_URL}/login" 90
echo "baseline_url=${BASELINE_URL}"
echo "baseline_branch=${BRANCH}"
echo "baseline_deploy_mode=${DEPLOY_MODE}"
