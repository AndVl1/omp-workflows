import {
  closeSync,
  accessSync,
  chmodSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  mkdtempSync,
  rmSync,
  lstatSync,
  linkSync,
  mkdirSync,
  openSync,
  opendirSync,
  readSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeSync,
  type Stats,
} from "node:fs";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { TextDecoder } from "node:util";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { tmpdir } from "node:os";
import { isSafeRelativePath } from "./validation.js";
import { MAX_PINNED_ROOT_READ_BYTES } from "./limits.js";
import { assertCurrentExecutionLiveness, ExecutionLivenessViolation, withoutCurrentExecutionLiveness } from "../execution-liveness.js";

/** Return the operating-system process-start identity used to detect PID reuse. */
let selfProcessStartIdentity: string | undefined;
export function processStartIdentity(pid = process.pid): string | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  // The current process cannot be replaced while this module is running, so a
  // successful self identity remains safe to reuse if the OS probe is later
  // transiently unavailable. Foreign PIDs are always probed afresh for reuse
  // fencing.
  if (pid === process.pid && selfProcessStartIdentity !== undefined) return selfProcessStartIdentity;
  if (process.platform === "linux") {
    try {
      const line = readFileSync(`/proc/${pid}/stat`, "utf8");
      const closing = line.lastIndexOf(")");
      if (closing < 0) return null;
      const fields = line.slice(closing + 2).trim().split(/\s+/u);
      // The suffix starts at field 3 (state); starttime is field 22.
      const identity = fields.length > 19 && fields[19] ? `linux:${fields[19]}` : null;
      if (pid === process.pid && identity !== null) selfProcessStartIdentity = identity;
      return identity;
    } catch {
      return null;
    }
  }
  if (process.platform === "darwin") {
    try {
      const result = spawnSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
        encoding: "utf8",
        timeout: 1000,
        killSignal: "SIGTERM",
        maxBuffer: 4096,
        env: { LC_ALL: "C", LANG: "C", TZ: "UTC" },
      });
      const output = typeof result.stdout === "string" ? result.stdout.trim() : "";
      const identity = result.status === 0 && output.length > 0 ? `darwin:${output}` : null;
      if (pid === process.pid && identity !== null) selfProcessStartIdentity = identity;
      return identity;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * A failure from a descriptor-anchored project-root operation.  Callers map
 * every failure to their own typed, fail-closed result instead of falling
 * back to a pathname write.
 */
export type PinnedRootErrorCode =
  | "unsupported"
  | "invalid"
  | "limit"
  | "changed"
  | "recovery_required"
  | "path_unauthorized"
  | "not_found"
  | "not_directory"
  | "not_regular"
  | "write_failed"
  | "exists";

export class PinnedRootError extends Error {
  readonly code: PinnedRootErrorCode;

  constructor(code: PinnedRootErrorCode, message: string) {
    super(message);
    this.name = "PinnedRootError";
    this.code = code;
  }
}

/** Internal deterministic seams used by migration path-race tests. */
export interface PinnedRootWriteHooks {
  /** Test-only fail-closed seam for Darwin helper availability. */
  disableDarwinHelper?: boolean;
  /** Test-only delay injected into the Darwin helper before dispatch. */
  helperSleepMs?: number;
  /** Test-only override for the bounded helper timeout. */
  helperTimeoutMs?: number;
  /** Test-only absolute executable override for spawn-error coverage. */
  helperExecutable?: string;
  /** Test-only deterministic response-channel fault. */
  helperProtocolTest?: "short_write" | "epipe" | "eof" | "oversized_response" | "two_frames" | "invalid_utf8" | "invalid_json" | "truncated" | "valid_multibyte_control" | "forged_response" | "replay_response" | "cross_session_replay" | "forged_request" | "eof_after_prepared_commit" | "eof_after_prepared_ack";
  /** Test-only seam immediately before opening a helper FIFO. */
  beforeDarwinHelperOpen?: (channel: "request" | "response", path: string) => void;
  /** Test-only seam immediately before a conditional target lock. */
  beforeConditionalCommit?: (relativePath: string) => void;
  /** Test-only seam after a deterministic conditional lock is acquired. */
  afterConditionalLock?: (relativePath: string) => void;
  /** Test-only seam after expected inode/digest verification. */
  afterConditionalVerification?: (relativePath: string) => void;
  /** Test-only seam after a replacement temp is durably staged. */
  afterConditionalStage?: (relativePath: string) => void;
  /** Test-only seam after canonical replacement/removal. */
  afterConditionalReplace?: (relativePath: string) => void;
  /** Test-only seam immediately before conditional lease cleanup. */
  conditionalPostExchangeMutation?: boolean;
  conditionalPreExchangeMutation?: boolean;
  conditionalStagePreExchangeMutation?: boolean;
  conditionalPreMoveMutation?: boolean;
  conditionalPreMoveSymlink?: boolean;
  conditionalPostExchangeStageMutation?: boolean;
  beforeConditionalCleanup?: (relativePath: string) => void;
  /** Test-only replacement of the prepared lease before its signed upgrade. */
  preparedLeaseReplacement?: boolean;
  /** Test-only same-inode mutation after ACK verification, before lease release. */
  preparedPostVerifyMutation?: boolean;
  /** Test-only helper/Node crash injection phase. */
  conditionalFailurePhase?: "after_lock" | "after_verification" | "after_stage" | "after_replace" | "before_cleanup" | "after_prepared_publish_error" | "after_prepared_publication_before_lease" | "after_prepared_stage_before_journal" | "after_prepared_batch_journal" | "after_prepared_batch_first_lease_release";
  /** Test-only seam: restrict a grouped helper crash to one prepared entry. */
  preparedBatchJournalIndex?: number;
  /** Test-only seam: fail a Darwin batch immediately after this operation. */
  batchFailureIndex?: number;
  beforeDirectoryCreate?: (relativePath: string) => void;
  beforeTempOpen?: (relativePath: string) => void;
  beforeRename?: (relativePath: string) => void;
  /** Invoked after secure staging and before target visibility. */
  beforePublish?: (receipt: PinnedRootWriteReceipt) => void;
  /** Test-only seam immediately after portable link/rename publication. */
  afterPublish?: (relativePath: string) => void;
  /** Test-only seam after portable parent fsync and before liveness assertion. */
  afterPublishLiveness?: (relativePath: string) => void;
  beforeCleanup?: (relativePath: string) => void;
}

export interface PinnedRootIdentity {
  canonical_root: string;
  dev: number;
  ino: number;
}

export interface PinnedRootReadResult {
  path: string;
  bytes: Uint8Array;
  /** Device/inode observed from the opened regular-file descriptor. */
  dev: number;
  ino: number;
  /** Metadata captured from the same descriptor operation when available. */
  size?: number;
  mtimeMs?: number;
  ctimeMs?: number;
}

/** One stable lexicographic page of descriptor-anchored directory entries. */
export interface PinnedRootDirectoryPage {
  names: string[];
  /** Last returned name, or null when the directory is exhausted. */
  nextCursor: string | null;
}

/** Expected identity and canonical bytes for an anchored compare-and-swap. */
export interface PinnedRootFileExpectation {
  dev: number;
  ino: number;
  sha256: string;
  /** Optional byte length used by exact rollback/CAS checks. */
  size?: number;
}

export type PinnedRootWriteContent = string | Uint8Array;

export type PinnedRootWritePreimage =
  | { readonly kind: "absent" }
  | { readonly kind: "file"; readonly bytes: Readonly<Uint8Array>; readonly expectation: PinnedRootFileExpectation };

/** Descriptor plus the exact preimage captured before this operation published. */
export interface PinnedRootWriteReceipt {
  readonly path: string;
  readonly relative_path: string;
  readonly descriptor: PinnedRootWriteDescriptor;
  readonly preimage: PinnedRootWritePreimage;
  /** Exact CAS rollback; returns false when a concurrent winner owns the path. */
  readonly rollback: () => boolean;
}

export interface PinnedRootWriteOptions {
  /** Called after secure staging and before the target name becomes visible. */
  readonly beforePublish?: (receipt: PinnedRootWriteReceipt) => void;
}

export interface PinnedRootBatchWriteOptions {
  /** Called after every entry is staged and before any target becomes visible. */
  readonly beforePublish?: (receipts: readonly PinnedRootWriteReceipt[]) => void;
}

/**
 * Identity of the exact inode published by one anchored write operation.
 * `sha256` and `size` are the requested bytes, while `dev`/`ino` identify the
 * operation's temp inode after its atomic rename or exclusive link. Callers
 * must use this descriptor for ownership rollback rather than re-reading the
 * pathname, which could have been replaced by a concurrent writer.
 */
export interface PinnedRootWriteDescriptor {
  readonly path: string;
  readonly relative_path: string;
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly sha256: string;
}

const descriptorReceipts = new WeakMap<PinnedRootWriteDescriptor, PinnedRootWriteReceipt>();
const descriptorPreimages = new WeakMap<PinnedRootWriteDescriptor, PinnedRootWritePreimage>();

const DARWIN_PYTHON_CANDIDATES = ["/usr/bin/python3", "/usr/local/bin/python3", "/opt/homebrew/bin/python3"] as const;
const DARWIN_HELPER_MAX_OUTPUT = 24 * 1024 * 1024;
/** Synchronous helper operations have one total deadline, including startup. */
const DARWIN_HELPER_TIMEOUT_MS = 4_500;
// Large framed writes must allow the complete bounded payload to cross the
// synchronous FIFOs on slower Darwin hosts. Keep the allowance finite and
// derive it from the validated frame size below; ordinary helper calls retain
// the short default deadline.
const DARWIN_HELPER_TRANSFER_TIMEOUT_CAP_MS = 90_000;
const DARWIN_HELPER_TRANSFER_COMPLETION_MARGIN_MS = 5_000;
const DARWIN_HELPER_TRANSFER_THRESHOLD_BYTES = 1 * 1024 * 1024;
const DARWIN_HELPER_TRANSFER_BYTES_PER_MS = 1 * 1024;
const DARWIN_HELPER_TRANSFER_OPERATIONS = new Set([
  "write_exclusive", "write_atomic", "prepare_write_exclusive", "prepare_write_atomic", "commit_prepared_write", "ack_prepared_write", "abort_prepared_write", "batch", "batch_atomic", "replace_if_matches",
]);
const DARWIN_HELPER_MAX_INPUT = 96 * 1024 * 1024;
const DARWIN_HELPER_START_TIMEOUT_MS = 1_000;
const DARWIN_HELPER_CLOSE_TIMEOUT_MS = 1_000;
const DARWIN_HELPER_POLL_MS = 2;
const MAX_PINNED_ROOT_WRITE_BYTES = 64 * 1024 * 1024;

interface DarwinHelperSession {
  readonly directory: string;
  readonly requestPath: string;
  readonly responsePath: string;
  readonly requestFd: number;
  readonly responseFd: number;
  readonly child: ChildProcess;
  readonly exitPromise: Promise<void>;
  readonly resolveExit: () => void;
  exited: boolean;
  closing: boolean;
  runtimeError: Error | null;
  readonly authKey: Buffer;
  readonly sessionId: string;
  readonly rootPathDigest: string;
  nonce: number;
}

const activeDarwinHelperSessions = new Set<DarwinHelperSession>();
const LIVE_DARWIN_HELPER_SESSION_IDS = new Map<string, Set<string>>();
const MAX_LIVE_DARWIN_HELPER_SESSIONS_PER_ROOT = 64;

function pruneLiveDarwinHelperSessions(rootPathDigest: string): Set<string> {
  const active = new Set([...activeDarwinHelperSessions]
    .filter((session) => session.rootPathDigest === rootPathDigest && !session.exited && !session.closing)
    .map((session) => session.sessionId));
  const known = LIVE_DARWIN_HELPER_SESSION_IDS.get(rootPathDigest);
  if (!known) return active;
  for (const sessionId of known) {
    if (!active.has(sessionId)) known.delete(sessionId);
  }
  if (known.size === 0) LIVE_DARWIN_HELPER_SESSION_IDS.delete(rootPathDigest);
  return active;
}

function registerLiveDarwinHelperSession(session: DarwinHelperSession): void {
  const active = pruneLiveDarwinHelperSessions(session.rootPathDigest);
  if (active.size >= MAX_LIVE_DARWIN_HELPER_SESSIONS_PER_ROOT) throw new PinnedRootError("unsupported", "descriptor helper live-session registry is full");
  let sessions = LIVE_DARWIN_HELPER_SESSION_IDS.get(session.rootPathDigest);
  if (!sessions) { sessions = new Set<string>(); LIVE_DARWIN_HELPER_SESSION_IDS.set(session.rootPathDigest, sessions); }
  sessions.add(session.sessionId);
}

function removeLiveDarwinHelperSession(session: DarwinHelperSession): void {
  const sessions = LIVE_DARWIN_HELPER_SESSION_IDS.get(session.rootPathDigest);
  if (!sessions) return;
  sessions.delete(session.sessionId);
  if (sessions.size === 0) LIVE_DARWIN_HELPER_SESSION_IDS.delete(session.rootPathDigest);
}

function liveDarwinHelperSessionIds(rootPathDigest: string): string[] {
  const sessions = LIVE_DARWIN_HELPER_SESSION_IDS.get(rootPathDigest);
  if (!sessions) return [];
  pruneLiveDarwinHelperSessions(rootPathDigest);
  return [...(LIVE_DARWIN_HELPER_SESSION_IDS.get(rootPathDigest) ?? [])];
}

/**
 * Darwin has no Node openat/*at bindings. This helper receives the already
 * opened root descriptor as fd 3 and serves a bounded, serialized FIFO
 * request stream using Python's dir_fd APIs. Every request re-validates the
 * pinned identity; it never accepts a project pathname or changes cwd.
 */
const DARWIN_JOURNAL_AUTH_KEY = randomBytes(32);
const DARWIN_HOST_INSTANCE_ID = randomUUID();
const LIVE_DARWIN_BATCH_IDS = new Map<string, Set<string>>();

function liveDarwinBatchSet(rootDigest: string): Set<string> {
  let ids = LIVE_DARWIN_BATCH_IDS.get(rootDigest);
  if (!ids) { ids = new Set<string>(); LIVE_DARWIN_BATCH_IDS.set(rootDigest, ids); }
  return ids;
}

function removeLiveDarwinBatch(rootDigest: string, batchId: string): void {
  const ids = LIVE_DARWIN_BATCH_IDS.get(rootDigest);
  if (!ids) return;
  ids.delete(batchId);
  if (ids.size === 0) LIVE_DARWIN_BATCH_IDS.delete(rootDigest);
}

function canonicalDarwinHelperJson(value: unknown): string {
  const encoded = JSON.stringify(value, (_key, nested) => {
    if (nested !== null && typeof nested === "object" && !Array.isArray(nested)) {
      const record = nested as Record<string, unknown>;
      return Object.fromEntries(Object.keys(record).sort().map((key) => [key, record[key]]));
    }
    return nested;
  });
  if (encoded === undefined) throw new Error("helper authentication cannot encode undefined");
  return encoded;
}

function darwinHelperMac(value: unknown, key: Buffer): string {
  return createHmac("sha256", key).update(canonicalDarwinHelperJson(value), "utf8").digest("hex");
}

