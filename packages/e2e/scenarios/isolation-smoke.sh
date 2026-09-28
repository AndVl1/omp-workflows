#!/bin/sh
set -eu

config=${1:-packages/e2e/scenarios/isolated-smoke.env.json}
run_id=${2:-isolated-smoke-$(date +%s)}
root=${OMP_E2E_ROOT:-${TMPDIR:-/tmp}/omp-workflows-e2e}
manifest="$root/runs/$run_id/manifest.json"

npm run e2e:prepare -- --config "$config" --run "$run_id" --json
npm run e2e:doctor -- --manifest "$manifest" --json
npm run e2e:verify -- --manifest "$manifest" --suite isolation --json
