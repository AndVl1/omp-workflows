import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { requireRegistryContext } from "../registry/owner.js";
import { CtoAuthorityUnavailableError, findActiveCtoRun } from "../commands/cto.js";
import { acknowledgeCtoRunDelivery, markCtoRunDeliveryPending, mintCtoRuntimeRunOrigin, ctoRuntimeRunInitialIdentityDigest, hasValidCtoRuntimeRunOriginPinned, hasCtoRuntimeRunOriginHandoffPinned, hasValidCtoRuntimeStateProofPinned, writeCtoRuntimeStateProof, newCtoState, publishCtoOutboxDelivery, readCtoRunDeliveryActiveCandidatesPinned, readCtoRunDeliveryCompletedCandidatesPinned, readCtoRunDeliveryIndexPage, refreshCtoRunDeliveryIndexAuthorityPinned, readCtoRunDeliveryCompletedIndexPage, readCtoStatePinned, currentOutboxDeliveryStatusPinned, recordCtoOutboxDeliveryObligation, readCtoOutboxDeliveryObligationsPinned, removeCtoOutboxDeliveryObligation, normalizeCtoOutboxDeliveryRoutingBinding, writeCtoState, writeCtoStateLocked, } from "./state.js";
export { readOrCreateRootRuntimeSecret, deriveRuntimeSecretKey } from "../runtime-secret.js";
export { hasValidCtoRuntimeStateProofPinned, readCtoStatePinned } from "./state.js";
import { appendWave } from "./waves.js";
import { withCtoRegistryLock, withCtoRunLock } from "./transaction-lock.js";
import { parseEscalationConfigRaw } from "./channels.js";
import { assessRunHealth } from "./health.js";
import { checkBudget } from "./budget.js";
import { recallDecisions } from "./decisions.js";
import { startWaveScheduler } from "./scheduler.js";
import { PinnedProjectRoot, PinnedRootError } from "../specification/pinned-root.js";
import { canonicalJson } from "../specification/validation.js";
const RUNTIME_CONTEXT_BRAND = Symbol("omp.cto.runtime-access-context");
const SENSITIVE_PROJECTION_KEY = /(?:^|_)(?:answer|body|user|by|raw|token)(?:_|$)/iu;
const MAX_RUNTIME_SESSION_ID_BYTES = 512;
const MAX_RUNTIME_CHANNEL_KIND_BYTES = 128;
const EMPTY_CHANNEL_CONFIGS = Object.freeze([]);
const EMPTY_CHANNEL_KINDS = Object.freeze([]);
const SAFE_ESCALATION_INVALID_REASONS = Object.freeze({
    malformed: "escalation.json is not valid JSON",
    invalid_shape: "escalation config shape is invalid",
    duplicate_id: "channel identifiers are duplicated",
    duplicate_primary: "multiple primary channels are declared",
    invalid_primary_direction: "primary channel direction is invalid",
});
export class CtoRuntimeAccessError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.name = "CtoRuntimeAccessError";
        this.code = code;
    }
}
const runtimeCells = new WeakMap();
const deliveryCapabilities = new WeakMap();
const runtimeAccessProviders = new Set();
/** Internal verifier used by state.ts; the token itself is never exposed by the facade. */
export function isCtoRuntimeDeliveryCapability(value) {
    return typeof value === "object" && value !== null && deliveryCapabilities.has(value);
}
/** Verifies a facade or guarded wrapper derives from a genuine runtime capability. */
function runtimeCellForFacade(value) {
    let current = typeof value === "object" && value !== null ? value : null;
    const seen = new Set();
    while (current && !seen.has(current)) {
        seen.add(current);
        const cell = runtimeCells.get(current);
        if (cell)
            return cell;
        try {
            current = Object.getPrototypeOf(current);
        }
        catch {
            return null;
        }
    }
    return null;
}
/** Validates the private lifecycle/root of a genuine facade or derived wrapper. */
export function assertCtoRuntimeAccessFacadeLive(value, expectedRoot, expectedSessionId) {
    const cell = runtimeCellForFacade(value);
    if (!cell)
        throw new CtoRuntimeAccessError("runtime_access_invalid", "CTO runtime access is not an authenticated facade");
    requireLive(cell);
    if (expectedRoot !== undefined && cell.root.canonical_root !== expectedRoot)
        throw new CtoRuntimeAccessError("runtime_access_invalid", "CTO runtime access project root does not match");
    if (expectedSessionId !== undefined && cell.sessionId !== expectedSessionId)
        throw new CtoRuntimeAccessError("runtime_access_invalid", "CTO runtime access session does not match");
}
export function isCtoRuntimeAccessFacade(value) {
    return runtimeCellForFacade(value) !== null;
}
/** Register a host-owned resolver for genuine runtime access capabilities. */
export function registerCtoRuntimeAccessProvider(provider) {
    if (typeof provider !== "function")
        throw new TypeError("CTO runtime access provider must be a function");
    runtimeAccessProviders.add(provider);
    let active = true;
    return () => {
        if (active) {
            active = false;
            runtimeAccessProviders.delete(provider);
        }
    };
}
/** Resolve exactly one live, same-root runtime capability without accepting model input. */
export function resolveCtoRuntimeAccessForRoot(root, sessionId) {
    if (typeof root !== "string" || root.length === 0 || !ownString(sessionId))
        return null;
    const pinnedRoot = PinnedProjectRoot.open(root);
    if (!pinnedRoot)
        return null;
    try {
        if (!pinnedRoot.isStable())
            return null;
        const canonicalRoot = pinnedRoot.canonical_root;
        const found = new Map();
        for (const provider of runtimeAccessProviders) {
            let candidate = null;
            try {
                candidate = provider(canonicalRoot, sessionId);
            }
            catch {
                continue;
            }
            if (!candidate)
                continue;
            try {
                assertCtoRuntimeAccessFacadeLive(candidate, canonicalRoot, sessionId);
                const cell = runtimeCellForFacade(candidate);
                if (!cell || (sessionId !== undefined && cell.sessionId !== sessionId))
                    continue;
                found.set(cell, candidate);
            }
            catch {
                continue;
            }
        }
        if (found.size !== 1 || !pinnedRoot.isStable())
            return null;
        return [...found.values()][0] ?? null;
    }
    finally {
        pinnedRoot.close();
    }
}
function ownString(value) {
    return typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= MAX_RUNTIME_SESSION_ID_BYTES
        && !/[\u0000\r\n]/u.test(value);
}
function ownRecord(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}
function errorCode(error) {
    if (!error || typeof error !== "object" || !("code" in error))
        return undefined;
    const code = error.code;
    return typeof code === "string" ? code : undefined;
}
function openFailure(code, error) {
    return { ok: false, code, error: error instanceof Error ? error.message : String(error) };
}
function runtimeError(code, message) {
    return new CtoRuntimeAccessError(code, message);
}
function cloneValue(value, redact, seen = new WeakMap()) {
    if (value === null || typeof value !== "object")
        return value;
    const object = value;
    const prior = seen.get(object);
    if (prior !== undefined)
        return prior;
    if (Array.isArray(value)) {
        const result = [];
        seen.set(object, result);
        for (const entry of value)
            result.push(cloneValue(entry, redact, seen));
        return Object.freeze(result);
    }
    const result = Object.create(null);
    seen.set(object, result);
    for (const [key, entry] of Object.entries(value)) {
        if (redact && SENSITIVE_PROJECTION_KEY.test(key))
            continue;
        result[key] = cloneValue(entry, redact, seen);
    }
    return Object.freeze(result);
}
function detachedProjection(value) {
    return cloneValue(value, true);
}
function detachedConfig(value) {
    return cloneValue(value, false);
}
function requireSafeRunId(runId) {
    if (typeof runId !== "string" || !/^[A-Za-z0-9._-]+$/u.test(runId) || runId === "." || runId === ".." || runId.length > 128) {
        throw runtimeError("runtime_access_invalid", "unsafe CTO run id");
    }
}
function requireLive(cell) {
    if (cell.revoked)
        throw runtimeError("activation_revoked", "CTO runtime access has been revoked");
    let current;
    try {
        current = requireRegistryContext(cell.context, cell.snapshot.canonical_root, "workflow_tools");
    }
    catch (error) {
        revoke(cell);
        throw runtimeError("activation_revoked", error instanceof Error ? error.message : String(error));
    }
    if (current.canonical_root !== cell.snapshot.canonical_root
        || current.root_dev !== cell.snapshot.root_dev
        || current.root_ino !== cell.snapshot.root_ino
        || current.owner_fingerprint !== cell.snapshot.owner_fingerprint
        || current.principal_fingerprint !== cell.snapshot.principal_fingerprint
        || current.claim_generation !== cell.snapshot.claim_generation
        || current.marker_generation !== cell.snapshot.marker_generation
        || current.marker_digest !== cell.snapshot.marker_digest) {
        revoke(cell);
        throw runtimeError("activation_revoked", "CTO runtime activation identity changed");
    }
    if (!cell.root.isStable()
        || cell.root.canonical_root !== cell.snapshot.canonical_root
        || cell.root.dev !== cell.snapshot.root_dev
        || cell.root.ino !== cell.snapshot.root_ino) {
        revoke(cell);
        throw runtimeError("activation_revoked", "CTO runtime project root identity changed");
    }
}
function requireTransactionActive(cell, activity) {
    if (!activity.active)
        throw runtimeError("activation_revoked", "CTO run transaction is no longer active");
    requireLive(cell);
}
function revoke(cell) {
    if (cell.revoked) {
        if (cell.access)
            runtimeCells.delete(cell.access);
        return;
    }
    cell.revoked = true;
    if (cell.deliveryCapability)
        deliveryCapabilities.delete(cell.deliveryCapability);
    for (const stop of cell.schedulers) {
        try {
            stop();
        }
        catch { /* scheduler teardown is best effort */ }
    }
    cell.schedulers.clear();
    cell.root.close();
    if (cell.access)
        runtimeCells.delete(cell.access);
}
function candidatesProjection(result) {
    return detachedProjection(result);
}
function authenticatedCandidatesProjection(result, pinnedRoot, sessionId) {
    if (!result.ok)
        return candidatesProjection(result);
    const entries = result.entries.filter((entry) => {
        const state = readCtoStatePinned(entry.run_id, pinnedRoot);
        return !!state && state.id === entry.run_id && (state.standby === true || state.owner_session === sessionId) && hasValidCtoRuntimeRunOriginPinned(pinnedRoot, state) && hasValidCtoRuntimeStateProofPinned(pinnedRoot, state);
    });
    return candidatesProjection({ ...result, entries, active_run_id: result.active_run_id !== null && entries.some((entry) => entry.run_id === result.active_run_id) ? result.active_run_id : null });
}
function authenticatedPageProjection(result, pinnedRoot, sessionId) {
    const entries = result.entries.filter((entry) => {
        const state = readCtoStatePinned(entry.run_id, pinnedRoot);
        return !!state && state.id === entry.run_id && (state.standby === true || state.owner_session === sessionId) && hasValidCtoRuntimeRunOriginPinned(pinnedRoot, state) && hasValidCtoRuntimeStateProofPinned(pinnedRoot, state);
    });
    return pageProjection({ ...result, entries, active_run_id: result.active_run_id !== null && entries.some((entry) => entry.run_id === result.active_run_id) ? result.active_run_id : null });
}
function pageProjection(result) {
    return detachedProjection(result);
}
function readEscalationConfig(root) {
    try {
        const read = root.readFile(".omp/escalation.json", { maxBytes: 256 * 1024 });
        const loaded = parseEscalationConfigRaw(read.bytes);
        const after = root.pathEntryInfo(".omp/escalation.json");
        if (!after || after.kind !== "file"
            || after.dev !== read.dev || after.ino !== read.ino || after.size !== read.size
            || after.mtimeMs !== read.mtimeMs || after.ctimeMs !== read.ctimeMs) {
            throw runtimeError("runtime_access_invalid", "escalation config changed during snapshot");
        }
        return { loaded, bytes: read.bytes };
    }
    catch (error) {
        if (error instanceof PinnedRootError && error.code === "not_found")
            return { loaded: { status: "absent" }, bytes: null };
        if (error instanceof CtoRuntimeAccessError)
            throw error;
        throw runtimeError("runtime_access_invalid", "escalation config could not be read safely");
    }
}
const ABSENT_ESCALATION_CONFIG_DIGEST = createHash("sha256").update("omp-escalation-config:absent", "utf8").digest("hex");
function invalidEscalationConfigError(loaded) {
    const reason = SAFE_ESCALATION_INVALID_REASONS[loaded.code] ?? "escalation config was rejected";
    return runtimeError("runtime_access_invalid", `escalation config invalid (${loaded.code}): ${reason}`);
}
function channelKindNamesFromConfig(document) {
    const kinds = [];
    const seen = new Set();
    const add = (value) => {
        if (!ownString(value) || Buffer.byteLength(value, "utf8") > MAX_RUNTIME_CHANNEL_KIND_BYTES || !/^[A-Za-z0-9._-]+$/u.test(value) || seen.has(value))
            return;
        seen.add(value);
        kinds.push(value);
    };
    if (Array.isArray(document.channels)) {
        for (const entry of document.channels) {
            if (ownRecord(entry))
                add(entry.adapter);
        }
    }
    else {
        add(document.adapter);
    }
    return kinds.length === 0 ? EMPTY_CHANNEL_KINDS : Object.freeze(kinds);
}
const CHANNEL_PROJECTION_SHARED_KEYS = new Set(["adapter", "id", "name", "mode", "direction", "primary", "subscriptions", "fields", "ackTarget", "chatId", "bidirectional"]);
function channelConfigsForNormalizedConfig(document, kind) {
    const ownConfig = (source) => {
        const result = {};
        for (const [key, value] of Object.entries(source)) {
            if (CHANNEL_PROJECTION_SHARED_KEYS.has(key) || key === kind)
                result[key] = value;
        }
        return detachedConfig(result);
    };
    if (Array.isArray(document.channels)) {
        const result = [];
        for (const entry of document.channels) {
            if (ownRecord(entry) && entry.adapter === kind)
                result.push(ownConfig(entry));
        }
        return result.length === 0 ? EMPTY_CHANNEL_CONFIGS : Object.freeze(result);
    }
    if (document.adapter !== kind)
        return EMPTY_CHANNEL_CONFIGS;
    return Object.freeze([ownConfig(document)]);
}
function channelKindNames(root) {
    const receipt = readEscalationConfig(root);
    const loaded = receipt.loaded;
    if (loaded.status === "absent")
        return EMPTY_CHANNEL_KINDS;
    if (loaded.status === "invalid")
        throw invalidEscalationConfigError(loaded);
    return channelKindNamesFromConfig(loaded.config);
}
function channelSnapshot(root) {
    const receipt = readEscalationConfig(root);
    const loaded = receipt.loaded;
    const config_sha256 = receipt.bytes === null
        ? ABSENT_ESCALATION_CONFIG_DIGEST
        : createHash("sha256").update(receipt.bytes).digest("hex");
    if (loaded.status === "absent")
        return Object.freeze({ status: "absent" });
    if (loaded.status === "invalid") {
        const failure = invalidEscalationConfigError(loaded);
        return Object.freeze({ status: "invalid", code: loaded.code, reason: failure.message });
    }
    const kinds = channelKindNamesFromConfig(loaded.config);
    const projections = Object.create(null);
    for (const kind of kinds)
        projections[kind] = channelConfigsForNormalizedConfig(loaded.config, kind);
    return Object.freeze({ status: "valid", config_sha256, kinds, projections: Object.freeze(projections) });
}
function channelConfigsForKind(root, kind) {
    if (!ownString(kind) || Buffer.byteLength(kind, "utf8") > MAX_RUNTIME_CHANNEL_KIND_BYTES || !/^[A-Za-z0-9._-]+$/u.test(kind))
        return EMPTY_CHANNEL_CONFIGS;
    const receipt = readEscalationConfig(root);
    const loaded = receipt.loaded;
    if (loaded.status === "absent")
        return EMPTY_CHANNEL_CONFIGS;
    if (loaded.status === "invalid")
        throw invalidEscalationConfigError(loaded);
    return channelConfigsForNormalizedConfig(loaded.config, kind);
}
function initialStateShapeDigest(state) {
    const copy = structuredClone(state);
    delete copy.state_revision;
    delete copy.updated_at;
    return canonicalJson(copy);
}
function makeFacade(cell) {
    const methods = Object.create(null);
    const requireAuthenticatedState = (runId) => {
        const state = readCtoStatePinned(runId, cell.root);
        if (!state || !hasValidCtoRuntimeRunOriginPinned(cell.root, state) || !hasValidCtoRuntimeStateProofPinned(cell.root, state))
            throw runtimeError("runtime_access_invalid", "CTO run requires state-proof recovery");
        if (state.standby !== true && state.owner_session !== cell.sessionId)
            throw runtimeError("runtime_access_invalid", "CTO run owner session does not match");
        return state;
    };
    Object.defineProperties(methods, {
        findActiveRun: {
            enumerable: false,
            value: () => {
                requireLive(cell);
                const authenticated = refreshCtoRunDeliveryIndexAuthorityPinned(cell.root, cell.deliveryCapability, cell.sessionId);
                if (!authenticated)
                    return null;
                const found = findActiveCtoRun(cell.root.canonical_root, { sessionId: cell.sessionId, pinnedRoot: cell.root });
                if (!found || !refreshCtoRunDeliveryIndexAuthorityPinned(cell.root, cell.deliveryCapability, cell.sessionId))
                    return null;
                const state = detachedProjection(found.state);
                return { runId: found.runId, state };
            },
        },
        readState: {
            enumerable: false,
            value: (runId) => {
                requireLive(cell);
                requireSafeRunId(runId);
                const state = readCtoStatePinned(runId, cell.root);
                if (state === null || !hasValidCtoRuntimeRunOriginPinned(cell.root, state) || !hasValidCtoRuntimeStateProofPinned(cell.root, state) || (state.standby !== true && state.owner_session !== cell.sessionId))
                    return null;
                const projection = detachedProjection(state);
                return projection;
            },
        },
        stateDirectory: {
            enumerable: false,
            value: (runId) => {
                requireLive(cell);
                requireSafeRunId(runId);
                return join(cell.root.canonical_root, ".work-state", "cto", runId);
            },
        },
        assertProjectRoot: {
            enumerable: false,
            value: (projectRoot) => {
                requireLive(cell);
                if (typeof projectRoot !== "string" || projectRoot.trim().length === 0)
                    throw runtimeError("runtime_access_invalid", "project root is required");
                const supplied = PinnedProjectRoot.open(projectRoot);
                if (!supplied)
                    throw runtimeError("runtime_access_invalid", "project root could not be pinned");
                try {
                    if (supplied.canonical_root !== cell.root.canonical_root
                        || supplied.dev !== cell.root.dev
                        || supplied.ino !== cell.root.ino
                        || !supplied.isStable())
                        throw runtimeError("runtime_access_invalid", "project root does not match the authenticated facade root");
                    requireLive(cell);
                }
                finally {
                    supplied.close();
                }
            },
        },
        createRun: {
            enumerable: false,
            value: (state, handoff) => {
                requireLive(cell);
                if (!state || typeof state !== "object" || typeof state.id !== "string" || !handoff || typeof handoff.source_id !== "string" || handoff.source_id.length === 0 || typeof handoff.initial_state_sha256 !== "string" || ctoRuntimeRunInitialIdentityDigest(state) !== handoff.initial_state_sha256 || (state.standby !== true && state.owner_session !== cell.sessionId))
                    throw runtimeError("runtime_access_invalid", "trusted CTO run creation handoff is invalid");
                return withCtoRunLock(cell.root.canonical_root, state.id, () => {
                    requireLive(cell);
                    const existing = readCtoStatePinned(state.id, cell.root);
                    if (existing) {
                        if (ctoRuntimeRunInitialIdentityDigest(existing) !== handoff.initial_state_sha256 || !hasCtoRuntimeRunOriginHandoffPinned(cell.root, existing, cell.sessionId, handoff.source_id, handoff.initial_state_sha256))
                            throw runtimeError("runtime_access_invalid", "CTO run creation conflicts with an existing authenticated origin");
                        if (!hasValidCtoRuntimeStateProofPinned(cell.root, existing) && (existing.state_revision !== 1 || initialStateShapeDigest(existing) !== initialStateShapeDigest(state)))
                            throw runtimeError("runtime_access_invalid", "proofless CTO run state does not match the requested initial image");
                        if (!writeCtoRuntimeStateProof(cell.root, existing) || !hasValidCtoRuntimeStateProofPinned(cell.root, existing))
                            throw runtimeError("runtime_access_invalid", "CTO run state proof recovery failed");
                        if (!refreshCtoRunDeliveryIndexAuthorityPinned(cell.root, cell.deliveryCapability, cell.sessionId))
                            throw runtimeError("runtime_access_invalid", "CTO delivery index proof recovery failed");
                        return existing;
                    }
                    if (!mintCtoRuntimeRunOrigin(cell.root, state, cell.sessionId, handoff.source_id, handoff.initial_state_sha256))
                        throw runtimeError("runtime_access_invalid", "CTO run origin proof could not be committed");
                    writeCtoStateLocked(state, cell.root.canonical_root, { pinnedRoot: cell.root, preCommit: ({ pinnedRoot }) => {
                            requireLive(cell);
                            if (!pinnedRoot.isStable())
                                throw runtimeError("runtime_access_invalid", "project root changed before trusted CTO run creation");
                        } });
                    const created = readCtoStatePinned(state.id, cell.root);
                    if (!created || !hasValidCtoRuntimeRunOriginPinned(cell.root, created) || !writeCtoRuntimeStateProof(cell.root, created) || !hasValidCtoRuntimeStateProofPinned(cell.root, created))
                        throw runtimeError("runtime_access_invalid", "trusted CTO run origin/state proof failed after creation");
                    if (!refreshCtoRunDeliveryIndexAuthorityPinned(cell.root, cell.deliveryCapability, cell.sessionId))
                        throw runtimeError("runtime_access_invalid", "trusted CTO delivery index proof failed after creation");
                    return created;
                }, { pinnedRoot: cell.root });
            },
        },
        ensureStandbyRun: {
            enumerable: false,
            value: () => {
                requireLive(cell);
                try {
                    const authenticated = refreshCtoRunDeliveryIndexAuthorityPinned(cell.root, cell.deliveryCapability, cell.sessionId);
                    const active = authenticated ? findActiveCtoRun(cell.root.canonical_root, { sessionId: cell.sessionId, pinnedRoot: cell.root }) : null;
                    if (active && refreshCtoRunDeliveryIndexAuthorityPinned(cell.root, cell.deliveryCapability, cell.sessionId))
                        return active.runId;
                    return withCtoRegistryLock(cell.root.canonical_root, () => {
                        requireLive(cell);
                        const authenticated = refreshCtoRunDeliveryIndexAuthorityPinned(cell.root, cell.deliveryCapability, cell.sessionId);
                        const current = authenticated ? findActiveCtoRun(cell.root.canonical_root, { sessionId: cell.sessionId, pinnedRoot: cell.root }) : null;
                        if (current && refreshCtoRunDeliveryIndexAuthorityPinned(cell.root, cell.deliveryCapability, cell.sessionId))
                            return current.runId;
                        const runId = `standby-${Date.now()}-${randomUUID().slice(0, 8)}`;
                        const runDirectory = join(".work-state", "cto", runId);
                        const inboxDirectory = join(runDirectory, "inbox");
                        const beforeRun = cell.root.pathEntryInfo(runDirectory);
                        const beforeInbox = cell.root.pathEntryInfo(inboxDirectory);
                        if (beforeRun && beforeRun.kind !== "directory")
                            throw new Error("standby run directory is not a real directory");
                        if (beforeInbox && beforeInbox.kind !== "directory")
                            throw new Error("standby inbox directory is not a real directory");
                        let completed = false;
                        let createdRun = null;
                        let createdInbox = null;
                        try {
                            cell.root.ensureDirectories([runDirectory, inboxDirectory]);
                            if (!cell.root.isStable())
                                throw new Error("standby project root changed after directory creation");
                            const afterRun = cell.root.pathEntryInfo(runDirectory);
                            const afterInbox = cell.root.pathEntryInfo(inboxDirectory);
                            if (!afterRun || afterRun.kind !== "directory" || !afterInbox || afterInbox.kind !== "directory") {
                                throw new Error("standby directory identity changed during creation");
                            }
                            if (!beforeRun)
                                createdRun = { dev: afterRun.dev, ino: afterRun.ino };
                            if (!beforeInbox)
                                createdInbox = { dev: afterInbox.dev, ino: afterInbox.ino };
                            const now = new Date().toISOString();
                            const state = newCtoState({
                                id: runId,
                                task: "standby — awaiting inbox tasks",
                                branch: "",
                                autonomous: true,
                                plan: { id: runId, task: "standby — awaiting inbox tasks", teams: [], created_at: now },
                                standby: true,
                            });
                            state.pause = { kind: "none", reason: "standby" };
                            writeCtoState(state, cell.root.canonical_root, {
                                pinnedRoot: cell.root,
                                preCommit: ({ pinnedRoot }) => {
                                    requireLive(cell);
                                    if (!pinnedRoot.isStable())
                                        throw runtimeError("runtime_access_invalid", "standby project root changed before state CAS");
                                },
                            });
                            if (!mintCtoRuntimeRunOrigin(cell.root, state, cell.sessionId))
                                throw new Error("standby runtime origin proof could not be committed");
                            const createdStandby = readCtoStatePinned(state.id, cell.root);
                            if (!createdStandby || !writeCtoRuntimeStateProof(cell.root, createdStandby))
                                throw new Error("standby runtime state proof could not be committed");
                            if (!refreshCtoRunDeliveryIndexAuthorityPinned(cell.root, cell.deliveryCapability, cell.sessionId))
                                throw new Error("standby delivery index proof could not be committed");
                            if (!cell.root.isStable())
                                throw new Error("standby project root changed after state/index publication");
                            const finalRun = cell.root.pathEntryInfo(runDirectory);
                            const finalInbox = cell.root.pathEntryInfo(inboxDirectory);
                            if (!finalRun || finalRun.kind !== "directory" || !finalInbox || finalInbox.kind !== "directory") {
                                throw new Error("standby path identity changed after state/index publication");
                            }
                            completed = true;
                            return runId;
                        }
                        catch (error) {
                            if (error?.code === "EEXIST") {
                                const authenticated = refreshCtoRunDeliveryIndexAuthorityPinned(cell.root, cell.deliveryCapability, cell.sessionId);
                                const winner = authenticated ? findActiveCtoRun(cell.root.canonical_root, { sessionId: cell.sessionId, pinnedRoot: cell.root }) : null;
                                if (winner && refreshCtoRunDeliveryIndexAuthorityPinned(cell.root, cell.deliveryCapability, cell.sessionId)) {
                                    completed = true;
                                    return winner.runId;
                                }
                            }
                            throw error;
                        }
                        finally {
                            if (!completed && cell.root.isStable()) {
                                if (createdInbox) {
                                    try {
                                        cell.root.removeEmptyDirectoryIfMatches(inboxDirectory, createdInbox);
                                    }
                                    catch { /* preserve evidence for recovery */ }
                                }
                                if (createdRun) {
                                    try {
                                        cell.root.removeEmptyDirectoryIfMatches(runDirectory, createdRun);
                                    }
                                    catch { /* preserve evidence for recovery */ }
                                }
                            }
                        }
                    }, { pinnedRoot: cell.root });
                }
                catch (error) {
                    if (error instanceof CtoAuthorityUnavailableError) {
                        throw runtimeError("runtime_access_invalid", error.message);
                    }
                    if (error instanceof Error && /delivery index|pinned project root|state read/i.test(error.message)) {
                        throw runtimeError("runtime_access_invalid", "canonical CTO delivery authority is unavailable");
                    }
                    if (error instanceof CtoRuntimeAccessError)
                        throw error;
                    let stable = false;
                    try {
                        stable = cell.root.isStable();
                    }
                    catch { /* closed roots are revoked below */ }
                    if (!stable) {
                        revoke(cell);
                        throw runtimeError("activation_revoked", error instanceof Error ? error.message : String(error));
                    }
                    throw runtimeError("runtime_access_invalid", error instanceof Error ? error.message : String(error));
                }
            },
        },
        registerRunOrigin: {
            enumerable: false,
            value: (runId, handoff) => {
                requireLive(cell);
                if (typeof runId !== "string" || runId.length === 0 || !handoff || typeof handoff.source_id !== "string" || handoff.source_id.length === 0 || typeof handoff.initial_state_sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(handoff.initial_state_sha256))
                    return false;
                return withCtoRunLock(cell.root.canonical_root, runId, () => {
                    requireLive(cell);
                    const state = requireAuthenticatedState(runId);
                    if (ctoRuntimeRunInitialIdentityDigest(state) !== handoff.initial_state_sha256)
                        return false;
                    return mintCtoRuntimeRunOrigin(cell.root, state, cell.sessionId, handoff.source_id, handoff.initial_state_sha256);
                }, { pinnedRoot: cell.root });
            },
        },
        readActiveDeliveryCandidates: {
            enumerable: false,
            value: () => {
                requireLive(cell);
                if (!refreshCtoRunDeliveryIndexAuthorityPinned(cell.root, cell.deliveryCapability, cell.sessionId))
                    return { ok: true, active_run_id: null, entries: [] };
                return authenticatedCandidatesProjection(readCtoRunDeliveryActiveCandidatesPinned(cell.root), cell.root, cell.sessionId);
            },
        },
        readCompletedDeliveryCandidates: {
            enumerable: false,
            value: () => {
                requireLive(cell);
                return authenticatedCandidatesProjection(readCtoRunDeliveryCompletedCandidatesPinned(cell.root), cell.root, cell.sessionId);
            },
        },
        readDeliveryIndexPage: {
            enumerable: false,
            value: (options = {}) => {
                requireLive(cell);
                if (!ownRecord(pageOptions))
                    throw runtimeError("runtime_access_invalid", "delivery index options must be a plain object");
                const copy = {};
                if (options.after_run_id !== undefined) {
                    if (typeof options.after_run_id !== "string")
                        throw runtimeError("runtime_access_invalid", "delivery cursor is invalid");
                    copy.after_run_id = options.after_run_id;
                }
                if (options.startAfter !== undefined) {
                    if (typeof options.startAfter !== "string")
                        throw runtimeError("runtime_access_invalid", "delivery cursor is invalid");
                    copy.startAfter = options.startAfter;
                }
                if (options.limit !== undefined) {
                    if (!Number.isSafeInteger(options.limit) || options.limit <= 0)
                        throw runtimeError("runtime_access_invalid", "delivery page limit is invalid");
                    copy.limit = options.limit;
                }
                return authenticatedPageProjection(readCtoRunDeliveryIndexPage(cell.root.canonical_root, copy, cell.root), cell.root, cell.sessionId);
            },
        },
        readCompletedDeliveryIndexPage: {
            enumerable: false,
            value: (options = {}) => {
                requireLive(cell);
                try {
                    if (!ownRecord(pageOptions))
                        throw runtimeError("runtime_access_invalid", "completed delivery page options must be a plain object");
                    const optionKeys = Object.keys(options);
                    if (optionKeys.some((key) => key !== "after_run_id" && key !== "limit"))
                        throw runtimeError("runtime_access_invalid", "completed delivery page options are invalid");
                    const copy = {};
                    if (options.after_run_id !== undefined) {
                        if (typeof options.after_run_id !== "string")
                            throw runtimeError("runtime_access_invalid", "completed delivery cursor is invalid");
                        requireSafeRunId(options.after_run_id);
                        copy.after_run_id = options.after_run_id;
                    }
                    if (options.limit !== undefined) {
                        if (!Number.isSafeInteger(options.limit) || options.limit <= 0)
                            throw runtimeError("runtime_access_invalid", "completed delivery page limit is invalid");
                        copy.limit = options.limit;
                    }
                    return authenticatedPageProjection(readCtoRunDeliveryCompletedIndexPage(cell.root.canonical_root, copy, cell.root), cell.root, cell.sessionId);
                }
                finally {
                    requireLive(cell);
                }
            },
        },
        markDeliveryPending: {
            enumerable: false,
            value: (runId, stateRevision, kind = "outbox") => {
                requireLive(cell);
                requireSafeRunId(runId);
                if (kind !== "outbox" && kind !== "summary" && kind !== "retry")
                    throw runtimeError("runtime_access_invalid", "delivery kind is invalid");
                if (stateRevision !== undefined && (!Number.isSafeInteger(stateRevision) || stateRevision < 0))
                    throw runtimeError("runtime_access_invalid", "delivery state revision is invalid");
                requireAuthenticatedState(runId);
                const marked = markCtoRunDeliveryPending(cell.root.canonical_root, runId, stateRevision, kind, cell.root, cell.deliveryCapability);
                if (marked && !refreshCtoRunDeliveryIndexAuthorityPinned(cell.root, cell.deliveryCapability, cell.sessionId))
                    throw runtimeError("runtime_access_invalid", "CTO delivery index proof could not be refreshed");
                return marked;
            },
        },
        publishOutboxDelivery: {
            enumerable: false,
            value: (input) => {
                requireLive(cell);
                if (!ownRecord(input))
                    throw runtimeError("runtime_access_invalid", "outbox delivery input must be a plain object");
                const runId = input.run_id;
                if (typeof runId !== "string")
                    throw runtimeError("runtime_access_invalid", "outbox delivery run id is invalid");
                requireSafeRunId(runId);
                if (!Number.isSafeInteger(input.state_revision) || input.state_revision < 0 || typeof input.entry_name !== "string") {
                    throw runtimeError("runtime_access_invalid", "outbox delivery metadata is invalid");
                }
                if (input.legacy_entry_name !== undefined && typeof input.legacy_entry_name !== "string")
                    throw runtimeError("runtime_access_invalid", "legacy delivery name is invalid");
                const json = typeof input.json === "string"
                    ? input.json
                    : input.json instanceof Uint8Array ? new Uint8Array(input.json) : null;
                if (json === null)
                    throw runtimeError("runtime_access_invalid", "outbox delivery JSON is invalid");
                const routingBinding = input.routing_binding === undefined ? undefined : normalizeCtoOutboxDeliveryRoutingBinding(input.routing_binding);
                if (input.routing_binding !== undefined && !routingBinding)
                    throw runtimeError("runtime_access_invalid", "outbox delivery routing binding is invalid");
                requireAuthenticatedState(runId);
                const copy = {
                    run_id: runId,
                    state_revision: input.state_revision,
                    entry_name: input.entry_name,
                    ...(input.legacy_entry_name === undefined ? {} : { legacy_entry_name: input.legacy_entry_name }),
                    json,
                    ...(routingBinding === undefined ? {} : { routing_binding: routingBinding }),
                };
                const published = publishCtoOutboxDelivery(cell.root.canonical_root, copy, cell.root, cell.deliveryCapability);
                if (published && !refreshCtoRunDeliveryIndexAuthorityPinned(cell.root, cell.deliveryCapability, cell.sessionId))
                    throw runtimeError("runtime_access_invalid", "CTO delivery index proof could not be refreshed");
                return published;
            },
        },
        recordOutboxDeliveryObligation: {
            enumerable: false,
            value: (input) => {
                requireLive(cell);
                if (!ownRecord(input) || Object.keys(input).some((key) => key !== "run_id" && key !== "entry_name" && key !== "json" && key !== "routing_binding") || typeof input.run_id !== "string" || typeof input.entry_name !== "string")
                    throw runtimeError("runtime_access_invalid", "delivery obligation input is invalid");
                const json = typeof input.json === "string" ? input.json : input.json instanceof Uint8Array ? new Uint8Array(input.json) : null;
                if (json === null)
                    throw runtimeError("runtime_access_invalid", "delivery obligation envelope is invalid");
                requireSafeRunId(input.run_id);
                requireAuthenticatedState(input.run_id);
                const routingBinding = input.routing_binding === undefined ? undefined : normalizeCtoOutboxDeliveryRoutingBinding(input.routing_binding);
                if (input.routing_binding !== undefined && !routingBinding)
                    throw runtimeError("runtime_access_invalid", "delivery obligation routing binding is invalid");
                const result = recordCtoOutboxDeliveryObligation(cell.root.canonical_root, { run_id: input.run_id, entry_name: input.entry_name, json, ...(routingBinding === undefined ? {} : { routing_binding: routingBinding }) }, cell.root, cell.deliveryCapability);
                requireLive(cell);
                if (result && !refreshCtoRunDeliveryIndexAuthorityPinned(cell.root, cell.deliveryCapability, cell.sessionId))
                    throw runtimeError("runtime_access_invalid", "CTO delivery index proof could not be refreshed");
                return result;
            },
        },
        readOutboxDeliveryObligations: {
            enumerable: false,
            value: (runId) => {
                requireLive(cell);
                requireSafeRunId(runId);
                requireAuthenticatedState(runId);
                return readCtoOutboxDeliveryObligationsPinned(cell.root.canonical_root, runId, cell.root);
            },
        },
        removeOutboxDeliveryObligation: {
            enumerable: false,
            value: (runId, entryName, envelopeId) => {
                requireLive(cell);
                requireSafeRunId(runId);
                requireAuthenticatedState(runId);
                const removed = removeCtoOutboxDeliveryObligation(cell.root.canonical_root, runId, entryName, envelopeId, cell.root, cell.deliveryCapability);
                requireLive(cell);
                if (removed && !refreshCtoRunDeliveryIndexAuthorityPinned(cell.root, cell.deliveryCapability, cell.sessionId))
                    throw runtimeError("runtime_access_invalid", "CTO delivery index proof could not be refreshed");
                return removed;
            },
        },
        acknowledgeDelivery: {
            enumerable: false,
            value: (runId, expectedRevision, options = { drained: true }) => {
                requireLive(cell);
                requireSafeRunId(runId);
                if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || !ownRecord(options) || options.drained !== true)
                    throw runtimeError("runtime_access_invalid", "delivery acknowledgement is invalid");
                requireAuthenticatedState(runId);
                const acknowledged = acknowledgeCtoRunDelivery(cell.root.canonical_root, runId, expectedRevision, { drained: true }, cell.root, cell.deliveryCapability);
                if (acknowledged && !refreshCtoRunDeliveryIndexAuthorityPinned(cell.root, cell.deliveryCapability, cell.sessionId))
                    throw runtimeError("runtime_access_invalid", "CTO delivery index proof could not be refreshed");
                return acknowledged;
            },
        },
        currentOutboxDeliveryStatus: {
            enumerable: false,
            value: (input) => {
                requireLive(cell);
                try {
                    if (!ownRecord(input))
                        return "invalid";
                    const keys = Object.keys(input).sort().join("\u0000");
                    const hasStorageEntryName = Object.hasOwn(input, "storage_entry_name");
                    const hasRoutingBinding = Object.hasOwn(input, "routing_binding");
                    const expectedKeys = [
                        "entry_name", "json", "lane", "run_id", "state_revision",
                        ...(hasStorageEntryName ? ["storage_entry_name"] : []),
                        ...(hasRoutingBinding ? ["routing_binding"] : []),
                    ];
                    if (keys !== expectedKeys.sort().join("\u0000"))
                        return "invalid";
                    const readData = (key) => {
                        const descriptor = Object.getOwnPropertyDescriptor(input, key);
                        return descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined;
                    };
                    const runId = readData("run_id");
                    const stateRevision = readData("state_revision");
                    const entryName = readData("entry_name");
                    const storageEntryName = readData("storage_entry_name");
                    const lane = readData("lane");
                    const json = readData("json");
                    if (typeof runId !== "string" || !Number.isSafeInteger(stateRevision) || stateRevision < 0
                        || typeof entryName !== "string" || (lane !== "outbox" && lane !== "retry")
                        || (hasStorageEntryName && typeof storageEntryName !== "string")
                        || (typeof json !== "string" && !(json instanceof Uint8Array)))
                        return "invalid";
                    requireAuthenticatedState(runId);
                    const routingBinding = input.routing_binding === undefined ? undefined : normalizeCtoOutboxDeliveryRoutingBinding(input.routing_binding);
                    if (input.routing_binding !== undefined && !routingBinding)
                        return "invalid";
                    const copy = Object.freeze({
                        run_id: runId,
                        state_revision: stateRevision,
                        entry_name: entryName,
                        ...(hasStorageEntryName ? { storage_entry_name: storageEntryName } : {}),
                        json: typeof json === "string" ? json : new Uint8Array(json),
                        lane,
                        ...(routingBinding === undefined ? {} : { routing_binding: routingBinding }),
                    });
                    return currentOutboxDeliveryStatusPinned(copy, cell.root, cell.deliveryCapability);
                }
                catch {
                    return "unavailable";
                }
                finally {
                    requireLive(cell);
                }
            },
        },
        listEscalationChannelKinds: {
            enumerable: false,
            value: () => {
                requireLive(cell);
                return channelKindNames(cell.root);
            },
        },
        resolveEscalationChannelSnapshot: {
            enumerable: false,
            value: () => {
                requireLive(cell);
                return channelSnapshot(cell.root);
            },
        },
        resolveEscalationChannelConfigs: {
            enumerable: false,
            value: (kind) => {
                requireLive(cell);
                return channelConfigsForKind(cell.root, kind);
            },
        },
        buildDigest: {
            enumerable: false,
            value: (runId) => {
                requireLive(cell);
                requireSafeRunId(runId);
                const state = requireAuthenticatedState(runId);
                const health = assessRunHealth(state);
                const digest = {
                    run_id: state.id,
                    at: new Date().toISOString(),
                    health,
                    recent_decisions: recallDecisions(state, { limit: 10 }),
                    open_escalations: health.pending_escalations,
                    budget_status: checkBudget(state).status,
                };
                return detachedProjection(digest);
            },
        },
        withRunTransaction: {
            enumerable: false,
            value: (runId, callback) => {
                requireLive(cell);
                requireSafeRunId(runId);
                if (typeof callback !== "function")
                    throw runtimeError("runtime_access_invalid", "run transaction callback is invalid");
                return withCtoRunLock(cell.root.canonical_root, runId, (handle) => {
                    requireLive(cell);
                    const loadedState = readCtoStatePinned(runId, cell.root);
                    if (!loadedState)
                        throw runtimeError("runtime_access_invalid", `CTO run '${runId}' is unavailable`);
                    let state = loadedState;
                    requireAuthenticatedState(runId);
                    const activity = { active: true };
                    const transaction = Object.create(null);
                    Object.defineProperties(transaction, {
                        readState: {
                            enumerable: false,
                            value: () => {
                                requireTransactionActive(cell, activity);
                                return state;
                            },
                        },
                        writeState: {
                            enumerable: false,
                            value: (next) => {
                                requireTransactionActive(cell, activity);
                                if (!next || typeof next !== "object" || next.id !== runId)
                                    throw runtimeError("runtime_access_invalid", "run transaction state identity does not match the bound run");
                                const path = writeCtoStateLocked(next, cell.root.canonical_root, {
                                    pinnedRoot: cell.root,
                                    preCommit: ({ pinnedRoot }) => {
                                        requireTransactionActive(cell, activity);
                                        const authenticated = requireAuthenticatedState(runId);
                                        if (authenticated.state_revision !== state.state_revision)
                                            throw runtimeError("runtime_access_invalid", "run transaction state changed before state CAS");
                                        if (!pinnedRoot.isStable())
                                            throw runtimeError("runtime_access_invalid", "run transaction project root changed before state CAS");
                                    },
                                });
                                state = next;
                                if (!writeCtoRuntimeStateProof(cell.root, next))
                                    throw runtimeError('runtime_access_invalid', 'CTO state proof could not be committed');
                                if (!refreshCtoRunDeliveryIndexAuthorityPinned(cell.root, cell.deliveryCapability, cell.sessionId))
                                    throw runtimeError("runtime_access_invalid", "CTO delivery index proof could not be committed");
                                return path;
                            },
                        },
                        appendWave: {
                            enumerable: false,
                            value: (options) => {
                                requireTransactionActive(cell, activity);
                                if (!ownRecord(options))
                                    throw runtimeError("runtime_access_invalid", "wave options must be a plain object");
                                const next = appendWave(state, options);
                                if (next !== state) {
                                    requireTransactionActive(cell, activity);
                                    writeCtoStateLocked(next, cell.root.canonical_root, {
                                        pinnedRoot: cell.root,
                                        preCommit: ({ pinnedRoot }) => {
                                            requireTransactionActive(cell, activity);
                                            const authenticated = requireAuthenticatedState(runId);
                                            if (authenticated.state_revision !== state.state_revision)
                                                throw runtimeError("runtime_access_invalid", "run transaction state changed before state CAS");
                                            if (!pinnedRoot.isStable())
                                                throw runtimeError("runtime_access_invalid", "run transaction project root changed before state CAS");
                                        },
                                    });
                                    const persisted = readCtoStatePinned(runId, cell.root);
                                    if (!persisted || !writeCtoRuntimeStateProof(cell.root, persisted))
                                        throw runtimeError('runtime_access_invalid', 'CTO state proof could not be committed');
                                    if (!refreshCtoRunDeliveryIndexAuthorityPinned(cell.root, cell.deliveryCapability, cell.sessionId))
                                        throw runtimeError("runtime_access_invalid", "CTO delivery index proof could not be committed");
                                    state = persisted;
                                }
                                return state;
                            },
                        },
                        findWaveBySourceId: {
                            enumerable: false,
                            value: (sourceId) => {
                                requireTransactionActive(cell, activity);
                                requireSafeRunId(sourceId);
                                const matches = (state.wave_history ?? []).filter((wave) => wave.source_id === sourceId);
                                return matches.length === 1 ? matches[0] : null;
                            },
                        },
                    });
                    Object.freeze(transaction);
                    try {
                        const result = callback(transaction);
                        let then;
                        try {
                            if (result !== null && (typeof result === "object" || typeof result === "function")) {
                                then = result.then;
                            }
                        }
                        catch {
                            throw runtimeError("runtime_access_invalid", "run transaction result thenable inspection failed");
                        }
                        if (typeof then === "function") {
                            throw runtimeError("cto_runtime_transaction_async_unsupported", "CTO run transactions must complete synchronously");
                        }
                        return result;
                    }
                    finally {
                        activity.active = false;
                    }
                }, { pinnedRoot: cell.root });
            },
        },
        startScheduler: {
            enumerable: false,
            value: (runId, intervalMs, onWave) => {
                requireLive(cell);
                requireSafeRunId(runId);
                if (!Number.isFinite(intervalMs) || intervalMs <= 0 || typeof onWave !== "function")
                    throw runtimeError("runtime_access_invalid", "scheduler arguments are invalid");
                const state = requireAuthenticatedState(runId);
                const schedulerAdapter = {
                    read: () => { requireLive(cell); return requireAuthenticatedState(runId); },
                    update: (mutator) => {
                        requireLive(cell);
                        let updated;
                        methods.withRunTransaction(runId, (transaction) => {
                            const current = transaction.readState();
                            updated = mutator(current);
                            if (updated !== current)
                                transaction.writeState(updated);
                        });
                        if (!updated)
                            throw runtimeError("runtime_access_invalid", "scheduler state update did not commit");
                        return updated;
                    },
                };
                let stopped = false;
                let stop = () => undefined;
                const guardedOnWave = () => {
                    if (stopped)
                        return;
                    try {
                        requireLive(cell);
                        onWave();
                    }
                    catch (error) {
                        stop();
                        throw error;
                    }
                };
                stop = startWaveScheduler(state, schedulerAdapter, intervalMs, guardedOnWave);
                const wrappedStop = () => {
                    if (stopped)
                        return;
                    stopped = true;
                    stop();
                    cell.schedulers.delete(wrappedStop);
                };
                cell.schedulers.add(wrappedStop);
                return wrappedStop;
            },
        },
        close: {
            enumerable: false,
            value: () => {
                revoke(cell);
            },
        },
        assertLive: {
            enumerable: false,
            value: () => {
                requireLive(cell);
            },
        },
    });
    return Object.freeze(methods);
}
/**
 * Open one owner-authenticated, main-session-bound CTO capability. The owner
 * context is the only authorization input; raw claims, marker strings, cwd,
 * and lock handles are intentionally not accepted.
 */