function verifyDarwinHelperMac(value: Record<string, unknown>, mac: unknown, key: Buffer): boolean {
  if (typeof mac !== "string") return false;
  const expected = Buffer.from(darwinHelperMac(value, key), "ascii");
  const actual = Buffer.from(mac, "ascii");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

const DARWIN_HELPER_SOURCE = String.raw`import base64
import hashlib
import hmac
import ctypes
import errno
import json
import os
import secrets
import stat
import subprocess
import sys
import threading
import time

MAX_READ = 8 * 1024 * 1024
MAX_PATH = 4096
MAX_SEGMENTS = 128
MAX_WRITE = 64 * 1024 * 1024
MAX_BATCH_ROLLBACK = 8 * 1024 * 1024
MAX_REQUEST_BYTES = 96 * 1024 * 1024
MAX_DIRECTORY_ENTRIES = 16384
MAX_DIRECTORY_NAME_BYTES = 4 * 1024 * 1024

# Prepared writes hold an exact parent descriptor and per-target lease across
# the beforePublish callback. A dead helper leaves only lease/stage residue;
# the next prepare reclaims it using the recorded process-start identity.
prepared_writes = {}
AUTH_KEY = None
JOURNAL_KEY = None
SESSION_ID = None
CURRENT_ROOT_BINDING = None
AUTHORIZED_BATCH_IDS = set()
RECOVERED_BATCH_IDS = set()
LIVE_HELPER_SESSION_IDS = set()
CURRENT_HOST_INSTANCE_ID = None
REQUEST_NONCE = 0


def auth_body(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def sign_auth(value):
    if AUTH_KEY is None:
        raise RuntimeError("helper IPC authentication key is unavailable")
    return hmac.new(AUTH_KEY, auth_body(value), hashlib.sha256).hexdigest()


def sign_journal(value):
    if JOURNAL_KEY is None:
        raise RuntimeError("helper journal authentication key is unavailable")
    return hmac.new(JOURNAL_KEY, auth_body(value), hashlib.sha256).hexdigest()


def signed_document(value):
    body = {key: item for key, item in value.items() if key != "signature"}
    return {**body, "signature": sign_journal(body)}


def verify_signed_document(value):
    if not isinstance(value, dict) or not isinstance(value.get("signature"), str):
        return False
    body = {key: item for key, item in value.items() if key != "signature"}
    return hmac.compare_digest(value["signature"], sign_journal(body))


def signed_frame(value):
    body = {key: item for key, item in value.items() if key != "_mac"}
    return {**body, "_mac": sign_auth(body)}


def verify_request_frame(value):
    global REQUEST_NONCE
    if not isinstance(value, dict) or not isinstance(value.get("_request_id"), str) or not isinstance(value.get("_nonce"), int):
        raise RuntimeError("helper request authentication is invalid")
    if value["_nonce"] != REQUEST_NONCE + 1:
        raise RuntimeError("helper request nonce is out of order")
    mac = value.get("_mac")
    if not isinstance(mac, str):
        raise RuntimeError("helper request authentication is missing")
    body = {key: item for key, item in value.items() if key != "_mac"}
    if value.get("_session_id") != SESSION_ID:
        raise RuntimeError("helper request session identity failed")
    if not hmac.compare_digest(mac, sign_auth(body)):
        raise RuntimeError("helper request authentication failed")
    REQUEST_NONCE = value["_nonce"]


class NotRegular(Exception):
    pass


class RecoveryRequired(Exception):
    pass


class LimitError(Exception):
    pass


def fail(code, message):
    return {"ok": False, "code": code, "message": message}


def errno_code(exc):
    return getattr(exc, "errno", None)


def safe_segments(value, allow_empty=False):
    if not isinstance(value, str):
        raise ValueError("anchored path must be a string")
    if len(value) > MAX_PATH or "\\" in value or "\x00" in value or value.startswith("/") or (len(value) >= 2 and value[1] == ":"):
        raise ValueError("anchored path must be a bounded relative POSIX path")
    if not value:
        if allow_empty:
            return []
        raise ValueError("anchored path cannot be empty")
    pieces = value.split("/")
    if len(pieces) > MAX_SEGMENTS or any((not piece or piece in (".", "..")) for piece in pieces):
        raise ValueError("anchored path contains an unsafe component")
    return pieces


def ensure_flags():
    required = ("O_DIRECTORY", "O_NOFOLLOW")
    if any(not hasattr(os, name) for name in required):
        raise NotImplementedError("descriptor no-follow operations are unavailable")
    return os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW


def open_chain(root_fd, pieces, create):
    flags = ensure_flags()
    current = os.dup(root_fd)
    try:
        for piece in pieces:
            try:
                child = os.open(piece, flags, dir_fd=current)
            except FileNotFoundError:
                if not create:
                    raise
                try:
                    os.mkdir(piece, 0o700, dir_fd=current)
                except FileExistsError:
                    # Another descriptor-anchored writer won the mkdir race.
                    # Re-open the winner with O_NOFOLLOW|O_DIRECTORY; a
                    # symlink, file, or other non-directory remains rejected.
                    pass
                child = os.open(piece, flags, dir_fd=current)
            os.close(current)
            current = child
        return current
    except Exception:
        try:
            os.close(current)
        except Exception:
            pass
        raise


def root_guard(root_fd, payload):
    expected_dev = payload.get("root_dev")
    expected_ino = payload.get("root_ino")
    if not isinstance(expected_dev, int) or not isinstance(expected_ino, int):
        raise ValueError("root identity is invalid")
    info = os.fstat(root_fd)
    if not stat.S_ISDIR(info.st_mode) or info.st_dev != expected_dev or info.st_ino != expected_ino:
        raise RuntimeError("pinned project root identity changed")


def parent_for(root_fd, path, create=False):
    pieces = safe_segments(path)
    return open_chain(root_fd, pieces[:-1], create), pieces[-1]


def parent_dir(root_fd, path, create=False):
    pieces = safe_segments(path, allow_empty=True)
    return open_chain(root_fd, pieces, create)


def stat_at(parent, name):
    return os.stat(name, dir_fd=parent, follow_symlinks=False)


def read_fd(fd, max_read=MAX_READ):
    before = os.fstat(fd)
    if not stat.S_ISREG(before.st_mode):
        raise NotRegular("anchored target is not a regular file")
    if before.st_size < 0 or before.st_size > max_read:
        raise OSError("anchored source exceeds the bounded read limit")
    # Read at most max_read+1 bytes. The extra byte detects a concurrent
    # append without ever allocating or buffering an unbounded regular file.
    chunks = []
    remaining = max_read + 1
    while remaining:
        chunk = os.read(fd, min(1024 * 1024, remaining))
        if not chunk:
            break
        chunks.append(chunk)
        remaining -= len(chunk)
    data = b"".join(chunks)
    if len(data) > max_read:
        raise OSError("anchored source exceeds the bounded read limit")
    after = os.fstat(fd)
    if len(data) != before.st_size or before.st_dev != after.st_dev or before.st_ino != after.st_ino or before.st_size != after.st_size or before.st_mtime_ns != after.st_mtime_ns or before.st_ctime_ns != after.st_ctime_ns:
        raise RuntimeError("anchored source changed while it was being read")
    return data, before


def read_at(parent, name, max_read=MAX_READ):
    flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
    fd = os.open(name, flags, dir_fd=parent)
    try:
        data, info = read_fd(fd, max_read)
        pathname = stat_at(parent, name)
        if stat.S_ISLNK(pathname.st_mode):
            raise RuntimeError("anchored source pathname is a symbolic link")
        if not stat.S_ISREG(pathname.st_mode) or pathname.st_dev != info.st_dev or pathname.st_ino != info.st_ino:
            raise RuntimeError("anchored source pathname changed while it was being read")
        return data, info
    finally:
        os.close(fd)


def read_prefix_at(parent, name, max_read=MAX_READ):
    flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
    fd = os.open(name, flags, dir_fd=parent)
    try:
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode):
            raise NotRegular("anchored source must be a regular file")
        data = bytearray()
        while len(data) < max_read:
            chunk = os.read(fd, max_read - len(data))
            if not chunk:
                break
            data.extend(chunk)
        after = os.fstat(fd)
        if before.st_dev != after.st_dev or before.st_ino != after.st_ino or before.st_size != after.st_size or before.st_mtime_ns != after.st_mtime_ns or before.st_ctime_ns != after.st_ctime_ns:
            raise RuntimeError("anchored source changed while it was being read")
        pathname = stat_at(parent, name)
        if stat.S_ISLNK(pathname.st_mode):
            raise RuntimeError("anchored source pathname is a symbolic link")
        if not stat.S_ISREG(pathname.st_mode) or pathname.st_dev != after.st_dev or pathname.st_ino != after.st_ino:
            raise RuntimeError("anchored source pathname changed while it was being read")
        return bytes(data), after
    finally:
        os.close(fd)

def bounded_name(domain, relative_path, suffix, nonce=True):
    """Build a bounded sibling component from the full canonical path."""
    digest = hashlib.sha256(relative_path.encode("utf-8")).hexdigest()
    token = ("-" + secrets.token_hex(16)) if nonce else ""
    return ".omp-" + domain + "-" + digest + token + suffix


def reserve(parent, relative_path):
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW
    for _ in range(32):
        candidate = bounded_name("write", relative_path, ".tmp")
        try:
            fd = os.open(candidate, flags, 0o600, dir_fd=parent)
            return candidate, fd
        except FileExistsError:
            continue
    raise OSError("unable to reserve an exclusive bounded temporary file")


def write_temp(parent, relative_path, data):
    if len(data) > MAX_WRITE:
        raise OSError("anchored write exceeds the bounded write limit")
    name, fd = reserve(parent, relative_path)
    try:
        view = memoryview(data)
        try:
            offset = 0
            while offset < len(data):
                count = os.write(fd, view[offset:])
                if count <= 0:
                    raise OSError("short anchored write")
                offset += count
        finally:
            view.release()
        os.fchmod(fd, 0o600)
        os.fsync(fd)
    except Exception:
        try:
            os.close(fd)
        finally:
            try:
                os.unlink(name, dir_fd=parent)
            except Exception:
                pass
        raise
    os.close(fd)
    return name


def decode_write_payload(payload, allow_text=False):
    has_bytes = "bytes" in payload
    has_text = "text" in payload
    if has_bytes == has_text:
        raise ValueError("anchored write must provide exactly one bytes or text payload")
    if has_text:
        if not allow_text or not isinstance(payload.get("text"), str):
            raise ValueError("anchored write text payload is unsupported")
        try:
            data = payload["text"].encode("utf-8", "strict")
        except UnicodeEncodeError:
            raise ValueError("anchored write text payload is not valid UTF-8")
    else:
        encoded = payload.get("bytes")
        if not isinstance(encoded, str):
            raise ValueError("anchored write bytes payload must be a string")
        try:
            data = base64.b64decode(encoded, validate=True)
        except Exception:
            raise ValueError("anchored write bytes payload is not valid base64")
    if len(data) > MAX_WRITE:
        raise OSError("anchored write exceeds the bounded write limit")
    return data


def cleanup_temp(parent, name, expected=None):
    if name is None:
        return
    if expected is not None:
        try:
            remove_exact_regular(parent, name, expected)
        except Exception:
            pass
        return
    try:
        os.unlink(name, dir_fd=parent)
    except FileNotFoundError:
        pass
def same_identity(info, expected):
    expected_dev = expected.st_dev if hasattr(expected, "st_dev") else expected.get("dev")
    expected_ino = expected.st_ino if hasattr(expected, "st_ino") else expected.get("ino")
    return info.st_dev == expected_dev and info.st_ino == expected_ino


def same_digest(data, expected):
    return hashlib.sha256(data).hexdigest() == expected.get("sha256")


def safe_remove_regular(parent, name):
    try:
        info = stat_at(parent, name)
    except FileNotFoundError:
        return False
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
        raise PermissionError("conditional lease path is unsafe")
    os.unlink(name, dir_fd=parent)
    return True


def remove_legacy_ownerless_directory(parent, name, grace_ms):
    try:
        info = stat_at(parent, name)
    except FileNotFoundError:
        return False
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
        return False
    if time.time_ns() - info.st_mtime_ns < int(grace_ms * 1000000):
        return False
    # Move the exact observed directory to a private name. If a replacement
    # was installed after the observation, it is restored without deletion.
    stale = bounded_name("legacy", name, ".stale")
    try:
        rename_noreplace(parent, name, stale)
    except FileNotFoundError:
        return False
    try:
        opened = stat_at(parent, stale)
        if opened.st_dev != info.st_dev or opened.st_ino != info.st_ino:
            try:
                rename_noreplace(parent, stale, name)
            except FileExistsError:
                pass
            return False
        child_fd = os.open(stale, ensure_flags(), dir_fd=parent)
        try:
            child_info = os.fstat(child_fd)
            if child_info.st_dev != info.st_dev or child_info.st_ino != info.st_ino:
                try:
                    rename_noreplace(parent, stale, name)
                except FileExistsError:
                    pass
                return False
            with os.scandir(child_fd) as entries:
                if next(entries, None) is not None:
                    try:
                        rename_noreplace(parent, stale, name)
                    except FileExistsError:
                        pass
                    return False
        finally:
            os.close(child_fd)
        os.rmdir(stale, dir_fd=parent)
        fsync_regular(parent)
        return True
    except (FileNotFoundError, NotADirectoryError):
        try:
            rename_noreplace(parent, stale, name)
        except FileExistsError:
            pass
        return False


def remove_exact_regular(parent, name, expected):
    """Compare and remove one exact descriptor-relative regular entry."""
    stale = bounded_name("cleanup", name, ".stale")
    try:
        rename_noreplace(parent, name, stale)
    except FileNotFoundError:
        return False
    try:
        data, info = read_at(parent, stale)
        if same_identity(info, expected) and (expected.get("size") is None or len(data) == expected.get("size")) and same_digest(data, expected):
            os.unlink(stale, dir_fd=parent)
            fsync_regular(parent)
            return True
        try:
            rename_noreplace(parent, stale, name)
        except FileExistsError:
            pass
        return False
    except (FileNotFoundError, NotRegular):
        try:
            rename_noreplace(parent, stale, name)
        except FileExistsError:
            pass
        return False


def remove_exact_empty_directory(parent, name, expected):
    stale = bounded_name("cleanup", name, ".stale")
    try:
        rename_noreplace(parent, name, stale)
    except FileNotFoundError:
        return False
    try:
        info = stat_at(parent, stale)
        if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_dev != expected.get("dev") or info.st_ino != expected.get("ino"):
            try:
                rename_noreplace(parent, stale, name)
            except FileExistsError:
                pass
            return False
        child_fd = os.open(stale, ensure_flags(), dir_fd=parent)
        try:
            opened = os.fstat(child_fd)
            if opened.st_dev != info.st_dev or opened.st_ino != info.st_ino:
                try:
                    rename_noreplace(parent, stale, name)
                except FileExistsError:
                    pass
                return False
            with os.scandir(child_fd) as entries:
                if next(entries, None) is not None:
                    try:
                        rename_noreplace(parent, stale, name)
                    except FileExistsError:
                        pass
                    return False
        finally:
            os.close(child_fd)
        os.rmdir(stale, dir_fd=parent)
        fsync_regular(parent)
        return True
    except (FileNotFoundError, NotADirectoryError):
        try:
            rename_noreplace(parent, stale, name)
        except FileExistsError:
            pass
        return False

def write_named_temp(parent, name, data):
    if len(data) > MAX_WRITE:
        raise OSError("anchored write exceeds the bounded write limit")
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW
    fd = os.open(name, flags, 0o600, dir_fd=parent)
    try:
        view = memoryview(data)
        try:
            offset = 0
            while offset < len(data):
                count = os.write(fd, view[offset:])
                if count <= 0:
                    raise OSError("short anchored write")
                offset += count
        finally:
            view.release()
        os.fchmod(fd, 0o600)
        os.fsync(fd)
    except Exception:
        try:
            info = os.fstat(fd)
        except Exception:
            info = None
        try:
            os.close(fd)
        finally:
            if info is not None:
                remove_exact_regular(parent, name, {"dev": info.st_dev, "ino": info.st_ino, "size": len(data), "sha256": hashlib.sha256(data).hexdigest()})
        raise
    os.close(fd)
    return name


def write_lock(parent, name, metadata, exclusive):
    flags = os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW
    if exclusive:
        flags |= os.O_EXCL
    payload = (json.dumps(metadata, separators=(",", ":")) + "\n").encode("utf-8")
    fd = os.open(name, flags, 0o600, dir_fd=parent)
    try:
        offset = 0
        while offset < len(payload):
            count = os.write(fd, payload[offset:])
            if count <= 0:
                raise OSError("short conditional lease write")
            offset += count
        os.fchmod(fd, 0o600)
        os.fsync(fd)
    except Exception:
        os.close(fd)
        if exclusive:
            try:
                os.unlink(name, dir_fd=parent)
            except FileNotFoundError:
                pass
        raise
    os.close(fd)


def read_lock(parent, name):
    flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
    try:
        fd = os.open(name, flags, dir_fd=parent)
    except FileNotFoundError:
        return None
    try:
        data, _ = read_fd(fd)
    finally:
        os.close(fd)
    try:
        value = json.loads(data.decode("utf-8"))
    except Exception:
        return {}
    return value if isinstance(value, dict) else {}

def read_lock_observed(parent, name):
    data, info = read_at(parent, name)
    try:
        owner = json.loads(data.decode("utf-8"))
    except Exception:
        owner = {}
    return data, info, owner if isinstance(owner, dict) else {}


_SELF_PID = os.getpid()
_SELF_START_IDENTITY = None

def process_start_identity(pid):
    """Return an identity that changes whenever pid is recycled."""
    global _SELF_START_IDENTITY
    if not isinstance(pid, int) or pid <= 0:
        return None
    # The helper process itself cannot be replaced while this interpreter is
    # serving requests. Cache only its first successful identity; foreign PIDs
    # must always be probed afresh for PID-reuse fencing.
    if pid == _SELF_PID and _SELF_START_IDENTITY is not None:
        return _SELF_START_IDENTITY
    if sys.platform == "linux":
        try:
            with open("/proc/" + str(pid) + "/stat", "rb") as stream:
                line = stream.read(4096).decode("ascii", "strict")
            closing = line.rfind(")")
            if closing < 0:
                return None
            fields = line[closing + 2:].split()
            # The suffix starts at field 3 (state); starttime is field 22.
            if len(fields) <= 19:
                return None
            identity = "linux:" + fields[19]
            if pid == _SELF_PID:
                _SELF_START_IDENTITY = identity
            return identity
        except (FileNotFoundError, PermissionError, OSError, UnicodeError):
            return None
    if sys.platform == "darwin":
        try:
            result = subprocess.run(
                ["/bin/ps", "-p", str(pid), "-o", "stat=,lstart="],
                capture_output=True,
                text=True,
                check=False,
                timeout=1,
                env={"LC_ALL": "C", "LANG": "C", "TZ": "UTC"},
            )
            fields = result.stdout.strip().split(None, 1)
            if result.returncode != 0 or not fields:
                return None
            if fields[0].startswith("Z"):
                return "darwin:zombie"
            identity = fields[1].strip() if len(fields) > 1 else ""
            identity = "darwin:" + identity if identity else None
            if pid == _SELF_PID and identity is not None:
                _SELF_START_IDENTITY = identity
            return identity
        except (OSError, subprocess.SubprocessError):
            return None
    return None


LEGACY_LOCK_GRACE_NS = 5 * 1000 * 1000 * 1000


def owner_alive(owner, observed_info=None):
    if not isinstance(owner, dict):
        return False
    owner_session = owner.get("session_id")
    owner_host = owner.get("host_instance_id")
    if owner_host == CURRENT_HOST_INSTANCE_ID and owner_session is not None and (not isinstance(owner_session, str) or owner_session not in LIVE_HELPER_SESSION_IDS):
        return False
    pid = owner.get("pid")
    if not isinstance(pid, int) or pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        # We cannot safely establish either identity or liveness. Preserve
        # the lock rather than time-stealing an owner we cannot inspect.
        return True
    except OSError as exc:
        if errno_code(exc) == 3:
            return False
        return True
    expected_identity = owner.get("start_identity")
    if not isinstance(expected_identity, str) or not expected_identity:
        # v1 metadata predates process identities. A live owner is protected
        # only by the bounded publication grace.
        if observed_info is None:
            return True
        return time.time_ns() - observed_info.st_mtime_ns < LEGACY_LOCK_GRACE_NS
    actual_identity = process_start_identity(pid)
    if actual_identity == "darwin:zombie":
        return False
    if actual_identity is None:
        # A live process whose identity cannot be read is not safe to reclaim.
        return True
    return actual_identity == expected_identity

def owner_identity_live(owner):
    """Prove an unverifiable lease belongs to a currently live exact process."""
    pid = owner.get("pid") if isinstance(owner, dict) else None
    expected_identity = owner.get("start_identity") if isinstance(owner, dict) else None
    if not isinstance(pid, int) or pid <= 0 or not isinstance(expected_identity, str) or not expected_identity:
        return False
    try:
        os.kill(pid, 0)
    except (ProcessLookupError, PermissionError):
        return False
    except OSError as exc:
        return False if errno_code(exc) == 3 else False
    actual_identity = process_start_identity(pid)
    return actual_identity is not None and actual_identity != "darwin:zombie" and actual_identity == expected_identity


def owner_identity_dead(owner):
    """Prove the recorded process identity is no longer the lease owner."""
    pid = owner.get("pid") if isinstance(owner, dict) else None
    expected_identity = owner.get("start_identity") if isinstance(owner, dict) else None
    if not isinstance(pid, int) or pid <= 0 or not isinstance(expected_identity, str) or not expected_identity:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return True
    except PermissionError:
        return False
    except OSError as exc:
        return errno_code(exc) == 3
    actual_identity = process_start_identity(pid)
    return actual_identity == "darwin:zombie" or (actual_identity is not None and actual_identity != expected_identity)


def quarantine_untrusted_entry(parent, name, relative_path, expected, prefix):
    """Move only an observed regular internal entry, verifying its descriptor."""
    for _ in range(32):
        candidate = bounded_name(prefix, relative_path, ".quarantined")
        try:
            rename_noreplace(parent, name, candidate)
        except FileExistsError:
            continue
        except FileNotFoundError:
            return None
        try:
            data, info = read_at(parent, candidate)
            if (not stat.S_ISREG(info.st_mode) or not same_identity(info, expected)
                or (expected.get("size") is not None and len(data) != expected.get("size"))
                or not same_digest(data, expected)):
                raise RecoveryRequired("untrusted lease residue changed during quarantine")
            fsync_entry(parent, candidate)
            fsync_regular(parent)
        except Exception as error:
            try:
                rename_noreplace(parent, candidate, name)
            except Exception:
                pass
            if isinstance(error, RecoveryRequired):
                raise
            raise RecoveryRequired("untrusted lease residue could not be quarantined") from error
        return candidate
    raise RecoveryRequired("untrusted lease quarantine path could not be reserved")


def quarantine_dead_untrusted_lease(parent, root_fd, target, relative_path, lock_name, stage_name, lock_data, lock_info, owner, expected):
    """Quarantine dead process-key-invalid residue without using its metadata."""
    if not preimage_matches(parent, target, expected):
        raise RuntimeError("anchored target changed while quarantining stale lease")
    lock_expected = {"dev": lock_info.st_dev, "ino": lock_info.st_ino, "size": len(lock_data), "sha256": hashlib.sha256(lock_data).hexdigest()}
    quarantine_untrusted_entry(parent, lock_name, relative_path, lock_expected, "restart-lease")
    try:
        stage_data, stage_info = read_at(parent, stage_name)
    except FileNotFoundError:
        stage_data = stage_info = None
    except Exception as error:
        raise RecoveryRequired("untrusted lease stage is not safely inspectable") from error
    if stage_info is not None:
        if not stat.S_ISREG(stage_info.st_mode):
            raise RecoveryRequired("untrusted lease stage is not a regular file")
        stage_expected = {"dev": stage_info.st_dev, "ino": stage_info.st_ino, "size": len(stage_data), "sha256": hashlib.sha256(stage_data).hexdigest()}
        quarantine_untrusted_entry(parent, stage_name, relative_path, stage_expected, "restart-stage")
    batch_id = owner.get("batch_id") if isinstance(owner, dict) else None
    journal_name = owner.get("batch_journal") if isinstance(owner, dict) else None
    if (isinstance(batch_id, str) and isinstance(journal_name, str) and len(batch_id) <= 128
        and journal_name == batch_journal_name(batch_id)):
        try:
            journal_data, journal_info = read_at(root_fd, journal_name)
        except FileNotFoundError:
            journal_data = journal_info = None
        except Exception:
            journal_data = journal_info = None
        if journal_info is not None and stat.S_ISREG(journal_info.st_mode):
            journal_expected = {"dev": journal_info.st_dev, "ino": journal_info.st_ino, "size": len(journal_data), "sha256": hashlib.sha256(journal_data).hexdigest()}
            quarantine_untrusted_entry(root_fd, journal_name, journal_name, journal_expected, "restart-journal")


def expected_matches(owner, expected, operation):
    if not isinstance(owner, dict) or owner.get("operation") != operation:
        return False
    recorded = owner.get("expected")
    if not isinstance(recorded, dict):
        return False
    return (
        recorded.get("dev") == expected.get("dev")
        and recorded.get("ino") == expected.get("ino")
        and (expected.get("size") is None or recorded.get("size") == expected.get("size"))
        and recorded.get("sha256") == expected.get("sha256")
    )

def conditional_lock(parent, target, relative_path, expected, desired_sha, operation, group=None):
    lock_name = bounded_name("cas-lock", relative_path, ".lock", nonce=False)
    stage_name = bounded_name("cas-stage", relative_path, ".tmp", nonce=False)
    # Read legacy lease names only when they already fit NAME_MAX. New
    # transactions never derive a component from the target basename.
    legacy_lock_name = "." + target + ".cas.lock"
    legacy_stage_name = "." + target + ".cas.tmp"
    if len(legacy_lock_name.encode("utf-8")) < 255 and len(legacy_stage_name.encode("utf-8")) < 255:
        try:
            stat_at(parent, lock_name)
        except FileNotFoundError:
            try:
                stat_at(parent, legacy_lock_name)
            except FileNotFoundError:
                pass
            else:
                lock_name = legacy_lock_name
                stage_name = legacy_stage_name
    start_identity = process_start_identity(os.getpid())
    if start_identity is None:
        raise NotImplementedError("process start identity is unavailable")
    metadata = signed_document({"schema_version": 2, "token": secrets.token_hex(16), "pid": os.getpid(), "start_identity": start_identity, "session_id": SESSION_ID, "host_instance_id": CURRENT_HOST_INSTANCE_ID, "operation": operation, "expected": expected, "desired_sha256": desired_sha, "stage": stage_name})
    if isinstance(group, dict):
        metadata.update({"schema_version": 3, "batch_id": group.get("batch_id"), "batch_index": group.get("batch_index"), "batch_size": group.get("batch_size"), "batch_journal": group.get("batch_journal"), "path": relative_path, "root_binding": CURRENT_ROOT_BINDING})
        metadata = signed_document(metadata)
    for _ in range(2):
        try:
            write_lock(parent, lock_name, metadata, True)
            try:
                os.fsync(parent)
            except OSError as exc:
                if errno_code(exc) not in (22, 95):
                    raise
            return metadata, False, lock_name, stage_name
        except FileExistsError:
            try:
                lock_data, lock_info, owner = read_lock_observed(parent, lock_name)
            except FileNotFoundError:
                continue
            expected_lock = {"dev": lock_info.st_dev, "ino": lock_info.st_ino, "sha256": hashlib.sha256(lock_data).hexdigest()}
            if "signature" in owner and not verify_signed_document(owner):
                if owner_identity_live(owner):
                    raise RuntimeError("conditional target is locked")
                if owner_identity_dead(owner):
                    quarantine_dead_untrusted_lease(parent, 3, target, relative_path, lock_name, stage_name, lock_data, lock_info, owner, expected)
                    return None, True, lock_name, stage_name
                raise RecoveryRequired("conditional lease authentication is unavailable")
            if owner_alive(owner, lock_info):
                raise RuntimeError("conditional target is locked")
            committed = False
            if (isinstance(owner.get("batch_id"), str) and isinstance(owner.get("batch_journal"), str)
                and owner.get("batch_index") is not None and owner.get("batch_size") is not None):
                try:
                    recover_prepared_batch(3, owner["batch_journal"], owner["batch_id"])
                except RecoveryRequired as error:
                    if str(error) == "prepared batch lease is missing":
                        recover_partial_prepared_batch(3, owner["batch_journal"], owner["batch_id"])
                    else:
                        raise
                # Recovery owns the entire group and removes its exact leases
                # and journal; retry acquisition for the requested operation.
                return None, True, lock_name, stage_name
            if owner.get("operation") in ("write_atomic", "write_exclusive"):

                postimage = owner.get("postimage")
                preimage = owner.get("expected")
                postimage_valid = isinstance(postimage, dict) and isinstance(postimage.get("dev"), int) and isinstance(postimage.get("ino"), int) and isinstance(postimage.get("size"), int) and isinstance(postimage.get("sha256"), str)
                preimage_valid = isinstance(preimage, dict) and preimage.get("kind") in ("absent", "file")
                if postimage_valid and preimage_valid:
                    current_matches = False
                    preimage_matches_current = False
                    try:
                        data, info = read_at(parent, target)
                        current_matches = info.st_dev == postimage.get("dev") and info.st_ino == postimage.get("ino") and len(data) == postimage.get("size") and hashlib.sha256(data).hexdigest() == postimage.get("sha256")
                        preimage_matches_current = (
                            preimage.get("kind") == "file"
                            and info.st_dev == preimage.get("dev")
                            and info.st_ino == preimage.get("ino")
                            and len(data) == preimage.get("size")
                            and hashlib.sha256(data).hexdigest() == preimage.get("sha256")
                        )
                    except FileNotFoundError:
                        preimage_matches_current = preimage.get("kind") == "absent"
                    if owner.get("published") is True or current_matches or not preimage_matches_current:
                        # There is no descriptor-relative expected-unlink CAS.
                        # Preserve the current target and retain the exact
                        # durable lease for WAL reconciliation.
                        raise RuntimeError("stale prepared publication quarantined: target recovery is nondestructive")
                    # A lease that never published owns only its unique stage;
                    # reclaiming that residue is safe.
                    committed = True
            if expected_matches(owner, expected, operation):
                try:
                    data, info = read_at(parent, target)
                    if operation == "replace" and not same_identity(info, expected) and hashlib.sha256(data).hexdigest() == desired_sha:
                        committed = True
                except FileNotFoundError:
                    if operation == "remove":
                        committed = True
            # Exact compare-and-remove of the observed lock. A replacement
            # installed after read_lock_observed is never removed.
            reclaimed = remove_exact_regular(parent, lock_name, expected_lock)
            if reclaimed:
                # Stage bytes are private transaction residue. Remove only a
                # stage whose digest matches the stale owner metadata.
                try:
                    stage_data, stage_info = read_at(parent, stage_name)
                    stage_digest = hashlib.sha256(stage_data).hexdigest()
                    owner_expected = owner.get("expected") if isinstance(owner.get("expected"), dict) else {}
                    if stage_digest == owner.get("desired_sha256") or (owner_expected.get("kind") == "file" and stage_digest == owner_expected.get("sha256")):
                        remove_exact_regular(parent, stage_name, {"dev": stage_info.st_dev, "ino": stage_info.st_ino, "sha256": stage_digest})
                except FileNotFoundError:
                    pass
            if committed and reclaimed:
                return None, True, lock_name, stage_name
    raise RuntimeError("conditional target lock could not be recovered")


def release_conditional_lock(parent, name, token):
    try:
        data, info, owner = read_lock_observed(parent, name)
        if owner.get("token") != token:
            return
        expected = {"dev": info.st_dev, "ino": info.st_ino, "sha256": hashlib.sha256(data).hexdigest()}
        remove_exact_regular(parent, name, expected)
    except FileNotFoundError:
        pass

def conditional_crash(payload, phase):
    if payload.get("failure_phase") == phase:
        os._exit(97)


def conditional_kill(payload, phase):
    if payload.get("failure_phase") == phase and (payload.get("failure_batch_index") is None or payload.get("batch_index") == payload.get("failure_batch_index")):
        os._exit(86)


def conditional_lease_replacement(payload, prepared):
    if not payload.get("test_prepared_lease_replacement") or prepared.get("_lease_replaced"):
        return
    prepared["_lease_replaced"] = True
    foreign_name = bounded_name("foreign-lease", prepared["path"], ".tmp")
    foreign_data = b"foreign lease replacement\n"
    temp = write_temp(prepared["parent"], foreign_name, foreign_data)
    try:
        os.replace(temp, prepared["lock_name"], src_dir_fd=prepared["parent"], dst_dir_fd=prepared["parent"])
        temp = None
        fsync_regular(prepared["parent"])
    finally:
        cleanup_temp(prepared["parent"], temp)

def conditional_error(payload, phase):
    if payload.get("failure_phase") == phase:
        raise RuntimeError("injected helper publication error")


def fsync_regular(fd):
    try:
        os.fsync(fd)
    except OSError as exc:
        if errno_code(exc) not in (22, 95):
            raise


def rename_exchange(parent, source, target):
    """Atomically exchange two names while retaining the inherited parent fd."""
    if sys.platform == "darwin":
        libc = ctypes.CDLL(None, use_errno=True)
        fn = getattr(libc, "renameatx_np", None)
        if fn is None:
            raise NotImplementedError("Darwin descriptor-relative rename swap is unavailable")
        fn.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
        fn.restype = ctypes.c_int
        if fn(parent, source.encode(), parent, target.encode(), 0x00000002) != 0:  # RENAME_SWAP
            error = ctypes.get_errno()
            raise OSError(error, os.strerror(error))
        return
    if sys.platform == "linux":
        libc = ctypes.CDLL(None, use_errno=True)
        fn = getattr(libc, "renameat2", None)
        if fn is not None:
            fn.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
            fn.restype = ctypes.c_int
            if fn(parent, source.encode(), parent, target.encode(), 2) == 0:
                return
            error = ctypes.get_errno()
            if error not in (38, 95):
                raise OSError(error, os.strerror(error))
        raise NotImplementedError("Linux rename exchange is unavailable")
    raise NotImplementedError("conditional exchange is unsupported on this platform")


def rename_noreplace(parent, source, target, destination_parent=None):
    """Atomically move source to an empty target, never overwriting target."""
    destination_parent = parent if destination_parent is None else destination_parent
    if sys.platform == "darwin":
        libc = ctypes.CDLL(None, use_errno=True)
        fn = getattr(libc, "renameatx_np", None)
        if fn is None:
            raise NotImplementedError("Darwin descriptor-relative exclusive rename is unavailable")
        fn.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
        fn.restype = ctypes.c_int
        if fn(parent, source.encode(), destination_parent, target.encode(), 0x00000004) != 0:  # RENAME_EXCL
            error = ctypes.get_errno()
            raise OSError(error, os.strerror(error))
        return
    if sys.platform == "linux":
        libc = ctypes.CDLL(None, use_errno=True)
        fn = getattr(libc, "renameat2", None)
        if fn is not None:
            fn.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
            fn.restype = ctypes.c_int
            if fn(parent, source.encode(), destination_parent, target.encode(), 1) == 0:
                return
            error = ctypes.get_errno()
            if error not in (38, 95):
                raise OSError(error, os.strerror(error))
        raise NotImplementedError("Linux exclusive rename is unavailable")
    raise NotImplementedError("conditional no-replace rename is unsupported on this platform")


def mutate_conditional_postimage(parent, target):
    fd = os.open(target, os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_size <= 0:
            raise RuntimeError("conditional postimage mutation requires a non-empty regular target")
        first = os.pread(fd, 1, 0)
        if len(first) != 1:
            raise RuntimeError("conditional postimage mutation could not read the target")
        if os.pwrite(fd, bytes([first[0] ^ 1]), 0) != 1:
            raise RuntimeError("conditional postimage mutation could not update the target")
        fsync_regular(fd)
    finally:
        os.close(fd)

def quarantine_conditional_stage(parent, stage, relative_path, expected):
    """Move a failed exchange stage to an exact, no-clobber recovery artifact."""
    for _ in range(32):
        candidate = bounded_name("cas-recovery", relative_path, ".quarantined")
        try:
            rename_noreplace(parent, stage, candidate)
        except FileExistsError:
            continue
        except FileNotFoundError as error:
            raise RecoveryRequired("conditional replacement recovery artifact is unavailable") from error
        try:
            data, info = read_at(parent, candidate)
            if (not same_identity(info, expected)
                or (expected.get("size") is not None and len(data) != expected.get("size"))
                or not same_digest(data, expected)):
                raise RuntimeError("quarantined stage descriptor or bytes changed")
            fsync_entry(parent, candidate)
            fsync_regular(parent)
        except Exception as error:
            raise RecoveryRequired(f"conditional replacement recovery artifact quarantined at {candidate}: {error}") from error
        return candidate
    raise RecoveryRequired("conditional replacement recovery artifact path could not be reserved")

def quarantine_conditional_entry(parent, name, relative_path, prefix):
    for _ in range(32):
        candidate = bounded_name(prefix, relative_path, ".quarantined")
        try:
            rename_noreplace(parent, name, candidate)
        except FileExistsError:
            continue
        except FileNotFoundError:
            return None
        fsync_regular(parent)
        return candidate
    raise RecoveryRequired("conditional replacement quarantine path could not be reserved")


def conditional_exchange_replace(parent, target, stage, expected, desired_sha, desired_size, mutate_post_exchange=False, mutate_stage_after_exchange=False, mutate_pre_exchange=False, mutate_stage_pre_exchange=False):
    """Atomically publish stage while preserving an exact target preimage."""
    try:
        observed, observed_info = read_at(parent, target)
        target_matches = same_identity(observed_info, expected) and (expected.get("size") is None or len(observed) == expected.get("size")) and same_digest(observed, expected)
        staged, staged_info = read_at(parent, stage)
        stage_receipt = {"dev": staged_info.st_dev, "ino": staged_info.st_ino, "size": len(staged), "sha256": hashlib.sha256(staged).hexdigest()}
        desired_matches = len(staged) == desired_size and same_digest(staged, {"sha256": desired_sha})
        if not target_matches or not desired_matches:
            raise RecoveryRequired("conditional replacement preimage or stage changed before atomic exchange")
        if mutate_pre_exchange:
            mutate_conditional_postimage(parent, target)
        if mutate_stage_pre_exchange:
            mutate_conditional_postimage(parent, stage)
        rename_exchange(parent, stage, target)
        displaced = stage
        displaced_info = staged_info
        if mutate_post_exchange:
            mutate_conditional_postimage(parent, target)
        if mutate_stage_after_exchange:
            mutate_conditional_postimage(parent, displaced)
        try:
            current, current_info = read_at(parent, target)
            desired_current = same_identity(current_info, {"dev": staged_info.st_dev, "ino": staged_info.st_ino}) and len(current) == desired_size and same_digest(current, {"sha256": desired_sha})
        except Exception:
            desired_current = False
        try:
            displaced_current, displaced_current_info = read_at(parent, displaced)
            displaced_current_expected = same_identity(displaced_current_info, expected) and (expected.get("size") is None or len(displaced_current) == expected.get("size")) and same_digest(displaced_current, expected)
            displaced_receipt = {"dev": displaced_current_info.st_dev, "ino": displaced_current_info.st_ino, "size": len(displaced_current), "sha256": hashlib.sha256(displaced_current).hexdigest()}
        except Exception:
            displaced_current_expected = False
            displaced_receipt = stage_receipt
        if desired_current and displaced_current_expected:
            if not remove_exact_regular(parent, displaced, displaced_receipt):
                raise RecoveryRequired("conditional replacement displaced cleanup could not be proven")
            fsync_regular(parent)
            return True, current_info
        winner = quarantine_conditional_entry(parent, target, target, "cas-recovery")
        try:
            rename_noreplace(parent, displaced, target)
        except FileExistsError as error:
            raise RecoveryRequired("conditional replacement canonical winner appeared during preimage restore") from error
        fsync_regular(parent)
        raise RecoveryRequired("conditional replacement postimage or displaced preimage changed; winner quarantined at " + str(winner or target))
    except RecoveryRequired:
        raise
    except FileNotFoundError as error:
        raise RecoveryRequired("conditional replacement entry disappeared during atomic exchange") from error
    except Exception as error:
        raise RecoveryRequired("conditional replacement failed without proving the atomic exchange result: " + str(error)) from error

def mutate_conditional_symlink(parent, target):
    os.unlink(target, dir_fd=parent)
    os.symlink("conditional-winner", target, dir_fd=parent)


def conditional_move_remove(parent, target, stage, expected, relative_path, mutate_stage_after_move=False, mutate_before_move=False, symlink_before_move=False):
    """Remove target only after its exact moved inode and bytes survive."""
    if mutate_before_move:
        mutate_conditional_postimage(parent, target)
    if symlink_before_move:
        mutate_conditional_symlink(parent, target)
    rename_noreplace(parent, target, stage)
    moved = True
    if mutate_stage_after_move:
        mutate_conditional_postimage(parent, stage)
    displaced = None
    displaced_info = None
    try:
        try:
            displaced, displaced_info = read_at(parent, stage)
        except Exception as error:
            try:
                rename_noreplace(parent, stage, target)
                moved = False
            except FileExistsError as winner_error:
                quarantine = quarantine_conditional_entry(parent, stage, relative_path, "cas-recovery") or stage
                raise RecoveryRequired(f"conditional removal found a newer canonical winner; moved entry quarantined at {quarantine}") from winner_error
            raise RecoveryRequired("conditional removal target type changed; original winner restored canonically") from error
        stage_expected = {
            "dev": displaced_info.st_dev,
            "ino": displaced_info.st_ino,
            "size": len(displaced),
            "sha256": hashlib.sha256(displaced).hexdigest(),
        }
        matches = same_identity(displaced_info, expected) and (expected.get("size") is None or len(displaced) == expected.get("size")) and same_digest(displaced, expected)
        if matches:
            fsync_entry(parent, stage)
            if not remove_exact_regular(parent, stage, stage_expected):
                raise RuntimeError("conditional removal stage cleanup could not be proven")
            fsync_regular(parent)
            return True
        try:
            rename_noreplace(parent, stage, target)
            moved = False
        except FileExistsError as error:
            quarantine = quarantine_conditional_stage(parent, stage, relative_path, stage_expected)
            raise RecoveryRequired(f"conditional removal found a newer canonical winner; moved winner quarantined at {quarantine}") from error
        raise RecoveryRequired("conditional removal target changed; original winner restored canonically")
    except RecoveryRequired:
        raise
    except Exception as error:
        if not moved:
            raise
        try:
            rename_noreplace(parent, stage, target)
            moved = False
        except FileExistsError as restore_error:
            try:
                quarantine = quarantine_conditional_stage(parent, stage, relative_path, {"dev": displaced_info.st_dev if displaced_info is not None else expected.get("dev"), "ino": displaced_info.st_ino if displaced_info is not None else expected.get("ino"), "size": len(displaced) if displaced is not None else expected.get("size"), "sha256": hashlib.sha256(displaced).hexdigest() if displaced is not None else expected.get("sha256")})
            except Exception:
                quarantine = stage
            raise RecoveryRequired(f"conditional removal winner appeared during restore; moved entry quarantined at {quarantine}") from restore_error
        raise RecoveryRequired("conditional removal failed after restoring the moved winner") from error

def fsync_entry(parent, name):
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
    try:
        fsync_regular(fd)
    finally:
        os.close(fd)

def atomic_batch(payload):
    root_fd = 3
    operations = payload.get("operations")
    if not isinstance(operations, list) or len(operations) > 8:
        raise ValueError("anchored atomic batch must contain at most 8 operations")
    failure_index = payload.get("failure_index")
    if failure_index is not None and (not isinstance(failure_index, int) or failure_index < 0):
        raise ValueError("anchored atomic batch failure index is invalid")
    preserve_backups = False
    seen = set()
    total_bytes = 0
    snapshot_bytes = 0
    stages = []
    validated = []
    try:
        for child in operations:
            root_guard(root_fd, payload)
            if not isinstance(child, dict) or child.get("op") != "write_atomic":
                raise ValueError("anchored atomic batch contains an invalid operation")
            path = child.get("path")
            if not isinstance(path, str) or path in seen:
                raise ValueError("anchored atomic batch contains a duplicate or invalid path")
            seen.add(path)
            data = base64.b64decode(child.get("bytes", ""), validate=True)
            total_bytes += len(data)
            if total_bytes > MAX_BATCH_ROLLBACK:
                raise ValueError("anchored atomic batch exceeds its byte bound")
            validated.append((path, data))

        # Preflight every target through a no-follow parent descriptor before
        # reading any existing bytes, creating directories, or staging a
        # backup/temp entry. This makes an oversized later target fail closed
        # without partial filesystem mutation.
        preflight = []
        for path, data in validated:
            root_guard(root_fd, payload)
            parent = None
            try:
                try:
                    parent, name = parent_for(root_fd, path, False)
                    try:
                        existing = stat_at(parent, name)
                    except FileNotFoundError:
                        existing = None
                except FileNotFoundError:
                    existing = None
                if existing is not None:
                    if stat.S_ISLNK(existing.st_mode) or not stat.S_ISREG(existing.st_mode):
                        raise PermissionError("anchored target is not a regular file")
                    if existing.st_size > MAX_READ:
                        raise LimitError("anchored target exceeds the per-target rollback snapshot limit")
                    snapshot_bytes += existing.st_size
                    if snapshot_bytes > MAX_BATCH_ROLLBACK:
                        raise LimitError("anchored atomic batch rollback snapshot exceeds its byte bound")
                preflight.append((path, data, existing))
            finally:
                if parent is not None:
                    os.close(parent)

        for path, data, expected in preflight:
            root_guard(root_fd, payload)
            parent, name = parent_for(root_fd, path, True)
            stage = {
                "parent": parent,
                "name": name,
                "path": path,
                "before": expected,
                "before_data": None,
                "backup": None,
                "temp": None,
                "temp_info": None,
                "size": len(data),
                "sha256": hashlib.sha256(data).hexdigest(),
                "committed": False,
                "backup_restored": False,
            }
            stages.append(stage)
            try:
                current = None
                try:
                    current = stat_at(parent, name)
                except FileNotFoundError:
                    pass
                if (expected is None) != (current is None) or (
                    expected is not None and current is not None and not same_identity(expected, current)
                ):
                    raise RuntimeError("anchored target changed before it was captured")
                if current is not None and (stat.S_ISLNK(current.st_mode) or not stat.S_ISREG(current.st_mode)):
                    raise PermissionError("anchored target is not a regular file")
                if expected is not None:
                    existing_data, existing_read_info = read_at(parent, name)
                    if not same_identity(existing_read_info, expected):
                        raise RuntimeError("anchored target changed while being captured")
                    stage["before_data"] = existing_data
                if stage["before"] is not None:
                    backup = bounded_name("batch-backup", path, ".bak")
                    os.link(name, backup, src_dir_fd=parent, dst_dir_fd=parent, follow_symlinks=False)
                    stage["backup"] = backup
                    backup_info = stat_at(parent, backup)
                    if not same_identity(backup_info, stage["before"]):
                        raise RuntimeError("anchored target changed while being backed up")
                    fsync_regular(parent)
                stage["temp"] = write_temp(parent, path, data)
                stage["temp_info"] = stat_at(parent, stage["temp"])
                fsync_regular(parent)
                root_guard(root_fd, payload)
            except Exception:
                raise
        for index, stage in enumerate(stages):
            root_guard(root_fd, payload)
            current = None
            try:
                current = stat_at(stage["parent"], stage["name"])
            except FileNotFoundError:
                pass
            if (stage["before"] is None) != (current is None) or (stage["before"] is not None and current is not None and not same_identity(stage["before"], current)):
                raise RuntimeError("anchored target changed before batch commit")
            if current is not None and (stat.S_ISLNK(current.st_mode) or not stat.S_ISREG(current.st_mode)):
                raise PermissionError("anchored target is not a regular file")
            if current is not None and stage["before_data"] is not None:
                current_data, current_read_info = read_at(stage["parent"], stage["name"])
                if not same_identity(current_read_info, stage["before"]) or current_data != stage["before_data"]:
                    raise RuntimeError("anchored target bytes changed before batch commit")
            if stage["before"] is None:
                rename_noreplace(stage["parent"], stage["temp"], stage["name"])
            else:
                before_data = stage["before_data"]
                expected = {"dev": stage["before"].st_dev, "ino": stage["before"].st_ino, "size": len(before_data), "sha256": hashlib.sha256(before_data).hexdigest()}
                committed, _ = conditional_exchange_replace(stage["parent"], stage["name"], stage["temp"], expected, stage["sha256"], stage["size"])
                if not committed:
                    raise RuntimeError("anchored target changed before batch exchange commit")
            stage["temp"] = None
            stage["committed"] = True
            fsync_regular(stage["parent"])
            root_guard(root_fd, payload)
            if failure_index == index:
                raise OSError("injected anchored atomic batch interruption")
        return {"ok": True, "results": [{"ok": True, "dev": stage["temp_info"].st_dev, "ino": stage["temp_info"].st_ino, "size": stage["size"], "sha256": stage["sha256"], "preimage": ({"kind": "absent"} if stage["before"] is None else {"kind": "file", "dev": stage["before"].st_dev, "ino": stage["before"].st_ino, "size": len(stage["before_data"]), "sha256": hashlib.sha256(stage["before_data"]).hexdigest(), "bytes": base64.b64encode(stage["before_data"]).decode("ascii")})} for stage in stages]}
    except Exception as error:
        rollback_error = None
        for stage in reversed(stages):
            if not stage["committed"]:
                continue
            try:
                root_guard(root_fd, payload)
                current = stat_at(stage["parent"], stage["name"])
                if not same_identity(current, stage["temp_info"]):
                    raise RuntimeError("anchored target changed during batch rollback")
                current_data, current_info = read_at(stage["parent"], stage["name"])
                if not same_identity(current_info, stage["temp_info"]) or len(current_data) != stage["size"] or hashlib.sha256(current_data).hexdigest() != stage["sha256"]:
                    raise RuntimeError("anchored target bytes changed during batch rollback")
                if stage["backup"] is not None:
                    if stage["before_data"] is not None:
                        restore_name = write_temp(stage["parent"], stage["path"], stage["before_data"])
                        try:
                            os.replace(restore_name, stage["backup"], src_dir_fd=stage["parent"], dst_dir_fd=stage["parent"])
                        finally:
                            cleanup_temp(stage["parent"], restore_name)
                    os.replace(stage["backup"], stage["name"], src_dir_fd=stage["parent"], dst_dir_fd=stage["parent"])
                    stage["backup_restored"] = True
                else:
                    os.unlink(stage["name"], dir_fd=stage["parent"])
                fsync_regular(stage["parent"])
                root_guard(root_fd, payload)
                stage["committed"] = False
            except Exception as restore:
                rollback_error = restore
                preserve_backups = True
                break
        if rollback_error is not None:
            raise RuntimeError("anchored atomic batch rollback failed: " + str(rollback_error))
        raise error
    finally:
        for stage in stages:
            if stage["temp"] is not None:
                cleanup_temp(stage["parent"], stage["temp"])
            if stage["backup"] is not None and not preserve_backups and not stage["backup_restored"]:
                try:
                    os.unlink(stage["backup"], dir_fd=stage["parent"])
                except Exception:
                    pass
            try:
                fsync_regular(stage["parent"])
            except Exception:
                pass
            os.close(stage["parent"])
def preimage_snapshot(parent, name):
    try:
        data, info = read_at(parent, name)
    except FileNotFoundError:
        return {"kind": "absent"}
    return {"kind": "file", "dev": info.st_dev, "ino": info.st_ino, "size": len(data), "sha256": hashlib.sha256(data).hexdigest(), "bytes": base64.b64encode(data).decode("ascii")}


def preimage_matches(parent, name, expected):
    try:
        data, info = read_at(parent, name)
    except FileNotFoundError:
        return expected.get("kind") == "absent"
    if expected.get("kind") != "file":
        return False
    return info.st_dev == expected.get("dev") and info.st_ino == expected.get("ino") and (expected.get("size") is None or len(data) == expected.get("size")) and hashlib.sha256(data).hexdigest() == expected.get("sha256")


def update_prepared_lease(parent, prepared):
    metadata = signed_document({
        "schema_version": 3,
        "token": prepared["lock_token"],
        "pid": os.getpid(),
        "start_identity": process_start_identity(os.getpid()),
        "session_id": SESSION_ID,
        "host_instance_id": CURRENT_HOST_INSTANCE_ID,
        "operation": "write_atomic" if prepared["operation"] == "prepare_write_atomic" else "write_exclusive",
        "path": "/".join(safe_segments(prepared["path"])),
        "expected": prepared["expected"],
        "desired_sha256": prepared["sha256"],
        "stage": prepared.get("stage") or prepared["temp"] or "",
        "published": prepared.get("published") is True,
        "quarantined": prepared.get("quarantined") is True,
        "recovery_policy": "quarantine_on_ambiguous_recovery",
        "postimage": prepared.get("postimage"),
        "batch_id": prepared.get("batch_id"),
        "batch_index": prepared.get("batch_index"),
        "batch_size": prepared.get("batch_size"),
        "batch_journal": prepared.get("batch_journal"),
        "root_binding": prepared.get("root_binding"),
    })
    encoded = (json.dumps(metadata, separators=(",", ":")) + "\n").encode("utf-8")
    update_name = write_temp(parent, bounded_name("prepared-lease", prepared["path"], ".tmp"), encoded)
    update_info = stat_at(parent, update_name)
    update_receipt = {"dev": update_info.st_dev, "ino": update_info.st_ino, "size": len(encoded), "sha256": hashlib.sha256(encoded).hexdigest()}
    exchanged = False
    current = None
    current_info = None
    try:
        current, current_info, owner = read_lock_observed(parent, prepared["lock_name"])
        current_receipt = {"dev": current_info.st_dev, "ino": current_info.st_ino, "size": len(current), "sha256": hashlib.sha256(current).hexdigest()}
        expected_receipt = prepared.get("lock_receipt")
        if (not verify_signed_document(owner) or owner.get("token") != prepared["lock_token"]
            or (isinstance(expected_receipt, dict) and current_receipt != expected_receipt)):
            raise RecoveryRequired("prepared lease changed before authenticated update")
        rename_exchange(parent, update_name, prepared["lock_name"])
        exchanged = True
        displaced, displaced_info = read_at(parent, update_name)
        displaced_receipt = {"dev": displaced_info.st_dev, "ino": displaced_info.st_ino, "size": len(displaced), "sha256": hashlib.sha256(displaced).hexdigest()}
        if displaced_receipt != current_receipt or displaced != current:
            try:
                observed, _ = read_at(parent, prepared["lock_name"])
            except FileNotFoundError:
                observed = None
            if observed == encoded:
                rename_exchange(parent, update_name, prepared["lock_name"])
                exchanged = False
                cleanup_temp(parent, update_name, update_receipt)
            raise RecoveryRequired("prepared lease displaced entry changed during authenticated update")
        observed, observed_info = read_at(parent, prepared["lock_name"])
        if observed != encoded:
            raise RecoveryRequired("prepared lease update was not published exactly")
        if not remove_exact_regular(parent, update_name, current_receipt):
            raise RecoveryRequired("prepared lease displaced-entry cleanup could not be proven")
        exchanged = False
        prepared["lock_receipt"] = {"dev": observed_info.st_dev, "ino": observed_info.st_ino, "size": len(observed), "sha256": hashlib.sha256(observed).hexdigest()}
        fsync_regular(parent)
    finally:
        if exchanged:
            # Preserve a foreign replacement. Only remove a temp whose bytes
            # are exactly the authenticated update we created.
            try:
                temp_data, temp_info = read_at(parent, update_name)
                if temp_data == encoded:
                    cleanup_temp(parent, update_name, {"dev": temp_info.st_dev, "ino": temp_info.st_ino, "size": len(temp_data), "sha256": hashlib.sha256(temp_data).hexdigest()})
            except Exception:
                pass
        elif current_info is not None and current is not None:
            cleanup_temp(parent, update_name, update_receipt)

def batch_journal_name(batch_id):
    return bounded_name("batch-journal", batch_id, ".json", nonce=False)


def validate_batch_manifest(batch_id, manifest, path, data, index, size):
    if not isinstance(batch_id, str) or not batch_id or len(batch_id) > 128:
        raise ValueError("prepared batch identity is invalid")
    if not isinstance(manifest, list) or not (1 <= len(manifest) <= 8):
        raise ValueError("prepared batch manifest is invalid")
    if not isinstance(index, int) or index < 0 or index >= len(manifest) or not isinstance(size, int) or size != len(manifest):
        raise ValueError("prepared batch index is invalid")
    expected = manifest[index]
    if not isinstance(expected, dict):
        raise ValueError("prepared batch manifest entry is invalid")
    canonical = "/".join(safe_segments(path))
    if expected.get("path") != canonical or expected.get("index") != index or expected.get("size") != len(data) or expected.get("sha256") != hashlib.sha256(data).hexdigest():
        raise ValueError("prepared batch manifest does not match operation")
    for position, item in enumerate(manifest):
        if not isinstance(item, dict) or item.get("index") != position or not isinstance(item.get("path"), str):
            raise ValueError("prepared batch manifest entry is invalid")
        canonical_item = "/".join(safe_segments(item["path"]))
        if canonical_item != item["path"] or not isinstance(item.get("size"), int) or item["size"] < 0 or not isinstance(item.get("sha256"), str) or len(item["sha256"]) != 64:
            raise ValueError("prepared batch manifest entry is invalid")
    if len({item["path"] for item in manifest}) != len(manifest):
        raise ValueError("prepared batch manifest contains duplicate paths")


def ensure_batch_journal(root_fd, batch_id, manifest, root_binding):
    name = batch_journal_name(batch_id)
    try:
        existing, _ = read_at(root_fd, name)
        try:
            observed = json.loads(existing.decode("utf-8"))
        except Exception as error:
            raise RecoveryRequired("prepared batch journal is unavailable") from error
        if (isinstance(observed, dict) and observed.get("state") == "finalizing"
            and observed.get("batch_id") == batch_id and verify_signed_document(observed)
            and observed.get("root_binding") == CURRENT_ROOT_BINDING):
            recover_prepared_batch(root_fd, name, observed["batch_id"])
            existing = None
        elif (not isinstance(observed, dict) or not verify_signed_document(observed)
            or observed.get("state") != "prepared" or observed.get("batch_id") != batch_id
            or observed.get("root_binding") != CURRENT_ROOT_BINDING or not isinstance(observed.get("entries"), list)
            or len(observed["entries"]) != len(manifest)):
            raise RecoveryRequired("prepared batch journal identity or manifest changed")
        if existing is not None:
            merged = [dict(item) for item in observed["entries"]]
            for index, incoming in enumerate(manifest):
                if (not isinstance(incoming, dict) or merged[index].get("path") != incoming.get("path")
                    or merged[index].get("index") != incoming.get("index") or merged[index].get("size") != incoming.get("size")
                    or merged[index].get("sha256") != incoming.get("sha256")):
                    raise RecoveryRequired("prepared batch journal identity or manifest changed")
                for key in ("expected", "postimage"):
                    if key in incoming:
                        if key in merged[index] and merged[index][key] != incoming[key]:
                            if key != "expected" or "postimage" in merged[index]:
                                raise RecoveryRequired("prepared batch journal preparation metadata changed at index " + str(index) + " key " + key)
                            candidate_parent, candidate_name = parent_for(root_fd, merged[index]["path"], False)
                            try:
                                if not target_matches_preimage(candidate_parent, candidate_name, incoming[key]):
                                    raise RecoveryRequired("prepared batch journal preparation metadata changed at index " + str(index) + " key " + key)
                            finally:
                                os.close(candidate_parent)
                        merged[index][key] = incoming[key]
            manifest = merged
        document = signed_document({"schema_version": 1, "batch_id": batch_id, "state": "prepared", "root_binding": root_binding, "entries": manifest})
        encoded = (json.dumps(document, separators=(",", ":")) + "\n").encode("utf-8")
        if existing is None:
            temp = write_temp(root_fd, name, encoded)
            try:
                rename_noreplace(root_fd, temp, name)
                temp = None
                fsync_regular(root_fd)
            finally:
                cleanup_temp(root_fd, temp)
        elif existing != encoded:
            persist_batch_journal(root_fd, name, existing, document)
        return name
    except FileNotFoundError:
        document = signed_document({"schema_version": 1, "batch_id": batch_id, "state": "prepared", "root_binding": root_binding, "entries": manifest})
        encoded = (json.dumps(document, separators=(",", ":")) + "\n").encode("utf-8")
        temp = write_temp(root_fd, name, encoded)
        try:
            rename_noreplace(root_fd, temp, name)
            temp = None
            fsync_regular(root_fd)
        finally:
            cleanup_temp(root_fd, temp)
        return name
    except RecoveryRequired:
        raise
    except Exception as error:
        raise RecoveryRequired("prepared batch journal is unavailable") from error


def read_batch_journal(root_fd, journal_name, batch_id):
    try:
        data, info = read_at(root_fd, journal_name)
    except FileNotFoundError as error:
        raise RecoveryRequired("prepared batch journal is missing") from error
    except Exception as error:
        raise RecoveryRequired("prepared batch journal is unavailable") from error
    try:
        document = json.loads(data.decode("utf-8"))
    except Exception as error:
        raise RecoveryRequired("prepared batch journal is invalid") from error
    if not verify_signed_document(document):
        raise RecoveryRequired("prepared batch journal authentication failed")
    if not isinstance(document, dict) or document.get("root_binding") != CURRENT_ROOT_BINDING:
        raise RecoveryRequired("prepared batch journal root binding changed")
    if (not isinstance(document, dict) or document.get("schema_version") != 1
        or document.get("batch_id") != batch_id or document.get("state") not in ("prepared", "finalizing") or not isinstance(document.get("entries"), list)
        or not (1 <= len(document["entries"]) <= 8)):
        raise RecoveryRequired("prepared batch journal identity or manifest is invalid")
    entries = document["entries"]
    seen = set()
    for index, entry in enumerate(entries):
        if (not isinstance(entry, dict) or entry.get("index") != index
            or not isinstance(entry.get("path"), str) or entry["path"] in seen
            or "/".join(safe_segments(entry["path"])) != entry["path"]
            or not isinstance(entry.get("size"), int) or entry["size"] < 0
            or not isinstance(entry.get("sha256"), str) or len(entry["sha256"]) != 64
            or ("postimage" in entry and (not isinstance(entry.get("postimage"), dict)
                or not isinstance(entry["postimage"].get("dev"), int)
                or not isinstance(entry["postimage"].get("ino"), int)
                or not isinstance(entry["postimage"].get("size"), int)
                or entry["postimage"].get("size") != entry["size"]
                or entry["postimage"].get("sha256") != entry["sha256"]))):
            raise RecoveryRequired("prepared batch journal entry is invalid")
        seen.add(entry["path"])
    return document, info, data


def target_matches_descriptor(parent, name, descriptor):
    try:
        data, info = read_at(parent, name)
    except Exception:
        return False
    return (isinstance(descriptor, dict) and same_identity(info, descriptor)
        and isinstance(descriptor.get("size"), int) and len(data) == descriptor.get("size")
        and isinstance(descriptor.get("sha256"), str) and hashlib.sha256(data).hexdigest() == descriptor.get("sha256"))


def target_matches_preimage(parent, name, expected):
    if not isinstance(expected, dict):
        return False
    if expected.get("kind") == "absent":
        try:
            stat_at(parent, name)
            return False
        except FileNotFoundError:
            return True
    if expected.get("kind") != "file":
        return False
    try:
        data, info = read_at(parent, name)
    except Exception:
        return False
    return same_identity(info, expected) and (expected.get("size") is None or len(data) == expected.get("size")) and same_digest(data, expected)


def release_batch_lease(parent, lock_name, token):
    try:
        data, info, owner = read_lock_observed(parent, lock_name)
    except Exception as error:
        raise RecoveryRequired("prepared batch lease is unavailable during recovery") from error
    if not verify_signed_document(owner) or owner.get("token") != token:
        raise RecoveryRequired("prepared batch lease authentication changed during recovery")
    expected = {"dev": info.st_dev, "ino": info.st_ino, "sha256": hashlib.sha256(data).hexdigest()}
    if not remove_exact_regular(parent, lock_name, expected):
        raise RecoveryRequired("prepared batch lease cleanup could not be proven")


def persist_batch_journal(root_fd, journal_name, expected_data, document):
    if not verify_signed_document(document):
        raise RecoveryRequired("prepared batch journal transition is unauthenticated")
    encoded = (json.dumps(document, separators=(",", ":")) + "\n").encode("utf-8")
    try:
        current, _ = read_at(root_fd, journal_name)
    except Exception as error:
        raise RecoveryRequired("prepared batch journal disappeared before transition") from error
    if current != expected_data:
        raise RecoveryRequired("prepared batch journal changed before transition")
    temp = write_temp(root_fd, journal_name, encoded)
    exchanged = False
    try:
        rename_exchange(root_fd, temp, journal_name)
        exchanged = True
        previous, _ = read_at(root_fd, temp)
        if previous != expected_data:
            # Restore the foreign journal and keep it authoritative for manual
            # recovery; never unlink bytes we did not authenticate.
            rename_exchange(root_fd, temp, journal_name)
            temp = None
            raise RecoveryRequired("prepared batch journal owner changed during transition")
        observed, _ = read_at(root_fd, journal_name)
        if observed != encoded:
            raise RecoveryRequired("prepared batch journal transition was not published exactly")
        os.unlink(temp, dir_fd=root_fd)
        temp = None
        fsync_regular(root_fd)
    except RecoveryRequired:
        if exchanged and temp is not None:
            try:
                rename_exchange(root_fd, temp, journal_name)
            except Exception:
                pass
        raise
    finally:
        cleanup_temp(root_fd, temp)


def mark_batch_finalizing(root_fd, journal_name, batch_id, states):
    document, _, raw = read_batch_journal(root_fd, journal_name, batch_id)
    if document.get("state") == "finalizing":
        return
    entries = []
    for state in states:
        if not target_matches_descriptor(state["parent"], state["name"], state["postimage"]):
            raise RecoveryRequired("prepared batch cannot finalize before postimage verification")
        try:
            stat_at(state["parent"], state["stage"])
        except FileNotFoundError:
            pass
        else:
            raise RecoveryRequired("prepared batch cannot finalize with a live stage")
        entry = dict(state["entry"])
        entry["postimage"] = state["postimage"]
        entries.append(entry)
    if len(entries) != len(document["entries"]):
        raise RecoveryRequired("prepared batch finalization metadata is incomplete")
    for expected, actual in zip(document["entries"], entries):
        if (expected.get("path") != actual.get("path") or expected.get("index") != actual.get("index")
            or expected.get("size") != actual.get("size") or expected.get("sha256") != actual.get("sha256")):
            raise RecoveryRequired("prepared batch finalization binding changed")
    next_document = signed_document({"schema_version": 1, "batch_id": batch_id, "state": "finalizing", "root_binding": CURRENT_ROOT_BINDING, "entries": entries})
    persist_batch_journal(root_fd, journal_name, raw, next_document)


def remove_batch_journal(root_fd, journal_name, batch_id, allow_prepared=False):
    try:
        data, info = read_at(root_fd, journal_name)
    except Exception as error:
        raise RecoveryRequired("prepared batch journal is unavailable during cleanup") from error
    try:
        document = json.loads(data.decode("utf-8"))
    except Exception as error:
        raise RecoveryRequired("prepared batch journal became invalid") from error
    if not verify_signed_document(document) or not isinstance(document, dict) or document.get("root_binding") != CURRENT_ROOT_BINDING or document.get("batch_id") != batch_id or document.get("state") not in ("prepared", "finalizing"):
        raise RecoveryRequired("prepared batch journal identity changed before cleanup")
    if document.get("state") == "prepared" and not allow_prepared:
        raise RecoveryRequired("prepared batch journal cannot be removed before finalization")
    if document.get("state") == "prepared":
        parents = []
        try:
            for entry in document.get("entries", []):
                path = entry.get("path") if isinstance(entry, dict) else None
                if not isinstance(path, str):
                    raise RecoveryRequired("prepared batch journal entry path is invalid")
                parent, name = parent_for(root_fd, path, False)
                parents.append(parent)
                for residue in (bounded_name("cas-lock", path, ".lock", nonce=False), bounded_name("cas-stage", path, ".tmp", nonce=False)):
                    try:
                        stat_at(parent, residue)
                    except FileNotFoundError:
                        continue
                    raise RecoveryRequired("prepared batch journal still has owned residue")
        finally:
            for parent in parents:
                os.close(parent)
    expected = {"dev": info.st_dev, "ino": info.st_ino, "size": len(data), "sha256": hashlib.sha256(data).hexdigest()}
    if not remove_exact_regular(root_fd, journal_name, expected):
        raise RecoveryRequired("prepared batch journal cleanup could not be proven")
    fsync_regular(root_fd)


def verify_recovery_stage(state):
    try:
        data, info = read_at(state["parent"], state["stage"])
    except FileNotFoundError as error:
        raise RecoveryRequired("prepared batch stage disappeared during recovery") from error
    except Exception as error:
        quarantine = quarantine_conditional_entry(state["parent"], state["stage"], state["entry"]["path"], "cas-recovery")
        raise RecoveryRequired("prepared batch stage type changed during recovery; stage quarantined at " + str(quarantine or state["stage"])) from error
    postimage = state["postimage"]
    exact = (stat.S_ISREG(info.st_mode) and info.st_dev == postimage.get("dev") and info.st_ino == postimage.get("ino")
        and len(data) == postimage.get("size") and hashlib.sha256(data).hexdigest() == postimage.get("sha256"))
    if exact:
        return
    quarantine = quarantine_conditional_entry(state["parent"], state["stage"], state["entry"]["path"], "cas-recovery")
    raise RecoveryRequired("prepared batch stage changed during recovery; stage quarantined at " + str(quarantine or state["stage"]))

def verify_recovery_target(state):
    if target_matches_descriptor(state["parent"], state["name"], state["postimage"]):
        return
    moved = quarantine_conditional_entry(state["parent"], state["name"], state["entry"]["path"], "cas-recovery")
    if moved is None:
        raise RecoveryRequired("prepared batch target disappeared after recovery publication")
    moved_info = stat_at(state["parent"], moved)
    postimage = state["postimage"]
    if moved_info.st_dev == postimage.get("dev") and moved_info.st_ino == postimage.get("ino"):
        fsync_regular(state["parent"])
        raise RecoveryRequired("prepared batch wrong publication quarantined after recovery")
    try:
        rename_noreplace(state["parent"], moved, state["name"])
    except FileExistsError as error:
        raise RecoveryRequired("prepared batch newer winner appeared during recovery restore; moved winner retained at " + moved) from error
    fsync_regular(state["parent"])
    raise RecoveryRequired("prepared batch newer winner preserved after recovery publication race")

def recover_prepared_batch(root_fd, journal_name, batch_id):
    if batch_id not in AUTHORIZED_BATCH_IDS:
        raise RecoveryRequired("prepared batch identity is not live in this host")
    document, _, _ = read_batch_journal(root_fd, journal_name, batch_id)
    entries = document["entries"]
    finalizing = document.get("state") == "finalizing"
    states = []
    for entry in entries:
        path = entry["path"]
        parent, name = parent_for(root_fd, path, False)
        try:
            lock_name = bounded_name("cas-lock", path, ".lock", nonce=False)
            stage_name = bounded_name("cas-stage", path, ".tmp", nonce=False)
            try:
                lock_data, lock_info, owner = read_lock_observed(parent, lock_name)
            except FileNotFoundError:
                lock_data = lock_info = owner = None
            if owner is not None:
                if not verify_signed_document(owner):
                    raise RecoveryRequired("prepared batch lease authentication failed")
                if owner.get("root_binding") != CURRENT_ROOT_BINDING:
                    raise RecoveryRequired("prepared batch lease root binding changed")
                if (owner.get("batch_id") != batch_id or owner.get("batch_journal") != journal_name
                    or owner.get("batch_index") != entry["index"] or owner.get("batch_size") != len(entries)
                    or owner.get("path") != entry["path"] or owner.get("stage") != bounded_name("cas-stage", path, ".tmp", nonce=False)
                    or owner.get("operation") != "write_atomic"):
                    raise RecoveryRequired("prepared batch lease belongs to a different transaction")
                expected = owner.get("expected")
                if expected is None and isinstance(entry.get("expected"), dict):
                    expected = entry["expected"]
                postimage = owner.get("postimage")
                if postimage is None and isinstance(entry.get("postimage"), dict):
                    postimage = entry["postimage"]
                token = owner.get("token")
                if not isinstance(token, str) or not isinstance(expected, dict):
                    raise RecoveryRequired("prepared batch lease metadata is incomplete")
                if postimage is not None and (not isinstance(postimage, dict) or postimage.get("size") != entry["size"] or postimage.get("sha256") != entry["sha256"]):
                    raise RecoveryRequired("prepared batch postimage metadata changed")
                if finalizing and (not isinstance(postimage, dict) or entry.get("postimage") != postimage):
                    raise RecoveryRequired("prepared batch finalizing postimage metadata changed")
            else:
                if not finalizing or not isinstance(entry.get("postimage"), dict):
                    # A durable prepared group must retain every exact owner
                    # lease until finalization; a missing lease is ambiguous.
                    raise RecoveryRequired("prepared batch lease is missing")
                expected = None
                postimage = entry["postimage"]
                token = None
            target_published = target_matches_descriptor(parent, name, postimage)
            target_prepared = expected is not None and target_matches_preimage(parent, name, expected)
            try:
                stage_data, stage_info = read_at(parent, stage_name)
                stage_exists = True
            except FileNotFoundError:
                stage_data = stage_info = None
                stage_exists = False
            if postimage is None and stage_exists and stat.S_ISREG(stage_info.st_mode) and len(stage_data) == entry["size"] and hashlib.sha256(stage_data).hexdigest() == entry["sha256"]:
                postimage = {"dev": stage_info.st_dev, "ino": stage_info.st_ino, "size": len(stage_data), "sha256": hashlib.sha256(stage_data).hexdigest()}
            stage_desired = stage_exists and len(stage_data) == entry["size"] and hashlib.sha256(stage_data).hexdigest() == entry["sha256"] and isinstance(postimage, dict) and same_identity(stage_info, postimage)
            stage_expected = (stage_exists and expected is not None and expected.get("kind") == "file"
                and same_identity(stage_info, expected) and (expected.get("size") is None or len(stage_data) == expected.get("size")) and same_digest(stage_data, expected))
            if finalizing and stage_exists:
                raise RecoveryRequired("prepared batch finalizing state has an unexpected stage")
            if target_published:
                if stage_exists and not stage_expected:
                    raise RecoveryRequired("prepared batch published target has an ambiguous stage")
                states.append({"entry": entry, "parent": parent, "name": name, "lock": lock_name, "stage": stage_name, "token": token, "expected": expected, "postimage": postimage, "state": "published", "lock_data": lock_data, "lock_info": lock_info})
            elif not finalizing and target_prepared and stage_desired and token is not None:
                states.append({"entry": entry, "parent": parent, "name": name, "lock": lock_name, "stage": stage_name, "token": token, "expected": expected, "postimage": postimage, "state": "prepared", "lock_data": lock_data, "lock_info": lock_info})
            else:
                raise RecoveryRequired("prepared batch target or stage is ambiguous")
        except RecoveryRequired:
            for state in states:
                try: os.close(state["parent"])
                except OSError: pass
            os.close(parent)
            raise
        except Exception as error:
            for state in states:
                try: os.close(state["parent"])
                except OSError: pass
            os.close(parent)
            raise RecoveryRequired("prepared batch entry state is ambiguous") from error
    if not finalizing and any(state["state"] == "prepared" for state in states):
        first_prepared = next(index for index, state in enumerate(states) if state["state"] == "prepared")
        if any(state["state"] == "published" for state in states[first_prepared:]):
            for state in states: os.close(state["parent"])
            raise RecoveryRequired("prepared batch publication order is ambiguous")
    try:
        if not finalizing:
            for state in states:
                if state["state"] == "prepared":
                    expected = state["expected"]
                    if expected.get("kind") == "absent":
                        verify_recovery_stage(state)
                        try:
                            rename_noreplace(state["parent"], state["stage"], state["name"])
                        except FileExistsError as error:
                            raise RecoveryRequired("prepared batch create target changed during recovery") from error
                        fsync_regular(state["parent"])
                        verify_recovery_target(state)
                    else:
                        conditional_exchange_replace(state["parent"], state["name"], state["stage"], expected, state["postimage"]["sha256"], state["postimage"]["size"])
                        fsync_regular(state["parent"])
                    state["state"] = "published"
                try:
                    stat_at(state["parent"], state["stage"])
                except FileNotFoundError:
                    pass
                else:
                    if state["expected"] is None or state["expected"].get("kind") != "file":
                        raise RecoveryRequired("prepared batch stage cleanup is ambiguous")
                    if not remove_exact_regular(state["parent"], state["stage"], state["expected"]):
                        raise RecoveryRequired("prepared batch stage cleanup could not be proven")
                    fsync_regular(state["parent"])
            for state in states:
                if not target_matches_descriptor(state["parent"], state["name"], state["postimage"]):
                    raise RecoveryRequired("prepared batch postimage verification failed")
            mark_batch_finalizing(root_fd, journal_name, batch_id, states)
        for state in states:
            if state["token"] is not None:
                release_batch_lease(state["parent"], state["lock"], state["token"])
        for state in states:
            if not target_matches_descriptor(state["parent"], state["name"], state["postimage"]):
                raise RecoveryRequired("prepared batch postimage verification failed")
        remove_batch_journal(root_fd, journal_name, batch_id)
        RECOVERED_BATCH_IDS.add(batch_id)
    finally:
        for state in states:
            os.close(state["parent"])


def prepare_write(payload):
    root_fd = 3
    op = payload.get("op")
    if op not in ("prepare_write_exclusive", "prepare_write_atomic"):
        raise ValueError("invalid prepared write operation")
    data = decode_write_payload(payload, op == "prepare_write_atomic")
    path = payload.get("path")
    if not isinstance(path, str):
        raise ValueError("prepared write path is invalid")
    parent, name = parent_for(root_fd, path, True)
    relative_path = "/".join(safe_segments(path))
    desired_sha = hashlib.sha256(data).hexdigest()
    batch_id = payload.get("batch_id")
    batch_manifest = payload.get("batch_manifest")
    batch_index = payload.get("batch_index")
    batch_size = payload.get("batch_size")
    grouped = batch_id is not None or batch_manifest is not None or batch_index is not None or batch_size is not None
    if grouped:
        validate_batch_manifest(batch_id, batch_manifest, path, data, batch_index, batch_size)
    # The lock is acquired before reading the target, so the returned preimage
    # and planned inode are one cooperating mutation transaction.
    lock_expected = preimage_snapshot(parent, name)
    lock_expected.pop("bytes", None)
    lease = None
    temp_info = None
    lock_receipt = None
    try:
        lease, recovered, lock_name, stage_name = conditional_lock(
            parent, name, relative_path, lock_expected, desired_sha, "write_atomic" if op == "prepare_write_atomic" else "write_exclusive", {"batch_id": batch_id, "batch_index": batch_index, "batch_size": batch_size, "batch_journal": batch_journal_name(batch_id)} if grouped else None)
        if recovered:
            # Recovery may have published an earlier group prefix; capture the
            # exact post-recovery target before reacquiring this lease.
            lock_expected = preimage_snapshot(parent, name)
            lock_expected.pop("bytes", None)
            lease, recovered, lock_name, stage_name = conditional_lock(
                parent, name, relative_path, lock_expected, desired_sha, "write_atomic" if op == "prepare_write_atomic" else "write_exclusive", {"batch_id": batch_id, "batch_index": batch_index, "batch_size": batch_size, "batch_journal": batch_journal_name(batch_id)} if grouped else None)
            if recovered:
                raise RuntimeError("prepared write lease could not be recovered")
        if op == "prepare_write_exclusive":
            try:
                existing = stat_at(parent, name)
                raise FileExistsError("anchored exclusive target already exists")
            except FileNotFoundError:
                pass
        if grouped and (lock_name != bounded_name("cas-lock", relative_path, ".lock", nonce=False) or stage_name != bounded_name("cas-stage", relative_path, ".tmp", nonce=False)):
            raise RecoveryRequired("prepared grouped batch cannot use a legacy lease")
        expected = preimage_snapshot(parent, name)
        if (expected.get("kind") != lock_expected.get("kind") or expected.get("dev") != lock_expected.get("dev") or expected.get("ino") != lock_expected.get("ino") or expected.get("size") != lock_expected.get("size") or expected.get("sha256") != lock_expected.get("sha256")):
            raise RuntimeError("anchored target changed while acquiring prepared lease")
        requested_expected = payload.get("expected")
        if requested_expected is not None:
            if not isinstance(requested_expected, dict):
                raise RuntimeError("anchored target changed before prepared write capture")
            if requested_expected.get("kind") == "absent":
                matches_requested = expected.get("kind") == "absent"
            elif requested_expected.get("kind", "file") == "file":
                matches_requested = (expected.get("kind") == "file"
                    and expected.get("dev") == requested_expected.get("dev")
                    and expected.get("ino") == requested_expected.get("ino")
                    and (requested_expected.get("size") is None or expected.get("size") == requested_expected.get("size"))
                    and expected.get("sha256") == requested_expected.get("sha256"))
            else:
                matches_requested = False
            if not matches_requested:
                raise RuntimeError("anchored target changed before prepared write capture")
        if op == "prepare_write_exclusive" and expected.get("kind") != "absent":
            raise FileExistsError("anchored exclusive target already exists")
        lock_data, lock_info, lock_owner = read_lock_observed(parent, lock_name)
        if not verify_signed_document(lock_owner) or lock_owner.get("token") != lease.get("token"):
            raise RecoveryRequired("prepared lease changed before stage publication")
        lock_receipt = {"dev": lock_info.st_dev, "ino": lock_info.st_ino, "size": len(lock_data), "sha256": hashlib.sha256(lock_data).hexdigest()}
        if expected.get("kind") == "file":
            # A regular-file preimage is bounded by read_at and its digest is
            # part of the exact rollback receipt.
            pass
        temp = write_named_temp(parent, stage_name, data)
        temp_info = stat_at(parent, temp)
        fsync_regular(parent)
        token = lease.get("token")
        prepared_writes[token] = {
            "parent": parent, "name": name, "path": path, "operation": op,
            "expected": expected, "temp": temp, "temp_info": temp_info,
            "size": len(data), "sha256": desired_sha, "lock_name": lock_name,
            "lock_token": token, "lock_receipt": lock_receipt,
            "batch_id": batch_id if grouped else None,
            "batch_index": batch_index if grouped else None,
            "batch_size": batch_size if grouped else None,
            "batch_journal": batch_journal_name(batch_id) if grouped else None,
            "root_binding": CURRENT_ROOT_BINDING,
            "stage": stage_name,
            "postimage": {"dev": temp_info.st_dev, "ino": temp_info.st_ino, "size": len(data), "sha256": desired_sha},
        }
        if grouped:
            conditional_kill(payload, "after_prepared_stage_before_journal")
            journal_manifest = [dict(item) for item in batch_manifest]
            journal_manifest[batch_index]["expected"] = {key: value for key, value in expected.items() if key != "bytes"}
            journal_manifest[batch_index]["postimage"] = prepared_writes[token]["postimage"]
            ensure_batch_journal(root_fd, batch_id, journal_manifest, prepared_writes[token]["root_binding"])
            conditional_kill(payload, "after_prepared_batch_journal")
        # Persist the exact preimage and intended postimage while still
        # uncommitted, so a process death between kernel publication and the
        # final lease update can be recovered without guessing ownership.
        conditional_lease_replacement(payload, prepared_writes[token])
        update_prepared_lease(parent, prepared_writes[token])
        return {"ok": True, "token": token, "preimage": expected, "dev": temp_info.st_dev, "ino": temp_info.st_ino, "size": len(data), "sha256": desired_sha}
    except Exception:
        if lease is not None:
            if temp_info is not None:
                try: cleanup_temp(parent, stage_name, {"dev": temp_info.st_dev, "ino": temp_info.st_ino, "size": len(data), "sha256": desired_sha})
                except Exception: pass
            try: release_conditional_lock(parent, lock_name, lease.get("token"))
            except Exception: pass
        os.close(parent)
        raise


def ack_prepared_write(payload):
    token = payload.get("token")
    prepared = prepared_writes.get(token)
    if prepared is None:
        # ACK replay after a successful commit is intentionally idempotent.
        return {"ok": True, "acknowledged": False, "already": True}
    if not prepared.get("published"):
        raise RuntimeError("prepared write cannot be acknowledged before publication")
    parent = prepared["parent"]
    batch_id = prepared.get("batch_id")
    if batch_id is not None:
        prepared["acknowledged"] = True
        group = [candidate for candidate in prepared_writes.values() if candidate.get("batch_id") == batch_id and candidate.get("batch_journal") == prepared.get("batch_journal")]
        if not all(candidate.get("acknowledged") is True for candidate in group):
            return {"ok": True, "acknowledged": True}
        try:
            for candidate in group:
                verify_prepared_target(candidate)
                conditional_pre_ack_mutation(payload, candidate)
            finalizing_states = []
            for candidate in sorted(group, key=lambda item: item.get("batch_index", 0)):
                finalizing_states.append({"entry": {"path": "/".join(safe_segments(candidate["path"])), "index": candidate["batch_index"], "size": candidate["size"], "sha256": candidate["sha256"]}, "parent": candidate["parent"], "name": candidate["name"], "stage": candidate["stage"], "postimage": candidate["postimage"]})
            mark_batch_finalizing(3, prepared["batch_journal"], batch_id, finalizing_states)
            for index, candidate in enumerate(finalizing_states):
                owner = next(item for item in group if item.get("batch_index") == candidate["entry"]["index"])
                verify_prepared_target(owner)
                release_batch_lease(candidate["parent"], owner["lock_name"], owner["lock_token"])
                if index == 0:
                    conditional_kill(payload, "after_prepared_batch_first_lease_release")
            remove_batch_journal(3, prepared["batch_journal"], batch_id)
            for candidate in group:
                prepared_writes.pop(candidate["lock_token"], None)
                if candidate["lock_token"] != token:
                    os.close(candidate["parent"])
            return {"ok": True, "acknowledged": True}
        finally:
            if token not in prepared_writes:
                os.close(parent)
    try:
        verify_prepared_target(prepared)
        conditional_pre_ack_mutation(payload, prepared)
        verify_prepared_target(prepared)
        lock_data, lock_info, owner = read_lock_observed(parent, prepared["lock_name"])
        if owner.get("token") != token:
            raise RuntimeError("prepared write lease was replaced before acknowledgement")
        cleanup_temp(parent, prepared.get("backup"))
        release_conditional_lock(parent, prepared["lock_name"], token)
        fsync_regular(parent)
        prepared_writes.pop(token, None)
        return {"ok": True, "acknowledged": True}
    finally:
        if token not in prepared_writes:
            os.close(parent)


def abort_prepared_stage_exact(prepared):
    stage = prepared.get("temp")
    if stage is None:
        return
    expected = prepared.get("temp_info")
    if not isinstance(expected, os.stat_result):
        raise RecoveryRequired("prepared write abort has no owned stage descriptor")
    try:
        info = stat_at(prepared["parent"], stage)
    except FileNotFoundError:
        return
    if not stat.S_ISREG(info.st_mode) or info.st_dev != expected.st_dev or info.st_ino != expected.st_ino:
        raise RecoveryRequired("prepared write abort found a foreign stage")
    if not remove_exact_regular(prepared["parent"], stage, {"dev": expected.st_dev, "ino": expected.st_ino, "size": prepared["size"], "sha256": prepared["sha256"]}):
        raise RecoveryRequired("prepared write abort stage cleanup could not be proven")

def abort_prepared_write(payload):
    token = payload.get("token")
    prepared = prepared_writes.get(token)
    if prepared is None:
        return {"ok": True, "aborted": False}
    parent = prepared["parent"]
    try:
        if prepared.get("published") or prepared.get("quarantined"):
            if not prepared.get("quarantined"):
                try:
                    rollback_prepared_publication(prepared)
                except RuntimeError:
                    pass
            if payload.get("release_published") is True:
                cleanup_temp(parent, prepared.get("backup"))
                release_conditional_lock(parent, prepared["lock_name"], prepared["lock_token"])
                fsync_regular(parent)
                prepared_writes.pop(token, None)
                if prepared.get("batch_id") is not None and not any(candidate.get("batch_id") == prepared.get("batch_id") for candidate in prepared_writes.values()):
                    remove_batch_journal(3, prepared["batch_journal"], prepared["batch_id"], True)
            return {"ok": True, "aborted": False, "quarantined": True}
        abort_prepared_stage_exact(prepared)
        cleanup_temp(parent, prepared.get("backup"))
        release_conditional_lock(parent, prepared["lock_name"], prepared["lock_token"])
        fsync_regular(parent)
        prepared_writes.pop(token, None)
        if prepared.get("batch_id") is not None and not any(candidate.get("batch_id") == prepared.get("batch_id") for candidate in prepared_writes.values()):
            remove_batch_journal(3, prepared["batch_journal"], prepared["batch_id"], True)
    finally:
        if token not in prepared_writes:
            os.close(parent)
    return {"ok": True, "aborted": True}


def rollback_prepared_publication(prepared):
    # A failed create must not leave either its desired bytes or a mutated
    # publication under the canonical name. Move that entry aside without
    # clobbering a newer winner, then retain the exact lease for reconciliation.
    if isinstance(prepared.get("expected"), dict) and prepared["expected"].get("kind") == "absent":
        moved = None
        try:
            moved = quarantine_conditional_entry(prepared["parent"], prepared["name"], prepared["path"], "cas-recovery")
        except Exception:
            moved = None
        if moved is not None:
            moved_info = stat_at(prepared["parent"], moved)
            postimage = prepared.get("postimage") or prepared.get("temp_info")
            same_publication = (isinstance(postimage, dict) and moved_info.st_dev == postimage.get("dev") and moved_info.st_ino == postimage.get("ino"))
            if not same_publication:
                try:
                    rename_noreplace(prepared["parent"], moved, prepared["name"])
                    moved = None
                except FileExistsError:
                    pass
        prepared["published"] = True
        prepared["quarantined"] = moved is not None
    else:
        # No descriptor-relative expected-unlink CAS exists for an existing
        # preimage; preserve it and make the exact lease durable.
        prepared["published"] = True
        prepared["quarantined"] = True
    descriptor = prepared.get("postimage")
    if not isinstance(descriptor, dict):
        info = prepared["temp_info"]
        descriptor = {"dev": info.st_dev, "ino": info.st_ino, "size": prepared["size"], "sha256": prepared["sha256"]}
        prepared["postimage"] = descriptor
    update_prepared_lease(prepared["parent"], prepared)
    raise RuntimeError("prepared write rollback quarantined: target preserved for WAL reconciliation")


def verify_prepared_stage(prepared):
    stage = prepared.get("temp")
    if not isinstance(stage, str) or not stage:
        raise RecoveryRequired("prepared write stage is missing before commit")
    try:
        data, info = read_at(prepared["parent"], stage)
    except FileNotFoundError as error:
        raise RecoveryRequired("prepared write stage disappeared before commit") from error
    expected = prepared.get("temp_info")
    desired = {"dev": info.st_dev, "ino": info.st_ino, "size": len(data), "sha256": hashlib.sha256(data).hexdigest()}
    exact = (isinstance(expected, os.stat_result)
        and stat.S_ISREG(info.st_mode)
        and info.st_dev == expected.st_dev and info.st_ino == expected.st_ino
        and len(data) == prepared.get("size") and desired["sha256"] == prepared.get("sha256"))
    if exact:
        return
    quarantine = quarantine_conditional_entry(prepared["parent"], stage, prepared["path"], "cas-recovery")
    raise RecoveryRequired("prepared write stage changed before commit; stage quarantined at " + str(quarantine or stage))

def mutate_prepared_target_same_inode(prepared):
    data, _ = read_at(prepared["parent"], prepared["name"])
    mutated = bytes((byte ^ 0xff) for byte in data) if data else b"x"
    fd = os.open(prepared["name"], os.O_WRONLY, dir_fd=prepared["parent"])
    try:
        os.ftruncate(fd, len(mutated))
        written = 0
        while written < len(mutated):
            written += os.write(fd, mutated[written:])
        os.fsync(fd)
    finally:
        os.close(fd)

def conditional_pre_ack_mutation(payload, prepared):
    if payload.get("test_prepared_post_verify_mutation") and not prepared.get("_ack_mutated"):
        prepared["_ack_mutated"] = True
        mutate_prepared_target_same_inode(prepared)

def verify_prepared_target(prepared):
    try:
        data, info = read_at(prepared["parent"], prepared["name"])
    except FileNotFoundError as error:
        raise RecoveryRequired("prepared write target disappeared after publication") from error
    expected = prepared.get("temp_info")
    exact = (isinstance(expected, os.stat_result) and stat.S_ISREG(info.st_mode)
        and info.st_dev == expected.st_dev and info.st_ino == expected.st_ino
        and len(data) == prepared.get("size") and hashlib.sha256(data).hexdigest() == prepared.get("sha256"))
    if exact:
        return
    actual = {"dev": info.st_dev, "ino": info.st_ino, "size": len(data), "sha256": hashlib.sha256(data).hexdigest()}
    moved = quarantine_conditional_entry(prepared["parent"], prepared["name"], prepared["path"], "cas-recovery")
    if moved is None:
        raise RecoveryRequired("prepared write target disappeared after publication")
    moved_data, moved_info = read_at(prepared["parent"], moved)
    moved_is_our_publication = (isinstance(expected, os.stat_result) and moved_info.st_dev == expected.st_dev and moved_info.st_ino == expected.st_ino)
    if not moved_is_our_publication:
        try:
            rename_noreplace(prepared["parent"], moved, prepared["name"])
        except FileExistsError as error:
            raise RecoveryRequired("prepared write newer winner appeared during target restore; moved winner retained at " + moved) from error
        fsync_regular(prepared["parent"])
        raise RecoveryRequired("prepared write newer winner preserved after publication race")
    prepared["published"] = True
    prepared["quarantined"] = True
    prepared["postimage"] = actual
    update_prepared_lease(prepared["parent"], prepared)
    raise RecoveryRequired("prepared write target descriptor changed after publication; target quarantined at " + moved)

def commit_prepared_write(payload):
    token = payload.get("token")
    prepared = prepared_writes.get(token)
    if not isinstance(token, str) or prepared is None:
        raise FileNotFoundError("prepared write lease is missing")
    parent = prepared["parent"]
    if prepared.get("published"):
        descriptor = prepared["temp_info"]
        return {"ok": True, "ack_required": True, "dev": descriptor.st_dev, "ino": descriptor.st_ino, "size": prepared["size"], "sha256": prepared["sha256"]}
    committed = False
    try:
        root_guard(3, payload)
        try:
            lock_data, lock_info, owner = read_lock_observed(parent, prepared["lock_name"])
        except FileNotFoundError:
            raise RuntimeError("prepared write lease disappeared")
        if owner.get("token") != token:
            raise RuntimeError("prepared write lease was replaced")
        if not preimage_matches(parent, prepared["name"], prepared["expected"]):
            raise RuntimeError("anchored target changed before prepared write commit")
        verify_prepared_stage(prepared)
        if prepared["operation"] == "prepare_write_exclusive":
            os.link(prepared["temp"], prepared["name"], src_dir_fd=parent, dst_dir_fd=parent, follow_symlinks=False)
            os.unlink(prepared["temp"], dir_fd=parent)
        elif prepared["expected"].get("kind") == "absent":
            # A create must never overwrite a target that appeared after the
            # preimage check.
            rename_noreplace(parent, prepared["temp"], prepared["name"])
        else:
            cas_committed = False
            try:
                cas_committed, _ = conditional_exchange_replace(
                    parent,
                    prepared["name"],
                    prepared["temp"],
                    prepared["expected"],
                    prepared["sha256"],
                    prepared["size"],
                )
            except Exception:
                # The exchange may have published before a later fsync/error;
                # retain ownership only when the exact desired postimage is
                # observable. Otherwise leave the competing target untouched.
                try:
                    observed, observed_info = read_at(parent, prepared["name"])
                    committed = same_identity(observed_info, prepared["temp_info"]) and len(observed) == prepared["size"] and hashlib.sha256(observed).hexdigest() == prepared["sha256"]
                except FileNotFoundError:
                    committed = False
                raise
            if not cas_committed:
                raise RuntimeError("anchored target changed before prepared exchange commit")
        committed = True
        verify_prepared_target(prepared)
        conditional_kill(payload, "after_prepared_publication_before_lease")
        prepared["temp"] = None
        conditional_error(payload, "after_prepared_publish_error")
        fsync_regular(parent)
        descriptor = prepared["temp_info"]
        prepared["published"] = True
        prepared["postimage"] = {"dev": descriptor.st_dev, "ino": descriptor.st_ino, "size": prepared["size"], "sha256": prepared["sha256"]}
        update_prepared_lease(parent, prepared)
        return {"ok": True, "ack_required": True, "dev": descriptor.st_dev, "ino": descriptor.st_ino, "size": prepared["size"], "sha256": prepared["sha256"]}
    except Exception:
        if committed:
            # fsync or descriptor publication failures happen after visibility;
            # restore the exact preimage while this target lease is held.
            try:
                rollback_prepared_publication(prepared)
                cleanup_temp(parent, prepared.get("temp"))
                release_conditional_lock(parent, prepared["lock_name"], prepared["lock_token"])
                prepared_writes.pop(token, None)
            except Exception as rollback_error:
                raise RuntimeError("prepared write rollback failed: " + str(rollback_error))
        raise
    finally:
        if token not in prepared_writes:
            os.close(parent)


def inherit_operation_context(parent, child):
    nested = dict(child)
    for key in ("root_dev", "root_ino", "_root_path_digest", "_live_batch_ids", "_live_helper_session_ids", "_host_instance_id", "_session_id"):
        if key in parent:
            nested[key] = parent[key]
    return nested


def operation(payload):
    global AUTHORIZED_BATCH_IDS, CURRENT_ROOT_BINDING, LIVE_HELPER_SESSION_IDS
    helper_sessions = payload.get("_live_helper_session_ids", [])
    if not isinstance(helper_sessions, list) or len(helper_sessions) > 64 or any(not isinstance(value, str) or not value for value in helper_sessions): raise ValueError("live helper session authorization is invalid")
    LIVE_HELPER_SESSION_IDS = set(helper_sessions)
    host_instance_id = payload.get("_host_instance_id")
    if not isinstance(host_instance_id, str) or not host_instance_id or len(host_instance_id) > 128: raise ValueError("host instance identity is invalid")
    global CURRENT_HOST_INSTANCE_ID
    CURRENT_HOST_INSTANCE_ID = host_instance_id
    live_ids = payload.get("_live_batch_ids", [])
    if not isinstance(live_ids, list) or any(not isinstance(value, str) for value in live_ids):
        raise ValueError("live batch authorization is invalid")
    AUTHORIZED_BATCH_IDS = set(live_ids)
    root_fd = 3
    root_guard(root_fd, payload)
    root_digest = payload.get("_root_path_digest")
    if not isinstance(root_digest, str) or len(root_digest) != 64:
        raise ValueError("root path identity is invalid")
    CURRENT_ROOT_BINDING = {"dev": payload["root_dev"], "ino": payload["root_ino"], "path_digest": root_digest}
    op = payload.get("op")
    path = payload.get("path", "")
    if op in ("prepare_write_exclusive", "prepare_write_atomic"):
        return prepare_write(payload)
    if op == "commit_prepared_write":
        return commit_prepared_write(payload)
    if op == "ack_prepared_write":
        return ack_prepared_write(payload)
    if op == "abort_prepared_write":
        return abort_prepared_write(payload)
    if op == "recover_prepared_batch":
        batch_id = payload.get("batch_id")
        if not isinstance(batch_id, str):
            raise ValueError("prepared batch identity is invalid")
        try:
            recover_prepared_batch(root_fd, batch_journal_name(batch_id), batch_id)
        except RecoveryRequired as error:
            if str(error) == "prepared batch lease is missing":
                return recover_partial_prepared_batch(root_fd, batch_journal_name(batch_id), batch_id)
            if str(error) == "prepared batch journal is missing":
                entries = payload.get("entries")
                if not isinstance(entries, list) or not entries:
                    raise RecoveryRequired("prepared batch journal is missing and manifest is unavailable")
                recover_missing_batch_residue(root_fd, batch_journal_name(batch_id), batch_id, entries)
                return {"ok": True, "recovered": False, "absent_clean": True, "aborted": True, "batch_id": batch_id}
            raise
        return {"ok": True, "recovered": True}
    if op == "batch_atomic":
        return atomic_batch(payload)
    if op == "batch":
        operations = payload.get("operations")
        if not isinstance(operations, list) or len(operations) > 16:
            raise ValueError("anchored state batch must contain at most 16 operations")
        results = []
        failure_index = payload.get("failure_index")
        if failure_index is not None and (not isinstance(failure_index, int) or failure_index < 0):
            raise ValueError("anchored state batch failure index is invalid")
        for index, child in enumerate(operations):
            if not isinstance(child, dict) or child.get("op") in (None, "batch"):
                raise ValueError("anchored state batch contains an invalid operation")
            nested = inherit_operation_context(payload, child)
            results.append(operation(nested))
            if failure_index == index:
                raise RuntimeError("injected anchored state batch interruption")
        return {"ok": True, "results": results}
    if op == "lock_acquire":
        candidate = payload.get("candidate")
        target = payload.get("target")
        data = base64.b64decode(payload.get("bytes", ""), validate=True)
        grace_ms = payload.get("ownerless_grace_ms")
        if grace_ms is not None and (not isinstance(grace_ms, (int, float)) or grace_ms <= 0):
            raise ValueError("ownerless lock grace is invalid")
        acquired = False
        try:
            operation(inherit_operation_context(payload, {"op": "write_exclusive", "path": candidate, "bytes": base64.b64encode(data).decode("ascii")}))
            try:
                operation(inherit_operation_context(payload, {"op": "link_exclusive", "source": candidate, "destination": target}))
                acquired = True
            except FileExistsError:
                if grace_ms is not None:
                    target_parent, target_name = parent_for(root_fd, target, False)
                    try:
                        if remove_legacy_ownerless_directory(target_parent, target_name, grace_ms):
                            try:
                                operation(inherit_operation_context(payload, {"op": "link_exclusive", "source": candidate, "destination": target}))
                                acquired = True
                            except FileExistsError:
                                acquired = False
                    finally:
                        os.close(target_parent)
            return {"ok": True, "acquired": acquired}
        finally:
            try:
                operation(inherit_operation_context(payload, {"op": "remove", "path": candidate}))
            except FileNotFoundError:
                pass
    if op == "lock_release":
        target = payload.get("target")
        expected_token = payload.get("token")
        parent, name = parent_for(root_fd, target, False)
        try:
            try:
                data, info = read_at(parent, name)
            except FileNotFoundError:
                return {"ok": True, "released": False}
            try:
                owner = json.loads(data.decode("utf-8"))
            except Exception:
                return {"ok": True, "released": False}
            if not isinstance(owner, dict) or owner.get("token") != expected_token:
                return {"ok": True, "released": False}
            expected = {"dev": info.st_dev, "ino": info.st_ino, "sha256": hashlib.sha256(data).hexdigest()}
            return {"ok": True, "released": remove_exact_regular(parent, name, expected)}
        finally:
            os.close(parent)
    if op == "ensure_directory":
        parent = parent_dir(root_fd, path, True)
        os.close(parent)
        return {"ok": True}
    if op == "exists":
        try:
            parent, name = parent_for(root_fd, path, False)
        except FileNotFoundError:
            return {"ok": True, "exists": False}
        try:
            try:
                info = stat_at(parent, name)
            except FileNotFoundError:
                return {"ok": True, "exists": False}
            kind = "symlink" if stat.S_ISLNK(info.st_mode) else "file" if stat.S_ISREG(info.st_mode) else "directory" if stat.S_ISDIR(info.st_mode) else "other"
            return {"ok": True, "exists": True, "kind": kind, "mode": stat.S_IMODE(info.st_mode), "size": info.st_size, "dev": info.st_dev, "ino": info.st_ino, "mtime_ms": info.st_mtime_ns // 1000000, "ctime_ms": info.st_ctime_ns // 1000000}
        finally:
            os.close(parent)
    if op == "list_batch":
        parent = parent_dir(root_fd, path, False)
        try:
            max_entries = payload.get("max_entries")
            max_name_bytes = payload.get("max_name_bytes")
            if not isinstance(max_entries, int) or max_entries <= 0 or max_entries > MAX_DIRECTORY_ENTRIES or not isinstance(max_name_bytes, int) or max_name_bytes <= 0 or max_name_bytes > MAX_DIRECTORY_NAME_BYTES:
                raise ValueError("bounded directory batch limits are invalid")
            names = []
            work = 0
            # Read no more than max_entries from the OS iterator. Unlike the
            # immutable-journal page operation, this deliberately does not
            # sort or scan ahead: destructive consumers remove this batch and
            # call again on the next tick.
            with os.scandir(parent) as entries:
                for _ in range(max_entries):
                    entry = next(entries, None)
                    if entry is None:
                        break
                    name_bytes = len(entry.name.encode("utf-8"))
                    if name_bytes > max_name_bytes or work + name_bytes > max_name_bytes:
                        if not names:
                            raise LimitError("bounded directory batch exceeded name-byte limit")
                        break
                    names.append(entry.name)
                    work += name_bytes
            return {"ok": True, "names": names}
        finally:
            os.close(parent)
    if op == "discard_batch":
        names = payload.get("names")
        rejected = payload.get("rejected")
        max_entries = payload.get("max_entries")
        max_name_bytes = payload.get("max_name_bytes")
        if not isinstance(names, list) or not isinstance(max_entries, int) or max_entries <= 0 or max_entries > MAX_DIRECTORY_ENTRIES or len(names) > max_entries or not isinstance(max_name_bytes, int) or max_name_bytes <= 0 or max_name_bytes > MAX_DIRECTORY_NAME_BYTES:
            raise ValueError("bounded discard batch limits are invalid")
        safe_segments(rejected)
        if any(not isinstance(name, str) or len(safe_segments(name)) != 1 for name in names):
            raise ValueError("bounded discard batch entry name is invalid")
        if sum(len(name.encode("utf-8")) for name in names) > max_name_bytes:
            raise LimitError("bounded discard batch exceeded name-byte limit")
        parent = None
        rejected_parent = None
        moved = 0
        try:
            parent = parent_dir(root_fd, path, False)
            try:
                rejected_parent = parent_dir(root_fd, rejected, True)
                for name in names:
                    try:
                        stat_at(parent, name)
                    except FileNotFoundError:
                        continue
                    destination_path = "/".join(safe_segments(rejected, allow_empty=True) + [name])
                    destination = bounded_name("discard", destination_path, ".discarded")
                    for _ in range(8):
                        try:
                            rename_noreplace(parent, name, destination, rejected_parent)
                            moved += 1
                            break
                        except FileExistsError:
                            destination = bounded_name("discard", destination_path, ".discarded")
            finally:
                if rejected_parent is not None:
                    os.close(rejected_parent)
        finally:
            if parent is not None:
                os.close(parent)
        return {"ok": True, "moved": moved}
    if op == "read_prefix":
        parent, name = parent_for(root_fd, path, False)
        try:
            max_read = payload.get("max_read", MAX_READ)
            if not isinstance(max_read, int) or max_read <= 0 or max_read > MAX_READ:
                raise ValueError("bounded prefix read limit is invalid")
            data, info = read_prefix_at(parent, name, max_read)
            return {"ok": True, "bytes": base64.b64encode(data).decode("ascii"), "dev": info.st_dev, "ino": info.st_ino}
        finally:
            os.close(parent)
    if op == "list":
        parent = parent_dir(root_fd, path, False)
        try:
            max_entries = payload.get("max_entries")
            max_name_bytes = payload.get("max_name_bytes")
            if not isinstance(max_entries, int) or max_entries <= 0 or max_entries > MAX_DIRECTORY_ENTRIES or not isinstance(max_name_bytes, int) or max_name_bytes <= 0 or max_name_bytes > MAX_DIRECTORY_NAME_BYTES:
                raise ValueError("bounded directory limits are invalid")
            names = []
            work = 0
            with os.scandir(parent) as entries:
                for entry in entries:
                    if len(names) >= max_entries:
                        raise LimitError("bounded directory enumeration exceeded entry limit")
                    name_bytes = len(entry.name.encode("utf-8"))
                    if work + name_bytes > max_name_bytes:
                        raise LimitError("bounded directory enumeration exceeded name-byte limit")
                    names.append(entry.name)
                    work += name_bytes
            return {"ok": True, "names": names}
        finally:
            os.close(parent)
    if op == "read":
        parent, name = parent_for(root_fd, path, False)
        try:
            max_read = payload.get("max_read", MAX_READ)
            if not isinstance(max_read, int) or max_read <= 0 or max_read > MAX_READ:
                raise ValueError("bounded read limit is invalid")
            data, info = read_at(parent, name, max_read)
            return {"ok": True, "bytes": base64.b64encode(data).decode("ascii"), "dev": info.st_dev, "ino": info.st_ino, "size": info.st_size, "mtime_ms": info.st_mtime_ns // 1_000_000, "ctime_ms": info.st_ctime_ns // 1_000_000}
        finally:
            os.close(parent)
    if op == "read_batch":
        names = payload.get("names")
        max_entries = payload.get("max_entries")
        max_name_bytes = payload.get("max_name_bytes")
        max_read = payload.get("max_read", MAX_READ)
        max_total_bytes = payload.get("max_total_bytes", 2 * 1024 * 1024)
        if not isinstance(names, list) or not isinstance(max_entries, int) or max_entries <= 0 or max_entries > MAX_DIRECTORY_ENTRIES or len(names) > max_entries or not isinstance(max_name_bytes, int) or max_name_bytes <= 0 or max_name_bytes > MAX_DIRECTORY_NAME_BYTES or not isinstance(max_read, int) or max_read <= 0 or max_read > MAX_READ or not isinstance(max_total_bytes, int) or max_total_bytes <= 0 or max_total_bytes > 2 * 1024 * 1024:
            raise ValueError("bounded read batch limits are invalid")
        if any(not isinstance(name, str) or len(safe_segments(name)) != 1 for name in names):
            raise ValueError("bounded read batch entry name is invalid")
        if sum(len(name.encode("utf-8")) for name in names) > max_name_bytes:
            raise LimitError("bounded read batch exceeded name-byte limit")
        parent = parent_dir(root_fd, path, False)
        records = []
        failed = []
        remaining = []
        total_bytes = 0
        try:
            for index, name in enumerate(names):
                try:
                    data, info = read_at(parent, name, max_read)
                except FileNotFoundError:
                    continue
                except Exception:
                    failed.append(name)
                    continue
                if total_bytes + len(data) > max_total_bytes:
                    remaining.extend(names[index:])
                    break
                total_bytes += len(data)
                records.append({"name": name, "bytes": base64.b64encode(data).decode("ascii"), "dev": info.st_dev, "ino": info.st_ino})
        finally:
            os.close(parent)
        return {"ok": True, "records": records, "failed": failed, "remaining": remaining}
    if op in ("write_exclusive", "write_atomic"):
        data = decode_write_payload(payload, op == "write_atomic")
        parent, name = parent_for(root_fd, path, True)
        relative_path = "/".join(safe_segments(path))
        temp = None
        try:
            try:
                existing = stat_at(parent, name)
                if stat.S_ISLNK(existing.st_mode) or (not stat.S_ISREG(existing.st_mode) and not stat.S_ISDIR(existing.st_mode)):
                    raise PermissionError("anchored target is unsafe")
                if op == "write_exclusive":
                    raise FileExistsError("anchored exclusive target already exists")
            except FileNotFoundError:
                pass
            temp = write_temp(parent, relative_path, data)
            temp_info = stat_at(parent, temp)
            if op == "write_exclusive":
                os.link(temp, name, src_dir_fd=parent, dst_dir_fd=parent, follow_symlinks=False)
                os.unlink(temp, dir_fd=parent)
                temp = None
            else:
                os.replace(temp, name, src_dir_fd=parent, dst_dir_fd=parent)
                temp = None
            try:
                os.fsync(parent)
            except OSError as exc:
                if getattr(exc, "errno", None) not in (22, 95):
                    raise
            return {"ok": True, "dev": temp_info.st_dev, "ino": temp_info.st_ino, "size": len(data), "sha256": hashlib.sha256(data).hexdigest()}
        finally:
            cleanup_temp(parent, temp)
            os.close(parent)
    if op in ("replace_if_matches", "remove_if_matches"):
        expected = payload.get("expected")
        if (not isinstance(expected, dict) or not isinstance(expected.get("dev"), int) or not isinstance(expected.get("ino"), int)
            or not isinstance(expected.get("sha256"), str)
            or (expected.get("size") is not None and (not isinstance(expected.get("size"), int) or expected.get("size") < 0))):
            raise ValueError("conditional expectation is invalid")
        operation_name = "replace" if op == "replace_if_matches" else "remove"
        desired = base64.b64decode(payload.get("bytes", ""), validate=True) if op == "replace_if_matches" else b""
        desired_sha = hashlib.sha256(desired).hexdigest()
        parent, name = parent_for(root_fd, path, False)
        relative_path = "/".join(safe_segments(path))
        lease = None
        temp = None
        try:
            lease, recovered, lock_name, stage_name = conditional_lock(parent, name, relative_path, expected, desired_sha, operation_name)
            if recovered:
                if operation_name == "replace":
                    recovered_data, recovered_info = read_at(parent, name)
                    if hashlib.sha256(recovered_data).hexdigest() != desired_sha:
                        raise RuntimeError("recovered conditional replacement has unexpected bytes")
                    return {"ok": True, "recovered": True, "preimage": {"kind": "file", "dev": recovered_info.st_dev, "ino": recovered_info.st_ino, "size": len(recovered_data), "sha256": hashlib.sha256(recovered_data).hexdigest(), "bytes": base64.b64encode(recovered_data).decode("ascii")}, "dev": recovered_info.st_dev, "ino": recovered_info.st_ino, "size": len(recovered_data), "sha256": desired_sha}
                return {"ok": True, "recovered": True}
            conditional_crash(payload, "after_lock")
            old_data, old_info = read_at(parent, name)
            if not same_identity(old_info, expected) or (expected.get("size") is not None and len(old_data) != expected.get("size")) or not same_digest(old_data, expected):
                raise RuntimeError("anchored target changed before compare-and-swap")
            conditional_crash(payload, "after_verification")
            if op == "replace_if_matches":
                temp = write_named_temp(parent, stage_name, desired)
            conditional_crash(payload, "after_stage")
            # The inherited descriptor helper performs the mutation with one
            # kernel operation. Replace exchanges stage and target, then checks
            # the displaced inode; remove moves target to stage with a no-
            # replace rename. A mismatch is rolled back without overwriting an
            # interloper, and a rollback collision retains both entries.
            if op == "replace_if_matches":
                # conditional_exchange_replace owns exact stage cleanup after the
                # exchange and quarantines failed postimages for recovery.
                temp = None
                try:
                    committed, descriptor = conditional_exchange_replace(parent, name, stage_name, expected, desired_sha, len(desired), payload.get("test_post_exchange_mutation") is True, payload.get("test_post_exchange_stage_mutation") is True, payload.get("test_pre_exchange_mutation") is True, payload.get("test_stage_pre_exchange_mutation") is True)
                except Exception:
                    raise
            else:
                committed = conditional_move_remove(parent, name, stage_name, expected, relative_path, payload.get("test_post_exchange_stage_mutation") is True, payload.get("test_pre_move_mutation") is True, payload.get("test_pre_move_symlink") is True)
                descriptor = None
            if not committed:
                raise RuntimeError("anchored target changed before conditional commit")
            conditional_crash(payload, "after_replace")
            conditional_crash(payload, "before_cleanup")
            if operation_name == "replace" and descriptor is None:
                raise RuntimeError("conditional replacement completed without an operation descriptor")
            return {"ok": True, "preimage": {"kind": "file", "dev": old_info.st_dev, "ino": old_info.st_ino, "size": len(old_data), "sha256": hashlib.sha256(old_data).hexdigest(), "bytes": base64.b64encode(old_data).decode("ascii")}, **({"dev": descriptor.st_dev, "ino": descriptor.st_ino, "size": len(desired), "sha256": desired_sha} if descriptor is not None else {})}
        finally:
            cleanup_temp(parent, temp)
            if lease is not None:
                release_conditional_lock(parent, lock_name, lease.get("token"))
            os.close(parent)
    if op == "link_exclusive":
        source = payload.get("source")
        destination = payload.get("destination")
        src_parent, src_name = parent_for(root_fd, source, False)
        try:
            dst_parent, dst_name = parent_for(root_fd, destination, False)
            try:
                os.link(src_name, dst_name, src_dir_fd=src_parent, dst_dir_fd=dst_parent, follow_symlinks=False)
                return {"ok": True}
            finally:
                os.close(dst_parent)
        finally:
            os.close(src_parent)
    if op == "rename_noreplace":
        source = payload.get("source")
        destination = payload.get("destination")
        if not isinstance(source, str) or not isinstance(destination, str):
            raise ValueError("rename source and destination must be strings")
        src_parent, src_name = parent_for(root_fd, source, False)
        try:
            dst_parent, dst_name = parent_for(root_fd, destination, False)
            try:
                rename_noreplace(src_parent, src_name, dst_name, dst_parent)
                return {"ok": True}
            finally:
                os.close(dst_parent)
        finally:
            os.close(src_parent)
    if op == "rename":
        source = payload.get("source")
        destination = payload.get("destination")
        src_parent, src_name = parent_for(root_fd, source, False)
        try:
            dst_parent, dst_name = parent_for(root_fd, destination, False)
            try:
                os.rename(src_name, dst_name, src_dir_fd=src_parent, dst_dir_fd=dst_parent)
                return {"ok": True}
            finally:
                os.close(dst_parent)
        finally:
            os.close(src_parent)
    if op == "rmdir":
        parent, name = parent_for(root_fd, path, False)
        try:
            os.rmdir(name, dir_fd=parent)
            return {"ok": True}
        finally:
            os.close(parent)
    if op == "remove_empty_directory":
        parent, name = parent_for(root_fd, path, False)
        try:
            info = stat_at(parent, name)
            if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode):
                raise PermissionError("anchored target is not a directory")
            child_fd = os.open(name, ensure_flags(), dir_fd=parent)
            try:
                with os.scandir(child_fd) as entries:
                    if next(entries, None) is not None:
                        raise OSError("anchored directory is not empty")
            finally:
                os.close(child_fd)
            os.rmdir(name, dir_fd=parent)
            return {"ok": True}
        finally:
            os.close(parent)
    if op == "remove_empty_directory_if_matches":
        expected = payload.get("expected")
        if not isinstance(expected, dict) or not isinstance(expected.get("dev"), int) or not isinstance(expected.get("ino"), int):
            raise ValueError("directory expectation is invalid")
        parent, name = parent_for(root_fd, path, False)
        try:
            return {"ok": True, "removed": remove_exact_empty_directory(parent, name, expected)}
        finally:
            os.close(parent)
    if op == "remove_entry":
        parent, name = parent_for(root_fd, path, False)
        try:
            info = stat_at(parent, name)
            if stat.S_ISDIR(info.st_mode) and not stat.S_ISLNK(info.st_mode):
                os.rmdir(name, dir_fd=parent)
            else:
                os.unlink(name, dir_fd=parent)
            return {"ok": True}
        finally:
            os.close(parent)
    if op in ("remove", "unlink"):
        parent, name = parent_for(root_fd, path, False)
        try:
            info = stat_at(parent, name)
            if stat.S_ISLNK(info.st_mode):
                raise PermissionError("anchored target is a symbolic link")
            if not stat.S_ISREG(info.st_mode):
                raise PermissionError("anchored target is not a regular file")
            os.unlink(name, dir_fd=parent)
            return {"ok": True}
        finally:
            os.close(parent)
    raise ValueError("unsupported descriptor helper operation")
def read_request(stream):
    frame = stream.readline(MAX_REQUEST_BYTES + 2)
    if frame == b"":
        raise EOFError("helper request channel reached EOF")
    if len(frame) > MAX_REQUEST_BYTES + 1 or not frame.endswith(b"\n"):
        raise ValueError("helper request must be one bounded newline frame")
    return frame[:-1].decode("utf-8")


def write_all(stream, frame):
    offset = 0
    while offset < len(frame):
        try:
            count = stream.write(frame[offset:])
        except InterruptedError:
            continue
        except OSError as exc:
            if getattr(exc, "errno", None) == errno.EINTR:
                continue
            raise
        if count is None or count <= 0:
            raise BrokenPipeError("helper response channel short write")
        offset += count
    while True:
        try:
            stream.flush()
            return
        except InterruptedError:
            continue
        except OSError as exc:
            if getattr(exc, "errno", None) == errno.EINTR:
                continue
            raise


def recover_missing_batch_residue(root_fd, journal_name, batch_id, entries):
    try:
        stat_at(root_fd, journal_name)
    except FileNotFoundError:
        pass
    else:
        raise RecoveryRequired("prepared batch journal appeared during absent-clean recovery")
    parents = []
    try:
        for index, entry in enumerate(entries):
            path = entry.get("path") if isinstance(entry, dict) else None
            if not isinstance(path, str) or not isinstance(entry.get("index"), int) or entry.get("index") != index or not isinstance(entry.get("size"), int) or not isinstance(entry.get("sha256"), str):
                raise RecoveryRequired("prepared batch absent-clean manifest is invalid")
            parent, name = parent_for(root_fd, path, False)
            parents.append(parent)
            lock_name = bounded_name("cas-lock", path, ".lock", nonce=False)
            stage_name = bounded_name("cas-stage", path, ".tmp", nonce=False)
            try:
                lock_data, lock_info, owner = read_lock_observed(parent, lock_name)
            except FileNotFoundError:
                lock_data = lock_info = owner = None
            if owner is not None:
                if (not verify_signed_document(owner) or owner.get("root_binding") != CURRENT_ROOT_BINDING
                    or owner.get("batch_id") != batch_id or owner.get("batch_journal") != journal_name
                    or owner.get("batch_index") != index or owner.get("batch_size") != len(entries)
                    or owner.get("path") != path or owner.get("stage") != stage_name
                    or owner.get("operation") != "write_atomic" or owner.get("desired_sha256") != entry["sha256"]
                    or not isinstance(owner.get("expected"), dict) or not preimage_matches(parent, name, owner["expected"])):

                    raise RecoveryRequired("prepared batch orphan lease identity changed")
                try:
                    stage_data, stage_info = read_at(parent, stage_name)
                except FileNotFoundError:
                    pass
                except Exception as error:
                    raise RecoveryRequired("prepared batch orphan stage type changed") from error
                else:
                    if (not stat.S_ISREG(stage_info.st_mode)
                        or len(stage_data) != entry["size"] or hashlib.sha256(stage_data).hexdigest() != entry["sha256"]):
                        raise RecoveryRequired("prepared batch orphan stage is foreign")
                    if not remove_exact_regular(parent, stage_name, {"dev": stage_info.st_dev, "ino": stage_info.st_ino, "size": len(stage_data), "sha256": entry["sha256"]}):
                        raise RecoveryRequired("prepared batch orphan stage cleanup could not be proven")
                lock_expected = {"dev": lock_info.st_dev, "ino": lock_info.st_ino, "size": len(lock_data), "sha256": hashlib.sha256(lock_data).hexdigest()}
                if not remove_exact_regular(parent, lock_name, lock_expected):
                    raise RecoveryRequired("prepared batch orphan lease cleanup could not be proven")
                try:
                    stat_at(parent, stage_name)
                    raise RecoveryRequired("prepared batch orphan stage survived exact cleanup")
                except FileNotFoundError:
                    pass
            else:
                try:
                    stat_at(parent, stage_name)
                except FileNotFoundError:
                    expected = entry.get("expected")
                    postimage = entry.get("postimage")
                    if isinstance(postimage, dict) and target_matches_descriptor(parent, name, postimage):
                        continue
                    if isinstance(expected, dict) and target_matches_preimage(parent, name, expected):
                        continue
                    raise RecoveryRequired("prepared batch journal is absent but exact target state is unavailable")
                raise RecoveryRequired("prepared batch journal is absent but foreign stage remains")
    finally:
        for parent in parents:
            os.close(parent)
    try:
        stat_at(root_fd, journal_name)
    except FileNotFoundError:
        pass
    else:
        raise RecoveryRequired("prepared batch journal appeared before absent-clean return")

def recover_partial_prepared_batch(root_fd, journal_name, batch_id):
    document, _, _ = read_batch_journal(root_fd, journal_name, batch_id)
    if document.get("state") != "prepared":
        raise RecoveryRequired("prepared batch partial lease recovery requires prepared journal")
    entries = document["entries"]
    states = []
    parents = []
    try:
        for index, entry in enumerate(entries):
            path = entry["path"]
            parent, name = parent_for(root_fd, path, False)
            parents.append(parent)
            lock_name = bounded_name("cas-lock", path, ".lock", nonce=False)
            stage_name = bounded_name("cas-stage", path, ".tmp", nonce=False)
            journal_expected = entry.get("expected")
            journal_postimage = entry.get("postimage")
            try:
                lock_data, lock_info, owner = read_lock_observed(parent, lock_name)
            except FileNotFoundError:
                try:
                    stat_at(parent, stage_name)
                except FileNotFoundError:
                    clean = isinstance(journal_expected, dict) and target_matches_preimage(parent, name, journal_expected)
                    published = isinstance(journal_postimage, dict) and target_matches_descriptor(parent, name, journal_postimage)
                    if not clean and not published:
                        raise RecoveryRequired("prepared batch partial recovery lacks exact target state")
                    states.append({"parent": parent, "name": name, "lock": lock_name, "stage": stage_name, "lock_data": None, "lock_info": None, "remove_stage": False})
                    continue
                raise RecoveryRequired("prepared batch partial recovery found an unleased stage")
            if (not verify_signed_document(owner) or owner.get("root_binding") != CURRENT_ROOT_BINDING
                or owner.get("batch_id") != batch_id or owner.get("batch_journal") != journal_name
                or owner.get("batch_index") != index or owner.get("batch_size") != len(entries)
                or owner.get("path") != path or owner.get("stage") != stage_name
                or owner.get("operation") != "write_atomic" or owner.get("desired_sha256") != entry["sha256"]
                or not isinstance(owner.get("expected"), dict)):
                raise RecoveryRequired("prepared batch partial lease identity changed")
            owner_expected = owner["expected"]
            if isinstance(journal_expected, dict) and owner_expected != journal_expected:
                raise RecoveryRequired("prepared batch partial lease preimage changed")
            owner_postimage = owner.get("postimage")
            if isinstance(journal_postimage, dict) and owner_postimage is not None and owner_postimage != journal_postimage:
                raise RecoveryRequired("prepared batch partial lease postimage changed")
            expected = owner_expected if isinstance(owner_expected, dict) else journal_expected
            postimage = owner_postimage if isinstance(owner_postimage, dict) else journal_postimage
            try:
                stage_data, stage_info = read_at(parent, stage_name)
            except FileNotFoundError:
                clean = isinstance(expected, dict) and target_matches_preimage(parent, name, expected)
                published = isinstance(postimage, dict) and target_matches_descriptor(parent, name, postimage)
                if not clean and not published:
                    raise RecoveryRequired("prepared batch partial recovery target is ambiguous")
                states.append({"parent": parent, "name": name, "lock": lock_name, "stage": stage_name, "lock_data": lock_data, "lock_info": lock_info, "remove_stage": False})
                continue
            except Exception as error:
                raise RecoveryRequired("prepared batch partial stage type changed") from error
            if (not stat.S_ISREG(stage_info.st_mode) or len(stage_data) != entry["size"]
                or hashlib.sha256(stage_data).hexdigest() != entry["sha256"]):
                raise RecoveryRequired("prepared batch partial stage is foreign")
            if not (isinstance(expected, dict) and target_matches_preimage(parent, name, expected)):
                raise RecoveryRequired("prepared batch partial staged target is ambiguous")
            states.append({"parent": parent, "name": name, "lock": lock_name, "stage": stage_name, "lock_data": lock_data, "lock_info": lock_info, "remove_stage": True, "stage_info": stage_info, "stage_size": len(stage_data), "stage_sha256": entry["sha256"]})
        for state in states:
            if state["lock_data"] is None:
                continue
            if state.get("remove_stage") and not remove_exact_regular(state["parent"], state["stage"], {"dev": state["stage_info"].st_dev, "ino": state["stage_info"].st_ino, "size": state["stage_size"], "sha256": state["stage_sha256"]}):
                raise RecoveryRequired("prepared batch partial stage cleanup could not be proven")
            lock_data = state["lock_data"]
            lock_info = state["lock_info"]
            lock_expected = {"dev": lock_info.st_dev, "ino": lock_info.st_ino, "size": len(lock_data), "sha256": hashlib.sha256(lock_data).hexdigest()}
            if not remove_exact_regular(state["parent"], state["lock"], lock_expected):
                raise RecoveryRequired("prepared batch partial lease cleanup could not be proven")
    finally:
        for parent in parents:
            os.close(parent)
    remove_batch_journal(root_fd, journal_name, batch_id, True)
    return {"ok": True, "recovered": False, "absent_clean": True, "aborted": True, "batch_id": batch_id}

def execute(payload):
    op_name = payload.get("op") if isinstance(payload, dict) else None
    try:
        if not isinstance(payload, dict):
            raise ValueError("helper payload must be an object")
        test_sleep_ms = payload.get("test_sleep_ms")
        if isinstance(test_sleep_ms, int) and 0 <= test_sleep_ms <= 60_000:
            time.sleep(test_sleep_ms / 1000)
        result = operation(payload)
        if RECOVERED_BATCH_IDS:
            result = dict(result)
            result["_recovered_batch_ids"] = sorted(RECOVERED_BATCH_IDS)
            RECOVERED_BATCH_IDS.clear()
        return result
    except FileNotFoundError:
        return fail("not_found", "anchored path does not exist")
    except NotRegular as exc:
        return fail("not_regular", str(exc))
    except RecoveryRequired as exc:
        return fail("recovery_required", str(exc))
    except LimitError as exc:
        return fail("limit", str(exc))
    except PermissionError as exc:
        # Explicit safety rejections use PermissionError without an errno and
        # remain path_unauthorized.  A kernel EACCES while mutating the
        # journal/projection is an ordinary persistence failure and must keep
        # its write_failed contract.
        write_ops = ("ensure_directory", "write_exclusive", "write_atomic", "prepare_write_exclusive", "prepare_write_atomic", "commit_prepared_write", "ack_prepared_write", "abort_prepared_write", "recover_prepared_batch", "batch_atomic", "replace_if_matches", "remove_if_matches", "remove_empty_directory_if_matches", "link_exclusive", "rename", "rename_noreplace", "rmdir", "remove_entry", "remove", "unlink", "lock_acquire", "lock_release")
        batch_writes = op_name in ("batch", "batch_atomic") and isinstance(payload, dict) and isinstance(payload.get("operations"), list) and any(isinstance(item, dict) and item.get("op") in write_ops for item in payload["operations"])
        if getattr(exc, "errno", None) == 13 and (op_name in write_ops or batch_writes):
            return fail("write_failed", str(exc))
        return fail("path_unauthorized", str(exc))
    except FileExistsError as exc:
        return fail("exists", str(exc))
    except NotImplementedError as exc:
        return fail("unsupported", str(exc))
    except ValueError as exc:
        return fail("invalid", str(exc))
    except RuntimeError as exc:
        return fail("changed", str(exc))
    except OSError as exc:
        if errno_code(exc) == 2:
            return fail("not_found", str(exc))
        if errno_code(exc) in (40, 62):
            return fail("path_unauthorized", "anchored path is a symlink")
        if errno_code(exc) == 20:
            return fail("path_unauthorized", str(exc))
        return fail("write_failed", str(exc))


def main():
    request_fifo = os.environ.get("OMP_DARWIN_HELPER_REQUEST_FIFO")
    response_fifo = os.environ.get("OMP_DARWIN_HELPER_RESPONSE_FIFO")
    ready_nonce = os.environ.get("OMP_DARWIN_HELPER_READY_NONCE")
    if not request_fifo or not response_fifo or not ready_nonce:
        raise RuntimeError("persistent helper authentication is unavailable")
    try:
        global AUTH_KEY
        auth_stream = os.fdopen(4, "rb", buffering=0)
        auth_line = auth_stream.readline(128)
        journal_line = auth_stream.readline(128)
        session_line = auth_stream.readline(256)
        auth_stream.close()
        if not auth_line.endswith(b"\n") or not journal_line.endswith(b"\n") or not session_line.endswith(b"\n"):
            raise ValueError("authentication key pipe ended before credentials")
        AUTH_KEY = bytes.fromhex(auth_line[:-1].decode("ascii"))
        global JOURNAL_KEY, SESSION_ID
        JOURNAL_KEY = bytes.fromhex(journal_line[:-1].decode("ascii"))
        SESSION_ID = session_line[:-1].decode("ascii")
        if not SESSION_ID:
            raise ValueError("helper session identity is empty")
    except (OSError, UnicodeDecodeError, ValueError) as error:
        raise RuntimeError("persistent helper authentication key is invalid") from error
    if len(AUTH_KEY) != 32 or len(JOURNAL_KEY) != 32:
        raise RuntimeError("persistent helper authentication key is invalid")
    try:
        os.mkfifo(request_fifo, 0o600)
        os.mkfifo(response_fifo, 0o600)
        os.chmod(request_fifo, 0o600)
        os.chmod(response_fifo, 0o600)
    except FileExistsError:
        raise RuntimeError("persistent helper FIFO already exists")
    with open(request_fifo, "rb", buffering=0) as request_stream, open(response_fifo, "wb", buffering=0) as response_stream:
        ready_frame = (json.dumps(signed_frame({"ok": True, "ready": True, "_ready_nonce": ready_nonce, "_session_id": SESSION_ID}), separators=(",", ":")) + "\n").encode("utf-8")
        write_all(response_stream, ready_frame)
        replay_frame = None
        while True:
            payload = None
            try:
                payload = json.loads(read_request(request_stream))
                if isinstance(payload, dict) and payload.get("_test_response_mode") == "forged_request":
                    payload["_mac"] = "00" * 32
                verify_request_frame(payload)
                if not isinstance(payload, dict):
                    raise ValueError("helper payload must be an object")
                request_id = payload.get("_request_id")
                if not isinstance(request_id, str) or len(request_id) > 128:
                    raise ValueError("helper request id is invalid")
                if payload.get("op") == "__close":
                    result = {"ok": True, "closed": True}
                else:
                    result = execute(payload)
                result["_request_id"] = request_id
                result["_nonce"] = payload["_nonce"]
                result["_session_id"] = SESSION_ID
            except EOFError:
                break
            except Exception as exc:
                result = fail("unsupported", "persistent helper protocol failed: " + str(exc))
                if isinstance(payload, dict) and isinstance(payload.get("_request_id"), str):
                    result["_request_id"] = payload["_request_id"]
                if isinstance(payload, dict) and isinstance(payload.get("_nonce"), int):
                    result["_nonce"] = payload["_nonce"]
                    result["_session_id"] = SESSION_ID
            response_mode = payload.get("_test_response_mode") if isinstance(payload, dict) else None
            if response_mode == "eof" or (response_mode == "eof_after_prepared_commit" and payload.get("op") == "commit_prepared_write") or (response_mode == "eof_after_prepared_ack" and payload.get("op") == "ack_prepared_write"):
                break
            if response_mode == "oversized_response":
                # Deterministically exercise the bounded fallback without an
                # unbounded allocation; the fallback retains correlation.
                result["_test_payload"] = "x" * (24 * 1024 * 1024)
            result = signed_frame(result)
            if response_mode == "forged_response":
                result["_session_id"] = "forged-session"
            elif response_mode == "cross_session_replay":
                result["_session_id"] = "previous-session"
            elif response_mode == "replay_response":
                if replay_frame is None:
                    replay_frame = dict(result)
                else:
                    result = dict(replay_frame)
            frame = (json.dumps(result, separators=(",", ":")) + "\n").encode("utf-8")
            if len(frame) > 24 * 1024 * 1024:
                fallback = fail("limit", "descriptor helper response exceeds its output limit")
                if isinstance(payload, dict) and isinstance(payload.get("_request_id"), str):
                    fallback["_request_id"] = payload["_request_id"]
                fallback["_nonce"] = payload.get("_nonce") if isinstance(payload, dict) else None
                fallback["_session_id"] = payload.get("_session_id") if isinstance(payload, dict) else None
                frame = (json.dumps(signed_frame(fallback), separators=(",", ":")) + "\n").encode("utf-8")
            if response_mode == "valid_multibyte_control":
                result = signed_frame({**result, "_test_payload": "界" + chr(1)})
                frame = (json.dumps(result, separators=(",", ":"), ensure_ascii=False) + "\n").encode("utf-8")
            elif response_mode == "invalid_utf8":
                frame = (b'{"ok":true,"exists":true,"path":"' + bytes([0xff])
                        + b'","_request_id":"' + request_id.encode("ascii") + b'"}\n')
            elif response_mode == "invalid_json":
                frame = b'{"ok":true,"exists":}\n'
            elif response_mode == "truncated":
                frame = b'{"ok":true,"exists":false'
            if response_mode == "two_frames":
                frame += b'{"ok":true}\n'
            # A FIFO writer can block once the kernel pipe buffer fills.
            # Keep the bounded write in a thread, but propagate every writer
            # error to the main loop so EPIPE/short writes terminate the
            # helper instead of silently desynchronizing request ids.
            writer_errors = []
            class ShortWriteStream:
                def __init__(self, stream):
                    self.stream = stream
                def write(self, data):
                    return self.stream.write(data[:max(1, min(7, len(data)))])
                def flush(self):
                    return self.stream.flush()
            class EpipeStream:
                def write(self, data):
                    raise BrokenPipeError("injected response EPIPE")
                def flush(self):
                    raise BrokenPipeError("injected response EPIPE")
            writer_stream = response_stream
            if response_mode == "short_write":
                writer_stream = ShortWriteStream(response_stream)
            elif response_mode == "epipe":
                writer_stream = EpipeStream()
            def write_response():
                try:
                    write_all(writer_stream, frame)
                except BaseException as exc:
                    writer_errors.append(exc)
            writer = threading.Thread(target=write_response)
            writer.start()
            writer.join()
            if writer_errors:
                raise writer_errors[0]
            if isinstance(payload, dict) and payload.get("op") == "__close":
                break


main()
`;

const MAX_RELATIVE_PATH_LENGTH = 4096;
const MAX_RELATIVE_PATH_SEGMENTS = 128;
const MAX_BATCH_ROLLBACK_BYTES = 8 * 1024 * 1024;
const DEFAULT_DIRECTORY_MAX_ENTRIES = 16384;
const DEFAULT_DIRECTORY_MAX_NAME_BYTES = 4 * 1024 * 1024;

type ConditionalOperation = "replace" | "remove";

function darwinHelperTransferTimeout(operation: string, baseTimeoutMs: number, requestBytes: number): number {
  if (!DARWIN_HELPER_TRANSFER_OPERATIONS.has(operation) || requestBytes <= DARWIN_HELPER_TRANSFER_THRESHOLD_BYTES) return baseTimeoutMs;
  const transferMs = Math.ceil((requestBytes - DARWIN_HELPER_TRANSFER_THRESHOLD_BYTES) / DARWIN_HELPER_TRANSFER_BYTES_PER_MS);
  return baseTimeoutMs + Math.min(DARWIN_HELPER_TRANSFER_TIMEOUT_CAP_MS, transferMs);
}

function errnoCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as NodeJS.ErrnoException).code)
    : undefined;
}

