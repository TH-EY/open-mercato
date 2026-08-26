#!/usr/bin/env bash
set -euo pipefail

umask 077
export AWS_PAGER=""

require_env() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    echo "${name} is required." >&2
    exit 1
  fi
}

for command_name in aws python3; do
  command -v "${command_name}" >/dev/null 2>&1 || {
    echo "${command_name} is required." >&2
    exit 1
  }
done

for required_name in \
  AWS_PARTITION AWS_REGION AWS_ACCOUNT_ID OIDC_PROVIDER_ARN DEPLOY_ROLE_NAME \
  HOST_ROLE_NAME WORKLOAD_ROLE_NAME INSTANCE_ID ECR_REPOSITORY OPENROUTER_SECRET_ARN \
  SES_IDENTITY_ARN; do
  require_env "${required_name}"
done

[[ "${AWS_ACCOUNT_ID}" =~ ^[0-9]{12}$ ]] || { echo "AWS_ACCOUNT_ID must be 12 digits." >&2; exit 1; }
[[ "${INSTANCE_ID}" =~ ^i-[A-Za-z0-9]+$ ]] || { echo "INSTANCE_ID is invalid." >&2; exit 1; }
[[ "${WORKLOAD_ROLE_NAME}" =~ ^[A-Za-z0-9+=,.@_-]{1,64}$ ]] || {
  echo "WORKLOAD_ROLE_NAME is invalid." >&2
  exit 1
}
expected_oidc_arn="arn:${AWS_PARTITION}:iam::${AWS_ACCOUNT_ID}:oidc-provider/token.actions.githubusercontent.com"
[[ "${OIDC_PROVIDER_ARN}" == "${expected_oidc_arn}" ]] || {
  echo "OIDC_PROVIDER_ARN does not match the required account and GitHub provider." >&2
  exit 1
}
expected_secret_prefix="arn:${AWS_PARTITION}:secretsmanager:${AWS_REGION}:${AWS_ACCOUNT_ID}:secret:"
[[ "${OPENROUTER_SECRET_ARN}" == "${expected_secret_prefix}"* ]] || {
  echo "OPENROUTER_SECRET_ARN does not match the required account and region." >&2
  exit 1
}
expected_ses_identity_arn="arn:${AWS_PARTITION}:ses:${AWS_REGION}:${AWS_ACCOUNT_ID}:identity/they.dev"
[[ "${SES_IDENTITY_ARN}" == "${expected_ses_identity_arn}" ]] || {
  echo "SES_IDENTITY_ARN must be the exact they.dev identity in the required account and region." >&2
  exit 1
}

instance_profile_arn="$(aws ec2 describe-instances \
  --region "${AWS_REGION}" \
  --instance-ids "${INSTANCE_ID}" \
  --query 'Reservations[0].Instances[0].IamInstanceProfile.Arn' \
  --output text)"
expected_profile_prefix="arn:${AWS_PARTITION}:iam::${AWS_ACCOUNT_ID}:instance-profile/"
[[ "${instance_profile_arn}" == "${expected_profile_prefix}"* ]] || {
  echo "INSTANCE_ID does not expose an instance profile in the required account." >&2
  exit 1
}
instance_profile_name="${instance_profile_arn##*/}"
instance_profile_json="$(aws iam get-instance-profile \
  --instance-profile-name "${instance_profile_name}" \
  --output json)"
host_role_arn="$(python3 -c '
import json
import sys

document = json.load(sys.stdin)
roles = document.get("InstanceProfile", {}).get("Roles", [])
if len(roles) != 1 or roles[0].get("RoleName") != sys.argv[1]:
    raise SystemExit("INSTANCE_ID is not bound to the exact HOST_ROLE_NAME")
role_arn = roles[0].get("Arn")
if not isinstance(role_arn, str) or not role_arn.startswith(sys.argv[2]):
    raise SystemExit("HOST_ROLE_NAME does not expose the required account role ARN")
print(role_arn)
' "${HOST_ROLE_NAME}" "arn:${AWS_PARTITION}:iam::${AWS_ACCOUNT_ID}:role/" <<<"${instance_profile_json}")"

