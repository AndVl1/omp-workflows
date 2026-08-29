/**
 * /session-report — one unified surface for the session-state report.
 *
 * Renders ONE selected or latest do-work/CTO session as a self-contained
 * offline HTML report (single file, inline CSS/JS/data, no network):
 *
 *   /session-report [do-work|cto] [id=<slug|runId>] [--full]
 *
 * The command is a thin orchestration shell over the core report API.  It
 * accepts only host-issued inventory admission and descriptor-relative
 * storage capabilities; cwd, descriptor-valid arrays and callback assertions
 * are never treated as authority.
 */

import type { CustomCommand, CustomCommandAPI } from "@oh-my-pi/pi-coding-agent/extensibility/custom-commands/types";
import type { HookCommandContext } from "@oh-my-pi/pi-coding-agent/extensibility/hooks/types";
import {
  buildSessionReport,
  createReportStorageAuthority,
  isCanonicalRoot,
  renderReportHtml,
  validateProjectIdentity,
  validateWorkflowRunIdentity,
  writeReport,
} from "@andvl1/omp-workflows-core";
import type {
  BuildSessionReportOptions,
  CanonicalRoot,
  ProjectIdentity,
  ReportStorageAuthority,
  SessionReport,
  SessionSelector,
  WorkflowRunIdentity,
} from "@andvl1/omp-workflows-core";
import {
  isFullstackStorageAuthority,
  validateFullstackInventoryAdmission,
  type FullstackInventoryAdmissionContext,
  type FullstackStorageAuthority,
} from "@andvl1/omp-workflows-fullstack";

type SessionReportAssemblyOptions = Parameters<typeof buildSessionReport>[2];

/** Canonical host-issued admission; validation is owned by agent-mapping's WeakMap ledger. */
type SessionReportInventoryAdmission = FullstackInventoryAdmissionContext;

type SessionReportCommandContext = HookCommandContext & {
  readonly policySnapshot?: SessionReportAssemblyOptions["policySnapshot"] | null;
  readonly effectivePolicy?: SessionReportAssemblyOptions["effectivePolicy"] | null;
  readonly catalog?: SessionReportAssemblyOptions["catalog"] | null;
  readonly project_identity?: SessionReportAssemblyOptions["project_identity"] | null;
  readonly run_identity?: WorkflowRunIdentity | null;
  readonly inventory_admission?: SessionReportInventoryAdmission | null;
  readonly storage_authority?: FullstackStorageAuthority | null;
};


export interface ParsedSessionReportArgs {
  selector: SessionSelector;
  options: BuildSessionReportOptions;
  error?: string;
}

/** Parse `/session-report [do-work|cto] [id=<slug|runId>] [--full]`. */
export function parseSessionReportArgs(args: string[]): ParsedSessionReportArgs {
  const selector: SessionSelector = {};
  const options: BuildSessionReportOptions = {};
  for (const token of args) {
    if (token.trim() === "") continue;
    if (token === "--full") {
      options.includeFullArtifacts = true;
      continue;
    }
    if (token === "do-work" || token === "cto") {
      if (selector.kind !== undefined) {
        return { selector, options, error: `duplicate session kind: ${token}` };
      }
      selector.kind = token;
      continue;
    }
    const idMatch = /^id=(.*)$/.exec(token);
    if (idMatch) {
      const id = idMatch[1]!.trim();
      if (!id) return { selector, options, error: "empty id= value" };
      if (selector.id !== undefined) {
        return { selector, options, error: `duplicate id: ${token}` };
      }
      selector.id = id;
      continue;
    }
    return { selector, options, error: `unknown argument: ${token}` };
  }
  return { selector, options };
}

const USAGE = [
  "Usage: /session-report [do-work|cto] [id=<slug|runId>] [--full]",
  "",
  "  (bare)      auto-detect the latest do-work or CTO session",
  "  do-work     latest do-work session (or id=<feature slug>)",
  "  cto         latest CTO run (or id=<run id>)",
  "  id=<...>    pick a specific session id",
  "  --full      embed sanitized full artifact content (default: summaries)",
  "",
  "Writes a self-contained offline HTML report under .work-state.",
].join("\n");

