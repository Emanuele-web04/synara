import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import {
  COMPUTER_GRANT_ACTION_CLASSES,
  COMPUTER_GRANT_DEFAULT_TTL_MS,
  COMPUTER_GRANT_MAX_COUNT,
  COMPUTER_GRANT_MAX_TTL_MS,
  COMPUTER_GRANT_MIN_TTL_MS,
  ThreadId,
  type ComputerApp,
  type ComputerApprovalGrant,
  type ComputerGrant,
  type ComputerGrantActionClass,
  type ComputerGrantAppIdentity,
  type ComputerGrantScope,
  type ComputerWindow,
} from "@synara/contracts";

import type { ComputerAuditEntry } from "./computerAuditLog.ts";

/**
 * Durable, scoped consent grants for the computer approval gate.
 *
 * A grant is minted only by an approval response that explicitly chose
 * "always allow" — {@link ComputerApprovalGate} hands the choice here — and
 * it only ever waives the next prompt. It does not admit an app, does not
 * touch the denylist, and does not lift a disabled or suspended thread:
 * those checks run downstream on every call regardless of what a grant
 * answered.
 *
 * Identity is the stable app identity — bundle id plus code-signing team
 * identifier when the backend reports one — never a pid. A grant recorded
 * with a bundle id matches only calls that resolve to the same bundle id
 * (and the same team when the grant recorded one); a name-only grant is the
 * residual form for backends that report no bundle id and matches on exact
 * normalized name.
 *
 * Persistence follows `ComputerControlState`: one JSON document beside it
 * (`computer-grants.json`), validated on load, written through temp-file +
 * rename on a serialized chain. A malformed file loads as a hard failure —
 * no grants apply and none may be created until it is fixed, matching the
 * fail-closed posture the control state takes rather than silently
 * discarding a user's consent records or writing over unreadable ones.
 */

/** The audit tool name every grant lifecycle row carries. */
export const COMPUTER_GRANT_AUDIT_TOOL = "computer_grant";
/** `code` values on grant lifecycle audit rows. */
export const COMPUTER_GRANT_CREATED_CODE = "grant_created";
export const COMPUTER_GRANT_APPLIED_CODE = "grant_applied";
export const COMPUTER_GRANT_REVOKED_CODE = "grant_revoked";
export const COMPUTER_GRANT_EXPIRED_CODE = "grant_expired";
export const COMPUTER_GRANT_REFUSED_CODE = "grant_refused";

/**
 * What one gated call needs a grant to cover, resolved at prompt time.
 * `apps` holds the stable identities the call provably drives; when part of
 * the call has no resolvable app — the shared clipboard, an opaque browser
 * target, a label-only semantic aim — `includesUnattributedTarget` is set
 * and only an `any-app` grant can cover the call.
 */
export interface ComputerGrantCallContext {
  readonly apps: readonly ComputerGrantAppIdentity[];
  readonly includesUnattributedTarget: boolean;
  readonly classes: readonly ComputerGrantActionClass[];
}

/**
 * The inventory the call-context resolver consults — the same
 * `listWindows`/`listApps` reads the denylist path makes, best-effort: a
 * failed enumeration degrades to `undefined` and the affected targets fall
 * back to `includesUnattributedTarget` rather than guessing.
 */
export interface ComputerGrantResolution {
  readonly windows: readonly ComputerWindow[] | undefined;
  readonly apps: readonly ComputerApp[] | undefined;
}

const COMPUTER_GRANT_FILE_VERSION = 1;
const BUNDLE_ID_PATTERN = /^[a-zA-Z][\w-]*(\.[\w-]+)+$/;

function normalizeAppName(name: string | undefined): string | undefined {
  const normalized = name?.trim().toLowerCase();
  return normalized === undefined || normalized.length === 0 ? undefined : normalized;
}

/** The identity a running or installed app resolves to for grant matching. */
export function computerGrantIdentityForApp(app: ComputerApp): ComputerGrantAppIdentity {
  return {
    ...(app.name.trim().length > 0 ? { name: app.name } : {}),
    ...(app.bundleId !== undefined && app.bundleId.trim().length > 0
      ? { bundleId: app.bundleId }
      : {}),
    ...(app.teamId !== undefined && app.teamId.trim().length > 0 ? { teamId: app.teamId } : {}),
  };
}

