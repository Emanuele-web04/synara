import { Schema } from "effect";

export const COMPUTER_SPACES_MAX_LENGTH = 256;

/** WindowServer IDs are session-local integers, not Mission Control positions. */
export const ComputerSpaceId = Schema.Int.check(
  Schema.isGreaterThan(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);
export type ComputerSpaceId = typeof ComputerSpaceId.Type;

const SpaceIdentity = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));

export const ComputerSpace = Schema.Struct({
  id: ComputerSpaceId,
  /** A stable identity is required before reserving a session-local numeric ID. */
  uuid: Schema.NullOr(SpaceIdentity),
  displayId: SpaceIdentity,
  kind: Schema.Literals(["desktop", "fullscreen", "unknown"]),
  current: Schema.NullOr(Schema.Boolean),
});
export type ComputerSpace = typeof ComputerSpace.Type;

export const ComputerSpaceInventory = Schema.Struct({
  spaces: Schema.Array(ComputerSpace).check(Schema.isMaxLength(COMPUTER_SPACES_MAX_LENGTH)),
  /** False when any display, identity, or current-Space reading is incomplete. */
  complete: Schema.Boolean,
  source: Schema.Literal("macos-managed-spaces"),
});
export type ComputerSpaceInventory = typeof ComputerSpaceInventory.Type;

/** A Synara task reservation of a user-designated existing Space, not OS ownership. */
export interface ComputerSpaceReservation {
  readonly threadId: string;
  readonly turnId: string | null;
  readonly spaceId: number;
  readonly spaceUuid: string;
  readonly displayId: string;
  readonly selectedWindowId: string | null;
  readonly selectedPid: number | null;
  readonly invalidReason: ComputerSpaceErrorCode | null;
}

export const COMPUTER_SPACE_ERROR_CODES = [
  "computer_spaces_unavailable",
  "computer_space_not_found",
  "computer_space_current",
  "computer_space_identity_unproven",
  "computer_space_not_designated",
  "computer_space_reserved",
  "computer_space_reservation_required",
  "computer_space_reservation_changed",
  "computer_space_reservation_limit",
  "computer_space_window_not_selected",
  "computer_space_target_outside_reservation",
  "computer_space_target_membership_unproven",
  "computer_space_operation_unsupported",
] as const;
export type ComputerSpaceErrorCode = (typeof COMPUTER_SPACE_ERROR_CODES)[number];