function assertDarwinFifoDescriptor(fd: number, expected: Stats, label: string): void {
  const observed = fstatSync(fd);
  const uid = process.getuid?.();
  if (uid === undefined || !observed.isFIFO() || !sameIdentity(observed, expected)
    || (observed.mode & 0o777) !== 0o600 || observed.uid !== uid) {
    throw new PinnedRootError("changed", `descriptor helper ${label} FIFO identity changed after open`);
  }
}

function sameIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function descriptorPathFor(fd: number): string | null {
  if (process.platform === "darwin") return `/dev/fd/${fd}`;
  if (process.platform === "linux") return `/proc/self/fd/${fd}`;
  return null;
}

function descriptorFlags(): number | null {
  const readOnly = constants.O_RDONLY;
  const directory = constants.O_DIRECTORY;
  const noFollow = constants.O_NOFOLLOW;
  if (![readOnly, directory, noFollow].every((value) => Number.isInteger(value))) return null;
  return readOnly | directory | noFollow;
}

function readFlags(): number | null {
  const readOnly = constants.O_RDONLY;
  const noFollow = constants.O_NOFOLLOW;
  const nonBlock = constants.O_NONBLOCK;
  if (![readOnly, noFollow, nonBlock].every((value) => Number.isInteger(value))) return null;
  return readOnly | noFollow | nonBlock;
}

