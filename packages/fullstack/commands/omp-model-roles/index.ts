/**
 * Explicit legacy disk-discovery compatibility asset.
 *
 * Supported OMP hosts use the extension-registered command from `src/model-roles.ts`.
 * This file remains only for callers that intentionally copy command assets into
 * a project-local `.omp/commands` directory after installation.
 */
export { default } from "@andvl1/omp-workflows-fullstack/model-roles";
export * from "@andvl1/omp-workflows-fullstack/model-roles";