/** Choose the per-feature or per-CTO `.work-state` report path. */
export function sessionReportTargetPath(report: SessionReport): string {
  if (report.kind === "cto") return `.work-state/cto/${report.source.id}/report.html`;
  if (report.source.isLegacy) return `.work-state/report.html`;
  return `.work-state/features/${report.source.id}/report.html`;
}

/** Concise status line returned to the main agent after a successful write. */
export function formatSessionReportStatus(report: SessionReport, targetPath: string): string {
  const warnings = report.warnings.length;
  const lines = [
    `Session report written: ${targetPath}`,
    `${report.meta.title} (${report.kind} · ${report.source.id})`,
    `${report.stages.length} stages · ${report.artifacts.length} artifacts · ${report.chronology.length} chronology entries${warnings ? ` · ${warnings} warning(s)` : ""}`,
    "Open the file in a browser to view the report.",
  ];
  return lines.join("\n");
}

function sameProject(left: ProjectIdentity, right: ProjectIdentity): boolean {
  return left.root_instance_id === right.root_instance_id
    && left.provider_id === right.provider_id
    && left.descriptor_fingerprint === right.descriptor_fingerprint
    && left.executable_provenance.build_fingerprint === right.executable_provenance.build_fingerprint
    && left.executable_provenance.runtime_fingerprint === right.executable_provenance.runtime_fingerprint
    && left.catalog_content_digest === right.catalog_content_digest
    && left.config_byte_sha256 === right.config_byte_sha256
    && left.config_semantic_sha256 === right.config_semantic_sha256
    && left.session.session_id === right.session.session_id
    && left.session.lifecycle_id === right.session.lifecycle_id;
}

function sameRun(left: WorkflowRunIdentity, right: WorkflowRunIdentity): boolean {
  return sameProject(left, right)
    && left.run_id === right.run_id
    && left.profile_identity.id === right.profile_identity.id
    && left.profile_identity.fingerprint === right.profile_identity.fingerprint;
}


type AdmissionFailureCode = "CAPABILITY_MISSING" | "IDENTITY_MISMATCH" | "MIGRATION_REQUIRED";

type AdmissionCheck =
  | {
    readonly ok: true;
    readonly project: ProjectIdentity;
    readonly run: WorkflowRunIdentity;
    readonly inventory: FullstackInventoryAdmissionContext["agent_inventory"];
    readonly canonical_root: CanonicalRoot;
  }
  | { readonly ok: false; readonly code: AdmissionFailureCode; readonly message: string };

type StorageAdmissionCheck =
  | { readonly ok: true; readonly report_storage: ReportStorageAuthority }
  | { readonly ok: false; readonly code: AdmissionFailureCode; readonly message: string };

function admissionFailure(code: AdmissionFailureCode, message: string): AdmissionCheck {
  return { ok: false, code, message };
}

function validateInventoryAdmission(
  value: SessionReportInventoryAdmission | null | undefined,
  expectedProject: ProjectIdentity,
  expectedRun: WorkflowRunIdentity,
): AdmissionCheck {
  const result = validateFullstackInventoryAdmission(value ?? undefined, expectedProject, expectedRun);
  if (!result.ok) {
    const diagnostic = result.diagnostics[0];
    const code: AdmissionFailureCode = diagnostic?.code === "IDENTITY_MISMATCH"
      ? "IDENTITY_MISMATCH"
      : diagnostic?.code === "MIGRATION_REQUIRED"
        ? "MIGRATION_REQUIRED"
        : "CAPABILITY_MISSING";
    return admissionFailure(code, diagnostic?.remediation ?? "session-report inventory admission is unavailable.");
  }
  return {
    ok: true,
    project: result.value.project_identity,
    run: result.value.run_identity,
    inventory: result.value.agent_inventory,
    canonical_root: result.value.authority_context.canonical_root,
  };
}

