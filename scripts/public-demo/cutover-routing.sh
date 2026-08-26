#!/usr/bin/env bash
set -euo pipefail

umask 077
export AWS_PAGER=""
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ssm_runner="${PUBLIC_DEMO_SSM_RUNNER:-${script_dir}/ssm-run-step.sh}"
host_verifier="${script_dir}/verify-staged-candidate.sh"

usage() {
  echo "Usage: $0 preflight|cutover|readback|rollback" >&2
  exit 2
}

require_env() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    echo "${name} is required." >&2
    exit 1
  fi
}

[[ "$#" -eq 1 ]] || usage
mode="$1"
case "${mode}" in
  preflight|cutover|readback|rollback) ;;
  *) usage ;;
esac

for command_name in aws curl jq python3; do
  command -v "${command_name}" >/dev/null 2>&1 || {
    echo "${command_name} is required." >&2
    exit 1
  }
done
for required_name in AWS_REGION INSTANCE_ID VPC_ID LOAD_BALANCER_ARN LISTENER_ARN LISTENER_SSL_POLICY LOAD_BALANCER_SECURITY_GROUP_ID; do
  require_env "${required_name}"
done
if [[ "${mode}" == cutover || "${mode}" == readback ]]; then
  for required_name in EXPECTED_DEPLOYMENT_SHA EXPECTED_IMAGE_URI EXPECTED_IMAGE_DIGEST; do
    require_env "${required_name}"
  done
  [[ "${EXPECTED_DEPLOYMENT_SHA}" =~ ^[0-9a-f]{40}$ ]] || {
    echo "EXPECTED_DEPLOYMENT_SHA must be one lowercase full commit SHA." >&2
    exit 1
  }
  [[ "${EXPECTED_IMAGE_DIGEST}" =~ ^sha256:[0-9a-f]{64}$ ]] || {
    echo "EXPECTED_IMAGE_DIGEST must be one SHA-256 image digest." >&2
    exit 1
  }
  [[ "${EXPECTED_IMAGE_URI}" == *@"${EXPECTED_IMAGE_DIGEST}" ]] || {
    echo "EXPECTED_IMAGE_URI is not bound to EXPECTED_IMAGE_DIGEST." >&2
    exit 1
  }
fi

app_target_group_name="om-demo-public-demo"
mcp_target_group_name="om-demo-public-demo-mcp"
app_port=4787
mcp_port=4788
credential_broker_port=4900
app_priority=1008
mcp_priority=1007
app_validation_priority=49008
mcp_validation_priority=49007
validation_source_cidr="127.0.0.1/32"
public_host="public-demo.om.they.dev"
app_health_path="/login"
mcp_health_path="/health"
app_matcher="200-399"
mcp_matcher="200"

temporary_directory="$(mktemp -d)"
aws_error_file="${temporary_directory}/aws-error"
registered_app=0
registered_mcp=0
app_rule_create_attempted=0
mcp_rule_create_attempted=0
app_validation_rule_create_attempted=0
mcp_validation_rule_create_attempted=0
completed=0

confirm_rule_absent() {
  local rule_arn="$1"
  local attempt
  for attempt in 1 2 3 4 5; do
    if aws elbv2 describe-rules \
      --region "${AWS_REGION}" \
      --rule-arns "${rule_arn}" \
      --output json >/dev/null 2>"${aws_error_file}"; then
      sleep 2
      continue
    fi
    if grep -q 'RuleNotFound' "${aws_error_file}"; then
      return 0
    fi
    cat "${aws_error_file}" >&2
    return 1
  done
  return 1
}

confirm_target_absent() {
  local target_group_arn="$1"
  local port="$2"
  local attempt health_json
  for attempt in 1 2 3 4 5 6 7 8 9 10 11 12; do
    if ! health_json="$(aws elbv2 describe-target-health \
      --region "${AWS_REGION}" \
      --target-group-arn "${target_group_arn}" \
      --output json 2>"${aws_error_file}")"; then
      cat "${aws_error_file}" >&2
      return 1
    fi
    if jq -e \
      --arg instance "${INSTANCE_ID}" \
      --argjson port "${port}" \
      'all(.TargetHealthDescriptions[]; .Target.Id != $instance or .Target.Port != $port)' \
      <<<"${health_json}" >/dev/null; then
      return 0
    fi
    sleep 5
  done
  return 1
}

