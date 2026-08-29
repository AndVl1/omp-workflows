/**
 * Runtime-config was the v1 seed/fallback authority.
 *
 * Workflow-v2 policy and binding writes are management-only and live in
 * `workflow-v2/policy.ts` and `workflow-v2/binding.ts`. This module remains
 * intentionally empty so no runtime/session caller can write or resolve an
 * authoritative configuration through a legacy path.
 */
/* <!-- omp-cto-slice run=01a03ee4-7dd6-7580-8ad7-16d26dc886ba slice=workflow-v2-core --> */
export {};
