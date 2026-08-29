/**
 * @andvl1/omp-workflows-internal — private protocol-v2 provider bundle.
 *
 * This entrypoint owns only the non-canonical `/omp-workflow-team`
 * diagnostic command. Provider publication is an explicit launcher operation:
 * the launcher supplies the host-issued activation capability and provider
 * registry to `ensureProviderPublication`. The extension never infers a cwd,
 * accepts a runtime factory, claims host capabilities, registers canonical
 * commands or tools, writes policy, or chooses a workflow profile.
 */

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

import {
	ensureProviderPublication,
	type InternalProviderActivationOptions,
	type InternalProviderActivationOutcome,
} from "./provider.js";
import { OMP_INTERNAL_ACTIVATION_MARKER } from "./identity.js";

const COMMAND_NAME = "omp-workflow-team";

export type {
	InternalProviderActivationCapability,
	InternalProviderActivationOptions,
	InternalProviderActivationOutcome,
} from "./provider.js";
export {
	INTERNAL_PROVIDER_CATALOG,
	INTERNAL_PROVIDER_DESCRIPTOR,
	INTERNAL_PROVIDER_DESCRIPTOR_FINGERPRINT,
	INTERNAL_PROVIDER_ID,
	lookupInternalProvider,
	ensureProviderPublication,
} from "./provider.js";

function formatPublicationOutcome(outcome: InternalProviderActivationOutcome | undefined): string {
	if (!outcome) {
		return [
			`[${COMMAND_NAME}] provider publication deferred`,
			`marker: ${OMP_INTERNAL_ACTIVATION_MARKER}`,
			"code: launcher_prerequisites_missing",
			"error: explicit launcher activation options were not supplied",
			"Canonical commands and tools remain owned by the core v2 host.",
		].join("\n");
	}
	if (outcome.ok) {
		return [
			`[${COMMAND_NAME}] provider publication: OK`,
			`provider_id: ${outcome.value.provider_id}`,
			`descriptor_fingerprint: ${outcome.value.descriptor_fingerprint}`,
			`catalog_content_digest: ${outcome.value.catalog.content_digest}`,
			"runtime: lazy (factory not invoked during publication)",
			"canonical commands/tools: core v2 host only",
		].join("\n");
	}
	return [
		`[${COMMAND_NAME}] provider publication failed`,
		`code: ${outcome.code}`,
		...(!("missing" in outcome) ? [] : ["missing:", ...outcome.missing.map((field) => `  - ${field}`)]),
		...outcome.diagnostics.map((diagnostic) => `diagnostic: ${diagnostic.code} (${diagnostic.operation})`),
		"Canonical commands and tools remain owned by the core v2 host.",
	].join("\n");
}

/**
 * Install the diagnostic command only. Supplying explicit activation options
 * performs marker/admission-gated provider publication but still does not
 * install a host or invoke the runtime factory.
 */
export default function ompWorkflowsInternal(
	pi: ExtensionAPI,
	options?: InternalProviderActivationOptions,
): void {
	const outcome = options === undefined ? undefined : ensureProviderPublication(options);
	pi.registerCommand(COMMAND_NAME, {
		description: `Private protocol-v2 provider diagnostics (${OMP_INTERNAL_ACTIVATION_MARKER}).`,
		handler: async (args) => {
			const trimmed = args.trim();
			if (trimmed === "validate" || trimmed.length === 0) {
				pi.sendUserMessage(formatPublicationOutcome(outcome));
				return;
			}
			pi.sendUserMessage(
				[
					`[${COMMAND_NAME}] Usage: /${COMMAND_NAME} validate`,
					"Provider activation is host-managed and requires an opaque pinned root/marker/admission capability, provider registry and actual OMP inventory reservation.",
				].join("\n"),
			);
		},
	});
}