/**
 * Whether the identity carries anything matchable at all. An empty record
 * can never key a grant — the caller treats it as an unresolved target.
 */
export function computerGrantIdentityIsMeaningful(identity: ComputerGrantAppIdentity): boolean {
  return (
    normalizeAppName(identity.name) !== undefined ||
    (identity.bundleId !== undefined && identity.bundleId.trim().length > 0)
  );
}

/** Dedup/match key for one resolved identity — never a pid. */
export function computerGrantIdentityKey(identity: ComputerGrantAppIdentity): string {
  const bundleId = identity.bundleId?.trim();
  if (bundleId !== undefined && bundleId.length > 0) {
    return `bundle:${bundleId.toLowerCase()}:${identity.teamId?.trim().toLowerCase() ?? ""}`;
  }
  return `name:${normalizeAppName(identity.name) ?? ""}`;
}

/**
 * Whether a grant's recorded identity covers the identity a call resolved.
 * Bundle ids decide when the grant recorded one — a call that could not
 * resolve the same bundle id does not match, because name-only agreement
 * under a known bundle id is exactly the spoof a durable grant must not
 * inherit. Name-only grants are the residual case for backends that never
 * report bundle ids and match on exact normalized name.
 */
export function computerGrantAppIdentityMatches(
  grant: ComputerGrantAppIdentity,
  call: ComputerGrantAppIdentity,
): boolean {
  const grantBundleId = grant.bundleId?.trim();
  const callBundleId = call.bundleId?.trim();
  if (grantBundleId !== undefined && grantBundleId.length > 0) {
    if (callBundleId === undefined || callBundleId.length === 0) return false;
    if (grantBundleId.toLowerCase() !== callBundleId.toLowerCase()) return false;
    const grantTeamId = grant.teamId?.trim();
    if (grantTeamId === undefined || grantTeamId.length === 0) return true;
    return grantTeamId.toLowerCase() === (call.teamId?.trim().toLowerCase() ?? "");
  }
  const grantName = normalizeAppName(grant.name);
  const callName = normalizeAppName(call.name);
  return grantName !== undefined && grantName === callName;
}

/** window → owning app identity, resolved through the live inventory. */
export function computerGrantIdentityForWindow(
  window: ComputerWindow,
  apps: readonly ComputerApp[] | undefined,
): ComputerGrantAppIdentity | undefined {
  const owner =
    window.pid !== undefined
      ? apps?.find((candidate) => candidate.pid === window.pid && candidate.running)
      : undefined;
  const identity: ComputerGrantAppIdentity =
    owner !== undefined
      ? computerGrantIdentityForApp(owner)
      : window.appName !== undefined
        ? { name: window.appName }
        : {};
  return computerGrantIdentityIsMeaningful(identity) ? identity : undefined;
}

/** pid → app identity. A pid alone is never a grant key — only the app it resolves to is. */
export function computerGrantIdentityForPid(
  pid: number,
  apps: readonly ComputerApp[] | undefined,
): ComputerGrantAppIdentity | undefined {
  const owner = apps?.find((candidate) => candidate.pid === pid && candidate.running);
  if (owner !== undefined) {
    const identity = computerGrantIdentityForApp(owner);
    return computerGrantIdentityIsMeaningful(identity) ? identity : undefined;
  }
  return undefined;
}

/**
 * The name or bundle id a `launch_app`-shaped argument declares, resolved to
 * an installed app's identity when the inventory knows it. A bundle-id
 * spelling matches on bundle id; anything else matches on exact name, and
 * an unknown spelling keeps its name-only identity — the denylist still
 * decides whether the launch itself may proceed.
 */
