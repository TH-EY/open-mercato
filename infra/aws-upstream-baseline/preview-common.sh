#!/usr/bin/env bash
set -euo pipefail

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing required command: $1" >&2
    exit 1
  }
}

require_cmd aws
require_cmd python3
require_cmd curl

export AWS_PAGER=""

AWS_REGION="${AWS_REGION:-eu-west-2}"
VPC_ID="${VPC_ID:-vpc-20252849}"
HOSTED_ZONE_ID="${HOSTED_ZONE_ID:-Z05995411RZM1GDPTHOZ6}"
ALB_ARN="${ALB_ARN:-arn:aws:elasticloadbalancing:eu-west-2:062648047691:loadbalancer/app/they-lb/fe10e6ccedf3d536}"
ALB_SG_ID="${ALB_SG_ID:-sg-0855bb417b5a17266}"
LISTENER_ARN="${LISTENER_ARN:-$(aws elbv2 describe-listeners --region "${AWS_REGION}" --load-balancer-arn "${ALB_ARN}" --query 'Listeners[?Port==`443`].ListenerArn | [0]' --output text)}"
ALB_DNS_NAME="${ALB_DNS_NAME:-$(aws elbv2 describe-load-balancers --region "${AWS_REGION}" --load-balancer-arns "${ALB_ARN}" --query 'LoadBalancers[0].DNSName' --output text)}"
ALB_ZONE_ID="${ALB_ZONE_ID:-$(aws elbv2 describe-load-balancers --region "${AWS_REGION}" --load-balancer-arns "${ALB_ARN}" --query 'LoadBalancers[0].CanonicalHostedZoneId' --output text)}"
PREVIEW_INSTANCE_ID="${PREVIEW_INSTANCE_ID:-i-0c6ec8e5a53900297}"
PREVIEW_HOST_SUFFIX="${PREVIEW_HOST_SUFFIX:-om.they.dev}"
PREVIEW_PORT_MIN="${PREVIEW_PORT_MIN:-4100}"
PREVIEW_PORT_MAX="${PREVIEW_PORT_MAX:-4899}"
PREVIEW_RULE_PRIORITY_MIN="${PREVIEW_RULE_PRIORITY_MIN:-1000}"
PREVIEW_RULE_PRIORITY_MAX="${PREVIEW_RULE_PRIORITY_MAX:-49999}"
PREVIEW_REMOTE_ROOT="${PREVIEW_REMOTE_ROOT:-/opt/openmercato-previews}"
PREVIEW_REPO_URL="${PREVIEW_REPO_URL:-https://github.com/TH-EY/open-mercato.git}"
BASELINE_ENV_FILE_REMOTE="${BASELINE_ENV_FILE_REMOTE:-/etc/dokploy/compose/baseline-zjkhnl/code/.env}"

json_escape() {
  python3 - <<'PY' "$1"
import json, sys
print(json.dumps(sys.argv[1]))
PY
}

branch_to_preview_slug() {
  python3 - <<'PY' "$1"
import hashlib, re, sys
branch = sys.argv[1]
base = branch
if base.startswith("refs/heads/"):
    base = base[len("refs/heads/"):]
if base == "fork/EPC":
    print("epc")
    raise SystemExit(0)
if base.startswith("contrib/"):
    base = base[len("contrib/"):]
base = base.lower()
base = re.sub(r'[^a-z0-9]+', '-', base).strip('-') or 'preview'
digest = hashlib.sha1(branch.encode()).hexdigest()[:6]
slug = f"{base[:36].rstrip('-')}-{digest}" if len(base) > 36 else f"{base}-{digest}"
print(slug[:50].strip('-'))
PY
}

preview_hostname_for_slug() {
  printf 'preview-%s.%s\n' "$1" "${PREVIEW_HOST_SUFFIX}"
}

preview_runtime_env_for_slug() {
  python3 - <<'PY' "$1"
import hashlib, sys
slug = sys.argv[1]
print(f"prv-{hashlib.sha1(slug.encode()).hexdigest()[:12]}")
PY
}

target_group_name_for_slug() {
  python3 - <<'PY' "$1"
import hashlib, sys
slug = sys.argv[1]
print(f"om-prv-{hashlib.sha1(slug.encode()).hexdigest()[:10]}")
PY
}

used_preview_ports() {
  aws elbv2 describe-target-groups \
    --region "${AWS_REGION}" \
    --query 'TargetGroups[?starts_with(TargetGroupName, `om-prv-`)].Port' \
    --output text | tr '\t' '\n' | grep -E '^[0-9]+$' || true
}