function writeFlags(): number | null {
  const writeOnly = constants.O_WRONLY;
  const create = constants.O_CREAT;
  const exclusive = constants.O_EXCL;
  const noFollow = constants.O_NOFOLLOW;
  if (![writeOnly, create, exclusive, noFollow].every((value) => Number.isInteger(value))) return null;
  return writeOnly | create | exclusive | noFollow;
}

function isWellFormedUtf16(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function contentByteLength(content: PinnedRootWriteContent): number {
  if (typeof content === "string" && !isWellFormedUtf16(content)) {
    throw new PinnedRootError("invalid", "anchored write text payload is not valid UTF-8");
  }
  const length = typeof content === "string" ? Buffer.byteLength(content, "utf8") : content.byteLength;
  if (!Number.isSafeInteger(length) || length < 0 || length > MAX_PINNED_ROOT_WRITE_BYTES) {
    throw new PinnedRootError("limit", "anchored write exceeds the bounded content limit");
  }
  return length;
}

function contentToBase64(content: PinnedRootWriteContent): string {
  contentByteLength(content);
  return Buffer.from(content).toString("base64");
}

function contentPayload(content: PinnedRootWriteContent, allowText = false): Record<string, string> {
  if (allowText && typeof content === "string") {
    contentByteLength(content);
    return { text: content };
  }
  return { bytes: contentToBase64(content) };
}

function contentSha256(content: PinnedRootWriteContent): string {
  return createHash("sha256").update(Buffer.from(content)).digest("hex");
}

type PinnedWriteDescriptorResponse = {
  ok?: unknown;
  recovered?: unknown;
  ack_required?: unknown;
  token?: unknown;
  preimage?: unknown;
  dev?: unknown;
  ino?: unknown;
  size?: unknown;
  sha256?: unknown;
};

function descriptorFromResponse(
  relativeFile: string,
  canonicalPath: string,
  content: PinnedRootWriteContent,
  response: PinnedWriteDescriptorResponse,
): PinnedRootWriteDescriptor {
  const size = contentByteLength(content);
  const sha256 = contentSha256(content);
  if (
    response.ok !== true
    || !Number.isSafeInteger(response.dev)
    || (response.dev as number) < 0
    || !Number.isSafeInteger(response.ino)
    || (response.ino as number) < 0
    || !Number.isSafeInteger(response.size)
    || response.size !== size
    || response.sha256 !== sha256
  ) {
    throw new PinnedRootError("write_failed", "anchored write returned an invalid operation descriptor");
  }
  return {
    path: canonicalPath,
    relative_path: relativeFile,
    dev: response.dev as number,
    ino: response.ino as number,
    size,
    sha256,
  };
}

function preimageFromResponse(response: PinnedWriteDescriptorResponse): PinnedRootWritePreimage {
  const raw = response.preimage;
  if (!raw || typeof raw !== "object") throw new PinnedRootError("write_failed", "prepared write returned no exact preimage");
  const record = raw as Record<string, unknown>;
  if (record.kind === "absent") return { kind: "absent" };
  if (record.kind !== "file" || typeof record.bytes !== "string"
    || !Number.isSafeInteger(record.dev) || (record.dev as number) < 0
    || !Number.isSafeInteger(record.ino) || (record.ino as number) < 0
    || !Number.isSafeInteger(record.size) || (record.size as number) < 0
    || typeof record.sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(record.sha256)) {
    throw new PinnedRootError("write_failed", "prepared write returned an invalid exact preimage");
  }
  let bytes: Buffer;
  try { bytes = Buffer.from(record.bytes, "base64"); } catch { throw new PinnedRootError("write_failed", "prepared write returned invalid preimage bytes"); }
  if (bytes.byteLength !== record.size || createHash("sha256").update(bytes).digest("hex") !== record.sha256) {
    throw new PinnedRootError("write_failed", "prepared write returned an inconsistent exact preimage");
  }
  return {
    kind: "file",
    bytes,
    expectation: { dev: record.dev as number, ino: record.ino as number, size: record.size as number, sha256: record.sha256 },
  };
}

function safeRelativeSegments(value: unknown, allowEmpty = false): string[] {
  if (typeof value !== "string") throw new PinnedRootError("path_unauthorized", "anchored path must be a string");
  if (value.length > MAX_RELATIVE_PATH_LENGTH || value.includes("\\") || value.includes("\0") || isAbsolute(value) || /^[A-Za-z]:/u.test(value)) {
    throw new PinnedRootError("path_unauthorized", "anchored path must be a bounded relative POSIX path");
  }
  if (value.length === 0) {
    if (allowEmpty) return [];
    throw new PinnedRootError("path_unauthorized", "anchored path cannot be empty");
  }
  if (!isSafeRelativePath(value)) throw new PinnedRootError("path_unauthorized", "anchored path contains an unsafe component");
  const segments = value.split("/");
  if (segments.length > MAX_RELATIVE_PATH_SEGMENTS || segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new PinnedRootError("path_unauthorized", "anchored path contains an unsafe component");
  }
  return segments;
}

function boundedTemporaryComponent(domain: string, relativePath: string, suffix: string): string {
  const digest = createHash("sha256").update(relativePath, "utf8").digest("hex");
  return `.omp-${domain}-${digest}-${randomUUID()}${suffix}`;
}

function boundedDarwinSibling(domain: string, relativePath: string, suffix: string): string {
  const digest = createHash("sha256").update(relativePath, "utf8").digest("hex");
  return ".omp-" + domain + "-" + digest + suffix;
}

function closeQuietly(fd: number | null): void {
  if (fd === null) return;
  try { closeSync(fd); } catch { /* preserve the primary operation result */ }
}

function decodeDarwinHelperUtf8(decoder: TextDecoder, bytes: Uint8Array, stream: boolean, operation: string): string {
  try {
    return decoder.decode(bytes, { stream });
  } catch (error) {
    throw new PinnedRootError("unsupported", `descriptor helper '${operation}' returned invalid UTF-8: ${String(error)}`);
  }
}

function pollDarwinChildExit(child: ChildProcess, timeoutMs: number): boolean {
  const childPid = child.pid;
  if (childPid === undefined || !Number.isInteger(childPid) || childPid <= 0) return child.exitCode !== null;
  const pid = childPid as number;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (child.exitCode !== null) return true;
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (errnoCode(error) === "ESRCH") return true;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, DARWIN_HELPER_POLL_MS);
  }
  return child.exitCode !== null;
}

