#!/usr/bin/env bash
set -euo pipefail

require_value() {
  local name="$1"
  [[ -n "${!name:-}" ]] || {
    echo "${name} is required." >&2
    exit 1
  }
}

for command_name in curl docker git jq sort stat; do
  command -v "${command_name}" >/dev/null 2>&1 || {
    echo "${command_name} is required." >&2
    exit 1
  }
done

for required_name in EXPECTED_DEPLOYMENT_SHA EXPECTED_IMAGE_URI EXPECTED_IMAGE_DIGEST; do
  require_value "${required_name}"
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

workdir="${PUBLIC_DEMO_WORKDIR:-/opt/openmercato-public-demo}"
owner_marker="${workdir}/.first-provision-owner"
staged_marker="${workdir}/.first-provision-staged"

for marker in "${owner_marker}" "${staged_marker}"; do
  [[ -f "${marker}" && ! -L "${marker}" ]] || {
    echo "Required public-demo candidate marker is missing or unsafe." >&2
    exit 1
  }
  [[ "$(stat -c '%a' "${marker}")" == 600 ]] || {
    echo "Public-demo candidate marker mode is not 0600." >&2
    exit 1
  }
done

[[ "$(cat "${owner_marker}")" == "${EXPECTED_DEPLOYMENT_SHA}" ]] || {
  echo "First-provision owner does not match the approved deployment SHA." >&2
  exit 1
}

expected_manifest="$(printf 'deployment_sha=%s\nimage_uri=%s\nimage_digest=%s' \
  "${EXPECTED_DEPLOYMENT_SHA}" \
  "${EXPECTED_IMAGE_URI}" \
  "${EXPECTED_IMAGE_DIGEST}")"
[[ "$(cat "${staged_marker}")" == "${expected_manifest}" ]] || {
  echo "Staged candidate manifest does not match the approved SHA and image digest." >&2
  exit 1
}

[[ -d "${workdir}/.git" && ! -L "${workdir}/.git" ]]
[[ "$(git -C "${workdir}" rev-parse HEAD)" == "${EXPECTED_DEPLOYMENT_SHA}" ]] || {
  echo "Host checkout does not match the approved deployment SHA." >&2
  exit 1
}
[[ -z "$(git -C "${workdir}" status --porcelain --untracked-files=no)" ]] || {
  echo "Host checkout contains tracked drift." >&2
  exit 1
}

expected_services=$'app\naws-credential-broker\nmcp\nmeilisearch\npostgres\nredis\nworker'
actual_services="$(docker ps -a \
  --filter label=com.docker.compose.project=openmercato-public-demo \
  --format '{{.Label "com.docker.compose.service"}}' | sort)"
[[ "${actual_services}" == "${expected_services}" ]] || {
  echo "Host Compose service set does not match the reviewed public-demo topology." >&2
  exit 1
}

for service in app aws-credential-broker mcp meilisearch postgres redis worker; do
  container="openmercato-public-demo-${service}"
  [[ "$(docker inspect --format '{{.State.Running}}' "${container}")" == true ]] || {
    echo "Required public-demo service ${service} is not running." >&2
    exit 1
  }
done
compose_config="$(docker compose \
  --env-file "${workdir}/.env.public-demo" \
  -f "${workdir}/docker-compose.public-demo.yml" \
  config --format json)"
for service in app aws-credential-broker mcp meilisearch postgres redis worker; do
  container="openmercato-public-demo-${service}"
  expected_service_image="$(jq -er --arg service "${service}" '.services[$service].image' <<<"${compose_config}")"
  [[ "$(docker inspect --format '{{.Config.Image}}' "${container}")" == "${expected_service_image}" ]] || {
    echo "Public-demo service ${service} does not run the exact reviewed image." >&2
    exit 1
  }
done

login_status="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
  --connect-timeout 5 --max-time 15 http://127.0.0.1:4787/login)"
[[ "${login_status}" =~ ^[23][0-9][0-9]$ ]] || {
  echo "Local public-demo login probe failed." >&2
  exit 1
}
[[ "$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
  --connect-timeout 5 --max-time 15 http://127.0.0.1:4788/health)" == 200 ]] || {
  echo "Local public-demo MCP health probe failed." >&2
  exit 1
}

echo "Host read-back confirmed the exact approved SHA, image digest, services, and local probes."