confirm_rule_priority_absent() {
  local priority="$1"
  local attempt current_rules
  for attempt in 1 2 3 4 5; do
    if ! current_rules="$(aws elbv2 describe-rules \
      --region "${AWS_REGION}" \
      --listener-arn "${LISTENER_ARN}" \
      --output json 2>"${aws_error_file}")"; then
      cat "${aws_error_file}" >&2
      return 1
    fi
    if jq -e --arg priority "${priority}" \
      'all(.Rules[]; .Priority != $priority)' <<<"${current_rules}" >/dev/null; then
      return 0
    fi
    sleep 2
  done
  return 1
}

rollback_attempted_rule() {
  local priority="$1"
  local target_group_arn="$2"
  local include_mcp_path="$3"
  local attempted="$4"
  local attempt rule_arn
  [[ "${attempted}" -eq 1 ]] || return 0
  for attempt in 1 2 3 4 5; do
    if ! rules_json="$(aws elbv2 describe-rules \
      --region "${AWS_REGION}" \
      --listener-arn "${LISTENER_ARN}" \
      --output json 2>"${aws_error_file}")"; then
      cat "${aws_error_file}" >&2
      return 1
    fi
    if [[ "$(jq --arg priority "${priority}" '[.Rules[] | select(.Priority == $priority)] | length' <<<"${rules_json}")" -eq 0 ]]; then
      [[ "${attempt}" -eq 5 ]] && return 0
      sleep 2
      continue
    fi
    if ! validate_rule "${priority}" "${target_group_arn}" "${include_mcp_path}"; then
      echo "Rollback preserved listener priority ${priority} because its accepted state drifted from the attempted rule." >&2
      return 1
    fi
    rule_arn="$(jq -r --arg priority "${priority}" '.Rules[] | select(.Priority == $priority) | .RuleArn' <<<"${rules_json}")"
    aws elbv2 delete-rule --region "${AWS_REGION}" --rule-arn "${rule_arn}" >/dev/null 2>&1 || true
    confirm_rule_priority_absent "${priority}"
    return
  done
}

