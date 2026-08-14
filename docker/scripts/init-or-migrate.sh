#!/bin/sh
set -e

MARKER_FILE="${INIT_MARKER_FILE:-/tmp/init-marker/.seeded}"
INIT_COMMAND="${INIT_COMMAND:-yarn initialize}"
MIGRATE_COMMAND="${MIGRATE_COMMAND:-yarn db:migrate}"
RESEND_UPGRADE_COMMAND="${RESEND_UPGRADE_COMMAND:-yarn mercato seed:defaults --module channel_resend}"
ALREADY_INITIALIZED_PATTERN='Initialization aborted: found [0-9][0-9]* existing user\(s\) in the database\.'
CLI_NOT_FOUND_PATTERN='command not found: mercato'

run_command_with_cli_recovery() {
  COMMAND="$1"
  LOG_FILE="$2"

  if sh -lc "${COMMAND}" >"${LOG_FILE}" 2>&1; then
    return 0
  else
    STATUS=$?
  fi

  if ! grep -Fq "${CLI_NOT_FOUND_PATTERN}" "${LOG_FILE}"; then
    return "${STATUS}"
  fi

  echo "Open Mercato CLI missing; running yarn install and retrying..."
  yarn install
  sh -lc "${COMMAND}" >"${LOG_FILE}" 2>&1
}

run_subsequent_provider_upgrade() {
  if [ "${SYSTEM_EMAIL_PROVIDER:-resend}" != "resend" ]; then
    return 0
  fi
  PROVIDER_LOG_FILE="$(mktemp)"
  if run_command_with_cli_recovery "${RESEND_UPGRADE_COMMAND}" "${PROVIDER_LOG_FILE}"; then
    cat "${PROVIDER_LOG_FILE}"
    rm -f "${PROVIDER_LOG_FILE}"
    return 0
  else
    PROVIDER_STATUS=$?
  fi
  cat "${PROVIDER_LOG_FILE}"
  rm -f "${PROVIDER_LOG_FILE}"
  return "${PROVIDER_STATUS}"
}

if [ ! -f "${MARKER_FILE}" ]; then
  echo "First run: full initialization..."
  LOG_FILE="$(mktemp)"

  if run_command_with_cli_recovery "${INIT_COMMAND}" "${LOG_FILE}"; then
    cat "${LOG_FILE}"
    rm -f "${LOG_FILE}"
    mkdir -p "$(dirname "${MARKER_FILE}")"
    touch "${MARKER_FILE}"
    exit 0
  else
    STATUS=$?
    cat "${LOG_FILE}"

    if grep -Eq "${ALREADY_INITIALIZED_PATTERN}" "${LOG_FILE}"; then
      rm -f "${LOG_FILE}"
      echo "Initialization reported existing users; treating database as already initialized."
      echo "Running migrations..."
      RECOVERY_LOG_FILE="$(mktemp)"
      if run_command_with_cli_recovery "${MIGRATE_COMMAND}" "${RECOVERY_LOG_FILE}"; then
        cat "${RECOVERY_LOG_FILE}"
        rm -f "${RECOVERY_LOG_FILE}"
        run_subsequent_provider_upgrade
      else
        RECOVERY_STATUS=$?
        cat "${RECOVERY_LOG_FILE}"
        rm -f "${RECOVERY_LOG_FILE}"
        exit "${RECOVERY_STATUS}"
      fi
      mkdir -p "$(dirname "${MARKER_FILE}")"
      touch "${MARKER_FILE}"
      exit 0
    fi

    rm -f "${LOG_FILE}"
    exit "${STATUS}"
  fi
fi

echo "Subsequent run: migrations only..."
LOG_FILE="$(mktemp)"

if run_command_with_cli_recovery "${MIGRATE_COMMAND}" "${LOG_FILE}"; then
  cat "${LOG_FILE}"
  rm -f "${LOG_FILE}"
  run_subsequent_provider_upgrade
  exit $?
fi

STATUS=$?
cat "${LOG_FILE}"
rm -f "${LOG_FILE}"
exit "${STATUS}"
