#!/usr/bin/env bash
set -euo pipefail

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing required command: $1" >&2
    exit 1
  }
}

require_cmd aws
require_cmd jq
require_cmd python3
require_cmd curl

export AWS_PAGER=""

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
USER_DATA_FILE="${SCRIPT_DIR}/user-data.sh"

AWS_REGION="${AWS_REGION:-eu-west-2}"
VPC_ID="${VPC_ID:-vpc-20252849}"
HOSTED_ZONE_ID="${HOSTED_ZONE_ID:-Z05995411RZM1GDPTHOZ6}"
BASELINE_HOSTNAME="${BASELINE_HOSTNAME:-om.they.dev}"
INSTANCE_NAME="${INSTANCE_NAME:-openmercato-upstream-baseline-dokploy}"
SECURITY_GROUP_NAME="${SECURITY_GROUP_NAME:-openmercato-upstream-baseline-dokploy-sg}"
TARGET_GROUP_NAME="${TARGET_GROUP_NAME:-openmercato-upstream-baseline-tg}"
IAM_ROLE_NAME="${IAM_ROLE_NAME:-openmercato-upstream-baseline-ssm-role}"
INSTANCE_PROFILE_NAME="${INSTANCE_PROFILE_NAME:-openmercato-upstream-baseline-ssm-role}"
INSTANCE_TYPE="${INSTANCE_TYPE:-t3.xlarge}"
ROOT_VOLUME_SIZE_GB="${ROOT_VOLUME_SIZE_GB:-50}"
APP_PORT="${APP_PORT:-3001}"
PREVIEW_PORT_MIN="${PREVIEW_PORT_MIN:-4100}"
PREVIEW_PORT_MAX="${PREVIEW_PORT_MAX:-4899}"
SSH_CIDR="${SSH_CIDR:-}"
DOKPLOY_ADMIN_CIDRS="${DOKPLOY_ADMIN_CIDRS:-}"
ALB_ARN="${ALB_ARN:-arn:aws:elasticloadbalancing:eu-west-2:062648047691:loadbalancer/app/they-lb/fe10e6ccedf3d536}"
ALB_SG_ID="${ALB_SG_ID:-sg-0855bb417b5a17266}"
LISTENER_RULE_PRIORITY="${LISTENER_RULE_PRIORITY:-}"
AMI_PARAMETER="${AMI_PARAMETER:-/aws/service/canonical/ubuntu/server/22.04/stable/current/amd64/hvm/ebs-gp2/ami-id}"

json_escape() {
  python3 - <<'PY' "$1"
import json, sys
print(json.dumps(sys.argv[1]))
PY
}

if [[ -z "${DOKPLOY_ADMIN_CIDRS}" ]]; then
  CALLER_IP="$(curl -fsSL https://checkip.amazonaws.com | tr -d '\n')"
  DOKPLOY_ADMIN_CIDRS="${CALLER_IP}/32"
fi

DOKPLOY_ADMIN_CIDR_LIST=()
SSH_CIDR_LIST=()

if [[ -n "${DOKPLOY_ADMIN_CIDRS}" ]]; then
  IFS=',' read -r -a DOKPLOY_ADMIN_CIDR_LIST <<< "${DOKPLOY_ADMIN_CIDRS}"
fi

if [[ -n "${SSH_CIDR}" ]]; then
  IFS=',' read -r -a SSH_CIDR_LIST <<< "${SSH_CIDR}"
fi

AMI_ID="$(aws ssm get-parameter --region "${AWS_REGION}" --name "${AMI_PARAMETER}" --query 'Parameter.Value' --output text)"
SUBNET_ID="${SUBNET_ID:-$(aws ec2 describe-subnets --region "${AWS_REGION}" --filters Name=vpc-id,Values="${VPC_ID}" Name=map-public-ip-on-launch,Values=true --query 'Subnets | sort_by(@,&AvailabilityZone)[0].SubnetId' --output text)}"
LISTENER_ARN="${LISTENER_ARN:-$(aws elbv2 describe-listeners --region "${AWS_REGION}" --load-balancer-arn "${ALB_ARN}" --query 'Listeners[?Port==`443`].ListenerArn | [0]' --output text)}"
ALB_DNS_NAME="$(aws elbv2 describe-load-balancers --region "${AWS_REGION}" --load-balancer-arns "${ALB_ARN}" --query 'LoadBalancers[0].DNSName' --output text)"
ALB_ZONE_ID="$(aws elbv2 describe-load-balancers --region "${AWS_REGION}" --load-balancer-arns "${ALB_ARN}" --query 'LoadBalancers[0].CanonicalHostedZoneId' --output text)"

