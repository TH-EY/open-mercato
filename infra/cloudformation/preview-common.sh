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

export AWS_PAGER=""

AWS_REGION="${AWS_REGION:-eu-west-2}"
PROD_STACK_NAME="${PROD_STACK_NAME:-openmercato}"
PREVIEW_STACK_PREFIX="${PREVIEW_STACK_PREFIX:-openmercato-preview}"
PREVIEW_HOST_SUFFIX="${PREVIEW_HOST_SUFFIX:-openmercato.they.dev}"
PREVIEW_RULE_PRIORITY_MIN="${PREVIEW_RULE_PRIORITY_MIN:-6000}"
PREVIEW_RULE_PRIORITY_MAX="${PREVIEW_RULE_PRIORITY_MAX:-6999}"
PREVIEW_LIMIT="${PREVIEW_LIMIT:-8}"
COMMON_SOURCE="${BASH_SOURCE:-$0}"
PREVIEW_TEMPLATE="${PREVIEW_TEMPLATE:-$(cd -- "$(dirname -- "${COMMON_SOURCE}")" && pwd)/preview.yml}"
CFN_S3_BUCKET="${CFN_S3_BUCKET:-openmercato-terraform-state-062648047691-eu-west-2}"
CFN_S3_PREFIX="${CFN_S3_PREFIX:-cloudformation/previews}"
EXISTING_LOAD_BALANCER_VPC_ID="${EXISTING_LOAD_BALANCER_VPC_ID:-vpc-20252849}"
EXISTING_LOAD_BALANCER_HTTPS_LISTENER_ARN="${EXISTING_LOAD_BALANCER_HTTPS_LISTENER_ARN:-arn:aws:elasticloadbalancing:eu-west-2:062648047691:listener/app/they-lb/fe10e6ccedf3d536/15478d3e1d97aedc}"

branch_to_preview_slug() {
  python3 - <<'PY' "$1"
import hashlib, re, sys
branch = sys.argv[1]
base = branch
if base.startswith('refs/heads/'):
    base = base[len('refs/heads/'):]
if base.startswith('contrib/'):
    base = base[len('contrib/'):]
base = base.lower()
base = re.sub(r'[^a-z0-9]+', '-', base).strip('-') or 'preview'
digest = hashlib.sha1(branch.encode()).hexdigest()[:6]
slug = f'{base[:36].rstrip("-")}-{digest}' if len(base) > 36 else f'{base}-{digest}'
print(slug[:50].strip('-'))
PY
}

preview_hostname_for_slug() {
  printf 'preview-%s.%s\n' "$1" "${PREVIEW_HOST_SUFFIX}"
}

preview_stack_name_for_slug() {
  printf '%s-%s\n' "${PREVIEW_STACK_PREFIX}" "$1"
}

target_group_name_for_slug() {
  python3 - <<'PY' "$1"
import hashlib, sys
slug = sys.argv[1]
print(f'omcf-{hashlib.sha1(slug.encode()).hexdigest()[:12]}')
PY
}

stack_exists() {
  aws cloudformation describe-stacks \
    --region "${AWS_REGION}" \
    --stack-name "$1" \
    --query 'Stacks[0].StackStatus' \
    --output text >/dev/null 2>&1
}

active_preview_count() {
  aws cloudformation describe-stacks \
    --region "${AWS_REGION}" \
    --query "length(Stacks[?starts_with(StackName, '${PREVIEW_STACK_PREFIX}-') && StackStatus != 'DELETE_COMPLETE'])" \
    --output text
}

choose_rule_priority() {
  local host="$1"
  local rules_json
  rules_json="$(aws elbv2 describe-rules --region "${AWS_REGION}" --listener-arn "${EXISTING_LOAD_BALANCER_HTTPS_LISTENER_ARN}" --output json)"

  local existing
  existing="$(python3 - <<'PY' "$host" "$rules_json"
import json, sys
host = sys.argv[1]
data = json.loads(sys.argv[2])
for rule in data.get('Rules', []):
    for condition in rule.get('Conditions', []):
        values = (condition.get('HostHeaderConfig') or {}).get('Values') or []
        if condition.get('Field') == 'host-header' and host in values:
            print(rule.get('Priority', ''))
            raise SystemExit(0)
print('')
PY
)"
  if [[ -n "${existing}" && "${existing}" != "default" ]]; then
    echo "${existing}"
    return 0
  fi

  python3 - <<'PY' "${PREVIEW_RULE_PRIORITY_MIN}" "${PREVIEW_RULE_PRIORITY_MAX}" "$rules_json"
import json, sys
low = int(sys.argv[1])
high = int(sys.argv[2])
data = json.loads(sys.argv[3])
used = set()
for rule in data.get('Rules', []):
    priority = rule.get('Priority')
    if priority and priority != 'default':
        used.add(int(priority))
for candidate in range(low, high + 1):
    if candidate not in used:
        print(candidate)
        break
else:
    raise SystemExit('No free listener rule priority available')
PY
}

stack_resource_id() {
  aws cloudformation describe-stack-resource \
    --region "${AWS_REGION}" \
    --stack-name "${PROD_STACK_NAME}" \
    --logical-resource-id "$1" \
    --query 'StackResourceDetail.PhysicalResourceId' \
    --output text
}

stack_output() {
  aws cloudformation describe-stacks \
    --region "${AWS_REGION}" \
    --stack-name "${PROD_STACK_NAME}" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue | [0]" \
    --output text
}

role_arn() {
  aws iam get-role --role-name "$1" --query 'Role.Arn' --output text
}

ensure_preview_limit() {
  local stack_name="$1"
  if stack_exists "${stack_name}"; then
    return 0
  fi
  local count
  count="$(active_preview_count)"
  if (( count >= PREVIEW_LIMIT )); then
    echo "Active CloudFormation preview limit reached: ${count}/${PREVIEW_LIMIT}" >&2
    exit 1
  fi
}
