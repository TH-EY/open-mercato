#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# Open Mercato - Local Setup Script (macOS / Linux)
# =============================================================================
# One-click installer for development.
# Idempotent: safe to re-run at any time.
#
# Usage:
#   ./scripts/setup-local.sh              # native setup (requires Node 24)
#   ./scripts/setup-local.sh --docker     # Docker-only setup (no Node required)
#   ./scripts/setup-local.sh --skip-infra # native setup, skip Docker infra
#
# Prerequisites:
#   Native mode: Node.js 24.x, corepack, Docker Desktop
#   Docker mode:  Docker Desktop only
# =============================================================================

SKIP_INFRA=false
DOCKER_MODE=false
for arg in "$@"; do
  case "$arg" in
    --skip-infra) SKIP_INFRA=true ;;
    --docker)     DOCKER_MODE=true ;;
  esac
done

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

info()  { echo -e "${BLUE}==>${NC} $1"; }
ok()    { echo -e "${GREEN}  OK${NC} $1"; }
warn()  { echo -e "${YELLOW}  WARN${NC} $1"; }
fail()  { echo -e "${RED}  FAIL${NC} $1"; exit 1; }

# Cross-platform sed -i (macOS requires '' backup extension, Linux does not)
sedi() {
  if [[ "$OSTYPE" == "darwin"* ]]; then
    sed -i '' "$@"
  else
    sed -i "$@"
  fi
}

echo ""
echo "============================================"
echo "  Open Mercato - Local Setup"
echo "============================================"
echo ""

# ---------------------------------------------------------------------------
# Phase 0: Ensure we're in the project root
# ---------------------------------------------------------------------------
if [ ! -f "package.json" ] || ! grep -q '"open-mercato"' package.json 2>/dev/null; then
  fail "Must be run from the Open Mercato project root (where package.json is)."
fi

# =============================================================================
# Docker-only mode: everything runs inside containers
# =============================================================================
if [ "$DOCKER_MODE" = true ]; then
  info "Docker-only mode - no Node.js required on host"
  echo ""

  # Check Docker
  if ! command -v docker &>/dev/null; then
    fail "Docker not found. Install Docker Desktop: https://docker.com/products/docker-desktop"
  fi
  ok "Docker $(docker --version | grep -oE '[0-9]+\.[0-9]+\.[0-9]+')"

  if ! docker compose version &>/dev/null; then
    fail "Docker Compose v2 not found. Update Docker Desktop."
  fi
  ok "Docker Compose $(docker compose version --short)"

  if ! docker info &>/dev/null 2>&1; then
    fail "Docker daemon is not running. Start Docker Desktop and try again."
  fi
  ok "Docker daemon running"
  echo ""

  info "Building and starting full stack (this may take a few minutes on first run)..."
  echo ""
  echo "  This will:"
  echo "    - Build a Node 24 container with all dependencies"
  echo "    - Start PostgreSQL, Redis, and Meilisearch"
  echo "    - Install deps, build packages, run generators"
  echo "    - Initialize/migrate the database"
  echo "    - Start the dev server with hot reload"
  echo ""

  docker compose -f docker-compose.fullapp.dev.yml up --build -d
  ok "Containers started"
  echo ""

  info "Waiting for app to be ready (watching logs)..."
  echo "  (This takes 2-5 minutes on first run while packages build)"
  echo ""

  # Wait for the app to be ready by watching for the Next.js ready message
  TIMEOUT=600
  ELAPSED=0
  while [ $ELAPSED -lt $TIMEOUT ]; do
    if docker compose -f docker-compose.fullapp.dev.yml logs app 2>/dev/null | grep -q "Ready in"; then
      ok "App is ready!"
      echo ""
      break
    fi
    # Also check if container exited with error
    APP_STATUS=$(docker compose -f docker-compose.fullapp.dev.yml ps app --format '{{.State}}' 2>/dev/null || echo "unknown")
    if [ "$APP_STATUS" = "exited" ]; then
      echo ""
      warn "App container exited. Showing last 30 lines of logs:"
      docker compose -f docker-compose.fullapp.dev.yml logs app --tail 30
      fail "App failed to start. Check logs above."
    fi
    sleep 5
    ELAPSED=$((ELAPSED + 5))
    # Print progress every 30 seconds
    if [ $((ELAPSED % 30)) -eq 0 ]; then
      info "  Still building... (${ELAPSED}s elapsed)"
    fi
  done

  if [ $ELAPSED -ge $TIMEOUT ]; then
    fail "App did not become ready within ${TIMEOUT}s. Run: docker compose -f docker-compose.fullapp.dev.yml logs app"
  fi

  echo "============================================"
  echo "  Setup complete! (Docker mode)"
  echo ""
  echo "  App URL:         http://localhost:3000"
  echo "  Admin panel:     http://localhost:3000/backend"
  echo "  Default login:   superadmin@acme.com / secret"
  echo ""
  echo "  Useful commands:"
  echo "    docker compose -f docker-compose.fullapp.dev.yml logs -f app  # watch logs"
  echo "    docker compose -f docker-compose.fullapp.dev.yml down         # stop"
  echo "    docker compose -f docker-compose.fullapp.dev.yml up -d        # restart"
  echo "============================================"
  exit 0