export function computerGrantIdentityForAppArg(
  app: string,
  apps: readonly ComputerApp[] | undefined,
): ComputerGrantAppIdentity | undefined {
  const trimmed = app.trim();
  if (trimmed.length === 0) return undefined;
  const bundleIdSpelled = BUNDLE_ID_PATTERN.test(trimmed);
  const listed = apps?.find((candidate) =>
    bundleIdSpelled
      ? candidate.bundleId !== undefined &&
        candidate.bundleId.toLowerCase() === trimmed.toLowerCase()
      : normalizeAppName(candidate.name) === trimmed.toLowerCase(),
  );
  if (listed !== undefined) return computerGrantIdentityForApp(listed);
  return bundleIdSpelled ? { bundleId: trimmed, name: trimmed } : { name: trimmed };
}

const COMPUTER_GRANT_INPUT_TOOLS: ReadonlySet<string> = new Set([
  "computer_click",
  "computer_double_click",
  "computer_triple_click",
  "computer_right_click",
  "computer_move_cursor",
  "computer_drag",
  "computer_scroll",
  "computer_type_text",
  "computer_press_key",
  "computer_hotkey",
  "computer_set_value",
  "computer_perform_action",
  "computer_select_text",
]);

const COMPUTER_GRANT_LIFECYCLE_TOOLS: ReadonlySet<string> = new Set([
  "computer_launch_app",
  "computer_activate_window",
  "computer_invoke_menu",
  "computer_kill_app",
  "computer_set_window_frame",
  "computer_set_window_minimized",
  "computer_set_app_visibility",
]);

/**
 * The action classes a gated tool exercises. `computer_paste` is both a
 * clipboard write and keystroke input, so it demands both classes. A
 * `computer_run` is the union of its declared step types; a step type the
 * dispatcher does not know contributes nothing because the run is refused
 * at parse anyway.
 */
export function computerGrantClassesForTool(
  name: string,
  args: Record<string, unknown>,
): readonly ComputerGrantActionClass[] {
  if (name.startsWith("computer_browser_")) return ["browser"];
  if (COMPUTER_GRANT_INPUT_TOOLS.has(name)) return ["input"];
  if (COMPUTER_GRANT_LIFECYCLE_TOOLS.has(name)) return ["lifecycle"];
  if (name === "computer_paste") return ["clipboard", "input"];
  if (name === "computer_read_clipboard" || name === "computer_write_clipboard") {
    return ["clipboard"];
  }
  if (name !== "computer_run") return [];
  const classes = new Set<ComputerGrantActionClass>();
  for (const step of Array.isArray(args.steps) ? args.steps : []) {
    if (step === null || typeof step !== "object" || Array.isArray(step)) continue;
    const type = Reflect.get(step, "type");
    for (const cls of computerGrantClassesForRunStep(typeof type === "string" ? type : "")) {
      classes.add(cls);
    }
  }
  return [...classes];
}

function computerGrantClassesForRunStep(type: string): readonly ComputerGrantActionClass[] {
  switch (type) {
    case "click":
    case "double_click":
    case "triple_click":
    case "right_click":
    case "move_cursor":
    case "drag":
    case "scroll":
    case "type_text":
    case "press_key":
    case "hotkey":
    case "set_value":
    case "perform_action":
    case "select_text":
      return ["input"];
    case "write_clipboard":
      return ["clipboard"];
    case "paste":
      return ["clipboard", "input"];
    case "activate_window":
    case "launch_app":
    case "set_window_frame":
    case "invoke_menu":
    case "kill_app":
    case "set_window_minimized":
    case "set_app_visibility":
      return ["lifecycle"];
    // `wait` is observation: it declares no mutation a grant class names.
    default:
      return [];
  }
}

/** The TTL configuration the store answers and enforces. */
export interface ComputerGrantTtlConfig {
  readonly defaultTtlMs: number;
  readonly minTtlMs: number;
  readonly maxTtlMs: number;
}

export interface StoredComputerGrant {
  readonly id: string;
  readonly app: ComputerGrantAppIdentity | null;
  /**
   * Mutable to match `ComputerGrant.classes` (a `Schema.Array`): list() and
   * createFromApproval hand contract-typed rows to the management surface,
   * so the stored row cannot be wider than the contract's own mutability.
   */
  readonly classes: ComputerGrantActionClass[];
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly lastUsedAt?: string;
  readonly createdByThreadId?: string;
}

