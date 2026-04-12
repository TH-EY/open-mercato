#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./preview-common.sh
source "${SCRIPT_DIR}/preview-common.sh"

INSTANCE_ID="${PREVIEW_INSTANCE_ID}"
INSTANCE_SG_ID="${INSTANCE_SG_ID:-$(aws ec2 describe-instances --region "${AWS_REGION}" --instance-ids "${INSTANCE_ID}" --query 'Reservations[0].Instances[0].SecurityGroups[0].GroupId' --output text)}"
CERT_DOMAIN="${CERT_DOMAIN:-*.om.they.dev}"
CERT_ALT_NAME="${CERT_ALT_NAME:-om.they.dev}"

aws ec2 authorize-security-group-ingress \
  --region "${AWS_REGION}" \
  --group-id "${INSTANCE_SG_ID}" \
  --ip-permissions "[{\"IpProtocol\":\"tcp\",\"FromPort\":${PREVIEW_PORT_MIN},\"ToPort\":${PREVIEW_PORT_MAX},\"UserIdGroupPairs\":[{\"GroupId\":$(json_escape "${ALB_SG_ID}"),\"Description\":\"ALB preview ports\"}]}]" >/dev/null 2>&1 || true

CERT_ARN="$(aws acm list-certificates --region "${AWS_REGION}" --certificate-statuses ISSUED PENDING_VALIDATION --query "CertificateSummaryList[?DomainName=='${CERT_DOMAIN}'].CertificateArn | [0]" --output text)"
if [[ -z "${CERT_ARN}" || "${CERT_ARN}" == "None" ]]; then
  CERT_ARN="$(aws acm request-certificate \
    --region "${AWS_REGION}" \
    --domain-name "${CERT_DOMAIN}" \
    --subject-alternative-names "${CERT_ALT_NAME}" \
    --validation-method DNS \
    --query 'CertificateArn' \
    --output text)"
fi

VALIDATION_JSON="$(aws acm describe-certificate --region "${AWS_REGION}" --certificate-arn "${CERT_ARN}" --query 'Certificate.DomainValidationOptions' --output json)"
python3 - <<'PY' "${VALIDATION_JSON}" "${HOSTED_ZONE_ID}" > /tmp/om-preview-cert-route53.json
import json, sys
items = json.loads(sys.argv[1])
changes = []
for item in items:
    rr = item.get('ResourceRecord')
    if not rr:
        continue
    changes.append({
        'Action': 'UPSERT',
        'ResourceRecordSet': {
            'Name': rr['Name'],
            'Type': rr['Type'],
            'TTL': 300,
            'ResourceRecords': [{'Value': rr['Value']}],
        }
    })
print(json.dumps({'Comment': 'ACM validation for *.om.they.dev', 'Changes': changes}))
PY
if [[ "$(python3 - <<'PY'
import json
from pathlib import Path
payload = json.loads(Path('/tmp/om-preview-cert-route53.json').read_text())
print(len(payload.get('Changes', [])))
PY
)" != "0" ]]; then
  aws route53 change-resource-record-sets --hosted-zone-id "${HOSTED_ZONE_ID}" --change-batch file:///tmp/om-preview-cert-route53.json >/dev/null
fi

aws acm wait certificate-validated --region "${AWS_REGION}" --certificate-arn "${CERT_ARN}"

ATTACHED="$(aws elbv2 describe-listener-certificates --region "${AWS_REGION}" --listener-arn "${LISTENER_ARN}" --query "Certificates[?CertificateArn=='${CERT_ARN}'].CertificateArn | [0]" --output text)"
if [[ -z "${ATTACHED}" || "${ATTACHED}" == "None" ]]; then
  aws elbv2 add-listener-certificates --region "${AWS_REGION}" --listener-arn "${LISTENER_ARN}" --certificates CertificateArn="${CERT_ARN}" >/dev/null
fi

cat > /tmp/om-preview-wildcard-alias.json <<EOF
{
  "Comment": "UPSERT wildcard om.they.dev alias",
  "Changes": [
    {
      "Action": "UPSERT",
      "ResourceRecordSet": {
        "Name": "*.om.they.dev",
        "Type": "A",
        "AliasTarget": {
          "HostedZoneId": "${ALB_ZONE_ID}",
          "DNSName": "${ALB_DNS_NAME}",
          "EvaluateTargetHealth": false
        }
      }
    }
  ]
}
EOF
aws route53 change-resource-record-sets --hosted-zone-id "${HOSTED_ZONE_ID}" --change-batch file:///tmp/om-preview-wildcard-alias.json >/dev/null

echo "certificate_arn=${CERT_ARN}"
echo "instance_security_group_id=${INSTANCE_SG_ID}"
echo "wildcard_record=*.om.they.dev"
