/**
 * Public consumer surface for project-local escalation transports.
 *
 * The registry implementation remains private to the fullstack runtime. A
 * consumer receives an opaque core RegistryRegistrationToken from an
 * activation-scoped transaction and may use it only to register its own
 * transport. Adapter construction is deliberately separate and exposes only
 * the validated factory path; dispatcher, queue, bridge, and raw registry
 * helpers are not part of this package subpath.
 */
export {
	createEscalationAdapter,
	registerEscalationAdapter,
} from "./registry.js";

export type {
	EscalationAdapterCapabilities,
	EscalationAdapterFactory,
	EscalationConfig,
} from "./registry.js";