export interface ComputerGrantStoreOptions {
  readonly filePath?: string | undefined;
  /** Milliseconds since epoch — the manager's injected clock. */
  readonly now?: (() => number) | undefined;
  /** Fire-and-forget audit sink; the manager wires the computer audit log. */
  readonly audit?: ((entry: Omit<ComputerAuditEntry, "ts">) => void) | undefined;
  readonly defaultTtlMs?: number | undefined;
}

function isActionClass(value: unknown): value is ComputerGrantActionClass {
  return (
    typeof value === "string" &&
    (COMPUTER_GRANT_ACTION_CLASSES as readonly string[]).includes(value)
  );
}

function readStoredIdentity(value: unknown): ComputerGrantAppIdentity | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const name = record.name;
  const bundleId = record.bundleId;
  const teamId = record.teamId;
  const identity: ComputerGrantAppIdentity = {
    ...(typeof name === "string" && name.trim().length > 0 ? { name } : {}),
    ...(typeof bundleId === "string" && bundleId.trim().length > 0 ? { bundleId } : {}),
    ...(typeof teamId === "string" && teamId.trim().length > 0 ? { teamId } : {}),
  };
  return computerGrantIdentityIsMeaningful(identity) ? identity : undefined;
}

function readStoredGrant(value: unknown): StoredComputerGrant {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid grant row.");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || record.id.trim().length === 0 || record.id.length > 64) {
    throw new Error("Invalid grant id.");
  }
  const app =
    record.app === null ? null : record.app === undefined ? null : readStoredIdentity(record.app);
  if (app === undefined) throw new Error("Invalid grant app identity.");
  if (!Array.isArray(record.classes) || record.classes.length === 0) {
    throw new Error("Invalid grant classes.");
  }
  const classes: ComputerGrantActionClass[] = [];
  for (const cls of record.classes) {
    if (!isActionClass(cls)) throw new Error("Invalid grant action class.");
    if (!classes.includes(cls)) classes.push(cls);
  }
  const createdAt = Date.parse(typeof record.createdAt === "string" ? record.createdAt : "");
  const expiresAt = Date.parse(typeof record.expiresAt === "string" ? record.expiresAt : "");
  if (!Number.isFinite(createdAt) || !Number.isFinite(expiresAt)) {
    throw new Error("Invalid grant timestamps.");
  }
  const lastUsedAt =
    typeof record.lastUsedAt === "string" && Number.isFinite(Date.parse(record.lastUsedAt))
      ? record.lastUsedAt
      : undefined;
  return {
    id: record.id,
    app,
    classes,
    createdAt: new Date(createdAt).toISOString(),
    expiresAt: new Date(expiresAt).toISOString(),
    ...(lastUsedAt !== undefined ? { lastUsedAt } : {}),
    ...(typeof record.createdByThreadId === "string" && record.createdByThreadId.length > 0
      ? { createdByThreadId: record.createdByThreadId }
      : {}),
  };
}

/**
 * Stored → contract row: `createdByThreadId` is the only branded field, and
 * `classes` copies so a caller cannot mutate the stored array through the
 * row it holds.
 */
function toContractGrant(grant: StoredComputerGrant): ComputerGrant {
  const { createdByThreadId, ...rest } = grant;
  return {
    ...rest,
    classes: [...grant.classes],
    ...(createdByThreadId !== undefined
      ? { createdByThreadId: ThreadId.makeUnsafe(createdByThreadId) }
      : {}),
  };
}

function grantAppAuditTarget(
  app: ComputerGrantAppIdentity | null,
): NonNullable<ComputerAuditEntry["target"]> {
  return app === null
    ? { app: "*" }
    : {
        ...(app.name !== undefined ? { app: app.name } : {}),
        ...(app.bundleId !== undefined ? { bundleId: app.bundleId } : {}),
      };
}

/**
 * The durable store behind "always allow". Owns the grant file, enforces
 * expiry at read time, and writes the lifecycle audit rows. Synchronous for
 * every read and bookkeeping mutation; the file write itself rides a
 * serialized promise like `ComputerControlState`'s.
 */