ensure_role_and_profile() {
  if ! aws iam get-role --role-name "${IAM_ROLE_NAME}" >/dev/null 2>&1; then
    cat > /tmp/openmercato-upstream-baseline-trust.json <<'JSON'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "Service": "ec2.amazonaws.com" },
      "Action": "sts:AssumeRole"
    }
  ]
}
JSON
    aws iam create-role --role-name "${IAM_ROLE_NAME}" --assume-role-policy-document file:///tmp/openmercato-upstream-baseline-trust.json >/dev/null
    aws iam attach-role-policy --role-name "${IAM_ROLE_NAME}" --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore >/dev/null
  fi

  if ! aws iam get-instance-profile --instance-profile-name "${INSTANCE_PROFILE_NAME}" >/dev/null 2>&1; then
    aws iam create-instance-profile --instance-profile-name "${INSTANCE_PROFILE_NAME}" >/dev/null
    sleep 5
  fi

  if ! aws iam get-instance-profile --instance-profile-name "${INSTANCE_PROFILE_NAME}" --query 'InstanceProfile.Roles[?RoleName==`'"${IAM_ROLE_NAME}"'`]' --output text | grep -q "${IAM_ROLE_NAME}"; then
    aws iam add-role-to-instance-profile --instance-profile-name "${INSTANCE_PROFILE_NAME}" --role-name "${IAM_ROLE_NAME}" >/dev/null || true
    sleep 10
  fi
}