fi

# =============================================================================
# Native mode: Node.js + Docker infra
# =============================================================================

# ---------------------------------------------------------------------------
# Phase 1: Prerequisite checks
# ---------------------------------------------------------------------------
info "[1/11] Checking prerequisites..."

# Node.js
if ! command -v node &>/dev/null; then
  echo ""
  warn "Node.js not found."
  echo "  Options:"
  echo "    1. Install Node 24.x (nvm install 24 && nvm use 24)"
  echo "    2. Run with --docker flag (no Node required):"
  echo "       ./scripts/setup-local.sh --docker"
  echo ""
  fail "Node.js is required for native mode."
fi
NODE_MAJOR=$(node -e "console.log(process.versions.node.split('.')[0])")
if [ "$NODE_MAJOR" -lt 20 ]; then
  fail "Node.js $NODE_MAJOR.x detected - minimum 20.x required (24.x recommended)."
fi
if [ "$NODE_MAJOR" -lt 24 ]; then
  warn "Node.js $NODE_MAJOR.x detected - 24.x is recommended (engines field). Continuing anyway."
else
  ok "Node.js $(node --version)"
fi

# Corepack
if ! command -v corepack &>/dev/null; then
  fail "Corepack not found. Run: npm install -g corepack"
fi
ok "Corepack $(corepack --version)"

# Docker
if [ "$SKIP_INFRA" = false ]; then
  if ! command -v docker &>/dev/null; then
    fail "Docker not found. Install Docker Desktop: https://docker.com/products/docker-desktop"
  fi
  ok "Docker $(docker --version | grep -oE '[0-9]+\.[0-9]+\.[0-9]+')"

  if ! docker compose version &>/dev/null; then
    fail "Docker Compose v2 not found. Update Docker Desktop."
  fi
  ok "Docker Compose $(docker compose version --short)"

  # Check Docker daemon is running
  if ! docker info &>/dev/null 2>&1; then
    fail "Docker daemon is not running. Start Docker Desktop and try again."
  fi
  ok "Docker daemon running"
fi

echo ""

# ---------------------------------------------------------------------------
# Phase 2: Enable corepack and ensure correct Yarn
# ---------------------------------------------------------------------------
info "[2/11] Enabling corepack..."
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0

# corepack enable may fail if Node was installed globally (e.g. brew) without write permission
if ! corepack enable 2>/dev/null; then
  warn "corepack enable failed (permission issue). Trying with sudo..."
  sudo corepack enable
fi

# Ensure corepack-managed yarn takes precedence over YVM or other shims.
# If `yarn --version` doesn't report 4.x, prepend the corepack bin directory.
COREPACK_BIN="$(dirname "$(command -v corepack)")"
YARN_VERSION="$(yarn --version 2>/dev/null || echo "0")"
if [[ ! "$YARN_VERSION" =~ ^4\. ]]; then
  warn "Yarn $YARN_VERSION detected (expected 4.x) - overriding PATH to use corepack."
  export PATH="$COREPACK_BIN:$PATH"
  YARN_VERSION="$(yarn --version 2>/dev/null || echo "unknown")"
  if [[ ! "$YARN_VERSION" =~ ^4\. ]]; then
    fail "Could not activate Yarn 4.x via corepack. Got: $YARN_VERSION"
  fi
fi
ok "Corepack enabled (Yarn $YARN_VERSION)"
echo ""

# ---------------------------------------------------------------------------
# Phase 3: Start Docker infrastructure
# ---------------------------------------------------------------------------
if [ "$SKIP_INFRA" = false ]; then
  info "[3/11] Starting Docker infrastructure (postgres, redis, meilisearch)..."
  docker compose up -d postgres redis meilisearch
  ok "Containers started"
  echo ""

  # -------------------------------------------------------------------------
  # Phase 4: Wait for healthy services
  # -------------------------------------------------------------------------
  info "[4/11] Waiting for services to become healthy..."

  wait_for_service() {
    local name="$1"
    local check_cmd="$2"
    local timeout_secs="${3:-60}"
    local elapsed=0
    while [ $elapsed -lt $timeout_secs ]; do
      if eval "$check_cmd" &>/dev/null 2>&1; then
        ok "$name ready (${elapsed}s)"
        return 0
      fi
      sleep 2
      elapsed=$((elapsed + 2))
    done
    fail "$name not ready after ${timeout_secs}s"
  }

  wait_for_service "PostgreSQL" "docker exec mercato-postgres pg_isready -U postgres" 60
  wait_for_service "Redis" "docker exec mercato-redis redis-cli ping" 30
  wait_for_service "Meilisearch" "curl -sf http://localhost:7700/health" 30
  echo ""