deploy_policy_name="OpenMercatoPublicDemoDeploy"
host_policy_name="OpenMercatoPublicDemoHostAccess"
workload_policy_name="OpenMercatoPublicDemoSesSend"
temporary_directory="$(mktemp -d)"
trust_file="${temporary_directory}/trust.json"
deploy_policy_file="${temporary_directory}/deploy-policy.json"
host_policy_file="${temporary_directory}/host-policy.json"
workload_trust_file="${temporary_directory}/workload-trust.json"
workload_policy_file="${temporary_directory}/workload-policy.json"
aws_error_file="${temporary_directory}/aws-error"
deploy_role_create_attempted=0
deploy_policy_put_attempted=0
host_policy_put_attempted=0
workload_role_create_attempted=0
workload_policy_put_attempted=0
completed=0

cleanup() {
  local original_status=$?
  local rollback_failed=0
  trap - EXIT HUP INT TERM

  confirm_policy_absent() {
    local role_name="$1"
    local policy_name="$2"
    local attempt
    for attempt in 1 2 3 4 5; do
      if aws iam get-role-policy \
        --role-name "${role_name}" \
        --policy-name "${policy_name}" \
        --output json >/dev/null 2>"${aws_error_file}"; then
        sleep 2
        continue
      fi
      if grep -q 'NoSuchEntity' "${aws_error_file}"; then
        return 0
      fi
      cat "${aws_error_file}" >&2
      return 1
    done
    return 1
  }

  confirm_role_absent() {
    local role_name="$1"
    local attempt
    for attempt in 1 2 3 4 5; do
      if aws iam get-role --role-name "${role_name}" --output json >/dev/null 2>"${aws_error_file}"; then
        sleep 2
        continue
      fi
      if grep -q 'NoSuchEntity' "${aws_error_file}"; then
        return 0
      fi
      cat "${aws_error_file}" >&2
      return 1
    done
    return 1
  }

  exact_json_files_equal() {
    python3 - "$1" "$2" <<'PY'
import json
import sys
from pathlib import Path

expected = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
actual = json.loads(Path(sys.argv[2]).read_text(encoding="utf-8"))
raise SystemExit(0 if actual == expected else 1)
PY
  }

  read_exact_policy_state() {
    local role_name="$1"
    local policy_name="$2"
    local expected_file="$3"
    local actual_file="${temporary_directory}/rollback-${policy_name}.json"
    local attempt
    for attempt in 1 2 3 4 5; do
      if aws iam get-role-policy \
        --role-name "${role_name}" \
        --policy-name "${policy_name}" \
        --query PolicyDocument \
        --output json >"${actual_file}" 2>"${aws_error_file}"; then
        exact_json_files_equal "${expected_file}" "${actual_file}" && return 0
        echo "Rollback preserved ${policy_name} because its accepted state drifted from the attempted policy." >&2
        return 2
      fi
      if ! grep -q 'NoSuchEntity' "${aws_error_file}"; then
        cat "${aws_error_file}" >&2
        return 2
      fi
      [[ "${attempt}" -eq 5 ]] || sleep 2
    done
    return 1
  }

  read_exact_role_state() {
    local role_name="$1"
    local expected_trust_file="$2"
    local actual_file="${temporary_directory}/rollback-${role_name}-trust.json"
    local attempt
    for attempt in 1 2 3 4 5; do
      if aws iam get-role \
        --role-name "${role_name}" \
        --query 'Role.AssumeRolePolicyDocument' \
        --output json >"${actual_file}" 2>"${aws_error_file}"; then
        exact_json_files_equal "${expected_trust_file}" "${actual_file}" && return 0
        echo "Rollback preserved ${role_name} because its accepted state drifted from the attempted trust." >&2
        return 2
      fi
      if ! grep -q 'NoSuchEntity' "${aws_error_file}"; then
        cat "${aws_error_file}" >&2
        return 2
      fi
      [[ "${attempt}" -eq 5 ]] || sleep 2
    done
    return 1
  }

  rollback_attempted_policy() {
    local role_name="$1"
    local policy_name="$2"
    local expected_file="$3"
    local attempted="$4"
    local state
    [[ "${attempted}" -eq 1 ]] || return 0
    if read_exact_policy_state "${role_name}" "${policy_name}" "${expected_file}"; then
      aws iam delete-role-policy --role-name "${role_name}" --policy-name "${policy_name}" >/dev/null 2>&1 || true
      confirm_policy_absent "${role_name}" "${policy_name}"
      return
    fi
    state=$?
    [[ "${state}" -eq 1 ]]
  }

  rollback_attempted_role() {
    local role_name="$1"
    local policy_name="$2"
    local expected_trust_file="$3"
    local expected_policy_file="$4"
    local role_attempted="$5"
    local policy_attempted="$6"
    local state
    if [[ "${role_attempted}" -ne 1 ]]; then
      rollback_attempted_policy "${role_name}" "${policy_name}" "${expected_policy_file}" "${policy_attempted}"
      return
    fi
    if read_exact_role_state "${role_name}" "${expected_trust_file}"; then
      rollback_attempted_policy "${role_name}" "${policy_name}" "${expected_policy_file}" "${policy_attempted}" || return 1
      aws iam delete-role --role-name "${role_name}" >/dev/null 2>&1 || true
      confirm_role_absent "${role_name}"
      return
    fi
    state=$?
    [[ "${state}" -eq 1 ]]
  }

  if [[ "${completed}" -ne 1 ]]; then
    rollback_attempted_policy \
      "${HOST_ROLE_NAME}" "${host_policy_name}" "${host_policy_file}" "${host_policy_put_attempted}" || rollback_failed=1
    rollback_attempted_role \
      "${WORKLOAD_ROLE_NAME}" "${workload_policy_name}" \
      "${workload_trust_file}" "${workload_policy_file}" \
      "${workload_role_create_attempted}" "${workload_policy_put_attempted}" || rollback_failed=1
    rollback_attempted_role \
      "${DEPLOY_ROLE_NAME}" "${deploy_policy_name}" \
      "${trust_file}" "${deploy_policy_file}" \
      "${deploy_role_create_attempted}" "${deploy_policy_put_attempted}" || rollback_failed=1
  fi
  rm -f "${temporary_directory}"/*
  rmdir "${temporary_directory}" 2>/dev/null || true
  if [[ "${rollback_failed}" -ne 0 ]]; then
    echo "IAM rollback could not be confirmed; stop before continuing." >&2
    exit 1
  fi
  exit "${original_status}"
}
trap cleanup EXIT
trap 'exit 130' HUP INT TERM

export PUBLIC_DEMO_DEPLOY_REPOSITORY="TH-EY/open-mercato"
export PUBLIC_DEMO_DEPLOY_REF="refs/heads/feat/THOM-113-public-demo"
export PUBLIC_DEMO_OIDC_SUBJECT="repo:TH-EY/open-mercato:ref:refs/heads/feat/THOM-113-public-demo"
export PUBLIC_DEMO_HOST_ROLE_ARN="${host_role_arn}"
export PUBLIC_DEMO_WORKLOAD_ROLE_ARN="arn:${AWS_PARTITION}:iam::${AWS_ACCOUNT_ID}:role/${WORKLOAD_ROLE_NAME}"
python3 - \
  "${trust_file}" "${deploy_policy_file}" "${host_policy_file}" \
  "${workload_trust_file}" "${workload_policy_file}" <<'PY'
import json
import os
import sys
from pathlib import Path

partition = os.environ["AWS_PARTITION"]
region = os.environ["AWS_REGION"]
account = os.environ["AWS_ACCOUNT_ID"]
instance_id = os.environ["INSTANCE_ID"]
repository = os.environ["ECR_REPOSITORY"]

trust = {
    "Version": "2012-10-17",
    "Statement": [{
        "Effect": "Allow",
        "Principal": {"Federated": os.environ["OIDC_PROVIDER_ARN"]},
        "Action": "sts:AssumeRoleWithWebIdentity",
        "Condition": {"StringEquals": {
            "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
            "token.actions.githubusercontent.com:sub": os.environ["PUBLIC_DEMO_OIDC_SUBJECT"],
        }},
    }],
}

deploy = {
    "Version": "2012-10-17",
    "Statement": [
        {"Sid": "EcrLogin", "Effect": "Allow", "Action": "ecr:GetAuthorizationToken", "Resource": "*"},
        {
            "Sid": "ExactEcrRepository",
            "Effect": "Allow",
            "Action": [
                "ecr:BatchCheckLayerAvailability", "ecr:CompleteLayerUpload",
                "ecr:DescribeImages", "ecr:DescribeRepositories",
                "ecr:InitiateLayerUpload", "ecr:PutImage", "ecr:UploadLayerPart",
            ],
            "Resource": f"arn:{partition}:ecr:{region}:{account}:repository/{repository}",
        },
        {
            "Sid": "ExactHostRunShell",
            "Effect": "Allow",
            "Action": "ssm:SendCommand",
            "Resource": [
                f"arn:{partition}:ssm:{region}::document/AWS-RunShellScript",
                f"arn:{partition}:ec2:{region}:{account}:instance/{instance_id}",
            ],
        },
        {
            "Sid": "CommandReadbackAndCancellation",
            "Effect": "Allow",
            "Action": ["ssm:CancelCommand", "ssm:GetCommandInvocation"],
            "Resource": "*",
        },
        {
            "Sid": "TargetStateReadback",
            "Effect": "Allow",
            "Action": ["ec2:DescribeInstances", "ssm:DescribeInstanceInformation"],
            "Resource": "*",
        },
    ],
}

host = {
    "Version": "2012-10-17",
    "Statement": [
        {
            "Sid": "ExactOpenRouterSecretRead",
            "Effect": "Allow",
            "Action": "secretsmanager:GetSecretValue",
            "Resource": os.environ["OPENROUTER_SECRET_ARN"],
        },
        {
            "Sid": "AssumeExactPublicDemoWorkloadRole",
            "Effect": "Allow",
            "Action": "sts:AssumeRole",
            "Resource": os.environ["PUBLIC_DEMO_WORKLOAD_ROLE_ARN"],
        },
    ],
}

workload_trust = {
    "Version": "2012-10-17",
    "Statement": [{
        "Effect": "Allow",
        "Principal": {"AWS": os.environ["PUBLIC_DEMO_HOST_ROLE_ARN"]},
        "Action": "sts:AssumeRole",
    }],
}

workload = {
    "Version": "2012-10-17",
    "Statement": [{
        "Sid": "ExactSimulatorDelivery",
        "Effect": "Allow",
        "Action": ["ses:SendEmail", "ses:SendRawEmail"],
        "Resource": os.environ["SES_IDENTITY_ARN"],
        "Condition": {
            "StringEquals": {"ses:FromAddress": "no-reply@they.dev"},
            "ForAllValues:StringEquals": {
                "ses:Recipients": ["success@simulator.amazonses.com"],
            },
            "Null": {"ses:Recipients": "false"},
        },
    }],
}

documents = (trust, deploy, host, workload_trust, workload)
for filename, document in zip(sys.argv[1:], documents, strict=True):
    Path(filename).write_text(json.dumps(document, separators=(",", ":")), encoding="utf-8")
PY
chmod 600 \
  "${trust_file}" "${deploy_policy_file}" "${host_policy_file}" \
  "${workload_trust_file}" "${workload_policy_file}"

canonical_equal() {
  python3 - "$1" "$2" <<'PY'
import json
import sys
from pathlib import Path

expected = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
actual = json.loads(Path(sys.argv[2]).read_text(encoding="utf-8"))
raise SystemExit(0 if actual == expected else 1)
PY
}

read_role_trust() {
  local role_name="$1"
  local output_file="$2"
  if aws iam get-role --role-name "${role_name}" --query 'Role.AssumeRolePolicyDocument' --output json >"${output_file}" 2>"${aws_error_file}"; then
    return 0
  fi
  if grep -q 'NoSuchEntity' "${aws_error_file}"; then
    return 1
  fi
  cat "${aws_error_file}" >&2
  return 2
}

deploy_existing_trust="${temporary_directory}/deploy-existing-trust.json"
if read_role_trust "${DEPLOY_ROLE_NAME}" "${deploy_existing_trust}"; then
  canonical_equal "${trust_file}" "${deploy_existing_trust}" || {
    echo "Existing deploy role trust differs from the exact repository/ref contract." >&2
    exit 1
  }
else
  role_state=$?
  [[ "${role_state}" -eq 1 ]] || exit "${role_state}"
  deploy_role_create_attempted=1
  aws iam create-role \
    --role-name "${DEPLOY_ROLE_NAME}" \
    --assume-role-policy-document "file://${trust_file}" \
    --output json >/dev/null
fi

ensure_inline_policy() {
  local role_name="$1"
  local policy_name="$2"
  local expected_file="$3"
  local added_flag_name="$4"
  local existing_file="${temporary_directory}/${policy_name}-existing.json"

  if aws iam get-role-policy \
    --role-name "${role_name}" \
    --policy-name "${policy_name}" \
    --query PolicyDocument \
    --output json >"${existing_file}" 2>"${aws_error_file}"; then
    canonical_equal "${expected_file}" "${existing_file}" || {
      echo "Existing ${policy_name} policy differs from the expected contract." >&2
      exit 1
    }
    return
  fi
  if ! grep -q 'NoSuchEntity' "${aws_error_file}"; then
    cat "${aws_error_file}" >&2
    exit 1
  fi

  printf -v "${added_flag_name}" '%s' 1
  aws iam put-role-policy \
    --role-name "${role_name}" \
    --policy-name "${policy_name}" \
    --policy-document "file://${expected_file}"
}

assert_exclusive_role_policies() {
  local role_name="$1"
  local expected_policy_name="$2"
  local inline_file="${temporary_directory}/${role_name}-inline-policies.json"
  local attached_file="${temporary_directory}/${role_name}-attached-policies.json"

  aws iam list-role-policies \
    --role-name "${role_name}" \
    --output json >"${inline_file}"
  aws iam list-attached-role-policies \
    --role-name "${role_name}" \
    --output json >"${attached_file}"
  python3 - "${expected_policy_name}" "${inline_file}" "${attached_file}" <<'PY'
import json
import sys
from pathlib import Path

expected_name, inline_path, attached_path = sys.argv[1:]
inline = json.loads(Path(inline_path).read_text(encoding="utf-8"))
attached = json.loads(Path(attached_path).read_text(encoding="utf-8"))
if inline.get("PolicyNames") != [expected_name] or attached.get("AttachedPolicies") != []:
    raise SystemExit("dedicated role has policies outside the exact approved set")
PY
}

ensure_inline_policy "${DEPLOY_ROLE_NAME}" "${deploy_policy_name}" "${deploy_policy_file}" deploy_policy_put_attempted
assert_exclusive_role_policies "${DEPLOY_ROLE_NAME}" "${deploy_policy_name}"

workload_existing_trust="${temporary_directory}/workload-existing-trust.json"
if read_role_trust "${WORKLOAD_ROLE_NAME}" "${workload_existing_trust}"; then
  canonical_equal "${workload_trust_file}" "${workload_existing_trust}" || {
    echo "Existing workload role trust differs from the exact host-role contract." >&2
    exit 1
  }
else
  workload_role_state=$?
  [[ "${workload_role_state}" -eq 1 ]] || exit "${workload_role_state}"
  workload_role_create_attempted=1
  aws iam create-role \
    --role-name "${WORKLOAD_ROLE_NAME}" \
    --assume-role-policy-document "file://${workload_trust_file}" \
    --output json >/dev/null
fi
ensure_inline_policy \
  "${WORKLOAD_ROLE_NAME}" "${workload_policy_name}" "${workload_policy_file}" workload_policy_put_attempted
assert_exclusive_role_policies "${WORKLOAD_ROLE_NAME}" "${workload_policy_name}"

host_trust="${temporary_directory}/host-trust.json"
if read_role_trust "${HOST_ROLE_NAME}" "${host_trust}"; then
  :
else
  host_state=$?
  if [[ "${host_state}" -eq 1 ]]; then
    echo "HOST_ROLE_NAME does not exist." >&2
    exit 1
  fi
  exit "${host_state}"
fi
ensure_inline_policy "${HOST_ROLE_NAME}" "${host_policy_name}" "${host_policy_file}" host_policy_put_attempted

completed=1
echo "Verified exact-ref deploy role, exact host access, and exact SES workload role."
