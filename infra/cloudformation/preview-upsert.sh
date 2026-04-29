#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./preview-common.sh
source "${SCRIPT_DIR}/preview-common.sh"

BRANCH="${1:-${BRANCH:-${GITHUB_REF_NAME:-}}}"
if [[ -z "${BRANCH}" ]]; then
  echo "Usage: $0 <contrib/branch-name>" >&2
  exit 1
fi
if [[ "${BRANCH}" == refs/heads/* ]]; then
  BRANCH="${BRANCH#refs/heads/}"
fi
if [[ "${BRANCH}" != contrib/* ]]; then
  echo "CloudFormation previews are only supported for contrib/* branches" >&2
  exit 1
fi
: "${APP_IMAGE:?Set APP_IMAGE to an existing ECR image URI}"

PREVIEW_SLUG="$(branch_to_preview_slug "${BRANCH}")"
PREVIEW_HOSTNAME="$(preview_hostname_for_slug "${PREVIEW_SLUG}")"
PREVIEW_URL="https://${PREVIEW_HOSTNAME}"
PREVIEW_STACK_NAME="$(preview_stack_name_for_slug "${PREVIEW_SLUG}")"
TARGET_GROUP_NAME="$(target_group_name_for_slug "${PREVIEW_SLUG}")"
RULE_PRIORITY="$(choose_rule_priority "${PREVIEW_HOSTNAME}")"
SKIP_INIT_OR_MIGRATE="true"
if [[ "${ALLOW_PROD_MIGRATIONS:-false}" == "true" ]]; then
  SKIP_INIT_OR_MIGRATE="false"
fi

ensure_preview_limit "${PREVIEW_STACK_NAME}"

CLUSTER_NAME="$(stack_resource_id EcsCluster)"
PUBLIC_SUBNET_1="$(stack_resource_id PublicSubnet1)"
PUBLIC_SUBNET_2="$(stack_resource_id PublicSubnet2)"
APP_SECURITY_GROUP_ID="$(stack_resource_id AppSecurityGroup)"
APP_STORAGE_EFS_ID="$(stack_resource_id AppStorageEfs)"
APP_STORAGE_EFS_AP_ID="$(stack_resource_id AppStorageEfsAccessPoint)"
DATABASE_URL_SECRET_ARN="$(stack_resource_id DatabaseUrlSecret)"
REDIS_URL_SECRET_ARN="$(stack_resource_id RedisUrlSecret)"
MEILI_API_KEY_SECRET_ARN="$(stack_resource_id MeilisearchApiKeySecret)"
LB_SYNC_FUNCTION_ARN="$(stack_output LoadBalancerSyncFunctionArn)"
if [[ -z "${LB_SYNC_FUNCTION_ARN}" || "${LB_SYNC_FUNCTION_ARN}" == "None" ]]; then
  LB_SYNC_FUNCTION_ARN="arn:aws:lambda:${AWS_REGION}:062648047691:function:openmercato-they-lb-sync"
fi
ECS_EXECUTION_ROLE_ARN="$(role_arn openmercato-ecs-execution)"
ECS_TASK_ROLE_ARN="$(role_arn openmercato-ecs-task)"

: "${JWT_SECRET_ARN:?Set JWT_SECRET_ARN}"
: "${ENCRYPTION_KEY_ARN:?Set ENCRYPTION_KEY_ARN}"

aws cloudformation deploy \
  --stack-name "${PREVIEW_STACK_NAME}" \
  --template-file "${PREVIEW_TEMPLATE}" \
  --capabilities CAPABILITY_NAMED_IAM \
  --region "${AWS_REGION}" \
  --s3-bucket "${CFN_S3_BUCKET}" \
  --s3-prefix "${CFN_S3_PREFIX}/${PREVIEW_SLUG}" \
  --no-fail-on-empty-changeset \
  --parameter-overrides \
    "PreviewSlug=${PREVIEW_SLUG}" \
    "PreviewHostName=${PREVIEW_HOSTNAME}" \
    "PreviewUrl=${PREVIEW_URL}" \
    "AppImage=${APP_IMAGE}" \
    "ClusterName=${CLUSTER_NAME}" \
    "PublicSubnet1=${PUBLIC_SUBNET_1}" \
    "PublicSubnet2=${PUBLIC_SUBNET_2}" \
    "AppSecurityGroupId=${APP_SECURITY_GROUP_ID}" \
    "ExistingLoadBalancerVpcId=${EXISTING_LOAD_BALANCER_VPC_ID}" \
    "ExistingLoadBalancerHttpsListenerArn=${EXISTING_LOAD_BALANCER_HTTPS_LISTENER_ARN}" \
    "ExistingLoadBalancerRulePriority=${RULE_PRIORITY}" \
    "TargetGroupName=${TARGET_GROUP_NAME}" \
    "LoadBalancerSyncFunctionArn=${LB_SYNC_FUNCTION_ARN}" \
    "EcsExecutionRoleArn=${ECS_EXECUTION_ROLE_ARN}" \
    "EcsTaskRoleArn=${ECS_TASK_ROLE_ARN}" \
    "AppStorageEfsId=${APP_STORAGE_EFS_ID}" \
    "AppStorageEfsAccessPointId=${APP_STORAGE_EFS_AP_ID}" \
    "DatabaseUrlSecretArn=${DATABASE_URL_SECRET_ARN}" \
    "RedisUrlSecretArn=${REDIS_URL_SECRET_ARN}" \
    "JwtSecretArn=${JWT_SECRET_ARN}" \
    "EncryptionKeyArn=${ENCRYPTION_KEY_ARN}" \
    "MeilisearchApiKeySecretArn=${MEILI_API_KEY_SECRET_ARN}" \
    "SkipInitOrMigrate=${SKIP_INIT_OR_MIGRATE}"

aws ecs wait services-stable \
  --region "${AWS_REGION}" \
  --cluster "${CLUSTER_NAME}" \
  --services "openmercato-preview-${PREVIEW_SLUG}-web" "openmercato-preview-${PREVIEW_SLUG}-worker"

echo "preview_branch=${BRANCH}"
echo "preview_slug=${PREVIEW_SLUG}"
echo "preview_stack=${PREVIEW_STACK_NAME}"
echo "preview_hostname=${PREVIEW_HOSTNAME}"
echo "preview_url=${PREVIEW_URL}"
echo "preview_target_group_name=${TARGET_GROUP_NAME}"
echo "preview_rule_priority=${RULE_PRIORITY}"
echo "preview_skip_init_or_migrate=${SKIP_INIT_OR_MIGRATE}"