export class ComputerGrantStore {
  private readonly filePath: string | undefined;
  private readonly now: () => number;
  private readonly audit: ((entry: Omit<ComputerAuditEntry, "ts">) => void) | undefined;
  private readonly grants = new Map<string, StoredComputerGrant>();
  private writes = Promise.resolve();
  private loadError: Error | undefined;
  private readonly ttl: ComputerGrantTtlConfig;

  constructor(options: ComputerGrantStoreOptions = {}) {
    this.filePath = options.filePath;
    this.now = options.now ?? Date.now;
    this.audit = options.audit;
    this.ttl = {
      defaultTtlMs: clampGrantTtl(
        options.defaultTtlMs ?? computerGrantDefaultTtlOverride() ?? COMPUTER_GRANT_DEFAULT_TTL_MS,
      ),
      minTtlMs: COMPUTER_GRANT_MIN_TTL_MS,
      maxTtlMs: COMPUTER_GRANT_MAX_TTL_MS,
    };
    if (this.filePath === undefined) return;
    try {
      const data: unknown = JSON.parse(readFileSync(this.filePath, "utf8"));
      if (typeof data !== "object" || data === null || Array.isArray(data)) {
        throw new Error("Invalid grant store structure.");
      }
      const record = data as Record<string, unknown>;
      if (record.version !== COMPUTER_GRANT_FILE_VERSION || !Array.isArray(record.grants)) {
        throw new Error("Invalid grant store structure.");
      }
      for (const row of record.grants) {
        const grant = readStoredGrant(row);
        if (this.grants.has(grant.id)) throw new Error("Duplicate grant id.");
        this.grants.set(grant.id, grant);
      }
      // Grants that lapsed while the server was off expire now, on first
      // load, with the same audit row a live expiry would write.
      this.pruneExpired();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      // A broken grant file disables grants, not computer use: every lookup
      // misses and creation refuses, so consent reverts to prompting.
      this.loadError = new Error("Computer grant store could not be loaded; grants are disabled.", {
        cause: error,
      });
    }
  }

  ttlConfig(): ComputerGrantTtlConfig {
    return this.ttl;
  }

  /** Live grants, newest first, with lapsed rows pruned and audited once. */
  list(): ComputerGrant[] {
    this.pruneExpired();
    return [...this.grants.values()]
      .toSorted((first, second) => second.createdAt.localeCompare(first.createdAt))
      .map(toContractGrant);
  }

  /**
   * Whether live grants cover everything this call provably touches. Per
   * (app, class) pair — a run spanning two apps needs each app covered for
   * each class the call exercises — and an unattributed target is coverable
   * only by an `any-app` grant. The matching grants ride back so the caller
   * can mark them used and audit the application.
   */
  covers(context: ComputerGrantCallContext): readonly StoredComputerGrant[] | undefined {
    if (context.classes.length === 0) return undefined;
    this.pruneExpired();
    const live = [...this.grants.values()];
    const used = new Map<string, StoredComputerGrant>();
    if (context.includesUnattributedTarget || context.apps.length === 0) {
      // Only an any-app grant covers a target with no stable identity.
      for (const cls of context.classes) {
        const grant = live.find(
          (candidate) => candidate.app === null && candidate.classes.includes(cls),
        );
        if (grant === undefined) return undefined;
        used.set(grant.id, grant);
      }
      return [...used.values()];
    }
    for (const identity of context.apps) {
      for (const cls of context.classes) {
        const grant = live.find(
          (candidate) =>
            candidate.classes.includes(cls) &&
            (candidate.app === null || computerGrantAppIdentityMatches(candidate.app, identity)),
        );
        if (grant === undefined) return undefined;
        used.set(grant.id, grant);
      }
    }
    return [...used.values()];
  }

