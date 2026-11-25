// FILE: newThreadDefaultsSync.ts
// Purpose: Keeps this window's new-chat defaults (each provider's last model and
//          options, the starting provider, the access mode) in step with the copy
//          the server shares with every client, so a change made on the phone
//          shows here live and a change made here reaches the phone.
// Layer: Web app state sync
// Exports: createNewThreadDefaultsSync and its pure helpers

import type {
  ModelSelection,
  NewThreadDefaults,
  ProviderInstanceId,
  ServerSettingsPatch,
} from "@synara/contracts";
import * as Equal from "effect/Equal";

import type { ComposerDraftStoreState, SharedNewThreadDefaults } from "../composerDraftStore";

export type NewThreadDefaultsPatch = NonNullable<ServerSettingsPatch["newThreadDefaults"]>;

/** One independently written value: a provider's selection, the starting provider, or the access mode. */
export type NewThreadDefaultsField = `selection:${string}` | "activeProvider" | "runtimeMode";

const WRITE_DEBOUNCE_MS = 300;

function selectionField(instanceId: string): NewThreadDefaultsField {
  return `selection:${instanceId}`;
}

function readLocalDefaults(state: ComposerDraftStoreState): SharedNewThreadDefaults {
  return {
    modelSelectionByProvider: state.stickyModelSelectionByProvider,
    activeProvider: state.stickyActiveProvider,
    runtimeMode: state.stickyRuntimeMode,
  };
}

/**
 * The local choices to hand to a server where nobody shared that choice yet: the
 * model (no selection and no starting provider) and the access mode, each on its own.
 */
export function newThreadDefaultsToMigrate(
  server: SharedNewThreadDefaults,
  local: SharedNewThreadDefaults,
): NewThreadDefaultsField[] {
  const empty: SharedNewThreadDefaults = {
    modelSelectionByProvider: {},
    activeProvider: null,
    runtimeMode: null,
  };
  const serverHasModel =
    Object.keys(server.modelSelectionByProvider).length > 0 || server.activeProvider !== null;
  return changedNewThreadDefaultsFields(empty, local).filter((field) =>
    field === "runtimeMode" ? server.runtimeMode === null : !serverHasModel,
  );
}

export function changedNewThreadDefaultsFields(
  previous: SharedNewThreadDefaults,
  next: SharedNewThreadDefaults,
): NewThreadDefaultsField[] {
  const fields: NewThreadDefaultsField[] = [];
  const instanceIds = new Set([
    ...Object.keys(previous.modelSelectionByProvider),
    ...Object.keys(next.modelSelectionByProvider),
  ]) as Set<ProviderInstanceId>;
  for (const instanceId of instanceIds) {
    if (
      !Equal.equals(
        previous.modelSelectionByProvider[instanceId],
        next.modelSelectionByProvider[instanceId],
      )
    ) {
      fields.push(selectionField(instanceId));
    }
  }
  if (previous.activeProvider !== next.activeProvider) fields.push("activeProvider");
  if (previous.runtimeMode !== next.runtimeMode) fields.push("runtimeMode");
  return fields;
}

/** A patch carrying this client's current value for each written field. */
export function newThreadDefaultsPatch(
  local: SharedNewThreadDefaults,
  fields: Iterable<NewThreadDefaultsField>,
): NewThreadDefaultsPatch {
  const modelSelectionByProvider: Record<ProviderInstanceId, ModelSelection> = {};
  let activeProvider: ProviderInstanceId | null | undefined;
  let runtimeMode: SharedNewThreadDefaults["runtimeMode"] | undefined;
  for (const field of fields) {
    if (field === "activeProvider") {
      activeProvider = local.activeProvider;
    } else if (field === "runtimeMode") {
      runtimeMode = local.runtimeMode;
    } else {
      const instanceId = field.slice("selection:".length) as ProviderInstanceId;
      const selection = local.modelSelectionByProvider[instanceId];
      // The client never forgets a provider's selection, so there is nothing to clear.
      if (selection) modelSelectionByProvider[instanceId] = selection;
    }
  }
  return {
    ...(Object.keys(modelSelectionByProvider).length > 0 ? { modelSelectionByProvider } : {}),
    ...(activeProvider !== undefined ? { activeProvider } : {}),
    ...(runtimeMode !== undefined ? { runtimeMode } : {}),
  };
}

