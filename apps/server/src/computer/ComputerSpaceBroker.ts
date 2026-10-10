import type {
  ComputerSpace,
  ComputerSpaceErrorCode,
  ComputerSpaceInventory,
  ComputerSpaceReservation,
  ComputerWindow,
} from "@synara/contracts";

import { ComputerTargetError } from "./uiTreeTargeting.ts";

export class ComputerSpaceError extends ComputerTargetError {
  constructor(code: ComputerSpaceErrorCode, message: string) {
    super({ code, message });
    this.name = "ComputerSpaceError";
  }
}

export interface ComputerSpaceOwner {
  readonly threadId: string;
  readonly turnId: string | null;
}

export interface ComputerSpaceSnapshot {
  readonly inventory: ComputerSpaceInventory;
  readonly windows: readonly ComputerWindow[];
}

const MAX_RESERVATIONS = 64;

function sameOwner(reservation: ComputerSpaceReservation, owner: ComputerSpaceOwner): boolean {
  return reservation.threadId === owner.threadId && reservation.turnId === owner.turnId;
}

/**
 * Reserves an existing user-designated Space for one Synara task. It never
 * creates, moves, activates or destroys a native Space/window. Every guarded
 * action rechecks native identity and current-Space membership; a reservation
 * invalidated by user intervention stays invalid until explicitly replaced.
 */
export class ComputerSpaceBroker {
  readonly #readSnapshot: () => Promise<ComputerSpaceSnapshot>;
  readonly #assertActive: () => void;
  readonly #reservations = new Map<string, ComputerSpaceReservation>();
  #revision = 0;
  #disposed = false;

  constructor(options: {
    readonly readSnapshot: () => Promise<ComputerSpaceSnapshot>;
    readonly assertActive: () => void;
  }) {
    this.#readSnapshot = options.readSnapshot;
    this.#assertActive = options.assertActive;
  }

  async inspect(spaceId?: number): Promise<ComputerSpaceSnapshot> {
    const snapshot = await this.#snapshot();
    this.#reconcile(snapshot.inventory);
    if (spaceId === undefined) return snapshot;
    this.#findSpace(snapshot.inventory, spaceId);
    return {
      inventory: {
        ...snapshot.inventory,
        spaces: snapshot.inventory.spaces.filter((space) => space.id === spaceId),
      },
      windows: snapshot.windows.filter((window) => window.spaceIds?.includes(spaceId)),
    };
  }

  reservationFor(owner: ComputerSpaceOwner): ComputerSpaceReservation | null {
    const reservation = this.#reservations.get(owner.threadId);
    return reservation && sameOwner(reservation, owner) ? { ...reservation } : null;
  }

  async reserve(
    owner: ComputerSpaceOwner,
    spaceId: number,
    userDesignatedSpaceIds: readonly number[],
    windowId?: string,
    recheckDesignation?: () => Promise<boolean>,
  ): Promise<ComputerSpaceReservation> {
    if (!userDesignatedSpaceIds.includes(spaceId)) {
      throw new ComputerSpaceError(
        "computer_space_not_designated",
        "The user has not designated this existing Space for this task. Ask them to say " +
          `“Use Space ID ${spaceId} for this task.” A tool argument or full access is not that designation.`,
      );
    }
    const revision = this.#revision;
    const snapshot = await this.#snapshot();
    this.#assertUnchanged(revision);
    this.#reconcile(snapshot.inventory);
    const space = this.#reservableSpace(snapshot.inventory, spaceId);
    const occupied = [...this.#reservations.values()].find(
      (entry) =>
        entry.invalidReason === null && entry.spaceId === spaceId && !sameOwner(entry, owner),
    );
    if (occupied) {
      throw new ComputerSpaceError(
        "computer_space_reserved",
        "Another Synara task reserved this Space. Use a different user-designated Space or wait for that task to finish.",
      );
    }
    if (!this.#reservations.has(owner.threadId) && this.#reservations.size >= MAX_RESERVATIONS) {
      throw new ComputerSpaceError(
        "computer_space_reservation_limit",
        "Too many tasks have Space reservations. Release an unused reservation first.",
      );
    }
    const selected = windowId === undefined ? undefined : this.#window(snapshot, windowId, spaceId);
    const admissionRevision = this.#revision;
    if (recheckDesignation && !(await recheckDesignation())) {
      throw new ComputerSpaceError(
        "computer_space_not_designated",
        "The user's current Space designation changed while reading the desktop. No reservation was created.",
      );
    }
    this.#assertActive();
    this.#assertUnchanged(admissionRevision);
    const reservation: ComputerSpaceReservation = {
      threadId: owner.threadId,
      turnId: owner.turnId,
      spaceId,
      spaceUuid: space.uuid!,
      displayId: space.displayId,
      selectedWindowId: selected?.id ?? null,
      selectedPid: selected?.pid ?? null,
      invalidReason: null,
    };
    this.#assertActive();
    this.#reservations.set(owner.threadId, reservation);
    this.#revision += 1;
    return { ...reservation };
  }