function validateStorageAuthority(
  value: FullstackStorageAuthority | null | undefined,
  expectedRoot: CanonicalRoot,
  expectedRun: WorkflowRunIdentity,
): StorageAdmissionCheck {
  if (!value || !isFullstackStorageAuthority(value)) {
    return { ok: false, code: "MIGRATION_REQUIRED", message: "session-report requires the host-issued descriptor-relative storage authority." };
  }
  if (!isCanonicalRoot(value.project_root) || value.project_root !== expectedRoot) {
    return { ok: false, code: "IDENTITY_MISMATCH", message: "session-report storage authority belongs to another canonical project root." };
  }
  const run = validateWorkflowRunIdentity(value.run_identity);
  if (!run.ok || !sameRun(run.value, expectedRun)) {
    return { ok: false, code: "IDENTITY_MISMATCH", message: "session-report storage authority belongs to another workflow run." };
  }
  try {
    const report_storage = createReportStorageAuthority({
      readBounded: value.readBounded.bind(value),
      readTextBounded: value.readTextBounded.bind(value),
      listBounded: value.listBounded.bind(value),
      statBounded: value.statBounded.bind(value),
      writeExclusive: value.writeExclusive.bind(value),
      writeAtomic: value.writeAtomic.bind(value),
    });
    return { ok: true, report_storage };
  } catch {
    return { ok: false, code: "MIGRATION_REQUIRED", message: "session-report storage authority does not expose the complete bounded report storage contract." };
  }
}

function commandError(check: AdmissionCheck | StorageAdmissionCheck): string {
  if (check.ok) return "";
  return `ERROR: ${check.code} — ${check.message}`;
}

const factory = (_api: CustomCommandAPI): CustomCommand => ({
  name: "session-report",
  description:
    "Render one selected or latest do-work/CTO session as a self-contained offline HTML report. /session-report [do-work|cto] [id=<slug|runId>] [--full]",
  async execute(args: string[], ctx: HookCommandContext): Promise<string> {
    const commandContext: SessionReportCommandContext = ctx;

    const policySnapshot = commandContext.policySnapshot;
    const effectivePolicy = commandContext.effectivePolicy;
    const catalog = commandContext.catalog;
    const projectIdentity = commandContext.project_identity;
    const runIdentity = commandContext.run_identity;
    if (
      policySnapshot === undefined
      || policySnapshot === null
      || effectivePolicy === undefined
      || effectivePolicy === null
      || catalog === undefined
      || catalog === null
      || projectIdentity === undefined
      || projectIdentity === null
      || runIdentity === undefined
      || runIdentity === null
    ) {
      return "ERROR: CAPABILITY_MISSING — session-report requires the admitted provider policy, catalog, project identity and workflow run identity.";
    }
    const project = validateProjectIdentity(projectIdentity);
    const run = validateWorkflowRunIdentity(runIdentity);
    if (!project.ok || !run.ok || !sameProject(project.ok ? project.value : projectIdentity, run.ok ? run.value : runIdentity)) {
      return "ERROR: IDENTITY_MISMATCH — session-report requires one complete project/run identity.";
    }
    const admission = validateInventoryAdmission(commandContext.inventory_admission, project.value, run.value);
    if (!admission.ok) return commandError(admission);
    const storageAdmission = validateStorageAuthority(
      commandContext.storage_authority,
      admission.canonical_root,
      run.value,
    );
    if (!storageAdmission.ok) return commandError(storageAdmission);
    const parsed = parseSessionReportArgs(args);
    if (parsed.error) return `ERROR: ${parsed.error}\n\n${USAGE}`;

    let report: SessionReport;
    try {
      const reportOptions: SessionReportAssemblyOptions = {
        ...parsed.options,
        policySnapshot,
        effectivePolicy,
        catalog,
        project_identity: project.value,
        agentInventory: admission.inventory.agents,
      };
      report = buildSessionReport(storageAdmission.report_storage, parsed.selector, reportOptions);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return `ERROR: could not build session report: ${message}\n\n${USAGE}`;
    }
    if (report.kind === "cto" && report.source.id !== run.value.run_id) {
      return "ERROR: IDENTITY_MISMATCH — the selected CTO report is not bound to the admitted workflow run.";
    }

    const target = sessionReportTargetPath(report);
    let relativePath: string;
    try {
      relativePath = writeReport(storageAdmission.report_storage, target, renderReportHtml(report));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return `ERROR: could not write report: ${message}`;
    }

    ctx.ui?.notify?.(`session-report: ${report.meta.title} → ${target}`, "info");
    return formatSessionReportStatus(report, relativePath);
  },
});

export default factory;