/** The server's values, except for the fields this client is still writing. */
export function mergeNewThreadDefaults(
  server: SharedNewThreadDefaults,
  local: SharedNewThreadDefaults,
  localFields: ReadonlySet<NewThreadDefaultsField>,
): SharedNewThreadDefaults {
  const modelSelectionByProvider = { ...server.modelSelectionByProvider };
  for (const field of localFields) {
    if (!field.startsWith("selection:")) continue;
    const instanceId = field.slice("selection:".length) as ProviderInstanceId;
    const selection = local.modelSelectionByProvider[instanceId];
    if (selection) modelSelectionByProvider[instanceId] = selection;
  }
  return {
    modelSelectionByProvider,
    activeProvider: localFields.has("activeProvider")
      ? local.activeProvider
      : server.activeProvider,
    runtimeMode: localFields.has("runtimeMode") ? local.runtimeMode : server.runtimeMode,
  };
}

export interface NewThreadDefaultsSync {
  /** Feeds the server's current copy: the first read and every later settings update. */
  receive: (server: NewThreadDefaults) => void;
  dispose: () => void;
}

interface NewThreadDefaultsStore {
  getState: () => ComposerDraftStoreState;
  subscribe: (
    listener: (state: ComposerDraftStoreState, previous: ComposerDraftStoreState) => void,
  ) => () => void;
}

/**
 * The server is the source of truth and browser storage only a cache. The user's
 * own changes are written field by field after a short pause, so the last writer
 * wins per field and an unrelated change from the phone is never overwritten.
 */
export function createNewThreadDefaultsSync(input: {
  store: NewThreadDefaultsStore;
  write: (patch: NewThreadDefaultsPatch) => Promise<NewThreadDefaults | undefined>;
}): NewThreadDefaultsSync {
  // The latest copy pushed by the server, in the server's own order.
  let server: SharedNewThreadDefaults | null = null;
  let disposed = false;
  let adoptingServer = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let writeGeneration = 0;
  const dirty = new Set<NewThreadDefaultsField>();
  // Each field being written, with the write that owns it: only the latest
  // write's answer releases a field another write is still carrying.
  const writing = new Map<NewThreadDefaultsField, number>();

  const adopt = (defaults: SharedNewThreadDefaults) => {
    const next = mergeNewThreadDefaults(
      defaults,
      readLocalDefaults(input.store.getState()),
      new Set([...dirty, ...writing.keys()]),
    );
    adoptingServer = true;
    try {
      input.store.getState().applySharedNewThreadDefaults(next);
    } finally {
      adoptingServer = false;
    }
  };

  const flush = () => {
    timer = null;
    if (disposed || dirty.size === 0) return;
    const fields = [...dirty];
    dirty.clear();
    const generation = ++writeGeneration;
    for (const field of fields) writing.set(field, generation);
    const patch = newThreadDefaultsPatch(readLocalDefaults(input.store.getState()), fields);
    const settle = () => {
      const owned = fields.filter((field) => writing.get(field) === generation);
      for (const field of owned) writing.delete(field);
      return new Set(owned);
    };
    input.write(patch).then(
      (reply) => {
        const owned = settle();
        if (disposed || server === null) return;
        // An answer can trail a push the server sent after it, so it only speaks
        // for the fields this write still owns; the rest stay as last pushed.
        if (reply) server = mergeNewThreadDefaults(server, reply, owned);
        adopt(server);
      },
      () => {
        settle();
        // A refused write leaves the server's copy in charge again.
        if (!disposed && server) adopt(server);
      },
    );
  };

  const schedule = () => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(flush, WRITE_DEBOUNCE_MS);
  };

  const unsubscribe = input.store.subscribe((state, previous) => {
    // Before the first server read there is nothing to diff against; that read
    // decides between adopting the server's copy and migrating this one.
    if (adoptingServer || server === null || disposed) return;
    // Most store updates (typing, attachments) leave the defaults untouched.
    if (
      state.stickyModelSelectionByProvider === previous.stickyModelSelectionByProvider &&
      state.stickyActiveProvider === previous.stickyActiveProvider &&
      state.stickyRuntimeMode === previous.stickyRuntimeMode
    ) {
      return;
    }
    const fields = changedNewThreadDefaultsFields(
      readLocalDefaults(previous),
      readLocalDefaults(state),
    );
    if (fields.length === 0) return;
    for (const field of fields) dirty.add(field);
    schedule();
  });

  return {
    receive(next) {
      if (disposed) return;
      const isFirstRead = server === null;
      server = next;
      if (isFirstRead) {
        // One-time migration of the choices this browser kept before they were shared.
        const migrated = newThreadDefaultsToMigrate(
          next,
          readLocalDefaults(input.store.getState()),
        );
        for (const field of migrated) dirty.add(field);
        if (migrated.length > 0) schedule();
      }
      adopt(next);
    },
    dispose() {
      disposed = true;
      unsubscribe();
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}