  async select(owner: ComputerSpaceOwner, windowId: string): Promise<ComputerSpaceReservation> {
    const revision = this.#revision;
    const snapshot = await this.#snapshot();
    this.#assertUnchanged(revision);
    this.#reconcile(snapshot.inventory);
    const reservation = this.#requireReservation(owner);
    const window = this.#window(snapshot, windowId, reservation.spaceId);
    const selected = { ...reservation, selectedWindowId: window.id, selectedPid: window.pid! };
    this.#assertActive();
    this.#reservations.set(owner.threadId, selected);
    this.#revision += 1;
    return { ...selected };
  }

  release(threadId: string, turnId?: string): void {
    // Fence pending replacements even when an older turn still owns the stored record.
    this.#revision += 1;
    const reservation = this.#reservations.get(threadId);
    if (reservation && turnId !== undefined && reservation.turnId !== turnId) return;
    this.#reservations.delete(threadId);
  }

  assertNativeLaunchAllowed(threadId: string | undefined): void {
    if (threadId !== undefined && this.#reservations.size > 0) {
      throw new ComputerSpaceError(
        "computer_space_operation_unsupported",
        "This backend cannot launch a native app into the reserved Space. Drive an existing window there in place, or use an isolated headless browser; no app was launched.",
      );
    }
  }

  assertForegroundAllowed(threadId: string | undefined): void {
    if (threadId !== undefined && this.#reservations.size > 0) {
      throw new ComputerSpaceError(
        "computer_space_operation_unsupported",
        "A foreground excursion or visible browser launch cannot be confined to a reserved Space. Drive the existing window in place or use an isolated headless browser; no desktop was activated.",
      );
    }
  }

  assertTargetBound(threadId: string | undefined, windowId: string | undefined): void {
    if (threadId !== undefined && this.#reservations.size > 0 && windowId === undefined) {
      throw new ComputerSpaceError(
        "computer_space_window_not_selected",
        "While a task holds a Space reservation, native input must name an exact current window. Select an existing window and pass its window_id; unscoped input was not sent.",
      );
    }
  }