ensure_security_group() {
  local sg_id
  sg_id="$(aws ec2 describe-security-groups --region "${AWS_REGION}" --filters Name=vpc-id,Values="${VPC_ID}" Name=group-name,Values="${SECURITY_GROUP_NAME}" --query 'SecurityGroups[0].GroupId' --output text 2>/dev/null || true)"

  if [[ -z "${sg_id}" || "${sg_id}" == "None" ]]; then
    sg_id="$(aws ec2 create-security-group --region "${AWS_REGION}" --group-name "${SECURITY_GROUP_NAME}" --description 'Open Mercato upstream baseline Dokploy host' --vpc-id "${VPC_ID}" --query 'GroupId' --output text)"
    aws ec2 create-tags --region "${AWS_REGION}" --resources "${sg_id}" --tags Key=Name,Value="${SECURITY_GROUP_NAME}" >/dev/null
  fi

  aws ec2 authorize-security-group-ingress --region "${AWS_REGION}" --group-id "${sg_id}" --ip-permissions '[{"IpProtocol":"tcp","FromPort":80,"ToPort":80,"IpRanges":[{"CidrIp":"0.0.0.0/0","Description":"HTTP ingress"}]},{"IpProtocol":"tcp","FromPort":443,"ToPort":443,"IpRanges":[{"CidrIp":"0.0.0.0/0","Description":"HTTPS ingress"}]}]' >/dev/null 2>&1 || true

  if (( ${#DOKPLOY_ADMIN_CIDR_LIST[@]} )); then
    for cidr in "${DOKPLOY_ADMIN_CIDR_LIST[@]}"; do
      [[ -z "${cidr}" ]] && continue
      aws ec2 authorize-security-group-ingress --region "${AWS_REGION}" --group-id "${sg_id}" --ip-permissions "[{\"IpProtocol\":\"tcp\",\"FromPort\":3000,\"ToPort\":3000,\"IpRanges\":[{\"CidrIp\":$(json_escape "${cidr}"),\"Description\":\"Dokploy admin\"}]}]" >/dev/null 2>&1 || true
    done
  fi

  if (( ${#SSH_CIDR_LIST[@]} )); then
    for cidr in "${SSH_CIDR_LIST[@]}"; do
      [[ -z "${cidr}" ]] && continue
      aws ec2 authorize-security-group-ingress --region "${AWS_REGION}" --group-id "${sg_id}" --ip-permissions "[{\"IpProtocol\":\"tcp\",\"FromPort\":22,\"ToPort\":22,\"IpRanges\":[{\"CidrIp\":$(json_escape "${cidr}"),\"Description\":\"SSH access\"}]}]" >/dev/null 2>&1 || true
    done
  fi

  aws ec2 authorize-security-group-ingress --region "${AWS_REGION}" --group-id "${sg_id}" --ip-permissions "[{\"IpProtocol\":\"tcp\",\"FromPort\":${APP_PORT},\"ToPort\":${APP_PORT},\"UserIdGroupPairs\":[{\"GroupId\":$(json_escape "${ALB_SG_ID}")}]}]" >/dev/null 2>&1 || true
  aws ec2 authorize-security-group-ingress --region "${AWS_REGION}" --group-id "${sg_id}" --ip-permissions "[{\"IpProtocol\":\"tcp\",\"FromPort\":${PREVIEW_PORT_MIN},\"ToPort\":${PREVIEW_PORT_MAX},\"UserIdGroupPairs\":[{\"GroupId\":$(json_escape "${ALB_SG_ID}")}]}]" >/dev/null 2>&1 || true

  echo "${sg_id}"
}

ensure_instance() {
  local sg_id="$1"
  local instance_id
  local instance_state
  instance_id="$(aws ec2 describe-instances --region "${AWS_REGION}" --filters Name=tag:Name,Values="${INSTANCE_NAME}" Name=instance-state-name,Values=pending,running,stopping,stopped --query 'Reservations[0].Instances[0].InstanceId' --output text 2>/dev/null || true)"
  instance_state="$(aws ec2 describe-instances --region "${AWS_REGION}" --filters Name=tag:Name,Values="${INSTANCE_NAME}" Name=instance-state-name,Values=pending,running,stopping,stopped --query 'Reservations[0].Instances[0].State.Name' --output text 2>/dev/null || true)"

  if [[ -z "${instance_id}" || "${instance_id}" == "None" ]]; then
    instance_id="$(aws ec2 run-instances \
      --region "${AWS_REGION}" \
      --image-id "${AMI_ID}" \
      --instance-type "${INSTANCE_TYPE}" \
      --block-device-mappings "[{\"DeviceName\":\"/dev/sda1\",\"Ebs\":{\"VolumeSize\":${ROOT_VOLUME_SIZE_GB},\"VolumeType\":\"gp3\",\"DeleteOnTermination\":true}}]" \
      --iam-instance-profile Name="${INSTANCE_PROFILE_NAME}" \
      --security-group-ids "${sg_id}" \
      --subnet-id "${SUBNET_ID}" \
      --associate-public-ip-address \
      --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=${INSTANCE_NAME}},{Key=Project,Value=openmercato},{Key=Environment,Value=upstream-baseline}]" \
      --user-data "file://${USER_DATA_FILE}" \
      --query 'Instances[0].InstanceId' \
      --output text)"
  elif [[ "${instance_state}" == "stopped" ]]; then
    aws ec2 start-instances --region "${AWS_REGION}" --instance-ids "${instance_id}" >/dev/null
  fi

  aws ec2 wait instance-running --region "${AWS_REGION}" --instance-ids "${instance_id}"
  echo "${instance_id}"
}

ensure_target_group() {
  local tg_arn
  tg_arn="$(aws elbv2 describe-target-groups --region "${AWS_REGION}" --names "${TARGET_GROUP_NAME}" --query 'TargetGroups[0].TargetGroupArn' --output text 2>/dev/null || true)"

  if [[ -z "${tg_arn}" || "${tg_arn}" == "None" ]]; then
    tg_arn="$(aws elbv2 create-target-group \
      --region "${AWS_REGION}" \
      --name "${TARGET_GROUP_NAME}" \
      --protocol HTTP \
      --port "${APP_PORT}" \
      --vpc-id "${VPC_ID}" \
      --target-type instance \
      --health-check-protocol HTTP \
      --health-check-port "${APP_PORT}" \
      --health-check-path /login \
      --health-check-interval-seconds 15 \
      --health-check-timeout-seconds 10 \
      --healthy-threshold-count 2 \
      --unhealthy-threshold-count 2 \
      --matcher HttpCode=200-399 \
      --query 'TargetGroups[0].TargetGroupArn' \
      --output text)"
  fi

  echo "${tg_arn}"
}

register_target() {
  local tg_arn="$1"
  local instance_id="$2"
  aws elbv2 register-targets --region "${AWS_REGION}" --target-group-arn "${tg_arn}" --targets "Id=${instance_id},Port=${APP_PORT}" >/dev/null
}

ensure_listener_rule() {
  local tg_arn="$1"
  local existing_rule_arn
  local rules_json
  rules_json="$(aws elbv2 describe-rules --region "${AWS_REGION}" --listener-arn "${LISTENER_ARN}" --output json)"
  existing_rule_arn="$(jq -r --arg host "${BASELINE_HOSTNAME}" '
    .Rules[]
    | select(any(.Conditions[]?; .Field == "host-header" and ((.HostHeaderConfig.Values // []) | index($host))))
    | .RuleArn
  ' <<<"${rules_json}" | head -n1)"

  if [[ -n "${existing_rule_arn}" && "${existing_rule_arn}" != "null" ]]; then
    echo "${existing_rule_arn}"
    return 0
  fi

  local priority="${LISTENER_RULE_PRIORITY}"
  if [[ -z "${priority}" ]]; then
    priority="$(jq -r '[.Rules[].Priority | select(. != "default") | tonumber] | (max // 9) + 1' <<<"${rules_json}")"
    if [[ -z "${priority}" || "${priority}" == "null" ]]; then
      priority=10
    fi
  fi

  aws elbv2 create-rule \
    --region "${AWS_REGION}" \
    --listener-arn "${LISTENER_ARN}" \
    --priority "${priority}" \
    --conditions "[{\"Field\":\"host-header\",\"HostHeaderConfig\":{\"Values\":[\"${BASELINE_HOSTNAME}\"]}}]" \
    --actions "[{\"Type\":\"forward\",\"TargetGroupArn\":\"${tg_arn}\"}]" \
    --query 'Rules[0].RuleArn' \
    --output text
}

upsert_route53_alias() {
  cat > /tmp/openmercato-upstream-baseline-route53.json <<JSON
{
  "Comment": "UPSERT upstream baseline ALB alias",
  "Changes": [
    {
      "Action": "UPSERT",
      "ResourceRecordSet": {
        "Name": "${BASELINE_HOSTNAME}",
        "Type": "A",
        "AliasTarget": {
          "HostedZoneId": "${ALB_ZONE_ID}",
          "DNSName": "${ALB_DNS_NAME}",
          "EvaluateTargetHealth": true
        }
      }
    }
  ]
}
JSON
  aws route53 change-resource-record-sets --hosted-zone-id "${HOSTED_ZONE_ID}" --change-batch file:///tmp/openmercato-upstream-baseline-route53.json >/dev/null
}

ensure_role_and_profile
SECURITY_GROUP_ID="$(ensure_security_group)"
INSTANCE_ID="$(ensure_instance "${SECURITY_GROUP_ID}")"
TARGET_GROUP_ARN="$(ensure_target_group)"
register_target "${TARGET_GROUP_ARN}" "${INSTANCE_ID}"
LISTENER_RULE_ARN="$(ensure_listener_rule "${TARGET_GROUP_ARN}")"
upsert_route53_alias

INSTANCE_JSON="$(aws ec2 describe-instances --region "${AWS_REGION}" --instance-ids "${INSTANCE_ID}" --query 'Reservations[0].Instances[0].{PublicIp:PublicIpAddress,PrivateIp:PrivateIpAddress,SubnetId:SubnetId,State:State.Name}' --output json)"
PUBLIC_IP="$(jq -r '.PublicIp' <<<"${INSTANCE_JSON}")"
PRIVATE_IP="$(jq -r '.PrivateIp' <<<"${INSTANCE_JSON}")"
STATE="$(jq -r '.State' <<<"${INSTANCE_JSON}")"

cat <<OUT
Provisioning complete.

Hostname:        ${BASELINE_HOSTNAME}
EC2 instance:    ${INSTANCE_ID}
State:           ${STATE}
Public IP:       ${PUBLIC_IP}
Private IP:      ${PRIVATE_IP}
Security group:  ${SECURITY_GROUP_ID}
Target group:    ${TARGET_GROUP_ARN}
Listener rule:   ${LISTENER_RULE_ARN}
Dokploy UI:      http://${PUBLIC_IP}:3000
Root volume GB:  ${ROOT_VOLUME_SIZE_GB}
App target port: ${APP_PORT}

Next steps:
1. Wait ~2-5 minutes for Dokploy installation to finish.
2. Complete the Dokploy first-login flow at the UI URL above.
3. Create a Docker Compose app from docker-compose.fullapp.yml and set APP_PORT=${APP_PORT}, APP_URL=https://${BASELINE_HOSTNAME}.
4. After the app is deployed, run ./infra/aws-upstream-baseline/check-health.sh and then ./infra/aws-upstream-baseline/smoke.sh.
OUT
