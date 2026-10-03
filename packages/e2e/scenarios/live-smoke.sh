#!/bin/sh
set -eu

config=${1:-packages/e2e/scenarios/live-smoke.env.json}
run_id=${2:-live-smoke-$(date +%s)}
root=${OMP_E2E_ROOT:-${TMPDIR:-/tmp}/omp-workflows-e2e}
manifest="$root/runs/$run_id/manifest.json"

npm run e2e:prepare -- --config "$config" --run "$run_id" --json
npm run e2e:doctor -- --manifest "$manifest" --json
npm run e2e:verify -- --manifest "$manifest" --suite live-smoke --json
