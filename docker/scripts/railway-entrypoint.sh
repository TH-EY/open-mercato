#!/bin/sh
set -e

# Railway entrypoint script
# Runs as omuser (non-root). Uses passwordless sudo for chown only.
# Uses /app/apps/mercato/storage (mounted volume) for both
# file attachments and the init marker to avoid needing two volumes.

STORAGE_DIR="/app/apps/mercato/storage"
MARKER_FILE="${STORAGE_DIR}/.initialized"

sudo chown -R omuser:omuser "${STORAGE_DIR}"

if [ "${OM_SKIP_INIT_OR_MIGRATE:-false}" = "true" ]; then
  echo "Skipping init/migrate because OM_SKIP_INIT_OR_MIGRATE=true"
else
  INIT_MARKER_FILE="${MARKER_FILE}" INIT_COMMAND="yarn mercato init" sh /app/docker/scripts/init-or-migrate.sh
fi

exec yarn start
