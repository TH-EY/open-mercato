#!/usr/bin/env bash
set -euxo pipefail

export DEBIAN_FRONTEND=noninteractive

apt-get update
apt-get install -y curl ca-certificates gnupg lsb-release ufw

if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
fi

systemctl enable docker
systemctl start docker

if ! docker info >/dev/null 2>&1; then
  usermod -aG docker ubuntu || true
fi

curl -sSL https://dokploy.com/install.sh | sh