validate_validation_rule() {
  local priority="$1"
  local target_group_arn="$2"
  local matching_rules
  matching_rules="$(rule_json_at_priority "${priority}")"
  jq -e \
    --arg target "${target_group_arn}" \
    --arg source "${validation_source_cidr}" \
    'length == 1 and
      (.[0].Actions | length == 1) and
      .[0].Actions[0].Type == "forward" and
      .[0].Actions[0].TargetGroupArn == $target and
      (.[0].Conditions | length == 1) and
      .[0].Conditions[0].Field == "source-ip" and
      ((.[0].Conditions[0].Values // .[0].Conditions[0].SourceIpConfig.Values // []) == [$source])' \
    <<<"${matching_rules}" >/dev/null
}

rollback_attempted_validation_rule() {
  local priority="$1"
  local target_group_arn="$2"
  local attempted="$3"
  local attempt rule_arn
  [[ "${attempted}" -eq 1 ]] || return 0
  for attempt in 1 2 3 4 5; do
    if ! rules_json="$(aws elbv2 describe-rules \
      --region "${AWS_REGION}" \
      --listener-arn "${LISTENER_ARN}" \
      --output json 2>"${aws_error_file}")"; then
      cat "${aws_error_file}" >&2
      return 1
    fi
    if [[ "$(jq --arg priority "${priority}" '[.Rules[] | select(.Priority == $priority)] | length' <<<"${rules_json}")" -eq 0 ]]; then
      [[ "${attempt}" -eq 5 ]] && return 0
      sleep 2
      continue
    fi
    if ! validate_validation_rule "${priority}" "${target_group_arn}"; then
      echo "Rollback preserved validation priority ${priority} because its accepted state drifted from the attempted rule." >&2
      return 1
    fi
    rule_arn="$(jq -r --arg priority "${priority}" '.Rules[] | select(.Priority == $priority) | .RuleArn' <<<"${rules_json}")"
    aws elbv2 delete-rule --region "${AWS_REGION}" --rule-arn "${rule_arn}" >/dev/null 2>&1 || true
    confirm_rule_priority_absent "${priority}"
    return
  done
}

cleanup() {
  local original_status=$?
  local rollback_failed=0
  trap - EXIT HUP INT TERM

  if [[ "${mode}" == "cutover" && "${completed}" -ne 1 ]]; then
    rollback_attempted_rule \
      "${app_priority}" "${app_target_group_arn:-}" false "${app_rule_create_attempted}" || rollback_failed=1
    rollback_attempted_rule \
      "${mcp_priority}" "${mcp_target_group_arn:-}" true "${mcp_rule_create_attempted}" || rollback_failed=1
    rollback_attempted_validation_rule \
      "${app_validation_priority}" "${app_target_group_arn:-}" "${app_validation_rule_create_attempted}" || rollback_failed=1
    rollback_attempted_validation_rule \
      "${mcp_validation_priority}" "${mcp_target_group_arn:-}" "${mcp_validation_rule_create_attempted}" || rollback_failed=1
    if [[ "${registered_mcp}" -eq 1 && -n "${mcp_target_group_arn:-}" ]]; then
      aws elbv2 deregister-targets --region "${AWS_REGION}" --target-group-arn "${mcp_target_group_arn}" --targets "Id=${INSTANCE_ID},Port=${mcp_port}" >/dev/null 2>&1 || true
      confirm_target_absent "${mcp_target_group_arn}" "${mcp_port}" || rollback_failed=1
    fi
    if [[ "${registered_app}" -eq 1 && -n "${app_target_group_arn:-}" ]]; then
      aws elbv2 deregister-targets --region "${AWS_REGION}" --target-group-arn "${app_target_group_arn}" --targets "Id=${INSTANCE_ID},Port=${app_port}" >/dev/null 2>&1 || true
      confirm_target_absent "${app_target_group_arn}" "${app_port}" || rollback_failed=1
    fi
  fi
  rm -f "${temporary_directory}"/*
  rmdir "${temporary_directory}" 2>/dev/null || true
  if [[ "${rollback_failed}" -ne 0 ]]; then
    echo "Routing rollback could not be confirmed; the candidate may still be reachable." >&2
    exit 1
  fi
  exit "${original_status}"
}
trap cleanup EXIT
trap 'exit 130' HUP INT TERM

describe_target_group() {
  local target_group_name="$1"
  local output_file="$2"
  if aws elbv2 describe-target-groups \
    --region "${AWS_REGION}" \
    --names "${target_group_name}" \
    --output json >"${output_file}" 2>"${aws_error_file}"; then
    return 0
  fi
  if grep -q 'TargetGroupNotFound' "${aws_error_file}"; then
    printf '%s\n' '{"TargetGroups":[]}' >"${output_file}"
    return 0
  fi
  cat "${aws_error_file}" >&2
  return 1
}

validate_target_group() {
  local document="$1"
  local name="$2"
  local port="$3"
  local health_path="$4"
  local matcher="$5"
  jq -e \
    --arg name "${name}" \
    --arg vpc "${VPC_ID}" \
    --argjson port "${port}" \
    --arg path "${health_path}" \
    --arg matcher "${matcher}" \
    '.TargetGroups | length == 1 and
      .[0].TargetGroupName == $name and
      .[0].VpcId == $vpc and
      .[0].Protocol == "HTTP" and
      .[0].Port == $port and
      .[0].TargetType == "instance" and
      .[0].HealthCheckProtocol == "HTTP" and
      .[0].HealthCheckPath == $path and
      .[0].Matcher.HttpCode == $matcher' <<<"${document}" >/dev/null
}

target_group_arn() {
  jq -r '.TargetGroups[0].TargetGroupArn // empty' <<<"$1"
}

validate_registered_targets() {
  local target_group_arn="$1"
  local port="$2"
  local require_healthy="$3"
  local health_json
  health_json="$(aws elbv2 describe-target-health \
    --region "${AWS_REGION}" \
    --target-group-arn "${target_group_arn}" \
    --output json)"
  if ! jq -e \
    --arg instance "${INSTANCE_ID}" \
    --argjson port "${port}" \
    'all(.TargetHealthDescriptions[]; .Target.Id == $instance and .Target.Port == $port)' \
    <<<"${health_json}" >/dev/null; then
    echo "Target registration collision or drift for ${target_group_arn}." >&2
    return 2
  fi
  if ! jq -e '.TargetHealthDescriptions | length > 0' <<<"${health_json}" >/dev/null; then
    return 1
  fi
  if [[ "${require_healthy}" == true ]] && ! jq -e \
    '.TargetHealthDescriptions | length == 1 and .[0].TargetHealth.State == "healthy"' \
    <<<"${health_json}" >/dev/null; then
    echo "The exact target is not healthy for ${target_group_arn}." >&2
    return 2
  fi
  return 0
}

load_state() {
  local require_running="$1"
  local instance_json listener_json load_balancer_json certificate_arn certificate_file app_target_group_file mcp_target_group_file
  local certificate_files=()
  instance_json="$(aws ec2 describe-instances \
    --region "${AWS_REGION}" \
    --instance-ids "${INSTANCE_ID}" \
    --output json)"
  jq -e \
    --arg instance "${INSTANCE_ID}" \
    --arg vpc "${VPC_ID}" \
    --argjson require_running "${require_running}" \
    '(.Reservations | length == 1) and
      (.Reservations[0].Instances | length == 1) and
      .Reservations[0].Instances[0].InstanceId == $instance and
      .Reservations[0].Instances[0].VpcId == $vpc and
      ($require_running == false or .Reservations[0].Instances[0].State.Name == "running")' \
    <<<"${instance_json}" >/dev/null || {
      echo "INSTANCE_ID does not resolve to the required VPC and state." >&2
      return 1
    }

  instance_security_group_ids="$(jq -r '.Reservations[0].Instances[0].SecurityGroups[].GroupId' <<<"${instance_json}")"
  [[ -n "${instance_security_group_ids}" ]] || {
    echo "The target instance has no security groups." >&2
    return 1
  }

  listener_json="$(aws elbv2 describe-listeners \
    --region "${AWS_REGION}" \
    --listener-arns "${LISTENER_ARN}" \
    --output json)"
  jq -e \
    --arg listener "${LISTENER_ARN}" \
    --arg load_balancer "${LOAD_BALANCER_ARN}" \
    --arg ssl_policy "${LISTENER_SSL_POLICY}" \
    '.Listeners | length == 1 and
      .[0].ListenerArn == $listener and
      .[0].LoadBalancerArn == $load_balancer and
      .[0].Protocol == "HTTPS" and
      .[0].Port == 443 and
      (.[0].Certificates | length > 0) and
      .[0].SslPolicy == $ssl_policy' \
    <<<"${listener_json}" >/dev/null || {
      echo "LISTENER_ARN is not the exact HTTPS/443 listener on LOAD_BALANCER_ARN." >&2
      return 1
    }

  listener_certificates_json="$(aws elbv2 describe-listener-certificates \
    --region "${AWS_REGION}" \
    --listener-arn "${LISTENER_ARN}" \
    --output json)"
  while IFS= read -r certificate_arn; do
    certificate_file="${temporary_directory}/certificate-$(( ${#certificate_files[@]} + 1 )).json"
    aws acm describe-certificate \
      --region "${AWS_REGION}" \
      --certificate-arn "${certificate_arn}" \
      --output json >"${certificate_file}"
    certificate_files+=("${certificate_file}")
  done < <(jq -r '.Certificates[].CertificateArn' <<<"${listener_certificates_json}" | sort -u)
  [[ "${#certificate_files[@]}" -gt 0 ]] || {
    echo "The HTTPS listener has no attached certificates." >&2
    return 1
  }
  python3 - "${public_host}" "${certificate_files[@]}" <<'PY' || {
import json
import sys
from pathlib import Path

host = sys.argv[1].lower()
names = set()
for certificate_path in sys.argv[2:]:
    certificate = json.loads(Path(certificate_path).read_text(encoding="utf-8")).get("Certificate", {})
    for name in [certificate.get("DomainName"), *(certificate.get("SubjectAlternativeNames") or [])]:
        if isinstance(name, str):
            names.add(name.lower().rstrip("."))

def covers(name: str) -> bool:
    if name == host:
        return True
    if not name.startswith("*."):
        return False
    return host.split(".")[1:] == name[2:].split(".")

raise SystemExit(0 if any(covers(name) for name in names) else 1)
PY
    echo "No listener certificate covers ${public_host}." >&2
    return 1
  }

  load_balancer_json="$(aws elbv2 describe-load-balancers \
    --region "${AWS_REGION}" \
    --load-balancer-arns "${LOAD_BALANCER_ARN}" \
    --output json)"
  jq -e \
    --arg load_balancer "${LOAD_BALANCER_ARN}" \
    --arg vpc "${VPC_ID}" \
    --arg security_group "${LOAD_BALANCER_SECURITY_GROUP_ID}" \
    '.LoadBalancers | length == 1 and
      .[0].LoadBalancerArn == $load_balancer and
      .[0].VpcId == $vpc and
      .[0].Type == "application" and
      .[0].Scheme == "internet-facing" and
      .[0].State.Code == "active" and
      any(.[0].SecurityGroups[]; . == $security_group)' \
    <<<"${load_balancer_json}" >/dev/null || {
      echo "LOAD_BALANCER_ARN does not match the active internet-facing ALB contract." >&2
      return 1
    }

  app_target_group_file="${temporary_directory}/app-target-group.json"
  mcp_target_group_file="${temporary_directory}/mcp-target-group.json"
  describe_target_group "${app_target_group_name}" "${app_target_group_file}"
  describe_target_group "${mcp_target_group_name}" "${mcp_target_group_file}"
  app_target_group_json="$(<"${app_target_group_file}")"
  mcp_target_group_json="$(<"${mcp_target_group_file}")"
  app_target_group_arn="$(target_group_arn "${app_target_group_json}")"
  mcp_target_group_arn="$(target_group_arn "${mcp_target_group_json}")"

  if [[ -n "${app_target_group_arn}" ]]; then
    validate_target_group "${app_target_group_json}" "${app_target_group_name}" "${app_port}" "${app_health_path}" "${app_matcher}" || {
      echo "Target group ${app_target_group_name} exists with drift." >&2
      return 1
    }
    if validate_registered_targets "${app_target_group_arn}" "${app_port}" false >/dev/null; then
      :
    else
      registration_state=$?
      [[ "${registration_state}" -eq 1 ]] || return "${registration_state}"
    fi
  fi
  if [[ -n "${mcp_target_group_arn}" ]]; then
    validate_target_group "${mcp_target_group_json}" "${mcp_target_group_name}" "${mcp_port}" "${mcp_health_path}" "${mcp_matcher}" || {
      echo "Target group ${mcp_target_group_name} exists with drift." >&2
      return 1
    }
    if validate_registered_targets "${mcp_target_group_arn}" "${mcp_port}" false >/dev/null; then
      :
    else
      registration_state=$?
      [[ "${registration_state}" -eq 1 ]] || return "${registration_state}"
    fi
  fi

  rules_json="$(aws elbv2 describe-rules \
    --region "${AWS_REGION}" \
    --listener-arn "${LISTENER_ARN}" \
    --output json)"
}

validate_instance_ingress() {
  local security_group_id rules_json rules_file combined_rules_json
  local rules_files=()
  while IFS= read -r security_group_id; do
    rules_json="$(aws ec2 describe-security-group-rules \
      --region "${AWS_REGION}" \
      --filters "Name=group-id,Values=${security_group_id}" \
      --output json)"
    jq -e \
      --argjson broker_port "${credential_broker_port}" \
      'all(.SecurityGroupRules[];
        if (.IsEgress == false and
            (.IpProtocol == "-1" or .IpProtocol == "tcp") and
            ((.IpProtocol == "-1") or
             ((.FromPort // -1) <= $broker_port and (.ToPort // -1) >= $broker_port)))
        then false
        else true
        end)' <<<"${rules_json}" >/dev/null || {
      echo "Instance security group ${security_group_id} exposes credential broker port ${credential_broker_port}." >&2
      return 1
    }
    jq -e \
      --arg source_group "${LOAD_BALANCER_SECURITY_GROUP_ID}" \
      'all(.SecurityGroupRules[];
        if (.IsEgress == false and
            (.IpProtocol == "-1" or .IpProtocol == "tcp") and
            ((.IpProtocol == "-1") or
             ((.FromPort // -1) <= 4788 and (.ToPort // -1) >= 4787)))
        then (.IpProtocol == "tcp" and
              .ReferencedGroupInfo.GroupId == $source_group and
              (.CidrIpv4 // "") == "" and
              (.CidrIpv6 // "") == "" and
              (.PrefixListId // "") == "")
        else true end)' <<<"${rules_json}" >/dev/null || {
      echo "Instance security group ${security_group_id} exposes or incompletely scopes ports 4787/4788." >&2
      return 1
    }
    rules_file="${temporary_directory}/security-group-${security_group_id}.json"
    printf '%s\n' "${rules_json}" >"${rules_file}"
    rules_files+=("${rules_file}")
  done <<<"${instance_security_group_ids}"

  combined_rules_json="$(jq -s '[.[].SecurityGroupRules[] | select(.IsEgress == false)]' "${rules_files[@]}")"
  for port in 4787 4788; do
    jq -e \
      --arg source_group "${LOAD_BALANCER_SECURITY_GROUP_ID}" \
      --argjson port "${port}" \
      'any(.[];
        .IpProtocol == "tcp" and
        (.FromPort // -1) <= $port and
        (.ToPort // -1) >= $port and
        .ReferencedGroupInfo.GroupId == $source_group)' \
      <<<"${combined_rules_json}" >/dev/null || {
      echo "No exact ALB security-group ingress reaches instance port ${port}." >&2
      return 1
    }
  done
}

rule_json_at_priority() {
  local priority="$1"
  jq -c --arg priority "${priority}" '[.Rules[] | select(.Priority == $priority)]' <<<"${rules_json}"
}

validate_rule() {
  local priority="$1"
  local target_group_arn="$2"
  local include_mcp_path="$3"
  local matching_rules
  matching_rules="$(rule_json_at_priority "${priority}")"
  [[ "$(jq 'length' <<<"${matching_rules}")" -eq 0 ]] && return 1
  jq -e \
    --arg host "${public_host}" \
    --arg target "${target_group_arn}" \
    --argjson mcp "${include_mcp_path}" \
    'length == 1 and
      (.[0].Actions | length == 1) and
      .[0].Actions[0].Type == "forward" and
      .[0].Actions[0].TargetGroupArn == $target and
      ([.[0].Conditions[] | select(.Field == "host-header" and .Values == [$host])] | length == 1) and
      (if $mcp then
        (.[0].Conditions | length == 2) and
        ([.[0].Conditions[] | select(.Field == "path-pattern" and .Values == ["/mcp*"])] | length == 1)
       else
        (.[0].Conditions | length == 1)
       end)' <<<"${matching_rules}" >/dev/null
}

validate_rule_collisions() {
  local app_rules mcp_rules app_validation_rules mcp_validation_rules
  app_rules="$(rule_json_at_priority "${app_priority}")"
  mcp_rules="$(rule_json_at_priority "${mcp_priority}")"
  app_validation_rules="$(rule_json_at_priority "${app_validation_priority}")"
  mcp_validation_rules="$(rule_json_at_priority "${mcp_validation_priority}")"
  if [[ "$(jq 'length' <<<"${app_validation_rules}")" -gt 0 || "$(jq 'length' <<<"${mcp_validation_rules}")" -gt 0 ]]; then
    echo "A public-demo validation listener priority is already occupied." >&2
    return 1
  fi
  if [[ "$(jq 'length' <<<"${app_rules}")" -gt 0 ]]; then
    [[ -n "${app_target_group_arn}" ]] && validate_rule "${app_priority}" "${app_target_group_arn}" false || {
      echo "Listener priority ${app_priority} is occupied by a non-exact rule." >&2
      return 1
    }
  fi
  if [[ "$(jq 'length' <<<"${mcp_rules}")" -gt 0 ]]; then
    [[ -n "${mcp_target_group_arn}" ]] && validate_rule "${mcp_priority}" "${mcp_target_group_arn}" true || {
      echo "Listener priority ${mcp_priority} is occupied by a non-exact rule." >&2
      return 1
    }
  fi

  rules_collision_file="${temporary_directory}/listener-rules.json"
  printf '%s\n' "${rules_json}" >"${rules_collision_file}"
  if ! python3 - "${public_host}" "${app_priority}" "${mcp_priority}" "${rules_collision_file}" <<'PY'
import fnmatch
import json
import re
import sys
from pathlib import Path

host, app_priority, mcp_priority, rules_path = sys.argv[1:]
document = json.loads(Path(rules_path).read_text(encoding="utf-8"))
for rule in document.get("Rules", []):
    if str(rule.get("Priority")) in {app_priority, mcp_priority}:
        continue
    for condition in rule.get("Conditions", []):
        if condition.get("Field") != "host-header":
            continue
        values = condition.get("Values") or condition.get("HostHeaderConfig", {}).get("Values") or []
        regex_values = condition.get("RegexValues") or condition.get("HostHeaderConfig", {}).get("RegexValues") or []
        if any(fnmatch.fnmatchcase(host.lower(), str(value).lower()) for value in values):
            raise SystemExit(1)
        for expression in regex_values:
            try:
                if re.fullmatch(str(expression), host, flags=re.IGNORECASE):
                    raise SystemExit(1)
            except re.error:
                raise SystemExit(1)
PY
  then
      echo "The public-demo hostname is already used by another listener rule." >&2
      return 1
  fi
}

create_target_group() {
  local name="$1"
  local port="$2"
  local health_path="$3"
  local matcher="$4"
  aws elbv2 create-target-group \
    --region "${AWS_REGION}" \
    --name "${name}" \
    --protocol HTTP \
    --port "${port}" \
    --vpc-id "${VPC_ID}" \
    --target-type instance \
    --health-check-enabled \
    --health-check-protocol HTTP \
    --health-check-port traffic-port \
    --health-check-path "${health_path}" \
    --matcher "HttpCode=${matcher}" \
    --query 'TargetGroups[0].TargetGroupArn' \
    --output text
}

register_target() {
  local target_group_arn="$1"
  local port="$2"
  local registered_flag_name="$3"
  if validate_registered_targets "${target_group_arn}" "${port}" false >/dev/null; then
    registration_state=0
  else
    registration_state=$?
  fi
  if [[ "${registration_state}" -eq 1 ]]; then
    printf -v "${registered_flag_name}" '%s' 1
    aws elbv2 register-targets \
      --region "${AWS_REGION}" \
      --target-group-arn "${target_group_arn}" \
      --targets "Id=${INSTANCE_ID},Port=${port}"
  elif [[ "${registration_state}" -ne 0 ]]; then
    return "${registration_state}"
  fi
}

wait_for_target() {
  local target_group_arn="$1"
  local port="$2"
  aws elbv2 wait target-in-service \
    --region "${AWS_REGION}" \
    --target-group-arn "${target_group_arn}" \
    --targets "Id=${INSTANCE_ID},Port=${port}"
}

create_forward_rule() {
  local priority="$1"
  local target_group_arn="$2"
  local include_mcp_path="$3"
  local attempted_flag_name="$4"
  local rule_arn
  printf -v "${attempted_flag_name}" '%s' 1
  if [[ "${include_mcp_path}" == true ]]; then
    rule_arn="$(aws elbv2 create-rule \
      --region "${AWS_REGION}" \
      --listener-arn "${LISTENER_ARN}" \
      --priority "${priority}" \
      --conditions "Field=host-header,Values=${public_host}" 'Field=path-pattern,Values=/mcp*' \
      --actions "Type=forward,TargetGroupArn=${target_group_arn}" \
      --query 'Rules[0].RuleArn' \
      --output text)"
  else
    rule_arn="$(aws elbv2 create-rule \
      --region "${AWS_REGION}" \
      --listener-arn "${LISTENER_ARN}" \
      --priority "${priority}" \
      --conditions "Field=host-header,Values=${public_host}" \
      --actions "Type=forward,TargetGroupArn=${target_group_arn}" \
      --query 'Rules[0].RuleArn' \
      --output text)"
  fi
  [[ -n "${rule_arn}" && "${rule_arn}" != "None" ]] || {
    echo "create-rule did not return a rule ARN." >&2
    return 1
  }
}

create_validation_rule() {
  local priority="$1"
  local target_group_arn="$2"
  local attempted_flag_name="$3"
  printf -v "${attempted_flag_name}" '%s' 1
  aws elbv2 create-rule \
    --region "${AWS_REGION}" \
    --listener-arn "${LISTENER_ARN}" \
    --priority "${priority}" \
    --conditions "Field=source-ip,Values=${validation_source_cidr}" \
    --actions "Type=forward,TargetGroupArn=${target_group_arn}" \
    --query 'Rules[0].RuleArn' \
    --output text >/dev/null
}

validate_public_https() {
  local login_status mcp_status
  login_status="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
    --connect-timeout 10 --max-time 30 --retry 6 --retry-delay 5 \
    "https://${public_host}/login")"
  [[ "${login_status}" =~ ^[23][0-9][0-9]$ ]] || {
    echo "External HTTPS login probe failed with status ${login_status:-none}." >&2
    return 1
  }
  mcp_status="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
    --connect-timeout 10 --max-time 30 --retry 6 --retry-delay 5 \
    "https://${public_host}/mcp")"
  [[ "${mcp_status}" == "401" ]] || {
    echo "External HTTPS MCP routing probe failed with status ${mcp_status:-none}." >&2
    return 1
  }
}

validate_host_candidate() {
  [[ -f "${ssm_runner}" && -f "${host_verifier}" ]] || {
    echo "Public-demo SSM runner or host verifier is missing." >&2
    return 1
  }
  {
    printf 'EXPECTED_DEPLOYMENT_SHA=%q\n' "${EXPECTED_DEPLOYMENT_SHA}"
    printf 'EXPECTED_IMAGE_URI=%q\n' "${EXPECTED_IMAGE_URI}"
    printf 'EXPECTED_IMAGE_DIGEST=%q\n' "${EXPECTED_IMAGE_DIGEST}"
    cat "${host_verifier}"
  } | AWS_REGION="${AWS_REGION}" \
    INSTANCE_ID="${INSTANCE_ID}" \
    SSM_STEP_NAME="Read back exact public-demo staged candidate" \
    SSM_TIMEOUT_SECONDS=240 \
    bash "${ssm_runner}"
}

case "${mode}" in
  preflight)
    load_state true
    validate_instance_ingress
    validate_rule_collisions
    echo "Routing preflight passed; exact resources are absent or match the public-demo contract."
    ;;
  cutover)
    validate_host_candidate
    load_state true
    validate_instance_ingress
    validate_rule_collisions
    if [[ -z "${app_target_group_arn}" ]]; then
      app_target_group_arn="$(create_target_group "${app_target_group_name}" "${app_port}" "${app_health_path}" "${app_matcher}")"
    fi
    if [[ -z "${mcp_target_group_arn}" ]]; then
      mcp_target_group_arn="$(create_target_group "${mcp_target_group_name}" "${mcp_port}" "${mcp_health_path}" "${mcp_matcher}")"
    fi
    register_target "${app_target_group_arn}" "${app_port}" registered_app
    register_target "${mcp_target_group_arn}" "${mcp_port}" registered_mcp

    rules_json="$(aws elbv2 describe-rules --region "${AWS_REGION}" --listener-arn "${LISTENER_ARN}" --output json)"
    validate_rule_collisions
    create_validation_rule "${app_validation_priority}" "${app_target_group_arn}" app_validation_rule_create_attempted
    create_validation_rule "${mcp_validation_priority}" "${mcp_target_group_arn}" mcp_validation_rule_create_attempted
    wait_for_target "${app_target_group_arn}" "${app_port}"
    wait_for_target "${mcp_target_group_arn}" "${mcp_port}"
    validate_rule "${mcp_priority}" "${mcp_target_group_arn}" true || \
      create_forward_rule "${mcp_priority}" "${mcp_target_group_arn}" true mcp_rule_create_attempted
    validate_rule "${app_priority}" "${app_target_group_arn}" false || \
      create_forward_rule "${app_priority}" "${app_target_group_arn}" false app_rule_create_attempted
    rollback_attempted_validation_rule "${app_validation_priority}" "${app_target_group_arn}" "${app_validation_rule_create_attempted}"
    app_validation_rule_create_attempted=0
    rollback_attempted_validation_rule "${mcp_validation_priority}" "${mcp_target_group_arn}" "${mcp_validation_rule_create_attempted}"
    mcp_validation_rule_create_attempted=0
    validate_public_https
    completed=1
    echo "Cutover created or reused only the exact public-demo target registrations and rules."
    ;;
  readback)
    validate_host_candidate
    load_state true
    validate_instance_ingress
    [[ -n "${app_target_group_arn}" && -n "${mcp_target_group_arn}" ]] || {
      echo "Both public-demo target groups must exist for readback." >&2
      exit 1
    }
    validate_rule_collisions
    validate_rule "${app_priority}" "${app_target_group_arn}" false
    validate_rule "${mcp_priority}" "${mcp_target_group_arn}" true
    validate_registered_targets "${app_target_group_arn}" "${app_port}" true >/dev/null
    validate_registered_targets "${mcp_target_group_arn}" "${mcp_port}" true >/dev/null
    validate_public_https
    echo "Readback confirmed exact healthy targets and exact host listener rules."
    ;;
  rollback)
    load_state false
    validate_rule_collisions
    if validate_rule "${mcp_priority}" "${mcp_target_group_arn}" true; then
      mcp_rule_arn="$(jq -r --arg priority "${mcp_priority}" '.Rules[] | select(.Priority == $priority) | .RuleArn' <<<"${rules_json}")"
      aws elbv2 delete-rule --region "${AWS_REGION}" --rule-arn "${mcp_rule_arn}"
      confirm_rule_absent "${mcp_rule_arn}"
    fi
    if validate_rule "${app_priority}" "${app_target_group_arn}" false; then
      app_rule_arn="$(jq -r --arg priority "${app_priority}" '.Rules[] | select(.Priority == $priority) | .RuleArn' <<<"${rules_json}")"
      aws elbv2 delete-rule --region "${AWS_REGION}" --rule-arn "${app_rule_arn}"
      confirm_rule_absent "${app_rule_arn}"
    fi
    if [[ -n "${app_target_group_arn}" ]]; then
      aws elbv2 deregister-targets --region "${AWS_REGION}" --target-group-arn "${app_target_group_arn}" --targets "Id=${INSTANCE_ID},Port=${app_port}"
      confirm_target_absent "${app_target_group_arn}" "${app_port}"
    fi
    if [[ -n "${mcp_target_group_arn}" ]]; then
      aws elbv2 deregister-targets --region "${AWS_REGION}" --target-group-arn "${mcp_target_group_arn}" --targets "Id=${INSTANCE_ID},Port=${mcp_port}"
      confirm_target_absent "${mcp_target_group_arn}" "${mcp_port}"
    fi
    completed=1
    echo "Rollback removed only exact public-demo rules and exact instance registrations."
    ;;
esac
