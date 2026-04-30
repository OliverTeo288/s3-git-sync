#!/usr/bin/env bash
# Run the full Docker test suite:
#   1. Build image → type-check + unit tests on Linux (inside Dockerfile)
#   2. Start LocalStack
#   3. Run integration tests against LocalStack
#
# Usage:
#   bash scripts/test-docker.sh          # run everything
#   bash scripts/test-docker.sh --no-rm  # keep containers after run (for debugging)

set -euo pipefail

COMPOSE="docker compose -f docker-compose.yml"
KEEP=${1:-""}

print_step() { echo ""; echo "━━━ $* ━━━"; }

cleanup() {
  if [[ "$KEEP" == "--no-rm" ]]; then
    print_step "Containers kept (--no-rm). Run 'docker compose down -v' to clean up."
  else
    print_step "Cleaning up containers and volumes"
    $COMPOSE down -v --remove-orphans 2>/dev/null || true
  fi
}
trap cleanup EXIT

# ── Preflight ────────────────────────────────────────────────────────────────

if ! command -v docker &>/dev/null; then
  echo "Error: docker is not installed or not in PATH." >&2
  exit 1
fi

if ! docker info &>/dev/null; then
  echo "Error: Docker daemon is not running." >&2
  exit 1
fi

print_step "S3 Git Sync — Docker test suite"
echo ""
echo "  Stage 1 (build)   Type-check + unit tests on Linux (Node 25 Alpine)"
echo "  Stage 2 (runtime) 17 integration tests (8 S3 ops + 9 sync scenarios) against LocalStack"
echo ""
echo "  LocalStack image : localstack/localstack:3"
echo "  Endpoint         : http://localhost:4566"
echo ""

# ── Stage 1: build image (runs tsc + unit tests inside Dockerfile) ───────────

print_step "Stage 1 — Building test image (Linux build + unit tests)"
$COMPOSE build test-runner
echo "  ✓ TypeScript compiled on Linux"
echo "  ✓ Unit tests passed on Linux"
echo "  ✓ esbuild bundle verified"

# ── Stage 2: start LocalStack + run integration tests ────────────────────────

print_step "Stage 2 — Starting LocalStack and running integration tests"
$COMPOSE up \
  --abort-on-container-exit \
  --exit-code-from test-runner \
  --no-build

EXIT_CODE=$?

if [[ $EXIT_CODE -eq 0 ]]; then
  print_step "All tests passed"
  echo ""
  echo "  Coverage:"
  echo "  ✓ Linux build (Node 25 Alpine)"
  echo "  ✓ TypeScript type-check on Linux"
  echo "  ✓ 75 unit tests on Linux"
  echo "  ✓ 17 S3 integration tests (LocalStack): 8 client ops + 9 sync scenarios"
  echo "  ✓ S3 client operations (put / get / delete / list / prefix)"
  echo "  ✓ Full sync cycle (local_new / remote_new / modified / deleted / conflict)"
  echo "  ✓ Conflict backup copies"
  echo "  ✓ Ignore patterns"
  echo "  ✓ Multi-vault prefix isolation"
  echo ""
  echo "  Platforms not covered by Docker (require manual testing):"
  echo "  • Windows  — core JS logic is platform-agnostic; only child_process"
  echo "               spawn(\\"cmd\\") is Windows-specific (already branched)"
  echo "  • Android  — use BRAT to install and test static credentials + sync"
  echo "  • iOS      — use BRAT to install and test static credentials + sync"
else
  print_step "Tests FAILED (exit code $EXIT_CODE)"
  echo "Run with --no-rm to inspect container logs:"
  echo "  bash scripts/test-docker.sh --no-rm"
  echo "  docker compose logs test-runner"
  exit $EXIT_CODE
fi
