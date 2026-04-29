#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./preview-common.sh
source "${SCRIPT_DIR}/preview-common.sh"

BRANCH="${1:-${BRANCH:-${GITHUB_REF_NAME:-${GITHUB_EVENT_REF:-}}}}"
if [[ -z "${BRANCH}" ]]; then
  echo "Usage: $0 <contrib/branch-name>" >&2
  exit 1
fi
if [[ "${BRANCH}" == refs/heads/* ]]; then
  BRANCH="${BRANCH#refs/heads/}"
fi
if [[ "${BRANCH}" != contrib/* ]]; then
  echo "CloudFormation preview cleanup is only supported for contrib/* branches" >&2
  exit 1
fi

PREVIEW_SLUG="$(branch_to_preview_slug "${BRANCH}")"
PREVIEW_STACK_NAME="$(preview_stack_name_for_slug "${PREVIEW_SLUG}")"
PREVIEW_HOSTNAME="$(preview_hostname_for_slug "${PREVIEW_SLUG}")"

if stack_exists "${PREVIEW_STACK_NAME}"; then
  aws cloudformation delete-stack \
    --region "${AWS_REGION}" \
    --stack-name "${PREVIEW_STACK_NAME}"
  aws cloudformation wait stack-delete-complete \
    --region "${AWS_REGION}" \
    --stack-name "${PREVIEW_STACK_NAME}"
fi

echo "preview_branch=${BRANCH}"
echo "preview_slug=${PREVIEW_SLUG}"
echo "preview_stack=${PREVIEW_STACK_NAME}"
echo "preview_hostname=${PREVIEW_HOSTNAME}"
echo "preview_deleted=true"