function cleanupDarwinHelpersOnExit(): void {
  for (const session of activeDarwinHelperSessions) {
    try { session.child.kill("SIGTERM"); } catch { /* preserve process shutdown */ }
    closeQuietly(session.requestFd);
    closeQuietly(session.responseFd);
    try { rmSync(session.directory, { recursive: true, force: true }); } catch { /* preserve process shutdown */ }
  }
  activeDarwinHelperSessions.clear();
}

if (process.platform === "darwin") {
  process.once("exit", cleanupDarwinHelpersOnExit);
}

/**
 * A project root held open for the lifetime of a scoped operation.  All paths
 * exposed by this class are descriptor paths, never caller-controlled root
 * strings.  Keeping the descriptor open means a root rename cannot redirect
 * a later operation to a replacement pathname.
 */
export interface PinnedRootPathEntryInfo {
  kind: "file" | "directory" | "symlink" | "other";
  size: number;
  dev: number;
  ino: number;
  mtimeMs: number;
  ctimeMs: number;
  /** Permission bits observed from the same no-follow descriptor operation. */
  mode: number;
}

export class PinnedProjectRoot {
  readonly lexical_root: string;
  readonly canonical_root: string;
  readonly dev: number;
  readonly ino: number;

  private readonly rootFd: number;
  private readonly rootDescriptorPath: string;
  private readonly hooks: PinnedRootWriteHooks;
  private readonly rootPathDigest: string;
  private darwinHelperSession: DarwinHelperSession | null = null;
  private darwinHelperClosePromise: Promise<void> | null = null;
  private darwinHelperPoisoned = false;
  private closed = false;

  private constructor(
    lexicalRoot: string,
    identity: PinnedRootIdentity,
    rootFd: number,
    rootDescriptorPath: string,
    hooks: PinnedRootWriteHooks,
  ) {
    this.lexical_root = lexicalRoot;
    this.canonical_root = identity.canonical_root;
    this.dev = identity.dev;
    this.ino = identity.ino;
    this.rootPathDigest = createHash("sha256").update([identity.canonical_root, identity.dev, identity.ino].join("\0"), "utf8").digest("hex");
    this.rootFd = rootFd;
    this.rootDescriptorPath = rootDescriptorPath;
    this.hooks = hooks;
  }

  /** Open and pin an existing canonical, non-symlink directory. */
  static open(projectRoot: unknown, hooks: PinnedRootWriteHooks = {}): PinnedProjectRoot | null {
    if (typeof projectRoot !== "string" || projectRoot.trim().length === 0) return null;
    const flags = descriptorFlags();
    if (flags === null || descriptorPathFor(0) === null) return null;
    const lexicalRoot = resolve(projectRoot);
    let fd: number | null = null;
    let retained = false;
    try {
      const lexical = lstatSync(lexicalRoot);
      if (lexical.isSymbolicLink() || !lexical.isDirectory()) return null;
      fd = openSync(lexicalRoot, flags);
      const descriptorPath = descriptorPathFor(fd);
      if (descriptorPath === null) return null;
      const descriptorIdentity = fstatSync(fd);
      if (!descriptorIdentity.isDirectory() || !sameIdentity(lexical, descriptorIdentity)) return null;
      const canonicalRoot = realpathSync(lexicalRoot);
      const canonical = lstatSync(canonicalRoot);
      if (canonical.isSymbolicLink() || !canonical.isDirectory()
        || !sameIdentity(descriptorIdentity, canonical)) return null;
      const pinned = new PinnedProjectRoot(
        lexicalRoot,
        { canonical_root: canonicalRoot, dev: descriptorIdentity.dev, ino: descriptorIdentity.ino },
        fd,
        descriptorPath,
        hooks,
      );
      retained = true;
      return pinned;
    } catch {
      return null;
    } finally {
      if (!retained) closeQuietly(fd);
    }
  }

  /** Close the pinned descriptor. Idempotent and safe in finally blocks. */
  close(): void {
    if (this.closed) {
      void this.darwinHelperClosePromise?.catch(() => undefined);
      return;
    }
    this.closed = true;
    this.closeDarwinHelper();
    closeQuietly(this.rootFd);
    void this.darwinHelperClosePromise?.catch(() => undefined);
  }

  /** Close and await actual Darwin helper exit; idempotent with close(). */
  async closeAsync(): Promise<void> {
    this.close();
    await this.darwinHelperClosePromise;
  }

  /** Descriptor path suitable for APIs that require a cwd/path string. */
  anchorPath(relativePath = ""): string {
    this.assertOpen();
    const segments = safeRelativeSegments(relativePath, true);
    if (process.platform === "darwin") return segments.length === 0 ? this.canonical_root : join(this.canonical_root, ...segments);
    return segments.length === 0 ? this.rootDescriptorPath : join(this.rootDescriptorPath, ...segments);
  }

  /** Convert an absolute lexical/canonical path into a safe root-relative path. */
  relativePath(candidate: unknown): string | null {
    if (typeof candidate !== "string" || this.closed) return null;
    const absolute = resolve(candidate);
    if (process.platform !== "darwin") {
      const descriptorPrefix = this.rootDescriptorPath.slice(0, this.rootDescriptorPath.lastIndexOf("/") + 1);
      if (absolute.startsWith(descriptorPrefix)) {
        const ownedPrefix = `${this.rootDescriptorPath}/`;
        if (candidate === this.rootDescriptorPath) return null;
        if (!candidate.startsWith(ownedPrefix) || !this.isStable()) return null;
        const rawRelative = candidate.slice(ownedPrefix.length);
        const descriptorRelative = absolute.slice(ownedPrefix.length);
        if (rawRelative !== descriptorRelative) return null;
        try {
          safeRelativeSegments(descriptorRelative);
          return descriptorRelative;
        } catch {
          return null;
        }
      }
    }
    const candidates = [relative(this.lexical_root, absolute), relative(this.canonical_root, absolute)];
    for (const candidateRelative of candidates) {
      if (candidateRelative === "" || candidateRelative.startsWith("..") || isAbsolute(candidateRelative)) continue;
      try {
        safeRelativeSegments(candidateRelative);
        return candidateRelative;
      } catch {
        // Try the canonical alias before rejecting the candidate.
      }
    }
    return null;
  }

  /** Verify the pinned descriptor and its canonical pathname still name the original root inode. */
  isStable(): boolean {
    if (this.closed) return false;
    try {
      const descriptor = fstatSync(this.rootFd);
      const canonical = lstatSync(this.canonical_root);
      return descriptor.isDirectory()
        && descriptor.dev === this.dev
        && descriptor.ino === this.ino
        && canonical.isDirectory()
        && canonical.dev === descriptor.dev
        && canonical.ino === descriptor.ino;
    } catch {
      return false;
    }
  }

  /** Ensure every directory component exists, opened no-follow one at a time. */
  ensureDirectory(relativeDirectory: string): void {
    const segments = safeRelativeSegments(relativeDirectory, true);
    assertCurrentExecutionLiveness();
    if (process.platform === "darwin") {
      this.hooks.beforeDirectoryCreate?.(relativeDirectory);
      this.runDescriptorHelper("ensure_directory", { path: relativeDirectory });
      return;
    }
    if (segments.length === 0) {
      this.assertStable();
      return;
    }
    let parentFd = this.rootFd;
    let ownedParent: number | null = null;
    try {
      for (let index = 0; index < segments.length; index += 1) {
        const segment = segments[index]!;
        const path = segments.slice(0, index + 1).join("/");
        const childFd = this.openDirectoryChild(parentFd, segment, path, true);
        closeQuietly(ownedParent);
        ownedParent = childFd;
        parentFd = childFd;
      }
      this.assertStable();
      assertCurrentExecutionLiveness();
    } finally {
      closeQuietly(ownedParent);
    }
  }