else
  info "[3/11] Skipping Docker infrastructure (--skip-infra)"
  info "[4/11] Skipping health checks (--skip-infra)"
  echo ""
fi

# ---------------------------------------------------------------------------
# Phase 5: Generate .env
# ---------------------------------------------------------------------------
info "[5/11] Configuring environment..."

ENV_EXAMPLE="apps/mercato/.env.example"
ENV_FILE="apps/mercato/.env"

if [ -f "$ENV_FILE" ]; then
  warn ".env already exists - skipping (delete it to regenerate)"
else
  if [ ! -f "$ENV_EXAMPLE" ]; then
    fail "$ENV_EXAMPLE not found. Are you in the project root?"
  fi

  cp "$ENV_EXAMPLE" "$ENV_FILE"

  # Patch for localhost (native dev, not container networking)
  sedi 's|^# REDIS_URL=redis://localhost:6379|REDIS_URL=redis://localhost:6379|' "$ENV_FILE"
  sedi 's|^# EVENTS_REDIS_URL=redis://localhost:6379|EVENTS_REDIS_URL=redis://localhost:6379|' "$ENV_FILE"
  sedi 's|^# MEILISEARCH_HOST=http://localhost:7700|MEILISEARCH_HOST=http://localhost:7700|' "$ENV_FILE"
  sedi 's|^# MEILISEARCH_API_KEY=your_master_key_here|MEILISEARCH_API_KEY=meilisearch-dev-key|' "$ENV_FILE"

  # Clear placeholder API keys (user will set their own)
  sedi 's|^OPENAI_API_KEY=your_openai_api_key_here|OPENAI_API_KEY=|' "$ENV_FILE"
  sedi 's|^ANTHROPIC_API_KEY=your_anthropic_api_key_here|ANTHROPIC_API_KEY=|' "$ENV_FILE"

  # Redis port (uncomment)
  sedi 's|^#REDIS_PORT=6379|REDIS_PORT=6379|' "$ENV_FILE"

  ok ".env generated with localhost defaults"
fi
echo ""

# ---------------------------------------------------------------------------
# Phase 6: Install dependencies
# ---------------------------------------------------------------------------
info "[6/11] Installing dependencies (yarn install)..."
yarn install
ok "Dependencies installed"
echo ""

# ---------------------------------------------------------------------------
# Phase 7: Build packages (first pass)
# ---------------------------------------------------------------------------
info "[7/11] Building packages (first pass)..."
yarn build:packages
ok "Packages built (pass 1)"
echo ""

# ---------------------------------------------------------------------------
# Phase 8: Run generators
# ---------------------------------------------------------------------------
info "[8/11] Running module generators..."
yarn generate
ok "Generators complete"
echo ""

# ---------------------------------------------------------------------------
# Phase 9: Build packages (second pass)
# ---------------------------------------------------------------------------
info "[9/11] Building packages (second pass - includes generated code)..."
yarn build:packages
ok "Packages built (pass 2)"
echo ""

# ---------------------------------------------------------------------------
# Phase 10: Initialize database
# ---------------------------------------------------------------------------
info "[10/11] Initializing database (migrate + seed)..."

# Check if database already has tables using docker exec (no local psql required)
TABLE_COUNT=$(docker exec mercato-postgres \
  psql -U postgres -d open-mercato -tAc \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'" 2>/dev/null || echo "0")
# Trim whitespace from psql output
TABLE_COUNT=$(echo "$TABLE_COUNT" | tr -d '[:space:]')

if [ "$TABLE_COUNT" -gt "0" ] 2>/dev/null; then
  info "  Existing database detected ($TABLE_COUNT tables) - running migrations..."
  (cd apps/mercato && yarn db:migrate)
  ok "Migrations applied"
else
  info "  Fresh database - running full initialization..."
  yarn initialize
  ok "Database initialized (migrated + seeded)"
fi
echo ""

# ---------------------------------------------------------------------------
# Phase 11: Done
# ---------------------------------------------------------------------------
info "[11/11] Setup complete!"
echo ""
echo "============================================"
echo "  Next steps:"
echo ""
echo "  Start dev server:  yarn dev"
echo "  App URL:           http://localhost:3000 (or :3001 if 3000 is busy)"
echo "  Admin panel:       http://localhost:3000/backend"
echo ""
echo "  Default admin credentials are in the seed output above."
echo ""
echo "  Optional .env tweaks:"
echo "    - Set OPENAI_API_KEY for vector search"
echo "    - Set ANTHROPIC_API_KEY for AI assistant"
echo "    - Set RESEND_API_KEY for email"
echo "============================================"
