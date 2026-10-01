import { Schema } from "effect";
import { boundedTrimmedNonEmptyString } from "./baseSchemas";
import {
  StatsGetRecapResult,
  StatsRecapModel,
  StatsRecapProject,
  StatsRecapSlot,
  STATS_RECAP_MAX_SLOT_BOUNDARIES,
  STATS_RECAP_MAX_WINDOW_MS,
} from "./stats";

const RecapDateTime = Schema.String.check(
  Schema.isMaxLength(40),
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/),
  Schema.makeFilter((value) => Number.isFinite(Date.parse(value)), {
    message: "Invalid timestamp",
  }),
);
const SavedRecapSlot = Schema.Struct({
  ...StatsRecapSlot.fields,
  from: RecapDateTime,
  to: RecapDateTime,
});

/** Private snapshots are uploaded only by an explicit Save action. */
export const SavedInboxRecapPayload = Schema.Struct({
  ...StatsGetRecapResult.fields,
  generatedAt: RecapDateTime,
  totals: SavedRecapSlot,
  slots: Schema.Array(SavedRecapSlot).check(
    Schema.isMaxLength(STATS_RECAP_MAX_SLOT_BOUNDARIES + 1),
  ),
  projects: Schema.Array(
    Schema.Struct({
      ...StatsRecapProject.fields,
      projectId: boundedTrimmedNonEmptyString(256),
      title: boundedTrimmedNonEmptyString(1024),
    }),
  ).check(Schema.isMaxLength(5)),
  models: Schema.Array(
    Schema.Struct({
      ...StatsRecapModel.fields,
      model: boundedTrimmedNonEmptyString(200),
    }),
  ).check(Schema.isMaxLength(5)),
  unavailableProviders: StatsGetRecapResult.fields.unavailableProviders.check(
    Schema.isMaxLength(32),
  ),
}).check(
  Schema.makeFilter(
    (recap) => {
      const from = Date.parse(recap.totals.from);
      const to = Date.parse(recap.totals.to);
      if (to <= from || to - from > STATS_RECAP_MAX_WINDOW_MS || recap.slots.length === 0)
        return false;
      let cursor = from;
      for (const slot of recap.slots) {
        const end = Date.parse(slot.to);
        if (Date.parse(slot.from) !== cursor || end <= cursor || end > to) return false;
        cursor = end;
      }
      return cursor === to;
    },
    { message: "Recap slots must cover a valid recap window in order" },
  ),
);

export const SaveInboxRecapRequest = Schema.Struct({
  sourceHostId: Schema.String.check(Schema.isUUID(undefined)),
  /** The working day in the source timezone (Inbox starts its day at 04:00). */
  day: Schema.String.check(
    Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/),
    Schema.makeFilter(
      (day) => {
        const date = new Date(`${day}T00:00:00.000Z`);
        return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === day;
      },
      { message: "Invalid calendar day" },
    ),
  ),
  timezone: boundedTrimmedNonEmptyString(100).check(
    Schema.makeFilter(
      (timezone) => {
        try {
          new Intl.DateTimeFormat("en", { timeZone: timezone });
          return true;
        } catch {
          return false;
        }
      },
      { message: "Invalid timezone" },
    ),
  ),
  recap: SavedInboxRecapPayload,
}).check(
  Schema.makeFilter(
    (saved) => {
      const nextDay = new Date(`${saved.day}T00:00:00.000Z`);
      nextDay.setUTCDate(nextDay.getUTCDate() + 1);
      const format = new Intl.DateTimeFormat("en", {
        timeZone: saved.timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
      });
      const localStamp = (instant: string) => {
        const date = new Date(instant);
        const parts = Object.fromEntries(
          format.formatToParts(date).map((part) => [part.type, part.value]),
        );
        return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}.${date.getUTCMilliseconds()}`;
      };
      return (
        localStamp(saved.recap.totals.from) === `${saved.day}T04:00:00.0` &&
        localStamp(saved.recap.totals.to) === `${nextDay.toISOString().slice(0, 10)}T04:00:00.0`
      );
    },
    { message: "Recap window must match its working day and source timezone" },
  ),
);
export type SaveInboxRecapRequest = typeof SaveInboxRecapRequest.Type;

/** The desktop broker must not upload a pending save under a different login. */
export const AccountSaveInboxRecapInput = Schema.Struct({
  request: SaveInboxRecapRequest,
  expectedUserId: boundedTrimmedNonEmptyString(256),
  expectedOrganizationId: boundedTrimmedNonEmptyString(256),
});
export type AccountSaveInboxRecapInput = typeof AccountSaveInboxRecapInput.Type;

export const SavedInboxRecap = Schema.Struct({
  ...SaveInboxRecapRequest.fields,
  id: Schema.String.check(Schema.isUUID(undefined)),
  sourceHostName: boundedTrimmedNonEmptyString(200),
  savedAt: RecapDateTime,
});
export type SavedInboxRecap = typeof SavedInboxRecap.Type;

export const ListSavedInboxRecapsResponse = Schema.Struct({
  recaps: Schema.Array(SavedInboxRecap),
  nextCursor: Schema.NullOr(Schema.String),
});
export type ListSavedInboxRecapsResponse = typeof ListSavedInboxRecapsResponse.Type;

export const ListSavedInboxRecapsInput = Schema.Struct({
  limit: Schema.optional(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(50)),
  ),
  cursor: Schema.optional(boundedTrimmedNonEmptyString(512)),
});
export type ListSavedInboxRecapsInput = typeof ListSavedInboxRecapsInput.Type;

export const SavedInboxRecapIdInput = Schema.Struct({
  id: Schema.String.check(Schema.isUUID(undefined)),
});
export type SavedInboxRecapIdInput = typeof SavedInboxRecapIdInput.Type;
