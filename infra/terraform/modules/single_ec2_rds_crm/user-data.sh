#!/usr/bin/env bash
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl git jq unzip awscli
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
fi
systemctl enable --now docker
usermod -aG docker ubuntu || true
mkdir -p /opt/openmercato-crm /var/log/openmercato-crm
cat >/etc/profile.d/openmercato-crm.sh <<PROFILE
export AWS_REGION="${aws_region}"
export OM_CRM_NAME_PREFIX="${name_prefix}"
PROFILE