export function openCtoRuntimeAccess(registryContext, session, projectRoot) {
    if (!session || typeof session !== "object" || !ownString(session.sessionId) || session.main !== true) {
        return openFailure("runtime_access_invalid", "a non-empty main session is required");
    }
    if (typeof projectRoot !== "string" || projectRoot.trim().length === 0)
        return openFailure("runtime_access_invalid", "project root is required");
    let snapshot;
    try {
        snapshot = requireRegistryContext(registryContext, projectRoot, "workflow_tools");
    }
    catch (error) {
        const code = errorCode(error);
        return openFailure(code === "owner_conflict" ? "owner_conflict" : "activation_revoked", error);
    }
    const root = PinnedProjectRoot.open(snapshot.canonical_root);
    if (!root || root.canonical_root !== snapshot.canonical_root || root.dev !== snapshot.root_dev || root.ino !== snapshot.root_ino || !root.isStable()) {
        root?.close();
        return openFailure("activation_revoked", "project root could not be pinned to the authenticated identity");
    }
    const cell = {
        context: registryContext,
        snapshot,
        root,
        sessionId: session.sessionId,
        schedulers: new Set(),
        revoked: false,
    };
    const access = makeFacade(cell);
    cell.access = access;
    const deliveryCapability = Object.freeze({});
    cell.deliveryCapability = deliveryCapability;
    deliveryCapabilities.set(deliveryCapability, cell);
    runtimeCells.set(access, cell);
    return { ok: true, access };
}
//# sourceMappingURL=runtime-access.js.map
