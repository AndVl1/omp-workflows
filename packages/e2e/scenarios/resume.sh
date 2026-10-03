#!/bin/sh
set -eu

manifest=${1:?usage: packages/e2e/scenarios/resume.sh PATH_TO_PREPARED_LIVE_MANIFEST}

# The live-smoke verifier submits a concrete workflow task, observes its
# persisted state, closes the first omp session, starts a new omp session, and
# checks the same saved workflow state. It refuses a missing provider/key.
npm run e2e:doctor -- --manifest "$manifest" --json
npm run e2e:verify -- --manifest "$manifest" --suite live-smoke --json
