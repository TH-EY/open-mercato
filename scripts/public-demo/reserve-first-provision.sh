#!/usr/bin/env bash
set -euo pipefail

for command_name in docker mktemp mv ss stat; do
  command -v "${command_name}" >/dev/null 2>&1 || {
    echo "${command_name} is required." >&2
    exit 1
  }
done

[[ "${DEPLOYMENT_SHA:-}" =~ ^[0-9a-f]{40}$ ]] || {
  echo "DEPLOYMENT_SHA must be one lowercase full commit SHA." >&2
  exit 1
}

workdir="${PUBLIC_DEMO_WORKDIR:-/opt/openmercato-public-demo}"
owner_marker="${workdir}/.first-provision-owner"
staged_marker="${workdir}/.first-provision-staged"

if [[ -e "${staged_marker}" || -L "${staged_marker}" ]]; then
  echo "First provisioning has already been staged; this workflow cannot replay or upgrade it." >&2
  exit 1
fi

existing_containers="$(docker ps -aq --filter label=com.docker.compose.project=openmercato-public-demo)"
if [[ -n "${existing_containers}" ]]; then
  echo "The public-demo Compose project already exists; this workflow is first-provision-only." >&2
  exit 1
fi

for port in 4787 4788 4900; do
  if [[ -n "$(ss -H -ltn "sport = :${port}" || true)" ]]; then
    echo "Host port ${port} is already in use; first provisioning requires an empty namespace." >&2
    exit 1
  fi
done

if [[ -e "${owner_marker}" || -L "${owner_marker}" ]]; then
  [[ -f "${owner_marker}" && ! -L "${owner_marker}" ]]
  [[ "$(stat -c '%a' "${owner_marker}")" == 600 ]]
  if [[ "$(cat "${owner_marker}")" != "${DEPLOYMENT_SHA}" ]]; then
    echo "Partial first provisioning belongs to a different deployment SHA." >&2
    exit 1
  fi
  echo "Same-SHA first-provision recovery admitted."
  exit 0
fi

if [[ -e "${workdir}" || -L "${workdir}" ]]; then
  echo "Public-demo workdir exists without an exact owner marker." >&2
  exit 1
fi

for volume in \
  public_demo_init_marker \
  public_demo_attachments_storage \
  public_demo_mcp_shared \
  public_demo_postgres_data \
  public_demo_redis_data \
  public_demo_meilisearch_data; do
  if docker volume inspect "${volume}" >/dev/null 2>&1; then
    echo "Public-demo volume ${volume} exists without an exact owner marker." >&2
    exit 1
  fi
done
if docker network inspect public_demo_network >/dev/null 2>&1; then
  echo "Public-demo network exists without an exact owner marker." >&2
  exit 1
fi

reservation_parent="$(dirname "${workdir}")"
reservation_name="$(basename "${workdir}")"
reservation_directory="$(mktemp -d "${reservation_parent}/.${reservation_name}.reserve.XXXXXX")"
cleanup_reservation_directory() {
  if [[ -n "${reservation_directory}" && -d "${reservation_directory}" ]]; then
    rm -f "${reservation_directory}/.first-provision-owner"
    rmdir "${reservation_directory}"
  fi
}
trap cleanup_reservation_directory EXIT HUP INT TERM
chmod 700 "${reservation_directory}"
printf '%s\n' "${DEPLOYMENT_SHA}" > "${reservation_directory}/.first-provision-owner"
chmod 600 "${reservation_directory}/.first-provision-owner"
mv "${reservation_directory}" "${workdir}"
reservation_directory=""
trap - EXIT HUP INT TERM

[[ -f "${owner_marker}" && ! -L "${owner_marker}" ]]
[[ "$(stat -c '%a' "${owner_marker}")" == 600 ]]
[[ "$(cat "${owner_marker}")" == "${DEPLOYMENT_SHA}" ]]
echo "First-provision preflight reserved the runtime namespace for the exact deployment SHA."