  /**
   * Mark the grants a covered call used. `lastUsedAt` is memory-only until
   * the next create/revoke/expire write — it exists for audit review, and a
   * write per covered call would churn the file for bookkeeping nobody
   * reads in the hot path.
   */
  noteUse(
    grantIds: readonly string[],
    context: { readonly toolName: string; readonly threadId?: string; readonly turnId?: string },
  ): void {
    if (grantIds.length === 0) return;
    const at = new Date(this.now()).toISOString();
    for (const id of grantIds) {
      const grant = this.grants.get(id);
      if (grant === undefined) continue;
      this.grants.set(id, { ...grant, lastUsedAt: at });
    }
    this.audit?.({
      tool: COMPUTER_GRANT_AUDIT_TOOL,
      ...(context.threadId !== undefined ? { threadId: context.threadId } : {}),
      ...(context.turnId !== undefined ? { turnId: context.turnId } : {}),
      args: { forTool: context.toolName, grantIds: [...grantIds].slice(0, 16) },
      effect: "verified",
      code: COMPUTER_GRANT_APPLIED_CODE,
    });
  }

  /**
   * Create the grants an explicit approval choice asks for. The class list
   * is clamped to what the prompt offered — a response can only narrow the
   * offer, never widen it — and a denylisted identity is refused outright so
   * a grant can never be minted for a surface the denylist already excludes.
   * Returns the created (or renewed) grants; an empty answer means the
   * choice minted nothing and the call proceeds on the one-time approval.
   */
  createFromApproval(input: {
    readonly offer: {
      readonly apps: readonly ComputerGrantAppIdentity[];
      readonly classes: readonly ComputerGrantActionClass[];
      /**
       * The scopes the prompt honestly offered. When present, a choice
       * naming any other scope mints nothing — a response can only ever
       * narrow the offer, never take a scope it did not propose.
       */
      readonly scopes?: readonly ComputerGrantScope[];
    };
    readonly choice: ComputerApprovalGrant;
    readonly threadId?: string | undefined;
    readonly turnId?: string | undefined;
    readonly isAppDenied: (identity: ComputerGrantAppIdentity) => boolean;
  }): ComputerGrant[] {
    if (this.loadError !== undefined) return [];
    const classes = [...new Set(input.choice.classes)].filter((cls) =>
      input.offer.classes.includes(cls),
    );
    if (classes.length === 0) return [];
    const scope = input.choice.scope ?? "app";
    if (input.offer.scopes !== undefined && !input.offer.scopes.includes(scope)) return [];
    const ttlMs = clampGrantTtl(input.choice.ttlMs ?? this.ttl.defaultTtlMs);
    const nowMs = this.now();
    const createdAt = new Date(nowMs).toISOString();
    const expiresAt = new Date(nowMs + ttlMs).toISOString();
    this.pruneExpired();
    const targets: ReadonlyArray<ComputerGrantAppIdentity | null> =
      scope === "any-app" ? [null] : [...input.offer.apps];
    if (scope === "app" && targets.length === 0) return [];
    const created: ComputerGrant[] = [];
    const seenKeys = new Set<string>();
    for (const target of targets) {
      const key = target === null ? "any-app" : computerGrantIdentityKey(target);
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      if (target !== null && input.isAppDenied(target)) {
        this.audit?.({
          tool: COMPUTER_GRANT_AUDIT_TOOL,
          ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
          ...(input.turnId !== undefined ? { turnId: input.turnId } : {}),
          target: grantAppAuditTarget(target),
          args: { classes, reason: "denylist" },
          effect: "refused",
          code: "computer_denylist_refused",
        });
        continue;
      }
      // A live grant covering the same identity and classes renews in place
      // rather than stacking a duplicate row into the list.
      const existing = [...this.grants.values()].find(
        (candidate) =>
          (candidate.app === null
            ? key === "any-app"
            : computerGrantIdentityKey(candidate.app) === key) &&
          classes.every((cls) => candidate.classes.includes(cls)),
      );
      if (existing !== undefined) {
        const renewed: StoredComputerGrant = { ...existing, expiresAt };
        this.grants.set(existing.id, renewed);
        this.audit?.({
          tool: COMPUTER_GRANT_AUDIT_TOOL,
          ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
          ...(input.turnId !== undefined ? { turnId: input.turnId } : {}),
          target: grantAppAuditTarget(existing.app),
          args: { grantId: existing.id, classes: [...existing.classes], ttlMs, renewed: true },
          effect: "verified",
          code: COMPUTER_GRANT_CREATED_CODE,
        });
        created.push(toContractGrant(renewed));
        continue;
      }
      if (this.grants.size >= COMPUTER_GRANT_MAX_COUNT) {
        this.audit?.({
          tool: COMPUTER_GRANT_AUDIT_TOOL,
          ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
          ...(input.turnId !== undefined ? { turnId: input.turnId } : {}),
          target: grantAppAuditTarget(target),
          args: { classes, reason: "limit" },
          effect: "refused",
          code: COMPUTER_GRANT_REFUSED_CODE,
        });
        continue;
      }
      const grant: StoredComputerGrant = {
        id: `cg_${randomUUID()}`,
        app: target === null ? null : { ...target },
        classes,
        createdAt,
        expiresAt,
        ...(input.threadId !== undefined ? { createdByThreadId: input.threadId } : {}),
      };
      this.grants.set(grant.id, grant);
      this.audit?.({
        tool: COMPUTER_GRANT_AUDIT_TOOL,
        ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
        ...(input.turnId !== undefined ? { turnId: input.turnId } : {}),
        target: grantAppAuditTarget(grant.app),
        args: { grantId: grant.id, classes: [...classes], ttlMs },
        effect: "verified",
        code: COMPUTER_GRANT_CREATED_CODE,
      });
      created.push(toContractGrant(grant));
    }
    if (created.length > 0) this.persist();
    return created;
  }