  /** Remove one regular file through an anchored no-follow parent descriptor. */
  unlink(relativeFile: string): void {
    const segments = safeRelativeSegments(relativeFile);
    assertCurrentExecutionLiveness();
    if (process.platform === "darwin") {
      this.runDescriptorHelper("unlink", { path: relativeFile });
      return;
    }
    const finalName = segments.pop()!;
    const parent = this.openParent(segments, false);
    try {
      const target = this.childPath(parent.fd, finalName, [...segments, finalName].join("/"));
      this.assertCanonicalDirectory(segments.join("/"));
      this.assertParentPathIdentity(parent.fd, segments.join("/"));
      let existing: Stats;
      try {
        existing = lstatSync(target);
      } catch (error) {
        if (errnoCode(error) === "ENOENT") throw new PinnedRootError("not_found", "anchored target does not exist");
        throw error;
      }
      if (existing.isSymbolicLink()) throw new PinnedRootError("path_unauthorized", "anchored target is a symbolic link");
      if (!existing.isFile()) throw new PinnedRootError("not_regular", "anchored target is not a regular file");
      assertCurrentExecutionLiveness();
      unlinkSync(target);
      this.assertStable();
      assertCurrentExecutionLiveness();
    } catch (error) {
      if (error instanceof ExecutionLivenessViolation) throw error;
      if (error instanceof PinnedRootError) throw error;
      const code = errnoCode(error);
      if (code === "ENOENT") throw new PinnedRootError("not_found", "anchored target does not exist");
      throw new PinnedRootError("write_failed", `anchored target could not be removed safely: ${String(error)}`);
    } finally {
      parent.close();
    }
  }
  /**
   * Move one bounded batch of queue entries to a durable rejected namespace.
   * Darwin performs all moves under one inherited root descriptor; portable
   * callers retain the same no-follow/no-replace contract on Linux.
   */
  discardBatch(relativeDirectory: string, names: readonly string[], rejectedRelativeDirectory: string, options: { maxEntries?: number; maxNameBytes?: number } = {}): number {
    safeRelativeSegments(relativeDirectory, true);
    assertCurrentExecutionLiveness();
    safeRelativeSegments(rejectedRelativeDirectory, true);
    const maxEntries = options.maxEntries ?? 512;
    const maxNameBytes = options.maxNameBytes ?? 64 * 1024;
    if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0 || maxEntries > DEFAULT_DIRECTORY_MAX_ENTRIES || names.length > maxEntries || !Number.isSafeInteger(maxNameBytes) || maxNameBytes <= 0 || maxNameBytes > DEFAULT_DIRECTORY_MAX_NAME_BYTES) {
      throw new PinnedRootError("invalid", "bounded discard batch limits are invalid");
    }
    const validNames = names.map((name) => {
      const segments = safeRelativeSegments(name);
      if (segments.length !== 1) throw new PinnedRootError("path_unauthorized", "discard batch entry must be one path segment");
      return segments[0]!;
    });
    if (validNames.reduce((total, name) => total + Buffer.byteLength(name, "utf8"), 0) > maxNameBytes) {
      throw new PinnedRootError("limit", "bounded discard batch exceeded name-byte limit");
    }
    if (validNames.length === 0) return 0;
    if (process.platform === "darwin") {
      const result = this.runDescriptorHelper<{ moved?: unknown }>("discard_batch", {
        path: relativeDirectory,
        names: validNames,
        rejected: rejectedRelativeDirectory,
        max_entries: maxEntries,
        max_name_bytes: maxNameBytes,
      });
      if (!Number.isSafeInteger(result.moved) || (result.moved as number) < 0 || (result.moved as number) > validNames.length) {
        throw new PinnedRootError("write_failed", "descriptor helper returned an invalid discard count");
      }
      return result.moved as number;
    }
    this.ensureDirectory(rejectedRelativeDirectory);
    let moved = 0;
    for (const name of validNames) {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        try {
          this.renameFileExclusive(join(relativeDirectory, name), join(rejectedRelativeDirectory, boundedTemporaryComponent("discard", join(rejectedRelativeDirectory, name), ".discarded")));
          moved += 1;
          break;
        } catch (error) {
          if (error instanceof PinnedRootError && error.code === "not_found") break;
          if (error instanceof PinnedRootError && error.code === "exists") continue;
          throw error;
        }
      }
    }
    return moved;
  }


  /** Remove one anchored regular file, optionally accepting an absent target. */
  removeFile(relativeFile: string, options: { missingOk?: boolean } = {}): void {
    try {
      this.unlink(relativeFile);
    } catch (error) {
      if (options.missingOk && error instanceof PinnedRootError && error.code === "not_found") return;
      throw error;
    }
  }

  /** Remove one anchored file, symlink, or empty directory without following links. */
  removeEntry(relativePath: string): void {
    const segments = safeRelativeSegments(relativePath);
    assertCurrentExecutionLiveness();
    if (process.platform === "darwin") {
      this.runDescriptorHelper("remove_entry", { path: relativePath });
      return;
    }
    const finalName = segments.pop()!;
    const parent = this.openParent(segments, false);
    try {
      const target = this.childPath(parent.fd, finalName, [...segments, finalName].join("/"));
      this.assertCanonicalDirectory(segments.join("/"));
      this.assertParentPathIdentity(parent.fd, segments.join("/"));
      const stat = lstatSync(target);
      assertCurrentExecutionLiveness();
      if (stat.isDirectory() && !stat.isSymbolicLink()) rmdirSync(target);
      else unlinkSync(target);
      this.assertStable();
      assertCurrentExecutionLiveness();
    } catch (error) {
      if (error instanceof ExecutionLivenessViolation) throw error;
      if (error instanceof PinnedRootError) throw error;
      if (errnoCode(error) === "ENOENT") throw new PinnedRootError("not_found", "anchored target does not exist");
      throw new PinnedRootError("write_failed", `anchored target could not be removed safely: ${String(error)}`);
    } finally { parent.close(); }
  }

  /** Return whether one anchored entry exists, without following links. */
  pathEntryExists(relativePath: string): boolean {
    const segments = safeRelativeSegments(relativePath);
    if (process.platform === "darwin") {
      const result = this.runDescriptorHelper<{ exists: unknown }>("exists", { path: relativePath });
      return result.exists === true;
    }
    const finalName = segments.pop()!;
    let parent: { fd: number; identity: Stats; close: () => void };
    try { parent = this.openParent(segments, false); }
    catch (error) { if (error instanceof PinnedRootError && error.code === "not_found") return false; throw error; }
    try {
      const target = this.childPath(parent.fd, finalName, [...segments, finalName].join("/"));
      try { lstatSync(target); return true; } catch (error) { if (errnoCode(error) === "ENOENT") return false; throw error; }
    } catch (error) {
      if (error instanceof PinnedRootError) throw error;
      throw new PinnedRootError("path_unauthorized", `anchored path could not be inspected safely: ${String(error)}`);
    } finally { parent.close(); }
  }

  /** Return no-follow metadata for one anchored path, or null when absent. */
  pathEntryInfo(relativePath: string): PinnedRootPathEntryInfo | null {
    const segments = safeRelativeSegments(relativePath);
    if (process.platform === "darwin") {
      const result = this.runDescriptorHelper<{ exists: unknown; kind?: unknown; mode?: unknown; size?: unknown; dev?: unknown; ino?: unknown; mtime_ms?: unknown; ctime_ms?: unknown }>("exists", { path: relativePath });
      if (result.exists !== true) return null;
      if (result.kind !== "file" && result.kind !== "directory" && result.kind !== "symlink" && result.kind !== "other") throw new PinnedRootError("write_failed", "descriptor helper returned invalid path metadata");
      if (typeof result.mode !== "number" || !Number.isSafeInteger(result.mode) || result.mode < 0 || typeof result.size !== "number" || typeof result.dev !== "number" || typeof result.ino !== "number" || typeof result.mtime_ms !== "number" || typeof result.ctime_ms !== "number") throw new PinnedRootError("write_failed", "descriptor helper returned incomplete path metadata");
      return { kind: result.kind, mode: result.mode, size: result.size, dev: result.dev, ino: result.ino, mtimeMs: result.mtime_ms, ctimeMs: result.ctime_ms };
    }
    const finalName = segments.pop()!;
    let parent: { fd: number; identity: Stats; close: () => void };
    try { parent = this.openParent(segments, false); }
    catch (error) { if (error instanceof PinnedRootError && error.code === "not_found") return null; throw error; }
    try {
      const target = this.childPath(parent.fd, finalName, [...segments, finalName].join("/"));
      this.assertCanonicalDirectory(segments.join("/"));
      this.assertParentPathIdentity(parent.fd, segments.join("/"));
      let stat: Stats;
      try { stat = lstatSync(target); }
      catch (error) { if (errnoCode(error) === "ENOENT") return null; throw error; }
      const kind = stat.isFile() ? "file" : stat.isDirectory() ? "directory" : stat.isSymbolicLink() ? "symlink" : "other";
      this.assertParentPathIdentity(parent.fd, segments.join("/"));
      this.assertStable();
      return { kind, mode: stat.mode & 0o777, size: stat.size, dev: stat.dev, ino: stat.ino, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
    } catch (error) {
      if (error instanceof PinnedRootError) throw error;
      throw new PinnedRootError("write_failed", `anchored path metadata could not be read safely: ${String(error)}`);
    } finally { parent.close(); }
  }
  /** Return no-follow metadata for several anchored paths in one helper call. */
  pathEntryInfoBatch(relativePaths: readonly string[]): Array<PinnedRootPathEntryInfo | null> {
    relativePaths.forEach((relativePath) => safeRelativeSegments(relativePath));
    if (relativePaths.length === 0) return [];
    if (relativePaths.length > 16) throw new PinnedRootError("invalid", "too many entries in one anchored path metadata batch");
    if (process.platform !== "darwin") return relativePaths.map((relativePath) => this.pathEntryInfo(relativePath));
    const result = this.runDescriptorHelper<{ results?: unknown[] }>("batch", {
      operations: relativePaths.map((path) => ({ op: "exists", path })),
    });
    if (!Array.isArray(result.results) || result.results.length !== relativePaths.length) {
      throw new PinnedRootError("write_failed", "descriptor helper returned incomplete path metadata batch");
    }
    return result.results.map((entry) => {
      if (!entry || typeof entry !== "object") throw new PinnedRootError("write_failed", "descriptor helper returned invalid path metadata batch");
      const value = entry as { exists?: unknown; kind?: unknown; mode?: unknown; size?: unknown; dev?: unknown; ino?: unknown; mtime_ms?: unknown; ctime_ms?: unknown };
      if (value.exists !== true) return null;
      if (value.kind !== "file" && value.kind !== "directory" && value.kind !== "symlink" && value.kind !== "other") throw new PinnedRootError("write_failed", "descriptor helper returned invalid batched path kind");
      if (typeof value.mode !== "number" || !Number.isSafeInteger(value.mode) || value.mode < 0 || typeof value.size !== "number" || typeof value.dev !== "number" || typeof value.ino !== "number" || typeof value.mtime_ms !== "number" || typeof value.ctime_ms !== "number") throw new PinnedRootError("write_failed", "descriptor helper returned incomplete batched path metadata");
      return { kind: value.kind, mode: value.mode, size: value.size, dev: value.dev, ino: value.ino, mtimeMs: value.mtime_ms, ctimeMs: value.ctime_ms };
    });
  }

  /** Create a hard link atomically, preserving an existing destination. */
  linkExclusive(relativeSource: string, relativeDestination: string): void {
    safeRelativeSegments(relativeSource); safeRelativeSegments(relativeDestination);
    assertCurrentExecutionLiveness();
    if (process.platform === "darwin") { this.runDescriptorHelper("link_exclusive", { source: relativeSource, destination: relativeDestination }); return; }
    const sourceSegments = safeRelativeSegments(relativeSource), destinationSegments = safeRelativeSegments(relativeDestination);
    const sourceName = sourceSegments.pop()!, destinationName = destinationSegments.pop()!;
    const sourceParent = this.openParent(sourceSegments, false);
    try {
      const destinationParent = this.openParent(destinationSegments, false);
      try {
        this.assertStable();
        assertCurrentExecutionLiveness();
        linkSync(this.childPath(sourceParent.fd, sourceName, [...sourceSegments, sourceName].join("/")), this.childPath(destinationParent.fd, destinationName, [...destinationSegments, destinationName].join("/")));
        this.assertStable();
        assertCurrentExecutionLiveness();
      } catch (error) {
        if (error instanceof ExecutionLivenessViolation) throw error;
        if (error instanceof PinnedRootError) throw error;
        if (errnoCode(error) === "EEXIST") throw new PinnedRootError("exists", "anchored destination already exists");
        throw new PinnedRootError("write_failed", `anchored hard link failed: ${String(error)}`);
      } finally { destinationParent.close(); }
    } finally { sourceParent.close(); }
  }

  /** Rename one anchored entry without resolving a caller pathname. */
  renameFile(relativeSource: string, relativeDestination: string): void {
    safeRelativeSegments(relativeSource); safeRelativeSegments(relativeDestination);
    assertCurrentExecutionLiveness();
    if (process.platform === "darwin") { this.runDescriptorHelper("rename", { source: relativeSource, destination: relativeDestination }); return; }
    const sourceSegments = safeRelativeSegments(relativeSource), destinationSegments = safeRelativeSegments(relativeDestination);
    const sourceName = sourceSegments.pop()!, destinationName = destinationSegments.pop()!;
    const sourceParent = this.openParent(sourceSegments, false);
    try {
      const destinationParent = this.openParent(destinationSegments, false);
      try {
        this.assertStable();
        assertCurrentExecutionLiveness();
        renameSync(this.childPath(sourceParent.fd, sourceName, [...sourceSegments, sourceName].join("/")), this.childPath(destinationParent.fd, destinationName, [...destinationSegments, destinationName].join("/")));
        this.assertStable();
        assertCurrentExecutionLiveness();
      } catch (error) {
        if (error instanceof ExecutionLivenessViolation) throw error;
        if (error instanceof PinnedRootError) throw error;
        if (errnoCode(error) === "ENOENT") throw new PinnedRootError("not_found", "anchored source does not exist");
        throw new PinnedRootError("write_failed", `anchored rename failed: ${String(error)}`);
      } finally { destinationParent.close(); }
    } finally { sourceParent.close(); }
  }

  /** Atomically rename one anchored entry without replacing an existing destination. */
  renameFileExclusive(relativeSource: string, relativeDestination: string): void {
    safeRelativeSegments(relativeSource); safeRelativeSegments(relativeDestination);
    assertCurrentExecutionLiveness();
    this.runDescriptorHelper("rename_noreplace", { source: relativeSource, destination: relativeDestination });
  }

  /** Remove one anchored directory only after no-follow emptiness verification. */
  removeEmptyDirectory(relativeDirectory: string): void {
    safeRelativeSegments(relativeDirectory);
    assertCurrentExecutionLiveness();
    this.runDescriptorHelper("remove_empty_directory", { path: relativeDirectory });
  }

  /** Remove an empty anchored directory only when its inode still matches. */
  removeEmptyDirectoryIfMatches(relativeDirectory: string, expected: { dev: number; ino: number }): boolean {
    safeRelativeSegments(relativeDirectory);
    assertCurrentExecutionLiveness();
    if (!Number.isSafeInteger(expected.dev) || !Number.isSafeInteger(expected.ino)) throw new PinnedRootError("invalid", "directory expectation is invalid");
    const result = this.runDescriptorHelper<{ removed?: unknown }>("remove_empty_directory_if_matches", {
      path: relativeDirectory,
      expected,
    });
    if (typeof result.removed !== "boolean") throw new PinnedRootError("write_failed", "descriptor helper returned an invalid directory removal result");
    return result.removed;
  }

  /** Remove one empty anchored directory. */
  removeDirectory(relativeDirectory: string): void {
    safeRelativeSegments(relativeDirectory);
    assertCurrentExecutionLiveness();
    if (process.platform === "darwin") { this.runDescriptorHelper("rmdir", { path: relativeDirectory }); return; }
    const segments = safeRelativeSegments(relativeDirectory), finalName = segments.pop()!, parent = this.openParent(segments, false);
    try {
      assertCurrentExecutionLiveness();
      rmdirSync(this.childPath(parent.fd, finalName, [...segments, finalName].join("/")));
      this.assertStable();
      assertCurrentExecutionLiveness();
    } catch (error) {
      if (error instanceof ExecutionLivenessViolation) throw error;
        if (error instanceof PinnedRootError) throw error;
      if (errnoCode(error) === "ENOENT") throw new PinnedRootError("not_found", "anchored directory does not exist");
      throw new PinnedRootError("write_failed", `anchored directory could not be removed: ${String(error)}`);
    } finally { parent.close(); }
  }

  /** Read one bounded regular file through an anchored no-follow descriptor. */
  readFile(relativeFile: string, options: { maxBytes?: number } = {}): PinnedRootReadResult {
    const segments = safeRelativeSegments(relativeFile);
    const maxBytes = options.maxBytes ?? MAX_PINNED_ROOT_READ_BYTES;
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > MAX_PINNED_ROOT_READ_BYTES) throw new PinnedRootError("invalid", "bounded read limit is invalid");
    if (process.platform === "darwin") {
      const result = this.runDescriptorHelper<{ bytes: string; dev: number; ino: number; size: number; mtime_ms: number; ctime_ms: number }>("read", { path: relativeFile, max_read: maxBytes });
      return { path: this.canonicalPath(relativeFile), bytes: Buffer.from(result.bytes, "base64"), dev: result.dev, ino: result.ino, size: result.size, mtimeMs: result.mtime_ms, ctimeMs: result.ctime_ms };
    }
    const finalName = segments.pop()!;
    const parent = this.openParent(segments, false);
    let fileFd: number | null = null;
    try {
      const flags = readFlags();
      if (flags === null) throw new PinnedRootError("unsupported", "descriptor no-follow reads are unavailable");
      const target = this.childPath(parent.fd, finalName, [...segments, finalName].join("/"));
      this.assertCanonicalDirectory(segments.join("/"));
      this.assertParentPathIdentity(parent.fd, segments.join("/"));
      fileFd = openSync(target, flags);
      const before = fstatSync(fileFd);
      if (!before.isFile()) throw new PinnedRootError("not_regular", "anchored source must be a regular file");
      if (!Number.isSafeInteger(before.size) || before.size < 0 || before.size > maxBytes) throw new PinnedRootError("write_failed", "anchored source exceeds the bounded read limit");
      // Read one byte beyond the queue budget so a concurrent append is
      // detected before any JSON parse. The initial fstat remains a fast fail
      // for an already oversized file, while the bounded loop handles growth.
      const bytes = Buffer.allocUnsafe(maxBytes + 1);
      let offset = 0;
      while (offset < maxBytes + 1) {
        const count = readSync(fileFd, bytes, offset, maxBytes + 1 - offset, offset);
        if (count === 0) break;
        offset += count;
      }
      if (offset > maxBytes) throw new PinnedRootError("write_failed", "anchored source exceeds the bounded read limit");
      const resultBytes = bytes.subarray(0, offset);
      const after = fstatSync(fileFd);
      if (offset !== before.size || !sameIdentity(before, after) || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
        throw new PinnedRootError("changed", "anchored source changed while it was being read");
      }
      this.assertParentPathIdentity(parent.fd, segments.join("/"));
      const pathname = lstatSync(target);
      if (pathname.isSymbolicLink() || !pathname.isFile() || !sameIdentity(pathname, after)) throw new PinnedRootError("changed", "anchored source pathname changed while it was being read");
      this.assertStable();
      return { path: this.canonicalPath(relativeFile), bytes: resultBytes, dev: after.dev, ino: after.ino, size: after.size, mtimeMs: after.mtimeMs, ctimeMs: after.ctimeMs };
    } catch (error) {
      if (error instanceof PinnedRootError) throw error;
      const code = errnoCode(error);
      if (code === "ENOENT") throw new PinnedRootError("not_found", "anchored source does not exist");
      throw new PinnedRootError("write_failed", `anchored source could not be read safely: ${String(error)}`);
    } finally {
      closeQuietly(fileFd);
      parent.close();
    }
  }

  /** Read only a bounded prefix of a regular file, allowing larger files. */
  readFilePrefix(relativeFile: string, options: { maxBytes?: number } = {}): PinnedRootReadResult {
    const segments = safeRelativeSegments(relativeFile);
    const maxBytes = options.maxBytes ?? MAX_PINNED_ROOT_READ_BYTES;
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > MAX_PINNED_ROOT_READ_BYTES) throw new PinnedRootError("invalid", "bounded prefix read limit is invalid");
    if (process.platform === "darwin") {
      const result = this.runDescriptorHelper<{ bytes: string; dev: number; ino: number }>("read_prefix", { path: relativeFile, max_read: maxBytes });
      return { path: this.canonicalPath(relativeFile), bytes: Buffer.from(result.bytes, "base64"), dev: result.dev, ino: result.ino };
    }
    const finalName = segments.pop()!;
    const parent = this.openParent(segments, false);
    let fileFd: number | null = null;
    try {
      const flags = readFlags();
      if (flags === null) throw new PinnedRootError("unsupported", "descriptor no-follow reads are unavailable");
      const target = this.childPath(parent.fd, finalName, [...segments, finalName].join("/"));
      this.assertCanonicalDirectory(segments.join("/"));
      this.assertParentPathIdentity(parent.fd, segments.join("/"));
      fileFd = openSync(target, flags);
      const before = fstatSync(fileFd);
      if (!before.isFile()) throw new PinnedRootError("not_regular", "anchored source must be a regular file");
      const bytes = Buffer.allocUnsafe(maxBytes);
      let offset = 0;
      while (offset < maxBytes) {
        const count = readSync(fileFd, bytes, offset, maxBytes - offset, offset);
        if (count === 0) break;
        offset += count;
      }
      const after = fstatSync(fileFd);
      if (!sameIdentity(before, after) || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
        throw new PinnedRootError("changed", "anchored source changed while it was being read");
      }
      this.assertParentPathIdentity(parent.fd, segments.join("/"));
      const pathname = lstatSync(target);
      if (pathname.isSymbolicLink() || !pathname.isFile() || !sameIdentity(pathname, after)) throw new PinnedRootError("changed", "anchored source pathname changed while it was being read");
      this.assertStable();
      return { path: this.canonicalPath(relativeFile), bytes: bytes.subarray(0, offset), dev: after.dev, ino: after.ino };
    } catch (error) {
      if (error instanceof PinnedRootError) throw error;
      const code = errnoCode(error);
      if (code === "ENOENT") throw new PinnedRootError("not_found", "anchored source does not exist");
      throw new PinnedRootError("write_failed", `anchored source prefix could not be read safely: ${String(error)}`);
    } finally {
      closeQuietly(fileFd);
      parent.close();
    }
  }
  /** Read one bounded regular-file batch under one anchored helper request. */
  readBatch(
    relativeDirectory: string,
    names: readonly string[],
    options: { maxEntries?: number; maxNameBytes?: number; maxBytes?: number; maxTotalBytes?: number } = {},
  ): {
    records: Array<{ name: string; bytes: Uint8Array; dev: number; ino: number }>;
    failed: string[];
    remaining: string[];
  } {
    safeRelativeSegments(relativeDirectory, true);
    const maxEntries = options.maxEntries ?? 64;
    const maxNameBytes = options.maxNameBytes ?? DEFAULT_DIRECTORY_MAX_NAME_BYTES;
    const maxBytes = options.maxBytes ?? MAX_PINNED_ROOT_READ_BYTES;
    const maxTotalBytes = options.maxTotalBytes ?? 2 * 1024 * 1024;
    if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0 || maxEntries > DEFAULT_DIRECTORY_MAX_ENTRIES || names.length > maxEntries || !Number.isSafeInteger(maxNameBytes) || maxNameBytes <= 0 || maxNameBytes > DEFAULT_DIRECTORY_MAX_NAME_BYTES || !Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > MAX_PINNED_ROOT_READ_BYTES || !Number.isSafeInteger(maxTotalBytes) || maxTotalBytes <= 0 || maxTotalBytes > 2 * 1024 * 1024) {
      throw new PinnedRootError("invalid", "bounded read batch limits are invalid");
    }
    const validNames = names.map((name) => {
      const segments = safeRelativeSegments(name);
      if (segments.length !== 1) throw new PinnedRootError("path_unauthorized", "read batch entry must be one path segment");
      return segments[0]!;
    });
    if (validNames.reduce((total, name) => total + Buffer.byteLength(name, "utf8"), 0) > maxNameBytes) {
      throw new PinnedRootError("limit", "bounded read batch exceeded name-byte limit");
    }
    if (validNames.length === 0) return { records: [], failed: [], remaining: [] };
    if (process.platform === "darwin") {
      const result = this.runDescriptorHelper<{ records?: unknown; failed?: unknown; remaining?: unknown }>("read_batch", {
        path: relativeDirectory,
        names: validNames,
        max_entries: maxEntries,
        max_name_bytes: maxNameBytes,
        max_read: maxBytes,
        max_total_bytes: maxTotalBytes,
      });
      if (!Array.isArray(result.records) || !Array.isArray(result.failed) || !Array.isArray(result.remaining)) {
        throw new PinnedRootError("write_failed", "descriptor helper returned invalid read batch records");
      }
      const allowed = new Set(validNames);
      const records = result.records.flatMap((record) => {
        if (!record || typeof record !== "object") return [];
        const value = record as { name?: unknown; bytes?: unknown; dev?: unknown; ino?: unknown };
        if (typeof value.name !== "string" || !allowed.has(value.name) || typeof value.bytes !== "string" || !Number.isSafeInteger(value.dev) || !Number.isSafeInteger(value.ino)) return [];
        return [{ name: value.name, bytes: Buffer.from(value.bytes, "base64"), dev: value.dev as number, ino: value.ino as number }];
      });
      const failed = result.failed.filter((name): name is string => typeof name === "string" && allowed.has(name));
      const remaining = result.remaining.filter((name): name is string => typeof name === "string" && allowed.has(name));
      return { records, failed, remaining };
    }
    const records: Array<{ name: string; bytes: Uint8Array; dev: number; ino: number }> = [];
    const failed: string[] = [];
    const remaining: string[] = [];
    let totalBytes = 0;
    for (let index = 0; index < validNames.length; index += 1) {
      const name = validNames[index]!;
      try {
        const read = this.readFile(join(relativeDirectory, name), { maxBytes });
        if (totalBytes + read.bytes.byteLength > maxTotalBytes) {
          remaining.push(...validNames.slice(index));
          break;
        }
        totalBytes += read.bytes.byteLength;
        records.push({ name, bytes: read.bytes, dev: read.dev, ino: read.ino });
      } catch {
        failed.push(name);
      }
    }
    return { records, failed, remaining };
  }


  /**
   * Return one stable lexicographic page of descriptor-anchored entries.
   * The directory is scanned once within explicit scan bounds; the cursor is
   * the last returned name and therefore remains monotonic across pages.
   */
  listDirectoryPage(
    relativeDirectory = "",
    options: {
      cursor?: string | null;
      maxEntries?: number;
      maxNameBytes?: number;
      maxScanEntries?: number;
      maxScanNameBytes?: number;
    } = {},
  ): PinnedRootDirectoryPage {
    const segments = safeRelativeSegments(relativeDirectory, true);
    const maxEntries = options.maxEntries ?? 64;
    const maxNameBytes = options.maxNameBytes ?? DEFAULT_DIRECTORY_MAX_NAME_BYTES;
    const maxScanEntries = options.maxScanEntries ?? DEFAULT_DIRECTORY_MAX_ENTRIES;
    const maxScanNameBytes = options.maxScanNameBytes ?? DEFAULT_DIRECTORY_MAX_NAME_BYTES;
    const cursor = options.cursor ?? null;
    if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0 || maxEntries > DEFAULT_DIRECTORY_MAX_ENTRIES
      || !Number.isSafeInteger(maxNameBytes) || maxNameBytes <= 0 || maxNameBytes > DEFAULT_DIRECTORY_MAX_NAME_BYTES
      || !Number.isSafeInteger(maxScanEntries) || maxScanEntries <= 0 || maxScanEntries > DEFAULT_DIRECTORY_MAX_ENTRIES
      || !Number.isSafeInteger(maxScanNameBytes) || maxScanNameBytes <= 0 || maxScanNameBytes > DEFAULT_DIRECTORY_MAX_NAME_BYTES
      || (cursor !== null && (typeof cursor !== "string" || cursor.length > MAX_RELATIVE_PATH_LENGTH))) {
      throw new PinnedRootError("invalid", "bounded directory pagination limits or cursor are invalid");
    }
    let allNames: string[];
    if (process.platform === "darwin") {
      const result = this.runDescriptorHelper<{ names: unknown }>("list", {
        path: relativeDirectory,
        max_entries: maxScanEntries,
        max_name_bytes: maxScanNameBytes,
      });
      if (!Array.isArray(result.names) || result.names.some((name) => typeof name !== "string")) {
        throw new PinnedRootError("write_failed", "descriptor helper returned invalid directory entries");
      }
      allNames = result.names as string[];
    } else {
      const parent = this.openParent(segments, false);
      let directory: ReturnType<typeof opendirSync> | null = null;
      try {
        this.assertCanonicalDirectory(segments.join("/"));
        this.assertParentPathIdentity(parent.fd, segments.join("/"));
        const parentPath = this.parentDirectoryPath(parent.fd, segments.join("/"));
        directory = opendirSync(parentPath);
        allNames = [];
        let scanWork = 0;
        while (true) {
          const entry = directory.readSync();
          if (entry === null) break;
          if (allNames.length >= maxScanEntries) throw new PinnedRootError("limit", "bounded directory enumeration exceeded entry limit");
          const nameBytes = Buffer.byteLength(entry.name, "utf8");
          if (scanWork + nameBytes > maxScanNameBytes) throw new PinnedRootError("limit", "bounded directory enumeration exceeded name-byte limit");
          allNames.push(entry.name);
          scanWork += nameBytes;
        }
        this.assertCanonicalDirectory(segments.join("/"));
        this.assertParentPathIdentity(parent.fd, segments.join("/"));
        this.assertStable();
      } catch (error) {
        if (error instanceof PinnedRootError) throw error;
        const code = errnoCode(error);
        if (code === "ENOENT") throw new PinnedRootError("not_found", "anchored directory does not exist");
        throw new PinnedRootError("write_failed", `anchored directory could not be listed safely: ${String(error)}`);
      } finally {
        try { directory?.closeSync(); } catch { /* preserve the primary listing result */ }
        parent.close();
      }
    }
    allNames.sort();
    const start = cursor === null ? 0 : allNames.findIndex((name) => name > cursor);
    if (start < 0) return { names: [], nextCursor: null };
    const names: string[] = [];
    let pageWork = 0;
    for (let index = start; index < allNames.length && names.length < maxEntries; index += 1) {
      const name = allNames[index]!;
      const nameBytes = Buffer.byteLength(name, "utf8");
      if (nameBytes > maxNameBytes || pageWork + nameBytes > maxNameBytes) {
        if (names.length === 0) throw new PinnedRootError("limit", "bounded directory page exceeded name-byte limit");
        break;
      }
      names.push(name);
      pageWork += nameBytes;
    }
    if (names.length === 0 && start < allNames.length) throw new PinnedRootError("limit", "bounded directory page made no progress");
    const last = names.at(-1) ?? null;
    const nextCursor = last !== null && allNames.some((name) => name > last) ? last : null;
    return { names, nextCursor };
  }

  /**
   * Read one bounded, unsorted directory batch directly from the OS iterator.
   * This is for destructive queues: callers remove the returned entries and
   * request another batch on the next tick, so no whole-directory scan or
   * cursor is needed to make progress through large queues.
   */
  listDirectoryBatch(
    relativeDirectory = "",
    options: { maxEntries?: number; maxNameBytes?: number } = {},
  ): string[] {
    const segments = safeRelativeSegments(relativeDirectory, true);
    const maxEntries = options.maxEntries ?? 64;
    const maxNameBytes = options.maxNameBytes ?? DEFAULT_DIRECTORY_MAX_NAME_BYTES;
    if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0 || maxEntries > DEFAULT_DIRECTORY_MAX_ENTRIES
      || !Number.isSafeInteger(maxNameBytes) || maxNameBytes <= 0 || maxNameBytes > DEFAULT_DIRECTORY_MAX_NAME_BYTES) {
      throw new PinnedRootError("invalid", "bounded directory batch limits are invalid");
    }
    if (process.platform === "darwin") {
      const result = this.runDescriptorHelper<{ names: unknown }>("list_batch", {
        path: relativeDirectory,
        max_entries: maxEntries,
        max_name_bytes: maxNameBytes,
      });
      if (!Array.isArray(result.names) || result.names.some((name) => typeof name !== "string")) {
        throw new PinnedRootError("write_failed", "descriptor helper returned invalid directory batch entries");
      }
      return result.names as string[];
    }
    const parent = this.openParent(segments, false);
    let directory: ReturnType<typeof opendirSync> | null = null;
    try {
      this.assertCanonicalDirectory(segments.join("/"));
      this.assertParentPathIdentity(parent.fd, segments.join("/"));
      const parentPath = this.parentDirectoryPath(parent.fd, segments.join("/"));
      directory = opendirSync(parentPath);
      const names: string[] = [];
      let work = 0;
      for (let index = 0; index < maxEntries; index += 1) {
        const entry = directory.readSync();
        if (entry === null) break;
        const nameBytes = Buffer.byteLength(entry.name, "utf8");
        if (nameBytes > maxNameBytes || work + nameBytes > maxNameBytes) {
          if (names.length === 0) throw new PinnedRootError("limit", "bounded directory batch exceeded name-byte limit");
          break;
        }
        names.push(entry.name);
        work += nameBytes;
      }
      this.assertCanonicalDirectory(segments.join("/"));
      this.assertParentPathIdentity(parent.fd, segments.join("/"));
      this.assertStable();
      return names;
    } catch (error) {
      if (error instanceof PinnedRootError) throw error;
      const code = errnoCode(error);
      if (code === "ENOENT") throw new PinnedRootError("not_found", "anchored directory does not exist");
      throw new PinnedRootError("write_failed", "anchored directory batch could not be listed safely: " + String(error));
    } finally {
      try { directory?.closeSync(); } catch { /* preserve the primary listing result */ }
      parent.close();
    }
  }

  /** List all entries only within an explicit bounded directory budget. */
  listDirectory(
    relativeDirectory = "",
    options: { maxEntries?: number; maxNameBytes?: number } = {},
  ): string[] {
    const maxEntries = options.maxEntries ?? DEFAULT_DIRECTORY_MAX_ENTRIES;
    const maxNameBytes = options.maxNameBytes ?? DEFAULT_DIRECTORY_MAX_NAME_BYTES;
    const page = this.listDirectoryPage(relativeDirectory, {
      maxEntries,
      maxNameBytes,
      maxScanEntries: maxEntries,
      maxScanNameBytes: maxNameBytes,
    });
    if (page.nextCursor !== null) throw new PinnedRootError("limit", "bounded directory enumeration exceeded entry limit");
    return page.names;
  }

  /** Replace one regular file only when its inode and SHA-256 still match. */
  replaceFileIfMatches(relativeFile: string, expected: PinnedRootFileExpectation, content: PinnedRootWriteContent): void {
    this.replaceFileIfMatchesWithDescriptor(relativeFile, expected, content);
  }

  /** Compare-and-swap replacement returning the inode published by this operation. */
  replaceFileIfMatchesWithDescriptor(
    relativeFile: string,
    expected: PinnedRootFileExpectation,
    content: PinnedRootWriteContent,
    options: PinnedRootWriteOptions = {},
  ): PinnedRootWriteDescriptor {
    const preparedPlatform = options.beforePublish !== undefined && (process.platform === "darwin" || process.platform === "linux");
    const capturedPreimage = preparedPlatform ? undefined : this.captureWritePreimage(relativeFile);
    if (preparedPlatform) {
      const prepared = this.writeDarwinPrepared("atomic", relativeFile, content, options, expected);
      const published = this.finishPublishedDescriptor(relativeFile, prepared.descriptor, prepared.preimage, true);
      descriptorPreimages.set(published, prepared.preimage);
      descriptorReceipts.set(published, this.makeWriteReceipt(relativeFile, published, prepared.preimage));
      return published;
    }
    const result = this.conditionalCommit(relativeFile, expected, content, "replace", (published) => {
      if (published.recovered === true) return;
      try {
        const descriptor = descriptorFromResponse(relativeFile, this.anchorPath(relativeFile), content, published);
        const preimage = preimageFromResponse(published);
        if (!this.rollbackPublishedDescriptor(relativeFile, descriptor, preimage)) {
          throw new PinnedRootError("changed", "conditional replacement rollback could not be proven");
        }
      } catch {
        // Preserve the original conditional-operation failure; a malformed
        // descriptor is not safe to adopt or use for rollback.
      }
    });
    const descriptor = descriptorFromResponse(relativeFile, this.anchorPath(relativeFile), content, result);
    const preimage = result.recovered === true
      ? (capturedPreimage ?? (() => { throw new PinnedRootError("write_failed", "conditional replacement recovery lost its exact preimage"); })())
      : preimageFromResponse(result);
    const published = this.finishPublishedDescriptor(relativeFile, descriptor, preimage, result.recovered !== true);
    descriptorPreimages.set(published, preimage);
    descriptorReceipts.set(published, this.makeWriteReceipt(relativeFile, published, preimage));
    return published;
  }

  /** Conditional replacement receipt retaining the exact replaced preimage. */
  replaceFileIfMatchesWithReceipt(
    relativeFile: string,
    expected: PinnedRootFileExpectation,
    content: PinnedRootWriteContent,
    options: PinnedRootWriteOptions = {},
  ): PinnedRootWriteReceipt {
    // Receipt-producing conditional replacements must retain the helper's
    // prepared lease through descriptor conversion even without a user hook;
    // route through the same prepared protocol with an internal no-op marker.
    const preparedOptions = options.beforePublish ? options : { ...options, beforePublish: () => {} };
    const descriptor = this.replaceFileIfMatchesWithDescriptor(relativeFile, expected, content, preparedOptions);
    const receipt = descriptorReceipts.get(descriptor);
    if (receipt) return receipt;
    const preimage = descriptorPreimages.get(descriptor);
    if (!preimage) throw new PinnedRootError("write_failed", "conditional replacement returned no exact preimage");
    const created = this.makeWriteReceipt(relativeFile, descriptor, preimage);
    descriptorReceipts.set(descriptor, created);
    return created;
  }

  /** Remove one regular file only when its inode and SHA-256 still match. */
  removeFileIfMatches(relativeFile: string, expected: PinnedRootFileExpectation): void {
    this.conditionalCommit(relativeFile, expected, null, "remove");
  }

  private conditionalCommit(
    relativeFile: string,
    expected: PinnedRootFileExpectation,
    content: PinnedRootWriteContent | null,
    operation: ConditionalOperation,
    onPublishedFailure?: (result: PinnedWriteDescriptorResponse) => void,
  ): PinnedWriteDescriptorResponse {
    const segments = safeRelativeSegments(relativeFile);
    if (operation === "replace") contentByteLength(content as PinnedRootWriteContent);
    this.assertExpectation(expected);
    if (process.platform === "darwin" || process.platform === "linux") {
      let result: PinnedWriteDescriptorResponse | undefined;
      try {
        this.hooks.beforeConditionalCommit?.(relativeFile);
        this.assertStable();
        // mutation. These deterministic seams execute immediately before that
        // request; the helper repeats every check, so an injected interloper
        // is rejected without touching its bytes.
        this.hooks.afterConditionalLock?.(relativeFile);
        this.hooks.afterConditionalVerification?.(relativeFile);
        this.hooks.afterConditionalStage?.(relativeFile);
        this.hooks.beforeRename?.(relativeFile);
        result = this.runDescriptorHelper<PinnedWriteDescriptorResponse>(operation === "replace" ? "replace_if_matches" : "remove_if_matches", {
          path: relativeFile,
          expected,
          ...(operation === "replace" ? { bytes: contentToBase64(content as PinnedRootWriteContent) } : {}),
          ...(this.hooks.conditionalFailurePhase ? { failure_phase: this.hooks.conditionalFailurePhase } : {}), ...(this.hooks.preparedPostVerifyMutation ? { test_prepared_post_verify_mutation: true } : {}), ...(this.hooks.preparedLeaseReplacement ? { test_prepared_lease_replacement: true } : {}),
          ...(operation === "replace" && this.hooks.conditionalPostExchangeMutation ? { test_post_exchange_mutation: true } : {}),
          ...(operation === "replace" && this.hooks.conditionalPreExchangeMutation ? { test_pre_exchange_mutation: true } : {}),
          ...(operation === "replace" && this.hooks.conditionalStagePreExchangeMutation ? { test_stage_pre_exchange_mutation: true } : {}),
          ...(this.hooks.conditionalPostExchangeStageMutation ? { test_post_exchange_stage_mutation: true } : {}),
          ...(operation === "remove" && this.hooks.conditionalPreMoveMutation ? { test_pre_move_mutation: true } : {}),
          ...(operation === "remove" && this.hooks.conditionalPreMoveSymlink ? { test_pre_move_symlink: true } : {}),
        });
        this.hooks.afterConditionalReplace?.(relativeFile);
        if (this.hooks.afterConditionalReplace) {
          try {
            if (operation === "replace") {
              const observed = this.readFile(relativeFile, { maxBytes: MAX_PINNED_ROOT_READ_BYTES });
              const desired = Buffer.from(content as PinnedRootWriteContent);
              if (!Buffer.from(observed.bytes).equals(desired)) throw new PinnedRootError("changed", "anchored target changed after conditional replacement");
            } else if (this.pathEntryExists(relativeFile)) {
              throw new PinnedRootError("changed", "anchored target changed after conditional removal");
            }
          } catch (error) {
            if (error instanceof PinnedRootError && error.code === "not_found" && operation === "replace") {
              throw new PinnedRootError("changed", "anchored target disappeared after conditional replacement");
            }
            throw error;
          }
        }
      } catch (error) {
        if (result?.ok === true && result.recovered !== true) onPublishedFailure?.(result);
        throw error;
      } finally {
        try { this.hooks.beforeConditionalCleanup?.(relativeFile); } catch { /* preserve the primary operation result */ }
        try { this.hooks.beforeCleanup?.(relativeFile); } catch { /* preserve the primary operation result */ }
      }
      assertCurrentExecutionLiveness();
      if (!result) throw new PinnedRootError("write_failed", "conditional operation completed without a result");
      return result;
    }
    throw new PinnedRootError("unsupported", "conditional replace/remove is unsupported on this platform");
  }

  private assertConditionalExpectation(observed: PinnedRootReadResult, expected: PinnedRootFileExpectation, message: string): void {
    const digest = createHash("sha256").update(observed.bytes).digest("hex");
    if (observed.dev !== expected.dev || observed.ino !== expected.ino || digest !== expected.sha256) throw new PinnedRootError("changed", message);
  }

  /** Crash-durable exclusive temp-write/fsync/hard-link anchored to the pinned root. */
  writeExclusive(relativeFile: string, content: PinnedRootWriteContent): void {
    this.writeExclusiveWithDescriptor(relativeFile, content);
  }

  /**
   * Exclusive write returning the inode published by this operation. The
   * descriptor is captured from the operation's own temp inode, not by
   * re-opening the final pathname after a concurrent writer can replace it.
   */
  writeExclusiveWithDescriptor(relativeFile: string, content: PinnedRootWriteContent, options: PinnedRootWriteOptions = {}): PinnedRootWriteDescriptor {
    contentByteLength(content);
    const segments = safeRelativeSegments(relativeFile);
    assertCurrentExecutionLiveness();
    if (process.platform === "darwin") {
      let prepared: { descriptor: PinnedRootWriteDescriptor; preimage: PinnedRootWritePreimage } | null = null;
      try {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            this.hooks.beforeTempOpen?.(relativeFile);
            this.hooks.beforeRename?.(relativeFile);
            prepared = this.writeDarwinPrepared("exclusive", relativeFile, content, options);
            break;
          } catch (error) {
            if (!(error instanceof PinnedRootError) || error.code !== "changed" || attempt === 1) throw error;
          }
        }
      } finally {
        try { this.hooks.beforeCleanup?.(relativeFile); } catch { /* preserve the primary operation result */ }
      }
      if (!prepared) throw new PinnedRootError("write_failed", "prepared exclusive write completed without an operation descriptor");
      const published = this.finishPublishedDescriptor(relativeFile, prepared.descriptor, prepared.preimage, true);
      descriptorReceipts.set(published, this.makeWriteReceipt(relativeFile, published, prepared.preimage));
      return published;
    }
    const preimage = this.captureWritePreimage(relativeFile);
    const finalName = segments.pop()!;
    const parent = this.openParent(segments, true);
    const relativeTarget = [...segments, finalName].join("/");
    let tempFd: number | null = null;
    let tempPath: string | null = null;
    let descriptor: PinnedRootWriteDescriptor | null = null;
    let publicationComplete = false;
    try {
      const flags = writeFlags();
      if (flags === null) throw new PinnedRootError("unsupported", "descriptor no-follow writes are unavailable");
      const parentPath = this.parentDirectoryPath(parent.fd, segments.join("/"));
      for (let attempt = 0; attempt < 32; attempt += 1) {
        const tempName = boundedTemporaryComponent("write", relativeTarget, ".tmp");
        const candidate = join(parentPath, tempName);
        this.hooks.beforeTempOpen?.(relativeTarget);
        this.assertCanonicalDirectory(segments.join("/"));
        this.assertParentPathIdentity(parent.fd, segments.join("/"));
        try {
          tempFd = openSync(candidate, flags, 0o600);
          tempPath = candidate;
          break;
        } catch (error) {
          if (errnoCode(error) !== "EEXIST") throw error;
        }
      }
      if (tempFd === null || tempPath === null) throw new PinnedRootError("write_failed", "unable to reserve an exclusive temp file");
      const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
      let offset = 0;
      while (offset < bytes.length) {
        const written = writeSync(tempFd, bytes, offset, bytes.length - offset);
        if (written <= 0) throw new PinnedRootError("write_failed", "short anchored exclusive write");
        offset += written;
      }
      fchmodSync(tempFd, 0o600);
      fsyncSync(tempFd);
      this.assertStable();
      const parentAfter = fstatSync(parent.fd);
      if (!sameIdentity(parentAfter, parent.identity)) throw new PinnedRootError("changed", "anchored parent changed during exclusive commit");
      const target = join(parentPath, finalName);
      try {
        const existing = lstatSync(target);
        if (existing.isSymbolicLink() || (!existing.isFile() && !existing.isDirectory())) throw new PinnedRootError("path_unauthorized", "anchored exclusive target is unsafe");
        throw new PinnedRootError("exists", "anchored exclusive target already exists");
      } catch (error) {
        if (error instanceof PinnedRootError) throw error;
        if (errnoCode(error) !== "ENOENT") throw error;
      }
      const source = fstatSync(tempFd);
      const planned: PinnedRootWriteDescriptor = {
        path: this.anchorPath(relativeFile),
        relative_path: relativeFile,
        dev: source.dev,
        ino: source.ino,
        size: contentByteLength(content),
        sha256: contentSha256(content),
      };
      this.hooks.beforeRename?.(relativeTarget);
      this.assertCanonicalDirectory(segments.join("/"));
      this.assertParentPathIdentity(parent.fd, segments.join("/"));
      this.assertStable();
      assertCurrentExecutionLiveness();
      const receipt = this.makeWriteReceipt(relativeFile, planned, preimage);
      this.hooks.beforePublish?.(receipt);
      options.beforePublish?.(receipt);
      try {
        linkSync(tempPath, target);
      } catch (error) {
        if (errnoCode(error) === "EEXIST") throw new PinnedRootError("exists", "anchored exclusive target already exists");
        throw error;
      }
      descriptor = planned;
      publicationComplete = true;
      this.hooks.afterPublish?.(relativeTarget);
      const committed = lstatSync(target);
      if (committed.isSymbolicLink() || !committed.isFile() || !sameIdentity(committed, source)) throw new PinnedRootError("path_unauthorized", "anchored exclusive destination changed during commit");
      closeQuietly(tempFd);
      tempFd = null;
      unlinkSync(tempPath);
      tempPath = null;
      try {
        fsyncSync(parent.fd);
      } catch (error) {
        const code = errnoCode(error);
        if (code !== "EINVAL" && code !== "ENOTSUP") throw error;
      }
      this.hooks.afterPublishLiveness?.(relativeTarget);
      assertCurrentExecutionLiveness();
    } catch (error) {
      if (publicationComplete && descriptor !== null) {
        let rolledBack = false;
        try {
          rolledBack = withoutCurrentExecutionLiveness(() => this.rollbackPublishedDescriptor(relativeFile, descriptor!, preimage));
        } catch {
          rolledBack = false;
        }
        if (!rolledBack) {
          throw new PinnedRootError("changed", `anchored exclusive publication failed and its exact rollback could not be proven: ${String(error)}`);
        }
        publicationComplete = false;
      }
      if (error instanceof ExecutionLivenessViolation) throw error;
      if (error instanceof PinnedRootError) throw error;
      const code = errnoCode(error);
      if (code === "ENOENT") throw new PinnedRootError("not_found", `anchored parent does not exist for '${relativeTarget}'`);
      throw new PinnedRootError("write_failed", `anchored exclusive write failed: ${String(error)}`);
    } finally {
      try { this.hooks.beforeCleanup?.(relativeTarget); } catch { /* test seams cannot replace the primary result */ }
      closeQuietly(tempFd);
      if (tempPath !== null) {
        let safeCleanup = true;
        try { this.assertCanonicalDirectory(segments.join("/")); } catch { safeCleanup = false; }
        if (safeCleanup) { try { unlinkSync(tempPath); } catch { } }
      }
      parent.close();
    }
    if (descriptor === null) throw new PinnedRootError("write_failed", "anchored exclusive write completed without an operation descriptor");
    const published = this.finishPublishedDescriptor(relativeFile, descriptor, preimage);
    descriptorReceipts.set(published, this.makeWriteReceipt(relativeFile, published, preimage));
    return published;
  }

  /** Exact publication receipt with the preimage captured by the transaction. */
  writeExclusiveWithReceipt(relativeFile: string, content: PinnedRootWriteContent, options: PinnedRootWriteOptions = {}): PinnedRootWriteReceipt {
    const descriptor = this.writeExclusiveWithDescriptor(relativeFile, content, options);
    const receipt = descriptorReceipts.get(descriptor);
    if (receipt) return receipt;
    return this.makeWriteReceipt(relativeFile, descriptor, this.captureWritePreimage(relativeFile));
  }

  /** Crash-durable temp-write/fsync/rename anchored to the pinned root. */
  writeAtomic(relativeFile: string, content: PinnedRootWriteContent): void {
    this.writeAtomicWithDescriptor(relativeFile, content);
  }

  /** Exact publication receipt with the preimage captured by the transaction. */
  writeAtomicWithReceipt(relativeFile: string, content: PinnedRootWriteContent, options: PinnedRootWriteOptions = {}): PinnedRootWriteReceipt {
    const descriptor = this.writeAtomicWithDescriptor(relativeFile, content, options);
    const receipt = descriptorReceipts.get(descriptor);
    if (receipt) return receipt;
    return this.makeWriteReceipt(relativeFile, descriptor, this.captureWritePreimage(relativeFile));
  }

  /** Atomic write returning the inode published by this operation. */
  writeAtomicWithDescriptor(relativeFile: string, content: PinnedRootWriteContent, options: PinnedRootWriteOptions = {}): PinnedRootWriteDescriptor {
    contentByteLength(content);
    const segments = safeRelativeSegments(relativeFile);
    assertCurrentExecutionLiveness();
    if (process.platform === "darwin") {
      let prepared: { descriptor: PinnedRootWriteDescriptor; preimage: PinnedRootWritePreimage } | null = null;
      try {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            this.hooks.beforeTempOpen?.(relativeFile);
            this.hooks.beforeRename?.(relativeFile);
            prepared = this.writeDarwinPrepared("atomic", relativeFile, content, options);
            break;
          } catch (error) {
            if (!(error instanceof PinnedRootError) || error.code !== "changed" || attempt === 1) throw error;
          }
        }
      } finally {
        try { this.hooks.beforeCleanup?.(relativeFile); } catch { /* preserve the primary operation result */ }
      }
      if (!prepared) throw new PinnedRootError("write_failed", "prepared atomic write completed without an operation descriptor");
      const published = this.finishPublishedDescriptor(relativeFile, prepared.descriptor, prepared.preimage, true);
      descriptorReceipts.set(published, this.makeWriteReceipt(relativeFile, published, prepared.preimage));
      return published;
    }
    const existingEntry = this.pathEntryInfo(relativeFile);
    if (existingEntry !== null && process.platform === "linux") {
      const expectedPreimage = this.captureWritePreimage(relativeFile);
      if (expectedPreimage.kind !== "file") throw new PinnedRootError("changed", "anchored replacement target disappeared before CAS preparation");
      const prepared = this.writeDarwinPrepared("atomic", relativeFile, content, options, expectedPreimage.expectation);
      const published = this.finishPublishedDescriptor(relativeFile, prepared.descriptor, prepared.preimage, true);
      descriptorPreimages.set(published, prepared.preimage);
      descriptorReceipts.set(published, this.makeWriteReceipt(relativeFile, published, prepared.preimage));
      return published;
    }
    if (existingEntry !== null) {
      throw new PinnedRootError("unsupported", "anchored replacement requires a kernel compare-and-swap transaction");
    }
    const preimage = this.captureWritePreimage(relativeFile);
    const finalName = segments.pop()!;
    const parent = this.openParent(segments, true);
    const relativeTarget = [
      ...segments,
      finalName,
    ].join("/");
    let tempFd: number | null = null;
    let tempPath: string | null = null;
    let descriptor: PinnedRootWriteDescriptor | null = null;
    let committed = false;
    try {
      const flags = writeFlags();
      if (flags === null) throw new PinnedRootError("unsupported", "descriptor no-follow writes are unavailable");
      const parentPath = this.parentDirectoryPath(parent.fd, segments.join("/"));
      for (let attempt = 0; attempt < 32; attempt += 1) {
        const tempName = boundedTemporaryComponent("write", relativeTarget, ".tmp");
        const candidate = join(parentPath, tempName);
        this.hooks.beforeTempOpen?.(relativeTarget);
        this.assertCanonicalDirectory(segments.join("/"));
        this.assertParentPathIdentity(parent.fd, segments.join("/"));
        try {
          tempFd = openSync(candidate, flags, 0o600);
          tempPath = candidate;
          break;
        } catch (error) {
          if (errnoCode(error) !== "EEXIST") throw error;
        }
      }
      if (tempFd === null || tempPath === null) throw new PinnedRootError("write_failed", "unable to reserve an atomic temp file");
      const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
      let offset = 0;
      while (offset < bytes.length) {
        const written = writeSync(tempFd, bytes, offset, bytes.length - offset);
        if (written <= 0) throw new PinnedRootError("write_failed", "short anchored atomic write");
        offset += written;
      }
      fchmodSync(tempFd, 0o600);
      fsyncSync(tempFd);
      this.assertStable();
      const parentAfter = fstatSync(parent.fd);
      if (!sameIdentity(parentAfter, parent.identity)) throw new PinnedRootError("changed", "anchored parent changed during commit");
      const target = join(parentPath, finalName);
      let existing: Stats | null = null;
      try { existing = lstatSync(target); } catch (error) { if (errnoCode(error) !== "ENOENT") throw error; }
      if (existing && (existing.isSymbolicLink() || existing.isDirectory() || !existing.isFile())) throw new PinnedRootError("path_unauthorized", "anchored target is not a regular file");
      const published = fstatSync(tempFd);
      const planned: PinnedRootWriteDescriptor = {
        path: this.anchorPath(relativeFile),
        relative_path: relativeFile,
        dev: published.dev,
        ino: published.ino,
        size: contentByteLength(content),
        sha256: contentSha256(content),
      };
      this.hooks.beforeRename?.(relativeTarget);
      this.assertCanonicalDirectory(segments.join("/"));
      this.assertParentPathIdentity(parent.fd, segments.join("/"));
      this.assertStable();
      assertCurrentExecutionLiveness();
      const receipt = this.makeWriteReceipt(relativeFile, planned, preimage);
      this.hooks.beforePublish?.(receipt);
      options.beforePublish?.(receipt);
      try {
        if (existing === null) {
          linkSync(tempPath, target);
          committed = true;
          descriptor = planned;
          unlinkSync(tempPath);
        } else {
          throw new PinnedRootError("unsupported", "anchored replacement requires a kernel compare-and-swap transaction");
        }
      } catch (error) {
        if (error instanceof PinnedRootError) throw error;
        if (errnoCode(error) === "EEXIST") throw new PinnedRootError("changed", "anchored create target changed before no-replace publication");
        throw error;
      }
      tempPath = null;
      this.hooks.afterPublish?.(relativeTarget);
      try {
        fsyncSync(parent.fd);
      } catch (error) {
        const code = errnoCode(error);
        if (code !== "EINVAL" && code !== "ENOTSUP") throw error;
      }
      this.hooks.afterPublishLiveness?.(relativeTarget);
      assertCurrentExecutionLiveness();
    } catch (error) {
      if (committed && descriptor !== null) {
        let rolledBack = false;
        try {
          rolledBack = withoutCurrentExecutionLiveness(() => this.rollbackPublishedDescriptor(relativeFile, descriptor!, preimage));
        } catch {
          rolledBack = false;
        }
        if (!rolledBack) {
          throw new PinnedRootError("changed", `anchored atomic publication failed and its exact rollback could not be proven: ${String(error)}`);
        }
        committed = false;
      }
      if (error instanceof ExecutionLivenessViolation) throw error;
      if (error instanceof PinnedRootError) throw error;
      const code = errnoCode(error);
      if (code === "ENOENT") throw new PinnedRootError("not_found", `anchored parent does not exist for '${relativeTarget}'`);
      throw new PinnedRootError("write_failed", `anchored atomic write failed: ${String(error)}`);
    } finally {
      try { this.hooks.beforeCleanup?.(relativeTarget); } catch { /* test seams cannot replace the primary result */ }
      closeQuietly(tempFd);
      if (!committed && tempPath !== null) {
        let safeCleanup = true;
        try { this.assertCanonicalDirectory(segments.join("/")); } catch { safeCleanup = false; }
        if (safeCleanup) {
          try { unlinkSync(tempPath); } catch { }
        }
      }
      parent.close();
    }
    if (descriptor === null) throw new PinnedRootError("write_failed", "anchored atomic write completed without an operation descriptor");
    const published = this.finishPublishedDescriptor(relativeFile, descriptor, preimage);
    descriptorReceipts.set(published, this.makeWriteReceipt(relativeFile, published, preimage));
    return published;
  }

  private startDarwinHelper(executable: string, deadline: number): DarwinHelperSession {
    const directory = mkdtempSync(join(tmpdir(), ".omp-darwin-helper-"));
    let requestFd: number | null = null;
    let responseFd: number | null = null;
    let child: ChildProcess | null = null;
    let startupError: Error | null = null;
    let sessionRef: DarwinHelperSession | null = null;
    let resolveExit!: () => void;
    let exited = false;
    const exitPromise = new Promise<void>((resolve) => { resolveExit = resolve; });
    try {
      chmodSync(directory, 0o700);
      const directoryInfo = lstatSync(directory);
      if (!directoryInfo.isDirectory() || (directoryInfo.mode & 0o777) !== 0o700) throw new PinnedRootError("unsupported", "descriptor helper IPC directory is unsafe");
      const requestPath = join(directory, "request.fifo");
      const responsePath = join(directory, "response.fifo");
      const readyNonce = randomUUID();
      const helperAuthKey = randomBytes(32);
      const helperSessionId = randomUUID();
      child = spawn(executable, ["-I", "-c", DARWIN_HELPER_SOURCE], {
        stdio: ["ignore", "ignore", "ignore", this.rootFd, "pipe"],
        env: {
          OMP_DARWIN_HELPER_REQUEST_FIFO: requestPath,
          OMP_DARWIN_HELPER_RESPONSE_FIFO: responsePath,
          OMP_DARWIN_HELPER_READY_NONCE: readyNonce,
          LC_ALL: "C",
          LANG: "C",
          TZ: "UTC",
        },
      });
      const authPipe = child.stdio[4];
      const authWriter = authPipe as unknown as { end: (chunk: Buffer) => void };
      if (!authPipe || typeof authWriter.end !== "function") throw new PinnedRootError("unsupported", "descriptor helper authentication pipe is unavailable");
      const credentials = [helperAuthKey.toString("hex"), DARWIN_JOURNAL_AUTH_KEY.toString("hex"), helperSessionId].join("\n") + "\n";
      authPipe.once("error", (error: Error) => { startupError ??= error; });
      authWriter.end(Buffer.from(credentials, "ascii"));
      // Register both handlers before any startup polling. A failed spawn is
      // always observed and converted to a poisoned, fail-closed session.
      child.once("error", (error) => {
        const normalized = error instanceof Error ? error : new Error(String(error));
        startupError ??= normalized;
        if (sessionRef) {
          sessionRef.runtimeError = normalized;
          if (!sessionRef.closing) this.poisonDarwinHelper();
        }
      });
      child.once("exit", (code, signal) => {
        exited = true;
        resolveExit();
        if (sessionRef) {
          sessionRef.exited = true;
          removeLiveDarwinHelperSession(sessionRef);
          if (!sessionRef.closing) {
            sessionRef.runtimeError = new Error(`descriptor helper exited (${code ?? "null"}, ${signal ?? "null"})`);
            this.poisonDarwinHelper();
          }
        }
      });
      const startupDeadline = Math.min(deadline, Date.now() + DARWIN_HELPER_START_TIMEOUT_MS);
      const helperUid = process.getuid?.();
      if (helperUid === undefined) throw new PinnedRootError("unsupported", "descriptor helper FIFO ownership cannot be verified");
      let requestInfo: Stats | null = null;
      let responseInfo: Stats | null = null;
      while (Date.now() <= startupDeadline) {
        if (startupError) throw new PinnedRootError("unsupported", `descriptor helper spawn failed: ${String(startupError)}`);
        if (child.exitCode !== null || exited) throw new PinnedRootError("unsupported", "descriptor helper exited before opening its IPC channels");
        try {
          requestInfo = lstatSync(requestPath);
          responseInfo = lstatSync(responsePath);
          if (requestInfo.isFIFO() && responseInfo.isFIFO()
            && (requestInfo.mode & 0o777) === 0o600 && (responseInfo.mode & 0o777) === 0o600
            && requestInfo.uid === helperUid && responseInfo.uid === helperUid) break;
          throw new PinnedRootError("unsupported", "descriptor helper IPC channel has unsafe identity or mode");
        } catch (error) {
          if (error instanceof PinnedRootError) throw error;
          if (errnoCode(error) !== "ENOENT") throw error;
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, DARWIN_HELPER_POLL_MS);
      }
      if (startupError) throw new PinnedRootError("unsupported", `descriptor helper spawn failed: ${String(startupError)}`);
      if (!requestInfo || !responseInfo) throw new PinnedRootError("unsupported", "descriptor helper IPC channels did not appear");
      const requestAfter = lstatSync(requestPath);
      const responseAfter = lstatSync(responsePath);
      if (requestAfter.dev !== requestInfo.dev || requestAfter.ino !== requestInfo.ino || !requestAfter.isFIFO()
        || responseAfter.dev !== responseInfo.dev || responseAfter.ino !== responseInfo.ino || !responseAfter.isFIFO()) {
        throw new PinnedRootError("changed", "descriptor helper IPC channel changed before open");
      }
      const nonblock = constants.O_NONBLOCK;
      const nofollow = constants.O_NOFOLLOW;
      if (!Number.isInteger(nonblock) || !Number.isInteger(nofollow)) throw new PinnedRootError("unsupported", "safe nonblocking FIFO operations are unavailable");
      while (requestFd === null && Date.now() <= startupDeadline) {
        this.hooks.beforeDarwinHelperOpen?.("request", requestPath);
        try { requestFd = openSync(requestPath, constants.O_WRONLY | nonblock | nofollow); }
        catch (error) { if (errnoCode(error) !== "ENXIO" && errnoCode(error) !== "ENOENT") throw error; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, DARWIN_HELPER_POLL_MS); }
      }
      if (requestFd === null) throw new PinnedRootError("unsupported", "descriptor helper request channel did not open");
      assertDarwinFifoDescriptor(requestFd, requestInfo, "request");
      this.hooks.beforeDarwinHelperOpen?.("response", responsePath);
      responseFd = openSync(responsePath, constants.O_RDONLY | nonblock | nofollow);
      assertDarwinFifoDescriptor(responseFd, responseInfo, "response");
      const requestOpened = lstatSync(requestPath);
      const responseOpened = lstatSync(responsePath);
      if (requestOpened.dev !== requestInfo.dev || requestOpened.ino !== requestInfo.ino || responseOpened.dev !== responseInfo.dev || responseOpened.ino !== responseInfo.ino) {
        throw new PinnedRootError("changed", "descriptor helper IPC channel changed after open");
      }
      const session: DarwinHelperSession = {
        directory, requestPath, responsePath, requestFd, responseFd, child, exitPromise, resolveExit,
        exited, closing: false, runtimeError: null, authKey: helperAuthKey, sessionId: helperSessionId, rootPathDigest: this.rootPathDigest, nonce: 0,
      };
      sessionRef = session;
      const readyOutput = this.readDarwinFrame(session, startupDeadline, "__ready", true);
      let readyResult: unknown;
      try { readyResult = JSON.parse(readyOutput); } catch (error) { throw new PinnedRootError("unsupported", `descriptor helper ready frame is invalid: ${String(error)}`); }
      if (!readyResult || typeof readyResult !== "object") throw new PinnedRootError("unsupported", "descriptor helper ready frame is invalid");
      const readyRecord = readyResult as Record<string, unknown>;
      const readyMac = readyRecord._mac;
      delete readyRecord._mac;
      if (readyRecord._session_id !== helperSessionId || !verifyDarwinHelperMac(readyRecord, readyMac, helperAuthKey)) throw new PinnedRootError("unsupported", "descriptor helper ready frame authentication failed");
      if (readyRecord.ok !== true || readyRecord.ready !== true || readyRecord._ready_nonce !== readyNonce) {
        throw new PinnedRootError("unsupported", "descriptor helper ready frame correlation failed");
      }
      activeDarwinHelperSessions.add(session);
      registerLiveDarwinHelperSession(session);
      // Verified FIFO identity and ready frame establish the response writer;
      // the child is then independent of Node event-loop liveness.
      child.unref();
      return session;
    } catch (error) {
      if (sessionRef) {
        activeDarwinHelperSessions.delete(sessionRef);
        removeLiveDarwinHelperSession(sessionRef);
      }
      closeQuietly(requestFd);
      closeQuietly(responseFd);
      if (child && child.pid !== undefined) {
        try { child.kill("SIGTERM"); } catch { /* preserve primary failure */ }
        pollDarwinChildExit(child, DARWIN_HELPER_CLOSE_TIMEOUT_MS);
      }
      try { rmSync(directory, { recursive: true, force: true }); } catch { /* preserve primary failure */ }
      if (error instanceof PinnedRootError) throw error;
      throw new PinnedRootError("unsupported", `descriptor helper could not start: ${String(error)}`);
    }
  }

  private poisonDarwinHelper(): void {
    this.darwinHelperPoisoned = true;
    const session = this.darwinHelperSession;
    this.darwinHelperSession = null;
    if (!session) return;
    activeDarwinHelperSessions.delete(session);
    removeLiveDarwinHelperSession(session);
    session.closing = true;
    try { session.child.kill("SIGTERM"); } catch { /* preserve primary failure */ }
    closeQuietly(session.requestFd);
    closeQuietly(session.responseFd);
    try { rmSync(session.directory, { recursive: true, force: true }); } catch { /* preserve primary failure */ }
    this.darwinHelperClosePromise = this.awaitDarwinHelperExit(session);
    void this.darwinHelperClosePromise.catch(() => undefined);
  }

  private writeDarwinFrame(session: DarwinHelperSession, frame: Buffer, deadline: number, operation: string): void {
    let offset = 0;
    while (offset < frame.byteLength) {
      if (Date.now() > deadline) throw new PinnedRootError("unsupported", `descriptor helper '${operation}' timed out`);
      try {
        const written = writeSync(session.requestFd, frame, offset, frame.byteLength - offset);
        if (written <= 0) throw new PinnedRootError("unsupported", "descriptor helper request channel closed");
        offset += written;
      } catch (error) {
        if (errnoCode(error) !== "EAGAIN" && errnoCode(error) !== "EWOULDBLOCK") throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, DARWIN_HELPER_POLL_MS);
      }
    }
  }

  private readDarwinFrame(session: DarwinHelperSession, deadline: number, operation: string, tolerateInitialEof = false): string {
    const chunk = Buffer.allocUnsafe(64 * 1024);
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const textParts: string[] = [];
    let total = 0;
    while (Date.now() <= deadline) {
      try {
        const read = readSync(session.responseFd, chunk, 0, chunk.byteLength, null);
        if (read === 0) {
          if (tolerateInitialEof) {
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, DARWIN_HELPER_POLL_MS);
            continue;
          }
          throw new PinnedRootError("unsupported", "descriptor helper response channel closed");
        }
        const bytes = chunk.subarray(0, read);
        total += read;
        if (total > DARWIN_HELPER_MAX_OUTPUT) throw new PinnedRootError("limit", "descriptor helper response exceeds its bounded output limit");
        const newline = bytes.indexOf(0x0a);
        if (newline >= 0) {
          if (newline !== read - 1) throw new PinnedRootError("unsupported", `descriptor helper '${operation}' returned trailing frame bytes`);
          textParts.push(decodeDarwinHelperUtf8(decoder, bytes.subarray(0, newline), false, operation));
          return textParts.join("");
        }
        textParts.push(decodeDarwinHelperUtf8(decoder, bytes, true, operation));
      } catch (error) {
        if (errnoCode(error) !== "EAGAIN" && errnoCode(error) !== "EWOULDBLOCK") throw error;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, DARWIN_HELPER_POLL_MS);
    }
    throw new PinnedRootError("unsupported", `descriptor helper '${operation}' timed out`);
  }

  private requestDarwinHelper<T extends Record<string, unknown>>(executable: string, operation: string, payload: Record<string, unknown>, timeoutMs: number): T {
    if (this.darwinHelperPoisoned) throw new PinnedRootError("unsupported", "descriptor helper is poisoned after a failed operation");
    const requestId = randomUUID();
    const requestPayload: Record<string, unknown> = { ...payload, op: operation, root_dev: this.dev, root_ino: this.ino, _root_path_digest: this.rootPathDigest, _request_id: requestId };
    if (this.hooks.helperSleepMs !== undefined) requestPayload.test_sleep_ms = this.hooks.helperSleepMs;
    if (this.hooks.helperProtocolTest !== undefined) requestPayload._test_response_mode = this.hooks.helperProtocolTest;
    const liveBatchIds = LIVE_DARWIN_BATCH_IDS.get(this.rootPathDigest);
    if (liveBatchIds && liveBatchIds.size > 0) requestPayload._live_batch_ids = [...liveBatchIds];
    const liveHelperSessionIds = liveDarwinHelperSessionIds(this.rootPathDigest);
    if (liveHelperSessionIds.length > 0) requestPayload._live_helper_session_ids = liveHelperSessionIds;
    const unsignedRequest = Buffer.from(JSON.stringify(requestPayload) + "\n", "utf8");
    if (unsignedRequest.byteLength > DARWIN_HELPER_MAX_INPUT) throw new PinnedRootError("limit", `descriptor helper '' request exceeds the bounded input limit`);
    const transferTimeoutMs = darwinHelperTransferTimeout(operation, timeoutMs, unsignedRequest.byteLength);
    const transferMarginMs = transferTimeoutMs > timeoutMs ? DARWIN_HELPER_TRANSFER_COMPLETION_MARGIN_MS : 0;
    const operationDeadline = Date.now() + transferTimeoutMs + transferMarginMs + DARWIN_HELPER_START_TIMEOUT_MS;
    if (!this.darwinHelperSession) {
      try {
        this.darwinHelperSession = this.startDarwinHelper(executable, operationDeadline);
      } catch (error) {
        this.darwinHelperPoisoned = true;
        throw error;
      }
    }
    const session = this.darwinHelperSession;
    if (session.runtimeError || session.exited || Date.now() > operationDeadline) {
      this.poisonDarwinHelper();
      throw new PinnedRootError("unsupported", "descriptor helper failed before request dispatch");
    }
    requestPayload._host_instance_id = DARWIN_HOST_INSTANCE_ID;
    requestPayload._session_id = session.sessionId;
    const authorizedHelperSessionIds = new Set(liveDarwinHelperSessionIds(this.rootPathDigest));
    authorizedHelperSessionIds.add(session.sessionId);
    requestPayload._live_helper_session_ids = [...authorizedHelperSessionIds];
    requestPayload._nonce = ++session.nonce;
    requestPayload._mac = darwinHelperMac(requestPayload, session.authKey);
    const request = Buffer.from(JSON.stringify(requestPayload) + "\n", "utf8");
    if (request.byteLength > DARWIN_HELPER_MAX_INPUT) throw new PinnedRootError("limit", `descriptor helper '' request exceeds the bounded input limit`);
    const requestDeadline = Math.min(operationDeadline, Date.now() + transferTimeoutMs + transferMarginMs);
    let responseReceived = false;
    try {
      this.writeDarwinFrame(session, request, requestDeadline, operation);
      const output = this.readDarwinFrame(session, requestDeadline, operation);
      let result: unknown;
      try { result = JSON.parse(output); } catch (error) { throw new PinnedRootError("unsupported", `descriptor helper returned invalid output: ${String(error)}`); }
      if (!result || typeof result !== "object") throw new PinnedRootError("unsupported", "descriptor helper returned an invalid result");
      const record = result as Record<string, unknown>;
      const responseMac = record._mac;
      delete record._mac;
      if (!verifyDarwinHelperMac(record, responseMac, session.authKey)) throw new PinnedRootError("unsupported", "descriptor helper response authentication failed");
      if (record._session_id !== session.sessionId || record._nonce !== requestPayload._nonce) throw new PinnedRootError("unsupported", "descriptor helper response nonce failed");
      if (record._request_id !== requestId) throw new PinnedRootError("unsupported", "descriptor helper response correlation failed");
      responseReceived = true;
      delete record._request_id;
      delete record._nonce;
      const recoveredIds = record._recovered_batch_ids;
      if (recoveredIds !== undefined) {
        if (!Array.isArray(recoveredIds) || recoveredIds.some((id) => typeof id !== "string")) throw new PinnedRootError("unsupported", "descriptor helper returned invalid recovered batch identities");
        for (const id of recoveredIds) removeLiveDarwinBatch(this.rootPathDigest, id);
        delete record._recovered_batch_ids;
      }
      if (record.ok !== true) {
        const code = ["unsupported", "invalid", "limit", "changed", "recovery_required", "path_unauthorized", "not_found", "not_directory", "not_regular", "write_failed", "exists"].includes(String(record.code))
          ? String(record.code) as PinnedRootErrorCode
          : "write_failed";
        throw new PinnedRootError(code, typeof record.message === "string" ? record.message : "descriptor helper operation failed");
      }
      return record as T;
    } catch (error) {
      if (!responseReceived) this.poisonDarwinHelper();
      if (error instanceof PinnedRootError) throw error;
      throw new PinnedRootError("unsupported", `descriptor helper '${operation}' failed: ${String(error)}`);
    }
  }

  private awaitDarwinHelperExit(session: DarwinHelperSession): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        try { rmSync(session.directory, { recursive: true, force: true }); } catch { /* preserve exit result */ }
        if (error) reject(error); else resolve();
      };
      if (session.exited || session.child.exitCode !== null) {
        session.exited = true;
        finish();
        return;
      }
      const timer = setTimeout(() => {
        if (session.exited || session.child.exitCode !== null) { finish(); return; }
        try { session.child.kill("SIGTERM"); } catch { /* preserve bounded teardown */ }
        const finalTimer = setTimeout(() => {
          if (session.exited || session.child.exitCode !== null) finish();
          else finish(new PinnedRootError("unsupported", "descriptor helper did not exit before bounded close"));
        }, DARWIN_HELPER_CLOSE_TIMEOUT_MS);
        finalTimer.unref();
      }, DARWIN_HELPER_CLOSE_TIMEOUT_MS);
      timer.unref();
      session.exitPromise.then(() => finish(), () => finish(new PinnedRootError("unsupported", "descriptor helper exit could not be observed")));
    });
  }

  private closeDarwinHelper(): void {
    const session = this.darwinHelperSession;
    this.darwinHelperSession = null;
    if (!session) return;
    activeDarwinHelperSessions.delete(session);
    removeLiveDarwinHelperSession(session);
    session.closing = true;
    const requestId = randomUUID();
    const closePayload: Record<string, unknown> = { op: "__close", _request_id: requestId, _session_id: session.sessionId, _nonce: ++session.nonce };
    closePayload._mac = darwinHelperMac(closePayload, session.authKey);
    const request = Buffer.from(JSON.stringify(closePayload) + "\n", "utf8");
    try {
      const deadline = Date.now() + DARWIN_HELPER_CLOSE_TIMEOUT_MS;
      this.writeDarwinFrame(session, request, deadline, "__close");
      const output = this.readDarwinFrame(session, deadline, "__close");
      const result = JSON.parse(output) as Record<string, unknown>;
      const responseMac = result._mac;
      delete result._mac;
      if (!verifyDarwinHelperMac(result, responseMac, session.authKey) || result._session_id !== session.sessionId || result._nonce !== closePayload._nonce || result.ok !== true || result.closed !== true || result._request_id !== requestId) throw new Error("close acknowledgement mismatch");
    } catch {
      // Closing either FIFO is an EOF signal; SIGTERM is the bounded fallback
      // for a helper blocked in a malformed/runtime operation.
    } finally {
      try { session.child.kill("SIGTERM"); } catch { /* preserve teardown */ }
      closeQuietly(session.requestFd);
      closeQuietly(session.responseFd);
    }
    this.darwinHelperClosePromise = this.awaitDarwinHelperExit(session);
  }

  private makeWriteReceipt(
    relativeFile: string,
    descriptor: PinnedRootWriteDescriptor,
    preimage: PinnedRootWritePreimage,
  ): PinnedRootWriteReceipt {
    return {
      ...descriptor,
      descriptor,
      preimage,
      rollback: () => this.rollbackPublishedDescriptor(relativeFile, descriptor, preimage),
    };
  }

  private resetDarwinHelperForCompensation(): void {
    // A malformed/EOF response poisons normal request reuse. Compensation is
    // a separate exact-CAS transaction and may safely start a fresh helper;
    // stale lease recovery protects any operation whose response was lost.
    this.darwinHelperPoisoned = false;
  }

  private publishedDescriptorMatches(relativeFile: string, descriptor: PinnedRootWriteDescriptor): boolean {
    try {
      const observed = this.readFile(relativeFile, { maxBytes: MAX_PINNED_ROOT_READ_BYTES });
      return observed.dev === descriptor.dev
        && observed.ino === descriptor.ino
        && observed.size === descriptor.size
        && Buffer.from(observed.bytes).byteLength === descriptor.size
        && createHash("sha256").update(Buffer.from(observed.bytes)).digest("hex") === descriptor.sha256;
    } catch {
      return false;
    }
  }

  private writeDarwinPrepared(
    operation: "exclusive" | "atomic",
    relativeFile: string,
    content: PinnedRootWriteContent,
    options?: PinnedRootWriteOptions,
    expected?: PinnedRootFileExpectation,
  ): { descriptor: PinnedRootWriteDescriptor; preimage: PinnedRootWritePreimage } {
    const prepOperation = operation === "exclusive" ? "prepare_write_exclusive" : "prepare_write_atomic";
    const prep = this.runDescriptorHelper<PinnedWriteDescriptorResponse>(prepOperation, {
      path: relativeFile,
      ...contentPayload(content, operation === "atomic"),
      ...(this.hooks.preparedLeaseReplacement ? { test_prepared_lease_replacement: true } : {}),
      ...(expected ? { expected } : {}),
      ...(this.hooks.conditionalFailurePhase ? { failure_phase: this.hooks.conditionalFailurePhase } : {}),
    });
    if (typeof prep.token !== "string" || prep.token.length === 0) {
      throw new PinnedRootError("write_failed", "prepared write returned no lease token");
    }
    const preimage = preimageFromResponse(prep);
    const planned = descriptorFromResponse(relativeFile, this.anchorPath(relativeFile), content, prep);
    const receipt = this.makeWriteReceipt(relativeFile, planned, preimage);
    try {
      this.hooks.beforePublish?.(receipt);
      options?.beforePublish?.(receipt);
      const result = this.runDescriptorHelper<PinnedWriteDescriptorResponse>("commit_prepared_write", {
        token: prep.token,
        root_dev: this.dev,
        root_ino: this.ino,
        ...(this.hooks.conditionalFailurePhase ? { failure_phase: this.hooks.conditionalFailurePhase } : {}), ...(this.hooks.preparedPostVerifyMutation ? { test_prepared_post_verify_mutation: true } : {}), ...(this.hooks.preparedLeaseReplacement ? { test_prepared_lease_replacement: true } : {}),
      });
      const descriptor = descriptorFromResponse(relativeFile, this.anchorPath(relativeFile), content, result);
      if (result.ack_required !== true) throw new PinnedRootError("write_failed", "prepared write returned no acknowledgement requirement");
      try {
        const acknowledged = this.runDescriptorHelper<{ acknowledged?: unknown; already?: unknown }>("ack_prepared_write", { token: prep.token, root_dev: this.dev, root_ino: this.ino, ...(this.hooks.conditionalFailurePhase ? { failure_phase: this.hooks.conditionalFailurePhase } : {}), ...(this.hooks.preparedPostVerifyMutation ? { test_prepared_post_verify_mutation: true } : {}), ...(this.hooks.preparedLeaseReplacement ? { test_prepared_lease_replacement: true } : {}) });
        if (acknowledged.acknowledged !== true && acknowledged.already !== true) throw new PinnedRootError("write_failed", "prepared write acknowledgement was not accepted");
        if (!this.publishedDescriptorMatches(relativeFile, descriptor) || !this.isStable()) throw new PinnedRootError("changed", "prepared write post-ACK descriptor changed before receipt");
      } catch (ackError) {
        // A verified target mutation is an authenticated recovery condition;
        // do not issue a competing CAS while the prepared lease remains live.
        if (ackError instanceof PinnedRootError && ackError.code === "recovery_required") throw ackError;
        // The helper may have committed and popped the lease immediately
        // before its ACK frame was lost. The descriptor is an anchored proof
        // of ownership; accept success when the exact postimage is present.
        this.resetDarwinHelperForCompensation();
        if (this.publishedDescriptorMatches(relativeFile, descriptor)) return { descriptor, preimage };
        if (!this.rollbackPublishedDescriptor(relativeFile, descriptor, preimage)) {
          throw new PinnedRootError("changed", `prepared write acknowledgement failed and rollback could not be proven: ${String(ackError)}`);
        }
        throw ackError;
      }
      return { descriptor, preimage };
    } catch (error) {
      try { this.runDescriptorHelper("abort_prepared_write", { token: prep.token, root_dev: this.dev, root_ino: this.ino }); } catch { /* dead helper leaves lease/stage for stale recovery */ }
      throw error;
    }
  }

  private writeDarwinPreparedBatch(
    entries: readonly { path: string; content: PinnedRootWriteContent }[],
    options: PinnedRootBatchWriteOptions,
    durableBatch = false,
  ): readonly { descriptor: PinnedRootWriteDescriptor; preimage: PinnedRootWritePreimage }[] {
    type PreparedBatchEntry = {
      path: string;
      content: PinnedRootWriteContent;
      token: string;
      descriptor: PinnedRootWriteDescriptor;
      preimage: PinnedRootWritePreimage;
      committed: boolean;
      commit_confirmed: boolean;
    };
    const prepared: PreparedBatchEntry[] = [];
    const batchId = durableBatch ? randomUUID() : undefined;
    if (batchId) liveDarwinBatchSet(this.rootPathDigest).add(batchId);
    const batchPreimages = durableBatch ? entries.map((entry) => this.captureWritePreimage(entry.path)) : undefined;
    const batchManifest = durableBatch ? entries.map((entry, index) => {
      const bytes = Buffer.from(entry.content);
      const preimage = batchPreimages?.[index];
      return { path: safeRelativeSegments(entry.path).join("/"), index, size: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex"), expected: preimage?.kind === "file" ? { kind: "file", ...preimage.expectation } : { kind: "absent" } };
    }) : undefined;
    try {
      for (const [index, entry] of entries.entries()) {
        this.hooks.beforeTempOpen?.(entry.path);
        this.assertStable();
        this.hooks.beforeRename?.(entry.path);
        if (batchManifest) {
          const currentPreimage = this.captureWritePreimage(entry.path);
          batchManifest[index]!.expected = currentPreimage.kind === "file" ? { kind: "file", ...currentPreimage.expectation } : { kind: "absent" };
        }
        const response = this.runDescriptorHelper<PinnedWriteDescriptorResponse>("prepare_write_atomic", {
          path: entry.path,
          ...contentPayload(entry.content, true),
          ...(this.hooks.conditionalFailurePhase ? { failure_phase: this.hooks.conditionalFailurePhase } : {}),
          ...(Number.isInteger(this.hooks.preparedBatchJournalIndex) ? { failure_batch_index: this.hooks.preparedBatchJournalIndex } : {}),
          ...(batchId ? { batch_id: batchId, batch_index: index, batch_size: entries.length, batch_manifest: batchManifest } : {}),
        });
        if (typeof response.token !== "string" || response.token.length === 0) {
          throw new PinnedRootError("write_failed", "prepared batch write returned no lease token");
        }
        const preimage = preimageFromResponse(response);
        const descriptor = descriptorFromResponse(entry.path, this.anchorPath(entry.path), entry.content, response);
        prepared.push({ path: entry.path, content: entry.content, token: response.token, descriptor, preimage, committed: false, commit_confirmed: false });
      }
      const receipts = prepared.map((entry) => this.makeWriteReceipt(entry.path, entry.descriptor, entry.preimage));
      options.beforePublish?.(receipts);
      for (const entry of prepared) {
        // Once commit is requested this operation owns the target even if the
        // response transport fails; the planned descriptor is the only safe
        // postimage identity available for exact compensation.
        entry.committed = true;
        const response = this.runDescriptorHelper<PinnedWriteDescriptorResponse>("commit_prepared_write", {
          token: entry.token,
          root_dev: this.dev,
          root_ino: this.ino,
          ...(this.hooks.conditionalFailurePhase ? { failure_phase: this.hooks.conditionalFailurePhase } : {}), ...(this.hooks.preparedPostVerifyMutation ? { test_prepared_post_verify_mutation: true } : {}), ...(this.hooks.preparedLeaseReplacement ? { test_prepared_lease_replacement: true } : {}),
        });
        const descriptor = descriptorFromResponse(entry.path, this.anchorPath(entry.path), entry.content, response);
        if (descriptor.dev !== entry.descriptor.dev || descriptor.ino !== entry.descriptor.ino) {
          throw new PinnedRootError("changed", "prepared batch postimage descriptor changed before acknowledgement");
        }
        if (response.ack_required !== true) throw new PinnedRootError("write_failed", "prepared batch write returned no acknowledgement requirement");
        entry.commit_confirmed = true;
        if (this.hooks.batchFailureIndex === prepared.indexOf(entry)) throw new PinnedRootError("write_failed", "injected anchored atomic batch interruption");
      }
      for (const entry of prepared) {
        try {
          const acknowledged = this.runDescriptorHelper<{ acknowledged?: unknown; already?: unknown }>("ack_prepared_write", { token: entry.token, root_dev: this.dev, root_ino: this.ino, ...(this.hooks.conditionalFailurePhase ? { failure_phase: this.hooks.conditionalFailurePhase } : {}), ...(this.hooks.preparedPostVerifyMutation ? { test_prepared_post_verify_mutation: true } : {}), ...(this.hooks.preparedLeaseReplacement ? { test_prepared_lease_replacement: true } : {}) });
          if (acknowledged.acknowledged !== true && acknowledged.already !== true) throw new PinnedRootError("write_failed", "prepared batch acknowledgement was not accepted");
        } catch (ackError) {
          // A response can be lost after ACK has atomically released the
          // lease. Verify all committed postimages before accepting success;
          // otherwise the transaction remains compensable by exact CAS.
          this.resetDarwinHelperForCompensation();
          let cleanupConfirmed = false;
          if (batchId) {
            try {
              const recovery = this.runDescriptorHelper<{ recovered?: unknown; absent_clean?: unknown }>("recover_prepared_batch", { batch_id: batchId, entries: prepared.map((candidate) => ({ path: safeRelativeSegments(candidate.path).join("/"), dev: candidate.descriptor.dev, ino: candidate.descriptor.ino, size: candidate.descriptor.size, sha256: candidate.descriptor.sha256 })) });
              cleanupConfirmed = recovery.recovered === true || recovery.absent_clean === true;
            } catch { /* retain the live ID until durable cleanup is proven */ }
          }
          if (cleanupConfirmed && prepared.every((candidate) => this.publishedDescriptorMatches(candidate.path, candidate.descriptor))) {
            if (batchId) removeLiveDarwinBatch(this.rootPathDigest, batchId);
            return prepared.map((candidate) => ({ descriptor: candidate.descriptor, preimage: candidate.preimage }));
          }
          throw ackError;
        }
      }
      if (!this.isStable() || prepared.some((entry) => !this.publishedDescriptorMatches(entry.path, entry.descriptor))) {
        throw new PinnedRootError("changed", "prepared batch post-ACK descriptor changed before receipt");
      }
      if (batchId) removeLiveDarwinBatch(this.rootPathDigest, batchId);
      return prepared.map((entry) => ({ descriptor: entry.descriptor, preimage: entry.preimage }));
    } catch (error) {
      // A lost helper response leaves the grouped journal as the only durable
      // authority. Do not run descriptor compensation here: it would issue a
      // fresh helper request, observe the stale group, and prematurely finish
      // or roll back a transaction whose progress is still unresolved. The
      // next open/operation performs grouped classification and recovery.
      if (durableBatch && prepared.length === 0) {
        if (batchId) {
          this.resetDarwinHelperForCompensation();
          try {
            const recovery = this.runDescriptorHelper<{ recovered?: unknown; absent_clean?: unknown }>("recover_prepared_batch", { batch_id: batchId, entries: batchManifest ?? [] });
            if (recovery.recovered === true || recovery.absent_clean === true) removeLiveDarwinBatch(this.rootPathDigest, batchId);
            else throw new PinnedRootError("recovery_required", "durable prepared batch cleanup was not proven");
          } catch (recoveryError) {
            let residueAbsent = false;
            if (batchManifest) {
              try { residueAbsent = this.durableBatchResidueAbsent(batchId, batchManifest); } catch { residueAbsent = false; }
            }
            if (residueAbsent) {
              removeLiveDarwinBatch(this.rootPathDigest, batchId);
              throw error;
            }
            if (recoveryError instanceof PinnedRootError && recoveryError.code === "recovery_required") throw recoveryError;
            throw new PinnedRootError("recovery_required", "durable prepared batch cleanup could not be disproven after helper failure: " + String(error));
          }
        }
        throw error;
      }
      if (durableBatch && prepared.length > 0 && error instanceof PinnedRootError && error.code === "unsupported") throw error;
      let rollbackComplete = true;
      let abortComplete = true;
      this.resetDarwinHelperForCompensation();
      for (const entry of prepared.slice().reverse()) {
        let aborted = false;
        try {
          const abortResult = this.runDescriptorHelper<{ aborted?: unknown }>("abort_prepared_write", { token: entry.token, root_dev: this.dev, root_ino: this.ino, ...(entry.commit_confirmed ? { release_published: true } : {}) });
          aborted = abortResult.aborted === true;
        } catch { abortComplete = false; /* stale lease recovery owns cleanup */ }
        if (entry.committed && !this.rollbackPublishedDescriptor(entry.path, entry.descriptor, entry.preimage)) rollbackComplete = false;
      }
      if (durableBatch && abortComplete && rollbackComplete && batchId) removeLiveDarwinBatch(this.rootPathDigest, batchId);
      if (!rollbackComplete) {
        throw new PinnedRootError("changed", `prepared Darwin batch failed and rollback could not be proven: ${String(error)}`);
      }
      throw error;
    } finally {
      for (const entry of entries) {
        try { this.hooks.beforeCleanup?.(entry.path); } catch { /* preserve primary result */ }
      }
    }
  }

  private runDescriptorHelper<T extends Record<string, unknown>>(operation: string, payload: Record<string, unknown> = {}): T {
    this.assertOpen();
    assertCurrentExecutionLiveness();
    if (this.hooks.disableDarwinHelper) throw new PinnedRootError("unsupported", "descriptor helper is disabled");
    let executable: string | null = this.hooks.helperExecutable ?? null;
    for (const candidate of DARWIN_PYTHON_CANDIDATES) {
      if (executable !== null) break;
      try { accessSync(candidate, constants.X_OK); executable = candidate; break; } catch { /* try next interpreter */ }
    }
    if (executable === null) throw new PinnedRootError("unsupported", "descriptor helper is unavailable");
    if (typeof payload.text === "string" && !isWellFormedUtf16(payload.text)) {
      throw new PinnedRootError("invalid", "anchored write text payload is not valid UTF-8");
    }
    const timeoutMs = this.hooks.helperTimeoutMs ?? DARWIN_HELPER_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > DARWIN_HELPER_TIMEOUT_MS) {
      throw new PinnedRootError("invalid", `descriptor helper '${operation}' timeout is invalid`);
    }
    return this.requestDarwinHelper<T>(executable, operation, payload, timeoutMs);
  }

  /** Internal bounded batch used by state-lock transactions on Darwin. */
  private runDarwinBatch(operations: readonly Record<string, unknown>[], failureIndex?: number): void {
    if (operations.length === 0) return;
    if (operations.length > 16) throw new PinnedRootError("invalid", "anchored state batch contains too many operations");
    const result = this.runDescriptorHelper<{ results: unknown[] }>("batch", {
      operations,
      ...(Number.isInteger(failureIndex) ? { failure_index: failureIndex } : {}),
    });
    if (!Array.isArray(result.results) || result.results.length !== operations.length) {
      throw new PinnedRootError("write_failed", "descriptor helper returned an incomplete state batch");
    }
  }

  /** Ensure a bounded set of directories through one inherited-fd request. */
  ensureDirectories(relativeDirectories: readonly string[]): void {
    if (relativeDirectories.length === 0) return;
    assertCurrentExecutionLiveness();
    if (relativeDirectories.length > 16) throw new PinnedRootError("invalid", "too many directories in one anchored state batch");
    if (process.platform !== "darwin") {
      for (const path of relativeDirectories) this.ensureDirectory(path);
      return;
    }
    for (const path of relativeDirectories) {
      safeRelativeSegments(path, true);
      this.hooks.beforeDirectoryCreate?.(path);
    }
    this.runDarwinBatch(relativeDirectories.map((path) => ({ op: "ensure_directory", path })));
  }

  /** Write a bounded ordered set of atomic files through one inherited-fd request. */
  writeAtomicFiles(entries: readonly { path: string; content: PinnedRootWriteContent }[]): void {
    this.writeAtomicFilesWithDescriptors(entries);
  }

  /**
   * Atomic batch write returning ready exact rollback receipts. Preimages are
   * captured before publication and descriptor conversion is completed inside
   * this method; any conversion failure rolls back every positively-owned
   * publication before it escapes to the caller.
   */
  writeAtomicFilesWithReceipts(entries: readonly { path: string; content: PinnedRootWriteContent }[], options: PinnedRootBatchWriteOptions = {}): readonly PinnedRootWriteReceipt[] {
    if (entries.length === 0) return [];
    let descriptors: readonly PinnedRootWriteDescriptor[] | undefined;
    try {
      // The descriptor writer captures the preimage at the same transaction
      // boundary as publication and records it against each returned inode.
      // Never capture a second, potentially stale, preimage here.
      // Receipt-producing batches must retain the helper's durable prepared
      // leases until the client has converted and acknowledged every result;
      // an ordinary one-phase batch response cannot prove rollback ownership
      // after transport loss. An empty callback is an internal routing marker.
      const preparedOptions = options.beforePublish ? options : { ...options, beforePublish: () => {} };
      descriptors = this.writeAtomicFilesWithDescriptors(entries, preparedOptions);
      if (descriptors.length !== entries.length) throw new PinnedRootError("write_failed", "anchored atomic batch returned an incomplete descriptor set");
      return descriptors.map((descriptor, index) => {
        const relativePath = entries[index]!.path;
        const preimage = descriptorPreimages.get(descriptor);
        const receipt = descriptorReceipts.get(descriptor) ?? (preimage === undefined
          ? undefined
          : this.makeWriteReceipt(relativePath, descriptor, preimage));
        if (!receipt
          || receipt.relative_path !== relativePath
          || receipt.path !== this.anchorPath(relativePath)
          || receipt.descriptor !== descriptor) {
          throw new PinnedRootError("write_failed", "anchored atomic batch returned an unbound publication receipt");
        }
        descriptorReceipts.set(descriptor, receipt);
        return receipt;
      });
    } catch (error) {
      // Descriptor conversion/root-stability failures roll back only the
      // descriptors that this transaction actually published, using the
      // preimages recorded by the descriptor writer itself.
      if (descriptors !== undefined) {
        const preimages = descriptors.map((descriptor) => descriptorPreimages.get(descriptor));
        const owned = preimages.every((preimage): preimage is PinnedRootWritePreimage => preimage !== undefined);
        if (owned && !this.rollbackBatchDescriptors(entries, descriptors, preimages)) {
          throw new PinnedRootError("changed", `anchored batch receipt conversion failed and rollback could not be proven: ${String(error)}`);
        }
      }
      throw error;
    }
  }

  /** Atomic batch write returning one operation descriptor per published inode. */
  writeAtomicFilesWithDescriptors(entries: readonly { path: string; content: PinnedRootWriteContent }[], options: PinnedRootBatchWriteOptions = {}): readonly PinnedRootWriteDescriptor[] {
    if (entries.length === 0) return [];
    assertCurrentExecutionLiveness();
    if (entries.length > 8) throw new PinnedRootError("invalid", "too many files in one anchored state batch");
    let totalBytes = 0;
    for (const entry of entries) {
      safeRelativeSegments(entry.path);
      totalBytes += contentByteLength(entry.content);
    }
    if (totalBytes > MAX_BATCH_ROLLBACK_BYTES) throw new PinnedRootError("invalid", "anchored state batch exceeds its byte bound");
    if (process.platform === "linux") {
      // Linux existing-target replacement uses the helper's per-target
      // prepared CAS transaction, which closes the non-cooperating writer
      // window between a userspace precheck and rename. It also gives batch
      // receipt callbacks one all-or-nothing preparation boundary.
      const preparedBatch = this.writeDarwinPreparedBatch(entries, options);
      const preparedDescriptors = preparedBatch.map((entry) => entry.descriptor);
      const preparedPreimages = preparedBatch.map((entry) => entry.preimage);
      const published = this.finishPublishedDescriptors(entries, preparedDescriptors, preparedPreimages);
      this.rememberBatchPreimages(published, preparedPreimages);
      return published;
    }
    if (process.platform !== "darwin") {
      const portable = this.writeAtomicFilesPortable(entries, options);
      const descriptors = portable.map((entry) => entry.descriptor);
      const portablePreimages = portable.map((entry) => entry.preimage);
      const published = this.finishPublishedDescriptors(entries, descriptors, portablePreimages);
      try {
        this.rememberBatchPreimages(published, portablePreimages);
      } catch (error) {
        if (!this.rollbackBatchDescriptors(entries, published, portablePreimages)) {
          throw new PinnedRootError("changed", `anchored portable batch receipt publication failed and rollback could not be proven: ${String(error)}`);
        }
        throw error;
      }
      return published;
    }
    // Every normal Darwin batch uses per-entry durable prepared leases, even
    // without a beforePublish callback. The legacy one-phase helper remains
    // only behind the deterministic batchFailureIndex seam so its rollback
    // regression can continue to exercise that injected path.
    if (options.beforePublish || !Number.isInteger(this.hooks.batchFailureIndex)) {
      const preparedBatch = this.writeDarwinPreparedBatch(entries, options, !options.beforePublish);
      const preparedDescriptors = preparedBatch.map((entry) => entry.descriptor);
      const preparedPreimages = preparedBatch.map((entry) => entry.preimage);
      const published = this.finishPublishedDescriptors(entries, preparedDescriptors, preparedPreimages);
      this.rememberBatchPreimages(published, preparedPreimages);
      return published;
    }
    const operations: Record<string, unknown>[] = [];
    let descriptors: readonly PinnedRootWriteDescriptor[] | null = null;
    let helperPreimages: readonly PinnedRootWritePreimage[] | null = null;
    try {
      for (const entry of entries) {
        this.hooks.beforeTempOpen?.(entry.path);
        this.hooks.beforeRename?.(entry.path);
        operations.push({ op: "write_atomic", path: entry.path, bytes: contentToBase64(entry.content) });
      }
      const response = this.runDescriptorHelper<{ results: PinnedWriteDescriptorResponse[] }>("batch_atomic", {
        operations,
        ...(Number.isInteger(this.hooks.batchFailureIndex) ? { failure_index: this.hooks.batchFailureIndex } : {}),
      });
      if (!Array.isArray(response.results) || response.results.length !== entries.length) {
        throw new PinnedRootError("write_failed", "descriptor helper returned an incomplete atomic batch descriptor set");
      }
      helperPreimages = response.results.map((result) => preimageFromResponse(result));
      descriptors = response.results.map((result, index) => descriptorFromResponse(entries[index]!.path, this.anchorPath(entries[index]!.path), entries[index]!.content, result));
    } catch (error) {
      // If response validation fails after helper publication, use the exact
      // preimages returned by that same helper transaction. Never recapture a
      // potentially changed target while compensating the batch.
      if (descriptors !== null && helperPreimages !== null
        && !this.rollbackBatchDescriptors(entries, descriptors, helperPreimages)) {
        throw new PinnedRootError("changed", `anchored Darwin batch response validation failed and rollback could not be proven: ${String(error)}`);
      }
      throw error;
    } finally {
      for (const entry of entries) {
        try { this.hooks.beforeCleanup?.(entry.path); } catch { /* preserve the primary batch result */ }
      }
    }
    if (!descriptors || !helperPreimages) throw new PinnedRootError("write_failed", "anchored atomic batch completed without exact operation metadata");
    const published = this.finishPublishedDescriptors(entries, descriptors, helperPreimages);
    try {
      this.rememberBatchPreimages(published, helperPreimages);
    } catch (error) {
      if (!this.rollbackBatchDescriptors(entries, published, helperPreimages)) {
        throw new PinnedRootError("changed", `anchored Darwin batch receipt publication failed and rollback could not be proven: ${String(error)}`);
      }
      throw error;
    }
    return published;
  }

  private writeAtomicFilesPortable(
    entries: readonly { path: string; content: PinnedRootWriteContent }[],
    options: PinnedRootBatchWriteOptions = {},
  ): readonly { descriptor: PinnedRootWriteDescriptor; preimage: PinnedRootWritePreimage }[] {
    type BatchStage = {
      path: string;
      content: Buffer;
      parent: { fd: number; identity: Stats; close: () => void };
      finalName: string;
      target: string;
      beforeIdentity: Stats | null;
      beforeBytes: Buffer | null;
      backupPath: string | null;
      tempPath: string | null;
      tempIdentity: Stats | null;
      descriptor: PinnedRootWriteDescriptor | null;
      committed: boolean;
      backupRestored: boolean;
      quarantinePath: string | null;
    };
    const sizes = entries.map((entry) => {
      safeRelativeSegments(entry.path);
      return contentByteLength(entry.content);
    });
    let totalBytes = sizes.reduce((total, size) => total + size, 0);
    if (totalBytes > MAX_BATCH_ROLLBACK_BYTES) throw new PinnedRootError("invalid", "anchored state batch exceeds its byte bound");
    const prepared = entries.map((entry) => {
      const segments = safeRelativeSegments(entry.path);
      return {
        path: segments.join("/"),
        content: Buffer.from(entry.content),
      };
    });
    const seen = new Set<string>();
    totalBytes = 0;
    for (const entry of prepared) {
      if (seen.has(entry.path)) throw new PinnedRootError("invalid", `anchored state batch contains duplicate path '${entry.path}'`);
      seen.add(entry.path);
      totalBytes += entry.content.byteLength;
    }
    if (totalBytes > MAX_BATCH_ROLLBACK_BYTES) throw new PinnedRootError("invalid", "anchored state batch exceeds its byte bound");

    type BatchPreflight = {
      path: string;
      content: Buffer;
      beforeIdentity: Stats | null;
    };
    let snapshotBytes = 0;
    const preflight: BatchPreflight[] = [];
    for (const entry of prepared) {
      const segments = safeRelativeSegments(entry.path);
      const finalName = segments.pop()!;
      let parent: { fd: number; identity: Stats; close: () => void } | null = null;
      try {
        try {
          parent = this.openParent(segments, false);
        } catch (error) {
          if (error instanceof PinnedRootError && error.code === "not_found") {
            preflight.push({ path: entry.path, content: entry.content, beforeIdentity: null });
            continue;
          }
          throw error;
        }
        const parentPath = this.parentDirectoryPath(parent.fd, segments.join("/"));
        let beforeIdentity: Stats | null = null;
        try { beforeIdentity = lstatSync(join(parentPath, finalName)); }
        catch (error) {
          if (errnoCode(error) !== "ENOENT") throw error;
        }
        if (beforeIdentity !== null) {
          if (beforeIdentity.isSymbolicLink() || !beforeIdentity.isFile()) {
            throw new PinnedRootError("path_unauthorized", `anchored target '${entry.path}' is not a regular file`);
          }
          if (beforeIdentity.size > MAX_PINNED_ROOT_READ_BYTES) {
            throw new PinnedRootError("limit", `anchored target '${entry.path}' exceeds the per-target rollback snapshot limit`);
          }
          snapshotBytes += beforeIdentity.size;
          if (snapshotBytes > MAX_BATCH_ROLLBACK_BYTES) {
            throw new PinnedRootError("limit", "anchored atomic batch rollback snapshot exceeds its byte bound");
          }
        }
        preflight.push({ path: entry.path, content: entry.content, beforeIdentity });
      } finally {
        parent?.close();
      }
    }

    if (process.platform !== "darwin" && process.platform !== "linux" && preflight.some((entry) => entry.beforeIdentity !== null)) {
      throw new PinnedRootError("unsupported", "atomic replacement of an existing target is unsupported on this platform");
    }

    const stages: BatchStage[] = [];
    let preserveBackups = false;
    const syncParent = (parentFd: number): void => {
      try { fsyncSync(parentFd); }
      catch (error) {
        const code = errnoCode(error);
        if (code !== "EINVAL" && code !== "ENOTSUP") throw error;
      }
    };
    const assertTargetUnchanged = (stage: BatchStage, phase: string): void => {
      this.assertStable();
      const parentAfter = fstatSync(stage.parent.fd);
      if (!sameIdentity(parentAfter, stage.parent.identity)) throw new PinnedRootError("changed", `anchored batch parent changed during ${phase}`);
      let current: Stats | null = null;
      try { current = lstatSync(stage.target); }
      catch (error) { if (errnoCode(error) !== "ENOENT") throw error; }
      if ((stage.beforeIdentity === null) !== (current === null)
        || (stage.beforeIdentity !== null && current !== null && !sameIdentity(stage.beforeIdentity, current))) {
        throw new PinnedRootError("changed", `anchored target '${stage.path}' changed during ${phase}`);
      }
      if (current !== null && (current.isSymbolicLink() || !current.isFile())) {
        throw new PinnedRootError("path_unauthorized", `anchored target '${stage.path}' is not a regular file`);
      }
      if (current !== null && stage.beforeBytes !== null && stage.beforeIdentity !== null) {
        const observed = this.readFile(stage.path);
        if (observed.dev !== stage.beforeIdentity.dev || observed.ino !== stage.beforeIdentity.ino || Buffer.compare(Buffer.from(observed.bytes), stage.beforeBytes) !== 0) {
          throw new PinnedRootError("changed", `anchored target '${stage.path}' bytes changed during ${phase}`);
        }
      }
    };
    const restoreBackupBytes = (stage: BatchStage): void => {
      if (stage.backupPath === null || stage.beforeBytes === null) return;
      const flags = writeFlags();
      if (flags === null) throw new PinnedRootError("unsupported", "descriptor no-follow writes are unavailable");
      const slash = stage.backupPath.lastIndexOf("/");
      const directory = slash >= 0 ? stage.backupPath.slice(0, slash) : ".";
      const restorePath = join(directory, boundedTemporaryComponent("batch-restore", stage.path, ".restore"));
      let restoreFd: number | null = null;
      try {
        restoreFd = openSync(restorePath, flags, 0o600);
        let offset = 0;
        while (offset < stage.beforeBytes.byteLength) {
          const written = writeSync(restoreFd, stage.beforeBytes, offset, stage.beforeBytes.byteLength - offset);
          if (written <= 0) throw new PinnedRootError("write_failed", "short anchored rollback write");
          offset += written;
        }
        fchmodSync(restoreFd, 0o600);
        fsyncSync(restoreFd);
        closeQuietly(restoreFd);
        restoreFd = null;
        renameSync(restorePath, stage.backupPath);
        syncParent(stage.parent.fd);
      } finally {
        closeQuietly(restoreFd);
        try { unlinkSync(restorePath); } catch { /* already renamed or absent */ }
      }
    };
    const quarantineTarget = (stage: BatchStage): void => {
      let quarantinePath: string | null = null;
      for (let attempt = 0; attempt < 32; attempt += 1) {
        const candidate = join(dirname(stage.target), boundedTemporaryComponent("batch-quarantine", stage.path, ".quarantined"));
        try {
          renameSync(stage.target, candidate);
          quarantinePath = candidate;
          break;
        } catch (error) {
          if (errnoCode(error) !== "EEXIST") throw error;
        }
      }
      if (quarantinePath === null) throw new PinnedRootError("write_failed", "unable to reserve a portable batch quarantine path");
      stage.quarantinePath = quarantinePath;
    };
    try {
      const flags = writeFlags();
      if (flags === null) throw new PinnedRootError("unsupported", "descriptor no-follow writes are unavailable");
      for (const entry of preflight) {
        const segments = safeRelativeSegments(entry.path);
        const finalName = segments.pop()!;
        const parent = this.openParent(segments, true);
        const parentPath = this.parentDirectoryPath(parent.fd, segments.join("/"));
        const stage: BatchStage = {
          path: entry.path,
          content: entry.content,
          parent,
          finalName,
          target: join(parentPath, finalName),
          beforeIdentity: entry.beforeIdentity,
          beforeBytes: null,
          backupPath: null,
          tempPath: null,
          tempIdentity: null,
          descriptor: null,
          committed: false,
          backupRestored: false,
          quarantinePath: null,
        };
        stages.push(stage);
        try {
          this.assertStable();
          const parentAfter = fstatSync(parent.fd);
          if (!sameIdentity(parentAfter, parent.identity)) throw new PinnedRootError("changed", "anchored batch parent changed during validation");
          let current: Stats | null = null;
          try { current = lstatSync(stage.target); }
          catch (error) {
            if (errnoCode(error) !== "ENOENT") throw error;
          }
          if ((entry.beforeIdentity === null) !== (current === null)
            || (entry.beforeIdentity !== null && current !== null && !sameIdentity(entry.beforeIdentity, current))) {
            throw new PinnedRootError("changed", `anchored target '${entry.path}' changed before it was captured`);
          }
          if (current !== null && (current.isSymbolicLink() || !current.isFile())) {
            throw new PinnedRootError("path_unauthorized", `anchored target '${entry.path}' is not a regular file`);
          }
          if (entry.beforeIdentity) {
            const observed = this.readFile(entry.path);
            if (observed.dev !== entry.beforeIdentity.dev || observed.ino !== entry.beforeIdentity.ino) throw new PinnedRootError("changed", `anchored target '${entry.path}' changed while being captured`);
            stage.beforeBytes = Buffer.from(observed.bytes);
          }
          if (stage.beforeIdentity) {
            const backupName = boundedTemporaryComponent("batch-backup", entry.path, ".bak");
            stage.backupPath = join(parentPath, backupName);
            linkSync(stage.target, stage.backupPath);
            const backupIdentity = lstatSync(stage.backupPath);
            if (!sameIdentity(backupIdentity, stage.beforeIdentity)) throw new PinnedRootError("changed", `anchored target '${entry.path}' changed while being backed up`);
          }
          this.hooks.beforeTempOpen?.(entry.path);
          let tempFd: number | null = null;
          for (let attempt = 0; attempt < 32; attempt += 1) {
            const tempName = boundedTemporaryComponent("batch-write", entry.path, ".tmp");
            const candidate = join(parentPath, tempName);
            try {
              stage.tempPath = candidate;
              tempFd = openSync(candidate, flags, 0o600);
              let offset = 0;
              while (offset < entry.content.byteLength) {
                const written = writeSync(tempFd, entry.content, offset, entry.content.byteLength - offset);
                if (written <= 0) throw new PinnedRootError("write_failed", "short anchored batch write");
                offset += written;
              }
              fchmodSync(tempFd, 0o600);
              fsyncSync(tempFd);
              stage.tempIdentity = fstatSync(tempFd);
              closeQuietly(tempFd);
              tempFd = null;
              break;
            } catch (error) {
              closeQuietly(tempFd);
              tempFd = null;
              if (errnoCode(error) !== "EEXIST") throw error;
              stage.tempPath = null;
            }
          }
          if (!stage.tempPath || !stage.tempIdentity) throw new PinnedRootError("write_failed", "unable to reserve an anchored batch temporary file");
        } catch (error) {
          throw error;
        }
      }
      for (const stage of stages) {
        if (!stage.tempIdentity) throw new PinnedRootError("write_failed", "anchored batch staging returned no temporary inode");
        stage.descriptor = {
          path: this.anchorPath(stage.path),
          relative_path: stage.path,
          dev: stage.tempIdentity.dev,
          ino: stage.tempIdentity.ino,
          size: stage.content.byteLength,
          sha256: contentSha256(stage.content),
        };
      }
      if (options.beforePublish) {
        options.beforePublish(stages.map((stage) => this.makeWriteReceipt(stage.path, stage.descriptor!, stage.beforeIdentity === null
          ? { kind: "absent" as const }
          : {
            kind: "file" as const,
            bytes: Buffer.from(stage.beforeBytes!),
            expectation: {
              dev: stage.beforeIdentity.dev,
              ino: stage.beforeIdentity.ino,
              size: stage.beforeBytes!.byteLength,
              sha256: createHash("sha256").update(stage.beforeBytes!).digest("hex"),
            },
          })));
      }
      for (const [index, stage] of stages.entries()) {
        assertTargetUnchanged(stage, "batch commit");
        this.hooks.beforeRename?.(stage.path);
        assertTargetUnchanged(stage, "batch commit");
        assertCurrentExecutionLiveness();
        linkSync(stage.tempPath!, stage.target);
        stage.committed = true;
        if (!stage.descriptor
          || stage.descriptor.dev !== stage.tempIdentity!.dev
          || stage.descriptor.ino !== stage.tempIdentity!.ino
          || stage.descriptor.size !== stage.content.byteLength
          || stage.descriptor.sha256 !== contentSha256(stage.content)) {
          throw new PinnedRootError("write_failed", "anchored batch postimage descriptor changed before publication");
        }
        const published = this.readFile(stage.path, { maxBytes: MAX_PINNED_ROOT_READ_BYTES });
        if (published.dev !== stage.tempIdentity!.dev
          || published.ino !== stage.tempIdentity!.ino
          || published.size !== stage.content.byteLength
          || Buffer.compare(Buffer.from(published.bytes), stage.content) !== 0) {
          throw new PinnedRootError("changed", "anchored target changed before portable batch cleanup");
        }
        unlinkSync(stage.tempPath!);
        stage.tempPath = null;
        syncParent(stage.parent.fd);
        this.assertStable();
        assertCurrentExecutionLiveness();
        if (this.hooks.batchFailureIndex === index) throw new PinnedRootError("write_failed", "injected anchored batch failure");
      }
      assertCurrentExecutionLiveness();
    } catch (error) {
      const rollbackError = withoutCurrentExecutionLiveness(() => {
        let failure: unknown = null;
        for (const stage of stages.slice().reverse()) {
        if (!stage.committed) continue;
        try {
          this.assertStable();
          const parentAfter = fstatSync(stage.parent.fd);
          if (!sameIdentity(parentAfter, stage.parent.identity)) throw new PinnedRootError("changed", "anchored batch parent changed during rollback");
          const current = lstatSync(stage.target);
          if (!stage.tempIdentity || !sameIdentity(current, stage.tempIdentity)) throw new PinnedRootError("changed", `anchored target '${stage.path}' changed during rollback`);
          const postimage = this.readFile(stage.path, { maxBytes: MAX_PINNED_ROOT_READ_BYTES });
          if (postimage.dev !== stage.tempIdentity.dev || postimage.ino !== stage.tempIdentity.ino
            || postimage.size !== stage.content.byteLength
            || Buffer.compare(Buffer.from(postimage.bytes), stage.content) !== 0) {
            throw new PinnedRootError("changed", `anchored target '${stage.path}' bytes changed during rollback`);
          }
          if (stage.backupPath) {
            restoreBackupBytes(stage);
            // Publish the captured preimage without replacing a target that
            // appeared after the rollback check. EEXIST preserves the winner
            // and leaves the backup available for recovery.
            linkSync(stage.backupPath, stage.target);
            unlinkSync(stage.backupPath);
            stage.backupRestored = true;
          } else {
            // Unknown platforms have no descriptor-relative CAS unlink. Move
            // the exact postimage to a private quarantine instead of deleting
            // a path after a separable read-check.
            quarantineTarget(stage);
          }
          syncParent(stage.parent.fd);
          this.assertStable();
          stage.committed = false;
        } catch (restoreError) {
          failure = restoreError;
          preserveBackups = true;
          break;
        }
      }
      return failure;
      });
      if (rollbackError && !(error instanceof ExecutionLivenessViolation)) throw new PinnedRootError("changed", `anchored batch rollback failed: ${String(rollbackError)}`);
      throw error;
    } finally {
      for (const stage of stages) {
        if (stage.tempPath) {
          try { unlinkSync(stage.tempPath); } catch { /* best-effort cleanup */ }
        }
        if (stage.backupPath && !preserveBackups && !stage.backupRestored) {
          try { unlinkSync(stage.backupPath); } catch { /* best-effort cleanup */ }
        }
        try { syncParent(stage.parent.fd); } catch { /* preserve primary result */ }
        try { this.hooks.beforeCleanup?.(stage.path); } catch { /* preserve primary result */ }
        stage.parent.close();
      }
    }
    return stages
      .filter((stage): stage is typeof stage & { descriptor: PinnedRootWriteDescriptor; beforeIdentity: Stats | null } => stage.descriptor !== null)
      .map((stage) => ({
        descriptor: stage.descriptor,
        preimage: stage.beforeIdentity === null
          ? { kind: "absent" as const }
          : {
            kind: "file" as const,
            bytes: Buffer.from(stage.beforeBytes!),
            expectation: {
              dev: stage.beforeIdentity.dev,
              ino: stage.beforeIdentity.ino,
              size: stage.beforeBytes!.byteLength,
              sha256: createHash("sha256").update(stage.beforeBytes!).digest("hex"),
            },
          },
      }));
  }

  /** Check a bounded set of entries through one inherited-fd request. */
  pathEntriesExist(relativePaths: readonly string[]): boolean[] {
    if (relativePaths.length === 0) return [];
    if (relativePaths.length > 16) throw new PinnedRootError("invalid", "too many entries in one anchored state batch");
    if (process.platform !== "darwin") return relativePaths.map((path) => this.pathEntryExists(path));
    for (const path of relativePaths) safeRelativeSegments(path);
    const result = this.runDescriptorHelper<{ results: Array<{ exists?: unknown }> }>("batch", {
      operations: relativePaths.map((path) => ({ op: "exists", path })),
    });
    if (!Array.isArray(result.results) || result.results.length !== relativePaths.length || result.results.some((entry) => !entry || typeof entry.exists !== "boolean")) {
      throw new PinnedRootError("write_failed", "descriptor helper returned an incomplete existence batch");
    }
    return result.results.map((entry) => entry.exists === true);
  }

  /** Publish a complete state-lock owner and hard-link it atomically. */
  tryAcquireExclusiveLock(relativeCandidate: string, relativeTarget: string, ownerContent: string, options: { ownerlessGraceMs?: number } = {}): boolean {
    if (process.platform === "darwin") {
      contentByteLength(ownerContent);
      const bytes = Buffer.from(ownerContent, "utf8");
      const result = this.runDescriptorHelper<{ acquired?: unknown }>("lock_acquire", {
        candidate: relativeCandidate,
        target: relativeTarget,
        bytes: bytes.toString("base64"),
        ...(options.ownerlessGraceMs === undefined ? {} : { ownerless_grace_ms: options.ownerlessGraceMs }),
      });
      if (typeof result.acquired !== "boolean") throw new PinnedRootError("write_failed", "descriptor helper returned an invalid lock result");
      return result.acquired;
    }
    try {
      this.writeExclusive(relativeCandidate, ownerContent);
    } catch (error) {
      if (error instanceof PinnedRootError && error.code === "exists") return false;
      throw error;
    }
    try {
      this.linkExclusive(relativeCandidate, relativeTarget);
      return true;
    } catch (error) {
      if (error instanceof PinnedRootError && error.code === "exists") return false;
      throw error;
    } finally {
      try { this.unlink(relativeCandidate); } catch { /* candidate cleanup is best effort */ }
    }
  }

  /** Remove a state lock only when its owner token and file identity still match. */
  releaseExclusiveLock(relativeTarget: string, token: string): boolean {
    if (process.platform === "darwin") {
      this.hooks.beforeConditionalCommit?.(relativeTarget);
      try {
        const result = this.runDescriptorHelper<{ released?: unknown }>("lock_release", { target: relativeTarget, token });
        if (typeof result.released !== "boolean") throw new PinnedRootError("write_failed", "descriptor helper returned an invalid lock release result");
        return result.released;
      } catch (error) {
        if (error instanceof PinnedRootError && error.code === "not_found") return false;
        throw error;
      }
    }

    // Non-Darwin uses the same descriptor-bound compare-and-swap primitive as
    // state/CTO lock cleanup. Read the owner through the pinned root, require
    // the caller token, then remove only the exact inode+bytes observed. A
    // replacement lock can therefore never be unlinked by a stale releaser.
    try {
      const observed = this.readFile(relativeTarget, { maxBytes: 64 * 1024 });
      let owner: unknown;
      try {
        owner = JSON.parse(Buffer.from(observed.bytes).toString("utf8")) as unknown;
      } catch {
        return false;
      }
      if (!owner || typeof owner !== "object" || Array.isArray(owner)
        || (owner as { token?: unknown }).token !== token) return false;
      const expected: PinnedRootFileExpectation = {
        dev: observed.dev,
        ino: observed.ino,
        sha256: createHash("sha256").update(observed.bytes).digest("hex"),
      };
      this.removeFileIfMatches(relativeTarget, expected);
      return true;
    } catch (error) {
      if (error instanceof PinnedRootError && ["not_found", "not_regular", "changed"].includes(error.code)) return false;
      throw error;
    }
  }

  private assertExpectation(expected: PinnedRootFileExpectation): void {
    if (!expected || !Number.isSafeInteger(expected.dev) || !Number.isSafeInteger(expected.ino)
      || (expected.size !== undefined && (!Number.isSafeInteger(expected.size) || expected.size < 0))
      || typeof expected.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(expected.sha256)) {
      throw new PinnedRootError("invalid", "conditional file expectation is invalid");
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new PinnedRootError("changed", "pinned project root is closed");
  }

  /** Capture a bounded preimage for callers that need an exact publication receipt. */
  captureWritePreimageForReceipt(relativeFile: string): PinnedRootWritePreimage {
    return this.captureWritePreimage(relativeFile);
  }

  /** Roll back one receipt through this pinned descriptor, preserving replacements. */
  rollbackWriteReceipt(receipt: PinnedRootWriteReceipt): boolean {
    if (!receipt || receipt.path !== this.anchorPath(receipt.relative_path)
      || receipt.descriptor.path !== receipt.path
      || receipt.descriptor.relative_path !== receipt.relative_path) return false;
    return this.rollbackPublishedDescriptor(receipt.relative_path, receipt.descriptor, receipt.preimage);
  }

  /** Capture a bounded preimage for rollback if publication loses root authority. */
  private captureWritePreimage(relativeFile: string): PinnedRootWritePreimage {
    if (!this.isStable()) throw new PinnedRootError("changed", "pinned project root changed before anchored write preimage capture");
    const info = this.pathEntryInfo(relativeFile);
    if (info === null) return { kind: "absent" };
    if (info.kind !== "file") throw new PinnedRootError("path_unauthorized", "anchored write target is not a regular file");
    const observed = this.readFile(relativeFile, { maxBytes: MAX_PINNED_ROOT_READ_BYTES });
    const bytes = Buffer.from(observed.bytes);
    if (
      observed.dev !== info.dev
      || observed.ino !== info.ino
      || bytes.byteLength !== info.size
      || (observed.mtimeMs !== undefined && observed.mtimeMs !== info.mtimeMs)
      || (observed.ctimeMs !== undefined && observed.ctimeMs !== info.ctimeMs)
      || !this.isStable()
    ) {
      throw new PinnedRootError("changed", "anchored write target changed while capturing its preimage");
    }
    return {
      kind: "file",
      bytes,
      expectation: { dev: observed.dev, ino: observed.ino, size: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") },
    };
  }

  private preimageMatchesAnchored(relativeFile: string, preimage: PinnedRootWritePreimage): boolean {
    try {
      const info = this.pathEntryInfo(relativeFile);
      if (preimage.kind === "absent") return info === null;
      if (info === null || info.kind !== "file") return false;
      const observed = this.readFile(relativeFile, { maxBytes: MAX_PINNED_ROOT_READ_BYTES });
      return observed.dev === preimage.expectation.dev
        && observed.ino === preimage.expectation.ino
        && (preimage.expectation.size === undefined || observed.size === preimage.expectation.size)
        && createHash("sha256").update(Buffer.from(observed.bytes)).digest("hex") === preimage.expectation.sha256;
    } catch {
      return false;
    }
  }

  /** Roll back through the inherited root descriptor even when its pathname was swapped away. */
  private rollbackPublishedDescriptor(
    relativeFile: string,
    descriptor: PinnedRootWriteDescriptor,
    preimage: PinnedRootWritePreimage,
  ): boolean {
    try {
      const expected = { dev: descriptor.dev, ino: descriptor.ino, size: descriptor.size, sha256: descriptor.sha256 };
      const operation = preimage.kind === "absent" ? "remove_if_matches" : "replace_if_matches";
      const result = this.runDescriptorHelper<PinnedWriteDescriptorResponse>(operation, {
        path: relativeFile,
        expected,
        ...(preimage.kind === "file" ? { bytes: contentToBase64(preimage.bytes) } : {}),
      });
      if (result.ok === true) return true;
      return this.preimageMatchesAnchored(relativeFile, preimage);
    } catch {
      return this.preimageMatchesAnchored(relativeFile, preimage);
    }
  }

  private rollbackBatchDescriptors(
    entries: readonly { path: string }[],
    descriptors: readonly PinnedRootWriteDescriptor[],
    preimages: readonly PinnedRootWritePreimage[],
  ): boolean {
    let allRolledBack = true;
    for (let index = descriptors.length - 1; index >= 0; index -= 1) {
      const descriptor = descriptors[index];
      const entry = entries[index];
      const preimage = preimages[index];
      if (!descriptor || !entry || !preimage || !this.rollbackPublishedDescriptor(entry.path, descriptor, preimage)) {
        allRolledBack = false;
      }
    }
    return allRolledBack;
  }

  private rememberBatchPreimages(
    descriptors: readonly PinnedRootWriteDescriptor[],
    preimages: readonly PinnedRootWritePreimage[],
  ): void {
    if (descriptors.length !== preimages.length) {
      throw new PinnedRootError("write_failed", "anchored atomic batch preimage metadata is incomplete");
    }
    for (let index = 0; index < descriptors.length; index += 1) {
      descriptorPreimages.set(descriptors[index]!, preimages[index]!);
    }
  }

  /** Require root authority after publication; on loss, remove only owned descriptors. */
  private finishPublishedDescriptor(
    relativeFile: string,
    descriptor: PinnedRootWriteDescriptor,
    preimage: PinnedRootWritePreimage,
    ownsPublication = true,
  ): PinnedRootWriteDescriptor {
    if (this.isStable()) return descriptor;
    if (ownsPublication && !this.rollbackPublishedDescriptor(relativeFile, descriptor, preimage)) {
      throw new PinnedRootError("changed", "pinned project root changed after anchored write publication and rollback could not be proven");
    }
    throw new PinnedRootError("changed", "pinned project root changed after anchored write publication");
  }

  private finishPublishedDescriptors(
    entries: readonly { path: string }[],
    descriptors: readonly PinnedRootWriteDescriptor[],
    preimages: readonly PinnedRootWritePreimage[],
  ): readonly PinnedRootWriteDescriptor[] {
    if (this.isStable()) return descriptors;
    if (!this.rollbackBatchDescriptors(entries, descriptors, preimages)) {
      throw new PinnedRootError("changed", "pinned project root changed after anchored batch publication and rollback could not be proven");
    }
    throw new PinnedRootError("changed", "pinned project root changed after anchored batch publication");
  }

  private durableBatchResidueAbsent(batchId: string, manifest: readonly { path: string }[]): boolean {
    if (process.platform !== "darwin" || !this.isStable()) return false;
    const candidates = [
      boundedDarwinSibling("batch-journal", batchId, ".json"),
      ...manifest.flatMap((entry) => {
        const path = safeRelativeSegments(entry.path).join("/");
        const parent = safeRelativeSegments(path).slice(0, -1);
        return [
          [...parent, boundedDarwinSibling("cas-lock", path, ".lock")].join("/"),
          [...parent, boundedDarwinSibling("cas-stage", path, ".tmp")].join("/"),
        ];
      }),
    ];
    for (const candidate of candidates) {
      const segments = safeRelativeSegments(candidate);
      let current = this.canonical_root;
      for (let index = 0; index < segments.length; index += 1) {
        current = join(current, segments[index]!);
        try {
          const info = lstatSync(current);
          if (index === segments.length - 1) return false;
          if (!info.isDirectory()) return false;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
          return false;
        }
      }
    }
    return this.isStable();
  }

  public assertStable(): void {
    if (!this.isStable()) throw new PinnedRootError("changed", "pinned project root identity changed");
  }

  private canonicalPath(relativeFile: string): string {
    const segments = safeRelativeSegments(relativeFile);
    return join(this.canonical_root, ...segments);
  }

  private openParent(segments: string[], create: boolean): { fd: number; identity: Stats; close: () => void } {
    let parentFd = this.rootFd;
    let ownedParent: number | null = null;
    try {
      for (let index = 0; index < segments.length; index += 1) {
        const segment = segments[index]!;
        const childFd = this.openDirectoryChild(parentFd, segment, segments.slice(0, index + 1).join("/"), create);
        closeQuietly(ownedParent);
        ownedParent = childFd;
        parentFd = childFd;
      }
      const identity = fstatSync(parentFd);
      if (!identity.isDirectory()) throw new PinnedRootError("not_directory", "anchored parent is not a directory");
      const heldFd = parentFd;
      return {
        fd: heldFd,
        identity,
        close: () => closeQuietly(ownedParent),
      };
    } catch (error) {
      closeQuietly(ownedParent);
      if (error instanceof PinnedRootError) throw error;
      const code = errnoCode(error);
      if (code === "ENOENT") throw new PinnedRootError("not_found", "anchored parent directory does not exist");
      throw new PinnedRootError("path_unauthorized", `anchored parent could not be opened: ${String(error)}`);
    }
  }

  private assertParentPathIdentity(parentFd: number, relativeDirectory: string): void {
    if (process.platform !== "darwin") return;
    const parentPath = relativeDirectory.length === 0 ? this.canonical_root : join(this.canonical_root, ...safeRelativeSegments(relativeDirectory));
    try {
      const pathname = lstatSync(parentPath);
      const descriptor = fstatSync(parentFd);
      if (pathname.isSymbolicLink() || !pathname.isDirectory() || !sameIdentity(pathname, descriptor)) {
        throw new PinnedRootError("changed", "anchored parent pathname changed during the operation");
      }
    } catch (error) {
      if (error instanceof PinnedRootError) throw error;
      throw new PinnedRootError("changed", `anchored parent pathname could not be verified: ${String(error)}`);
    }
  }

  private assertCanonicalDirectory(relativeDirectory: string): void {
    if (process.platform !== "darwin") return;
    const segments = safeRelativeSegments(relativeDirectory, true);
    let probe = this.canonical_root;
    const rootInfo = lstatSync(probe);
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory() || rootInfo.dev !== this.dev || rootInfo.ino !== this.ino) throw new PinnedRootError("changed", "pinned project root pathname changed");
    for (const segment of segments) {
      probe = join(probe, segment);
      const info = lstatSync(probe);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new PinnedRootError("path_unauthorized", "anchored directory contains an unsafe component");
      if (realpathSync(probe) !== probe) throw new PinnedRootError("path_unauthorized", "anchored directory contains a symlink");
    }
  }

  private parentDirectoryPath(parentFd: number, relativeDirectory: string): string {
    if (process.platform === "darwin") {
      const segments = safeRelativeSegments(relativeDirectory, true);
      return segments.length === 0 ? this.canonical_root : join(this.canonical_root, ...segments);
    }
    const parentPath = descriptorPathFor(parentFd);
    if (parentPath === null) throw new PinnedRootError("unsupported", "descriptor-anchored paths are unavailable");
    return parentPath;
  }

  private childPath(parentFd: number, segment: string, relativeDirectory: string): string {
    const parentPath = this.parentDirectoryPath(parentFd, relativeDirectory.split("/").slice(0, -1).join("/"));
    return join(parentPath, segment);
  }

  private openDirectoryChild(parentFd: number, segment: string, relativeDirectory: string, create: boolean): number {
    const flags = descriptorFlags();
    if (flags === null) throw new PinnedRootError("unsupported", "descriptor no-follow directories are unavailable");
    const candidate = this.childPath(parentFd, segment, relativeDirectory);
    const parentRelative = relativeDirectory.split("/").slice(0, -1).join("/");
    this.assertCanonicalDirectory(parentRelative);
    this.assertParentPathIdentity(parentFd, parentRelative);
    let before: Stats | null = null;
    try {
      before = lstatSync(candidate);
      if (before.isSymbolicLink() || !before.isDirectory()) throw new PinnedRootError("path_unauthorized", `anchored directory '${relativeDirectory}' is not a real directory`);
    } catch (error) {
      if (errnoCode(error) !== "ENOENT") throw error;
      if (!create) throw new PinnedRootError("not_found", `anchored parent directory does not exist`);
      this.hooks.beforeDirectoryCreate?.(relativeDirectory);
      this.assertCanonicalDirectory(relativeDirectory.split("/").slice(0, -1).join("/"));
      this.assertParentPathIdentity(parentFd, parentRelative);
      try {
        assertCurrentExecutionLiveness();
      mkdirSync(candidate, { mode: 0o700 });
      } catch (mkdirError) {
        if (errnoCode(mkdirError) !== "EEXIST") throw mkdirError;
      }
      try {
        before = lstatSync(candidate);
      } catch (inspectError) {
        if (errnoCode(inspectError) === "ENOENT") throw new PinnedRootError("not_found", `anchored directory '${relativeDirectory}' disappeared while being created`);
        throw inspectError;
      }
      if (before.isSymbolicLink() || !before.isDirectory()) throw new PinnedRootError("path_unauthorized", `anchored directory '${relativeDirectory}' is not a real directory`);
    }
    let childFd: number;
    try {
      childFd = openSync(candidate, flags);
    } catch (error) {
      const code = errnoCode(error);
      if (code === "ENOENT") throw new PinnedRootError("not_found", `anchored directory '${relativeDirectory}' does not exist`);
      if (code === "ELOOP" || code === "ENOTDIR") throw new PinnedRootError("path_unauthorized", `anchored directory '${relativeDirectory}' is unsafe`);
      throw error;
    }
    try {
      const after = fstatSync(childFd);
      if (!after.isDirectory() || before === null || !sameIdentity(before, after)) throw new PinnedRootError("changed", `anchored directory '${relativeDirectory}' changed while opening`);
      const physicalRoot = process.platform === "darwin" ? this.canonical_root : realpathSync(this.rootDescriptorPath);
      let physicalChild: string;
      if (process.platform === "darwin") {
        physicalChild = realpathSync(candidate);
      } else {
        const childPath = descriptorPathFor(childFd);
        if (childPath === null) throw new PinnedRootError("unsupported", "descriptor-anchored paths are unavailable");
        physicalChild = realpathSync(childPath);
      }
      const childRelative = relative(physicalRoot, physicalChild);
      if (childRelative.startsWith("..") || isAbsolute(childRelative)) throw new PinnedRootError("path_unauthorized", `anchored directory '${relativeDirectory}' resolves outside the pinned root`);
      this.assertStable();
      assertCurrentExecutionLiveness();
      return childFd;
    } catch (error) {
      closeQuietly(childFd);
      if (error instanceof ExecutionLivenessViolation) throw error;
      if (error instanceof PinnedRootError) throw error;
      throw new PinnedRootError("path_unauthorized", `anchored directory '${relativeDirectory}' could not be verified: ${String(error)}`);
    }
  }
}

/** Shared exact rollback helper for state and other receipt-owning callers. */
export function rollbackPinnedRootWriteReceipt(pinnedRoot: PinnedProjectRoot, receipt: PinnedRootWriteReceipt): boolean {
  try { return pinnedRoot.rollbackWriteReceipt(receipt); } catch { return false; }
}

/** Shared preimage capture helper for lock-owning transaction callers. */
export function capturePinnedRootWritePreimage(pinnedRoot: PinnedProjectRoot, relativeFile: string): PinnedRootWritePreimage {
  return pinnedRoot.captureWritePreimageForReceipt(relativeFile);
}