  /** Application-wide side effects cannot be confined to one selected window. */
  async assertAppMutationAllowed(owner: ComputerSpaceOwner, pid: number): Promise<void> {
    if (this.#reservations.size === 0) return;
    if (this.#reservations.has(owner.threadId)) {
      throw new ComputerSpaceError(
        "computer_space_operation_unsupported",
        "Application-wide or window-visibility changes cannot be confined to a reserved Space. Drive the selected existing window in place; no app or window was changed.",
      );
    }
    const revision = this.#revision;
    const snapshot = await this.#snapshot();
    this.#assertUnchanged(revision);
    this.#reconcile(snapshot.inventory);
    for (const window of snapshot.windows.filter((candidate) => candidate.pid === pid)) {
      if (!window.spaceIds || window.spaceIds.length === 0) {
        throw new ComputerSpaceError(
          "computer_space_target_membership_unproven",
          "This application's Space membership is unknown while a task holds a reservation. No application-wide action was sent.",
        );
      }
      if (
        [...this.#reservations.values()].some(
          (entry) => entry.invalidReason === null && window.spaceIds!.includes(entry.spaceId),
        )
      ) {
        throw new ComputerSpaceError(
          "computer_space_reserved",
          "This application has a window in another task's reserved Space. No application-wide action was sent.",
        );
      }
    }
  }

  /** Called on the resolved exact window before native input admission. Idle cost is zero. */
  async assertWindowAllowed(owner: ComputerSpaceOwner, window: ComputerWindow): Promise<void> {
    if (this.#reservations.size === 0) return;
    const revision = this.#revision;
    const snapshot = await this.#snapshot();
    this.#assertUnchanged(revision);
    this.#reconcile(snapshot.inventory);
    const own = this.#reservations.get(owner.threadId);
    if (own && !sameOwner(own, owner)) {
      throw new ComputerSpaceError(
        "computer_space_reservation_changed",
        "This Space reservation belongs to another turn. Reserve it again for the current task.",
      );
    }
    if (own) {
      this.#requireReservation(owner);
      const current = this.#window(snapshot, window.id, own.spaceId);
      if (
        current.pid !== window.pid ||
        current.pid !== own.selectedPid ||
        current.id !== own.selectedWindowId
      ) {
        throw new ComputerSpaceError(
          "computer_space_window_not_selected",
          "Select this exact current window with computer_spaces before driving it. Space selection does not activate or move the window.",
        );
      }
      return;
    }
    const current = snapshot.windows.find(
      (candidate) => candidate.id === window.id && candidate.pid === window.pid,
    );
    if (!current?.spaceIds || current.spaceIds.length === 0) {
      throw new ComputerSpaceError(
        "computer_space_target_membership_unproven",
        "The target's current Space membership is unknown while another task holds a reservation. Read fresh window state before choosing a target.",
      );
    }
    if (
      [...this.#reservations.values()].some(
        (entry) => entry.invalidReason === null && current.spaceIds!.includes(entry.spaceId),
      )
    ) {
      throw new ComputerSpaceError(
        "computer_space_reserved",
        "This window belongs to a Space reserved by another Synara task. No input was sent.",
      );
    }
  }

  dispose(): void {
    this.#disposed = true;
    this.#revision += 1;
    this.#reservations.clear();
  }

  async #snapshot(): Promise<ComputerSpaceSnapshot> {
    this.#assertActive();
    if (this.#disposed)
      throw new ComputerSpaceError(
        "computer_space_reservation_changed",
        "The Space broker has closed.",
      );
    const snapshot = await this.#readSnapshot();
    this.#assertActive();
    if (this.#disposed)
      throw new ComputerSpaceError(
        "computer_space_reservation_changed",
        "The Space broker closed while reading the desktop.",
      );
    return snapshot;
  }

  #assertUnchanged(revision: number): void {
    if (this.#revision !== revision)
      throw new ComputerSpaceError(
        "computer_space_reservation_changed",
        "Space reservations changed while reading the desktop. Observe the current reservation before continuing.",
      );
  }

  #findSpace(inventory: ComputerSpaceInventory, id: number): ComputerSpace {
    const matches = inventory.spaces.filter((space) => space.id === id);
    if (matches.length !== 1)
      throw new ComputerSpaceError(
        "computer_space_not_found",
        "That Space is absent or ambiguous in the current managed-display inventory. List Spaces again.",
      );
    return matches[0]!;
  }

  #reservableSpace(inventory: ComputerSpaceInventory, id: number): ComputerSpace {
    const space = this.#findSpace(inventory, id);
    if (space.current === true)
      throw new ComputerSpaceError(
        "computer_space_current",
        "The user is currently on this Space. Synara will not reserve or switch it. Choose an existing noncurrent Space explicitly designated by the user.",
      );
    if (!inventory.complete || space.current === null || !space.uuid || space.kind !== "desktop") {
      throw new ComputerSpaceError(
        "computer_space_identity_unproven",
        "This Space has incomplete identity, current-state information or unsupported fullscreen behavior. It cannot be reserved safely.",
      );
    }
    return space;
  }

  #window(snapshot: ComputerSpaceSnapshot, id: string, spaceId: number): ComputerWindow {
    const window = snapshot.windows.find((candidate) => candidate.id === id);
    if (
      !window?.pid ||
      !window.spaceIds ||
      window.spaceIds.length !== 1 ||
      window.onCurrentSpace !== false
    ) {
      throw new ComputerSpaceError(
        "computer_space_target_membership_unproven",
        "This window's exact noncurrent Space membership is not proven. List windows again; do not switch Spaces as a workaround.",
      );
    }
    if (window.spaceIds[0] !== spaceId || window.currentSpaceId === spaceId) {
      throw new ComputerSpaceError(
        "computer_space_target_outside_reservation",
        "This window is outside the reserved Space. Select an existing window in that Space; Synara will not move it there.",
      );
    }
    return window;
  }

  #reconcile(inventory: ComputerSpaceInventory): void {
    for (const [threadId, entry] of this.#reservations) {
      if (entry.invalidReason !== null) continue;
      const matches = inventory.spaces.filter((candidate) => candidate.id === entry.spaceId);
      const space = matches.length === 1 ? matches[0] : undefined;
      const reason =
        space?.current === true
          ? "computer_space_current"
          : !inventory.complete ||
              !space ||
              space.uuid !== entry.spaceUuid ||
              space.displayId !== entry.displayId ||
              space.current !== false
            ? "computer_space_reservation_changed"
            : null;
      if (reason) {
        this.#reservations.set(threadId, { ...entry, invalidReason: reason });
        this.#revision += 1;
      }
    }
  }

  #requireReservation(owner: ComputerSpaceOwner): ComputerSpaceReservation {
    const reservation = this.reservationFor(owner);
    if (!reservation)
      throw new ComputerSpaceError(
        "computer_space_reservation_required",
        "Reserve an existing noncurrent Space explicitly designated by the user before selecting its windows.",
      );
    if (reservation.invalidReason)
      throw new ComputerSpaceError(
        reservation.invalidReason,
        "The reserved Space became current or its identity changed. No input was sent. Inspect Spaces and explicitly reserve a safe target again; Synara will not move the user away.",
      );
    return reservation;
  }
}