choose_preview_port() {
  local slug="$1"
  local tg_name="$2"
  local existing_port
  existing_port="$(aws elbv2 describe-target-groups --region "${AWS_REGION}" --names "${tg_name}" --query 'TargetGroups[0].Port' --output text 2>/dev/null || true)"
  if [[ -n "${existing_port}" && "${existing_port}" != "None" ]]; then
    echo "${existing_port}"
    return 0
  fi

  python3 - <<'PY' "${slug}" "${PREVIEW_PORT_MIN}" "${PREVIEW_PORT_MAX}" "$(used_preview_ports | tr '\n' ' ')"
import hashlib, sys
slug = sys.argv[1]
port_min = int(sys.argv[2])
port_max = int(sys.argv[3])
used = {int(x) for x in sys.argv[4].split() if x.strip()}
span = port_max - port_min + 1
start = port_min + (int(hashlib.sha1(slug.encode()).hexdigest()[:8], 16) % span)
for offset in range(span):
    candidate = port_min + ((start - port_min + offset) % span)
    if candidate not in used:
        print(candidate)
        break
else:
    raise SystemExit("No free preview port available")
PY
}

existing_rule_arn_for_host() {
  local host="$1"
  local rules_json
  rules_json="$(aws elbv2 describe-rules --region "${AWS_REGION}" --listener-arn "${LISTENER_ARN}" --output json)"
  python3 - <<'PY' "$host" "$rules_json"
import json, sys
host = sys.argv[1]
data = json.loads(sys.argv[2])
for rule in data.get("Rules", []):
    for condition in rule.get("Conditions", []):
        values = ((condition.get("HostHeaderConfig") or {}).get("Values") or [])
        if condition.get("Field") == "host-header" and host in values:
            print(rule["RuleArn"])
            raise SystemExit(0)
print("")
PY
}

choose_rule_priority() {
  local rules_json
  rules_json="$(aws elbv2 describe-rules --region "${AWS_REGION}" --listener-arn "${LISTENER_ARN}" --output json)"
  python3 - <<'PY' "${PREVIEW_RULE_PRIORITY_MIN}" "${PREVIEW_RULE_PRIORITY_MAX}" "$rules_json"
import json, sys
low = int(sys.argv[1])
high = int(sys.argv[2])
data = json.loads(sys.argv[3])
used = set()
for rule in data.get("Rules", []):
    priority = rule.get("Priority")
    if priority and priority != 'default':
        used.add(int(priority))
for candidate in range(low, high + 1):
    if candidate not in used:
        print(candidate)
        break
else:
    raise SystemExit("No free listener rule priority available")
PY
}

wait_for_ssm_command() {
  local command_id="$1"
  local instance_id="$2"
  while true; do
    local status
    status="$(aws ssm get-command-invocation --region "${AWS_REGION}" --command-id "${command_id}" --instance-id "${instance_id}" --query 'Status' --output text)"
    case "${status}" in
      Pending|InProgress|Delayed)
        sleep 10
        ;;
      Success)
        aws ssm get-command-invocation --region "${AWS_REGION}" --command-id "${command_id}" --instance-id "${instance_id}" --query 'StandardOutputContent' --output text
        return 0
        ;;
      *)
        aws ssm get-command-invocation --region "${AWS_REGION}" --command-id "${command_id}" --instance-id "${instance_id}" --output json >&2 || true
        return 1
        ;;
    esac
  done
}

wait_for_target_healthy() {
  local tg_arn="$1"
  local max_attempts="${2:-60}"
  local attempt=1
  while (( attempt <= max_attempts )); do
    local state
    state="$(aws elbv2 describe-target-health --region "${AWS_REGION}" --target-group-arn "${tg_arn}" --query 'TargetHealthDescriptions[0].TargetHealth.State' --output text 2>/dev/null || true)"
    if [[ "${state}" == "healthy" ]]; then
      return 0
    fi
    sleep 10
    ((attempt++))
  done
  aws elbv2 describe-target-health --region "${AWS_REGION}" --target-group-arn "${tg_arn}" --output json >&2 || true
  return 1
}

wait_for_http_200() {
  local url="$1"
  local max_attempts="${2:-60}"
  local attempt=1
  while (( attempt <= max_attempts )); do
    local code
    code="$(curl -k -s -o /dev/null -w '%{http_code}' "${url}" || true)"
    if [[ "${code}" == "200" || "${code}" == "302" || "${code}" == "307" ]]; then
      return 0
    fi
    sleep 10
    ((attempt++))
  done
  return 1
}