  /** Delete one grant. Returns false when the id named no live grant. */
  revoke(grantId: string): boolean {
    this.pruneExpired();
    const grant = this.grants.get(grantId);
    if (grant === undefined) return false;
    this.grants.delete(grantId);
    this.audit?.({
      tool: COMPUTER_GRANT_AUDIT_TOOL,
      target: grantAppAuditTarget(grant.app),
      args: { grantId: grant.id, classes: [...grant.classes] },
      effect: "verified",
      code: COMPUTER_GRANT_REVOKED_CODE,
    });
    this.persist();
    return true;
  }

  /** Settles once every queued write has finished — for tests and dispose. */
  flush(): Promise<void> {
    return this.writes;
  }

  /**
   * Drop lapsed grants, auditing each expiry once. Runs lazily on every read
   * and mutation — there is no timer, because the only moments expiry can
   * matter are the moments a grant is consulted.
   */
  private pruneExpired(): void {
    const nowMs = this.now();
    let expired = false;
    for (const [id, grant] of this.grants) {
      if (Date.parse(grant.expiresAt) > nowMs) continue;
      this.grants.delete(id);
      expired = true;
      this.audit?.({
        tool: COMPUTER_GRANT_AUDIT_TOOL,
        ...(grant.createdByThreadId !== undefined ? { threadId: grant.createdByThreadId } : {}),
        target: grantAppAuditTarget(grant.app),
        args: { grantId: grant.id, classes: [...grant.classes], expiresAt: grant.expiresAt },
        effect: "refused",
        code: COMPUTER_GRANT_EXPIRED_CODE,
      });
    }
    if (expired) this.persist();
  }

  private persist(): void {
    if (this.filePath === undefined || this.loadError !== undefined) return;
    const filePath = this.filePath;
    const content = JSON.stringify({
      version: COMPUTER_GRANT_FILE_VERSION,
      grants: [...this.grants.values()],
    });
    this.writes = this.writes
      .catch(() => undefined)
      .then(async () => {
        await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
        const temporaryPath = `${filePath}.tmp`;
        await writeFile(temporaryPath, content, { mode: 0o600 });
        await rename(temporaryPath, filePath);
      });
  }
}

function clampGrantTtl(ttlMs: number): number {
  return Math.min(
    COMPUTER_GRANT_MAX_TTL_MS,
    Math.max(COMPUTER_GRANT_MIN_TTL_MS, Math.round(ttlMs)),
  );
}

/** `SYNARA_COMPUTER_GRANT_TTL_MS` overrides the default grant lifetime. */
export function computerGrantDefaultTtlOverride(): number | undefined {
  const raw = process.env.SYNARA_COMPUTER_GRANT_TTL_MS;
  if (raw === undefined) return undefined;
  const value = Number.parseInt(raw, 10);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}
